/**
 * src/__tests__/invoke-caller-spoof.adversarial.test.ts — T-0422 [SECURITY] adversary (Враг)
 *
 * THE SPOOF TEST (the important one). In keycloak mode the invoke route is
 * withAuth-wrapped and the grant-driving `callerId` is derived from the VALIDATED
 * Bearer token, NEVER from the request header. This test proves the header cannot
 * override the token:
 *
 *   Request carries BOTH
 *     - a VALID Bearer for actor X  (sub = preferred_username = "e-tokenowner")
 *     - a CONFLICTING x-dev-user header naming a DIFFERENT actor ("e-attacker")
 *
 *   Assertion: the `caller_id` written into invoke_proposal (and the audit actor)
 *   is "e-tokenowner" (the TOKEN), and is NEVER "e-attacker" (the header). The
 *   covering invoke-grant is loaded for the TOKEN actor; if the header had driven
 *   the callerId, the grant lookup would key on "e-attacker" → no covering grant
 *   → 403 (and the captured caller_id would be wrong). We get a 201 with
 *   caller_id == the token actor, conclusively proving token-wins.
 *
 * No live Keycloak / no DB: a local in-process JWKS server validates a real RS256
 * token, and a RECORDING stub pool replays the invoke DB flow and captures the
 * INSERTed caller_id. Runnable NOW in CI, deterministic.
 *
 * Defence in depth: this complements agent-auth-bypass.adversarial.test.ts which
 * proves x-dev-user-WITHOUT-a-token is rejected outright. Here a token IS present;
 * we prove the colocated x-dev-user is ignored, not merged.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { Router } from "../http/router.js";
import { registerInvokeRoutes } from "../http/invoke.js";
import { _resetJwksCache } from "../http/auth.js";

// ---------------------------------------------------------------------------
// HTTP harness
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
// Identities — token actor vs header actor (intentionally different).
// ---------------------------------------------------------------------------

const TOKEN_ACTOR = "e-tokenowner"; // resolved identity MUST be this (from the JWT)
const HEADER_ACTOR = "e-attacker"; // x-dev-user — MUST be ignored once a token authenticated
const TENANT_ID = "a0000000-0000-0000-0000-000000000001"; // == DEV_TENANT_ID default in invoke.ts
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const ROLE_ID = "33333333-3333-3333-3333-333333333333";

// A covering grant: agent_role_id matches the target's role, scope (tags ["t1"])
// covers the target's org scope (tags ["t1"]). validFrom/validUntil omitted ⇒
// always effective. operation 'invoke'.
const TARGET_ORG_SCOPE = { kind: "tags", tags: ["t1"] };
const COVERING_GRANT_ROW = {
  id: "44444444-4444-4444-4444-444444444444",
  role_id: ROLE_ID,
  resource_type: "agent",
  resource_facet: { agent_role_id: ROLE_ID },
  operation: "invoke",
  scope: { kind: "tags", tags: ["t1"] },
  constraint: null,
  delegable: false,
  granted_by: "seed",
  valid_from: null,
  valid_until: null,
  created_at: String(Date.now() - 1000),
};

// ---------------------------------------------------------------------------
// RECORDING stub pool — replays the invoke DB flow by SQL-text routing and
// captures the caller_id passed into the invoke_proposal INSERT.
//
// CRITICAL: the grant lookup (loadCallerInvokeGrants) returns the covering grant
// ONLY when the bound callerId param == TOKEN_ACTOR. If the route had driven the
// callerId from x-dev-user (HEADER_ACTOR), the grant lookup would miss → 403 and
// nothing is inserted. So a 201 with caller_id == TOKEN_ACTOR is the proof.
// ---------------------------------------------------------------------------

interface RecordingPool {
  pool: import("pg").Pool;
  insertedCallerIds: string[];
  grantLookupCallerIds: string[];
  employeeExistenceChecks: string[];
}

function makeRecordingPool(): RecordingPool {
  const insertedCallerIds: string[] = [];
  const grantLookupCallerIds: string[] = [];
  const employeeExistenceChecks: string[] = [];

  const client = {
    query: async (text: string, params?: unknown[]) => {
      const sql = typeof text === "string" ? text : "";

      // resolveActorSlugFromAuth existence check — the token sub/preferred_username
      // resolves to a real human employee. We return exists=true ONLY for the
      // token actor's slug, so the resolved slug is exactly the token identity.
      if (sql.includes("FROM choros.employee") && sql.includes("EXISTS")) {
        const slug = String(params?.[0] ?? "");
        employeeExistenceChecks.push(slug);
        return { rows: [{ exists: slug === TOKEN_ACTOR }] };
      }

      // T-0486: resolveActorTenant (employee ⋈ tenant by slug → tenant_id).
      // In keycloak mode resolveInvokeTenant calls this for the resolved caller.
      // Return the tenant ONLY for the token actor — any OTHER slug yields 0 rows,
      // which now fails CLOSED (403) instead of the removed DEV_TENANT_ID fallback.
      if (
        sql.includes("FROM choros.employee e") &&
        sql.includes("JOIN choros.tenant t") &&
        sql.includes("e.slug = $1")
      ) {
        const slug = String(params?.[0] ?? "");
        return { rows: slug === TOKEN_ACTOR ? [{ tenant_id: TENANT_ID }] : [] };
      }

      // loadAgentCard
      if (sql.includes("FROM choros.agent_card")) {
        return { rows: [{ employee_id: AGENT_ID }] };
      }

      // loadActiveRoleAssignment (single-table SELECT role_id, org_scope)
      if (
        sql.includes("FROM choros.role_assignment") &&
        !sql.includes('choros."grant"')
      ) {
        return { rows: [{ role_id: ROLE_ID, org_scope: TARGET_ORG_SCOPE }] };
      }

      // loadCallerInvokeGrants (grant JOIN role_assignment, keyed on callerId param $2)
      if (sql.includes('choros."grant"') && sql.includes("operation = 'invoke'")) {
        const callerId = String(params?.[1] ?? "");
        grantLookupCallerIds.push(callerId);
        // Covering grant returned ONLY for the token actor.
        return { rows: callerId === TOKEN_ACTOR ? [COVERING_GRANT_ROW] : [] };
      }

      // INSERT invoke_proposal — capture caller_id ($3).
      if (sql.includes("INSERT INTO choros.invoke_proposal")) {
        insertedCallerIds.push(String(params?.[2] ?? ""));
        return { rows: [], rowCount: 1 };
      }

      // --- audit-writer (appendAuditEvent) queries -------------------------
      // tenant_id read from the GUC the route set via SET LOCAL.
      if (sql.includes("current_setting('choros.tenant_id'") && sql.includes("AS tenant_id")) {
        return { rows: [{ tenant_id: TENANT_ID }] };
      }
      // per-tenant head SELECT ... FOR UPDATE → seed head row (seq 0, genesis hash).
      if (sql.includes("FROM choros.audit_head") && sql.includes("FOR UPDATE")) {
        return { rows: [{ seq: 0, row_hash: Buffer.alloc(32, 0), vocab_version: 1 }] };
      }

      // audit_head seed INSERT / advance UPDATE / audit_event INSERT, BEGIN/COMMIT/
      // SET LOCAL etc. — no-op.
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  const pool = {
    connect: async () => client as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;

  return { pool, insertedCallerIds, grantLookupCallerIds, employeeExistenceChecks };
}

// ---------------------------------------------------------------------------
// Local JWKS + RSA key — mint a real validated RS256 token for the TOKEN actor.
// ---------------------------------------------------------------------------

const KID = "t0422-spoof-key";
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

let server: http.Server;
let base: string;
let rec: RecordingPool;

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
  process.env["CHOROS_AUTH_MODE"] = "keycloak";
  _resetJwksCache();

  rec = makeRecordingPool();
  const router = new Router();
  registerInvokeRoutes(router, rec.pool);
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
// SPOOF: token-actor wins over a conflicting x-dev-user header.
// ---------------------------------------------------------------------------

describe("[T-0422 SPOOF] invoke callerId is TOKEN-derived, header can't override", () => {
  it("valid Bearer(X) + x-dev-user(Y): caller_id == token actor X, never header Y → 201", async () => {
    const r = await httpReq(
      "POST",
      `${base}/api/invoke/request`,
      {
        Authorization: `Bearer ${bearerToken(TOKEN_ACTOR)}`,
        "x-dev-user": HEADER_ACTOR, // conflicting header — the bait
      },
      { target_agent_id: AGENT_ID, goal: "spoof attempt" },
    );

    // A covering grant exists ONLY for the token actor; reaching 201 means the
    // grant lookup keyed on the TOKEN actor, not the header.
    expect(r.status).toBe(201);

    // The persisted caller_id is the TOKEN actor.
    expect(rec.insertedCallerIds).toContain(TOKEN_ACTOR);
    // ...and NEVER the header actor.
    expect(rec.insertedCallerIds).not.toContain(HEADER_ACTOR);

    // The grant lookup itself was keyed on the TOKEN actor (the authority decision
    // rode the token, not the header).
    expect(rec.grantLookupCallerIds).toContain(TOKEN_ACTOR);
    expect(rec.grantLookupCallerIds).not.toContain(HEADER_ACTOR);

    // The identity-resolution existence check ran for the TOKEN sub, never the header.
    expect(rec.employeeExistenceChecks).toContain(TOKEN_ACTOR);
    expect(rec.employeeExistenceChecks).not.toContain(HEADER_ACTOR);
  });

  it("invoke/command: same spoof — caller_id == token actor X, never header Y → 202", async () => {
    const before = rec.grantLookupCallerIds.length;
    const r = await httpReq(
      "POST",
      `${base}/api/invoke/command`,
      {
        Authorization: `Bearer ${bearerToken(TOKEN_ACTOR)}`,
        "x-dev-user": HEADER_ACTOR,
      },
      { target_agent_id: AGENT_ID, goal: "spoof attempt 2" },
    );
    expect(r.status).toBe(202);
    // The grant lookups added since this request keyed on the TOKEN actor only.
    const added = rec.grantLookupCallerIds.slice(before);
    expect(added).toContain(TOKEN_ACTOR);
    expect(added).not.toContain(HEADER_ACTOR);
  });

  it("control: a token whose sub matches NO employee fails closed (401), even with a valid x-dev-user", async () => {
    // "e-attacker" is the header actor; here we put it in the TOKEN too. The
    // recording pool returns exists=false for any slug != TOKEN_ACTOR, so
    // resolveActorSlugFromAuth → null → 401. Proves we never silently fall back
    // to x-dev-user when a token authenticated but resolved to no employee.
    const r = await httpReq(
      "POST",
      `${base}/api/invoke/request`,
      {
        Authorization: `Bearer ${bearerToken("e-nobody")}`,
        "x-dev-user": TOKEN_ACTOR, // a slug that WOULD resolve — but must be ignored
      },
      { target_agent_id: AGENT_ID, goal: "fallback probe" },
    );
    expect(r.status).toBe(401);
    // No proposal was inserted for this unresolved-token request.
    expect(rec.insertedCallerIds).not.toContain("e-nobody");
  });
});
