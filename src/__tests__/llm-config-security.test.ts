/**
 * T-0382 · LLM-config security fixes — unit tests.
 *
 * Covers the three security defects fixed in T-0382:
 *
 *   BLOCKER-1 (env exfiltration): decideEnvHandle + the live composition-root
 *     tenantSecretResolver reject ANY env:// handle not on the explicit allow-list
 *     (DATABASE_URL, arbitrary vars) and never return the env value — proving the
 *     arbitrary-server-env-exfiltration vector is closed.
 *   BLOCKER-1 (endpoint policy): PUT /api/llm-config rejects non-https endpoints
 *     (the resolved key ships as a bearer token).
 *   BLOCKER-2 (atomicity): the endpoint/model UPDATE and the audit append run in
 *     ONE transaction on ONE connection — when the audit append throws, the UPDATE
 *     rolls back (no orphaned write).
 *   MINOR (authz): GET /api/llm-config is admin-gated — a non-admin gets 403,
 *     matching PUT.
 *
 * Pure unit — no live Postgres. A small in-memory fake pg pool models the
 * minimal queries the route issues (admin-context resolution, agent_card read,
 * agent org-scope, UPDATE, and the canonical audit writer's INSERT/head SELECT).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerLlmConfigRoutes } from "../http/llm-config.js";
import {
  decideEnvHandle,
  DEFAULT_ENV_HANDLE_ALLOWLIST,
} from "../core/env-secret-allowlist.js";
import { tenantSecretResolver } from "../server.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const ADMIN = "e-admin";
const NON_ADMIN = "e-nobody";

// ---------------------------------------------------------------------------
// BLOCKER-1: env:// allow-list (the env-exfiltration proof)
// ---------------------------------------------------------------------------

describe("BLOCKER-1 · decideEnvHandle env:// allow-list", () => {
  it("ALLOWS the single dev-fallback key env://DEEPSEEK_API_KEY", () => {
    expect(decideEnvHandle("env://DEEPSEEK_API_KEY")).toEqual({
      kind: "allowed",
      varName: "DEEPSEEK_API_KEY",
    });
  });

  it("DENIES env://DATABASE_URL (the headline exfil vector)", () => {
    expect(decideEnvHandle("env://DATABASE_URL")).toEqual({
      kind: "denied",
      varName: "DATABASE_URL",
    });
  });

  it("DENIES arbitrary server env vars (KC secrets, cloud creds, anything else)", () => {
    for (const v of [
      "KC_REGISTRAR_CLIENT_SECRET",
      "FLOWABLE_REST_APP_ADMIN_PASSWORD",
      "AWS_SECRET_ACCESS_KEY",
      "HOME",
      "PATH",
      "ANYTHING_ELSE",
    ]) {
      expect(decideEnvHandle(`env://${v}`)).toEqual({ kind: "denied", varName: v });
    }
  });

  it("treats non-env schemes as not_env (handled elsewhere — vault://, opaque)", () => {
    expect(decideEnvHandle("vault://secret/llm/x").kind).toBe("not_env");
    expect(decideEnvHandle("someOpaqueToken123").kind).toBe("not_env");
  });

  it("allow-list contains EXACTLY the one dev fallback key", () => {
    expect([...DEFAULT_ENV_HANDLE_ALLOWLIST]).toEqual(["DEEPSEEK_API_KEY"]);
  });
});

describe("BLOCKER-1 + T-0413 · live tenantSecretResolver refuses ALL env:// handles", () => {
  it("THROWS on env://DATABASE_URL and never returns the env value", async () => {
    // Plant a sentinel so a leak would be visible as the returned value.
    const SENTINEL = "postgres://leaked-secret-should-never-be-returned";
    const prev = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = SENTINEL;
    try {
      await expect(
        tenantSecretResolver.resolveSecret("env://DATABASE_URL", { tenantId: TENANT_ID }),
      ).rejects.toThrow(/system-only/i);
    } finally {
      if (prev === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prev;
    }
  });

  it("THROWS on an arbitrary env:// handle (env://SECRET_X) even if the var is set", async () => {
    const prev = process.env["SECRET_X"];
    process.env["SECRET_X"] = "super-secret-value";
    try {
      const result = tenantSecretResolver.resolveSecret("env://SECRET_X", {
        tenantId: TENANT_ID,
      });
      await expect(result).rejects.toThrow();
      // Belt-and-suspenders: confirm the rejection reason does not echo the value.
      await result.catch((e: unknown) => {
        expect(String(e)).not.toContain("super-secret-value");
      });
    } finally {
      if (prev === undefined) delete process.env["SECRET_X"];
      else process.env["SECRET_X"] = prev;
    }
  });

  it("T-0413: REJECTS env://DEEPSEEK_API_KEY — env:// is system-only, never tenant-resolvable", async () => {
    // After T-0413 the tenant resolver rejects ALL env:// handles including the
    // canonical allowlisted one. The system fallback (deepseekSecretResolver) is
    // wired separately in makeLlmPortFactory and is NOT the tenantSecretResolver.
    const prev = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "dev-fallback-key";
    try {
      await expect(
        tenantSecretResolver.resolveSecret("env://DEEPSEEK_API_KEY", { tenantId: TENANT_ID }),
      ).rejects.toThrow(/system-only/i);
    } finally {
      if (prev === undefined) delete process.env["DEEPSEEK_API_KEY"];
      else process.env["DEEPSEEK_API_KEY"] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Fake pg pool — models the minimal queries the llm-config route issues.
// ---------------------------------------------------------------------------

interface FakeState {
  /** Actor slugs that resolve to genesis-owner (admin) in loadAdminContext. */
  owners: Set<string>;
  /** Current persisted endpoint/model (the "row"). Mutated by UPDATE. */
  card: { llm_endpoint: string | null; llm_model: string | null; secret_bound: boolean };
  /** If true, the audit-writer INSERT throws — to exercise tx rollback (BLOCKER-2). */
  failAudit: boolean;
  /** Records the UPDATE result for assertions (committed value). */
  committedEndpoint: string | null;
  committedModel: string | null;
}

