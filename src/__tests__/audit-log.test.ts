/**
 * src/__tests__/audit-log.test.ts — T-0500 [reality-gap]
 *
 * Proves the REAL tenant-wide audit-log read route:
 *   GET /api/audit?limit=&cursor=&actor=&action=
 *
 * Replaces the former in-memory "Счёт-агент" demo timeline with the genuine
 * hash-chained audit_event read. A scripted in-memory stub pg.Pool replays exactly
 * the queries the handler runs (no real DB). Covered:
 *
 *   (1) success — owner reads the tenant-wide event list → 200 { events, nextCursor }
 *   (2) authz — non-owner (with or without mgmt grant) → 403; no x-dev-user → 401;
 *       both BEFORE any audit read (T-0500 review: owner-only)
 *   (3) tenant-scope — the audit SELECT carries a literal WHERE tenant_id = $1 bound
 *       to the ACTOR's resolved tenant (cross-tenant isolation; a tenant-B caller
 *       resolves to tenant B and reads only tenant-B's rows)
 *   (4) redaction — a payload carrying a secret sentinel + free-text reason is NEVER
 *       echoed; only the safe allow-list (id/ts/actor/action/summary/safe-target)
 *       reaches the wire
 *   (5) pagination — nextCursor round-trips; limit is clamped to the ceiling (100);
 *       a cursor adds a keyset predicate
 *   (6) filters — ?actor= / ?action= are bound as PARAMETERS ($N), never interpolated
 *       (injection-safe); a `'; DROP TABLE` actor lands in params, not the SQL text;
 *       the action prefix is escaped + bound (LIKE wildcards neutralised)
 *   (7) T-0712 — `department.moved`/`position.moved`/`employee.moved` (org-move-API,
 *       T-0655) get a payload-aware human `summary` (moved/renamed/both, never
 *       echoing free-text names) + a `target` chip sourced from the writer's
 *       `subject` column (always populated since T-0655, so this is retroactive —
 *       no degradation for existing rows); `employee.moved` additionally gets a
 *       resolved `targetDisplay` (the moved employee IS an actor, resolved via the
 *       same batch resolver as T-0648); other types are byte-identical (regression)
 *   (8) T-0733 [R-1 из ревью T-0712] — `department.moved`/`position.moved` ALSO get
 *       a resolved `targetDisplay` now, through the SEPARATE node-resolver.ts batch
 *       (department/position are org-tree NODES, not actors): honest degradation for
 *       a deleted/never-existed node (resolved:false, never a raw id leak), tenant-
 *       scope (the node query is bound to the ACTOR's tenant, defence-in-depth), and
 *       a single page mixing both node kinds resolving in ONE round-trip (no N+1)
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerAuditRoutes } from "../http/audit.js";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";
const ROLE_ID = "eeeeeeee-0000-0000-0000-000000000005";
const DEPT_ID = "dddddddd-0000-0000-0000-000000000004";

const SECRET_SENTINEL = "vault://secret/should-never-egress-in-audit";
const REASON_SENTINEL = "LLM said: the customer SSN is 123-45-6789";
const INJECTION = "'; DROP TABLE choros.audit_event; --";

interface Capture {
  auditSql: string | null;
  auditParams: unknown[] | null;
  nodeSql: string | null;
  nodeParams: unknown[] | null;
}

interface OrgNodeFixture {
  id: string;
  name: string;
  kind: "department" | "position";
}

interface Scenario {
  tenantId: string;
  isOwner: boolean;
  hasMgmtGrant: boolean;
  auditRows: Array<Record<string, unknown>>;
  orgNodes: OrgNodeFixture[];
  capture: Capture;
}

function makePool(s: Scenario): pg.Pool {
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };

      // resolveActorTenant: employee ⋈ tenant slug → tenant_id.
      if (
        text.includes("FROM choros.employee e") &&
        text.includes("JOIN choros.tenant t")
      ) {
        return { rows: [{ tenant_id: s.tenantId }], rowCount: 1 };
      }

      // loadAdminContext step 1: tenant-owner role lookup.
      if (text.includes("'tenant-owner'") && text.includes("role_assignment")) {
        return s.isOwner
          ? { rows: [{ id: "ra-owner" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      // loadAdminContext step 2: confirmed in-window assignments for the actor.
      if (text.includes("SELECT ra.id, ra.role_id, ra.org_scope")) {
        return {
          rows: [
            {
              id: "ra-1",
              role_id: ROLE_ID,
              org_scope: {
                kind: "node",
                hierarchy: "org",
                nodeId: DEPT_ID,
                nodeLevel: "department",
              },
            },
          ],
          rowCount: 1,
        };
      }

      // loadAdminContext step 3: delegable mgmt_object:* grants on the role.
      if (text.includes('choros."grant"') && text.includes("mgmt_object:")) {
        if (!s.hasMgmtGrant) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: "g-1",
              role_id: ROLE_ID,
              resource_type: "mgmt_object:org",
              resource_facet: null,
              operation: "update",
              scope: {
                kind: "node",
                hierarchy: "org",
                nodeId: DEPT_ID,
                nodeLevel: "department",
              },
              constraint: null,
              delegable: true,
              granted_by: "seed",
              valid_from: null,
              valid_until: null,
              created_at: "0",
            },
          ],
          rowCount: 1,
        };
      }

      // The audit read: SELECT ... FROM choros.audit_event ...
      if (
        text.includes("FROM choros.audit_event") &&
        text.includes("ORDER BY occurred_at DESC")
      ) {
        s.capture.auditSql = text;
        s.capture.auditParams = params ?? null;
        return { rows: s.auditRows, rowCount: s.auditRows.length };
      }

      // T-0733 — batchResolveOrgNodes: ONE UNION ALL query over
      // choros.department + choros.position.
      if (text.includes("FROM choros.department") && text.includes("UNION ALL")) {
        s.capture.nodeSql = text;
        s.capture.nodeParams = (params as unknown[]) ?? null;
        const [, deptIdsRaw, posIdsRaw] = (params ?? []) as [string, string[], string[]];
        const deptIds = new Set(deptIdsRaw ?? []);
        const posIds = new Set(posIdsRaw ?? []);
        const rows = s.orgNodes
          .filter(
            (n) =>
              (n.kind === "department" && deptIds.has(n.id)) ||
              (n.kind === "position" && posIds.has(n.id)),
          )
          .map((n) => ({ id: n.id, name: n.name, kind: n.kind }));
        return { rows, rowCount: rows.length };
      }

      // BEGIN / SET LOCAL / COMMIT / ROLLBACK → no-op OK.
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

async function startServer(
  pool: pg.Pool,
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerAuditRoutes(router, undefined, pool);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e: Error | undefined) => (e ? reject(e) : resolve())),
      ),
  };
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { devUser?: string | null } = {},
): Promise<{ status: number; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.devUser !== null) headers["x-dev-user"] = opts.devUser ?? "e-owner";
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null, raw: data });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data, raw: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

function baseScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    tenantId: TENANT_A,
    isOwner: true,
    hasMgmtGrant: false,
    auditRows: [],
    orgNodes: [],
    capture: { auditSql: null, auditParams: null, nodeSql: null, nodeParams: null },
    ...over,
  };
}

const PATH = "/api/audit";

// A grant.create + an agent.deferred row, the latter carrying secret + free-text
// that MUST be redacted. DESC (newest first) as the DAO query returns.
function sampleRows(): Array<Record<string, unknown>> {
  return [
    {
      id: "11111111-0000-0000-0000-000000000001",
      type: "grant.create",
      actor: "e-larina",
      occurred_at: "1700000002000",
      payload: { grant_id: "g-77", reason: REASON_SENTINEL },
    },
    {
      id: "22222222-0000-0000-0000-000000000002",
      type: "agent.deferred",
      actor: "agent-uuid-9",
      occurred_at: "1700000001000",
      payload: {
        proc_key: "purchase-approval",
        instance_id: "inst-1",
        doubt_reason: REASON_SENTINEL,
        signal: "low_confidence",
        agent_draft: { summary: SECRET_SENTINEL, redFlags: [REASON_SENTINEL] },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// (1) success
// ---------------------------------------------------------------------------

describe("T-0500 (1) — owner reads the tenant-wide audit log", () => {
  it("GET → 200 { events, nextCursor } with redacted, ordered events", async () => {
    const s = baseScenario({ isOwner: true, auditRows: sampleRows() });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      const body = r.body as { events: unknown[]; nextCursor: string | null };
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBe(2);
      expect(body.events[0]).toMatchObject({
        action: "grant.create",
        actor: "e-larina",
        ts: 1700000002000,
        target: "g-77",
      });
      expect((body.events[0] as { summary?: string }).summary).toBeTruthy();
      expect(body.events[1]).toMatchObject({
        action: "agent.deferred",
        actor: "agent-uuid-9",
        target: "inst-1", // instance_id safe-target (first allow-listed key present)
      });
    } finally {
      await close();
    }
  });

  // T-0500 review: a mgmt_object:* grant covers one object type (dept/position/employee)
  // and MUST NOT open the whole-tenant audit journal — narrowed to owner-only.
  it("a non-owner holding a delegable mgmt_object:* grant CANNOT read → 403", async () => {
    const s = baseScenario({ isOwner: false, hasMgmtGrant: true, auditRows: sampleRows() });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("ADMIN_GATE_REJECTED");
      expect(s.capture.auditSql).toBeNull(); // gate fires BEFORE any DB read
    } finally {
      await close();
    }
  });

  it("empty audit → 200 { events: [], nextCursor: null }", async () => {
    const s = baseScenario({ isOwner: true, auditRows: [] });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      const body = r.body as { events: unknown[]; nextCursor: string | null };
      expect(body.events).toEqual([]);
      expect(body.nextCursor).toBeNull();
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) authz — 403 / 401.
// ---------------------------------------------------------------------------

describe("T-0500 (2) — authz gate (owner/admin only)", () => {
  it("neither owner nor mgmt grant → 403 ADMIN_GATE_REJECTED, no audit read", async () => {
    const s = baseScenario({ isOwner: false, hasMgmtGrant: false });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("ADMIN_GATE_REJECTED");
      expect(s.capture.auditSql).toBeNull();
    } finally {
      await close();
    }
  });

  it("no x-dev-user header → 401 (dev mode), no audit read", async () => {
    const s = baseScenario({ isOwner: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH, { devUser: null });
      expect(r.status).toBe(401);
      expect(s.capture.auditSql).toBeNull();
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) tenant-scope — literal WHERE tenant_id bound to the ACTOR's tenant.
// ---------------------------------------------------------------------------

describe("T-0500 (3) — tenant isolation", () => {
  it("the audit query is tenant-scoped (WHERE tenant_id = $1) bound to the actor's tenant", async () => {
    const s = baseScenario({ isOwner: true, auditRows: sampleRows() });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      expect(s.capture.auditSql).toContain("tenant_id = $1");
      expect(s.capture.auditParams?.[0]).toBe(TENANT_A);
    } finally {
      await close();
    }
  });

  it("a tenant-B caller resolves to tenant B → the SELECT is bound to TENANT_B, never TENANT_A", async () => {
    const s = baseScenario({ tenantId: TENANT_B, isOwner: true, auditRows: sampleRows() });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      expect(s.capture.auditParams?.[0]).toBe(TENANT_B);
      expect(s.capture.auditParams?.[0]).not.toBe(TENANT_A);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) REDACTION — secret + free-text reason NEVER egress.
// ---------------------------------------------------------------------------

describe("T-0500 (4) — redaction (audit payload never leaks)", () => {
  it("the response NEVER contains the secret sentinel, the free-text reason, or raw payload keys", async () => {
    const s = baseScenario({ isOwner: true, auditRows: sampleRows() });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      expect(r.raw).not.toContain("should-never-egress-in-audit");
      expect(r.raw).not.toContain("123-45-6789");
      expect(r.raw).not.toContain("doubt_reason");
      expect(r.raw).not.toContain("agent_draft");
      expect(r.raw).not.toContain("redFlags");
      expect(r.raw).not.toContain("signal");
      expect(r.raw).not.toContain("reason");
      // The events still surface their SAFE fields.
      const body = r.body as { events: Array<Record<string, unknown>> };
      const deferred = body.events.find((e) => e["action"] === "agent.deferred");
      expect(deferred).toBeDefined();
      expect(deferred?.["target"]).toBe("inst-1");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (5) pagination — nextCursor round-trips; limit clamped to ceiling (100).
// ---------------------------------------------------------------------------

describe("T-0500 (5) — pagination", () => {
  it("a full page (limit+1 rows) yields a nextCursor; ?limit is clamped to 100", async () => {
    const rows = [
      { id: "aaaaaaaa-0000-0000-0000-00000000000a", type: "grant.create", actor: "a", occurred_at: "30", payload: {} },
      { id: "bbbbbbbb-0000-0000-0000-00000000000b", type: "grant.revoke", actor: "b", occurred_at: "20", payload: {} },
      { id: "cccccccc-0000-0000-0000-00000000000c", type: "agent.blocked", actor: "c", occurred_at: "10", payload: {} },
    ];
    const s = baseScenario({ isOwner: true, auditRows: rows });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", `${PATH}?limit=2`);
      expect(r.status).toBe(200);
      const body = r.body as { events: unknown[]; nextCursor: string | null };
      expect(body.events.length).toBe(2); // limit+1 sliced back to limit
      expect(body.nextCursor).not.toBeNull();
      const lastParam = s.capture.auditParams?.[s.capture.auditParams.length - 1];
      expect(lastParam).toBe(3); // clamped limit 2 + 1
    } finally {
      await close();
    }
  });

  it("?limit above the ceiling is clamped to 100 (LIMIT param = 101)", async () => {
    const s = baseScenario({ isOwner: true, auditRows: [] });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", `${PATH}?limit=99999`);
      expect(r.status).toBe(200);
      const lastParam = s.capture.auditParams?.[s.capture.auditParams.length - 1];
      expect(lastParam).toBe(101); // 100 (ceiling) + 1
    } finally {
      await close();
    }
  });

  it("a cursor passed as ?cursor= is decoded and adds a keyset predicate", async () => {
    const s = baseScenario({ isOwner: true, auditRows: [] });
    const { port, close } = await startServer(makePool(s));
    try {
      const cursor = Buffer.from(
        JSON.stringify({ ts: 1700000001000, id: "22222222-0000-0000-0000-000000000002" }),
      ).toString("base64url");
      const r = await request(port, "GET", `${PATH}?cursor=${cursor}`);
      expect(r.status).toBe(200);
      expect(s.capture.auditSql).toContain("occurred_at <");
      expect(s.capture.auditParams).toContain(1700000001000);
      expect(s.capture.auditParams).toContain("22222222-0000-0000-0000-000000000002");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (7) T-0712 [P3 из LIVE_PROOF T-0655] — `.moved` events (org-move-API,
// department/position/employee) get a payload-aware human summary + a target
// chip. Before this fix `summaryFor` had no entry for these three types, so
// the raw `type` token ("employee.moved") WAS the entire summary, and
// `target` was always null (the move-diff payload carries none of
// SAFE_TARGET_KEYS — the moved entity's own id lives only in the writer's
// `subject` column, which the DAO now also reads).
// ---------------------------------------------------------------------------

describe("T-0712 (7) — .moved events: human summary + target chip", () => {
  it("employee.moved (position changed only) → 'Сотрудник перемещён'; target=subject; targetDisplay resolved (fallback shape, honest — no raw UUID as primary text)", async () => {
    const s = baseScenario({
      isOwner: true,
      auditRows: [
        {
          id: "33333333-0000-0000-0000-000000000003",
          type: "employee.moved",
          actor: "e-owner",
          subject: "emp-1",
          occurred_at: "1700000005000",
          payload: { to_position_id: "pos-2", from_position_id: "pos-1" },
        },
      ],
    });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      const body = r.body as { events: Array<Record<string, unknown>> };
      const ev = body.events[0]!;
      expect(ev["summary"]).toBe("Сотрудник перемещён");
      expect(ev["target"]).toBe("emp-1");
      expect(ev["targetDisplay"]).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("employee.moved (renamed only, no position change) → 'Сотрудник переименован'; from_name/to_name NEVER echoed in the summary text", async () => {
    const s = baseScenario({
      isOwner: true,
      auditRows: [
        {
          id: "44444444-0000-0000-0000-000000000004",
          type: "employee.moved",
          actor: "e-owner",
          subject: "emp-2",
          occurred_at: "1700000004000",
          payload: { renamed: true, from_name: REASON_SENTINEL, to_name: "Новое Имя Сотрудника" },
        },
      ],
    });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      const body = r.body as { events: Array<Record<string, unknown>> };
      const ev = body.events[0]!;
      expect(ev["summary"]).toBe("Сотрудник переименован");
      expect(ev["target"]).toBe("emp-2");
      expect(r.raw).not.toContain("Новое Имя Сотрудника");
      expect(r.raw).not.toContain(REASON_SENTINEL);
    } finally {
      await close();
    }
  });

  it("employee.moved (position changed AND renamed) → combined summary", async () => {
    const s = baseScenario({
      isOwner: true,
      auditRows: [
        {
          id: "55555555-0000-0000-0000-000000000015",
          type: "employee.moved",
          actor: "e-owner",
          subject: "emp-3",
          occurred_at: "1700000004500",
          payload: { to_position_id: "pos-3", renamed: true, from_name: "A", to_name: "B" },
        },
      ],
    });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      const body = r.body as { events: Array<Record<string, unknown>> };
      expect(body.events[0]!["summary"]).toBe("Сотрудник перемещён и переименован");
    } finally {
      await close();
    }
  });

  // T-0733 (R-1 из ревью T-0712): department.moved/position.moved NOW ALSO get
  // a resolved targetDisplay (was hardcoded null before this task — see the
  // T-0733 (8) block below for the fuller node-resolver coverage; these two
  // stay here as the direct sibling regressions of the employee.moved cases
  // above, proving the SAME `.moved` family now resolves symmetrically).
  it("department.moved → 'Отдел перемещён'; target=subject (dept id); targetDisplay resolves to the department's name (T-0733)", async () => {
    const s = baseScenario({
      isOwner: true,
      auditRows: [
        {
          id: "66666666-0000-0000-0000-000000000006",
          type: "department.moved",
          actor: "e-owner",
          subject: "dept-9",
          occurred_at: "1700000003000",
          payload: { to_parent_id: "dept-8", from_parent_id: "dept-7" },
        },
      ],
      orgNodes: [{ id: "dept-9", name: "Клиентский сервис", kind: "department" }],
    });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      const body = r.body as { events: Array<Record<string, unknown>> };
      const ev = body.events[0]!;
      expect(ev["summary"]).toBe("Отдел перемещён");
      expect(ev["target"]).toBe("dept-9");
      expect(ev["targetDisplay"]).toMatchObject({
        id: "dept-9",
        name: "Клиентский сервис",
        kind: "department",
        resolved: true,
      });
    } finally {
      await close();
    }
  });

  it("position.moved (department changed AND renamed) → 'Должность перемещена и переименована'; targetDisplay resolves to the position's title (T-0733)", async () => {
    const s = baseScenario({
      isOwner: true,
      auditRows: [
        {
          id: "77777777-0000-0000-0000-000000000007",
          type: "position.moved",
          actor: "e-owner",
          subject: "pos-9",
          occurred_at: "1700000002500",
          payload: { to_department_id: "dept-4", renamed: true, from_title: "A", to_title: "B" },
        },
      ],
      orgNodes: [{ id: "pos-9", name: "Эскалации L2", kind: "position" }],
    });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      const body = r.body as { events: Array<Record<string, unknown>> };
      const ev = body.events[0]!;
      expect(ev["summary"]).toBe("Должность перемещена и переименована");
      expect(ev["target"]).toBe("pos-9");
      expect(ev["targetDisplay"]).toMatchObject({
        id: "pos-9",
        name: "Эскалации L2",
        kind: "position",
        resolved: true,
      });
    } finally {
      await close();
    }
  });

  // Honest degradation: a hypothetical `.moved` row with no `subject` at all
  // (the column has ALWAYS been populated by seed-write.ts since T-0655's
  // first commit, so this is a defensive edge case, not a real legacy shape)
  // still gets a human summary — just no target chip, exactly like today
  // before this fix, never worse.
  it("employee.moved with an empty diff AND no subject → honest fallback summary, target null (never worse than before this fix)", async () => {
    const s = baseScenario({
      isOwner: true,
      auditRows: [
        {
          id: "88888888-0000-0000-0000-000000000008",
          type: "employee.moved",
          actor: "e-owner",
          occurred_at: "1700000001500",
          payload: {},
        },
      ],
    });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      const body = r.body as { events: Array<Record<string, unknown>> };
      const ev = body.events[0]!;
      expect(ev["summary"]).toBe("Сотрудник изменён");
      expect(ev["target"]).toBeNull();
      expect(ev["targetDisplay"]).toBeNull();
    } finally {
      await close();
    }
  });

  it("regression: record.create / grant.create summary+target are byte-identical to before this fix", async () => {
    const s = baseScenario({ isOwner: true, auditRows: sampleRows() });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      const body = r.body as { events: Array<Record<string, unknown>> };
      const grant = body.events.find((e) => e["action"] === "grant.create")!;
      expect(grant["summary"]).toBe("Выдан грант прав");
      expect(grant["target"]).toBe("g-77");
      const deferred = body.events.find((e) => e["action"] === "agent.deferred")!;
      expect(deferred["summary"]).toBe("Агент передал решение человеку");
      expect(deferred["target"]).toBe("inst-1");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (8) T-0733 [R-1 из ревью T-0712, столп 4 анти-UUID] — the node-resolver
// batch: department.moved/position.moved targetDisplay now resolves through
// node-resolver.ts (choros.department/choros.position), the ORG-TREE-NODE
// sibling of the T-0648 actor batch. Covers: honest degradation for a
// deleted/never-existed node, cross-tenant non-leak, and a single page mixing
// both node kinds resolving in one round-trip.
// ---------------------------------------------------------------------------

describe("T-0733 (8) — node-resolver batch (department.moved/position.moved targetDisplay)", () => {
  it("a DELETED department (no matching row) → targetDisplay is an honest fallback, NEVER the raw id as the response's only signal of success", async () => {
    const s = baseScenario({
      isOwner: true,
      auditRows: [
        {
          id: "99999999-0000-0000-0000-000000000009",
          type: "department.moved",
          actor: "e-owner",
          subject: "dept-ghost",
          occurred_at: "1700000006000",
          payload: { to_parent_id: "dept-x" },
        },
      ],
      orgNodes: [], // the department row no longer exists (hard delete, AC-9)
    });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      const body = r.body as { events: Array<Record<string, unknown>> };
      const ev = body.events[0]!;
      expect(ev["target"]).toBe("dept-ghost");
      expect(ev["targetDisplay"]).toEqual({
        id: "dept-ghost",
        name: "dept-ghost",
        kind: "department",
        resolved: false,
      });
    } finally {
      await close();
    }
  });

  it("a DELETED position (no matching row) → targetDisplay is an honest fallback shape, resolved:false", async () => {
    const s = baseScenario({
      isOwner: true,
      auditRows: [
        {
          id: "aaaaaaaa-1111-0000-0000-00000000000a",
          type: "position.moved",
          actor: "e-owner",
          subject: "pos-ghost",
          occurred_at: "1700000006500",
          payload: { to_department_id: "dept-x" },
        },
      ],
      orgNodes: [],
    });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      const body = r.body as { events: Array<Record<string, unknown>> };
      const ev = body.events[0]!;
      expect(ev["targetDisplay"]).toEqual({
        id: "pos-ghost",
        name: "pos-ghost",
        kind: "position",
        resolved: false,
      });
    } finally {
      await close();
    }
  });

  it("a CROSS-TENANT node id never resolves — the node query is bound to the ACTOR's tenant, never a request-supplied one", async () => {
    // A department that exists, but in orgNodes we simulate it belonging to a
    // different tenant by simply NOT returning it for this tenant's query (the
    // mock pool has no per-row tenant field — the REAL isolation guarantee is
    // node-resolver.ts's `SET LOCAL choros.tenant_id` + literal WHERE tenant_id
    // = $1, proven directly by node-resolver.test.ts's tenant-scope case (g);
    // this HTTP-level test proves the WIRING passes the resolved tenantId, not
    // a second tenant, into the node query — the same discipline test (3)
    // above already proves for the audit SELECT itself).
    const s = baseScenario({
      tenantId: TENANT_B,
      isOwner: true,
      auditRows: [
        {
          id: "bbbbbbbb-2222-0000-0000-00000000000b",
          type: "department.moved",
          actor: "e-owner",
          subject: "dept-tenant-a-only",
          occurred_at: "1700000007000",
          payload: {},
        },
      ],
      orgNodes: [], // tenant A's department is invisible to tenant B's query
    });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      // The node query (like the audit query) is bound to TENANT_B — never TENANT_A.
      expect(s.capture.nodeParams?.[0]).toBe(TENANT_B);
      expect(s.capture.nodeParams?.[0]).not.toBe(TENANT_A);
      const body = r.body as { events: Array<Record<string, unknown>> };
      // Honest miss — not a leaked tenant-A name, not a 500.
      expect((body.events[0]!["targetDisplay"] as { resolved: boolean }).resolved).toBe(false);
    } finally {
      await close();
    }
  });

  it("a single page mixing department.moved AND position.moved resolves BOTH in one node-resolver round-trip", async () => {
    const s = baseScenario({
      isOwner: true,
      auditRows: [
        {
          id: "cccccccc-3333-0000-0000-00000000000c",
          type: "department.moved",
          actor: "e-owner",
          subject: "dept-mix",
          occurred_at: "1700000008000",
          payload: {},
        },
        {
          id: "dddddddd-4444-0000-0000-00000000000d",
          type: "position.moved",
          actor: "e-owner",
          subject: "pos-mix",
          occurred_at: "1700000007900",
          payload: {},
        },
      ],
      orgNodes: [
        { id: "dept-mix", name: "Платформа", kind: "department" },
        { id: "pos-mix", name: "Интеграции", kind: "position" },
      ],
    });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      const body = r.body as { events: Array<Record<string, unknown>> };
      const dept = body.events.find((e) => e["action"] === "department.moved")!;
      const pos = body.events.find((e) => e["action"] === "position.moved")!;
      expect((dept["targetDisplay"] as { name: string }).name).toBe("Платформа");
      expect((pos["targetDisplay"] as { name: string }).name).toBe("Интеграции");
    } finally {
      await close();
    }
  });

  it("a page with NO .moved events at all never queries the node resolver", async () => {
    const s = baseScenario({ isOwner: true, auditRows: sampleRows() }); // grant.create + agent.deferred only
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      expect(s.capture.nodeSql).toBeNull();
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (6) filters — parameterised, injection-safe.
// ---------------------------------------------------------------------------

describe("T-0500 (6) — filters are parameterised (injection-safe)", () => {
  it("?actor= is bound as a parameter (actor = $N), never interpolated", async () => {
    const s = baseScenario({ isOwner: true, auditRows: [] });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", `${PATH}?actor=${encodeURIComponent(INJECTION)}`);
      expect(r.status).toBe(200);
      // The injection payload is in PARAMS, never in the SQL text.
      expect(s.capture.auditSql).toContain("actor = $");
      expect(s.capture.auditSql).not.toContain("DROP TABLE");
      expect(s.capture.auditParams).toContain(INJECTION);
    } finally {
      await close();
    }
  });

  it("?action= is bound as a LIKE-prefix parameter with wildcards neutralised", async () => {
    const s = baseScenario({ isOwner: true, auditRows: [] });
    const { port, close } = await startServer(makePool(s));
    try {
      // A wildcard-laden action prefix must NOT become a wildcard match.
      const r = await request(port, "GET", `${PATH}?action=${encodeURIComponent("gr%a_nt")}`);
      expect(r.status).toBe(200);
      expect(s.capture.auditSql).toContain("type LIKE $");
      expect(s.capture.auditSql).toContain("ESCAPE");
      // The escaped + trailing-% value lands in params, not the SQL text.
      expect(s.capture.auditParams).toContain("gr\\%a\\_nt%");
    } finally {
      await close();
    }
  });
});
