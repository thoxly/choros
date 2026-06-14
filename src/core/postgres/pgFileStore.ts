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
  async insertFile(file: Omit<FileRow, "registryId">): Promise<void> {
    await this.pool.query(
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

  async getFile(tenantId: string, fileId: string): Promise<FileRow | null> {
    const { rows } = await this.pool.query<FileDbRow>(
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

  async getVersion(tenantId: string, versionId: string): Promise<FileVersionRow | null> {
    const { rows } = await this.pool.query<FileVersionDbRow>(
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

  async maxVersionNo(tenantId: string, fileId: string): Promise<number> {
    const { rows } = await this.pool.query<{ max_no: string | null }>(
      `SELECT MAX(version_no) AS max_no
       FROM choros.file_version
       WHERE tenant_id = $1 AND file_id = $2`,
      [tenantId, fileId],
    );
    const v = rows[0]?.max_no;
    return v === null || v === undefined ? 0 : Number(v);
  }

  async insertVersion(row: FileVersionRow): Promise<void> {
    await this.pool.query(
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
  ): Promise<void> {
    // Pointer-only update on choros.file. This is NOT a file_version content
    // mutation — version rows stay immutable (FF-V).
    await this.pool.query(
      `UPDATE choros.file
         SET current_version = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, fileId, versionId, atMs],
    );
  }

  async markContentErased(tenantId: string, versionId: string, atMs: number): Promise<void> {
    // The ONLY post-insert mutation of a file_version: the retention tombstone.
    // content_hash / object_key / size / mime are NOT touched — metadata survives
    // the byte erase (NF-5 / T-0016 append-only).
    await this.pool.query(
      `UPDATE choros.file_version
         SET content_erased_at = $3
       WHERE tenant_id = $1 AND id = $2 AND content_erased_at IS NULL`,
      [tenantId, versionId, atMs],
    );
  }
}
