/**
 * src/db/llm-connection-dao.ts — T-0474 [E-AGENTS L2]
 *
 * Thin DAO for the named LLM connection-profile registry (migration 094,
 * choros.llm_connection). Tenant-isolated, RLS-backed.
 *
 * Operations (all run INSIDE the caller's open tenant-scoped tx — SET LOCAL
 * choros.tenant_id + FORCE RLS — they do NOT open their own BEGIN/COMMIT, same
 * convention as agent-provision.ts / cross-app-ref-dao.ts):
 *   listLlmConnections(client, tenantId)              → LlmConnectionRow[]
 *   getLlmConnection(client, tenantId, id)            → LlmConnectionRow | null
 *   createLlmConnection(client, tenantId, input)      → LlmConnectionRow
 *   getDefaultLlmConnection(client, tenantId)         → LlmConnectionRow | null
 *
 * Tenant isolation: every query carries an explicit `WHERE tenant_id = $1`
 * BYPASSRLS double-predicate guard (T-0184) on TOP of the RLS policy.
 *
 * SECRET CUSTODY (RL-3 / spec NOTE): `secret_handle` is an OPAQUE REFERENCE
 * (app://<id> / env://<NAME> / vault://<path>), NEVER a raw key. This DAO writes
 * and reads only the handle. The list/get readers below DO NOT return the raw
 * handle to callers — they expose a boolean `secretBound` instead (the route maps
 * rows so the opaque value never egresses). createLlmConnection returns the full
 * row to its caller (the route), which is responsible for collapsing the handle to
 * `secretBound` before responding (same custody discipline as llm-config.ts).
 *
 * NOT a second authority path: plain registry CRUD, no grant algebra. Does NOT
 * import grant-resolver / object-handle / scoped-admin. The HTTP route enforces
 * the llm_connection:configure authz (genesis-owner OR mgmt grant).
 */

import type { PgClientLike } from "./audit-writer.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Allowed provider discriminators (mirror the migration-094 CHECK constraint). */
export const LLM_PROVIDERS = [
  "deepseek",
  "openai",
  "anthropic",
  "self-hosted",
  "other",
] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value);
}

/**
 * A named LLM connection profile (migration 094 row), in camelCase.
 * `secretHandle` is the OPAQUE RL-3 reference — the route NEVER egresses it; it
 * surfaces only as a boolean to the client.
 */
export interface LlmConnectionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly provider: LlmProvider;
  readonly endpoint: string | null;
  readonly model: string | null;
  /** OPAQUE handle (app:///env:///vault://) — NEVER a raw key. Route collapses to bool. */
  readonly secretHandle: string | null;
  readonly priceInputPer1k: number | null;
  readonly priceOutputPer1k: number | null;
  readonly currency: string;
  readonly isDefault: boolean;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface LlmConnectionDbRow {
  id: string;
  tenant_id: string;
  name: string;
  provider: string;
  endpoint: string | null;
  model: string | null;
  secret_handle: string | null;
  price_input_per_1k: string | null;
  price_output_per_1k: string | null;
  currency: string;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: LlmConnectionDbRow): LlmConnectionRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    provider: r.provider as LlmProvider,
    endpoint: r.endpoint,
    model: r.model,
    secretHandle: r.secret_handle,
    // pg returns numeric as a string to preserve precision — parse to number for
    // the JSON contract (these are display prices, not exact-decimal accounting).
    priceInputPer1k: r.price_input_per_1k === null ? null : Number(r.price_input_per_1k),
    priceOutputPer1k: r.price_output_per_1k === null ? null : Number(r.price_output_per_1k),
    currency: r.currency,
    isDefault: r.is_default,
    createdBy: r.created_by,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const SELECT_COLS = `
  id, tenant_id, name, provider, endpoint, model, secret_handle,
  price_input_per_1k, price_output_per_1k, currency, is_default,
  created_by, created_at, updated_at`;

/**
 * List all LLM connection profiles for the current tenant, newest first.
 * Runs inside the caller's tenant-scoped tx. Explicit tenant_id predicate on top
 * of RLS (double guard).
 */
export async function listLlmConnections(
  client: PgClientLike,
  tenantId: string,
): Promise<LlmConnectionRow[]> {
  if (!isUuid(tenantId)) {
    throw new Error(`[T-0474] listLlmConnections: invalid tenantId shape`);
  }
  const { rows } = await client.query(
    `SELECT ${SELECT_COLS}
       FROM choros.llm_connection
      WHERE tenant_id = $1
      ORDER BY is_default DESC, created_at DESC, name ASC`,
    [tenantId],
  );
  return (rows as LlmConnectionDbRow[]).map(mapRow);
}

/**
 * Fetch one connection profile by id within the current tenant. Returns null when
 * absent (or owned by another tenant — RLS + the tenant_id predicate both bite).
 */
export async function getLlmConnection(
  client: PgClientLike,
  tenantId: string,
  id: string,
): Promise<LlmConnectionRow | null> {
  if (!isUuid(tenantId)) {
    throw new Error(`[T-0474] getLlmConnection: invalid tenantId shape`);
  }
  if (!isUuid(id)) return null;
  const { rows } = await client.query(
    `SELECT ${SELECT_COLS}
       FROM choros.llm_connection
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1`,
    [tenantId, id],
  );
  const r = (rows as LlmConnectionDbRow[])[0];
  return r ? mapRow(r) : null;
}

