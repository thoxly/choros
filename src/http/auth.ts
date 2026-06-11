/**
 * src/http/auth.ts
 *
 * Auth layer for Choros:
 *   - Dev-stub path (CHOROS_AUTH_MODE=dev): reads identity from x-dev-user header.
 *   - Keycloak JWT path (CHOROS_AUTH_MODE=keycloak): validates Bearer JWT via JWKS.
 *
 * Migration seam (T-0054 §4.2): CHOROS_AUTH_MODE controls the active auth path.
 *   'dev' (default) — x-dev-user header stub; no JWT required.
 *                     All existing tests pass unchanged.
 *   'keycloak'      — Bearer JWT required; validated against Keycloak JWKS.
 *                     Implemented by T-0060.
 *
 * Guard (T-0060): withAuth(handler) — decorator that wraps worker RouteHandlers.
 * Single branching point: authenticate(req) in this file reads AUTH_MODE.
 * externalWorker.ts does NOT branch on AUTH_MODE — only calls withAuth().
 * AC-17: grep -rE 'CHOROS_AUTH_MODE' src/ ≤ 2 matches (this file + optional server.ts).
 */
import * as crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpError, type Router, type RouteHandler } from "./router.js";
import { findEmployee, listSelectableUsers } from "./org.js";
import { JobStore } from "../core/jobStore.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEV_USER_HEADER = "x-dev-user";

/**
 * Returns the active auth mode, reading from env each call.
 * Internal to the auth layer; not a public export (NF-2, AC-17).
 * Reading lazily (not a module-level const) allows tests to override CHOROS_AUTH_MODE.
 */
function getAuthMode(): "dev" | "keycloak" {
  return (process.env["CHOROS_AUTH_MODE"] ?? "dev") as "dev" | "keycloak";
}

/**
 * Public accessor for the active auth mode (used by modules outside the auth layer,
 * e.g. binding.ts — avoids re-reading process.env["CHOROS_AUTH_MODE"] directly).
 * Additive export seam; delegates to internal getAuthMode() — no behaviour change.
 */
export { getAuthMode };

/** Convenience alias for the /api/me route branch (eager read at route-registration time). */
const AUTH_MODE = getAuthMode();

// ---------------------------------------------------------------------------
// Types (ADR §3)
// ---------------------------------------------------------------------------

export interface AuthContext {
  sub: string;
  preferredUsername: string;
  actorType: "human" | "agent";
}

interface KeycloakAuthConfig {
  mode: "dev" | "keycloak";
  issuer: string;
  keycloakUrl: string;
  realm: string;
  audience: string;
  jwksUri: string | undefined;
  jwksCacheTtlMs: number;
}

interface Jwk {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
  alg?: string;
  use?: string;
}

interface JwksCacheEntry {
  keys: Jwk[];
  fetchedAtMs: number;
}

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface JwtClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  sub: string;
  preferred_username: string;
  actor_type: "human" | "agent";
}

// ---------------------------------------------------------------------------
// Identity WeakMap (FR-4, AC-15)
// ---------------------------------------------------------------------------

const authContextMap = new WeakMap<IncomingMessage, AuthContext>();

/**
 * Returns the AuthContext for a request after successful authentication.
 * Returns undefined for dev-mode requests (worker routes don't require identity in dev).
 */
export function getAuthContext(req: IncomingMessage): AuthContext | undefined {
  return authContextMap.get(req);
}

// ---------------------------------------------------------------------------
// Config resolution (ADR §1.2)
// ---------------------------------------------------------------------------

