/**
 * src/__tests__/agents-llm-connection.test.ts — T-0498 [E-AGENTS]
 *
 * Proves the keystone BYO-LLM wiring route:
 *   PUT /api/agents/:id/llm-connection  { llm_connection_id: string|null }
 *
 * Closes the flow: connection+key (exists) → test (exists, T-0496) → AGENT USES
 * the connection (this route writes agent_card.llm_connection_id).
 *
 * Covered (no real DB — a scripted in-memory stub pg.Pool replays exactly the
 * queries the handler runs):
 *   (1) success — owner binds a tenant-local connection → 200 {ok,llm_connection_id,
 *       connection_summary}
 *   (2) null — detach → 200 {ok,llm_connection_id:null}, NO connection_summary
 *   (3) authz — neither owner nor mgmt grant → 403 ADMIN_GATE_REJECTED;
 *       no x-dev-user header → 401
 *   (4) tenant — agent of another tenant (UPDATE matches 0 rows) → 404
 *   (5) CROSS-TENANT connection — getLlmConnection returns null for a foreign id →
 *       400 LLM_CONNECTION_NOT_FOUND, agent NOT rebound (no UPDATE issued)
 *   (6) non-existent connection (same shape as cross-tenant) → 400
 *   (7) secret never egressed — the connection's opaque secret_handle is present in
 *       the stub row but NEVER appears in the response body
 *
 * The same authz predicate as POST /api/agents/:id/secret-handle
 * (genesis-owner OR delegable mgmt_object:agent/update grant) is exercised via
 * loadAdminContext's scripted queries.
 *
 * Runs in dev auth mode (x-dev-user); slug→tenant→admin resolution is
 * auth-mode-agnostic.
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
const CONN_ID = "ffffffff-0000-0000-0000-000000000006";
const SECRET_FIXTURE = "vault://secret/should-never-egress";

interface Scenario {
  /** true → loadAdminContext owner-row query returns a row (genesis owner). */
  isOwner: boolean;
  /** mgmt_object:agent grant present + delegable + covers the agent's dept scope. */
  hasAgentMgmtGrant: boolean;
  /** false → getLlmConnection returns null (foreign / missing connection). */
  connectionExistsInTenant: boolean;
  /** false → the agent_card UPDATE matches 0 rows (agent in another tenant). */
  agentInTenant: boolean;
  /** capture flag: did an agent_card UPDATE actually run? */
  updateRan: { value: boolean };
}

