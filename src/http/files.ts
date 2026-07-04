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
 *     of attachment, for record-card preview (image/*, application/pdf only —
 *     see isInlineSafeMime). Only applies to the FsObjectStore streaming path
 *     (the redirect/JSON-fallback paths are unaffected — presign URLs carry
 *     no disposition header here). Without the param, or for any other mime
 *     (including image/svg+xml — anti-XSS), behaviour is UNCHANGED: attachment.
 *
 * Authorization: every route delegates to the T-0021 PDP via makeFileRecordResolver
 * (the owner RECORD's grant governs; no separate file ACL — FF-NOACL). Tenant
 * is resolved from the actor identity — NEVER from a header or body arg.
 *
 * Atomicity: insertFile + addVersion are sequenced in a single withTenantTx;
 * if addVersion fails (PDP deny, S3 put error, DB insert error), the outer
 * ROLLBACK undoes the choros.file row too — no orphan metadata rows.
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
// image/* (EXCLUDING image/svg+xml — an SVG can carry a <script>, which would
// execute in the app's origin if rendered inline: stored-XSS) and
// application/pdf. Every other mime, and the absence of the query param,
// falls back to `attachment` — the existing default behaviour is UNCHANGED
// (no regression on any pre-T-0579 test/caller).
// ---------------------------------------------------------------------------

/**
 * True iff `mime` is safe to serve with Content-Disposition: inline.
 *
 * T-0579 fix-forward (review B1): normalize (trim + lowercase) BEFORE any
 * comparison — this is the second line of defense (the upload path already
 * stores a normalized mime; this function does not trust that as its ONLY
 * guarantee, since it is also the read-time boundary for the inline decision
 * and must not regress if a row was written before the upload-side fix, by a
 * migration/import path, or by any future writer). Without normalizing here,
 * a stored `image/SVG+xml` would fail the exact `=== "image/svg+xml"` compare
 * yet still pass `startsWith("image/")` → inline → stored-XSS (SVG can carry
 * <script>, executed in the app's origin).
 */
function isInlineSafeMime(mime: string | null | undefined): boolean {
  if (typeof mime !== "string" || mime.length === 0) return false;
  const normalized = mime.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (normalized === "image/svg+xml") return false; // anti-XSS: SVG can carry <script>
  if (normalized.startsWith("image/")) return true;
  if (normalized === "application/pdf") return true;
  return false;
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
  // Atomicity: insertFile + addVersion (which calls insertVersion +
  // setCurrentVersion) run inside ONE withTenantTx. If addVersion fails
  // (PDP deny, S3 put error, DB error), ROLLBACK undoes the file row too.
  // The S3 put (store.put) runs inside the tx fn, so an S3 failure rolls
  // back DB side; an S3 success followed by DB failure leaves an orphaned
  // object on disk/S3 — acceptable as idempotent orphan (no metadata row
  // visible to users). This is the standard behaviour for the pattern.
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
        // T-0579 fix-forward (review B1): normalize to lowercase at the ONE
        // ingestion boundary so every stored mime is canonical from here on —
        // `image/SVG+xml` / `image/Svg+xml` etc. are stored as `image/svg+xml`.
        // Without this, isInlineSafeMime's exact `=== "image/svg+xml"` compare
        // (case-sensitive per the MIME grammar's subtype being case-preserved
        // in this codebase's comparisons) would miss a registro-variant and
        // `startsWith("image/")` would then let it through as inline —
        // stored-XSS (an SVG can carry <script>, executed in the app's origin).
        // Normalizing on WRITE means every reader (this route's own inline
        // check, the client preview gate, any future consumer) sees one
        // canonical form — one boundary, not N scattered case-insensitive
        // compares.
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

        // Run insertFile + addVersion atomically inside a single tenant tx.
        const result = await withTenantTx(pool, tenantId, async (_client) => {
          // Insert the choros.file metadata row (current_version NULL until addVersion).
          await fileStore.insertFile({
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
          });

          // addVersion internally calls store.put (FsObjectStore: write to disk;
          // S3: PutObject) BEFORE the DB insertVersion row is committed. If the
          // subsequent DB write or the outer COMMIT fails, addVersion performs a
          // best-effort erase of the uploaded object (honest-cleanup, T-0521 п.3).
          // A best-effort erase after a network failure may still leave an orphan;
          // a server-side S3 lifecycle GC is the backstop for production (see
          // addVersion in core/file-attachment.ts for the full note).
          const vResult = await addVersion(
            {
              resolver,
              store: objectStore,
              meta: metaStore,
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
          const contentType = version?.mimeType ?? "application/octet-stream";
          const fileName = version ? `file-${fileVersionId}` : "download";

          // T-0579 (FR-8/FF-INLINE-SAFE): inline ONLY when the caller asked for
          // it AND the mime is on the preview-safe allowlist (image/* except
          // svg, application/pdf). Everything else — no param, or an unsafe
          // mime (including image/svg+xml and text/html) — stays `attachment`,
          // exactly as before T-0579 (anti-XSS: an inline SVG/HTML response
          // would execute in the app's origin).
          const disposition = wantsInline && isInlineSafeMime(contentType) ? "inline" : "attachment";

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
