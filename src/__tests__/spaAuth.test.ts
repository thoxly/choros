/**
 * src/__tests__/spaAuth.test.ts
 *
 * T-0291 [SECURITY] — close the keycloak-mode auth-gap on the SPA API routes.
 *
 * The SPA write/read routes (/api/applications, /api/records, /api/registry-defs,
 * + the grants/rights/agents/processes mutations) historically registered their
 * handlers WITHOUT withAuth. Their actor extraction does
 *   getAuthContext(req) ?? <read x-dev-user header>
 * In keycloak mode getAuthContext is ONLY populated by withAuth (which previously
 * only the externalWorker routes used), so an unguarded SPA route fell through to
 * accepting an UNAUTHENTICATED x-dev-user header even in keycloak mode = an auth
 * bypass. T-0291 wraps these registrations in withAuth so that:
 *   - keycloak mode: a valid Bearer JWT is REQUIRED (401 otherwise); x-dev-user
 *     alone does NOT authenticate (no bypass) and the actor comes from the token.
 *   - dev mode: withAuth is a no-op pass-through; the existing x-dev-user path
 *     authenticates exactly as before (no regression).
 *
 * Mirrors workerAuth.test.ts (Group A dev-mode regression + Group B JWT rejection)
 * and the registry-defs-pdp.test.ts fake-pool / Router.dispatch harness so the
 * suite needs NO live Keycloak and NO live Postgres.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as crypto from "node:crypto";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Router } from "../http/router.js";
import { registerApplicationRoutes } from "../http/applications.js";
import { registerRecordRoutes } from "../http/records.js";
import { registerRegistryDefRoutes } from "../http/registry-defs.js";
import { _resetJwksCache } from "../http/auth.js";

// ---------------------------------------------------------------------------
// Fake pg.Pool — every query yields empty rows so the list/get handlers reach a
// clean 200 (empty list) on the dev path WITHOUT a live database. On the 401
// paths the handler never runs, so the pool is never touched.
// ---------------------------------------------------------------------------

class FakePoolClient {
  async query(): Promise<{ rows: unknown[] }> {
    return { rows: [] };
  }
  release(): void {
    /* no-op */
  }
}

function makeFakePool(): import("pg").Pool {
  return {
    connect: async () => new FakePoolClient() as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

// A tenant UUID the stub resolver returns for any actor (RLS scope; irrelevant to
// the auth gate, which fires before any tenant resolution).
const STUB_TENANT = "a0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// RSA test key pair + JWT signing (copied from workerAuth.test.ts pattern)
// ---------------------------------------------------------------------------

let privateKey: crypto.KeyObject;
let publicJwk: crypto.JsonWebKey & { kid: string; alg: string; use: string };
const KID = "spa-test-key-1";

beforeAll(() => {
  const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  privateKey = priv;
  const rawJwk = pub.export({ format: "jwk" });
  publicJwk = { ...rawJwk, kid: KID, alg: "RS256", use: "sig" };
});

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

interface TokenClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  sub?: string;
  preferred_username?: string;
  actor_type?: string;
  [key: string]: unknown;
}

function makeJwt(claims: TokenClaims): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${base64url(sig)}`;
}

// ---------------------------------------------------------------------------
// JWKS mock server (serves discovery + certs)
// ---------------------------------------------------------------------------

let jwksServer: http.Server;
let jwksPort: number;

function startJwksServer(): Promise<void> {
  return new Promise((resolve) => {
    jwksServer = http.createServer((req, res) => {
      if (req.url?.includes("openid-configuration")) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            issuer: `http://127.0.0.1:${jwksPort}/realms/choros`,
            jwks_uri: `http://127.0.0.1:${jwksPort}/certs`,
          }),
        );
      } else {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ keys: [publicJwk] }));
      }
    });
    jwksServer.listen(0, "127.0.0.1", () => {
      jwksPort = (jwksServer.address() as AddressInfo).port;
      resolve();
    });
  });
}

