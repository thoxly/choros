/**
 * src/http/__tests__/agent-instruction-routes.test.ts — T-0637
 *
 * Proves the keystone workforce-agent authoring routes registered in
 * src/http/agents.ts:
 *
 *   GET /api/agents/:id/instruction
 *   PUT /api/agents/:id/instruction
 *
 * Covered (no real DB — a scripted in-memory stub pg.Pool replays exactly the
 * queries the handlers run, mirroring src/__tests__/agents-llm-connection.test.ts):
 *   AC-1  — PUT for a REAL workforce agent (kind='agent') writes a draft row
 *           keyed on the agent's own employee_id (not a synthetic
 *           'assistant-agent' slug / instruction_meta hack).
 *   AC-2  — authz: non-admin → 403 ADMIN_GATE_REJECTED on both GET/PUT, zero
 *           write; genesis-owner / delegable-grant holder → 200.
 *   AC-3  — published-lock: PUT against an already-published row → 409
 *           PUBLISHED_LOCKED, no new row written.
 *   (bonus) GET fallback semantics: draft present → tier=draft; only published
 *           present → tier=published; neither → { text:null, tier:null }.
 *   (bonus) foreign/missing agent → 404 AGENT_NOT_FOUND on both routes.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../router.js";
import { registerAgentRoutes } from "../agents.js";
import type { KeycloakAdminPort } from "../../core/agent-hire.js";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ROLE_ID = "eeeeeeee-0000-0000-0000-000000000005";
const AGENT_ID = "cccccccc-0000-0000-0000-000000000003";
const DEPT_ID = "bbbbbbbb-0000-0000-0000-000000000002";

interface Row {
  tenant_id: string;
  id: string;
  employee_id: string;
  employee_kind: string;
  tier: string;
  instruction_text: string;
  answer_form: string | null;
  instruction_meta: Record<string, unknown>;
  bundle_id: string | null;
  created_at: number;
  updated_at: number;
}

interface Scenario {
  isOwner: boolean;
  hasAgentMgmtGrant: boolean;
  agentInTenant: boolean;
  /** The single existing agent_instruction row (any tier), or null (none). */
  existingRow: Row | null;
  /** Captures whether an INSERT ... ON CONFLICT ran. */
  insertRan: { value: boolean };
}

