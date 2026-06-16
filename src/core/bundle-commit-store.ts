/**
 * src/core/bundle-commit-store.ts
 *
 * T-0083 · E12.2 — Adapter / non-pure boundary for bundle-commit.
 *
 * This module is the IMPURE boundary that owns `node:crypto` (SHA-256) — exactly
 * as `keyed-digest.ts` owns `node:crypto` for the keyed-digest port (T-0118 seam).
 * The pure core (`bundle-commit.ts`) never imports crypto; it calls `BundleHashPort`.
 *
 * Exports:
 *   - `makeSha256Port()` — builds the BundleHashPort backed by SHA-256
 *   - `BundleCommitStore` interface — DB adapter interface (pg only in adapter layer)
 *   - `makeBundleCommitStore(pool)` — build a store backed by a pg pool
 *
 * The store persists BundleCommit objects into two tenant-scoped tables
 * (migration 069):
 *   choros.bundle_commit — one row per commit
 *   choros.bundle_ref    — named mutable pointer to a commit (e.g. "HEAD" for the
 *                          latest published commit of a given bundle)
 *
 * These tables are populated/read through choros_app (NOBYPASSRLS). Callers
 * supply the tenant_id via the pg session GUC (SET choros.tenant_id = '...') before
 * querying — the same RLS contract as every other choros tenant table.
 */

import { createHash } from "node:crypto";
import type pg from "pg";
import {
  type BundleHashPort,
  type BundleCommit,
  type BundleSnapshot,
} from "./bundle-commit.js";

// ---------------------------------------------------------------------------
// makeSha256Port — the concrete BundleHashPort (SHA-256 via node:crypto)
// ---------------------------------------------------------------------------

/**
 * Build a `BundleHashPort` backed by SHA-256. This is the ONLY call site of
 * `node:crypto` for bundle-commit; it lives here (adapter layer), not in core.
 *
 * Usage: inject the returned port into `makeCommit` at the composition seam.
 */
export function makeSha256Port(): BundleHashPort {
  return {
    hash(data: Buffer): string {
      return createHash("sha256").update(data).digest("hex");
    },
  };
}

// ---------------------------------------------------------------------------
// BundleCommitStore — interface (pg adapter)
// ---------------------------------------------------------------------------

/**
 * Persistence adapter for BundleCommit objects.
 *
 * All methods operate against the choros_app role under the caller-set RLS GUC
 * (choros.tenant_id). The `client` or `pool` passed to `makeBundleCommitStore`
 * must already have the GUC set for tenant-scoped access.
 */
export interface BundleCommitStore {
  /**
   * Persist a BundleCommit. The `tenant_id` is required for insert (RLS still
   * enforces it, but the application must supply it for the INSERT statement).
   * Idempotent: ON CONFLICT (tenant_id, content_hash) DO NOTHING.
   */
  saveCommit(tenantId: string, bundleId: string, commit: BundleCommit): Promise<void>;

  /**
   * Load a BundleCommit by its content_hash. Returns undefined if not found.
   */
  loadCommit(
    tenantId: string,
    bundleId: string,
    contentHash: string,
  ): Promise<BundleCommit | undefined>;

  /**
   * Advance the named ref (e.g. "HEAD") to point to `contentHash`. Upserts.
   * Used to record "the current published version" without touching commit objects.
   */
  setRef(tenantId: string, bundleId: string, refName: string, contentHash: string): Promise<void>;

  /**
   * Resolve a named ref to a content_hash. Returns undefined if the ref has no entry.
   */
  getRef(
    tenantId: string,
    bundleId: string,
    refName: string,
  ): Promise<string | undefined>;

  /**
   * List all commit content_hashes for a bundle, ordered oldest-first (by committed_at).
   * For building a changelog: walk forward through the chain.
   */
  listCommits(
    tenantId: string,
    bundleId: string,
  ): Promise<Array<{ content_hash: string; parent_hash: string; committed_at: number }>>;
}

// ---------------------------------------------------------------------------
// makeBundleCommitStore — pg-backed implementation
// ---------------------------------------------------------------------------

/** Row shape returned from the DB for a bundle_commit. */
interface BundleCommitRow {
  content_hash: string;
  parent_hash: string;
  author: string;
  message: string;
  committed_at: string; // bigint returned as string by pg driver
  snapshot_object_schema: string;
  snapshot_grants: string;
  snapshot_bpmn_process: string;
  snapshot_form_code: string;
  snapshot_form_json_schema: string;
}

