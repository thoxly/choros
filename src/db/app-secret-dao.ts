/**
 * src/db/app-secret-dao.ts — T-0476 [E-AGENTS L3]
 *
 * Thin DAO for the app:// encrypted secret store (migration 106, choros.app_secret).
 * Tenant-isolated, FORCE-RLS-backed.
 *
 * Operations (all run INSIDE the caller's open tenant-scoped tx — SET LOCAL
 * choros.tenant_id + FORCE RLS — they do NOT open their own BEGIN/COMMIT, same
 * convention as llm-connection-dao.ts / agent-provision.ts):
 *   insertAppSecret(client, tenantId, input, nowMs) → { id }
 *   getAppSecretSealed(client, tenantId, id)        → SealedSecretRow | null
 *   deleteAppSecret(client, tenantId, id)           → boolean (rows affected)
 *
 * CUSTODY (RL-3 / spec §5 — THE non-negotiable invariant):
 *   - This DAO stores and reads ONLY ciphertext + nonce + key_version. The RAW key
 *     is NEVER a column, NEVER a parameter, NEVER returned. Encryption/decryption is
 *     done by the CALLER (the route / resolver) via app-secret-cipher.ts before
 *     insert and after select. The plaintext never touches this module.
 *   - Tenant isolation: every query carries an explicit `WHERE tenant_id = $1`
 *     BYPASSRLS double-predicate guard (T-0184) on TOP of the RLS policy.
 *
 * NOT a second authority path: plain encrypted-blob CRUD, no grant algebra. The HTTP
 * route enforces the llm_connection:configure authz (genesis-owner OR mgmt grant).
 */

import type { PgClientLike } from "./audit-writer.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** The encrypted material of one app_secret row (NEVER the raw key). */
export interface SealedSecretRow {
  readonly id: string;
  /** AES-256-GCM ciphertext WITH appended auth tag (bytea). */
  readonly ciphertext: Buffer;
  /** Random 12-byte GCM nonce (bytea). */
  readonly nonce: Buffer;
  /** Master-key version that sealed this row. */
  readonly keyVersion: number;
}

/** Fields accepted when storing an encrypted secret (already-sealed material only). */
export interface InsertAppSecretInput {
  /** AES-256-GCM ciphertext+tag from encryptSecret(). */
  readonly ciphertext: Buffer;
  /** Random 12-byte nonce from encryptSecret(). */
  readonly nonce: Buffer;
  /** Master-key version (CURRENT_KEY_VERSION). */
  readonly keyVersion: number;
  /** Actor slug/sub that stored the secret (audit hint; never the key). */
  readonly createdBy?: string | null;
}

/**
 * Insert a sealed secret for the current tenant and return its generated id.
 * Runs inside the caller's tenant-scoped tx. tenant_id leads the INSERT (T-0013).
 * The returned id becomes the app://<id> handle written onto llm_connection.
 */
export async function insertAppSecret(
  client: PgClientLike,
  tenantId: string,
  input: InsertAppSecretInput,
  nowMs: number,
): Promise<{ id: string }> {
  if (!isUuid(tenantId)) {
    throw new Error(`[T-0476] insertAppSecret: invalid tenantId shape`);
  }
  if (!Buffer.isBuffer(input.ciphertext) || input.ciphertext.length === 0) {
    throw new Error(`[T-0476] insertAppSecret: ciphertext must be a non-empty Buffer`);
  }
  if (!Buffer.isBuffer(input.nonce) || input.nonce.length !== 12) {
    throw new Error(`[T-0476] insertAppSecret: nonce must be a 12-byte Buffer`);
  }
  const { rows } = await client.query(
    `INSERT INTO choros.app_secret
       (tenant_id, ciphertext, nonce, key_version, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING id`,
    [tenantId, input.ciphertext, input.nonce, input.keyVersion, input.createdBy ?? null, nowMs],
  );
  return { id: (rows as Array<{ id: string }>)[0]!.id };
}

/**
 * Fetch the sealed material for one app_secret row within the current tenant.
 * Returns null when absent (or owned by another tenant — RLS + the tenant_id
 * predicate both bite). The returned ciphertext/nonce are decrypted by the CALLER
 * (resolveSecret) in memory only; this DAO never sees the plaintext.
 */
export async function getAppSecretSealed(
  client: PgClientLike,
  tenantId: string,
  id: string,
): Promise<SealedSecretRow | null> {
  if (!isUuid(tenantId)) {
    throw new Error(`[T-0476] getAppSecretSealed: invalid tenantId shape`);
  }
  if (!isUuid(id)) return null;
  const { rows } = await client.query(
    `SELECT id, ciphertext, nonce, key_version
       FROM choros.app_secret
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1`,
    [tenantId, id],
  );
  const r = (rows as Array<{
    id: string;
    ciphertext: Buffer;
    nonce: Buffer;
    key_version: number;
  }>)[0];
  if (!r) return null;
  return {
    id: r.id,
    // node-postgres returns bytea as a Buffer.
    ciphertext: r.ciphertext,
    nonce: r.nonce,
    keyVersion: Number(r.key_version),
  };
}

/**
 * Delete one app_secret row within the current tenant. Returns true iff a row was
 * removed. Used when a connection's key is rotated/cleared (the old sealed row is
 * dropped after the handle is re-pointed). Tenant-scoped (RLS + predicate).
 */
export async function deleteAppSecret(
  client: PgClientLike,
  tenantId: string,
  id: string,
): Promise<boolean> {
  if (!isUuid(tenantId)) {
    throw new Error(`[T-0476] deleteAppSecret: invalid tenantId shape`);
  }
  if (!isUuid(id)) return false;
  // RETURNING id so we can count removed rows via the typed { rows } contract
  // (PgClientLike does not expose rowCount).
  const { rows } = await client.query(
    `DELETE FROM choros.app_secret WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [tenantId, id],
  );
  return (rows as unknown[]).length > 0;
}
