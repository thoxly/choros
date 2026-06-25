/**
 * src/http/llm-connections.ts — T-0474 [E-AGENTS L2]
 *
 * HTTP routes for the named LLM connection-profile registry (migration 094,
 * choros.llm_connection). Profiles are reusable, tenant-isolated LLM connection
 * descriptors (provider/endpoint/model/prices) that agent_card rows reference via
 * agent_card.llm_connection_id.
 *
 * Routes:
 *   GET  /api/llm-connections        — list the tenant's connection profiles.
 *   POST /api/llm-connections        — create a profile.
 *
 * Auth: same x-dev-user / keycloak-Bearer pattern as llm-config.ts (withAuth +
 *   extractActor + resolveActorTenant).
 * Authz (spec §6, T-0475 [E-AGENTS L4]): configuring connections = genesis-owner
 *   OR a holder of the dedicated `llm_connection:configure` capability grant. The
 *   gate is fail-closed: a plain tenant member (no owner, no grant) → 403. A
 *   role-constructor-admin (T-0469) granted llm_connection:configure inside the
 *   owner-delegated envelope qualifies via the grant. Resolved through
 *   canConfigureLlmConnection (capability-grants-dao), which composes the existing
 *   getGrantsForSubject DAO + the DB-resolved owner check — NOT the mgmt_object
 *   scoped-admin tier (this is a CAPABILITY, not an org-place delegation).
 * Tenant isolation: resolveActorTenant → withTenantTx (SET LOCAL + FORCE RLS) +
 *   the DAO's explicit WHERE tenant_id double-predicate.
 *
 * SECRET CUSTODY (spec NOTE / RL-3 — THE non-negotiable invariant):
 *   - The raw API key is NEVER accepted or stored here. The app:// encrypted store
 *     is L3 (a later task). This route accepts only an OPTIONAL `secret_handle`
 *     which must be an OPAQUE REFERENCE (env://NAME / vault://path / app://id) and
 *     is shape-guarded by validateSecretHandleShape (rejects sk-*, JWTs, bare hex,
 *     too-short) BEFORE any write. A raw key → 400, never persisted.
 *   - The handle is NEVER returned to the client. List responses expose a boolean
 *     `secret_bound` + a redacted scheme summary (redactHandle), never the value.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { canConfigureLlmConnection } from "../db/capability-grants-dao.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import {
  validateSecretHandleShape,
  redactHandle,
} from "../core/secret-handle-validator.js";
import {
  listLlmConnections,
  createLlmConnection,
  clearDefaultLlmConnection,
  isLlmProvider,
  type LlmConnectionRow,
} from "../db/llm-connection-dao.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface LlmConnectionsRouteDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// Auth helper (same pattern as llm-config.ts / agents-list.ts)
// ---------------------------------------------------------------------------

function extractActor(req: import("node:http").IncomingMessage): string {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) return ctx.sub;
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors llm-config.ts (SET LOCAL + FORCE RLS)
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

// ---------------------------------------------------------------------------
// Authz — T-0475 [E-AGENTS L4]: configuring connections = genesis-owner OR a
// holder of the dedicated `llm_connection:configure` capability grant (spec §6).
// Resolved by canConfigureLlmConnection (capability-grants-dao). Fail-closed: a
// plain member with neither → 403.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Audit writer
// ---------------------------------------------------------------------------

const auditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// Response shaping — NEVER egress the opaque handle.
// ---------------------------------------------------------------------------

interface LlmConnectionView {
  id: string;
  name: string;
  provider: string;
  endpoint: string | null;
  model: string | null;
  /** true iff a secret handle is bound. The raw handle NEVER travels. */
  secret_bound: boolean;
  /** Redacted scheme summary (e.g. "env://...") or null. Never the full value. */
  secret_handle_redacted: string | null;
  price_input_per_1k: number | null;
  price_output_per_1k: number | null;
  currency: string;
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

