/**
 * src/__tests__/llm-connections.capability-authz.test.ts — T-0475 [E-AGENTS L4]
 *
 * Proves the new CAPABILITY gate on the LLM connection registry routes
 * (llm-connections.ts): configuring connections is no longer the mgmt_object
 * scoped-admin tier — it is now `genesis-owner OR holder of the
 * llm_connection:configure capability grant` (spec §6), fail-closed.
 *
 *   (a) a plain tenant member with NO owner role and NO capability grant
 *       CANNOT list or create connections                              → 403
 *   (b) the genesis OWNER (tenant-owner role) CAN                       → 200/201
 *   (c) a NON-owner holding llm_connection:configure CAN                → 200/201
 *
 * No real DB: a scripted in-memory stub pg.Pool replays exactly the queries the
 * gate runs — isGenesisOwnerForTenant (tenant-owner lookup) + getGrantsForSubject
 * (employee → role_assignment → grant). resolveActorTenant is an injected dep.
 * Runs in dev auth mode (x-dev-user); the slug→tenant→grant resolution is
 * auth-mode-agnostic.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerLlmConnectionsRoutes } from "../http/llm-connections.js";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const EMP_ID = "dddddddd-0000-0000-0000-000000000004";
const ROLE_ID = "eeeeeeee-0000-0000-0000-000000000005";

interface Principal {
  /** true → isGenesisOwnerForTenant returns a row (owner). */
  isOwner: boolean;
  /** resource_type strings the actor's role holds (confirmed grants). */
  grants: string[];
}

/**
 * Scripted stub pg.Pool. Replays:
 *   - isGenesisOwnerForTenant: 'tenant-owner' + role_assignment + LIMIT 1
 *   - getGrantsForSubject step 1: employee slug → id
 *   - getGrantsForSubject step 2: role_assignment → role_id
 *   - getGrantsForSubject step 3: grant rows for the role
 *   - listLlmConnections / createLlmConnection / audit / clearDefault → no-op OK
 */
