/**
 * src/__tests__/agents-activity.test.ts — T-0499 [E-AGENTS]
 *
 * Proves the agent-activity read route:
 *   GET /api/agents/:id/activity?limit=&cursor=
 *
 * Reads the agent's outcome events (agent.proceeded / agent.deferred /
 * agent.blocked) from the REAL hash-chained audit log (choros.audit_event), the
 * events dispatch-outcome.ts writes. Covered (no real DB — a scripted in-memory
 * stub pg.Pool replays exactly the queries the handler runs):
 *
 *   (1) success — owner reads the agent's outcome stream → 200 { items, nextCursor }
 *   (2) authz — neither owner nor mgmt grant → 403 ADMIN_GATE_REJECTED;
 *       no x-dev-user header → 401
 *   (3) tenant — agent of another tenant (employee-exists matches 0 rows) → 404;
 *       and the audit SELECT carries a literal WHERE tenant_id + actor filter
 *   (4) redaction — a payload carrying a secret sentinel + free-text reason is
 *       NEVER echoed; only the safe allow-list (outcome/ts/process_key/instance_id/
 *       step/canned summary) reaches the wire
 *   (5) pagination — nextCursor round-trips; limit is clamped to the ceiling (50)
 *
 * Same authz predicate as PUT /api/agents/:id/llm-connection (genesis-owner OR a
 * delegable mgmt_object:agent/update grant). Runs in dev auth mode (x-dev-user);
 * slug→tenant→admin resolution is auth-mode-agnostic.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerAgentRoutes } from "../http/agents.js";
import type { KeycloakAdminPort } from "../core/agent-hire.js";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ROLE_ID = "eeeeeeee-0000-0000-0000-000000000005";
const AGENT_ID = "cccccccc-0000-0000-0000-000000000003";
const DEPT_ID = "bbbbbbbb-0000-0000-0000-000000000002";

const SECRET_SENTINEL = "vault://secret/should-never-egress-in-activity";
const REASON_SENTINEL = "LLM said: the customer SSN is 123-45-6789";

interface Capture {
  /** the params bound to the audit_event activity SELECT (for assertions). */
  activityParams: unknown[] | null;
  /** the SQL text of the audit_event activity SELECT (for assertions). */
  activitySql: string | null;
}

interface Scenario {
  isOwner: boolean;
  hasAgentMgmtGrant: boolean;
  /** false → the employee-exists guard matches 0 rows (agent in another tenant). */
  agentInTenant: boolean;
  /** rows the audit_event SELECT returns (already in DESC order; stub honours limit+1). */
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
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
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
        if (!s.hasAgentMgmtGrant) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: "g-1",
              role_id: ROLE_ID,
              resource_type: "mgmt_object:agent",
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

      // loadAgentOrgScope: employee → position → department.
      if (
        text.includes("p.department_id") &&
        text.includes("FROM choros.employee e")
      ) {
        return { rows: [{ department_id: DEPT_ID }], rowCount: 1 };
      }