function toView(row: LlmConnectionRow): LlmConnectionView {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    endpoint: row.endpoint,
    model: row.model,
    secret_bound: row.secretHandle !== null,
    secret_handle_redacted:
      row.secretHandle !== null ? redactHandle(row.secretHandle) : null,
    price_input_per_1k: row.priceInputPer1k,
    price_output_per_1k: row.priceOutputPer1k,
    currency: row.currency,
    is_default: row.isDefault,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /api/llm-connections
// ---------------------------------------------------------------------------

async function handleList(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const actor = extractActor(req);
  const tenantId = await resolveActorTenant(actor);
  const nowMs = Date.now();

  // Capability read: the connection registry (provider/endpoint/prices +
  // bound-state) is config metadata, not general-read — gate on the
  // llm_connection:configure capability (owner OR grant holder).
  if (!(await canConfigureLlmConnection(pool, tenantId, actor, nowMs))) {
    throw new HttpError(403, "LLM_CONNECTION_CONFIGURE_REQUIRED", "requires owner or llm_connection:configure grant");
  }

  const rows = await withTenantTx(pool, tenantId, (client) =>
    listLlmConnections(client as unknown as PgClientLike, tenantId),
  );

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ connections: rows.map(toView) }));
}

// ---------------------------------------------------------------------------
// POST /api/llm-connections
// ---------------------------------------------------------------------------

/**
 * Body:
 *   {
 *     name: string,                 (required, non-empty)
 *     provider: string,             (required, one of LLM_PROVIDERS)
 *     endpoint?: string,            (optional; if present must be https, no userinfo)
 *     model?: string,
 *     secret_handle?: string,       (optional; OPAQUE ref only — env://NAME / vault:// / app://;
 *                                    shape-guarded; a raw key → 400, never stored)
 *     price_input_per_1k?: number,
 *     price_output_per_1k?: number,
 *     currency?: string,
 *     is_default?: boolean
 *   }
 */