function rowToCommit(row: BundleCommitRow): BundleCommit {
  const snapshot: BundleSnapshot = {
    object_schema: row.snapshot_object_schema,
    grants: row.snapshot_grants,
    bpmn_process: row.snapshot_bpmn_process,
    form_code: row.snapshot_form_code,
    form_json_schema: row.snapshot_form_json_schema,
  };
  return {
    content_hash: row.content_hash,
    parent_hash: row.parent_hash,
    snapshot,
    author: row.author,
    message: row.message,
    committed_at: parseInt(row.committed_at, 10),
  };
}

/**
 * Build a `BundleCommitStore` backed by the given pg `Pool` or `Client`.
 * The caller is responsible for setting `choros.tenant_id` GUC before querying
 * (or passing a pre-configured client). For INSERT operations the tenant_id is
 * supplied explicitly as a parameter (RLS still enforces it on reads).
 */
export function makeBundleCommitStore(
  pool: Pick<pg.Pool, "query"> | Pick<pg.Client, "query">,
): BundleCommitStore {
  return {
    async saveCommit(tenantId: string, bundleId: string, commit: BundleCommit): Promise<void> {
      await pool.query(
        `INSERT INTO choros.bundle_commit
           (tenant_id, bundle_id, content_hash, parent_hash, author, message,
            committed_at,
            snapshot_object_schema, snapshot_grants, snapshot_bpmn_process,
            snapshot_form_code, snapshot_form_json_schema)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, content_hash) DO NOTHING`,
        [
          tenantId,
          bundleId,
          commit.content_hash,
          commit.parent_hash,
          commit.author,
          commit.message,
          commit.committed_at,
          commit.snapshot.object_schema,
          commit.snapshot.grants,
          commit.snapshot.bpmn_process,
          commit.snapshot.form_code,
          commit.snapshot.form_json_schema,
        ],
      );
    },

    async loadCommit(
      tenantId: string,
      bundleId: string,
      contentHash: string,
    ): Promise<BundleCommit | undefined> {
      const res = await pool.query<BundleCommitRow>(
        `SELECT content_hash, parent_hash, author, message, committed_at,
                snapshot_object_schema, snapshot_grants, snapshot_bpmn_process,
                snapshot_form_code, snapshot_form_json_schema
         FROM choros.bundle_commit
         WHERE tenant_id = $1 AND bundle_id = $2 AND content_hash = $3`,
        [tenantId, bundleId, contentHash],
      );
      if (res.rows.length === 0) return undefined;
      return rowToCommit(res.rows[0]);
    },

    async setRef(
      tenantId: string,
      bundleId: string,
      refName: string,
      contentHash: string,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO choros.bundle_ref
           (tenant_id, bundle_id, ref_name, content_hash, updated_at)
         VALUES ($1, $2, $3, $4, extract(epoch from now()) * 1000)
         ON CONFLICT (tenant_id, bundle_id, ref_name)
         DO UPDATE SET content_hash = EXCLUDED.content_hash,
                       updated_at   = EXCLUDED.updated_at`,
        [tenantId, bundleId, refName, contentHash],
      );
    },

    async getRef(
      tenantId: string,
      bundleId: string,
      refName: string,
    ): Promise<string | undefined> {
      const res = await pool.query<{ content_hash: string }>(
        `SELECT content_hash FROM choros.bundle_ref
         WHERE tenant_id = $1 AND bundle_id = $2 AND ref_name = $3`,
        [tenantId, bundleId, refName],
      );
      if (res.rows.length === 0) return undefined;
      return res.rows[0].content_hash;
    },

    async listCommits(
      tenantId: string,
      bundleId: string,
    ): Promise<Array<{ content_hash: string; parent_hash: string; committed_at: number }>> {
      const res = await pool.query<{
        content_hash: string;
        parent_hash: string;
        committed_at: string;
      }>(
        `SELECT content_hash, parent_hash, committed_at
         FROM choros.bundle_commit
         WHERE tenant_id = $1 AND bundle_id = $2
         ORDER BY committed_at ASC`,
        [tenantId, bundleId],
      );
      return res.rows.map((r) => ({
        content_hash: r.content_hash,
        parent_hash: r.parent_hash,
        committed_at: parseInt(r.committed_at, 10),
      }));
    },
  };
}
