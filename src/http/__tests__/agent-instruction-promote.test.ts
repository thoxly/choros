/**
 * src/http/__tests__/agent-instruction-promote.test.ts — T-0637 AC-4
 *
 * Proves the end-to-end promote sequence WITHOUT a single new promote mechanism:
 *
 *   PUT /api/agents/:id/instruction { text }        (this task's new route)
 *     → 200 { instruction_id, tier: 'draft' }
 *   POST /api/artifacts/:instruction_id/promote { artifact_table: 'agent_instruction' }
 *     → 200 { tier: 'published' }                    (EXISTING route, zero changes)
 *   GET /api/agents/:id/instruction
 *     → tier: 'published', same text
 *
 * The fake pool is a single in-memory row store shared across BOTH routers
 * (registerAgentRoutes + registerArtifactRoutes), proving the SAME row is
 * mutated by two independently-registered route sets with no new backend code
 * in src/http/artifacts.ts or src/core/env-tier.ts (git diff of those files is
 * empty for this task).
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../router.js";
import { registerAgentRoutes } from "../agents.js";
import { registerArtifactRoutes, resetPoolForTesting, type ArtifactAuthzDeps } from "../artifacts.js";
import type { KeycloakAdminPort } from "../../core/agent-hire.js";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const AGENT_ID = "cccccccc-0000-0000-0000-000000000003";
const DEPT_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const ROLE_ID = "eeeeeeee-0000-0000-0000-000000000005";

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

function makeSharedPool(): { pool: pg.Pool; getRow: () => Row | null } {
  let row: Row | null = null;

  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };
      const p = params ?? [];
      const t = text.trim();

      if (/^BEGIN/i.test(t)) return { rows: [], rowCount: 0 };
      if (/^COMMIT/i.test(t)) return { rows: [], rowCount: 0 };
      if (/^ROLLBACK/i.test(t)) return { rows: [], rowCount: 0 };
      if (/^SET LOCAL/i.test(t)) return { rows: [], rowCount: 0 };

      // resolveActorTenant.
      if (text.includes("FROM choros.employee e") && text.includes("JOIN choros.tenant t")) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }
      // loadAdminContext: owner.
      if (text.includes("'tenant-owner'") && text.includes("role_assignment")) {
        return { rows: [{ id: "ra-owner" }], rowCount: 1 }; // always owner in this test
      }
      if (text.includes("SELECT ra.id, ra.role_id, ra.org_scope")) {
        return { rows: [], rowCount: 0 };
      }
      // loadAgentOrgScope.
      if (text.includes("p.department_id") && text.includes("FROM choros.employee e")) {
        return { rows: [{ department_id: DEPT_ID }], rowCount: 1 };
      }
      void ROLE_ID;

      // Tenant existence guard (agents.ts handlers).
      if (
        text.includes("SELECT id") &&
        text.includes("FROM choros.employee") &&
        text.includes("WHERE tenant_id = $1 AND id = $2")
      ) {
        return { rows: [{ id: AGENT_ID }], rowCount: 1 };
      }

      // readByTier (draft/published) via the facade.
      if (text.includes("FROM choros.agent_instruction") && text.includes("AND tier = $2")) {
        const tier = p[1] as string;
        return { rows: row && row.tier === tier ? [row] : [], rowCount: row && row.tier === tier ? 1 : 0 };
      }
      // readCurrent (any tier).
      if (text.includes("FROM choros.agent_instruction") && text.includes("WHERE employee_id = $1") && !text.includes("tier = $2")) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      // saveDraft UPSERT.
      if (text.includes("INSERT INTO choros.agent_instruction")) {
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

      // promoteTier: SELECT tier ... FOR UPDATE.
      if (text.includes("SELECT tier FROM") && text.includes("FOR UPDATE")) {
        return row ? { rows: [{ tier: row.tier }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // promoteTier: UPDATE ... SET tier = 'published'.
      if (text.includes("SET tier = 'published'")) {
        if (row) row = { ...row, tier: "published" };
        return { rows: [], rowCount: 1 };
      }

      // Audit writer (shared by saveDraft + promoteTier).
      if (text.includes("current_setting('choros.tenant_id'") && text.includes("AS tenant_id")) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }
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
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, getRow: () => row };
}

const noopKcPort: KeycloakAdminPort = {
  createServiceAccountClient: async () => ({ clientId: "noop" }),
  deleteClient: async () => {},
};

// Always grants promote authority — proves the SEQUENCE, not the promote-grant gate
// itself (that gate is pre-existing artifacts.ts behavior, out of this task's scope).
const allowPromoteDeps: ArtifactAuthzDeps = {
  checkTierPromoteGrant: async () => ({ ok: true }),
};

async function startServer(pool: pg.Pool): Promise<{ port: number; close: () => Promise<void> }> {
  resetPoolForTesting();
  const router = new Router();
  registerAgentRoutes(router, pool, noopKcPort);
  registerArtifactRoutes(
    router,
    { resolveActorTenant: async () => TENANT_A, authzDeps: allowPromoteDeps },
    pool,
  );
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
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { "x-dev-user": "e-owner" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
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

describe("T-0637 AC-4 — draft → promote → published, via the EXISTING shared promote route", () => {
  it("PUT instruction draft, then POST /api/artifacts/:id/promote flips tier to published; GET reflects it", async () => {
    const { pool, getRow } = makeSharedPool();
    const { port, close } = await startServer(pool);
    try {
      const put = await request(port, "PUT", `/api/agents/${AGENT_ID}/instruction`, {
        text: "Собирай данные по заявке и считай итог.",
      });
      expect(put.status).toBe(200);
      const instructionId = (put.body as { instruction_id: string }).instruction_id;
      expect(typeof instructionId).toBe("string");
      expect(getRow()?.tier).toBe("draft");

      const promote = await request(port, "POST", `/api/artifacts/${instructionId}/promote`, {
        artifact_table: "agent_instruction",
      });
      expect(promote.status).toBe(200);
      expect(promote.body).toMatchObject({
        promoted: true,
        artifact_id: instructionId,
        artifact_table: "agent_instruction",
        tier: "published",
      });
      expect(getRow()?.tier).toBe("published");

      const get = await request(port, "GET", `/api/agents/${AGENT_ID}/instruction`);
      expect(get.status).toBe(200);
      expect(get.body).toMatchObject({
        employee_id: AGENT_ID,
        text: "Собирай данные по заявке и считай итог.",
        tier: "published",
        instruction_id: instructionId,
      });
    } finally {
      await close();
    }
  });
});
