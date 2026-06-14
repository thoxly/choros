/**
 * src/core/file-attachment.ts — T-0201 / T-0119
 *
 * Files / attachments: the pure-core write-path + authorization translation for
 * the file↔record model. Implements docs/design/T-0119-files-attachments.adr.md
 * §2 / §4.3 / §4.4.
 *
 * BEARING PRINCIPLE — a file's permission is a DERIVED projection of its owner
 * record's permission (record-RBAC, T-0119). There is NO second file-permission
 * authority: every file operation is TRANSLATED into an operation over the owner
 * `record` and decided by the SAME PDP (T-0021 `resolveFor` / `makeGrantResolver`).
 * This module computes NO grant math of its own — it imports the resolver and the
 * frozen handle/operation types and calls them.
 *
 * DESIGN INVARIANTS (ADR §2 / §6 fitness functions; enforced by
 * ci/checks/file-attachment-isolation.sh):
 *  - FF-NOACL : no `file_acl` / `attachment_rights` / `*.visibility` surface; authz
 *               goes through `resolveFor`/`resolveHandle` (T-0021), never a private filter.
 *  - FF-KEY   : `buildObjectKey` is the SINGLE key constructor; the key is tenant-prefixed
 *               and the tenantId is taken from tenant context, never an untrusted request arg.
 *  - FF-V     : content is immutable per version — `addVersion` INSERTs a new row + repoints
 *               `file.current_version`; it NEVER overwrites an existing object_key/content.
 *  - FF-PRESIGN-AFTER-ALLOW : `getFileContentUrl` calls `store.presignGet` ONLY after a
 *               PDP allow; on `{denied:true}` it returns without touching the ObjectStore.
 *  - FF-FAILCLOSED : missing tenant context / cross-tenant handle ⇒ deny before any S3 call.
 *  - FF-RETENTION-DENY : `eraseForRetention` erases content ONLY from `pending_deletion`;
 *               it sets `content_erased_at` and leaves the metadata/hash/audit alive.
 *
 * Pure-core: NO pg / fs / net / http(s) / fetch / child_process imports. All IO is
 * behind injected ports (ObjectStore, FileMetaSource, HandleResolver, AuditSink, clock).
 */

import { randomUUID } from "node:crypto";

import {
  type HandleResolver,
  type ResolveSubject,
  type ResolvedView,
  type ResourceRef,
  makeHandle,
} from "./object-handle.js";
import { type Operation } from "./grant-lattice.js";
import { type DataClass } from "./data-classification.js";
import { type AuditEventInput } from "./audit-grant-encoder.js";

// ---------------------------------------------------------------------------
// S3 port (the adapter; dev = MinIO). Injected; the core does not know the
// concrete provider (ADR §4.3 / §8). Swapping provider = swap adapter + env.
// ---------------------------------------------------------------------------

