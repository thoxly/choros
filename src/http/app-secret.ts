/**
 * src/http/app-secret.ts — T-0476 [E-AGENTS L3]
 *
 * The "вставить API-ключ" (paste-an-API-key) WRITE-ONLY surface for the app://
 * encrypted secret store (migration 106, choros.app_secret). This is the self-serve
 * tenant BYO-key path: a tenant admin pastes a raw key in the UI; this route
 * ENCRYPTS it (AES-256-GCM) into app_secret and points the LLM connection profile at
 * the new app://<id> handle. The raw key is NEVER stored, NEVER logged, NEVER echoed.
 *
 * Spec: docs/specs/agent-registry-and-llm-keys.spec.md §4 п.4, §5, §8 L3.
 *
 * Routes (scoped to a connection profile so they nest cleanly under T-0474):
 *   POST /api/llm-connections/:id/key         → bind a key (encrypt → app://<id>).
 *   GET  /api/llm-connections/:id/key/status  → secret_bound:bool + redactHandle.
 *   DELETE /api/llm-connections/:id/key       → clear the bound key (drop sealed row).
 *
 * Auth: same x-dev-user / keycloak-Bearer pattern as llm-connections.ts.
 * Authz (spec §6): managing a key = canConfigureLlmConnection (genesis-owner OR the
 *   llm_connection:configure capability). Fail-closed: plain member → 403.
 * Tenant isolation: resolveActorTenant → withTenantTx (SET LOCAL + FORCE RLS) + the
 *   DAO's explicit WHERE tenant_id double-predicate.
 *
 * DORMANCY (spec §4 п.4): when APP_SECRET_MASTER_KEY is unset the store is DORMANT.
 *   POST returns 503 "secret store not configured" (honest) — it NEVER stores the
 *   plaintext and NEVER crashes. GET status still works (it reads the handle, not the
 *   key). This is signalled by AppSecretStoreunconfiguredError from loadMasterKey.
 *
 * NON-EGRESS (RL-3 — the keystone invariant): the raw key flows ONLY:
 *   request body → encryptSecret() → app_secret.ciphertext. It is never placed in a
 *   response, an error message, an audit payload, or a log. The audit records only
 *   secret_bound + a redacted scheme summary.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import { canConfigureLlmConnection } from "../db/capability-grants-dao.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import {
  makeAppHandle,
  redactHandle,
  isAppHandle,
  parseAppHandle,
} from "../core/secret-handle-validator.js";
import {
  encryptSecret,
  loadMasterKey,
  AppSecretStoreUnconfiguredError,
} from "../core/app-secret-cipher.js";
import { insertAppSecret, deleteAppSecret } from "../db/app-secret-dao.js";
import {
  getLlmConnection,
  setLlmConnectionSecretHandle,
} from "../db/llm-connection-dao.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/** Provider for the AEAD master key. Reads process.env at the COMPOSITION ROOT only
 *  (server.ts) — this module never touches process.env (no-env-in-core spirit). */
export type MasterKeyProvider = () => string | undefined;

export interface AppSecretRouteDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
  /** Returns the raw APP_SECRET_MASTER_KEY (or undefined → DORMANT). */
  getMasterKey: MasterKeyProvider;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// Auth helper (mirrors agents.ts::extractActor — T-0371/T-0633: resolve the
// keycloak sub to the REAL employee slug via resolveActorSlugFromAuth before
// it drives tenant/grant resolution). dev mode unchanged.
// ---------------------------------------------------------------------------

