/**
 * src/core/postgres/pgFileStore.ts — T-0201 / T-0119
 *
 * Postgres-backed implementation of FileMetaSource (file-attachment.ts).
 * Mirrors choros.file + choros.file_version (migration 058). Mirrors
 * pgConnectorStore.ts.
 *
 * RLS invariants (T-0013 / T-0053):
 *   - Every op runs under a caller-SET choros.tenant_id GUC (transaction-scoped).
 *     RLS + FORCE enforce tenant isolation; without the GUC the op fails closed.
 *   - getFile JOINs choros.record to surface the owner record's registry_id —
 *     the registry id is needed ONLY to build the T-0014 record ResourceRef the
 *     PDP keys the scope on. The JOIN is RLS-scoped to the same tenant.
 *
 * Raw pg SQL with parameterised queries (no ORM). This DAO is metadata-only — it
 * NEVER touches the S3 object plane (that is the ObjectStore adapter).
 *
 * IMMUTABILITY (FF-V): this DAO exposes NO update of a file_version's content
 * columns. The only post-insert version mutator is markContentErased (the
 * retention tombstone, which sets content_erased_at — metadata/hash survive).
 */

import type { Pool } from "pg";
import type {
  FileMetaSource,
  FileRow,
  FileVersionRow,
} from "../file-attachment.js";
import { type DataClass } from "../data-classification.js";

/**
 * T-0621 [P0/tx-atomicity]: minimal structural shape every write/read op below
 * needs from its query executor. Satisfied by both `pg.Pool` and
 * `pg.PoolClient` (mirrors `Queryable` in pgJobStore.ts — the T-0636 P0-6
 * precedent for this exact seam). Every method below accepts an OPTIONAL
 * trailing `executor` and defaults to `this.pool` (today's behaviour,
 * unchanged for every existing caller that omits it).
 *
 * WHY THIS EXISTS: src/http/files.ts's upload route wraps insertFile +
 * addVersion in `withTenantTx` (a dedicated `pg.PoolClient` with
 * `SET LOCAL choros.tenant_id` + `BEGIN`/`COMMIT`/`ROLLBACK`), but every
 * PgFileStore method historically queried `this.pool` directly — a SEPARATE,
 * autocommitting connection. `insertFile` committed the moment it ran,
 * regardless of what happened afterward; a mid-way DB error in `insertVersion`
 * (thrown AFTER insertFile's row was already durable) could not be undone by
 * the outer tx's ROLLBACK, leaving an orphan `choros.file` row
 * (`current_version = NULL`, zero versions). T-0620 closed the DENY-path
 * instance of this (authorize before insertFile, so a clean PDP deny never
 * reaches insertFile at all) but did not change WHERE insertFile/insertVersion
 * actually run — a genuine mid-transaction DB error (not a PDP deny) between
 * insertFile and insertVersion committing was, and without this seam remains,
 * unrecoverable. Passing the SAME `pg.PoolClient` withTenantTx already opened
 * (which already carries the `SET LOCAL choros.tenant_id` GUC — RLS scope is
 * inherited, not re-derived) as `executor` to both insertFile and (via a
 * request-scoped FileMetaSource view) insertVersion/getFile/maxVersionNo/
 * setCurrentVersion makes every DML of one upload part of ONE Postgres
 * transaction: a mid-way throw anywhere in that sequence rolls back all of it,
 * so no `choros.file` row can ever be orphaned by a DB-level failure.
 */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

// ---------------------------------------------------------------------------
// DB row shapes (snake_case → camelCase)
// ---------------------------------------------------------------------------

interface FileDbRow {
  tenant_id: string;
  id: string;
  record_id: string;
  registry_id: string; // from the JOIN to choros.record
  original_name: string;
  current_version: string | null;
  retention_state: string;
  retention_policy_ref: string | null;
  created_by: string;
  created_at: string; // bigint → string from pg
  updated_at: string;
}

interface FileVersionDbRow {
  tenant_id: string;
  id: string;
  file_id: string;
  version_no: number | string;
  object_key: string;
  mime_type: string;
  size_bytes: string;
  content_hash: string;
  data_class: string;
  is_snapshot: boolean;
  cycle_ref: string | null;
  content_erased_at: string | null;
  uploaded_by: string;
  uploaded_at: string;
}

