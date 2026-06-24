/**
 * src/__tests__/agent-auth-bypass.adversarial.test.ts — T-0422 [SECURITY] adversary (Враг)
 *
 * RED-TEAM the agent-facing SSO auth wraps merged by T-0418 (P0) + T-0420 (P1).
 * This file does NOT change production code — it tries HARD to BYPASS the wraps
 * and LOCKS the closure as regression coverage. Surfaces under attack (keycloak
 * mode): invoke, process-defs (write), binding (write), secret-handle (write),
 * email-channel-config (write), floor1-editor (write), process-start.
 *
 * Attack vectors per surface (all in keycloak mode unless noted):
 *   (A) x-dev-user header ONLY, no Authorization        → must 401 (dev bypass dead)
 *   (B) NO Authorization header at all                  → must 401
 *   (C) malformed / structurally-invalid Bearer         → must 401
 *         - "Bearer " (empty token)
 *         - "Bearer garbage" (1 segment)
 *         - "Bearer a.b" (2 segments)
 *         - "Bearer a.b.c.d" (4 segments)
 *         - lowercase "bearer <token>" (wrong scheme casing)
 *         - "Basic <token>" (wrong scheme entirely)
 *         - structurally-valid 3-segment JWT signed by the WRONG key
 *           (reaches verifyJwt → unknown signing key / invalid signature → 401)
 *   (D) DEV-mode positive: x-dev-user → NOT 401 (the wrap is a no-op in dev)
 *
 * The "no Bearer / malformed Bearer" cases need NO JWKS mock: withAuth →
 * authenticate() rejects a keycloak request lacking a valid Authorization header
 * (or with a structurally-broken one) at 401 BEFORE any token validation. The
 * wrong-key JWT case DOES need a JWKS mock (a local RSA keypair + JWKS server) so
 * verifyJwt runs the real signature check and rejects — that proves a structurally
 * well-formed but untrusted token cannot ride past the guard.
 *
 * Runnable NOW (no live Keycloak, no DB): every test uses stub pools + a local
 * in-process JWKS server for the signed-token cases. Deterministic in CI.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { Router } from "../http/router.js";
import { registerInvokeRoutes } from "../http/invoke.js";
import { registerProcessDefsRoutes } from "../http/process-defs.js";
import { registerBindingRoutes } from "../http/binding.js";
import { registerSecretHandleRoutes } from "../http/secret-handle.js";
import { registerEmailChannelConfigRoutes } from "../http/email-channel-config.js";
import { registerFloor1EditorRoutes } from "../http/floor1-editor.js";
import { registerProcessesRoutes } from "../http/processes.js";
import { withAuthRegistrar } from "../http/auth-wrap-router.js";
import { _resetJwksCache } from "../http/auth.js";
import type { FlowableClient } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// HTTP harness (mirrors agent-facing-auth-wraps.test.ts)
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

// Pool stub — empty rows for any query. Negative (keycloak) paths 401 before the
// DB; the dev positive path may touch it and must not throw.
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
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: true }),
  };
}

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const DEV_USER = { "x-dev-user": "alice" };

// ---------------------------------------------------------------------------
// Local JWKS server + RSA keypair — lets us forge a structurally-valid 3-segment
// JWT signed by an UNKNOWN (wrong) key so verifyJwt's real signature check runs.
// We never publish this key in the JWKS, so the token is "well-formed but
// untrusted" — the strongest malformed-Bearer vector short of a real KC.
// ---------------------------------------------------------------------------

const KID = "t0422-adversary-key";
let kcPrivateKey: crypto.KeyObject; // the key whose PUBLIC half IS published (trusted)
let wrongPrivateKey: crypto.KeyObject; // an UNPUBLISHED key (untrusted attacker key)
let kcPublicJwk: crypto.JsonWebKey & { kid: string; alg: string; use: string };
let jwksServer: http.Server;
let jwksPort: number;
const savedAuthEnv: Record<string, string | undefined> = {};

function base64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Sign a JWT with the given RSA private key (kid always = KID). */
function signWith(privKey: crypto.KeyObject, claims: Record<string, unknown>): string {
  const header = base64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = base64urlJson(claims);
  const signingInput = `${header}.${payload}`;
  const sig = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privKey)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `${signingInput}.${sig}`;
}