/**
 * Read the tenant's DEFAULT connection profile (is_default = true), if any.
 * The assistant references the default profile (spec §4.3).
 */
export async function getDefaultLlmConnection(
  client: PgClientLike,
  tenantId: string,
): Promise<LlmConnectionRow | null> {
  if (!isUuid(tenantId)) {
    throw new Error(`[T-0474] getDefaultLlmConnection: invalid tenantId shape`);
  }
  const { rows } = await client.query(
    `SELECT ${SELECT_COLS}
       FROM choros.llm_connection
      WHERE tenant_id = $1 AND is_default
      LIMIT 1`,
    [tenantId],
  );
  const r = (rows as LlmConnectionDbRow[])[0];
  return r ? mapRow(r) : null;
}

/** Fields accepted when creating a connection profile. */
export interface CreateLlmConnectionInput {
  readonly name: string;
  readonly provider: LlmProvider;
  readonly endpoint?: string | null;
  readonly model?: string | null;
  /** OPAQUE RL-3 handle (app:///env:///vault://). Caller validates the shape; never a raw key. */
  readonly secretHandle?: string | null;
  readonly priceInputPer1k?: number | null;
  readonly priceOutputPer1k?: number | null;
  readonly currency?: string;
  readonly isDefault?: boolean;
  readonly createdBy?: string | null;
}

/**
 * Create a connection profile for the current tenant and return the inserted row.
 * Runs inside the caller's tenant-scoped tx. tenant_id leads the INSERT (T-0013).
 *
 * When `isDefault` is true the caller is responsible for first clearing any prior
 * default (the partial UNIQUE index llm_connection_one_default_per_tenant otherwise
 * rejects a second default with a 23505 conflict) — see clearDefaultLlmConnection.
 */
export async function createLlmConnection(
  client: PgClientLike,
  tenantId: string,
  input: CreateLlmConnectionInput,
  nowMs: number,
): Promise<LlmConnectionRow> {
  if (!isUuid(tenantId)) {
    throw new Error(`[T-0474] createLlmConnection: invalid tenantId shape`);
  }
  const { rows } = await client.query(
    `INSERT INTO choros.llm_connection
       (tenant_id, name, provider, endpoint, model, secret_handle,
        price_input_per_1k, price_output_per_1k, currency, is_default,
        created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     RETURNING ${SELECT_COLS}`,
    [
      tenantId,
      input.name,
      input.provider,
      input.endpoint ?? null,
      input.model ?? null,
      input.secretHandle ?? null,
      input.priceInputPer1k ?? null,
      input.priceOutputPer1k ?? null,
      input.currency ?? "USD",
      input.isDefault ?? false,
      input.createdBy ?? null,
      nowMs,
    ],
  );
  return mapRow((rows as LlmConnectionDbRow[])[0]);
}

/**
 * Clear the current tenant's default flag (so a NEW default can be set without
 * tripping the one-default-per-tenant partial UNIQUE). No-op when none is set.
 * Call this in the SAME tx as a createLlmConnection({ isDefault: true }).
 */
export async function clearDefaultLlmConnection(
  client: PgClientLike,
  tenantId: string,
  nowMs: number,
): Promise<void> {
  if (!isUuid(tenantId)) {
    throw new Error(`[T-0474] clearDefaultLlmConnection: invalid tenantId shape`);
  }
  await client.query(
    `UPDATE choros.llm_connection
        SET is_default = false, updated_at = $2
      WHERE tenant_id = $1 AND is_default`,
    [tenantId, nowMs],
  );
}

/**
 * T-0476 [E-AGENTS L3]: point a connection profile at an OPAQUE secret handle
 * (e.g. app://<app_secret-id> after the raw key was encrypted into app_secret).
 * The handle is RL-3 opaque — NEVER a raw key (the route validates the shape and
 * only ever passes an app:///env:///vault:// reference here). Returns the prior
 * handle (so the caller can delete a superseded app_secret row), or undefined if
 * the connection id does not exist in this tenant. Runs inside the caller's
 * tenant-scoped tx; explicit tenant_id predicate on top of RLS (double guard).
 */
export async function setLlmConnectionSecretHandle(
  client: PgClientLike,
  tenantId: string,
  connectionId: string,
  secretHandle: string,
  nowMs: number,
): Promise<{ priorHandle: string | null } | undefined> {
  if (!isUuid(tenantId)) {
    throw new Error(`[T-0476] setLlmConnectionSecretHandle: invalid tenantId shape`);
  }
  if (!isUuid(connectionId)) return undefined;
  // Read the prior handle first (same tx) so the caller can clean up a superseded
  // app_secret row. Then update. Both are tenant-scoped (RLS + predicate).
  const before = await client.query(
    `SELECT secret_handle FROM choros.llm_connection
      WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, connectionId],
  );
  const beforeRow = (before.rows as Array<{ secret_handle: string | null }>)[0];
  if (!beforeRow) return undefined;
  await client.query(
    `UPDATE choros.llm_connection
        SET secret_handle = $3, updated_at = $4
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, connectionId, secretHandle, nowMs],
  );
  return { priorHandle: beforeRow.secret_handle ?? null };
}