      // employee-exists guard: SELECT id FROM employee WHERE tenant_id AND id.
      if (
        text.includes("SELECT id") &&
        text.includes("FROM choros.employee") &&
        text.includes("WHERE tenant_id = $1 AND id = $2")
      ) {
        return s.agentInTenant
          ? { rows: [{ id: AGENT_ID }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      // The activity read: SELECT ... FROM choros.audit_event ...
      if (
        text.includes("FROM choros.audit_event") &&
        text.includes("ORDER BY occurred_at DESC")
      ) {
        s.capture.activitySql = text;
        s.capture.activityParams = params ?? null;
        // Honour limit+1 semantics: the last param is the LIMIT.
        return { rows: s.auditRows, rowCount: s.auditRows.length };
      }

      // BEGIN / SET LOCAL / COMMIT / ROLLBACK → no-op OK.
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

const noopKcPort: KeycloakAdminPort = {
  createServiceAccountClient: async () => ({ clientId: "noop" }),
  deleteClient: async () => {},
};

async function startServer(
  pool: pg.Pool,
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerAgentRoutes(router, pool, noopKcPort);
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
    isOwner: true,
    hasAgentMgmtGrant: false,
    agentInTenant: true,
    auditRows: [],
    capture: { activityParams: null, activitySql: null },
    ...over,
  };
}

const PATH = `/api/agents/${AGENT_ID}/activity`;

// A proceeded + a deferred row, the deferred one carrying secret + free-text that
// MUST be redacted. Listed in DESC (newest first) order as the DAO query returns.
function sampleRows(): Array<Record<string, unknown>> {
  return [
    {
      id: "11111111-0000-0000-0000-000000000001",
      type: "agent.proceeded",
      occurred_at: "1700000002000",
      payload: {
        proc_key: "purchase-approval",
        instance_id: "inst-2",
        answer_form: "approve",
      },
    },
    {
      id: "22222222-0000-0000-0000-000000000002",
      type: "agent.deferred",
      occurred_at: "1700000001000",
      payload: {
        proc_key: "purchase-approval",
        instance_id: "inst-1",
        inbox_task_id: "22222222-0000-0000-0000-000000000002",
        doubt_reason: REASON_SENTINEL,
        signal: "low_confidence",
        defer_role: "role-approver",
        // F5 agent draft — must NEVER egress.
        agent_draft: { summary: SECRET_SENTINEL, redFlags: [REASON_SENTINEL] },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// (1) success — owner reads the agent's outcome stream.
// ---------------------------------------------------------------------------

describe("T-0499 (1) — owner reads the agent activity stream", () => {
  it("GET → 200 { items, nextCursor } with redacted, ordered items", async () => {
    const s = baseScenario({ isOwner: true, auditRows: sampleRows() });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      const body = r.body as { items: unknown[]; nextCursor: string | null };
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBe(2);
      expect(body.items[0]).toMatchObject({
        outcome: "proceeded",
        process_key: "purchase-approval",
        instance_id: "inst-2",
        ts: 1700000002000,
      });
      expect(body.items[1]).toMatchObject({
        outcome: "deferred",
        process_key: "purchase-approval",
        instance_id: "inst-1",
      });
      // Each item carries a human summary (canned, not raw reason).
      expect((body.items[0] as { summary?: string }).summary).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("a non-owner holding a delegable mgmt_object:agent/update grant CAN read → 200", async () => {
    const s = baseScenario({ isOwner: false, hasAgentMgmtGrant: true, auditRows: sampleRows() });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) authz — 403 / 401.
// ---------------------------------------------------------------------------

describe("T-0499 (2) — authz gate (same class as agent management)", () => {
  it("neither owner nor mgmt grant → 403 ADMIN_GATE_REJECTED", async () => {
    const s = baseScenario({ isOwner: false, hasAgentMgmtGrant: false });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("ADMIN_GATE_REJECTED");
      // Authz failed BEFORE any audit read.
      expect(s.capture.activitySql).toBeNull();
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
      expect(s.capture.activitySql).toBeNull();
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) tenant — agent of another tenant → 404; SQL carries tenant + actor filter.
// ---------------------------------------------------------------------------

describe("T-0499 (3) — tenant isolation", () => {
  it("agent of another tenant (employee-exists 0 rows) → 404 AGENT_NOT_FOUND, no audit read", async () => {
    const s = baseScenario({ isOwner: true, agentInTenant: false });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(404);
      expect(errCode(r.body)).toBe("AGENT_NOT_FOUND");
      // The audit SELECT must NOT run for a foreign agent.
      expect(s.capture.activitySql).toBeNull();
    } finally {
      await close();
    }
  });

  it("the audit query is tenant-scoped (WHERE tenant_id = $1) AND agent-scoped (actor = $2)", async () => {
    const s = baseScenario({ isOwner: true, auditRows: sampleRows() });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      // Враг target: the literal tenant predicate + agent (actor) filter + action set.
      expect(s.capture.activitySql).toContain("tenant_id = $1");
      expect(s.capture.activitySql).toContain("actor = $2");
      expect(s.capture.activitySql).toContain("type = ANY($3)");
      // $1 bound to the actor's resolved tenant, $2 to the requested agent id.
      expect(s.capture.activityParams?.[0]).toBe(TENANT_A);
      expect(s.capture.activityParams?.[1]).toBe(AGENT_ID);
      expect(s.capture.activityParams?.[2]).toEqual([
        "agent.proceeded",
        "agent.deferred",
        "agent.blocked",
      ]);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) REDACTION — secret + free-text reason NEVER egress.
// ---------------------------------------------------------------------------

describe("T-0499 (4) — redaction (audit payload never leaks)", () => {
  it("the response NEVER contains the secret sentinel, the free-text reason, or raw payload keys", async () => {
    const s = baseScenario({ isOwner: true, auditRows: sampleRows() });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      // The whole serialized body must be clean.
      expect(r.raw).not.toContain("should-never-egress-in-activity");
      expect(r.raw).not.toContain("123-45-6789");
      expect(r.raw).not.toContain("doubt_reason");
      expect(r.raw).not.toContain("agent_draft");
      expect(r.raw).not.toContain("redFlags");
      expect(r.raw).not.toContain("signal");
      // The deferred item still surfaces its SAFE fields.
      const body = r.body as { items: Array<Record<string, unknown>> };
      const deferred = body.items.find((i) => i["outcome"] === "deferred");
      expect(deferred).toBeDefined();
      expect(deferred?.["process_key"]).toBe("purchase-approval");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (5) pagination — nextCursor round-trips; limit clamped to ceiling (50).
// ---------------------------------------------------------------------------

describe("T-0499 (5) — pagination", () => {
  it("a full page (limit+1 rows) yields a nextCursor; ?limit is clamped to 50", async () => {
    // Build limit+1 = 3 rows so a page of limit=2 detects a next page.
    const rows = [
      { id: "aaaaaaaa-0000-0000-0000-00000000000a", type: "agent.proceeded", occurred_at: "30", payload: { proc_key: "p", instance_id: "i3" } },
      { id: "bbbbbbbb-0000-0000-0000-00000000000b", type: "agent.blocked", occurred_at: "20", payload: { proc_key: "p", instance_id: "i2" } },
      { id: "cccccccc-0000-0000-0000-00000000000c", type: "agent.deferred", occurred_at: "10", payload: { proc_key: "p", instance_id: "i1" } },
    ];
    const s = baseScenario({ isOwner: true, auditRows: rows });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", `${PATH}?limit=2`);
      expect(r.status).toBe(200);
      const body = r.body as { items: unknown[]; nextCursor: string | null };
      expect(body.items.length).toBe(2); // limit+1 sliced back to limit
      expect(body.nextCursor).not.toBeNull();
      // The LIMIT param the DAO bound = clamped limit + 1 = 3.
      const lastParam = s.capture.activityParams?.[s.capture.activityParams.length - 1];
      expect(lastParam).toBe(3);
    } finally {
      await close();
    }
  });

  it("?limit above the ceiling is clamped to 50 (LIMIT param = 51)", async () => {
    const s = baseScenario({ isOwner: true, auditRows: [] });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", `${PATH}?limit=9999`);
      expect(r.status).toBe(200);
      const lastParam = s.capture.activityParams?.[s.capture.activityParams.length - 1];
      expect(lastParam).toBe(51); // 50 (ceiling) + 1
    } finally {
      await close();
    }
  });

  it("a cursor passed as ?cursor= is decoded and adds a keyset predicate", async () => {
    const s = baseScenario({ isOwner: true, auditRows: [] });
    const { port, close } = await startServer(makePool(s));
    try {
      const cursor = Buffer.from(JSON.stringify({ ts: 1700000001000, id: "22222222-0000-0000-0000-000000000002" })).toString("base64url");
      const r = await request(port, "GET", `${PATH}?cursor=${cursor}`);
      expect(r.status).toBe(200);
      // The keyset predicate is present and bound the cursor ts + id.
      expect(s.capture.activitySql).toContain("occurred_at <");
      expect(s.capture.activityParams).toContain(1700000001000);
      expect(s.capture.activityParams).toContain("22222222-0000-0000-0000-000000000002");
    } finally {
      await close();
    }
  });
});
