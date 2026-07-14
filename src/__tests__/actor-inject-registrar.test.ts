/**
 * src/__tests__/actor-inject-registrar.test.ts — T-0328 G1
 *
 * Proves the actor-inject FAÇADE (src/http/actor-inject-registrar.ts) is in the
 * request path AND does the right thing at the seam, on BOTH frozen surfaces'
 * wiring shape (slug-only for secret-handle; slug + tenant for process-start):
 *
 *   keycloak + valid Bearer →
 *     - the inner handler (a stand-in for the FROZEN body) reads the RESOLVED slug
 *       from x-dev-user (proving identity reaches the body via the channel it reads),
 *       and (process-start variant) the RESOLVED tenant from x-tenant-id;
 *     - a client-supplied x-dev-user is OVERWRITTEN by the JWT-resolved slug (ADR §4.5
 *       risk 3 — the JWT identity is authoritative, a header can't shadow it).
 *   keycloak + x-dev-user but NO Bearer → 401 (the dev-header bypass is DEAD).
 *   keycloak + valid Bearer but resolver → null → 401 (fail closed, body never runs).
 *   dev mode → pure pass-through (the inner handler reads the client's x-dev-user
 *     unchanged; the injector touches nothing) → the existing dev/test path is green.
 *
 * Identity is resolved via the injected resolver (production = resolveActorSlugFromAuth,
 * kind='human'); the test injects a stub so no DB is needed. A real in-process JWKS
 * server mints validated RS256 tokens (mirrors invoke-caller-spoof.adversarial.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Router, type RouteHandler } from "../http/router.js";
import { _resetJwksCache } from "../http/auth.js";
import {
  withActorInject,
  actorInjectRegistrar,
} from "../http/actor-inject-registrar.js";

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
// Local JWKS + RSA key — mint a real validated RS256 token (mirrors
// invoke-caller-spoof.adversarial.test.ts).
// ---------------------------------------------------------------------------

const KID = "t0328-facade-key";
let kcPrivateKey: crypto.KeyObject;
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
// Terminal handler stand-in for a FROZEN body: echoes back the x-dev-user and
// x-tenant-id headers it ACTUALLY receives (exactly what secret-handle.ts /
// process-start.ts read via their in-body extractActor / extractTenantId).
// ---------------------------------------------------------------------------

const echoHandler: RouteHandler = (req, res) => {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      devUser: req.headers["x-dev-user"] ?? null,
      tenant: req.headers["x-tenant-id"] ?? null,
    }),
  );
};

// Resolver stubs (production = resolveActorSlugFromAuth / resolveActorTenant).
const RESOLVED_SLUG = "e-larina";
const RESOLVED_TENANT = "33333333-3333-3333-3333-333333333333";
const slugOk = async (sub: string) => (sub === "kc-sub-uuid" ? RESOLVED_SLUG : null);
const slugNull = async () => null;
const tenantOk = async (slug: string) => {
  if (slug !== RESOLVED_SLUG) throw new Error("unexpected slug");
  return RESOLVED_TENANT;
};

let server: http.Server;
let base: string;

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

  for (const k of ["KEYCLOAK_URL", "KEYCLOAK_REALM", "KEYCLOAK_AUDIENCE", "KC_ISSUER", "CHOROS_AUTH_MODE"]) {
    savedAuthEnv[k] = process.env[k];
  }
  process.env["KEYCLOAK_URL"] = `http://127.0.0.1:${jwksPort}`;
  process.env["KEYCLOAK_REALM"] = "choros";
  process.env["KEYCLOAK_AUDIENCE"] = "choros-api";
  delete process.env["KC_ISSUER"];

  const router = new Router();
  // secret-handle shape: slug-only registrar façade.
  actorInjectRegistrar(router, { resolveActorSlug: slugOk }).register(
    "POST",
    "/secret/slug-ok",
    echoHandler,
  );
  // secret-handle shape with a resolver that fails closed.
  actorInjectRegistrar(router, { resolveActorSlug: slugNull }).register(
    "POST",
    "/secret/slug-null",
    echoHandler,
  );
  // process-start shape: slug + tenant via a single explicit wrap.
  router.register(
    "POST",
    "/start/slug-tenant",
    withActorInject(echoHandler, { resolveActorSlug: slugOk, injectTenant: tenantOk }),
  );

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

// ---------------------------------------------------------------------------
// keycloak-mode behaviour
// ---------------------------------------------------------------------------

describe("[T-0328 G1] actor-inject façade — keycloak mode", () => {
  beforeAll(() => { process.env["CHOROS_AUTH_MODE"] = "keycloak"; _resetJwksCache(); });

  it("valid Bearer → resolved slug injected into x-dev-user (secret-handle shape)", async () => {
    const r = await httpReq(
      "POST",
      `${base}/secret/slug-ok`,
      { Authorization: `Bearer ${bearerToken("kc-sub-uuid")}` },
      {},
    );
    expect(r.status).toBe(200);
    expect((r.json as { devUser: string }).devUser).toBe(RESOLVED_SLUG);
  });

  it("valid Bearer + client x-dev-user → client header is OVERWRITTEN by JWT slug", async () => {
    const r = await httpReq(
      "POST",
      `${base}/secret/slug-ok`,
      {
        Authorization: `Bearer ${bearerToken("kc-sub-uuid")}`,
        "x-dev-user": "attacker-spoofed-admin",
      },
      {},
    );
    expect(r.status).toBe(200);
    // The resolved slug wins; the spoofed header never reaches the body.
    expect((r.json as { devUser: string }).devUser).toBe(RESOLVED_SLUG);
  });

  it("valid Bearer → resolved slug + tenant injected (process-start shape)", async () => {
    const r = await httpReq(
      "POST",
      `${base}/start/slug-tenant`,
      {
        Authorization: `Bearer ${bearerToken("kc-sub-uuid")}`,
        "x-tenant-id": "00000000-0000-0000-0000-000000000000", // foreign — must be overwritten
      },
      {},
    );
    expect(r.status).toBe(200);
    const j = r.json as { devUser: string; tenant: string };
    expect(j.devUser).toBe(RESOLVED_SLUG);
    expect(j.tenant).toBe(RESOLVED_TENANT); // actor's OWN tenant, not the header
  });

  it("x-dev-user but NO Bearer → 401 (bypass dead)", async () => {
    const r = await httpReq("POST", `${base}/secret/slug-ok`, { "x-dev-user": "alice" }, {});
    expect(r.status).toBe(401);
  });

  it("valid Bearer but resolver → null → 401 (fail closed, body never runs)", async () => {
    const r = await httpReq(
      "POST",
      `${base}/secret/slug-null`,
      { Authorization: `Bearer ${bearerToken("kc-sub-uuid")}` },
      {},
    );
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// dev-mode behaviour — pure pass-through
// ---------------------------------------------------------------------------

describe("[T-0328 G1] actor-inject façade — dev mode pass-through", () => {
  beforeAll(() => { process.env["CHOROS_AUTH_MODE"] = "dev"; _resetJwksCache(); });

  it("x-dev-user reaches the body UNCHANGED (injector is a no-op in dev)", async () => {
    const r = await httpReq("POST", `${base}/secret/slug-ok`, { "x-dev-user": "alice" }, {});
    expect(r.status).toBe(200);
    expect((r.json as { devUser: string }).devUser).toBe("alice");
  });

  it("process-start shape: x-dev-user + x-tenant-id pass through unchanged in dev", async () => {
    const r = await httpReq(
      "POST",
      `${base}/start/slug-tenant`,
      { "x-dev-user": "bob", "x-tenant-id": RESOLVED_TENANT },
      {},
    );
    expect(r.status).toBe(200);
    const j = r.json as { devUser: string; tenant: string };
    expect(j.devUser).toBe("bob");
    expect(j.tenant).toBe(RESOLVED_TENANT);
  });
});
