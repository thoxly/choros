/**
 * T-0417 · ADVERSARY (Враг red-team) — PUT /api/llm-config endpoint-policy suite.
 *
 * Surface under attack: T-0382 BLOCKER-1 (endpoint policy).
 *   src/http/llm-config.ts — the llm_endpoint receives the resolved LLM key as an
 *   `Authorization: Bearer <key>` header, so the policy is: must parse as a URL AND
 *   protocol must be exactly `https:` (no plaintext bearer over http://, no
 *   non-http schemes that could exfil the bearer).
 *
 * GOAL: hammer the URL/scheme gate with non-https schemes, malformed URLs, scheme
 * smuggling, and userinfo, and prove the policy holds: only an https:// endpoint
 * with no scheme-confusion writes. NOTHING commits on a rejected endpoint.
 *
 * NOTE on userinfo: `new URL("https://user@host")` parses with protocol "https:"
 * and is ACCEPTED by the current policy. That is NOT an env-exfil vector (the
 * resolver still only yields the allow-listed DEEPSEEK_API_KEY regardless of
 * endpoint), but we pin the observed behavior so a future tightening is a
 * conscious decision, not an accident.
 *
 * Pure unit — in-process http server + in-memory fake pg pool. Runnable NOW.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerLlmConfigRoutes } from "../http/llm-config.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const ADMIN = "e-admin";

interface FakeState {
  owners: Set<string>;
  card: { llm_endpoint: string | null; llm_model: string | null; secret_bound: boolean };
  committedEndpoint: string | null;
  committedModel: string | null;
}

function makeFakePool(state: FakeState): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    let pendingEndpoint: string | null = null;
    let pendingModel: string | null = null;
    let dirty = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = async (sql: string, params?: unknown[]): Promise<any> => {
      const text = sql.trim();
      const p = params ?? [];
      if (/SET LOCAL choros\.tenant_id/.test(text)) return { rows: [] };
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
      if (/SET LOCAL search_path/i.test(text)) return { rows: [] };
      if (/role r[\s\S]*r\.slug = 'tenant-owner'/.test(text)) {
        const actorSlug = String(p[1] ?? "");
        return { rows: state.owners.has(actorSlug) ? [{ id: "ra-1" }] : [] };
      }
      if (/SELECT ra\.id, ra\.role_id, ra\.org_scope/.test(text)) return { rows: [] };
      if (/secret_handle_ref/.test(text)) {
        return {
          rows: [{
            employee_id: AGENT_ID,
            slug: "assistant-agent",
            llm_endpoint: state.card.llm_endpoint,
            llm_model: state.card.llm_model,
            secret_handle_ref: state.card.secret_bound ? "vault://x" : null,
          }],
        };
      }
      if (/FROM choros\.employee e[\s\S]*LEFT JOIN choros\.position p/.test(text)) {
        return { rows: [{ department_id: null }] };
      }
      if (/UPDATE choros\.agent_card/.test(text)) {
        pendingEndpoint = String(p[1]);
        pendingModel = String(p[2]);
        dirty = true;
        return { rows: [{ employee_id: AGENT_ID }] };
      }
      if (/current_setting\('choros\.tenant_id'/.test(text) && /AS tenant_id/.test(text)) {
        return { rows: [{ tenant_id: TENANT_ID }] };
      }
      if (/INSERT INTO choros\.audit_head/i.test(text)) return { rows: [] };
      if (/FROM choros\.audit_head[\s\S]*FOR UPDATE/i.test(text)) {
        return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
      }
      if (/UPDATE choros\.audit_head/i.test(text)) return { rows: [] };
      if (/INSERT INTO choros\.audit_event/i.test(text)) return { rows: [] };
      return { rows: [] };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { query, release: () => {} } as any;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { connect: async () => makeClient() } as any;
}

function buildServer(state: FakeState): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  registerLlmConfigRoutes(router, {
    pool: makeFakePool(state),
    resolveActorTenant: async () => TENANT_ID,
  });
  router.setFallback((_req, res) => { res.statusCode = 404; res.end("{}"); });
  const server = http.createServer(router.dispatch.bind(router));
  return { server, baseUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function httpReq(
  method: string, url: string, headers: Record<string, string>, body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname, port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search, method,
      headers: { ...headers, ...(buf ? { "Content-Type": "application/json", "Content-Length": String(buf.length) } : {}) },
    }, (res) => {
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

function freshState(): FakeState {
  return {
    owners: new Set([ADMIN]),
    card: { llm_endpoint: "https://old.example.com", llm_model: "old-model", secret_bound: true },
    committedEndpoint: null,
    committedModel: null,
  };
}

describe("Враг · PUT /api/llm-config rejects every non-https / malformed endpoint", () => {
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

  // Schemes that would either ship the bearer in plaintext or to a non-http
  // target — every one must be a 400 VALIDATION with NOTHING committed.
  const REJECTED_ENDPOINTS = [
    "http://attacker.example.com", // plaintext bearer
    "HTTP://attacker.example.com", // uppercase scheme (URL lowercases → still http:)
    "ftp://attacker.example.com", // wrong scheme
    "ws://attacker.example.com", // websocket
    "wss://attacker.example.com", // secure ws — still not https:
    "file:///etc/passwd", // file scheme
    "gopher://attacker.example.com", // SSRF-classic scheme
    "data:text/plain;base64,QQ==", // data URI
    "javascript:alert(1)", // js scheme
    "//attacker.example.com", // protocol-relative → not a valid absolute URL
    "attacker.example.com", // bare host, no scheme → URL parse fails
    "  ", // whitespace only → trimmed empty → 400
    "https://", // no host → URL parse fails
  ];

  for (const endpoint of REJECTED_ENDPOINTS) {
    it(`rejects ${JSON.stringify(endpoint)} with 400 and no write`, async () => {
      const state = freshState();
      await start(state);
      const r = await httpReq("PUT", `${base}/api/llm-config`, { "x-dev-user": ADMIN }, {
        llm_endpoint: endpoint, llm_model: "m",
      });
      expect(r.status).toBe(400);
      expect((r.json as { error: { code: string } }).error.code).toBe("VALIDATION");
      expect(state.committedEndpoint).toBeNull();
      // Persisted card unchanged.
      expect(state.card.llm_endpoint).toBe("https://old.example.com");
    });
  }

  it("a valid https:// endpoint with NO scheme confusion commits (positive control)", async () => {
    const state = freshState();
    await start(state);
    const r = await httpReq("PUT", `${base}/api/llm-config`, { "x-dev-user": ADMIN }, {
      llm_endpoint: "https://api.deepseek.com", llm_model: "deepseek-chat",
    });
    expect(r.status).toBe(200);
    expect(state.committedEndpoint).toBe("https://api.deepseek.com");
  });

  it("PINNED: single-slash https:/host normalizes to a valid https URL (accepted — still https/TLS)", async () => {
    // WHATWG URL normalizes "https:/host" → "https://host/" (protocol https:).
    // This is sloppy-slash normalization, NOT a non-https bypass: the bearer still
    // ships over TLS to that host. Pinned to document the normalization behavior.
    const state = freshState();
    await start(state);
    const r = await httpReq("PUT", `${base}/api/llm-config`, { "x-dev-user": ADMIN }, {
      llm_endpoint: "https:/api.deepseek.com", llm_model: "m",
    });
    expect(r.status).toBe(200);
    // NOTE: the route validates the *parsed* URL but persists the raw *trimmed
    // string* (not parsedEndpoint.href), so the stored value keeps the sloppy
    // single-slash form. Still https-scheme; the OpenAI port re-parses on use.
    expect(state.committedEndpoint).toBe("https:/api.deepseek.com");
  });

  it("PINNED BEHAVIOR: https:// with userinfo (https://user@host) is currently ACCEPTED", async () => {
    // This is NOT an env-exfil hole (the resolver only yields the allow-listed key
    // regardless of endpoint), but the policy is protocol-only — userinfo passes.
    // Pinned so a future tightening of the endpoint host/userinfo policy is
    // intentional, not silent. If this ever flips to 400, update the assertion.
    const state = freshState();
    await start(state);
    const r = await httpReq("PUT", `${base}/api/llm-config`, { "x-dev-user": ADMIN }, {
      llm_endpoint: "https://stolen-user@attacker.example.com", llm_model: "m",
    });
    expect(r.status).toBe(200);
    expect(state.committedEndpoint).toBe("https://stolen-user@attacker.example.com");
  });
});