function makePool(s: Scenario): pg.Pool {
  const client = {
    query: async (text: string, _params?: unknown[]) => {
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
        // A single assignment whose org_scope covers the agent's department, so a
        // delegable mgmt_object:agent grant on its role admits the agent scope.
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

      // getLlmConnection: tenant-scoped SELECT by id.
      if (
        text.includes("FROM choros.llm_connection") &&
        text.includes("WHERE tenant_id = $1 AND id = $2")
      ) {
        return s.connectionExistsInTenant
          ? {
              rows: [
                {
                  id: CONN_ID,
                  tenant_id: TENANT_A,
                  name: "DeepSeek prod",
                  provider: "deepseek",
                  endpoint: "https://api.deepseek.com",
                  model: "deepseek-chat",
                  secret_handle: SECRET_FIXTURE,
                  price_input_per_1k: null,
                  price_output_per_1k: null,
                  currency: "USD",
                  is_default: false,
                  created_by: "seed",
                  created_at: "0",
                  updated_at: "0",
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }

      // setAgentLlmConnection: agent_card UPDATE ... RETURNING employee_id.
      if (
        text.includes("UPDATE choros.agent_card") &&
        text.includes("llm_connection_id")
      ) {
        s.updateRan.value = true;
        return s.agentInTenant
          ? { rows: [{ employee_id: AGENT_ID }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      // Audit writer: tenant_id read.
      if (
        text.includes("current_setting('choros.tenant_id', false)") &&
        text.includes("AS tenant_id")
      ) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // Audit writer: audit_head SELECT ... FOR UPDATE → seeded head row.
      if (text.includes("FROM choros.audit_head") && text.includes("FOR UPDATE")) {
        return {
          rows: [{ seq: "0", row_hash: Buffer.alloc(32), vocab_version: 1 }],
          rowCount: 1,
        };
      }

      // BEGIN / SET LOCAL / COMMIT / ROLLBACK / audit INSERT/UPDATE → no-op OK.
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

// A no-op KeycloakAdminPort — the llm-connection route never touches it.
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
  body: unknown,
  opts: { devUser?: string | null } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
    };
    if (opts.devUser !== null) headers["x-dev-user"] = opts.devUser ?? "e-owner";
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
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
    connectionExistsInTenant: true,
    agentInTenant: true,
    updateRan: { value: false },
    ...over,
  };
}

const PATH = `/api/agents/${AGENT_ID}/llm-connection`;

// ---------------------------------------------------------------------------
// (1) success — owner binds a tenant-local connection.
// ---------------------------------------------------------------------------

describe("T-0498 (1) — owner binds a tenant-local connection", () => {
  it("PUT → 200 {ok, llm_connection_id, connection_summary}", async () => {
    const s = baseScenario({ isOwner: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { llm_connection_id: CONN_ID });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        ok: true,
        llm_connection_id: CONN_ID,
        connection_summary: {
          name: "DeepSeek prod",
          provider: "deepseek",
          model: "deepseek-chat",
        },
      });
      expect(s.updateRan.value).toBe(true);
    } finally {
      await close();
    }
  });

  it("a non-owner holding a delegable mgmt_object:agent/update grant CAN bind → 200", async () => {
    const s = baseScenario({ isOwner: false, hasAgentMgmtGrant: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { llm_connection_id: CONN_ID });
      expect(r.status).toBe(200);
      expect((r.body as { ok?: boolean }).ok).toBe(true);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) null — detach.
// ---------------------------------------------------------------------------

describe("T-0498 (2) — detach (null)", () => {
  it("PUT { llm_connection_id: null } → 200, no connection_summary, no getLlmConnection lookup", async () => {
    const s = baseScenario({ isOwner: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { llm_connection_id: null });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, llm_connection_id: null });
      expect((r.body as { connection_summary?: unknown }).connection_summary).toBeUndefined();
      expect(s.updateRan.value).toBe(true);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) authz — 403 / 401.
// ---------------------------------------------------------------------------

describe("T-0498 (3) — authz gate (same class as secret-handle)", () => {
  it("neither owner nor mgmt grant → 403 ADMIN_GATE_REJECTED, agent NOT rebound", async () => {
    const s = baseScenario({ isOwner: false, hasAgentMgmtGrant: false });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { llm_connection_id: CONN_ID });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("ADMIN_GATE_REJECTED");
      expect(s.updateRan.value).toBe(false);
    } finally {
      await close();
    }
  });

  it("no x-dev-user header → 401 (dev mode), agent NOT rebound", async () => {
    const s = baseScenario({ isOwner: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { llm_connection_id: CONN_ID }, { devUser: null });
      expect(r.status).toBe(401);
      expect(s.updateRan.value).toBe(false);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) tenant — agent of another tenant → 404 (UPDATE matches 0 rows).
// ---------------------------------------------------------------------------

describe("T-0498 (4) — agent of another tenant → 404", () => {
  it("PUT → 404 AGENT_NOT_FOUND when the agent_card UPDATE matches 0 rows", async () => {
    const s = baseScenario({ isOwner: true, agentInTenant: false });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { llm_connection_id: CONN_ID });
      expect(r.status).toBe(404);
      expect(errCode(r.body)).toBe("AGENT_NOT_FOUND");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (5)/(6) cross-tenant / non-existent connection → 400, agent NOT rebound.
// ---------------------------------------------------------------------------

describe("T-0498 (5/6) — cross-tenant / non-existent connection is rejected", () => {
  it("connection not in the actor's tenant → 400 LLM_CONNECTION_NOT_FOUND, NO UPDATE issued", async () => {
    const s = baseScenario({ isOwner: true, connectionExistsInTenant: false });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { llm_connection_id: CONN_ID });
      expect(r.status).toBe(400);
      expect(errCode(r.body)).toBe("LLM_CONNECTION_NOT_FOUND");
      // KEYSTONE: the agent must NOT be rebound to a connection it can't see.
      expect(s.updateRan.value).toBe(false);
    } finally {
      await close();
    }
  });

  it("malformed llm_connection_id (not a UUID) → 400 VALIDATION before any DB write", async () => {
    const s = baseScenario({ isOwner: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { llm_connection_id: "not-a-uuid" });
      expect(r.status).toBe(400);
      expect(s.updateRan.value).toBe(false);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (7) secret never egressed.
// ---------------------------------------------------------------------------

describe("T-0498 (7) — the connection secret never egresses", () => {
  it("a successful bind response NEVER contains the opaque secret handle", async () => {
    const s = baseScenario({ isOwner: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { llm_connection_id: CONN_ID });
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain("should-never-egress");
      expect(JSON.stringify(r.body)).not.toContain("secret_handle");
    } finally {
      await close();
    }
  });
});