function validClaims(sub = "e-attacker"): Record<string, unknown> {
  return {
    iss: `http://127.0.0.1:${jwksPort}/realms/choros`,
    aud: "choros-api",
    exp: Math.floor(Date.now() / 1000) + 300,
    sub,
    preferred_username: sub,
    actor_type: "human",
  };
}

let server: http.Server;
let base: string;

beforeAll(async () => {
  // Two keypairs: the "trusted" one (its pub half is in the JWKS) and a "wrong"
  // one (never published — the attacker's forging key).
  const trusted = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const wrong = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  kcPrivateKey = trusted.privateKey;
  wrongPrivateKey = wrong.privateKey;
  kcPublicJwk = {
    ...trusted.publicKey.export({ format: "jwk" }),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };

  await new Promise<void>((resolve) => {
    jwksServer = http.createServer((req, res) => {
      if (req.url === "/realms/choros/.well-known/openid-configuration") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          issuer: `http://127.0.0.1:${jwksPort}/realms/choros`,
          jwks_uri: `http://127.0.0.1:${jwksPort}/realms/choros/protocol/openid-connect/certs`,
        }));
      } else if (req.url === "/realms/choros/protocol/openid-connect/certs") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ keys: [kcPublicJwk] }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    jwksServer.listen(0, "127.0.0.1", () => {
      jwksPort = (jwksServer.address() as AddressInfo).port;
      resolve();
    });
  });

  for (const k of ["KEYCLOAK_URL", "KEYCLOAK_REALM", "KEYCLOAK_AUDIENCE", "KC_ISSUER"]) {
    savedAuthEnv[k] = process.env[k];
  }
  process.env["KEYCLOAK_URL"] = `http://127.0.0.1:${jwksPort}`;
  process.env["KEYCLOAK_REALM"] = "choros";
  process.env["KEYCLOAK_AUDIENCE"] = "choros-api";
  delete process.env["KC_ISSUER"];
  _resetJwksCache();

  // One server hosting every wrapped surface, registered EXACTLY as the
  // composition root does (secret-handle via the withAuthRegistrar façade,
  // process-start via registerProcessesRoutes startDeps).
  const pool = makeStubPool();
  const flowable = makeStubFlowable();
  const router = new Router();

  registerInvokeRoutes(router, pool);
  registerProcessDefsRoutes(router, pool, flowable);
  registerBindingRoutes(router, pool, {
    pool,
    resolveActorTenant: async () => TENANT_ID,
  });
  registerSecretHandleRoutes(withAuthRegistrar(router) as unknown as typeof router, pool);
  registerEmailChannelConfigRoutes(router, pool);
  registerFloor1EditorRoutes(router, pool);
  registerProcessesRoutes(router, undefined, {
    pool,
    flowable,
    resolveActorTenant: async () => TENANT_ID,
  });

  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((r) =>
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      r();
    }),
  );
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedAuthEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetJwksCache();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => jwksServer.close(() => r()));
});

const ORIGINAL_AUTH_MODE = process.env["CHOROS_AUTH_MODE"];
afterEach(() => {
  if (ORIGINAL_AUTH_MODE === undefined) delete process.env["CHOROS_AUTH_MODE"];
  else process.env["CHOROS_AUTH_MODE"] = ORIGINAL_AUTH_MODE;
});

// All wrapped write surfaces under attack.
const SURFACES: Array<{
  surface: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}> = [
  { surface: "invoke", method: "POST", path: "/api/invoke/request",
    body: { target_agent_id: AGENT_ID, goal: "do x" } },
  { surface: "invoke-command", method: "POST", path: "/api/invoke/command",
    body: { target_agent_id: AGENT_ID, goal: "do x" } },
  { surface: "process-defs", method: "POST", path: "/api/process-defs",
    headers: { "x-tenant-id": TENANT_ID },
    body: { processKey: "k", name: "N", bpmnXml: "<x/>" } },
  { surface: "binding", method: "POST",
    path: `/tenants/${TENANT_ID}/processes/p/forms/f/binding`, body: { fields: [] } },
  { surface: "secret-handle", method: "POST",
    path: `/api/agents/${AGENT_ID}/secret-handle`, body: { handle_value: "env://LLM_API_KEY" } },
  { surface: "email-channel-config", method: "PUT", path: "/api/email-channel-config",
    body: { smtpHost: "smtp.example.com", smtpPort: 587, fromAddress: "ops@example.com", smtpHandle: "env://SMTP_PASS" } },
  { surface: "floor1-editor", method: "POST",
    path: `/tenants/${TENANT_ID}/processes/p/forms/f/edits`,
    body: { fields: [], uiSchema: {}, edit: { kind: "hide_field", fieldKey: "x" } } },
  { surface: "process-start", method: "POST", path: "/api/processes/start",
    headers: { "x-tenant-id": TENANT_ID }, body: { processKey: "k" } },
];