function resolveConfig(): KeycloakAuthConfig {
  const mode = AUTH_MODE;
  const keycloakUrl = process.env["KEYCLOAK_URL"] ?? "";
  const realm = process.env["KEYCLOAK_REALM"] ?? "choros";
  const audience = process.env["KEYCLOAK_AUDIENCE"] ?? "choros-api";
  const jwksCacheTtlMs = Number(process.env["JWKS_CACHE_TTL_MS"] ?? 300000);

  // KC_ISSUER is an optional override (T-0061 seam compatibility, ADR §1.2).
  // If set, it takes priority over computed KEYCLOAK_URL+KEYCLOAK_REALM.
  const kcIssuerOverride = process.env["KC_ISSUER"];
  const issuer = kcIssuerOverride
    ? kcIssuerOverride
    : keycloakUrl
    ? `${keycloakUrl}/realms/${realm}`
    : "";

  const jwksUri = process.env["KEYCLOAK_JWKS_URI"];

  return { mode, issuer, keycloakUrl, realm, audience, jwksUri, jwksCacheTtlMs };
}

/**
 * fail-fast config validation (ADR §1.7, AC-20).
 * Throws if CHOROS_AUTH_MODE=keycloak but neither KEYCLOAK_URL nor KC_ISSUER is set.
 * Called from registerExternalWorkerRoutes when in keycloak mode.
 */
export function assertKeycloakConfig(): void {
  if (getAuthMode() !== "keycloak") return;
  const keycloakUrl = process.env["KEYCLOAK_URL"] ?? "";
  const kcIssuerOverride = process.env["KC_ISSUER"] ?? "";
  if (!keycloakUrl && !kcIssuerOverride) {
    throw new Error(
      "CHOROS_AUTH_MODE=keycloak requires KEYCLOAK_URL (or KC_ISSUER override) to be set"
    );
  }
}

// ---------------------------------------------------------------------------
// JWKS cache (ADR §1.4)
// ---------------------------------------------------------------------------

let jwksCache: JwksCacheEntry | null = null;

/** Exported for testing only — resets the in-memory JWKS cache. */
export function _resetJwksCache(): void {
  jwksCache = null;
}

async function fetchJwksFromUri(uri: string): Promise<Jwk[]> {
  const response = await fetch(uri, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new HttpError(503, "AUTH_UNAVAILABLE", "auth service unavailable");
  }
  const data = (await response.json()) as { keys: Jwk[] };
  return data.keys;
}