function isRetentionState(v: string): v is FileRow["retentionState"] {
  return v === "active" || v === "archived" || v === "pending_deletion";
}

function isDataClass(v: string): v is DataClass {
  return v === "public" || v === "internal" || v === "confidential" || v === "restricted";
}

function rowToFile(row: FileDbRow): FileRow {
  if (!isRetentionState(row.retention_state)) {
    throw new Error(`pgFileStore: unexpected retention_state '${row.retention_state}'`);
  }
  return {
    tenantId: row.tenant_id,
    id: row.id,
    recordId: row.record_id,
    registryId: row.registry_id,
    originalName: row.original_name,
    currentVersion: row.current_version,
    retentionState: row.retention_state,
    retentionPolicyRef: row.retention_policy_ref,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToVersion(row: FileVersionDbRow): FileVersionRow {
  if (!isDataClass(row.data_class)) {
    throw new Error(`pgFileStore: unexpected data_class '${row.data_class}'`);
  }
  return {
    tenantId: row.tenant_id,
    id: row.id,
    fileId: row.file_id,
    versionNo: Number(row.version_no),
    objectKey: row.object_key,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    contentHash: row.content_hash,
    dataClass: row.data_class,
    isSnapshot: row.is_snapshot,
    cycleRef: row.cycle_ref,
    contentErasedAt: row.content_erased_at === null ? null : Number(row.content_erased_at),
    uploadedBy: row.uploaded_by,
    uploadedAt: Number(row.uploaded_at),
  };
}

// ---------------------------------------------------------------------------
// PgFileStore — production Postgres implementation of FileMetaSource
// ---------------------------------------------------------------------------

export class PgFileStore implements FileMetaSource {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert a logical file row. Not part of FileMetaSource (the attach surface)
   * but needed at the composition root to create a file before its first version.
   * current_version is NULL until addVersion runs.
   */
  /**
   * T-0621: optional trailing `executor` — the query executor to run the
   * INSERT on. Defaults to `this.pool` (today's behaviour, unchanged for
   * every existing caller). A caller that opened its own tx client (e.g.
   * `withTenantTx` in src/http/files.ts) passes that client here so this
   * INSERT commits/rolls back as part of the SAME transaction as any
   * subsequent op the caller runs on that client (see the Queryable doc
   * comment above for the full atomicity rationale).
   */
  async insertFile(file: Omit<FileRow, "registryId">, executor?: Queryable): Promise<void> {
    const q = executor ?? this.pool;
    await q.query(
      `INSERT INTO choros.file
         (tenant_id, id, record_id, original_name, current_version,
          retention_state, retention_policy_ref, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        file.tenantId,
        file.id,
        file.recordId,
        file.originalName,
        file.currentVersion,
        file.retentionState,
        file.retentionPolicyRef,
        file.createdBy,
        file.createdAt,
        file.updatedAt,
      ],
    );
  }

  async getFile(tenantId: string, fileId: string, executor?: Queryable): Promise<FileRow | null> {
    const q = executor ?? this.pool;
    const { rows } = await q.query<FileDbRow>(
      `SELECT f.tenant_id, f.id, f.record_id, r.registry_id,
              f.original_name, f.current_version, f.retention_state,
              f.retention_policy_ref, f.created_by, f.created_at, f.updated_at
       FROM choros.file f
       JOIN choros.record r ON r.tenant_id = f.tenant_id AND r.id = f.record_id
       WHERE f.tenant_id = $1 AND f.id = $2`,
      [tenantId, fileId],
    );
    if (rows.length === 0) return null;
    return rowToFile(rows[0]);
  }

  async getVersion(
    tenantId: string,
    versionId: string,
    executor?: Queryable,
  ): Promise<FileVersionRow | null> {
    const q = executor ?? this.pool;
    const { rows } = await q.query<FileVersionDbRow>(
      `SELECT tenant_id, id, file_id, version_no, object_key, mime_type, size_bytes,
              content_hash, data_class, is_snapshot, cycle_ref, content_erased_at,
              uploaded_by, uploaded_at
       FROM choros.file_version
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, versionId],
    );
    if (rows.length === 0) return null;
    return rowToVersion(rows[0]);
  }

  async maxVersionNo(tenantId: string, fileId: string, executor?: Queryable): Promise<number> {
    const q = executor ?? this.pool;
    const { rows } = await q.query<{ max_no: string | null }>(
      `SELECT MAX(version_no) AS max_no
       FROM choros.file_version
       WHERE tenant_id = $1 AND file_id = $2`,
      [tenantId, fileId],
    );
    const v = rows[0]?.max_no;
    return v === null || v === undefined ? 0 : Number(v);
  }

  async insertVersion(row: FileVersionRow, executor?: Queryable): Promise<void> {
    const q = executor ?? this.pool;
    await q.query(
      `INSERT INTO choros.file_version
         (tenant_id, id, file_id, version_no, object_key, mime_type, size_bytes,
          content_hash, data_class, is_snapshot, cycle_ref, content_erased_at,
          uploaded_by, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        row.tenantId,
        row.id,
        row.fileId,
        row.versionNo,
        row.objectKey,
        row.mimeType,
        row.sizeBytes,
        row.contentHash,
        row.dataClass,
        row.isSnapshot,
        row.cycleRef,
        row.contentErasedAt,
        row.uploadedBy,
        row.uploadedAt,
      ],
    );
  }

  async setCurrentVersion(
    tenantId: string,
    fileId: string,
    versionId: string,
    atMs: number,
    executor?: Queryable,
  ): Promise<void> {
    // Pointer-only update on choros.file. This is NOT a file_version content
    // mutation — version rows stay immutable (FF-V).
    const q = executor ?? this.pool;
    await q.query(
      `UPDATE choros.file
         SET current_version = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, fileId, versionId, atMs],
    );
  }

  /**
   * T-0621: bind a `FileMetaSource` VIEW of this store to a specific executor
   * (typically a `withTenantTx` client). Every read/write method on the
   * returned object delegates to `this.<method>(..., executor)` — so a
   * pure-core caller that only knows the `FileMetaSource` shape (e.g.
   * `addVersion` in core/file-attachment.ts, which is NOT allowed to import
   * `pg` — FF-PURE) can be handed a metadata source that transparently runs
   * every query on the SAME connection/transaction as the caller's other DML,
   * without core/file-attachment.ts ever knowing a `pg.PoolClient` exists.
   *
   * This is the seam src/http/files.ts's upload route uses: it opens
   * `withTenantTx`, calls `fileStore.insertFile(file, client)` directly, then
   * passes `fileStore.boundTo(client)` as `addVersion`'s `meta` — so
   * insertFile + addVersion's getFile/maxVersionNo/insertVersion/
   * setCurrentVersion all run on the one tx client. A mid-way DB error
   * anywhere in that sequence throws, `withTenantTx`'s catch ROLLBACKs, and
   * NOTHING commits (not insertFile, not a partial insertVersion) — no
   * orphaned `choros.file` row survives a mid-transaction failure.
   */
  boundTo(executor: Queryable): FileMetaSource {
    return {
      getFile: (tenantId, fileId) => this.getFile(tenantId, fileId, executor),
      getVersion: (tenantId, versionId) => this.getVersion(tenantId, versionId, executor),
      maxVersionNo: (tenantId, fileId) => this.maxVersionNo(tenantId, fileId, executor),
      insertVersion: (row) => this.insertVersion(row, executor),
      setCurrentVersion: (tenantId, fileId, versionId, atMs) =>
        this.setCurrentVersion(tenantId, fileId, versionId, atMs, executor),
      markContentErased: (tenantId, versionId, atMs) =>
        this.markContentErased(tenantId, versionId, atMs, executor),
      updateRetentionState: (tenantId, fileId, newState, atMs) =>
        this.updateRetentionState(tenantId, fileId, newState, atMs, executor),
    };
  }

  async updateRetentionState(
    tenantId: string,
    fileId: string,
    newState: FileRow["retentionState"],
    atMs: number,
    executor?: Queryable,
  ): Promise<void> {
    // T-0202: retention lifecycle state move on choros.file. Pointer/state-only —
    // this UPDATEs choros.file, NEVER a choros.file_version content column, so the
    // immutable-version invariant (FF-V) is preserved. The CHECK constraint on
    // retention_state (migration 058) is the schema-side backstop; the lawful
    // transition is decided in setRetentionState before this runs.
    const q = executor ?? this.pool;
    await q.query(
      `UPDATE choros.file
         SET retention_state = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, fileId, newState, atMs],
    );
  }

  async markContentErased(tenantId: string, versionId: string, atMs: number, executor?: Queryable): Promise<void> {
    // The ONLY post-insert mutation of a file_version: the retention tombstone.
    // content_hash / object_key / size / mime are NOT touched — metadata survives
    // the byte erase (NF-5 / T-0016 append-only).
    const q = executor ?? this.pool;
    await q.query(
      `UPDATE choros.file_version
         SET content_erased_at = $3
       WHERE tenant_id = $1 AND id = $2 AND content_erased_at IS NULL`,
      [tenantId, versionId, atMs],
    );
  }

  // ---------------------------------------------------------------------------
  // T-0518 — list files for a record (HTTP list route)
  // ---------------------------------------------------------------------------

  /**
   * List all non-deleted file rows owned by a record, joined to their current
   * version for mime/size. Tenant-scoped via RLS (must run inside a tenant tx
   * with SET LOCAL choros.tenant_id = '<tenantId>'). The LEFT JOIN on
   * file_version returns null size/mime when current_version is NULL (newly
   * created file with no version yet — should not normally appear on the list
   * route since POST /files immediately adds a version).
   *
   * T-0579 fix-forward (review m1): also returns `versionIds` — EVERY version
   * id ever recorded for the file, not just the current one. A field's stored
   * value is a fileVersionId captured at upload time; a later "Заменить"
   * re-upload on the SAME file row advances current_version but the OLD
   * versionId is still a legitimate historical version, not a dangling
   * reference. Callers resolving a value to a display name must match against
   * the FULL version set (versionIds.includes(value)), not just
   * currentVersionId, or a valid old value falsely resolves as "not found".
   */
  async listFilesByRecord(
    tenantId: string,
    recordId: string,
  ): Promise<
    Array<{
      fileId: string;
      originalName: string;
      currentVersionId: string | null;
      versionIds: string[];
      mime: string | null;
      sizeBytes: number | null;
      createdAt: number;
    }>
  > {
    const { rows } = await this.pool.query<{
      id: string;
      original_name: string;
      current_version: string | null;
      mime_type: string | null;
      size_bytes: string | null;
      created_at: string;
    }>(
      `SELECT f.id, f.original_name, f.current_version,
              fv.mime_type, fv.size_bytes, f.created_at
       FROM choros.file f
       LEFT JOIN choros.file_version fv
         ON fv.tenant_id = f.tenant_id AND fv.id = f.current_version
       WHERE f.tenant_id = $1 AND f.record_id = $2
       ORDER BY f.created_at ASC`,
      [tenantId, recordId],
    );
    if (rows.length === 0) return [];

    // Second query: every version id for every file row above, grouped by
    // file_id. One extra round-trip for the whole page (not per-row), same
    // tenant-scoped RLS transaction.
    const fileIds = rows.map((r) => r.id);
    const { rows: versionRows } = await this.pool.query<{ file_id: string; id: string }>(
      `SELECT file_id, id
       FROM choros.file_version
       WHERE tenant_id = $1 AND file_id = ANY($2::uuid[])
       ORDER BY version_no ASC`,
      [tenantId, fileIds],
    );
    const versionIdsByFile = new Map<string, string[]>();
    for (const vr of versionRows) {
      const list = versionIdsByFile.get(vr.file_id) ?? [];
      list.push(vr.id);
      versionIdsByFile.set(vr.file_id, list);
    }

    return rows.map((r) => ({
      fileId: r.id,
      originalName: r.original_name,
      currentVersionId: r.current_version,
      versionIds: versionIdsByFile.get(r.id) ?? [],
      mime: r.mime_type,
      sizeBytes: r.size_bytes !== null ? Number(r.size_bytes) : null,
      createdAt: Number(r.created_at),
    }));
  }
}