async function extractActor(
  req: import("node:http").IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors llm-connections.ts (SET LOCAL + FORCE RLS)
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const auditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// POST /api/llm-connections/:id/key — bind an API key (write-only).
//
// Body: { api_key: string }  — the RAW key (the ONLY place it ever appears).
// Effect: encrypt → app_secret row → llm_connection.secret_handle = app://<row id>.
// Response: { secret_bound: true, secret_handle_redacted: "app://..." } — NO key.
// ---------------------------------------------------------------------------

async function handleBindKey(
  deps: AppSecretRouteDeps,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  connectionId: string,
): Promise<void> {
  const { pool, resolveActorTenant, getMasterKey } = deps;
  const actor = await extractActor(req, pool);
  assertUuidShape(connectionId, "connectionId");
  const tenantId = await resolveActorTenant(actor);
  const nowMs = Date.now();

  if (!(await canConfigureLlmConnection(pool, tenantId, actor, nowMs))) {
    throw new HttpError(403, "LLM_CONNECTION_CONFIGURE_REQUIRED", "requires owner or llm_connection:configure grant");
  }

  // DORMANCY GATE: master key resolved BEFORE reading the body so we fail honestly
  // (503) without ever touching the plaintext when the store is unconfigured.
  let masterKey: Buffer;
  try {
    masterKey = loadMasterKey(getMasterKey());
  } catch (err) {
    if (err instanceof AppSecretStoreUnconfiguredError) {
      throw new HttpError(503, "SECRET_STORE_UNCONFIGURED", "secret store not configured (APP_SECRET_MASTER_KEY unset)");
    }
    throw err;
  }

  const body = await readJsonBody(req);
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>)["api_key"] !== "string"
  ) {
    throw new HttpError(400, "VALIDATION", "api_key is required and must be a string");
  }
  const apiKey = (body as Record<string, string>)["api_key"];
  if (apiKey.length === 0) {
    throw new HttpError(400, "VALIDATION", "api_key must be a non-empty string");
  }

  // Encrypt IN MEMORY. The plaintext apiKey is never persisted or echoed beyond here.
  const sealed = encryptSecret(apiKey, masterKey);

  const view = await withTenantTx(pool, tenantId, async (client) => {
    const pgLike = client as unknown as PgClientLike;

    // The connection must exist in this tenant (RLS + predicate). 404 otherwise.
    const conn = await getLlmConnection(pgLike, tenantId, connectionId);
    if (!conn) {
      throw new HttpError(404, "CONNECTION_NOT_FOUND", "connection profile not found");
    }

    // Store the sealed secret → app://<id>.
    const { id: secretId } = await insertAppSecret(
      pgLike,
      tenantId,
      {
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        keyVersion: sealed.keyVersion,
        createdBy: actor,
      },
      nowMs,
    );
    const handle = makeAppHandle(secretId);

    // Point the connection at the new handle; capture the prior handle for cleanup.
    const upd = await setLlmConnectionSecretHandle(pgLike, tenantId, connectionId, handle, nowMs);
    if (upd === undefined) {
      throw new HttpError(404, "CONNECTION_NOT_FOUND", "connection profile not found");
    }

    // If the prior handle was a superseded app:// row, delete it (avoid orphan keys).
    const prior = upd.priorHandle;
    if (prior && isAppHandle(prior)) {
      const parsed = parseAppHandle(prior);
      if (parsed && parsed.secretId !== secretId) {
        await deleteAppSecret(pgLike, tenantId, parsed.secretId);
      }
    }

    // Audit — records secret_bound + redacted scheme ONLY. The key NEVER appears.
    const auditInput: AuditEventInput = {
      id: randomUUID(),
      type: "bind_llm_connection_key",
      actor,
      subject: connectionId,
      scope: null,
      via: "app-secret",
      proposed_by: null,
      confirmed_by: null,
      payload: {
        connectionId,
        secret_bound: true,
        secret_handle_redacted: redactHandle(handle),
        key_version: sealed.keyVersion,
      },
      occurred_at: nowMs,
    };
    await auditWriter.appendAuditEvent(pgLike, auditInput);

    return { secret_bound: true, secret_handle_redacted: redactHandle(handle) };
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(view));
}

// ---------------------------------------------------------------------------
// GET /api/llm-connections/:id/key/status — read bound-state (never the key).
// ---------------------------------------------------------------------------

