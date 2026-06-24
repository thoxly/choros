/**
 * src/__tests__/agent-facing-auth-wraps-p1.test.ts — T-0420 [SECURITY] P1
 *
 * Follow-up to T-0418 P0 (src/__tests__/agent-facing-auth-wraps.test.ts). Same
 * shape, the P1 surface set from ADR T-0328 §5:
 *
 *   - email-channel-config (SSO, keycloak)  — withAuth + mode-aware actor
 *   - floor1-editor        (SSO, keycloak)  — withAuth + mode-aware actor
 *   - process-start        (SSO, FROZEN)    — registration-site withAuth (façade)
 *   - vendor-activation    (vendor-signed)  — NOT a withAuth wrap; the activation-key
 *                                             signature is the credential, enforced
 *                                             fail-closed (invalid signature → 403).
 *
 * Per-surface NEGATIVE test (ADR §4.3 must-close list, last bullet):
 *   SSO surfaces — in keycloak mode, a request that supplies `x-dev-user` but NO
 *   Bearer token MUST be rejected with 401 (the dev-header bypass is DEAD in prod).
 *   vendor-activation — a signature-fail (status `invalid`) MUST be rejected (403)
 *   on the gated vendor-service routes.
 *
 * Plus a DEV-mode POSITIVE assertion per SSO surface: with `x-dev-user` and the
 * default dev auth mode, the request reaches the handler (NOT 401) — proving the
 * withAuth wrap is a no-op pass-through in dev and the existing SPA/test path is
 * unchanged.
 *
 * WHY no JWKS mock is needed for the negative path (same as P0):
 *   `withAuth` → `authenticate()` rejects a keycloak-mode request with no
 *   Authorization header at 401 BEFORE any token validation / JWKS fetch. So
 *   presenting x-dev-user alone is exactly the bypass attempt and it short-circuits
 *   to 401 deterministically without a live/mock Keycloak.
 *
 * CHOROS_AUTH_MODE is read lazily per request, so toggling process.env per test
 * works; we always restore it in afterEach.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerEmailChannelConfigRoutes } from "../http/email-channel-config.js";
import { registerFloor1EditorRoutes } from "../http/floor1-editor.js";
import { registerProcessesRoutes } from "../http/processes.js";
import { registerVendorActivationRoutes } from "../http/vendor-activation.js";
import type { FlowableClient } from "../core/flowable-client.js";
import type { ActivationStatus } from "../vendor/activation.js";

// ---------------------------------------------------------------------------
// Minimal HTTP harness (mirrors the P0 test)
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
const DEV_USER = { "x-dev-user": "alice" };

// An `invalid`-signature activation status (forged/tampered key) — the
// vendor-signed fail-closed input for the vendor-activation guard test.
const INVALID_ACTIVATION: ActivationStatus = {
  state: "invalid",
  circuit_id: null,
  entitlements: null,
  not_after: null,
  reason: "signature mismatch",
};

// ---------------------------------------------------------------------------
// One server hosting the P1 surfaces, registered EXACTLY as the composition
// root does. vendor-activation is registered with an injected provider that
// returns an INVALID (signature-fail) status, so the guard test exercises the
// fail-closed signature path deterministically (no real key on disk).
// ---------------------------------------------------------------------------

let server: http.Server;
let base: string;

beforeAll(async () => {
  const pool = makeStubPool();
  const flowable = makeStubFlowable();
  const router = new Router();

  registerEmailChannelConfigRoutes(router, pool);
  registerFloor1EditorRoutes(router, pool);
  // process-start.ts handler body is FROZEN — wrapped at the registration site
  // inside registerProcessesRoutes (withAuth(makeStartInstanceHandler(...))),
  // identical to server.ts. Supplying startDeps registers the write-route.
  registerProcessesRoutes(router, undefined, {
    pool,
    flowable,
    resolveActorTenant: async () => TENANT_ID,
  });
  // vendor-activation is vendor-signed (NOT withAuth). Inject a forged-signature
  // status so the gated routes exercise the fail-closed 403 path.
  registerVendorActivationRoutes(router, () => INVALID_ACTIVATION);

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

// The three SSO P1 surfaces, as { surface, method, path, body }.
const SSO_SURFACES: Array<{
  surface: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}> = [
  {
    surface: "email-channel-config",
    method: "PUT",
    path: "/api/email-channel-config",
    body: {
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      fromAddress: "ops@example.com",
      smtpHandle: "env://SMTP_PASS",
    },
  },
  {
    surface: "floor1-editor",
    method: "POST",
    path: `/tenants/${TENANT_ID}/processes/p/forms/f/edits`,
    body: { fields: [], uiSchema: {}, edit: { kind: "hide_field", fieldKey: "x" } },
  },
  {
    surface: "process-start",
    method: "POST",
    path: "/api/processes/start",
    headers: { "x-tenant-id": TENANT_ID },
    body: { processKey: "k" },
  },
];

// ---------------------------------------------------------------------------
// NEGATIVE (SSO): keycloak mode + x-dev-user + NO Bearer → 401 (bypass dead)
// ---------------------------------------------------------------------------

describe("T-0420 P1 (SSO): keycloak mode — x-dev-user without Bearer → 401 (bypass dead)", () => {
  for (const s of SSO_SURFACES) {
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
// May return a downstream status (400/403/404/502/...) from the stubbed DB —
// anything-but-401 proves the dev bypass still works and auth did not block it.
// ---------------------------------------------------------------------------

describe("T-0420 P1 (SSO): dev mode — x-dev-user authenticates (no 401 regression)", () => {
  for (const s of SSO_SURFACES) {
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
// CONTROL (SSO): dev mode, NO x-dev-user → 401 on each surface. Proves the wrap
// did not accidentally make the route public — the dev x-dev-user gate is intact.
// ---------------------------------------------------------------------------

describe("T-0420 P1 (SSO): dev mode — missing x-dev-user still → 401", () => {
  for (const s of SSO_SURFACES) {
    it(`${s.surface}: ${s.method} ${s.path} → 401`, async () => {
      process.env["CHOROS_AUTH_MODE"] = "dev";
      const r = await httpReq(s.method, `${base}${s.path}`, { ...(s.headers ?? {}) }, s.body);
      expect(r.status).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// vendor-activation (vendor-signed): the activation-key signature is the
// credential, enforced FAIL-CLOSED. With a forged/tampered status (`invalid`),
// the gated vendor-service routes MUST refuse with 403 ACTIVATION_INVALID — in
// BOTH auth modes (these routes intentionally bypass withAuth; the keycloak
// flip does not change vendor-plane behaviour). The unauthenticated reporting
// endpoint (GET /vendor/activation) is allowed to 200 (reporting is not gating).
// ---------------------------------------------------------------------------

const VENDOR_GATED: Array<{ method: string; path: string }> = [
  { method: "POST", path: "/vendor/updates/check" },
  { method: "POST", path: "/vendor/agentic-ops/run" },
  { method: "GET", path: "/vendor/support/ticket" },
];

describe("T-0420 P1 (vendor-signed): invalid signature → 403 fail-closed", () => {
  for (const mode of ["dev", "keycloak"]) {
    for (const v of VENDOR_GATED) {
      it(`[${mode}] ${v.method} ${v.path} → 403 ACTIVATION_INVALID`, async () => {
        process.env["CHOROS_AUTH_MODE"] = mode;
        const r = await httpReq(v.method, `${base}${v.path}`);
        expect(r.status).toBe(403);
        const body = r.json as { error?: { code?: string } };
        expect(body.error?.code).toBe("ACTIVATION_INVALID");
      });
    }
  }

  it("GET /vendor/activation reports the verdict (200, not gating)", async () => {
    process.env["CHOROS_AUTH_MODE"] = "keycloak";
    const r = await httpReq("GET", `${base}/vendor/activation`);
    expect(r.status).toBe(200);
    expect((r.json as { state?: string }).state).toBe("invalid");
  });
});