function stopJwksServer(): Promise<void> {
  return new Promise((resolve) => jwksServer.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Choros server — registers the SPA routes (applications/records/registry-defs)
// against the fake pool + a stub actor→tenant resolver. The resolver is a spy so
// the dev-path tests can assert it was reached with the x-dev-user actor and the
// keycloak bypass tests can assert it was NEVER reached.
// ---------------------------------------------------------------------------

let appServer: http.Server;
let appPort: number;
let resolveActorTenantSpy: ReturnType<typeof vi.fn>;

function buildSpaRouter(): Router {
  const pool = makeFakePool();
  resolveActorTenantSpy = vi.fn(async (_actorSlug: string) => STUB_TENANT);
  const resolveActorTenant = resolveActorTenantSpy as unknown as (slug: string) => Promise<string>;

  const router = new Router();
  registerApplicationRoutes(router, { pool, resolveActorTenant });
  registerRecordRoutes(router, { pool, resolveActorTenant });
  // registry-defs CRUD (4th param) — the create/list/get routes guarded by withAuth.
  registerRegistryDefRoutes(router, undefined, undefined, { pool, resolveActorTenant });
  return router;
}

function setupAppServer(): Promise<void> {
  return new Promise((resolve) => {
    const router = buildSpaRouter();
    appServer = http.createServer((req, res) => router.dispatch(req, res));
    appServer.listen(0, "127.0.0.1", () => {
      appPort = (appServer.address() as AddressInfo).port;
      resolve();
    });
  });
}

function teardownAppServer(): Promise<void> {
  return new Promise((resolve) => appServer.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function req(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: appPort,
      path,
      method,
      headers: {
        ...headers,
        ...(payload !== undefined
          ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
          : {}),
      },
    };
    const r = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* leave as string */
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = {};
}

// The SPA list routes that read the actor and (in dev) authenticate via x-dev-user.
// All three were unguarded before T-0291 → the keycloak x-dev-user bypass surface.
const LIST_ROUTES = ["/api/applications", "/api/records", "/api/registry-defs"] as const;

// ---------------------------------------------------------------------------
// Group A — dev-mode regression: x-dev-user STILL authenticates (no regression).
// ---------------------------------------------------------------------------

describe("Group A — dev mode: x-dev-user still authenticates (no regression)", () => {
  beforeAll(async () => {
    delete process.env["CHOROS_AUTH_MODE"]; // dev mode (default)
    await setupAppServer();
  });
  afterAll(teardownAppServer);

  it.each(LIST_ROUTES)(
    "GET %s with x-dev-user → 200 (dev actor resolved, handler ran)",
    async (route) => {
      resolveActorTenantSpy.mockClear();
      const res = await req("GET", route, { "x-dev-user": "e-owner" });
      expect(res.status).toBe(200);
      // The handler ran and resolved the tenant for the DEV actor (x-dev-user).
      expect(resolveActorTenantSpy).toHaveBeenCalledWith("e-owner");
    },
  );

  it.each(LIST_ROUTES)(
    "GET %s WITHOUT x-dev-user → 401 (dev still requires an identity)",
    async (route) => {
      const res = await req("GET", route);
      expect(res.status).toBe(401);
      const b = res.body as { error: { code: string } };
      expect(b.error.code).toBe("UNAUTHENTICATED");
    },
  );
});

// ---------------------------------------------------------------------------
// Group B — keycloak mode: a valid Bearer is REQUIRED; x-dev-user does NOT bypass.
// (mirrors workerAuth.test.ts Group B JWT-rejection template)
// ---------------------------------------------------------------------------

describe("Group B — keycloak mode: JWT required, NO x-dev-user bypass", () => {
  function validClaimsKc(overrides: Partial<TokenClaims> = {}): TokenClaims {
    return {
      iss: `http://127.0.0.1:${jwksPort}/realms/choros`,
      aud: "choros-api",
      exp: Math.floor(Date.now() / 1000) + 300,
      sub: "kc-user-uuid-1",
      preferred_username: "e-owner",
      actor_type: "human",
      ...overrides,
    };
  }

  beforeAll(async () => {
    await startJwksServer();
    setEnv({
      CHOROS_AUTH_MODE: "keycloak",
      KEYCLOAK_URL: `http://127.0.0.1:${jwksPort}`,
      KEYCLOAK_REALM: "choros",
      KEYCLOAK_AUDIENCE: "choros-api",
    });
    await setupAppServer();
  });

  afterAll(async () => {
    await teardownAppServer();
    restoreEnv();
    await stopJwksServer();
    _resetJwksCache();
  });

  beforeEach(() => {
    _resetJwksCache();
  });

  it.each(LIST_ROUTES)(
    "GET %s with NO Authorization → 401 (keycloak requires a Bearer)",
    async (route) => {
      const res = await req("GET", route);
      expect(res.status).toBe(401);
      const b = res.body as { error: { code: string } };
      expect(b.error.code).toBe("UNAUTHENTICATED");
    },
  );

  it.each(LIST_ROUTES)(
    "GET %s with ONLY x-dev-user (no Bearer) → 401 (THE BYPASS IS CLOSED)",
    async (route) => {
      resolveActorTenantSpy.mockClear();
      const res = await req("GET", route, { "x-dev-user": "e-owner" });
      expect(res.status).toBe(401);
      const b = res.body as { error: { code: string } };
      expect(b.error.code).toBe("UNAUTHENTICATED");
      // The handler must NOT have run — x-dev-user did not authenticate.
      expect(resolveActorTenantSpy).not.toHaveBeenCalled();
    },
  );

  it.each(LIST_ROUTES)(
    "GET %s with a malformed Bearer → 401",
    async (route) => {
      const res = await req("GET", route, { Authorization: "Bearer not.a.jwt" });
      expect(res.status).toBe(401);
    },
  );

  it("POST /api/applications with ONLY x-dev-user (no Bearer) → 401 (write bypass closed)", async () => {
    resolveActorTenantSpy.mockClear();
    const res = await req(
      "POST",
      "/api/applications",
      { "x-dev-user": "e-owner" },
      { slug: "demo-app", display_name: "Demo" },
    );
    expect(res.status).toBe(401);
    expect(resolveActorTenantSpy).not.toHaveBeenCalled();
  });

  it.each(LIST_ROUTES)(
    "GET %s with a VALID Bearer → 200 (handler runs; actor = token sub)",
    async (route) => {
      resolveActorTenantSpy.mockClear();
      const token = makeJwt(validClaimsKc({ sub: "kc-actor-sub-xyz" }));
      const res = await req("GET", route, { Authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      // The validated token's sub is the actor — NOT any x-dev-user header.
      expect(resolveActorTenantSpy).toHaveBeenCalledWith("kc-actor-sub-xyz");
    },
  );

  it("GET /api/applications: a valid Bearer wins even if x-dev-user is ALSO present (token sub, not header)", async () => {
    resolveActorTenantSpy.mockClear();
    const token = makeJwt(validClaimsKc({ sub: "kc-actor-sub-token" }));
    const res = await req("GET", "/api/applications", {
      Authorization: `Bearer ${token}`,
      "x-dev-user": "attacker-slug",
    });
    expect(res.status).toBe(200);
    expect(resolveActorTenantSpy).toHaveBeenCalledWith("kc-actor-sub-token");
    expect(resolveActorTenantSpy).not.toHaveBeenCalledWith("attacker-slug");
  });
});
