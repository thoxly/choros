/**
 * src/__tests__/process-start-kc-mode.test.ts — T-0542 (B16)
 *
 * Mode-aware actor resolution for POST /api/processes/start when the route is
 * wired with an actorSlugResolver (the 4-arg form of registerProcessesRoutes
 * that activates the withActorInject façade — ADR T-0328 §4.2 / G1).
 *
 * The FROZEN body (process-start.ts) is byte-unchanged; the fix lives purely at
 * the registration/wrapper site (actor-inject façade in processes.ts). These tests
 * prove the wiring is correct end-to-end via the REAL /api/processes/start route:
 *
 *   (a) keycloak + valid Bearer, slug resolves → 201 (actor reaches the body)
 *   (b) keycloak + x-dev-user only, no Bearer → 401 (bypass DEAD)
 *   (c) keycloak, no headers at all → 401 (anonymous)
 *   (d) keycloak + valid Bearer, slug resolves → null → 401 (unknown identity)
 *   (e) keycloak + valid Bearer, actor in wrong tenant → 403 NOT_ELIGIBLE
 *       (cross-tenant deny; actor-inject injects own tenant, process-start checks it)
 *
 * JWKS server: a real in-process RS256 key + JWKS endpoint (mirrors
 * actor-inject-registrar.test.ts) so withAuth validates a genuine JWT and populates
 * getAuthContext before the façade resolves the slug. No external Keycloak needed.
 *
 * HONEST scoping (as in test comment at top of actor-inject-registrar.test.ts):
 *   - Unit: slug resolver + tenant resolver are stubs (no live DB).
 *   - Server-gated: a real Keycloak login with a real employee row in PG is
 *     verified on the deployed dev stack (manual / deploy-acceptance path).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Router } from "../http/router.js";
import { _resetJwksCache } from "../http/auth.js";
import { registerProcessesRoutes } from "../http/processes.js";
import type { StartInstanceDeps } from "../http/process-start.js";
import type { FlowableClient } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// HTTP request helper
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
// Local JWKS + RSA key (mirrors actor-inject-registrar.test.ts)
// ---------------------------------------------------------------------------

const KID = "t0542-ps-kc-key";
let kcPrivateKey: crypto.KeyObject;
let kcPublicJwk: crypto.JsonWebKey & { kid: string; alg: string; use: string };
let jwksServer: http.Server;
let jwksPort: number;

function base64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Mint a validated human token whose sub/preferred_username = `sub`. */
function bearerToken(sub: string): string {
  const claims = {
    iss: `http://127.0.0.1:${jwksPort}/realms/choros`,
    aud: "choros-api",
    exp: Math.floor(Date.now() / 1000) + 300,
    sub,
    preferred_username: sub,
    actor_type: "human",
  };
  const header = base64urlJson({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = base64urlJson(claims);
  const signingInput = `${header}.${payload}`;
  const sig = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), kcPrivateKey)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `${signingInput}.${sig}`;
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const ACTOR_SUB = "kc-sub-orlov";
const RESOLVED_SLUG = "e-orlov";
const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const INSTANCE_ID = "flowable-inst-t0542";
const PROCESS_KEY = "telLinear";

/** Stub slug resolver: ACTOR_SUB → RESOLVED_SLUG; anything else → null (fail-closed). */
const slugOk = async (sub: string, _preferred?: string) =>
  sub === ACTOR_SUB ? RESOLVED_SLUG : null;
const slugNull = async () => null;

function makeMemoryPool(): import("pg").Pool {
  const fakeClient = {
    query: async () => ({ rows: [] }),
    release: () => {},
  };
  return {
    connect: async () => fakeClient as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

function makeStubFlowable(ok: boolean): FlowableClient {
  return {
    deployBpmn: async () => ({ ok: false as const, code: "UNKNOWN" as const }),
    startInstance: async () =>
      ok
        ? { ok: true as const, instanceId: INSTANCE_ID }
        : { ok: false as const, code: "UNKNOWN" as const },
    fetchAndLock: async () => ({ ok: false as const, code: "UNKNOWN" as const }),
    completeTask: async () => ({ ok: false as const, code: "UNKNOWN" as const }),
    failTask: async () => ({ ok: false as const, code: "UNKNOWN" as const }),
    getFirstActiveUserTask: async () => ({ ok: true as const, taskId: null }),
    completeUserTask: async () => ({ ok: true as const }),
    getActiveUserTasks: async () => ({ ok: true as const, tasks: [] }),
    getMessageCatchWaits: async () => ({ ok: true as const, waits: [] }),
    correlateMessage: async () => ({ ok: true as const }),
    isInstanceEnded: async () => ({ ok: true as const, ended: false }),
  };
}

function makeStartDeps(
  ok: boolean,
  resolverTenant: string = TENANT_ID,
): StartInstanceDeps {
  return {
    pool: makeMemoryPool(),
    flowable: makeStubFlowable(ok),
    resolveActorTenant: async () => resolverTenant,
  };
}

// ---------------------------------------------------------------------------
// Test infrastructure: one shared server + JWKS server
// ---------------------------------------------------------------------------

let server: http.Server;
let base: string;
const savedAuthEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  kcPrivateKey = privateKey;
  kcPublicJwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };

  await new Promise<void>((resolve) => {
    jwksServer = http.createServer((req, res) => {
      if (req.url === "/realms/choros/.well-known/openid-configuration") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            issuer: `http://127.0.0.1:${jwksPort}/realms/choros`,
            jwks_uri: `http://127.0.0.1:${jwksPort}/realms/choros/protocol/openid-connect/certs`,
          }),
        );
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

  for (const k of ["KEYCLOAK_URL", "KEYCLOAK_REALM", "KEYCLOAK_AUDIENCE", "KC_ISSUER", "CHOROS_AUTH_MODE"]) {
    savedAuthEnv[k] = process.env[k];
  }
  process.env["KEYCLOAK_URL"] = `http://127.0.0.1:${jwksPort}`;
  process.env["KEYCLOAK_REALM"] = "choros";
  process.env["KEYCLOAK_AUDIENCE"] = "choros-api";
  delete process.env["KC_ISSUER"];
  process.env["CHOROS_AUTH_MODE"] = "keycloak";

  const router = new Router();
  // 4-arg form: activates withActorInject façade for KC-mode identity injection.
  registerProcessesRoutes(
    router,
    undefined,
    makeStartDeps(true),
    slugOk,
  );

  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((r) =>
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      r();
    }),
  );
  _resetJwksCache();
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

// ---------------------------------------------------------------------------
// (a) keycloak + valid Bearer → 201 (actor identity resolved → body runs)
// ---------------------------------------------------------------------------

describe("T-0542 (a): keycloak + valid Bearer → 201 (actor reaches body)", () => {
  it("returns 201 with frozen response shape", async () => {
    const r = await httpReq(
      "POST",
      `${base}/api/processes/start`,
      { Authorization: `Bearer ${bearerToken(ACTOR_SUB)}` },
      { processKey: PROCESS_KEY },
    );
    expect(r.status).toBe(201);
    const body = r.json as Record<string, unknown>;
    expect(body["instanceId"]).toBe(INSTANCE_ID);
    expect(body["processKey"]).toBe(PROCESS_KEY);
    expect(typeof body["tenantId"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// (b) keycloak + x-dev-user only, NO Bearer → 401 (bypass dead)
// ---------------------------------------------------------------------------

describe("T-0542 (b): keycloak + x-dev-user without Bearer → 401 (bypass dead)", () => {
  it("returns 401 when only x-dev-user is supplied (no Bearer token)", async () => {
    const r = await httpReq(
      "POST",
      `${base}/api/processes/start`,
      { "x-dev-user": RESOLVED_SLUG },
      { processKey: PROCESS_KEY },
    );
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// (c) keycloak, anonymous (no headers) → 401
// ---------------------------------------------------------------------------

describe("T-0542 (c): keycloak anonymous → 401", () => {
  it("returns 401 with no auth headers at all", async () => {
    const r = await httpReq(
      "POST",
      `${base}/api/processes/start`,
      {},
      { processKey: PROCESS_KEY },
    );
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// (d) keycloak + valid Bearer, slug resolves → null → 401 (unknown identity)
//
// Uses a separate server wired with slugNull so every KC sub is unresolvable.
// ---------------------------------------------------------------------------

describe("T-0542 (d): keycloak + valid Bearer but unresolvable identity → 401", () => {
  let s2: http.Server;
  let base2: string;

  beforeAll(async () => {
    const router2 = new Router();
    registerProcessesRoutes(
      router2,
      undefined,
      makeStartDeps(true),
      slugNull, // every slug lookup → null → 401
    );
    s2 = http.createServer((req, res) => router2.dispatch(req, res));
    await new Promise<void>((r) =>
      s2.listen(0, "127.0.0.1", () => {
        base2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
        r();
      }),
    );
  });
  afterAll(async () => { await new Promise<void>((r) => s2.close(() => r())); });

  it("returns 401 when the token sub does not match any employee", async () => {
    const r = await httpReq(
      "POST",
      `${base2}/api/processes/start`,
      { Authorization: `Bearer ${bearerToken(ACTOR_SUB)}` },
      { processKey: PROCESS_KEY },
    );
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// (e) keycloak + valid Bearer, actor belongs to a DIFFERENT tenant → 403
//
// The actor-inject façade injects the actor's OWN tenant (from resolveActorTenant)
// into x-tenant-id. The frozen body compares that injected tenant against the
// resolved tenant (same resolver → same value → they match → no cross-tenant deny).
//
// To exercise the 403 path we need the actor-inject façade to inject tenantA, but
// then the body's resolver to return tenantB. Because the façade and the body share
// startDeps.resolveActorTenant, we use a call-count trick: the first call (from
// the façade, injectTenant) returns TENANT_ID; the second call (from the body,
// resolveActorTenant) returns OTHER_TENANT_ID.  This makes the body see a mismatch
// and fire the 403 cross-tenant deny (AC-9 / Враг target).
// ---------------------------------------------------------------------------

const OTHER_TENANT_ID = "22222222-2222-2222-2222-222222222222";

describe("T-0542 (e): cross-tenant → 403 NOT_ELIGIBLE", () => {
  let s3: http.Server;
  let base3: string;

  beforeAll(async () => {
    // Two-call resolver: façade (inject) → TENANT_ID; body (check) → OTHER_TENANT_ID.
    let callCount = 0;
    const twoCallResolver = async () => {
      callCount++;
      return callCount === 1 ? TENANT_ID : OTHER_TENANT_ID;
    };
    const deps3: StartInstanceDeps = {
      pool: makeMemoryPool(),
      flowable: makeStubFlowable(true),
      resolveActorTenant: twoCallResolver,
    };

    const router3 = new Router();
    registerProcessesRoutes(router3, undefined, deps3, slugOk);
    s3 = http.createServer((req, res) => router3.dispatch(req, res));
    await new Promise<void>((r) =>
      s3.listen(0, "127.0.0.1", () => {
        base3 = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
        r();
      }),
    );
  });
  afterAll(async () => { await new Promise<void>((r) => s3.close(() => r())); });

  it("returns 403 NOT_ELIGIBLE when actor's injected tenant ≠ body's resolver tenant", async () => {
    const r = await httpReq(
      "POST",
      `${base3}/api/processes/start`,
      { Authorization: `Bearer ${bearerToken(ACTOR_SUB)}` },
      { processKey: PROCESS_KEY },
    );
    expect(r.status).toBe(403);
    const body = r.json as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("NOT_ELIGIBLE");
  });
});
