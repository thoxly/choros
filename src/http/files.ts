/**
 * src/http/files.ts — T-0518
 *
 * HTTP layer for file attachments on top of the existing core/DB/adapters.
 *
 * Routes:
 *   POST /api/records/:recordId/files
 *     Upload a new file (raw bytes) and attach it to a record. Resolves actor
 *     + tenant, inserts a choros.file row + first version via addVersion.
 *     Returns 201 { fileId, versionId, versionNo }.
 *
 *   GET /api/records/:recordId/files
 *     List all files attached to a record (tenant-scoped, read-gated).
 *     Returns [{ fileId, originalName, currentVersionId, versionIds, mime,
 *     sizeBytes, createdAt }]. versionIds (T-0579 fix-forward, review m1) is
 *     EVERY version id the file has ever had (not just the current one) — a
 *     field's stored value is whatever fileVersionId was captured at upload
 *     time, and a later re-upload advances currentVersionId while the OLD
 *     value remains a legitimate historical version; callers resolving a
 *     value to a display name must match against the full set.
 *
 *   GET /api/files/:fileVersionId/download[?disposition=inline]
 *     Presign or stream the content of a specific file version (PDP read-gated).
 *     - FsObjectStore: streams bytes directly from disk.
 *     - http(s) presign url (S3): 302 redirect.
 *     T-0579: ?disposition=inline requests Content-Disposition: inline instead
 *     of attachment, for record-card preview (a POSITIVE allowlist of
 *     concrete-safe image subtypes + application/pdf only — see
 *     isInlineSafeMime / INLINE_SAFE_IMAGE_SUBTYPES). Only applies to the
 *     FsObjectStore streaming path (the redirect/JSON-fallback paths are
 *     unaffected — presign URLs carry no disposition header here). Without
 *     the param, or for any mime not on the allowlist (including
 *     image/svg+xml, image/svg, and any parameterized variant of either —
 *     anti-XSS), behaviour is UNCHANGED: attachment.
 *
 * Authorization: every route delegates to the T-0021 PDP via makeFileRecordResolver
 * (the owner RECORD's grant governs; no separate file ACL — FF-NOACL). Tenant
 * is resolved from the actor identity — NEVER from a header or body arg.
 *
 * Atomicity: insertFile + addVersion are sequenced in a single withTenantTx AND
 * (T-0621) both actually RUN on that transaction's `pg.PoolClient` — insertFile
 * is called with the client as its explicit executor, and addVersion is handed
 * `fileStore.boundTo(client)` as its `meta` (not the plain fileStore), so every
 * DAO call addVersion makes internally (getFile/maxVersionNo/insertVersion/
 * setCurrentVersion) also runs on that same client. If addVersion fails (PDP
 * deny, S3 put error, DB insert error) the outer ROLLBACK now undoes the
 * ENTIRE sequence — no DML above it has committed independently on a separate
 * connection, so no orphan metadata row can survive a mid-way failure of any
 * kind (PDP deny — T-0620 — or a genuine mid-transaction DB error — T-0621).
 */