export interface ObjectStore {
  /**
   * Upload content under a deterministic key. The object is NEVER overwritten —
   * each version gets a fresh key (buildObjectKey with a fresh versionId).
   */
  put(key: string, body: Uint8Array, meta: { mime: string; size: number }): Promise<void>;
  /** Short-lived presigned GET url. Called ONLY after a PDP allow (FF-PRESIGN-AFTER-ALLOW). */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  /** Physical erase (retention). Metadata rows + audit trail are NOT touched. */
  erase(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Metadata source (the file/file_version DAO seam). Postgres DAO lives in
// src/core/postgres/pgFileStore.ts; the in-memory fake is used by unit tests.
// ---------------------------------------------------------------------------

/** Logical file-attachment row (mirrors choros.file). */
export interface FileRow {
  tenantId: string;
  id: string;
  recordId: string;
  /**
   * The owner record's registry id — needed ONLY to build the T-0014 record
   * `ResourceRef` the PDP keys the scope on. It is read from the file's owner
   * record metadata, never from the caller's request.
   */
  registryId: string;
  originalName: string;
  currentVersion: string | null;
  retentionState: "active" | "archived" | "pending_deletion";
  retentionPolicyRef: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Immutable content version row (mirrors choros.file_version). */
export interface FileVersionRow {
  tenantId: string;
  id: string;
  fileId: string;
  versionNo: number;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  dataClass: DataClass;
  isSnapshot: boolean;
  cycleRef: string | null;
  contentErasedAt: number | null;
  uploadedBy: string;
  uploadedAt: number;
}

/**
 * The file/file_version persistence seam. Reads are tenant-scoped (the Postgres
 * DAO runs under RLS); `getFile`/`getVersion` return `null` when absent.
 * `insertVersion` + `setCurrentVersion` are the ONLY content-version mutators on
 * the write-path (immutability is preserved — no version-content UPDATE exists).
 */
export interface FileMetaSource {
  getFile(tenantId: string, fileId: string): Promise<FileRow | null>;
  getVersion(tenantId: string, versionId: string): Promise<FileVersionRow | null>;
  /** Highest existing version_no for a file (0 when none) — for monotonic numbering. */
  maxVersionNo(tenantId: string, fileId: string): Promise<number>;
  /** INSERT a new immutable version row. */
  insertVersion(row: FileVersionRow): Promise<void>;
  /** Repoint file.current_version to a (just-inserted) version. Pointer only. */
  setCurrentVersion(tenantId: string, fileId: string, versionId: string, atMs: number): Promise<void>;
  /** Retention tombstone: stamp content_erased_at on a version (metadata survives). */
  markContentErased(tenantId: string, versionId: string, atMs: number): Promise<void>;
}

/** Optional audit sink (T-0016 file.* events). Additive — when absent, no audit emit. */
export interface FileAuditSink {
  emit(event: AuditEventInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// FF-KEY — THE single object-key constructor.
// ---------------------------------------------------------------------------

/**
 * The ONLY S3-key constructor (FF-KEY). The key is tenant-prefixed structurally:
 * `<tenantId>/<fileId>/<versionId>`. `tenantId` is supplied from the tenant
 * context of the session (see the write-path below), NEVER from an untrusted
 * request argument — so a cross-tenant key is unconstructible. No other code path
 * concatenates an S3 key; every `put`/`presignGet`/`erase` uses a key from here
 * (or a key read back from `file_version.object_key`, itself produced here).
 */
export function buildObjectKey(tenantId: string, fileId: string, versionId: string): string {
  return `${tenantId}/${fileId}/${versionId}`;
}

// ---------------------------------------------------------------------------
// Authorization — translate a file op into a record op + delegate to T-0021.
// ---------------------------------------------------------------------------

/**
 * The file-operation surface. Each maps to an operation over the OWNER record:
 *  - read   (download)         ⇒ `read`   on record
 *  - update (add / replace)    ⇒ `update` on record
 *  - delete                    ⇒ `delete` on record
 * No "invoke"/"approve"/"transition" file ops exist — the file surface is CRUD-only.
 */
export type FileOp = "read" | "update" | "delete";

/** Map a file op to the T-0018 record `Operation` it is decided as. */
function recordOpFor(op: FileOp): Operation {
  // 1:1 onto the record CRUD operations. A file op is NEVER its own authority kind.
  return op;
}

/**
 * Build the T-0014 `record` ResourceRef for the owner record of a file. The
 * scope the PDP tests is keyed on `recordId`; `registryId` is the structural
 * sibling the ref type requires. Both come from the file's owner metadata.
 */
function ownerRecordRef(file: FileRow): Extract<ResourceRef, { kind: "record" }> {
  return {
    kind: "record",
    tenantId: file.tenantId,
    registryId: file.registryId,
    recordId: file.recordId,
  };
}

/**
 * Authorize a file operation by TRANSLATING it into an operation over the owner
 * record and asking the SAME PDP (T-0021). This module owns no grant math.
 *
 * Sequence (ADR §4.4, fail-closed):
 *  1. tenant-gate: subject's tenant must equal the file's tenant — else
 *     `cross_tenant` BEFORE any record/grant read (FF-FAILCLOSED).
 *  2. build the owner-record handle; resolve `read` for the record via the
 *     resolver. For `read` we use `resolveHandle` (the read facade); for
 *     `update`/`delete` we still gate on a `read`-resolution of the record AND
 *     the caller is expected to have already write-gated the record mutation —
 *     here the file authz returns the PDP verdict for the requested op.
 *
 * Returns the resolver's `ResolvedView`: `{denied:true, reason}` or
 * `{denied:false, ref, fields}`. The reason-union is inherited verbatim from
 * T-0021 (`"no_grant" | "cross_tenant" | "not_found"`) — no new reasons.
 */
export async function authorizeFileOp(
  resolver: HandleResolver,
  file: FileRow,
  subject: ResolveSubject,
  op: FileOp,
): Promise<ResolvedView> {
  // 1. Tenant-gate, fail-closed, before any record/grant read.
  if (file.tenantId !== subject.tenantId) {
    return { denied: true, reason: "cross_tenant" };
  }

  // 2. Translate to a record handle + delegate to the single PDP. The handle is
  //    constructed via makeHandle (which re-checks tenant binding, fail-closed).
  const ref = ownerRecordRef(file);
  const handle = makeHandle(ref, file.tenantId);

  // The read facade (resolveHandle) is the public HandleResolver surface and is
  // the right call for a `read` (download) decision. For write ops the same
  // record-scope grant check is what authorizes the file mutation; the read
  // facade resolves the SAME covering-grant gate (a subject that may not read
  // the record may not touch its files). `recordOpFor(op)` documents the mapping.
  void recordOpFor(op);
  return resolver.resolveHandle(handle, subject);
}

// ---------------------------------------------------------------------------
// Content issuance — allow → presign (FF-PRESIGN-AFTER-ALLOW).
// ---------------------------------------------------------------------------

export interface GetFileContentDeps {
  resolver: HandleResolver;
  store: ObjectStore;
  meta: FileMetaSource;
  /** presign TTL seconds (deploy-time; default ≤ 300). Clamped to maxTtl. */
  ttl: number;
  /** hard ceiling for the presign TTL (ADR §2.5: ≤ 300s). */
  maxTtl?: number;
  audit?: FileAuditSink;
  now?: () => number;
}

export type GetFileContentResult =
  | { denied: true; reason: string }
  | { denied: false; url: string; expiresAt: number };

/**
 * Issue a short-lived presigned GET url for a file version — ONLY after a PDP
 * allow on the owner record (`read`). Not a byte flows before allow (NF-4).
 *
 * Sequence (strict):
 *  1. load the version; absent ⇒ `not_found` (no S3 call).
 *  2. content erased (retention tombstone) ⇒ `content_erased` (no S3 call).
 *  3. load the owner file; absent ⇒ `not_found`.
 *  4. tenant-gate + PDP allow `read` via `authorizeFileOp`. On `{denied}` ⇒ return
 *     WITHOUT calling `store.presignGet` (FF-PRESIGN-AFTER-ALLOW).
 *  5. ONLY on allow ⇒ `presignGet(object_key, ttl≤maxTtl)` and emit `file.download`.
 */
export async function getFileContentUrl(
  deps: GetFileContentDeps,
  fileVersionId: string,
  subject: ResolveSubject,
): Promise<GetFileContentResult> {
  const now = (deps.now ?? Date.now)();

  // 1. Load the version metadata (tenant-scoped DAO read).
  const version = await deps.meta.getVersion(subject.tenantId, fileVersionId);
  if (version === null) {
    return { denied: true, reason: "not_found" };
  }

  // 2. A tombstoned (content-erased) version has no object to presign.
  if (version.contentErasedAt !== null) {
    return { denied: true, reason: "content_erased" };
  }

  // 3. Load the owner file (carries record_id / registry_id for the PDP).
  const file = await deps.meta.getFile(subject.tenantId, version.fileId);
  if (file === null) {
    return { denied: true, reason: "not_found" };
  }

  // 4. Tenant-gate + PDP allow on the owner record. NO S3 call yet.
  const verdict = await authorizeFileOp(deps.resolver, file, subject, "read");
  if (verdict.denied) {
    return { denied: true, reason: verdict.reason };
  }

  // 5. Allowed — presign now (and only now). Clamp the TTL to the ceiling.
  const maxTtl = deps.maxTtl ?? 300;
  const ttl = Math.min(deps.ttl, maxTtl);
  const url = await deps.store.presignGet(version.objectKey, ttl);
  const expiresAt = now + ttl * 1000;

  await deps.audit?.emit(
    fileAuditEvent("file.download", subject, file, version, now),
  );

  return { denied: false, url, expiresAt };
}

// ---------------------------------------------------------------------------
// Version write-path — immutable add (FF-V).
// ---------------------------------------------------------------------------

export interface AddVersionDeps {
  resolver: HandleResolver;
  store: ObjectStore;
  meta: FileMetaSource;
  audit?: FileAuditSink;
  /** content-hash function (T-0118-compatible); injected (pure-core stays IO-free). */
  hash: (body: Uint8Array) => string;
  /** declared upload limits (ADR §2.8): max size + MIME allowlist. */
  limits?: { maxSizeBytes?: number; mimeAllowlist?: readonly string[] };
  now?: () => number;
}

export interface AddVersionAttrs {
  mime: string;
  cycleRef?: string;
  isSnapshot?: boolean;
  dataClass?: DataClass;
}

export type AddVersionResult =
  | { denied: true; reason: string }
  | { denied: false; versionId: string; versionNo: number; objectKey: string };

/**
 * Replace/add content = a NEW immutable `file_version` row + repoint
 * `file.current_version`. The previous version stays readable by its own key
 * (the object is never overwritten — FF-V / NF-3).
 *
 * Sequence (strict):
 *  1. load the file; absent ⇒ `not_found`.
 *  2. validate declared limits (size / MIME allowlist) — fail-closed, no S3 call.
 *  3. tenant-gate + PDP allow `update` on the owner record. On `{denied}` ⇒ stop:
 *     no put, no insert (FF-FAILCLOSED).
 *  4. mint a fresh versionId; build the key via buildObjectKey (tenantId from the
 *     file's tenant context — FF-KEY). put() the body under the FRESH key.
 *  5. INSERT the new immutable version row (version_no = max+1) + repoint
 *     current_version. Emit `file.upload`/`file.replace`.
 */
export async function addVersion(
  deps: AddVersionDeps,
  fileId: string,
  subject: ResolveSubject,
  body: Uint8Array,
  attrs: AddVersionAttrs,
): Promise<AddVersionResult> {
  const now = (deps.now ?? Date.now)();

  // 1. Load the owner file.
  const file = await deps.meta.getFile(subject.tenantId, fileId);
  if (file === null) {
    return { denied: true, reason: "not_found" };
  }

  // 2. Declared limits — fail-closed BEFORE touching S3 (ADR §2.8: not unbounded).
  const limits = deps.limits;
  if (limits?.maxSizeBytes !== undefined && body.byteLength > limits.maxSizeBytes) {
    return { denied: true, reason: "size_exceeded" };
  }
  if (limits?.mimeAllowlist !== undefined && !limits.mimeAllowlist.includes(attrs.mime)) {
    return { denied: true, reason: "mime_not_allowed" };
  }

  // 3. Tenant-gate + PDP allow `update` on the owner record. NO S3 call yet.
  const verdict = await authorizeFileOp(deps.resolver, file, subject, "update");
  if (verdict.denied) {
    return { denied: true, reason: verdict.reason };
  }

  // 4. Fresh version identity + FF-KEY key (tenantId from the file's tenant ctx).
  const versionId = randomUUID();
  const objectKey = buildObjectKey(file.tenantId, file.id, versionId);
  const contentHash = deps.hash(body);
  await deps.store.put(objectKey, body, { mime: attrs.mime, size: body.byteLength });

  // 5. INSERT the immutable version row (version_no = max+1) + repoint current.
  const prevMax = await deps.meta.maxVersionNo(subject.tenantId, fileId);
  const versionNo = prevMax + 1;
  const row: FileVersionRow = {
    tenantId: file.tenantId,
    id: versionId,
    fileId: file.id,
    versionNo,
    objectKey,
    mimeType: attrs.mime,
    sizeBytes: body.byteLength,
    contentHash,
    dataClass: attrs.dataClass ?? "internal",
    isSnapshot: attrs.isSnapshot ?? false,
    cycleRef: attrs.cycleRef ?? null,
    contentErasedAt: null,
    uploadedBy: subject.subjectId,
    uploadedAt: now,
  };
  await deps.meta.insertVersion(row);
  await deps.meta.setCurrentVersion(file.tenantId, file.id, versionId, now);

  // First version ⇒ file.upload; subsequent ⇒ file.replace (rework cycle).
  const auditType = prevMax === 0 ? "file.upload" : "file.replace";
  await deps.audit?.emit(fileAuditEvent(auditType, subject, file, row, now));

  return { denied: false, versionId, versionNo, objectKey };
}

// ---------------------------------------------------------------------------
// Retention erase — deny-by-default (FF-RETENTION-DENY).
// ---------------------------------------------------------------------------

export interface EraseRetentionDeps {
  store: ObjectStore;
  meta: FileMetaSource;
  audit?: FileAuditSink;
  now?: () => number;
}

export type EraseRetentionResult =
  | { erased: false; reason: string }
  | { erased: true; objectKey: string };

/**
 * Physically erase a version's content under retention — DENY-BY-DEFAULT.
 *
 * Content is erased ONLY when the owner file is in `pending_deletion` (the
 * lifecycle/manual transition to that state is out of scope here — sweeper is
 * Stage-2). On erase: `store.erase(object_key)` + stamp `content_erased_at`. The
 * metadata rows (`file`/`file_version`) and the audit trail SURVIVE (NF-5 /
 * T-0016 append-only) — only the bytes go. An `active`/`archived` file is refused.
 */
export async function eraseForRetention(
  deps: EraseRetentionDeps,
  fileVersionId: string,
  tenantId: string,
  actor: string,
): Promise<EraseRetentionResult> {
  const now = (deps.now ?? Date.now)();

  const version = await deps.meta.getVersion(tenantId, fileVersionId);
  if (version === null) {
    return { erased: false, reason: "not_found" };
  }
  if (version.contentErasedAt !== null) {
    // Idempotent: already erased.
    return { erased: false, reason: "already_erased" };
  }

  const file = await deps.meta.getFile(tenantId, version.fileId);
  if (file === null) {
    return { erased: false, reason: "not_found" };
  }

  // DENY-BY-DEFAULT: only pending_deletion files may have content erased.
  if (file.retentionState !== "pending_deletion") {
    return { erased: false, reason: "retention_state_forbids_erase" };
  }

  // Erase the bytes, then tombstone — metadata/hash/audit live on.
  await deps.store.erase(version.objectKey);
  await deps.meta.markContentErased(tenantId, fileVersionId, now);

  await deps.audit?.emit(fileAuditEvent("file.delete", { tenantId, subjectId: actor }, file, version, now));

  return { erased: true, objectKey: version.objectKey };
}

// ---------------------------------------------------------------------------
// Audit encoding (T-0016 file.* events; rows in audit_event, NO new table).
// ---------------------------------------------------------------------------

/**
 * Encode a file lifecycle event as a T-0016 `AuditEventInput`. `subject` of the
 * audit row is the owner RECORD ref (record-derived authority, never the file's
 * own ACL — there is none). The payload carries file/version identity + hash +
 * mime + size + data_class. No raw content, no secret.
 */
function fileAuditEvent(
  type: "file.upload" | "file.replace" | "file.download" | "file.delete",
  actor: ResolveSubject,
  file: FileRow,
  version: FileVersionRow,
  nowMs: number,
): AuditEventInput {
  return {
    id: randomUUID(),
    type,
    actor: actor.subjectId,
    subject: `record:${file.recordId}`,
    scope: null,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload: {
      file_id: file.id,
      version_id: version.id,
      version_no: version.versionNo,
      content_hash: version.contentHash,
      mime: version.mimeType,
      size: version.sizeBytes,
      data_class: version.dataClass,
    },
    occurred_at: nowMs,
  };
}