async function resolveJwksUri(cfg: KeycloakAuthConfig): Promise<string> {
  if (cfg.jwksUri) return cfg.jwksUri;
  // OIDC Discovery
  const discoveryUrl = `${cfg.issuer}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new HttpError(503, "AUTH_UNAVAILABLE", "auth service unavailable");
  }
  const discovery = (await response.json()) as { jwks_uri: string };
  return discovery.jwks_uri;
}

/**
 * Gets JWKS keys, using the in-memory TTL cache (ADR §1.4).
 * forceRefresh=true bypasses the TTL (used on kid-miss to handle key rotation).
 */
export async function getJwks(
  cfg: KeycloakAuthConfig,
  forceRefresh = false
): Promise<Jwk[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    jwksCache !== null &&
    now - jwksCache.fetchedAtMs < cfg.jwksCacheTtlMs
  ) {
    return jwksCache.keys;
  }
  const uri = await resolveJwksUri(cfg);
  const keys = await fetchJwksFromUri(uri);
  jwksCache = { keys, fetchedAtMs: now };
  return keys;
}

// ---------------------------------------------------------------------------
// stdlib JWT validator (ADR §1.3, NF-1/FR-8)
// ---------------------------------------------------------------------------

function base64urlDecode(s: string): Buffer {
  // Convert base64url → standard base64, then decode
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function parseJwtParts(token: string): {
  header: JwtHeader;
  claims: JwtClaims;
  signingInput: string;
  signatureBuffer: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new HttpError(401, "UNAUTHENTICATED", "malformed JWT");
  }
  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = JSON.parse(base64urlDecode(parts[0]!).toString("utf8")) as JwtHeader;
    claims = JSON.parse(base64urlDecode(parts[1]!).toString("utf8")) as JwtClaims;
  } catch {
    throw new HttpError(401, "UNAUTHENTICATED", "malformed JWT");
  }
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signatureBuffer = base64urlDecode(parts[2]!);
  return { header, claims, signingInput, signatureBuffer };
}

function verifyRsaSignature(
  signingInput: string,
  signatureBuffer: Buffer,
  jwk: Jwk
): boolean {
  try {
    // Node 20 supports JWK format directly via createPublicKey
    const keyObject = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: "jwk" });
    return crypto.verify(
      "RSA-SHA256",
      Buffer.from(signingInput, "utf8"),
      keyObject,
      signatureBuffer
    );
  } catch {
    return false;
  }
}

function verifyEcSignature(
  signingInput: string,
  signatureBuffer: Buffer,
  jwk: Jwk
): boolean {
  try {
    const keyObject = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: "jwk" });
    // JWT ES256 signatures use IEEE P1363 raw R||S format (64 bytes for P-256).
    // Node's crypto.verify with an EC key expects DER-encoded signatures by default.
    // Passing dsaEncoding:'ieee-p1363' tells Node to accept the raw R||S directly.
    return crypto.verify(
      "SHA256",
      Buffer.from(signingInput, "utf8"),
      { key: keyObject, dsaEncoding: "ieee-p1363" },
      signatureBuffer
    );
  } catch {
    return false;
  }
}

function verifyClaims(claims: JwtClaims, cfg: KeycloakAuthConfig): void {
  // iss check (AC-10)
  if (claims.iss !== cfg.issuer) {
    throw new HttpError(401, "UNAUTHENTICATED", "invalid token issuer");
  }

  // aud check (AC-11): aud may be string or string[]
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.audience)) {
    throw new HttpError(401, "UNAUTHENTICATED", "invalid token audience");
  }

  // exp check with clock skew tolerance ≤ 60s (AC-9)
  const nowSecs = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp + 60 < nowSecs) {
    throw new HttpError(401, "UNAUTHENTICATED", "token expired");
  }

  // actor_type check (AC-12)
  if (claims.actor_type !== "human" && claims.actor_type !== "agent") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing or invalid actor_type claim");
  }

  // sub must be non-empty (AC-15)
  if (!claims.sub || typeof claims.sub !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing sub claim");
  }

  // preferred_username must be non-empty (AC-15)
  if (!claims.preferred_username || typeof claims.preferred_username !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing preferred_username claim");
  }
}

/**
 * Verifies a Bearer JWT token against Keycloak JWKS (ADR §1.3).
 * Throws HttpError(401) on token errors, HttpError(503) on KC unavailability.
 */
export async function verifyJwt(
  token: string,
  cfg: KeycloakAuthConfig
): Promise<JwtClaims> {
  let header: JwtHeader;
  let claims: JwtClaims;
  let signingInput: string;
  let signatureBuffer: Buffer;

  try {
    ({ header, claims, signingInput, signatureBuffer } = parseJwtParts(token));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, "UNAUTHENTICATED", "malformed JWT");
  }

  const kid = header.kid;
  const alg = header.alg;

  // Fetch JWKS (cached), find key by kid
  let keys: Jwk[];
  try {
    keys = await getJwks(cfg, false);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, "AUTH_UNAVAILABLE", "auth service unavailable");
  }

  let matchingKey = kid ? keys.find((k) => k.kid === kid) : keys[0];

  // If kid not found, try one forced refresh (key rotation, ADR §1.4)
  if (!matchingKey && kid) {
    try {
      keys = await getJwks(cfg, true);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(503, "AUTH_UNAVAILABLE", "auth service unavailable");
    }
    matchingKey = keys.find((k) => k.kid === kid);
  }

  if (!matchingKey) {
    throw new HttpError(401, "UNAUTHENTICATED", "unknown signing key");
  }

  // Verify signature (AC-8)
  let valid: boolean;
  try {
    if (alg === "RS256") {
      valid = verifyRsaSignature(signingInput, signatureBuffer, matchingKey);
    } else if (alg === "ES256") {
      valid = verifyEcSignature(signingInput, signatureBuffer, matchingKey);
    } else {
      throw new HttpError(401, "UNAUTHENTICATED", "unsupported algorithm");
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, "UNAUTHENTICATED", "signature verification failed");
  }

  if (!valid) {
    throw new HttpError(401, "UNAUTHENTICATED", "invalid signature");
  }

  // Validate claims (AC-9..AC-12, AC-15)
  verifyClaims(claims, cfg);

  return claims;
}

// ---------------------------------------------------------------------------
// authenticate — single branching point on AUTH_MODE (ADR §1.1, AC-17)
// ---------------------------------------------------------------------------

/**
 * Single branching point on CHOROS_AUTH_MODE.
 * dev-mode: no-op for worker routes (existing behaviour preserved, FR-5).
 * keycloak-mode: validates Bearer JWT; throws HttpError(401|503) on failure.
 * On success in keycloak-mode, stores AuthContext in WeakMap (ADR §1.6).
 */
async function authenticate(req: IncomingMessage): Promise<void> {
  if (getAuthMode() !== "keycloak") {
    // dev pass-through: worker routes don't require token in dev (FR-5)
    return;
  }

  const cfg = resolveConfig();

  // Extract Bearer token
  const authHeader = req.headers["authorization"];
  if (!authHeader || typeof authHeader !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing Authorization header");
  }

  if (!authHeader.startsWith("Bearer ")) {
    throw new HttpError(401, "UNAUTHENTICATED", "invalid Authorization header format");
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    throw new HttpError(401, "UNAUTHENTICATED", "empty Bearer token");
  }

  // Validate JWT — any exception from verifyJwt is already HttpError(401|503)
  let claims: JwtClaims;
  try {
    claims = await verifyJwt(token, cfg);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Unexpected internal error → fail-closed as 401 (ADR §1.5)
    throw new HttpError(401, "UNAUTHENTICATED", "token validation failed");
  }

  // Store identity in WeakMap (ADR §1.6, FR-4, AC-15)
  const ctx: AuthContext = {
    sub: claims.sub,
    preferredUsername: claims.preferred_username,
    actorType: claims.actor_type,
  };
  authContextMap.set(req, ctx);
}

// ---------------------------------------------------------------------------
// withAuth — decorator for worker RouteHandlers (ADR §1.1, §4)
// ---------------------------------------------------------------------------

/**
 * Wraps a RouteHandler with authentication.
 * In dev-mode: pass-through (no-op authenticate).
 * In keycloak-mode: validates Bearer JWT; returns 401/503 before calling inner handler.
 * (ADR §4 contract)
 */
export function withAuth(handler: RouteHandler): RouteHandler {
  return async (req, res, params) => {
    await authenticate(req);
    return handler(req, res, params);
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAuthRoutes(router: Router, _store?: JobStore): void {
  // GET /api/users — return list of selectable users (humans only)
  router.register("GET", "/api/users", async (_req, res) => {
    const users = await listSelectableUsers();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ users }));
  });

  // GET /api/me — return current user identity
  router.register("GET", "/api/me", async (req, res) => {
    if (AUTH_MODE === "keycloak") {
      // T-0060 implements the JWT validation branch.
      // Until the full UI-auth task is done, return 501 for /api/me in keycloak mode.
      // The worker-endpoint auth is handled via withAuth() in externalWorker.ts.
      throw new HttpError(501, "NOT_IMPLEMENTED", "keycloak auth mode requires T-0060 JWT validator");
    }

    // AUTH_MODE === 'dev': read identity from x-dev-user header (existing behaviour)
    let devUserId = req.headers[DEV_USER_HEADER];
    if (Array.isArray(devUserId)) {
      devUserId = devUserId[0];
    }

    if (!devUserId || typeof devUserId !== "string") {
      throw new HttpError(401, "UNAUTHENTICATED", "no valid dev identity");
    }

    const employee = await findEmployee(devUserId);
    if (!employee) {
      throw new HttpError(401, "UNAUTHENTICATED", "no valid dev identity");
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: employee.id,
        name: employee.name,
        type: employee.type,
        position: employee.position,
        department: employee.department,
      })
    );
  });
}