function makePool(p: Principal): pg.Pool {
  const client = {
    query: async (text: string, _params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };

      // isGenesisOwnerForTenant: tenant-owner role lookup.
      if (text.includes("'tenant-owner'") && text.includes("role_assignment")) {
        return p.isOwner
          ? { rows: [{ id: "ra-owner" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      // getGrantsForSubject step 1: employee slug → id.
      if (text.includes("SELECT id FROM choros.employee") && text.includes("slug = $2")) {
        return { rows: [{ id: EMP_ID }], rowCount: 1 };
      }

      // getGrantsForSubject step 2: role_assignment → role_id.
      if (text.includes("SELECT ra.role_id") && text.includes("role_assignment")) {
        return { rows: [{ role_id: ROLE_ID }], rowCount: 1 };
      }

      // getGrantsForSubject step 3: grant rows for the role.
      if (text.includes('choros."grant"') && text.includes("role_id = ANY")) {
        const rows = p.grants.map((rt, i) => ({
          id: `g-${i}`,
          role_id: ROLE_ID,
          resource_type: rt,
          resource_facet: null,
          operation: rt === "llm_connection:configure" ? "configure" : "operate",
          scope: { kind: "set", members: [] },
          constraint: null,
          delegable: false,
          granted_by: "seed",
          valid_from: null,
          valid_until: null,
          created_at: "0",
        }));
        return { rows, rowCount: rows.length };
      }

      // Audit writer: tenant_id read.
      if (text.includes("current_setting('choros.tenant_id', false)") && text.includes("AS tenant_id")) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // Audit writer: audit_head SELECT ... FOR UPDATE → seeded head row.
      // row_hash MUST be a 32-byte Buffer (the hash chain treats it as bytes).
      if (text.includes("FROM choros.audit_head") && text.includes("FOR UPDATE")) {
        return {
          rows: [{ seq: "0", row_hash: Buffer.alloc(32), vocab_version: 1 }],
          rowCount: 1,
        };
      }

      // listLlmConnections SELECT → empty list (gate already passed by the time we get here).
      if (text.includes("FROM choros.llm_connection")) {
        return { rows: [], rowCount: 0 };
      }

      // createLlmConnection INSERT ... RETURNING → a minimal row the toView reads.
      if (text.includes("INSERT INTO choros.llm_connection")) {
        return {
          rows: [
            {
              id: "conn-1",
              name: "DeepSeek",
              provider: "deepseek",
              endpoint: null,
              model: null,
              secret_handle: null,
              price_input_per_1k: null,
              price_output_per_1k: null,
              currency: "USD",
              is_default: false,
              created_at: "0",
              updated_at: "0",
            },
          ],
          rowCount: 1,
        };
      }

      // BEGIN / SET LOCAL / COMMIT / ROLLBACK / audit / clearDefault → no-op OK.
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

async function startServer(pool: pg.Pool): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerLlmConnectionsRoutes(router, {
    pool,
    resolveActorTenant: async () => TENANT_A,
  });
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
  devUser = "e-someone",
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-dev-user": devUser,
        },
      },
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

// ---------------------------------------------------------------------------
// (a) plain member — neither owner nor capability — is rejected.
// ---------------------------------------------------------------------------

describe("T-0475 (a) — a plain member CANNOT configure llm-connections", () => {
  it("POST /api/llm-connections → 403", async () => {
    const { port, close } = await startServer(makePool({ isOwner: false, grants: [] }));
    try {
      const r = await request(port, "POST", "/api/llm-connections", {
        name: "DeepSeek",
        provider: "deepseek",
      });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("LLM_CONNECTION_CONFIGURE_REQUIRED");
    } finally {
      await close();
    }
  });

  it("GET /api/llm-connections → 403", async () => {
    const { port, close } = await startServer(makePool({ isOwner: false, grants: [] }));
    try {
      const r = await request(port, "GET", "/api/llm-connections", undefined);
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("LLM_CONNECTION_CONFIGURE_REQUIRED");
    } finally {
      await close();
    }
  });

  it("a member holding ONLY authoring_draft (not llm_connection:configure) is STILL rejected — connection config is its own capability", async () => {
    const { port, close } = await startServer(
      makePool({ isOwner: false, grants: ["authoring_draft"] }),
    );
    try {
      const r = await request(port, "POST", "/api/llm-connections", {
        name: "X",
        provider: "openai",
      });
      expect(r.status).toBe(403);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (b) genesis owner CAN.
// ---------------------------------------------------------------------------

describe("T-0475 (b) — the genesis owner CAN configure llm-connections", () => {
  it("POST → 201", async () => {
    const { port, close } = await startServer(makePool({ isOwner: true, grants: [] }));
    try {
      const r = await request(port, "POST", "/api/llm-connections", {
        name: "DeepSeek",
        provider: "deepseek",
      });
      expect(r.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("GET → 200", async () => {
    const { port, close } = await startServer(makePool({ isOwner: true, grants: [] }));
    try {
      const r = await request(port, "GET", "/api/llm-connections", undefined);
      expect(r.status).toBe(200);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) non-owner holding llm_connection:configure CAN.
// ---------------------------------------------------------------------------

describe("T-0475 (c) — a llm_connection:configure holder (non-owner) CAN configure", () => {
  it("POST → 201", async () => {
    const { port, close } = await startServer(
      makePool({ isOwner: false, grants: ["llm_connection:configure"] }),
    );
    try {
      const r = await request(port, "POST", "/api/llm-connections", {
        name: "DeepSeek",
        provider: "deepseek",
      });
      expect(r.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("GET → 200", async () => {
    const { port, close } = await startServer(
      makePool({ isOwner: false, grants: ["llm_connection:configure"] }),
    );
    try {
      const r = await request(port, "GET", "/api/llm-connections", undefined);
      expect(r.status).toBe(200);
    } finally {
      await close();
    }
  });
});