function makePool(s: Scenario): pg.Pool {
  // A tiny in-memory single-row store so INSERT ... ON CONFLICT DO UPDATE
  // behaves like the real DAO (readCurrent / readByTier both read this).
  let row: Row | null = s.existingRow;

  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };
      const p = params ?? [];

      if (/^BEGIN/i.test(text.trim())) return { rows: [], rowCount: 0 };
      if (/^COMMIT/i.test(text.trim())) return { rows: [], rowCount: 0 };
      if (/^ROLLBACK/i.test(text.trim())) return { rows: [], rowCount: 0 };
      if (/^SET LOCAL/i.test(text.trim())) return { rows: [], rowCount: 0 };

      // resolveActorTenant: employee ⋈ tenant slug → tenant_id.
      if (text.includes("FROM choros.employee e") && text.includes("JOIN choros.tenant t")) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // loadAdminContext step 1: tenant-owner role lookup.
      if (text.includes("'tenant-owner'") && text.includes("role_assignment")) {
        return s.isOwner ? { rows: [{ id: "ra-owner" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      // loadAdminContext step 2: confirmed in-window assignments for the actor.
      if (text.includes("SELECT ra.id, ra.role_id, ra.org_scope")) {
        return {
          rows: [
            {
              id: "ra-1",
              role_id: ROLE_ID,
              org_scope: { kind: "node", hierarchy: "org", nodeId: DEPT_ID, nodeLevel: "department" },
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
              scope: { kind: "node", hierarchy: "org", nodeId: DEPT_ID, nodeLevel: "department" },
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
      if (text.includes("p.department_id") && text.includes("FROM choros.employee e")) {
        return { rows: [{ department_id: DEPT_ID }], rowCount: 1 };
      }

      // Tenant existence guard (handleGetAgentInstruction / handleSetAgentInstruction):
      // SELECT id FROM choros.employee WHERE tenant_id = $1 AND id = $2.
      if (
        text.includes("SELECT id") &&
        text.includes("FROM choros.employee") &&
        text.includes("WHERE tenant_id = $1 AND id = $2")
      ) {
        return s.agentInTenant ? { rows: [{ id: AGENT_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      // readByTier (readDraft / readPublished via the facade).
      if (text.includes("FROM choros.agent_instruction") && text.includes("AND tier = $2")) {
        const tier = p[1] as string;
        return { rows: row && row.tier === tier ? [row] : [], rowCount: row && row.tier === tier ? 1 : 0 };
      }
      // readCurrent (any tier) — used internally by saveDraft's published-lock guard.
      if (text.includes("FROM choros.agent_instruction") && text.includes("WHERE employee_id = $1") && !text.includes("tier = $2")) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      // saveDraft UPSERT.
      if (text.includes("INSERT INTO choros.agent_instruction")) {
        s.insertRan.value = true;
        const [id, employeeId, instructionText, answerForm, metaJson, bundleId, nowMs] = p as [
          string, string, string, string | null, string, string | null, number,
        ];
        row = {
          tenant_id: TENANT_A,
          id,
          employee_id: employeeId,
          employee_kind: "agent",
          tier: "draft",
          instruction_text: instructionText,
          answer_form: answerForm,
          instruction_meta: JSON.parse(metaJson) as Record<string, unknown>,
          bundle_id: bundleId,
          created_at: nowMs,
          updated_at: nowMs,
        };
        return { rows: [], rowCount: 1 };
      }

      // Audit writer: tenant_id GUC read.
      if (text.includes("current_setting('choros.tenant_id'") && text.includes("AS tenant_id")) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }
      // Audit writer: audit_head seed / lock / advance.
      if (text.includes("INSERT INTO choros.audit_head")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM choros.audit_head") && text.includes("FOR UPDATE")) {
        return { rows: [{ seq: "0", row_hash: Buffer.alloc(32), vocab_version: 1 }], rowCount: 1 };
      }
      if (text.includes("UPDATE choros.audit_head")) return { rows: [], rowCount: 0 };
      if (text.includes("INSERT INTO choros.audit_event")) return { rows: [], rowCount: 0 };

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

async function startServer(pool: pg.Pool): Promise<{ port: number; close: () => Promise<void> }> {
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
  body?: unknown,
  opts: { devUser?: string | null } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    if (opts.devUser !== null) headers["x-dev-user"] = opts.devUser ?? "e-owner";
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString()));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
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
    agentInTenant: true,
    existingRow: null,
    insertRan: { value: false },
    ...over,
  };
}

const PATH = `/api/agents/${AGENT_ID}/instruction`;

// ---------------------------------------------------------------------------
// AC-1 — PUT writes a draft row keyed on the REAL agent employee_id.
// ---------------------------------------------------------------------------

describe("T-0637 AC-1 — PUT /api/agents/:id/instruction writes a draft row for a real workforce agent", () => {
  it("200, echoes tier=draft + instruction_id; a subsequent GET returns the saved text", async () => {
    const s = baseScenario({ isOwner: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const put = await request(port, "PUT", PATH, { text: "Проверяй заявки и суммируй расходы." });
      expect(put.status).toBe(200);
      expect(s.insertRan.value).toBe(true);
      const putBody = put.body as { employee_id?: string; tier?: string; instruction_id?: string };
      expect(putBody.employee_id).toBe(AGENT_ID);
      expect(putBody.tier).toBe("draft");
      expect(typeof putBody.instruction_id).toBe("string");

      const get = await request(port, "GET", PATH);
      expect(get.status).toBe(200);
      expect(get.body).toMatchObject({
        employee_id: AGENT_ID,
        text: "Проверяй заявки и суммируй расходы.",
        tier: "draft",
      });
    } finally {
      await close();
    }
  });

  it("GET on an agent with neither draft nor published row → tier:null, text:null, instruction_id:null", async () => {
    const s = baseScenario({ isOwner: true, existingRow: null });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        employee_id: AGENT_ID,
        text: null,
        tier: null,
        instruction_id: null,
      });
    } finally {
      await close();
    }
  });

  it("GET falls back to published when no draft exists", async () => {
    const publishedRow: Row = {
      tenant_id: TENANT_A, id: "pub-1", employee_id: AGENT_ID, employee_kind: "agent",
      tier: "published", instruction_text: "Опубликованная компетенция.", answer_form: null,
      instruction_meta: {}, bundle_id: null, created_at: 0, updated_at: 0,
    };
    const s = baseScenario({ isOwner: true, existingRow: publishedRow });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        employee_id: AGENT_ID,
        text: "Опубликованная компетенция.",
        tier: "published",
        instruction_id: "pub-1",
      });
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2 — authz gate (same class as llm-connection / secret-handle).
// ---------------------------------------------------------------------------

describe("T-0637 AC-2 — authz gate", () => {
  it("PUT: neither owner nor mgmt grant → 403 ADMIN_GATE_REJECTED, no write", async () => {
    const s = baseScenario({ isOwner: false, hasAgentMgmtGrant: false });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { text: "injected" });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("ADMIN_GATE_REJECTED");
      expect(s.insertRan.value).toBe(false);
    } finally {
      await close();
    }
  });

  it("GET: neither owner nor mgmt grant → 403 ADMIN_GATE_REJECTED", async () => {
    const s = baseScenario({ isOwner: false, hasAgentMgmtGrant: false });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "GET", PATH);
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("ADMIN_GATE_REJECTED");
    } finally {
      await close();
    }
  });

  it("PUT: a non-owner holding a delegable mgmt_object:agent/update grant CAN write → 200", async () => {
    const s = baseScenario({ isOwner: false, hasAgentMgmtGrant: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { text: "ok" });
      expect(r.status).toBe(200);
      expect(s.insertRan.value).toBe(true);
    } finally {
      await close();
    }
  });

  it("no x-dev-user header → 401, no write", async () => {
    const s = baseScenario({ isOwner: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { text: "x" }, { devUser: null });
      expect(r.status).toBe(401);
      expect(s.insertRan.value).toBe(false);
    } finally {
      await close();
    }
  });

  it("foreign / missing agent → 404 AGENT_NOT_FOUND (GET and PUT)", async () => {
    const s = baseScenario({ isOwner: true, agentInTenant: false });
    const { port, close } = await startServer(makePool(s));
    try {
      const getR = await request(port, "GET", PATH);
      expect(getR.status).toBe(404);
      expect(errCode(getR.body)).toBe("AGENT_NOT_FOUND");

      const putR = await request(port, "PUT", PATH, { text: "x" });
      expect(putR.status).toBe(404);
      expect(errCode(putR.body)).toBe("AGENT_NOT_FOUND");
      expect(s.insertRan.value).toBe(false);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3 — published-lock: PUT against a published row → 409, no new write.
// ---------------------------------------------------------------------------

describe("T-0637 AC-3 — published-lock", () => {
  it("PUT against an agent whose instruction is already tier=published → 409 PUBLISHED_LOCKED, no write", async () => {
    const publishedRow: Row = {
      tenant_id: TENANT_A, id: "pub-locked", employee_id: AGENT_ID, employee_kind: "agent",
      tier: "published", instruction_text: "locked text", answer_form: null,
      instruction_meta: {}, bundle_id: null, created_at: 0, updated_at: 0,
    };
    const s = baseScenario({ isOwner: true, existingRow: publishedRow });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { text: "new text attempt" });
      expect(r.status).toBe(409);
      expect(errCode(r.body)).toBe("PUBLISHED_LOCKED");
      expect(s.insertRan.value).toBe(false);

      // The row is unaffected — a follow-up GET still returns the published text.
      const get = await request(port, "GET", PATH);
      expect(get.body).toMatchObject({ text: "locked text", tier: "published" });
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

describe("T-0637 — validation", () => {
  it("PUT with a non-string text → 400 VALIDATION, no write", async () => {
    const s = baseScenario({ isOwner: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { text: 42 });
      expect(r.status).toBe(400);
      expect(s.insertRan.value).toBe(false);
    } finally {
      await close();
    }
  });

  it("PUT with an empty string text is a VALID draft (clears the content, not the row)", async () => {
    const s = baseScenario({ isOwner: true });
    const { port, close } = await startServer(makePool(s));
    try {
      const r = await request(port, "PUT", PATH, { text: "" });
      expect(r.status).toBe(200);
      expect(s.insertRan.value).toBe(true);
    } finally {
      await close();
    }
  });
});
