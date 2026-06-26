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
}

interface Scenario {
  tenantId: string;
  isOwner: boolean;
  hasMgmtGrant: boolean;
  auditRows: Array<Record<string, unknown>>;
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
    capture: { auditSql: null, auditParams: null },
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
