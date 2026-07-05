/**
 * src/__tests__/binding-owner-bypass.test.ts — T-0666 [substrate/P0, столп 2]
 *
 * checkRole (src/http/binding.ts) is the single conventional (non-PDP-grant)
 * authz gate for POST /api/forms/binding (+ the tenant-path POST, floor1-editor,
 * dmn-rule-table). Before T-0666, `process_designer` was seeded in NO tenant,
 * so the role_assignment lookup always returned 0 rows in keycloak auth mode —
 * form-binding save was 403 FORBIDDEN for EVERY actor, including the tenant
 * owner (LIVE_PROOF T-0656 had to grant the role by hand in the DB).
 *
 * T-0666 fix: checkRole now checks isGenesisOwnerForTenant (the SAME owner
 * short-circuit capability-grants-dao.ts already uses) BEFORE the
 * process_designer lookup. This file proves, over real HTTP with a signed
 * keycloak Bearer (local JWKS mock, no live Keycloak needed):
 *
 *   AC-2 — tenant owner (no process_designer role assignment) → POST
 *          /api/forms/binding → 201/200 (was 403 before the fix).
 *   AC-3 — DEACTIVATED owner (T-0658 gate: isGenesisOwnerForTenant's inner
 *          slug→employee subquery carries `AND deactivated_at IS NULL`) →
 *          bypass does NOT fire → falls through to the (also-empty)
 *          process_designer lookup → 403. Deactivation is inherited, not
 *          reopened by this task.
 *   AC-4 — rank-and-file actor (not owner, no process_designer role) → 403
 *          (access is not spilled to everyone by the bypass).
 *
 * No live Postgres: a differentiated stub pg.Pool replays each query by its
 * distinguishing SQL fragment (resolveActorSlugFromAuth's employee-exists
 * check, isGenesisOwnerForTenant's tenant-owner role_assignment query,
 * checkRole's process_designer role_assignment query, the form_binding
 * upsert). Keycloak mode via a local RSA keypair + JWKS server (mirrors
 * agent-auth-bypass.adversarial.test.ts / floor1-editor.test.ts harnesses).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerBindingRoutes } from "../http/binding.js";
import { _resetJwksCache } from "../http/auth.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Differentiated stub pg.Pool — one client shared across pool.connect() calls.
// isOwner / hasDesignerRole / actorExists are configured per describe block.
// ---------------------------------------------------------------------------

function makeStubPool(opts: {
  actorExists: boolean;
  isOwner: boolean;
  hasDesignerRole: boolean;
}): pg.Pool {
  const client = {
    query: async (text: string, _params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [] };
      // BEGIN/COMMIT/ROLLBACK/SET LOCAL — no-ops (withTenantTx / resolveActorSlugFromAuth's txn).
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/i.test(text.trim())) {
        return { rows: [] };
      }
      // resolveActorSlugFromAuth → humanEmployeeSlugExistsOnClient (org.ts:532).
      if (text.includes("SELECT EXISTS") && text.includes("choros.employee")) {
        return { rows: [{ exists: opts.actorExists }] };
      }
      // isGenesisOwnerForTenant (org.ts:721) — keyed on r.slug = 'tenant-owner'.
      if (text.includes("role_assignment") && text.includes("tenant-owner")) {
        return { rows: opts.isOwner ? [{ id: "owner-ra-1" }] : [] };
      }
      // checkRole (binding.ts:153) — keyed on r.slug = 'process_designer'.
      if (text.includes("role_assignment") && text.includes("process_designer")) {
        return { rows: [{ cnt: opts.hasDesignerRole ? 1 : 0 }] };
      }
      // getBinding SELECT (no existing row → INSERT path, 201).
      if (text.includes("FROM choros.form_binding") && text.includes("SELECT")) {
        return { rows: [] };
      }
      if (text.includes("INSERT INTO choros.form_binding")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// Local JWKS server + RSA keypair (mirrors floor1-editor.test.ts / T-0422
// adversarial harness) — lets the keycloak-mode Bearer pass real signature
// verification without a live Keycloak.
// ---------------------------------------------------------------------------

const KID = "t0666-owner-bypass-key";
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

function bearerToken(sub: string): string {
  const claims = {
    iss: `http://127.0.0.1:${jwksPort}/realms/choros`,
    aud: "choros-api",
    exp: Math.floor(Date.now() / 1000) + 300,
    sub,
    preferred_username: sub,
    actor_type: "human",
  };
  return signWith(kcPrivateKey, claims);
}

beforeAll(async () => {
  const trusted = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  kcPrivateKey = trusted.privateKey;
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
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedAuthEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetJwksCache();
  await new Promise<void>((r) => jwksServer.close(() => r()));
});

const ORIGINAL_AUTH_MODE = process.env["CHOROS_AUTH_MODE"];
afterEach(() => {
  if (ORIGINAL_AUTH_MODE === undefined) delete process.env["CHOROS_AUTH_MODE"];
  else process.env["CHOROS_AUTH_MODE"] = ORIGINAL_AUTH_MODE;
});

async function startServer(pool: pg.Pool): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerBindingRoutes(router, pool, {
    pool,
    resolveActorTenant: async () => TENANT_ID,
  });
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((e: Error | undefined) => (e ? reject(e) : resolve()))),
  };
}

function postFormBinding(
  port: number,
  bearer: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      processKey: "purchase-approval",
      stepKey: "purchase-form",
      fields: [{ key: "supplier", type: "string", required: true, label: "Supplier" }],
    });
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/forms/binding",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${bearer}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// AC-2 — tenant owner, NO process_designer role assignment → 200/201.
// ---------------------------------------------------------------------------

describe("T-0666 AC-2 — keycloak mode, tenant owner (no process_designer role) → 201", () => {
  it("POST /api/forms/binding succeeds via the owner bypass, no manual role grant", async () => {
    process.env["CHOROS_AUTH_MODE"] = "keycloak";
    const pool = makeStubPool({ actorExists: true, isOwner: true, hasDesignerRole: false });
    const { port, close } = await startServer(pool);
    try {
      const resp = await postFormBinding(port, bearerToken("e-owner"));
      expect(resp.status).toBe(201);
      const body = resp.body as { id: string; version: number };
      expect(body.version).toBe(1);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3 — DEACTIVATED owner: isGenesisOwnerForTenant's own fail-closed gate
// (T-0658) means it never resolves true for a deactivated employee slug — that
// is proven at the DB layer by ci/checks/db/org-admin-deactivation.db.test.ts.
// Here we simulate the CONSEQUENCE at the HTTP layer: with isOwner=false
// (what a deactivated owner resolves to) AND no process_designer role, the
// route still 403s — the bypass does not somehow route around deactivation.
// ---------------------------------------------------------------------------

describe("T-0666 AC-3 — keycloak mode, DEACTIVATED owner (isGenesisOwnerForTenant=false per T-0658) → 403", () => {
  it("POST /api/forms/binding still 403s — bypass does not resurrect a deactivated owner", async () => {
    process.env["CHOROS_AUTH_MODE"] = "keycloak";
    const pool = makeStubPool({ actorExists: true, isOwner: false, hasDesignerRole: false });
    const { port, close } = await startServer(pool);
    try {
      const resp = await postFormBinding(port, bearerToken("e-owner-deactivated"));
      expect(resp.status).toBe(403);
      expect((resp.body as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4 — rank-and-file actor: not owner, no process_designer role → 403.
// Proves the owner bypass does NOT spill access to everyone.
// ---------------------------------------------------------------------------

describe("T-0666 AC-4 — keycloak mode, rank-and-file actor (not owner, no role) → 403", () => {
  it("POST /api/forms/binding still 403s for a plain employee", async () => {
    process.env["CHOROS_AUTH_MODE"] = "keycloak";
    const pool = makeStubPool({ actorExists: true, isOwner: false, hasDesignerRole: false });
    const { port, close } = await startServer(pool);
    try {
      const resp = await postFormBinding(port, bearerToken("e-rank-and-file"));
      expect(resp.status).toBe(403);
      expect((resp.body as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    } finally {
      await close();
    }
  });

  it("positive control: actor WITH process_designer role (not owner) → 201 (existing convention unaffected)", async () => {
    process.env["CHOROS_AUTH_MODE"] = "keycloak";
    const pool = makeStubPool({ actorExists: true, isOwner: false, hasDesignerRole: true });
    const { port, close } = await startServer(pool);
    try {
      const resp = await postFormBinding(port, bearerToken("e-designer"));
      expect(resp.status).toBe(201);
    } finally {
      await close();
    }
  });
});