async function handleKeyStatus(
  deps: AppSecretRouteDeps,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  connectionId: string,
): Promise<void> {
  const { pool, resolveActorTenant } = deps;
  const actor = await extractActor(req, pool);
  assertUuidShape(connectionId, "connectionId");
  const tenantId = await resolveActorTenant(actor);
  const nowMs = Date.now();

  if (!(await canConfigureLlmConnection(pool, tenantId, actor, nowMs))) {
    throw new HttpError(403, "LLM_CONNECTION_CONFIGURE_REQUIRED", "requires owner or llm_connection:configure grant");
  }

  const view = await withTenantTx(pool, tenantId, async (client) => {
    const conn = await getLlmConnection(client as unknown as PgClientLike, tenantId, connectionId);
    if (!conn) {
      throw new HttpError(404, "CONNECTION_NOT_FOUND", "connection profile not found");
    }
    const handle = conn.secretHandle;
    if (handle === null) {
      return { secret_bound: false, secret_handle_redacted: null, scheme: null };
    }
    // Consume the full handle SERVER-SIDE ONLY; never echo it. The key itself is
    // not even read here (the handle is only an opaque reference).
    const scheme = isAppHandle(handle) ? "app" : handle.includes("://") ? handle.slice(0, handle.indexOf("://")) : "opaque";
    return { secret_bound: true, secret_handle_redacted: redactHandle(handle), scheme };
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(view));
}

// ---------------------------------------------------------------------------
// DELETE /api/llm-connections/:id/key — clear the bound key.
// ---------------------------------------------------------------------------

async function handleClearKey(
  deps: AppSecretRouteDeps,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  connectionId: string,
): Promise<void> {
  const { pool, resolveActorTenant } = deps;
  const actor = await extractActor(req, pool);
  assertUuidShape(connectionId, "connectionId");
  const tenantId = await resolveActorTenant(actor);
  const nowMs = Date.now();

  if (!(await canConfigureLlmConnection(pool, tenantId, actor, nowMs))) {
    throw new HttpError(403, "LLM_CONNECTION_CONFIGURE_REQUIRED", "requires owner or llm_connection:configure grant");
  }

  await withTenantTx(pool, tenantId, async (client) => {
    const pgLike = client as unknown as PgClientLike;
    const conn = await getLlmConnection(pgLike, tenantId, connectionId);
    if (!conn) {
      throw new HttpError(404, "CONNECTION_NOT_FOUND", "connection profile not found");
    }
    const prior = conn.secretHandle;
    // Clear the handle (set to empty-ref by writing a non-app placeholder? No —
    // we set it to NULL via the dedicated setter using an empty marker). The setter
    // requires a string; instead we directly null it here within the same tx.
    await pgLike.query(
      `UPDATE choros.llm_connection
          SET secret_handle = NULL, updated_at = $3
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, connectionId, nowMs],
    );
    // Drop the superseded app:// sealed row if any.
    if (prior && isAppHandle(prior)) {
      const parsed = parseAppHandle(prior);
      if (parsed) await deleteAppSecret(pgLike, tenantId, parsed.secretId);
    }
    const auditInput: AuditEventInput = {
      id: randomUUID(),
      type: "clear_llm_connection_key",
      actor,
      subject: connectionId,
      scope: null,
      via: "app-secret",
      proposed_by: null,
      confirmed_by: null,
      payload: { connectionId, secret_bound: false },
      occurred_at: nowMs,
    };
    await auditWriter.appendAuditEvent(pgLike, auditInput);
  });

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ secret_bound: false }));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAppSecretRoutes(router: Router, deps: AppSecretRouteDeps): void {
  router.register(
    "POST",
    "/api/llm-connections/:id/key",
    withAuth(async (req, res, params) => handleBindKey(deps, req, res, params["id"] ?? "")),
  );
  router.register(
    "GET",
    "/api/llm-connections/:id/key/status",
    withAuth(async (req, res, params) => handleKeyStatus(deps, req, res, params["id"] ?? "")),
  );
  router.register(
    "DELETE",
    "/api/llm-connections/:id/key",
    withAuth(async (req, res, params) => handleClearKey(deps, req, res, params["id"] ?? "")),
  );
}
