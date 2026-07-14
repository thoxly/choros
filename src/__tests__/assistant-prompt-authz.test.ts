/**
 * T-0383 · assistant-prompt route — authz gate tests.
 *
 * Verifies BLOCKER fix: GET and PUT /api/assistant/prompt/:role are now gated
 * behind genesis-owner OR mgmt_object:agent/update grant. Any authenticated
 * tenant member that does NOT hold that authority receives 403 ADMIN_GATE_REJECTED.
 *
 * Pure unit — no live Postgres. A small in-memory fake pg pool models the minimal
 * queries that loadAdminContext issues (tenant-owner role_assignment lookup +
 * mgmt_object grants query), mirroring the pattern in llm-config-security.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerAssistantPromptRoutes } from "../http/assistant-prompt-routes.js";

const TENANT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ADMIN = "e-admin";
const NON_ADMIN = "e-nobody";

// ---------------------------------------------------------------------------
// Fake pg pool — models the minimal queries loadAdminContext issues.
// ---------------------------------------------------------------------------

interface FakeState {
  /** Actor slugs that resolve to genesis-owner in loadAdminContext. */
  owners: Set<string>;
}

function makeFakePool(state: FakeState): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = async (sql: string, params?: unknown[]): Promise<any> => {
      const text = sql.trim();
      const p = params ?? [];

      if (/^BEGIN/i.test(text)) return { rows: [] };
      if (/^COMMIT/i.test(text)) return { rows: [] };
      if (/^ROLLBACK/i.test(text)) return { rows: [] };
      if (/SET LOCAL/i.test(text)) return { rows: [] };

      // loadAdminContext: tenant-owner lookup — returns a row iff actor is owner.
      if (/role r[\s\S]*r\.slug = 'tenant-owner'/.test(text)) {
        const actorSlug = String(p[1] ?? "");
        return { rows: state.owners.has(actorSlug) ? [{ id: "ra-1" }] : [] };
      }
      // loadAdminContext: confirmed role-assignment rows (none for non-owners).
      if (/SELECT ra\.id, ra\.role_id, ra\.org_scope/.test(text)) {
        return { rows: [] };
      }

      // resolveActorSlugFromAuth: not called in x-dev-user path (returns header directly).
      // resolveAssistantAgentId (DAO): assistant-agent employee lookup.
      if (/SELECT id FROM choros\.employee[\s\S]*slug = 'assistant-agent'/.test(text)) {
        return { rows: [{ id: "eeeeeeee-0000-0000-0000-000000000001" }] };
      }
      // readDraft / readPublished / readCurrent (agent-instruction-store): no custom prompt.
      if (/FROM choros\.agent_instruction/i.test(text)) {
        return { rows: [] };
      }
      // saveDraft INSERT ... ON CONFLICT.
      if (/INSERT INTO choros\.agent_instruction/i.test(text)) {
        return { rows: [] };
      }

      // Canonical audit writer: current_setting GUC read for preimage.
      if (/current_setting\('choros\.tenant_id'/.test(text) && /AS tenant_id/.test(text)) {
        return { rows: [{ tenant_id: TENANT_ID }] };
      }
      // Audit writer: seed head (INSERT ... ON CONFLICT DO NOTHING).
      if (/INSERT INTO choros\.audit_head/i.test(text)) {
        return { rows: [] };
      }
      // Audit writer: head lock SELECT ... FOR UPDATE.
      if (/FROM choros\.audit_head[\s\S]*FOR UPDATE/i.test(text)) {
        return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
      }
      // Audit writer: head advance UPDATE.
      if (/UPDATE choros\.audit_head/i.test(text)) {
        return { rows: [] };
      }
      // Audit writer: INSERT audit_event.
      if (/INSERT INTO choros\.audit_event/i.test(text)) {
        return { rows: [] };
      }

      return { rows: [] };
    };

    return { query, release: () => {} } as unknown as import("pg").PoolClient;
  }

  return { connect: async () => makeClient() } as unknown as import("pg").Pool;
}

function buildServer(
  state: FakeState,
): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  const pool = makeFakePool(state);
  registerAssistantPromptRoutes(router, {
    pool,
    resolveActorTenant: async () => TENANT_ID,
  });
  router.setFallback((_req, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const server = http.createServer(router.dispatch.bind(router));
  return {
    server,
    baseUrl: () =>
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}

async function httpReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf =
      body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(buf
          ? {
              "Content-Type": "application/json",
              "Content-Length": String(buf.length),
            }
          : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => {
        data += c.toString();
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: { raw: data } });
        }
      });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PUT /api/assistant/prompt/:role — authz gate (BLOCKER fix T-0383)", () => {
  let server: http.Server;
  let base: string;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function start(state: FakeState): Promise<void> {
    const h = buildServer(state);
    server = h.server;
    await new Promise<void>((r) =>
      server.listen(0, "127.0.0.1", () => {
        base = h.baseUrl();
        r();
      }),
    );
  }

  it("non-admin actor gets 403 ADMIN_GATE_REJECTED, no write", async () => {
    await start({ owners: new Set([ADMIN]) });
    const r = await httpReq(
      "PUT",
      `${base}/api/assistant/prompt/analyst`,
      { "x-dev-user": NON_ADMIN },
      { text: "injected prompt" },
    );
    expect(r.status).toBe(403);
    expect(
      (r.json as { error: { code: string } }).error.code,
    ).toBe("ADMIN_GATE_REJECTED");
  });

  it("genesis-owner actor can write (200)", async () => {
    await start({ owners: new Set([ADMIN]) });
    const r = await httpReq(
      "PUT",
      `${base}/api/assistant/prompt/analyst`,
      { "x-dev-user": ADMIN },
      { text: "new prompt text" },
    );
    // The DAO will try to resolve assistant-agent then saveDraft; in our fake
    // there's no published row to lock on so saveDraft eventually reaches
    // saveDraft which runs an INSERT — our fake returns empty rows for that
    // too. The happy path goes to 200.
    expect(r.status).toBe(200);
    expect((r.json as { ok?: boolean }).ok).toBe(true);
  });
});

describe("GET /api/assistant/prompt/:role — authz gate (BLOCKER fix T-0383)", () => {
  let server: http.Server;
  let base: string;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function start(state: FakeState): Promise<void> {
    const h = buildServer(state);
    server = h.server;
    await new Promise<void>((r) =>
      server.listen(0, "127.0.0.1", () => {
        base = h.baseUrl();
        r();
      }),
    );
  }

  it("non-admin actor gets 403 ADMIN_GATE_REJECTED on GET", async () => {
    await start({ owners: new Set([ADMIN]) });
    const r = await httpReq(
      "GET",
      `${base}/api/assistant/prompt/analyst`,
      { "x-dev-user": NON_ADMIN },
    );
    expect(r.status).toBe(403);
    expect(
      (r.json as { error: { code: string } }).error.code,
    ).toBe("ADMIN_GATE_REJECTED");
  });

  it("genesis-owner actor reads config (200)", async () => {
    await start({ owners: new Set([ADMIN]) });
    const r = await httpReq(
      "GET",
      `${base}/api/assistant/prompt/analyst`,
      { "x-dev-user": ADMIN },
    );
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["role"]).toBe("analyst");
  });
});