// ---------------------------------------------------------------------------
// (A) keycloak + x-dev-user ONLY (no Authorization) → 401 — the dev bypass is dead.
// ---------------------------------------------------------------------------

describe("[T-0422] keycloak: x-dev-user without Bearer → 401 (dev bypass DEAD)", () => {
  for (const s of SURFACES) {
    it(`${s.surface}: ${s.method} ${s.path} → 401`, async () => {
      process.env["CHOROS_AUTH_MODE"] = "keycloak";
      const r = await httpReq(s.method, `${base}${s.path}`,
        { ...DEV_USER, ...(s.headers ?? {}) }, s.body);
      expect(r.status).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// (B) keycloak + NO Authorization at all → 401.
// ---------------------------------------------------------------------------

describe("[T-0422] keycloak: no Authorization header → 401", () => {
  for (const s of SURFACES) {
    it(`${s.surface}: ${s.method} ${s.path} → 401`, async () => {
      process.env["CHOROS_AUTH_MODE"] = "keycloak";
      const r = await httpReq(s.method, `${base}${s.path}`, { ...(s.headers ?? {}) }, s.body);
      expect(r.status).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// (C) keycloak + malformed / structurally-invalid Bearer → 401.
// These exercise authenticate()'s pre-validation guards AND, for the wrong-key
// JWT, the real verifyJwt signature check (JWKS-mocked above).
// ---------------------------------------------------------------------------

describe("[T-0422] keycloak: malformed/untrusted Bearer → 401 (no token rides past)", () => {
  // NOTE: the Authorization values are produced LAZILY inside each `it` (via the
  // `auth()` thunk) because the signed-token cases need kcPrivateKey/wrongPrivateKey,
  // which are only assigned in beforeAll (after collection).
  const MALFORMED: Array<{ label: string; auth: () => string }> = [
    { label: "empty token after Bearer", auth: () => "Bearer " },
    { label: "whitespace-only token", auth: () => "Bearer    " },
    { label: "single-segment garbage", auth: () => "Bearer notajwt" },
    { label: "two-segment JWT", auth: () => "Bearer aaa.bbb" },
    { label: "four-segment JWT", auth: () => "Bearer aaa.bbb.ccc.ddd" },
    { label: "lowercase bearer scheme", auth: () => `bearer ${signWith(kcPrivateKey, validClaims())}` },
    { label: "Basic auth scheme", auth: () => "Basic dXNlcjpwYXNz" },
    { label: "non-base64url segments", auth: () => "Bearer @@@.@@@.@@@" },
    // structurally-valid 3-segment JWT signed by an UNPUBLISHED key → the real
    // verifyJwt signature check rejects it (unknown signing key / invalid signature).
    { label: "valid-shape JWT signed by WRONG key", auth: () => `Bearer ${signWith(wrongPrivateKey, validClaims())}` },
  ];

  for (const s of SURFACES) {
    for (const m of MALFORMED) {
      it(`${s.surface} [${m.label}] → 401`, async () => {
        process.env["CHOROS_AUTH_MODE"] = "keycloak";
        const r = await httpReq(s.method, `${base}${s.path}`,
          { Authorization: m.auth(), ...DEV_USER, ...(s.headers ?? {}) }, s.body);
        expect(r.status).toBe(401);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// (D) DEV-mode regression: x-dev-user → NOT 401 (the wrap is a no-op in dev, so
// the existing SPA/test dev path is not broken by the SSO wraps).
// ---------------------------------------------------------------------------

describe("[T-0422] dev mode: x-dev-user authenticates (wrap is no-op, no 401 regression)", () => {
  for (const s of SURFACES) {
    it(`${s.surface}: ${s.method} ${s.path} → not 401`, async () => {
      process.env["CHOROS_AUTH_MODE"] = "dev";
      const r = await httpReq(s.method, `${base}${s.path}`,
        { ...DEV_USER, ...(s.headers ?? {}) }, s.body);
      expect(r.status).not.toBe(401);
    });
  }
});
