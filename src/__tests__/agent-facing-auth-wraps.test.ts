/**
 * src/__tests__/agent-facing-auth-wraps.test.ts — T-0418 [SECURITY] P0
 *
 * Per-surface NEGATIVE test (ADR T-0328 §4.3 must-close list, last bullet):
 *
 *   In keycloak mode, a request that supplies `x-dev-user` but NO Bearer token
 *   MUST be rejected with 401 — proving the dev-header bypass is DEAD in prod on
 *   each wrapped surface (invoke, secret-handle, process-defs, binding).
 *
 * Plus a DEV-mode POSITIVE assertion per surface: with `x-dev-user` and the
 * default dev auth mode, the request reaches the handler (NOT 401) — proving the
 * withAuth wrap is a no-op pass-through in dev and the existing SPA/test path is
 * unchanged.
 *
 * WHY no JWKS mock is needed for the negative path:
 *   `withAuth` → `authenticate()` rejects a keycloak-mode request with no
 *   Authorization header at 401 BEFORE any token validation / JWKS fetch
 *   (auth.ts: "missing Authorization header"). So presenting x-dev-user alone is
 *   exactly the bypass attempt, and it short-circuits to 401 deterministically
 *   without a live/mock Keycloak.
 *
 * CHOROS_AUTH_MODE is read lazily per request by getAuthMode(), so toggling
 * process.env per test works; we always restore it in afterEach.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerInvokeRoutes } from "../http/invoke.js";
import { registerProcessDefsRoutes } from "../http/process-defs.js";
import { registerBindingRoutes } from "../http/binding.js";
import { registerSecretHandleRoutes } from "../http/secret-handle.js";
import { withAuthRegistrar } from "../http/auth-wrap-router.js";
import type { FlowableClient } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// Minimal HTTP harness (mirrors process-defs.test.ts)
// ---------------------------------------------------------------------------

function httpReq(
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
        ...(buf
          ? { "Content-Type": "application/json", "Content-Length": String(buf.length) }
          : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
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

// ---------------------------------------------------------------------------
// Pool stub — returns empty rows for any query. The negative (keycloak) path
// never reaches the DB (401 fires first); the dev positive path may touch it,
// so it must not throw. Empty-rows is the safe honest default.
// ---------------------------------------------------------------------------

function makeStubPool(): import("pg").Pool {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => {},
  };
  return {
    connect: async () => client as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

function makeStubFlowable(): FlowableClient {
  return {
    deployBpmn: vi.fn().mockResolvedValue({ ok: true, deploymentId: "d-1" }),
    startInstance: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    fetchAndLock: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    completeTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    failTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null }),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
    // T-0443: engine-reconcile stubs
    getActiveUserTasks: vi.fn().mockResolvedValue({ ok: true, tasks: [] }),
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
  };
}

// A well-formed tenant UUID for header/path args.
const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const DEV_USER = { "x-dev-user": "alice" };

// ---------------------------------------------------------------------------
// One server hosting all four P0 surfaces, registered EXACTLY as the
// composition root does (secret-handle via the withAuthRegistrar facade).
// ---------------------------------------------------------------------------

let server: http.Server;
let base: string;

beforeAll(async () => {
  const pool = makeStubPool();
  const flowable = makeStubFlowable();
  const router = new Router();

  registerInvokeRoutes(router, pool);
  registerProcessDefsRoutes(router, pool, flowable);
  registerBindingRoutes(router, pool, {
    pool,
    resolveActorTenant: async () => TENANT_ID,
  });
  // secret-handle.ts is FROZEN — wrapped at the registration site, identical to server.ts.
  registerSecretHandleRoutes(withAuthRegistrar(router) as unknown as typeof router, pool);

  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((r) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      base = `http://127.0.0.1:${addr.port}`;
      r();
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const ORIGINAL_AUTH_MODE = process.env["CHOROS_AUTH_MODE"];
afterEach(() => {
  if (ORIGINAL_AUTH_MODE === undefined) delete process.env["CHOROS_AUTH_MODE"];
  else process.env["CHOROS_AUTH_MODE"] = ORIGINAL_AUTH_MODE;
});

// The four P0 write surfaces, as { surface, method, path, body }.
const SURFACES: Array<{
  surface: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}> = [
  {
    surface: "invoke",
    method: "POST",
    path: "/api/invoke/request",
    body: { target_agent_id: AGENT_ID, goal: "do x" },
  },
  {
    surface: "process-defs",
    method: "POST",
    path: "/api/process-defs",
    headers: { "x-tenant-id": TENANT_ID },
    body: { processKey: "k", name: "N", bpmnXml: "<x/>" },
  },
  {
    surface: "binding",
    method: "POST",
    path: `/tenants/${TENANT_ID}/processes/p/forms/f/binding`,
    body: { fields: [] },
  },
  {
    surface: "secret-handle",
    method: "POST",
    path: `/api/agents/${AGENT_ID}/secret-handle`,
    body: { handle_value: "env://LLM_API_KEY" },
  },
];

// ---------------------------------------------------------------------------
// NEGATIVE: keycloak mode + x-dev-user + NO Bearer → 401 (bypass is dead)
// ---------------------------------------------------------------------------

describe("T-0418 P0: keycloak mode — x-dev-user without Bearer → 401 (bypass dead)", () => {
  for (const s of SURFACES) {
    it(`${s.surface}: ${s.method} ${s.path} → 401`, async () => {
      process.env["CHOROS_AUTH_MODE"] = "keycloak";
      const r = await httpReq(
        s.method,
        `${base}${s.path}`,
        { ...DEV_USER, ...(s.headers ?? {}) }, // x-dev-user present, NO Authorization
        s.body,
      );
      expect(r.status).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// POSITIVE (dev): x-dev-user reaches the handler (NOT 401) — wrap is a no-op.
//
// In dev mode the withAuth wrap passes through and the surface's own
// x-dev-user path authenticates, so the request must NOT 401. It may return a
// downstream status (400/403/404/...) from the stubbed DB — anything-but-401
// proves the dev bypass still works and authentication did not block it.
// ---------------------------------------------------------------------------

describe("T-0418 P0: dev mode — x-dev-user authenticates (no 401 regression)", () => {
  for (const s of SURFACES) {
    it(`${s.surface}: ${s.method} ${s.path} → not 401`, async () => {
      process.env["CHOROS_AUTH_MODE"] = "dev";
      const r = await httpReq(
        s.method,
        `${base}${s.path}`,
        { ...DEV_USER, ...(s.headers ?? {}) },
        s.body,
      );
      expect(r.status).not.toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// CONTROL: dev mode, NO x-dev-user → 401 on each surface. Proves the surface
// still authenticates SOMETHING in dev (the wrap did not accidentally make the
// route public) — the dev x-dev-user gate is intact.
// ---------------------------------------------------------------------------

describe("T-0418 P0: dev mode — missing x-dev-user still → 401", () => {
  for (const s of SURFACES) {
    it(`${s.surface}: ${s.method} ${s.path} → 401`, async () => {
      process.env["CHOROS_AUTH_MODE"] = "dev";
      const r = await httpReq(s.method, `${base}${s.path}`, { ...(s.headers ?? {}) }, s.body);
      expect(r.status).toBe(401);
    });
  }
});