function makeFakePool(state: FakeState): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    let tenant = "";
    // Staged-but-uncommitted UPDATE values; only flushed to state on COMMIT.
    let pendingEndpoint: string | null = null;
    let pendingModel: string | null = null;
    let dirty = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = async (sql: string, params?: unknown[]): Promise<any> => {
      const text = sql.trim();
      const p = params ?? [];

      const setM = /SET LOCAL choros\.tenant_id = '([^']+)'/.exec(text);
      if (setM) { tenant = setM[1]; return { rows: [] }; }
      if (/^BEGIN/i.test(text)) { dirty = false; return { rows: [] }; }
      if (/^COMMIT/i.test(text)) {
        if (dirty) {
          state.card.llm_endpoint = pendingEndpoint;
          state.card.llm_model = pendingModel;
          state.committedEndpoint = pendingEndpoint;
          state.committedModel = pendingModel;
        }
        return { rows: [] };
      }
      if (/^ROLLBACK/i.test(text)) { dirty = false; return { rows: [] }; }
      if (/SET LOCAL search_path/i.test(text)) { return { rows: [] }; }

      // loadAdminContext: tenant-owner lookup (returns a row iff actor is owner).
      if (/role r[\s\S]*r\.slug = 'tenant-owner'/.test(text)) {
        const actorSlug = String(p[1] ?? "");
        return { rows: state.owners.has(actorSlug) ? [{ id: "ra-1" }] : [] };
      }
      // loadAdminContext: confirmed assignments (none — non-owners have no grants).
      if (/SELECT ra\.id, ra\.role_id, ra\.org_scope/.test(text)) {
        return { rows: [] };
      }

      // readPrimaryAgentLlmConfig: agent_card ⋈ employee primary row.
      // (matches on the aliased handle field, which is unique to this query).
      if (/secret_handle_ref/.test(text)) {
        return {
          rows: [
            {
              employee_id: AGENT_ID,
              slug: "assistant-agent",
              llm_endpoint: state.card.llm_endpoint,
              llm_model: state.card.llm_model,
              secret_handle_ref: state.card.secret_bound ? "vault://x" : null,
            },
          ],
        };
      }

      // loadAgentOrgScope: employee ⋈ position department lookup.
      if (/FROM choros\.employee e[\s\S]*LEFT JOIN choros\.position p/.test(text)) {
        return { rows: [{ department_id: null }] };
      }

      // updateAgentLlmEndpointModel: stage the write (flushed on COMMIT only).
      if (/UPDATE choros\.agent_card/.test(text)) {
        pendingEndpoint = String(p[1]);
        pendingModel = String(p[2]);
        dirty = true;
        return { rows: [{ employee_id: AGENT_ID }] };
      }

      // Canonical audit writer: read GUC tenant for the preimage.
      if (/current_setting\('choros\.tenant_id'/.test(text) && /AS tenant_id/.test(text)) {
        return { rows: [{ tenant_id: tenant || TENANT_ID }] };
      }
      // Audit writer: seed head (INSERT ... ON CONFLICT DO NOTHING) — no-op.
      if (/INSERT INTO choros\.audit_head/i.test(text)) {
        return { rows: [] };
      }
      // Audit writer: head lock SELECT ... FOR UPDATE → genesis head row.
      if (/FROM choros\.audit_head[\s\S]*FOR UPDATE/i.test(text)) {
        return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
      }
      // Audit writer: head advance UPDATE.
      if (/UPDATE choros\.audit_head/i.test(text)) {
        return { rows: [] };
      }
      // Audit writer INSERT event — optionally fail to exercise rollback (BLOCKER-2).
      if (/INSERT INTO choros\.audit_event/i.test(text)) {
        if (state.failAudit) {
          throw new Error("simulated audit append failure (tx must roll back)");
        }
        return { rows: [] };
      }

      // Default: empty result.
      return { rows: [] };
    };

    return {
      query,
      release: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  return {
    connect: async () => makeClient(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function buildServer(state: FakeState): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  const pool = makeFakePool(state);
  registerLlmConfigRoutes(router, {
    pool,
    resolveActorTenant: async () => TENANT_ID,
  });
  router.setFallback((_req, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const server = http.createServer(router.dispatch.bind(router));
  return { server, baseUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function httpReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(buf ? { "Content-Type": "application/json", "Content-Length": String(buf.length) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, json: { raw: data } }); }
      });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    owners: new Set([ADMIN]),
    card: { llm_endpoint: "https://old.example.com", llm_model: "old-model", secret_bound: true },
    failAudit: false,
    committedEndpoint: null,
    committedModel: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

describe("PUT /api/llm-config — endpoint policy + authz + atomicity", () => {
  let server: http.Server;
  let base: string;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function start(state: FakeState): Promise<void> {
    const h = buildServer(state);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  }

  it("BLOCKER-1: rejects a non-https (http://) endpoint with 400", async () => {
    const state = freshState();
    await start(state);
    const r = await httpReq("PUT", `${base}/api/llm-config`, { "x-dev-user": ADMIN }, {
      llm_endpoint: "http://attacker.example.com",
      llm_model: "m",
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("VALIDATION");
    // No write committed.
    expect(state.committedEndpoint).toBeNull();
  });

  it("authz: non-admin actor gets 403 ADMIN_GATE_REJECTED, no write", async () => {
    const state = freshState();
    await start(state);
    const r = await httpReq("PUT", `${base}/api/llm-config`, { "x-dev-user": NON_ADMIN }, {
      llm_endpoint: "https://api.example.com",
      llm_model: "m",
    });
    expect(r.status).toBe(403);
    expect((r.json as { error: { code: string } }).error.code).toBe("ADMIN_GATE_REJECTED");
    expect(state.committedEndpoint).toBeNull();
  });

  it("BLOCKER-2: when the audit append fails, the endpoint/model UPDATE rolls back", async () => {
    const state = freshState({ failAudit: true });
    await start(state);
    const r = await httpReq("PUT", `${base}/api/llm-config`, { "x-dev-user": ADMIN }, {
      llm_endpoint: "https://api.new-endpoint.com",
      llm_model: "new-model",
    });
    // The request fails (500/throw surfaces) — but crucially nothing committed.
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(state.committedEndpoint).toBeNull();
    expect(state.committedModel).toBeNull();
    // The persisted card is unchanged (UPDATE + audit are atomic).
    expect(state.card.llm_endpoint).toBe("https://old.example.com");
    expect(state.card.llm_model).toBe("old-model");
  });

  it("happy path: admin sets https endpoint+model; both commit atomically", async () => {
    const state = freshState();
    await start(state);
    const r = await httpReq("PUT", `${base}/api/llm-config`, { "x-dev-user": ADMIN }, {
      llm_endpoint: "https://api.new-endpoint.com",
      llm_model: "new-model",
    });
    expect(r.status).toBe(200);
    expect((r.json as { ok?: boolean }).ok).toBe(true);
    // T-0413: stored as normalized href (WHATWG adds trailing slash on bare host).
    expect(state.committedEndpoint).toBe("https://api.new-endpoint.com/");
    expect(state.committedModel).toBe("new-model");
  });
});

describe("GET /api/llm-config — admin-gated (MINOR)", () => {
  let server: http.Server;
  let base: string;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function start(state: FakeState): Promise<void> {
    const h = buildServer(state);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  }

  it("non-admin actor gets 403 (consistent with PUT)", async () => {
    const state = freshState();
    await start(state);
    const r = await httpReq("GET", `${base}/api/llm-config`, { "x-dev-user": NON_ADMIN });
    expect(r.status).toBe(403);
    expect((r.json as { error: { code: string } }).error.code).toBe("ADMIN_GATE_REJECTED");
  });

  it("admin actor reads config (200) and NEVER receives the raw handle", async () => {
    const state = freshState();
    await start(state);
    const r = await httpReq("GET", `${base}/api/llm-config`, { "x-dev-user": ADMIN });
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["secret_bound"]).toBe(true);
    // No field carries the raw handle.
    expect(JSON.stringify(body)).not.toContain("vault://x");
  });
});

// ---------------------------------------------------------------------------
// T-0413: env:// scheme is SYSTEM-ONLY + endpoint tightening (userinfo + normalization)
// ---------------------------------------------------------------------------

describe("T-0413 · tenant env:// handles are ALWAYS rejected", () => {
  it("rejects env://DEEPSEEK_API_KEY — the shared system key must not be exfiltrable via tenant handle", async () => {
    // Attack vector (from T-0417 red-team): tenant sets the agent secret handle to
    // env://DEEPSEEK_API_KEY + llm_endpoint = https://attacker-host → the system key
    // ships as a Bearer token to the attacker. T-0413 closes this by making the
    // tenant resolver reject ALL env:// handles, including the allow-listed one.
    const prev = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "shared-system-key-must-not-leak";
    try {
      await expect(
        tenantSecretResolver.resolveSecret("env://DEEPSEEK_API_KEY", { tenantId: TENANT_ID }),
      ).rejects.toThrow(/system-only/i);
    } finally {
      if (prev === undefined) delete process.env["DEEPSEEK_API_KEY"];
      else process.env["DEEPSEEK_API_KEY"] = prev;
    }
  });

  it("rejects any env:// handle — the scheme is never resolvable in the tenant path", async () => {
    for (const handle of [
      "env://DATABASE_URL",
      "env://KC_REGISTRAR_CLIENT_SECRET",
      "env://DEEPSEEK_API_KEY",
      "env://AWS_SECRET_ACCESS_KEY",
    ]) {
      await expect(
        tenantSecretResolver.resolveSecret(handle, { tenantId: TENANT_ID }),
      ).rejects.toThrow(/system-only/i);
    }
  });
});

describe("T-0413 · PUT /api/llm-config rejects userinfo endpoints", () => {
  let server: http.Server;
  let base: string;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function start(state: FakeState): Promise<void> {
    const h = buildServer(state);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  }

  it("rejects https://user@host with 400 VALIDATION and no write", async () => {
    const state = freshState();
    await start(state);
    const r = await httpReq("PUT", `${base}/api/llm-config`, { "x-dev-user": ADMIN }, {
      llm_endpoint: "https://stolen-user@attacker.example.com",
      llm_model: "m",
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("VALIDATION");
    expect(state.committedEndpoint).toBeNull();
  });

  it("stores the WHATWG-normalized href (trailing slash on bare host)", async () => {
    const state = freshState();
    await start(state);
    const r = await httpReq("PUT", `${base}/api/llm-config`, { "x-dev-user": ADMIN }, {
      llm_endpoint: "https://api.deepseek.com",
      llm_model: "deepseek-chat",
    });
    expect(r.status).toBe(200);
    // WHATWG URL normalizes bare host → adds trailing slash.
    expect(state.committedEndpoint).toBe("https://api.deepseek.com/");
  });
});