import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { HttpError, readRawBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import {
  addVersion,
  getFileContentUrl,
  type ObjectStore,
  type FileMetaSource,
  type FileRecordResolver,
} from "../core/file-attachment.js";
import { makeHandle, type ResourceRef } from "../core/object-handle.js";
import type { PgFileStore } from "../core/postgres/pgFileStore.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

/** Default max upload size = 25 MiB (same as readRawBody default). */
const MAX_UPLOAD_BYTES = 26_214_400;

/** Presign TTL in seconds (served or redirected). */
const PRESIGN_TTL_SECONDS = 300;

// ---------------------------------------------------------------------------
// T-0579: inline-disposition allowlist (FR-8 / FF-INLINE-SAFE)
//
// GET /api/files/:fileVersionId/download?disposition=inline requests an inline
// Content-Disposition (browser renders instead of downloads — needed for the
// record-card preview, ADR §2.7). Only preview-SAFE mime types are honoured:
// a POSITIVE allowlist of concrete safe image subtypes (png/jpeg/gif/webp)
// and application/pdf. Every other mime — including any image/* NOT on the
// allowlist (svg, svg+xml, and any future/unknown SVG-like subtype) — and the
// absence of the query param, falls back to `attachment` — the existing
// default behaviour is UNCHANGED (no regression on any pre-T-0579 test/caller).
// ---------------------------------------------------------------------------

/**
 * Concrete image subtypes safe to render inline. Deliberately a POSITIVE
 * allowlist (not "image/* except svg"): SVG can carry a <script> that would
 * execute in the app's origin if rendered inline (stored-XSS), and a single
 * negative exception for "image/svg+xml" misses siblings like "image/svg"
 * (no +xml suffix) or any future SVG-like/unknown subtype. Enumerating the
 * SAFE subtypes instead means anything not explicitly known-safe is denied
 * by construction — no new image subtype can silently become inline-eligible.
 */
const INLINE_SAFE_IMAGE_SUBTYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * True iff `mime` is safe to serve with Content-Disposition: inline.
 *
 * T-0579 fix-forward (review B1): normalize (trim + lowercase) BEFORE any
 * comparison — this is the second line of defense (the upload path already
 * stores a normalized mime; this function does not trust that as its ONLY
 * guarantee, since it is also the read-time boundary for the inline decision
 * and must not regress if a row was written before the upload-side fix, by a
 * migration/import path, or by any future writer).
 *
 * T-0579 fix-forward (review B1-residual, blocking): normalizing case/
 * whitespace alone is NOT enough — a stored mime carrying a parameter
 * (`image/svg+xml;charset=utf-8`, `image/svg+xml;x=1`) survives
 * trim()+toLowerCase() as `image/svg+xml;charset=utf-8`, which fails the
 * exact `=== "image/svg+xml"` compare yet still passes a bare
 * `startsWith("image/")` check → inline → stored-XSS. Separately, a stored
 * `image/svg` (no `+xml` suffix at all) was never excluded by that single
 * negative check in the first place — browsers still treat it as SVG. Both
 * gaps are closed at once by (a) stripping the `;param` suffix at the
 * comparison boundary and (b) switching from a negative svg-exclusion to a
 * POSITIVE allowlist of concrete safe image subtypes — see
 * INLINE_SAFE_IMAGE_SUBTYPES above.
 */
function isInlineSafeMime(mime: string | null | undefined): boolean {
  if (typeof mime !== "string" || mime.length === 0) return false;
  // Strip any `;charset=...`/`;x=1`/etc parameter BEFORE comparing — the
  // media-type token itself is everything before the first ';'.
  const base = mime.trim().toLowerCase().split(";")[0]!.trim();
  if (base.length === 0) return false;
  if (INLINE_SAFE_IMAGE_SUBTYPES.has(base)) return true;
  if (base === "application/pdf") return true;
  return false;
}

// ---------------------------------------------------------------------------
// T-0618: Content-Type read-time sanitization (setHeader-safety, NOT XSS gate)
//
// The stored mime (choros.file_version.mime_type) is read back here and
// handed to res.setHeader('Content-Type', ...). Node's http.ServerResponse
// throws ERR_INVALID_CHAR synchronously if the header value contains any
// control byte (0x00-0x1F, 0x7F) — verified: setHeader('Content-Type',
// 'text/plain\x00evil') throws "Invalid character in header content". The
// upload route (POST /files) normalizes Content-Type from the HTTP header
// before storing, so this isn't reachable through that writer today — but
// core/file-attachment.ts::addVersion accepts attrs.mime as an arbitrary
// string with no byte-level validation (only an optional mimeAllowlist,
// unset for most callers), so ANY other writer (document-render.ts today;
// a future seed/import/migration path tomorrow) can store a mime containing
// control bytes. Today that would crash the download route with a 500
// instead of serving the file — fail-closed for XSS (no XSS surface from a
// header the browser never receives usably) but a needless availability
// bug. sanitizeContentType applies the SAME read-time-boundary discipline
// as isInlineSafeMime (T-0579): never trust only the writer, re-validate on
// read, and fall back to a safe, well-known default rather than throw.
// ---------------------------------------------------------------------------

/** Maximum length for a Content-Type header value we'll pass through as-is. */
const MAX_CONTENT_TYPE_LENGTH = 4096;

/**
 * Matches ANY control byte (0x00-0x1F, 0x7F) — the exact range Node's HTTP
 * header validation rejects. A mime containing one of these cannot be set
 * as a header value at all; passing it to setHeader throws ERR_INVALID_CHAR.
 */
const CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;

/**
 * Returns `mime` unchanged if it is safe to pass to
 * `res.setHeader('Content-Type', ...)` as-is; otherwise returns the safe
 * default `application/octet-stream`.
 *
 * This is NOT the XSS allowlist (that's isInlineSafeMime) — it exists purely
 * so a malformed/control-byte stored mime degrades to a safe default
 * download instead of crashing the response with ERR_INVALID_CHAR (500).
 * Every mime that passes today's tests (text/plain, image/png,
 * application/pdf, image/svg+xml, etc.) is untouched — this only catches
 * bytes that were never valid HTTP header content in the first place.
 */
function sanitizeContentType(mime: string | null | undefined): string {
  const fallback = "application/octet-stream";
  if (typeof mime !== "string" || mime.length === 0) return fallback;
  if (mime.length > MAX_CONTENT_TYPE_LENGTH) return fallback;
  if (CONTROL_BYTE_RE.test(mime)) return fallback;
  return mime;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface FileRoutesDeps {
  pool: pg.Pool;
  /** Postgres-backed metadata store (insertFile + FileMetaSource). */
  fileStore: PgFileStore;
  /** Object storage for binary content (put / presignGet / erase). */
  objectStore: ObjectStore;
  /** File-to-record PDP resolver. */
  resolver: FileRecordResolver;
  resolveActorTenant: (actorSlug: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// withTenantTx — canonical RLS pattern (mirrors records.ts)
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
// extractActor — mirrors records.ts extractActor
// ---------------------------------------------------------------------------

async function extractActor(req: IncomingMessage, pool: pg.Pool): Promise<string> {
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
// sha256 — content hash (mirrors bundle-commit-store.ts)
// ---------------------------------------------------------------------------

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// loadRecordRegistryId — the owner record's registry_id, tenant-scoped.
//
// T-0620: the upload write pre-check builds a `record` ResourceRef, which needs
// the owner record's registry_id (the PDP keys the record scope on recordId;
// registryId is the structural sibling the ref type requires). Read it under a
// tenant tx (SET LOCAL choros.tenant_id + RLS). Returns null when the record is
// not visible in this tenant (cross-tenant / absent) → the caller treats that as
// a deny WITHOUT inserting any file row (no orphan, no existence leak).
// ---------------------------------------------------------------------------

async function loadRecordRegistryId(
  pool: pg.Pool,
  tenantId: string,
  recordId: string,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{ registry_id: string }>(
      `SELECT registry_id FROM choros.record WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, recordId],
    );
    await client.query("COMMIT");
    return rows.length > 0 ? rows[0]!.registry_id : null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// registerFileRoutes
// ---------------------------------------------------------------------------

export function registerFileRoutes(router: Router, deps: FileRoutesDeps): void {
  const { pool, fileStore, objectStore, resolver, resolveActorTenant } = deps;
  // fileStore implements FileMetaSource (read ops: getFile/getVersion/maxVersionNo/etc.)
  const metaStore: FileMetaSource = fileStore;

  // -------------------------------------------------------------------------
  // POST /api/records/:recordId/files
  //
  // Upload a file and attach it to a record.
  //   Body    : raw bytes
  //   Headers : Content-Type → mime (defaults to application/octet-stream)
  //             X-File-Name  → original filename (defaults to "upload")
  //   Returns : 201 { fileId, versionId, versionNo }
  //
  // Orphan-free authz (T-0620): the write authority is decided BEFORE any DB
  // write (loadRecordRegistryId → resolver.resolveRecordOp(record, "update")).
  // On deny → 403 and insertFile is NEVER called, so no orphan choros.file row
  // can exist (before T-0620 the deny fired INSIDE addVersion, AFTER insertFile
  // had already autocommitted on its own PgFileStore connection — the tx's
  // ROLLBACK could not undo it, leaving a current_version=NULL orphan). On allow,
  // insertFile + addVersion run and, on the success path, commit file + version
  // together. The S3 put (store.put) happens inside addVersion; an S3 success
  // followed by a DB write failure leaves an orphaned OBJECT on disk/S3 (no
  // metadata row) — addVersion best-effort erases it, and a server-side S3
  // lifecycle GC is the production backstop (see core/file-attachment.ts).
  // -------------------------------------------------------------------------
  router.register(
    "POST",
    "/api/records/:recordId/files",
    withAuth(
      async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
      ) => {
        const actor = await extractActor(req, pool);
        const tenantId = await resolveActorTenant(actor);

        const recordId = params["recordId"] ?? "";
        assertUuidShape(recordId, "recordId");

        // Read raw body (enforces 25 MiB cap).
        const bodyBuf = await readRawBody(req, MAX_UPLOAD_BYTES);

        // Derive mime from Content-Type; strip parameters (e.g. ; charset=...).
        // T-0579 fix-forward (review B1): normalize to lowercase at this
        // ingestion boundary so every stored mime is canonical from here on —
        // `image/SVG+xml` / `image/Svg+xml` etc. are stored as `image/svg+xml`.
        // Normalizing (and stripping params) on WRITE is defense-in-depth, not
        // the only guarantee: this is ONE writer among several (see
        // src/core/document-render.ts's addVersion calls for text/html etc,
        // plus any future seed/import/migration path) — isInlineSafeMime
        // itself MUST re-normalize and re-strip params on READ regardless of
        // what any writer stored (review B1-residual), and gates on a
        // POSITIVE allowlist of concrete-safe subtypes rather than a negative
        // svg-exclusion, so an unnormalized/un-stripped/unknown-subtype mime
        // is denied by construction rather than by an exhaustive blocklist.
        const rawCt = req.headers["content-type"] ?? "application/octet-stream";
        const mime = (rawCt.split(";")[0] ?? "").trim().toLowerCase() || "application/octet-stream";

        // Original name from X-File-Name header.
        let xFileName = req.headers["x-file-name"];
        if (Array.isArray(xFileName)) xFileName = xFileName[0];
        const originalName =
          typeof xFileName === "string" && xFileName.length > 0
            ? xFileName
            : "upload";

        const fileId = randomUUID();
        const now = Date.now();

        // T-0620 [P0/orphan-fix]: AUTHORIZE THE WRITE **BEFORE** insertFile.
        //
        // Historical note (fixed by T-0621, kept for context): at the time this
        // pre-check was written, PgFileStore.insertFile/insertVersion/
        // setCurrentVersion each ran on their OWN pooled connection
        // (this.pool.query), NOT on the withTenantTx client — so they autocommitted
        // independently and the tx's ROLLBACK could not undo the insertFile row. A
        // deny that fired INSIDE addVersion (after insertFile) therefore left an
        // orphan choros.file row (current_version=NULL, 0 versions) regardless of
        // any throw. T-0621 closed that residual gap by threading the SAME tx
        // client through insertFile + every DAO call addVersion makes (see the
        // withTenantTx callback below and PgFileStore.boundTo) — so a genuine
        // mid-transaction DB error now also rolls back cleanly, not just a PDP
        // deny. This pre-check below remains valuable independently of that fix:
        // it avoids taking a DB write at all on the (common) deny path, and keeps
        // the write-authority decision explicit and up front.
        //
        // The fix (T-0620): decide the write authority up front, on the OWNER
        // RECORD, via the SAME resolver addVersion would consult (authorizeFileOp
        // maps upload→`update` on the record). On deny we return 403 and NEVER
        // call insertFile — zero orphan by construction. On allow we proceed;
        // addVersion re-checks the same authority (belt-and-suspenders) and, on
        // the success path, both agree.
        const reg = await loadRecordRegistryId(pool, tenantId, recordId);
        if (reg === null) {
          // Record not visible in this tenant → treat as a deny (no leak, no insert).
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "FORBIDDEN", reason: "not_found" } }));
          return;
        }
        const recordRef: ResourceRef = {
          kind: "record",
          tenantId,
          registryId: reg,
          recordId,
        };
        let writeHandle;
        try {
          writeHandle = makeHandle(recordRef, tenantId);
        } catch {
          // makeHandle throws only on a cross-tenant ref (unreachable here — tenant
          // is the actor's own) — treat defensively as a deny, no insert.
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "FORBIDDEN", reason: "cross_tenant" } }));
          return;
        }
        // Upload = a `update` op on the owner record (authorizeFileOp mapping).
        const writeVerdict = await resolver.resolveRecordOp(
          writeHandle,
          { tenantId, subjectId: actor },
          "update",
        );
        if (writeVerdict.denied) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "FORBIDDEN", reason: writeVerdict.reason } }));
          return;
        }

        // Authorized. Now insert the file + first version. (withTenantTx sets the
        // tenant GUC; the PgFileStore ops are tenant-scoped by explicit tenant_id.)
        //
        // T-0621 [P0/tx-atomicity]: insertFile AND every DAO call addVersion makes
        // (getFile/maxVersionNo/insertVersion/setCurrentVersion) now run on THIS
        // SAME tx `client` — not PgFileStore's own autocommitting `this.pool`
        // connection. `fileStore.insertFile(..., client)` passes the client as the
        // explicit executor; `fileStore.boundTo(client)` hands addVersion (which
        // only knows the pure-core `FileMetaSource` shape and is NOT allowed to
        // import `pg` — FF-PURE) a metadata-source VIEW that transparently runs
        // every call on `client` too. Before this fix each DAO op ran on a
        // separate pooled connection and autocommitted independently — a mid-way
        // DB error in insertVersion (thrown AFTER insertFile's row had already
        // committed on its own connection) left an orphan `choros.file` row that
        // this outer ROLLBACK could not undo (T-0620's pr-handoff named this
        // exact residual gap: "withTenantTx is cosmetic for PgFileStore"). Now a
        // throw anywhere in this callback rolls back the ENTIRE sequence — no DML
        // above this line has committed independently, so nothing survives.
        const result = await withTenantTx(pool, tenantId, async (client) => {
          const txMeta = fileStore.boundTo(client);

          // Insert the choros.file metadata row (current_version NULL until addVersion).
          await fileStore.insertFile(
            {
              tenantId,
              id: fileId,
              recordId,
              originalName,
              currentVersion: null,
              retentionState: "active",
              retentionPolicyRef: null,
              createdBy: actor,
              createdAt: now,
              updatedAt: now,
            },
            client,
          );

          // addVersion internally calls store.put (FsObjectStore: write to disk;
          // S3: PutObject) BEFORE the DB insertVersion row is committed. If the
          // subsequent DB write fails, addVersion best-effort erases the uploaded
          // object (honest-cleanup, T-0521 п.3); a server-side S3 lifecycle GC is
          // the production backstop (see addVersion in core/file-attachment.ts).
          // The authority was already granted above; addVersion re-checks it (same
          // resolver) and agrees on the success path. `meta: txMeta` (not the
          // plain `metaStore`) is what makes getFile/maxVersionNo/insertVersion/
          // setCurrentVersion below run on `client` instead of `fileStore`'s own
          // pool connection (T-0621).
          const vResult = await addVersion(
            {
              resolver,
              store: objectStore,
              meta: txMeta,
              hash: sha256,
            },
            fileId,
            { tenantId, subjectId: actor },
            new Uint8Array(bodyBuf),
            { mime },
          );
          return vResult;
        });

        if (result.denied) {
          // Defensive: the pre-check allowed but addVersion denied (should not happen
          // on the success path). Return 403 honestly — the file row's orphan window
          // is closed by the pre-check above (deny never reaches insertFile in the
          // normal path). This branch only triggers on a race/limit inside addVersion.
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "FORBIDDEN", reason: result.reason } }));
          return;
        }

        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            fileId,
            versionId: result.versionId,
            versionNo: result.versionNo,
          }),
        );
      },
    ),
  );

  // -------------------------------------------------------------------------
  // GET /api/records/:recordId/files
  //
  // List files attached to a record. Tenant-scoped via RLS (choros_app role
  // + SET LOCAL tenant_id). The read gate is the tenant boundary itself —
  // the actor must belong to the tenant owning the record (resolveActorTenant).
  // A per-file PDP read check would require a separate round-trip per file;
  // since file authz is DERIVED from the record (FF-NOACL), and the actor
  // already resolved to this tenant, the listing is tenant-scoped consistent
  // with the record's own read authz (the record-level grant is checked on
  // download individually via getFileContentUrl). The list surface is
  // metadata only — no bytes, no presign url.
  //
  // FF-NOACL by design — record-level metadata enumeration within a tenant is
  // intentional (intra-tenant). Cross-tenant boundary is enforced by the tenant
  // context derivation above (resolveActorTenant). Record-level read gating on
  // the list response is a founder policy decision (T-0521 п.1).
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/records/:recordId/files",
    withAuth(
      async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
      ) => {
        const actor = await extractActor(req, pool);
        const tenantId = await resolveActorTenant(actor);

        const recordId = params["recordId"] ?? "";
        assertUuidShape(recordId, "recordId");

        const files = await fileStore.listFilesByRecord(tenantId, recordId);

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(files));
      },
    ),
  );

  // -------------------------------------------------------------------------
  // GET /api/files/:fileVersionId/download
  //
  // Download or redirect to a file version's content.
  //
  // Authorization: getFileContentUrl → PDP `read` on owner record. On deny
  //   → 403. On not_found → 404.
  //
  // Content delivery:
  //   - FsObjectStore: presignGet returns `file://<abspath>?expires=<ms>`.
  //     We parse the path, create a read stream, and pipe it with the
  //     correct Content-Type and Content-Disposition headers.
  //   - http(s) presign url (S3/MinIO): 302 redirect.
  //
  // Expiry is NOT enforced on the file:// path (dev-only, short TTL, and
  // enforcement would require server-side state). S3 presign expiry is
  // enforced by the provider.
  // -------------------------------------------------------------------------
  router.register(
    "GET",
    "/api/files/:fileVersionId/download",
    withAuth(
      async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
      ) => {
        const actor = await extractActor(req, pool);
        const tenantId = await resolveActorTenant(actor);

        const fileVersionId = params["fileVersionId"] ?? "";
        assertUuidShape(fileVersionId, "fileVersionId");

        // T-0579: parse ?disposition=inline. Additive — absence of the param
        // (or any value other than "inline") preserves the exact prior
        // behaviour (attachment), so every existing caller/test is unaffected.
        const rawUrl = req.url ?? "";
        const qIdx = rawUrl.indexOf("?");
        const query = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");
        const wantsInline = query.get("disposition") === "inline";

        const urlResult = await getFileContentUrl(
          {
            resolver,
            store: objectStore,
            meta: metaStore,
            ttl: PRESIGN_TTL_SECONDS,
            maxTtl: PRESIGN_TTL_SECONDS,
          },
          fileVersionId,
          { tenantId, subjectId: actor },
        );

        if (urlResult.denied) {
          const statusCode =
            urlResult.reason === "not_found" || urlResult.reason === "content_erased"
              ? 404
              : 403;
          res.statusCode = statusCode;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({ error: { code: "FORBIDDEN", reason: urlResult.reason } }),
          );
          return;
        }

        const presignedUrl = urlResult.url;

        if (presignedUrl.startsWith("file://")) {
          // FsObjectStore path — stream bytes from the local filesystem.
          // URL format: file://<abspath>?expires=<ms>
          // Strip the file:// prefix and the query string to get the absolute path.
          const withoutScheme = presignedUrl.slice("file://".length);
          const qIdx = withoutScheme.indexOf("?");
          const absPath = qIdx === -1 ? withoutScheme : withoutScheme.slice(0, qIdx);

          // Look up mime from the version metadata (already loaded in getFileContentUrl
          // via deps.meta — we must re-load from metaStore because we don't have it here).
          // We do a second getVersion read; the version was already authorized above.
          const version = await metaStore.getVersion(tenantId, fileVersionId);
          const rawMime = version?.mimeType ?? "application/octet-stream";

          // T-0618: sanitize the stored mime BEFORE it ever reaches setHeader.
          // A mime with a control byte would otherwise throw ERR_INVALID_CHAR
          // inside setHeader below (uncaught → 500 instead of the file). This
          // is a setHeader-safety guard, NOT the XSS allowlist — see
          // sanitizeContentType's doc comment. wasSanitized tracks whether the
          // stored value was rejected, so we can force `attachment` below
          // regardless of ?disposition=inline (defense-in-depth: a mime that
          // couldn't even survive being a valid header value never gets to
          // ride the inline allowlist path).
          const contentType = sanitizeContentType(rawMime);
          const wasSanitized = contentType !== rawMime;
          const fileName = version ? `file-${fileVersionId}` : "download";

          // T-0579 (FR-8/FF-INLINE-SAFE): inline ONLY when the caller asked for
          // it AND the mime (param-stripped, case/whitespace-normalized) is on
          // the POSITIVE preview-safe allowlist (png/jpeg/gif/webp,
          // application/pdf). Everything else — no param, or a mime not on
          // that allowlist (including image/svg+xml, image/svg, any
          // `image/svg+xml;charset=...` variant, and text/html) — stays
          // `attachment`, exactly as before T-0579 (anti-XSS: an inline
          // SVG/HTML response would execute in the app's origin).
          //
          // T-0618: a sanitized (i.e. originally invalid/control-byte) mime
          // is NEVER eligible for inline, no matter what isInlineSafeMime
          // would say about the fallback "application/octet-stream" (it
          // isn't on the allowlist anyway, but this makes the invariant
          // explicit and independent of allowlist contents).
          const disposition =
            !wasSanitized && wantsInline && isInlineSafeMime(contentType)
              ? "inline"
              : "attachment";

          res.statusCode = 200;
          res.setHeader("Content-Type", contentType);
          res.setHeader(
            "Content-Disposition",
            `${disposition}; filename="${fileName}"`,
          );
          // Prevent browsers from MIME-sniffing the response and executing it
          // as a different content type (e.g. treating an octet-stream as HTML).
          res.setHeader("X-Content-Type-Options", "nosniff");

          const stream = createReadStream(absPath);
          stream.on("error", (_err) => {
            // Stream error after headers sent — close the connection.
            if (!res.headersSent) {
              res.statusCode = 500;
              res.end();
            } else {
              res.end();
            }
          });
          stream.pipe(res);
          return;
        }

        if (presignedUrl.startsWith("http://") || presignedUrl.startsWith("https://")) {
          // S3/MinIO presign — redirect.
          res.statusCode = 302;
          res.setHeader("Location", presignedUrl);
          res.end();
          return;
        }

        // mem:// or unknown scheme (test/dev in-memory store) — return the url directly.
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        // Nosniff on JSON fallback too — defence-in-depth; the file:// branch
        // already sets it, keep the header consistent across all download paths.
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.end(JSON.stringify({ url: presignedUrl, expiresAt: urlResult.expiresAt }));
      },
    ),
  );
}