async function handleCreate(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const actor = extractActor(req);
  const tenantId = await resolveActorTenant(actor);
  const nowMs = Date.now();

  if (!(await canConfigureLlmConnection(pool, tenantId, actor, nowMs))) {
    throw new HttpError(403, "LLM_CONNECTION_CONFIGURE_REQUIRED", "requires owner or llm_connection:configure grant");
  }

  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null) {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  // name
  if (typeof b["name"] !== "string" || b["name"].trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "name is required (non-empty string)");
  }
  const name = b["name"].trim();

  // provider
  if (!isLlmProvider(b["provider"])) {
    throw new HttpError(
      400,
      "VALIDATION",
      "provider must be one of: deepseek, openai, anthropic, self-hosted, other",
    );
  }
  const provider = b["provider"];

  // endpoint (optional) — same https + no-userinfo policy as llm-config PUT, since
  // the resolved key is shipped as a bearer header to this endpoint.
  let endpoint: string | null = null;
  if (b["endpoint"] !== undefined && b["endpoint"] !== null && b["endpoint"] !== "") {
    if (typeof b["endpoint"] !== "string") {
      throw new HttpError(400, "VALIDATION", "endpoint must be a string");
    }
    let parsed: URL;
    try {
      parsed = new URL(b["endpoint"].trim());
    } catch {
      throw new HttpError(400, "VALIDATION", "endpoint must be a valid URL");
    }
    if (parsed.protocol !== "https:") {
      throw new HttpError(
        400,
        "VALIDATION",
        "endpoint must use https (the LLM key is sent as a bearer token)",
      );
    }
    if (parsed.username !== "") {
      throw new HttpError(
        400,
        "VALIDATION",
        "endpoint must not contain userinfo (user@host form is not permitted)",
      );
    }
    endpoint = parsed.href;
  }

  // model (optional)
  let model: string | null = null;
  if (b["model"] !== undefined && b["model"] !== null && b["model"] !== "") {
    if (typeof b["model"] !== "string") {
      throw new HttpError(400, "VALIDATION", "model must be a string");
    }
    model = b["model"].trim();
  }

  // secret_handle (optional) — OPAQUE REFERENCE only. NEVER a raw key.
  // Shape-guard rejects sk-*/JWT/bare-hex/too-short BEFORE any write. The raw key
  // custody (app://) is L3 and is NOT implemented here.
  let secretHandle: string | null = null;
  if (
    b["secret_handle"] !== undefined &&
    b["secret_handle"] !== null &&
    b["secret_handle"] !== ""
  ) {
    if (typeof b["secret_handle"] !== "string") {
      throw new HttpError(400, "VALIDATION", "secret_handle must be a string");
    }
    const candidate = b["secret_handle"].trim();
    const verdict = validateSecretHandleShape(candidate);
    if (!verdict.ok) {
      // Do NOT echo the candidate (it may be a raw key the caller mis-pasted).
      throw new HttpError(
        400,
        "SECRET_HANDLE_REJECTED",
        `secret_handle must be an opaque reference (env:// / vault:// / app://), not a raw key (${verdict.reason})`,
      );
    }
    secretHandle = candidate;
  }

  // prices (optional, non-negative finite numbers)
  const priceInputPer1k = parseOptionalPrice(b["price_input_per_1k"], "price_input_per_1k");
  const priceOutputPer1k = parseOptionalPrice(b["price_output_per_1k"], "price_output_per_1k");

  // currency (optional, defaults USD)
  let currency = "USD";
  if (b["currency"] !== undefined && b["currency"] !== null && b["currency"] !== "") {
    if (typeof b["currency"] !== "string" || b["currency"].trim().length === 0) {
      throw new HttpError(400, "VALIDATION", "currency must be a non-empty string");
    }
    currency = b["currency"].trim().toUpperCase().slice(0, 8);
  }

  const isDefault = b["is_default"] === true;

  const created = await withTenantTx(pool, tenantId, async (client) => {
    // If this profile is to become the default, clear the prior default FIRST so the
    // one-default-per-tenant partial UNIQUE does not reject the insert (same tx).
    if (isDefault) {
      await clearDefaultLlmConnection(client as unknown as PgClientLike, tenantId, nowMs);
    }
    const row = await createLlmConnection(
      client as unknown as PgClientLike,
      tenantId,
      {
        name,
        provider,
        endpoint,
        model,
        secretHandle,
        priceInputPer1k,
        priceOutputPer1k,
        currency,
        isDefault,
        createdBy: actor,
      },
      nowMs,
    );

    // Audit — name/provider/endpoint/model are NOT secrets. The handle is NEVER
    // logged: we record only secret_bound + a redacted scheme summary.
    const auditInput: AuditEventInput = {
      id: randomUUID(),
      type: "create_llm_connection",
      actor,
      subject: row.id,
      scope: null,
      via: "llm-connections",
      proposed_by: null,
      confirmed_by: null,
      payload: {
        connectionId: row.id,
        name: row.name,
        provider: row.provider,
        endpoint: row.endpoint,
        model: row.model,
        is_default: row.isDefault,
        secret_bound: row.secretHandle !== null,
        secret_handle_redacted:
          row.secretHandle !== null ? redactHandle(row.secretHandle) : null,
      },
      occurred_at: nowMs,
    };
    await auditWriter.appendAuditEvent(client as unknown as PgClientLike, auditInput);

    return row;
  });

  res.statusCode = 201;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(toView(created)));
}

function parseOptionalPrice(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpError(400, "VALIDATION", `${label} must be a non-negative number`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register GET/POST /api/llm-connections. Additive — touches no existing routes.
 */
export function registerLlmConnectionsRoutes(
  router: Router,
  deps: LlmConnectionsRouteDeps,
): void {
  const { pool, resolveActorTenant } = deps;

  router.register(
    "GET",
    "/api/llm-connections",
    withAuth(async (req, res) => handleList(pool, resolveActorTenant, req, res)),
  );

  router.register(
    "POST",
    "/api/llm-connections",
    withAuth(async (req, res) => handleCreate(pool, resolveActorTenant, req, res)),
  );
}
