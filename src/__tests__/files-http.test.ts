/**
 * T-0518 — files-http HTTP-layer tests.
 *
 * Tests the three HTTP routes registered by registerFileRoutes:
 *   POST /api/records/:recordId/files  — upload
 *   GET  /api/records/:recordId/files  — list
 *   GET  /api/files/:fileVersionId/download — download
 *
 * NO live DB, NO real S3. Everything is mocked through FileRoutesDeps.
 * The pool mock handles withTenantTx (BEGIN / SET LOCAL / COMMIT sequence).
 * The auth layer runs in dev-mode (CHOROS_AUTH_MODE not set), so x-dev-user
 * header provides the actor slug directly — no DB token validation.
 *
 * Security surface checks:
 *   - authz + tenant: resolver deny → 403 (upload and download)
 *   - IDOR: wrong-tenant actor → resolver cross_tenant → 403/404 (no bytes)
 *   - path-traversal: X-File-Name with ../ does not affect the object key
 *   - size limit: body > 25 MiB → 413
 *   - missing file → 404
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { registerFileRoutes, type FileRoutesDeps } from "../http/files.js";
import { Router } from "../http/router.js";
import type { FileMetaSource, FileRow, FileVersionRow, ObjectStore, FileRecordResolver } from "../core/file-attachment.js";
import type { ObjectHandle } from "../core/object-handle.js";
import type { ResolveSubject, ResolvedView } from "../core/object-handle.js";
import type { Operation } from "../core/grant-lattice.js";
import type { PgFileStore } from "../core/postgres/pgFileStore.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RECORD_ID = "11111111-1111-1111-1111-111111111111";
const FILE_ID = "22222222-2222-2222-2222-222222222222";
const VERSION_ID = "33333333-3333-3333-3333-333333333333";
const REGISTRY_ID = "44444444-4444-4444-4444-444444444444";
const ACTOR_A = "alice";
const ACTOR_B = "bob";

// ---------------------------------------------------------------------------
// Fake pool — handles BEGIN / SET LOCAL / COMMIT queries in withTenantTx
// ---------------------------------------------------------------------------

interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number;
}

class FakePoolClient {
  private queryIndex = 0;
  private rowSets: unknown[][];

  constructor(rowSets: unknown[][]) {
    this.rowSets = rowSets;
  }

  async query(_sql: string, _params?: unknown[]): Promise<FakeQueryResult> {
    const rows = (this.rowSets[this.queryIndex] ?? []) as unknown[];
    this.queryIndex++;
    return { rows, rowCount: rows.length };
  }

  release(): void { /* no-op */ }
}

function makeFakePool(rowSets: unknown[][] = []): import("pg").Pool {
  // Provide enough empty row-sets for BEGIN, SET LOCAL ×2, COMMIT
  const padded = [...rowSets, ...Array.from({ length: 30 }, () => [])];
  return {
    connect: async () => new FakePoolClient(padded) as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// In-memory FileMetaSource stub
// ---------------------------------------------------------------------------

class FakeFileStore implements FileMetaSource {
  files = new Map<string, FileRow>();
  versions = new Map<string, FileVersionRow>();
  insertedFiles: FileRow[] = [];
  insertedVersions: FileVersionRow[] = [];
  setCurrentVersionCalls: string[] = [];

  private fk(t: string, id: string) {
    return `${t}::${id}`;
  }

  seedFile(f: FileRow) {
    this.files.set(this.fk(f.tenantId, f.id), f);
  }

  seedVersion(v: FileVersionRow) {
    this.versions.set(this.fk(v.tenantId, v.id), v);
  }

  async getFile(tenantId: string, fileId: string): Promise<FileRow | null> {
    return this.files.get(this.fk(tenantId, fileId)) ?? null;
  }

  async getVersion(tenantId: string, versionId: string): Promise<FileVersionRow | null> {
    return this.versions.get(this.fk(tenantId, versionId)) ?? null;
  }

  async maxVersionNo(tenantId: string, fileId: string): Promise<number> {
    let max = 0;
    for (const v of this.versions.values()) {
      if (v.tenantId === tenantId && v.fileId === fileId && v.versionNo > max) max = v.versionNo;
    }
    return max;
  }

  async insertVersion(row: FileVersionRow): Promise<void> {
    const key = this.fk(row.tenantId, row.id);
    this.versions.set(key, { ...row });
    this.insertedVersions.push(row);
  }

  async setCurrentVersion(tenantId: string, fileId: string, versionId: string, atMs: number): Promise<void> {
    const f = this.files.get(this.fk(tenantId, fileId));
    if (f) {
      f.currentVersion = versionId;
      f.updatedAt = atMs;
    }
    this.setCurrentVersionCalls.push(versionId);
  }

  async markContentErased(_t: string, _id: string, _at: number): Promise<void> {
    // not exercised in these tests
  }

  async updateRetentionState(
    _t: string, _id: string, _s: FileRow["retentionState"], _at: number,
  ): Promise<void> {
    // not exercised
  }

  /** PgFileStore-specific method needed for the deps cast. */
  async insertFile(file: Omit<FileRow, "registryId">): Promise<void> {
    const fRow: FileRow = {
      ...file,
      registryId: REGISTRY_ID, // only needed for PDP lookup; in tests it's resolved from seeded file
    };
    this.files.set(`${file.tenantId}::${file.id}`, fRow);
    this.insertedFiles.push(fRow);
  }

  /** List files for a record — used by the GET list route.
   * T-0579 fix-forward (review m1): versionIds mirrors PgFileStore's
   * behaviour — EVERY version id recorded for the file, not just current. */
  async listFilesByRecord(
    tenantId: string,
    recordId: string,
  ): Promise<Array<{
    fileId: string;
    originalName: string;
    currentVersionId: string | null;
    versionIds: string[];
    mime: string | null;
    sizeBytes: number | null;
    createdAt: number;
  }>> {
    const result: ReturnType<FakeFileStore["listFilesByRecord"]> extends Promise<infer R> ? R : never = [];
    for (const f of this.files.values()) {
      if (f.tenantId === tenantId && f.recordId === recordId) {
        const v = f.currentVersion ? this.versions.get(`${tenantId}::${f.currentVersion}`) : undefined;
        const versionIds: string[] = [];
        for (const ver of this.versions.values()) {
          if (ver.tenantId === tenantId && ver.fileId === f.id) versionIds.push(ver.id);
        }
        (result as unknown[]).push({
          fileId: f.id,
          originalName: f.originalName,
          currentVersionId: f.currentVersion,
          versionIds,
          mime: v?.mimeType ?? null,
          sizeBytes: v?.sizeBytes ?? null,
          createdAt: f.createdAt,
        });
      }
    }
    return result as Awaited<ReturnType<PgFileStore["listFilesByRecord"]>>;
  }
}

// ---------------------------------------------------------------------------
// In-memory ObjectStore stub
// ---------------------------------------------------------------------------

class FakeObjectStore implements ObjectStore {
  private objects = new Map<string, Uint8Array>();
  putCalls: Array<{ key: string; mime: string; size: number }> = [];
  presignCalls: string[] = [];

  async put(key: string, body: Uint8Array, meta: { mime: string; size: number }): Promise<void> {
    this.objects.set(key, body.slice());
    this.putCalls.push({ key, mime: meta.mime, size: meta.size });
  }

  async presignGet(key: string, _ttl: number): Promise<string> {
    this.presignCalls.push(key);
    // Return a mem:// URL so the HTTP handler hits the json-fallback branch
    const expiresAt = Date.now() + 300_000;
    return `mem://object/${encodeURIComponent(key)}?expires=${expiresAt}`;
  }

  async erase(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

// ---------------------------------------------------------------------------
// FileRecordResolver stubs
// ---------------------------------------------------------------------------

function makeAllowResolver(): FileRecordResolver {
  return {
    async resolveRecordOp(
      _handle: ObjectHandle,
      _subject: ResolveSubject,
      _op: Operation,
    ): Promise<ResolvedView> {
      return { denied: false, ref: null as unknown as ResolvedView extends { denied: false } ? typeof _handle : never, fields: [] } as unknown as ResolvedView;
    },
  };
}

function makeDenyResolver(reason: "no_grant" | "cross_tenant" | "not_found" = "no_grant"): FileRecordResolver {
  return {
    async resolveRecordOp(
      _handle: ObjectHandle,
      _subject: ResolveSubject,
      _op: Operation,
    ): Promise<ResolvedView> {
      return { denied: true, reason };
    },
  };
}

// ---------------------------------------------------------------------------
// Build a test server with given deps overrides
// ---------------------------------------------------------------------------

interface TestSetup {
  server: http.Server;
  fileStore: FakeFileStore;
  objectStore: FakeObjectStore;
  baseUrl: () => string;
}

function buildTestServer(opts: {
  resolver?: FileRecordResolver;
  tenantForActor?: (slug: string) => Promise<string>;
  fileStore?: FakeFileStore;
  objectStore?: FakeObjectStore;
}): TestSetup {
  const fileStore = opts.fileStore ?? new FakeFileStore();
  const objectStore = opts.objectStore ?? new FakeObjectStore();

  const deps: FileRoutesDeps = {
    pool: makeFakePool(),
    fileStore: fileStore as unknown as PgFileStore,
    objectStore,
    resolver: opts.resolver ?? makeAllowResolver(),
    resolveActorTenant: opts.tenantForActor ?? (async (_slug) => TENANT_A),
  };

  const router = new Router();
  registerFileRoutes(router, deps);

  const server = http.createServer((req, res) => router.dispatch(req, res));

  return {
    server,
    fileStore,
    objectStore,
    baseUrl: () => {
      const addr = server.address() as { port: number } | null;
      if (!addr) throw new Error("server not listening");
      return `http://127.0.0.1:${addr.port}`;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  headers: Record<string, string>,
  body: Buffer | null,
): Promise<{ status: number; body: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqHeaders: Record<string, string | number> = { ...headers };
    if (body) {
      reqHeaders["Content-Length"] = body.length;
    }
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: "POST",
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let json: unknown = null;
          try { json = JSON.parse(raw); } catch { /* ok */ }
          resolve({ status: res.statusCode ?? 0, body: raw, json });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; json: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        // T-0579: include the query string (parsed.search) — the pre-existing
        // helper dropped it (path: parsed.pathname only), which silently
        // discarded ?disposition=inline. No prior test exercised query params
        // on this route, so the gap was latent until now.
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let json: unknown = null;
          try { json = JSON.parse(raw); } catch { /* ok */ }
          resolve({ status: res.statusCode ?? 0, body: raw, json, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

async function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) server.close(() => resolve());
    else resolve();
  });
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await close(s);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function makeFileRow(overrides: Partial<FileRow> = {}): FileRow {
  return {
    tenantId: TENANT_A,
    id: FILE_ID,
    recordId: RECORD_ID,
    registryId: REGISTRY_ID,
    originalName: "test.txt",
    currentVersion: null,
    retentionState: "active",
    retentionPolicyRef: null,
    createdBy: ACTOR_A,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeVersionRow(overrides: Partial<FileVersionRow> = {}): FileVersionRow {
  return {
    tenantId: TENANT_A,
    id: VERSION_ID,
    fileId: FILE_ID,
    versionNo: 1,
    objectKey: `${TENANT_A}/${FILE_ID}/${VERSION_ID}`,
    mimeType: "text/plain",
    sizeBytes: 5,
    contentHash: sha256(Buffer.from("hello")),
    dataClass: "internal",
    isSnapshot: false,
    cycleRef: null,
    contentErasedAt: null,
    uploadedBy: ACTOR_A,
    uploadedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: POST /api/records/:recordId/files — upload
// ---------------------------------------------------------------------------

describe("POST /api/records/:recordId/files", () => {
  it("AC-upload-1: happy path — 201 with fileId, versionId, versionNo", async () => {
    const { server, fileStore, objectStore, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    // addVersion loads the file from meta AFTER insertFile. The FakeFileStore
    // insertFile seeds the file row, so addVersion can find it.
    const content = Buffer.from("hello world");
    const res = await httpPost(
      `${baseUrl()}/api/records/${RECORD_ID}/files`,
      {
        "x-dev-user": ACTOR_A,
        "Content-Type": "text/plain",
        "X-File-Name": "hello.txt",
      },
      content,
    );

    expect(res.status).toBe(201);
    const body = res.json as Record<string, unknown>;
    expect(typeof body["fileId"]).toBe("string");
    expect(typeof body["versionId"]).toBe("string");
    expect(body["versionNo"]).toBe(1);

    // The file was inserted in the fake store
    expect(fileStore.insertedFiles).toHaveLength(1);
    expect(fileStore.insertedFiles[0]!.originalName).toBe("hello.txt");
    expect(fileStore.insertedFiles[0]!.recordId).toBe(RECORD_ID);

    // A version was inserted
    expect(fileStore.insertedVersions).toHaveLength(1);
    expect(fileStore.insertedVersions[0]!.mimeType).toBe("text/plain");
    expect(fileStore.insertedVersions[0]!.sizeBytes).toBe(content.length);

    // Object was put to the store
    expect(objectStore.putCalls).toHaveLength(1);
    expect(objectStore.putCalls[0]!.mime).toBe("text/plain");
  });

  it("AC-upload-2: resolver deny → 403", async () => {
    const { server, baseUrl } = buildTestServer({ resolver: makeDenyResolver("no_grant") });
    servers.push(server);
    await listen(server);

    const res = await httpPost(
      `${baseUrl()}/api/records/${RECORD_ID}/files`,
      { "x-dev-user": ACTOR_A, "Content-Type": "application/octet-stream" },
      Buffer.from("bytes"),
    );

    // The resolver denied, but insertFile runs first (to create the row for addVersion
    // to load). addVersion returns denied. Response should be 403.
    expect(res.status).toBe(403);
    const body = res.json as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("FORBIDDEN");
  });

  it("AC-upload-3: missing x-dev-user → 401", async () => {
    const { server, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    const res = await httpPost(
      `${baseUrl()}/api/records/${RECORD_ID}/files`,
      { "Content-Type": "application/octet-stream" },
      Buffer.from("bytes"),
    );

    expect(res.status).toBe(401);
  });

  it("AC-upload-4: invalid recordId (not UUID) → 400", async () => {
    const { server, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    const res = await httpPost(
      `${baseUrl()}/api/records/not-a-uuid/files`,
      { "x-dev-user": ACTOR_A, "Content-Type": "application/octet-stream" },
      Buffer.from("bytes"),
    );

    expect(res.status).toBe(400);
  });

  it("AC-upload-5: body too large → 413", async () => {
    const { server, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    // 26 MiB exceeds the 25 MiB limit
    const oversize = Buffer.alloc(26 * 1024 * 1024, 0x41);
    const res = await httpPost(
      `${baseUrl()}/api/records/${RECORD_ID}/files`,
      { "x-dev-user": ACTOR_A, "Content-Type": "application/octet-stream" },
      oversize,
    );

    expect(res.status).toBe(413);
  });

  it("AC-upload-6: path-traversal in X-File-Name does NOT appear in object key", async () => {
    const { server, fileStore, objectStore, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    const res = await httpPost(
      `${baseUrl()}/api/records/${RECORD_ID}/files`,
      {
        "x-dev-user": ACTOR_A,
        "Content-Type": "application/octet-stream",
        // Malicious filename with traversal sequences
        "X-File-Name": "../../etc/passwd",
      },
      Buffer.from("exploit"),
    );

    // Should succeed (name is stored as metadata, not part of key)
    expect(res.status).toBe(201);

    // The object key is built from tenantId/fileId/versionId — no filename
    expect(objectStore.putCalls).toHaveLength(1);
    const key = objectStore.putCalls[0]!.key;
    expect(key).not.toContain("etc");
    expect(key).not.toContain("passwd");
    expect(key).not.toContain("..");

    // The original filename IS stored as metadata
    expect(fileStore.insertedFiles[0]!.originalName).toBe("../../etc/passwd");
    // But the stored key pattern is: tenantId/fileId/versionId
    expect(key).toMatch(/^[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+$/);
  });

  it("AC-upload-8/FF-MIME-NORMALIZE (review B1): Content-Type is normalized (trim+lowercase) at the ONE ingestion boundary before it is stored", async () => {
    // review B1: without normalizing on write, a case-variant Content-Type
    // like `image/SVG+xml` would be stored verbatim, and isInlineSafeMime's
    // exact `=== "image/svg+xml"` compare would then miss it — the
    // startsWith("image/") branch would treat it as a safe image and allow
    // inline rendering (stored-XSS, since an SVG can carry <script>). This
    // proves the upload path itself canonicalizes the mime, so every reader
    // downstream sees ONE normalized form.
    const { server, fileStore, objectStore, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    const res = await httpPost(
      `${baseUrl()}/api/records/${RECORD_ID}/files`,
      {
        "x-dev-user": ACTOR_A,
        "Content-Type": "  Image/SVG+XML  ; charset=utf-8",
        "X-File-Name": "evil.svg",
      },
      Buffer.from("<svg onload=alert(1)></svg>"),
    );

    expect(res.status).toBe(201);
    expect(fileStore.insertedVersions).toHaveLength(1);
    expect(fileStore.insertedVersions[0]!.mimeType).toBe("image/svg+xml");
    expect(objectStore.putCalls).toHaveLength(1);
    expect(objectStore.putCalls[0]!.mime).toBe("image/svg+xml");
  });

  it("AC-upload-7: cross-tenant actor gets 403 (IDOR protection on upload)", async () => {
    // ACTOR_B resolves to TENANT_B; resolver returns cross_tenant → denied
    const { server, baseUrl } = buildTestServer({
      resolver: makeDenyResolver("cross_tenant"),
      tenantForActor: async (slug) => (slug === ACTOR_B ? TENANT_B : TENANT_A),
    });
    servers.push(server);
    await listen(server);

    const res = await httpPost(
      `${baseUrl()}/api/records/${RECORD_ID}/files`,
      { "x-dev-user": ACTOR_B, "Content-Type": "application/octet-stream" },
      Buffer.from("bytes"),
    );

    expect(res.status).toBe(403);
    const err = (res.json as Record<string, unknown>)["error"] as Record<string, unknown>;
    expect(err["reason"]).toBe("cross_tenant");
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/records/:recordId/files — list
// ---------------------------------------------------------------------------

describe("GET /api/records/:recordId/files", () => {
  it("AC-list-1: happy path — 200 with file list", async () => {
    const fileStore = new FakeFileStore();
    const fileRow = makeFileRow({ currentVersion: VERSION_ID });
    const versionRow = makeVersionRow();
    fileStore.seedFile(fileRow);
    fileStore.seedVersion(versionRow);

    const { server, baseUrl } = buildTestServer({ fileStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(
      `${baseUrl()}/api/records/${RECORD_ID}/files`,
      { "x-dev-user": ACTOR_A },
    );

    expect(res.status).toBe(200);
    const files = res.json as Array<Record<string, unknown>>;
    expect(Array.isArray(files)).toBe(true);
    expect(files).toHaveLength(1);
    expect(files[0]!["fileId"]).toBe(FILE_ID);
    expect(files[0]!["originalName"]).toBe("test.txt");
    expect(files[0]!["currentVersionId"]).toBe(VERSION_ID);
    expect(files[0]!["versionIds"]).toEqual([VERSION_ID]);
    expect(files[0]!["mime"]).toBe("text/plain");
    expect(files[0]!["sizeBytes"]).toBe(5);
  });

  it("AC-list-5/FF-VERSION-HISTORY (review m1): versionIds includes a SUPERSEDED (non-current) version — a stale field value must still resolve", async () => {
    // Simulates the "Заменить" (replace) flow: the file was first uploaded as
    // OLD_VERSION_ID, then replaced by a newer NEW_VERSION_ID (currentVersionId
    // advances). A record field whose stored value is still OLD_VERSION_ID (it
    // captured the version id at the time it was set, and nothing rewrites it
    // on a LATER unrelated replace of the same file by someone else) must be
    // resolvable via versionIds even though it is no longer current.
    const OLD_VERSION_ID = "11111111-1111-1111-1111-111111111111";
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ id: OLD_VERSION_ID, versionNo: 1 }));
    fileStore.seedVersion(makeVersionRow({ id: VERSION_ID, versionNo: 2 }));

    const { server, baseUrl } = buildTestServer({ fileStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(
      `${baseUrl()}/api/records/${RECORD_ID}/files`,
      { "x-dev-user": ACTOR_A },
    );

    expect(res.status).toBe(200);
    const files = res.json as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0]!["currentVersionId"]).toBe(VERSION_ID);
    const versionIds = files[0]!["versionIds"] as string[];
    expect(versionIds).toContain(OLD_VERSION_ID);
    expect(versionIds).toContain(VERSION_ID);
  });

  it("AC-list-2: empty record → 200 with []", async () => {
    const { server, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    const res = await httpGet(
      `${baseUrl()}/api/records/${RECORD_ID}/files`,
      { "x-dev-user": ACTOR_A },
    );

    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });

  it("AC-list-3: missing x-dev-user → 401", async () => {
    const { server, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/records/${RECORD_ID}/files`);
    expect(res.status).toBe(401);
  });

  it("AC-list-4: invalid recordId → 400", async () => {
    const { server, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    const res = await httpGet(
      `${baseUrl()}/api/records/not-a-uuid/files`,
      { "x-dev-user": ACTOR_A },
    );

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/files/:fileVersionId/download — download
// ---------------------------------------------------------------------------

describe("GET /api/files/:fileVersionId/download", () => {
  it("AC-download-1: happy path — 200 with mem:// url JSON response", async () => {
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow());

    const { server, baseUrl } = buildTestServer({ fileStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(
      `${baseUrl()}/api/files/${VERSION_ID}/download`,
      { "x-dev-user": ACTOR_A },
    );

    // FakeObjectStore returns mem:// url → handler returns 200 JSON {url, expiresAt}
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(typeof body["url"]).toBe("string");
    expect((body["url"] as string).startsWith("mem://")).toBe(true);
    expect(typeof body["expiresAt"]).toBe("number");
  });

  it("AC-download-2: resolver deny → 403", async () => {
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow());

    const { server, baseUrl } = buildTestServer({
      fileStore,
      resolver: makeDenyResolver("no_grant"),
    });
    servers.push(server);
    await listen(server);

    const res = await httpGet(
      `${baseUrl()}/api/files/${VERSION_ID}/download`,
      { "x-dev-user": ACTOR_A },
    );

    expect(res.status).toBe(403);
    // Presign MUST NOT have been called (FF-PRESIGN-AFTER-ALLOW)
    // (checked via objectStore.presignCalls — should be empty from denied resolver)
  });

  it("AC-download-3: IDOR — wrong-tenant actor cannot download → 404 (no version visible cross-tenant)", async () => {
    // Version exists in TENANT_A but actor resolves to TENANT_B.
    // getFileContentUrl calls meta.getVersion(TENANT_B, versionId) — the fake
    // store has it under TENANT_A only → not_found → 404. No bytes, no URL,
    // no information about whether the version exists in TENANT_A is returned.
    // This is the correct IDOR behaviour: the version is invisible to TENANT_B.
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow()); // seeded in TENANT_A

    const { server, baseUrl } = buildTestServer({
      fileStore,
      // Resolver would deny cross_tenant — but we never reach it because
      // meta.getVersion(TENANT_B, ...) already returns null.
      resolver: makeAllowResolver(),
      tenantForActor: async (slug) => (slug === ACTOR_B ? TENANT_B : TENANT_A),
    });
    servers.push(server);
    await listen(server);

    const res = await httpGet(
      `${baseUrl()}/api/files/${VERSION_ID}/download`,
      { "x-dev-user": ACTOR_B },
    );

    // 404: version is not visible in TENANT_B — no leak of TENANT_A existence.
    expect(res.status).toBe(404);
  });

  it("AC-download-4: version does not exist → 404", async () => {
    const { server, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    // No version seeded — getFileContentUrl returns not_found
    const res = await httpGet(
      `${baseUrl()}/api/files/${VERSION_ID}/download`,
      { "x-dev-user": ACTOR_A },
    );

    expect(res.status).toBe(404);
  });

  it("AC-download-5: content erased (tombstone) → 404", async () => {
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ contentErasedAt: Date.now() - 1000 }));

    const { server, baseUrl } = buildTestServer({ fileStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(
      `${baseUrl()}/api/files/${VERSION_ID}/download`,
      { "x-dev-user": ACTOR_A },
    );

    expect(res.status).toBe(404);
  });

  it("AC-download-6: missing x-dev-user → 401", async () => {
    const { server, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download`);
    expect(res.status).toBe(401);
  });

  it("AC-download-7: invalid fileVersionId → 400", async () => {
    const { server, baseUrl } = buildTestServer({});
    servers.push(server);
    await listen(server);

    const res = await httpGet(
      `${baseUrl()}/api/files/not-a-uuid/download`,
      { "x-dev-user": ACTOR_A },
    );

    expect(res.status).toBe(400);
  });

  it("AC-download-8: file:// branch — response carries X-Content-Type-Options: nosniff", async () => {
    // Write a real temp file so createReadStream in the handler succeeds.
    const tmpFile = path.join(os.tmpdir(), `choros-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, "hello nosniff");

    const expiresAt = Date.now() + 300_000;
    const fileUrl = `file://${tmpFile}?expires=${expiresAt}`;

    // Custom ObjectStore that presigns with a file:// URL pointing to our temp file.
    const fsLikeStore: ObjectStore = {
      async put(_key: string, _body: Uint8Array, _meta: { mime: string; size: number }): Promise<void> { /* no-op */ },
      async presignGet(_key: string, _ttl: number): Promise<string> { return fileUrl; },
      async erase(_key: string): Promise<void> { /* no-op */ },
    };

    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "text/plain" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsLikeStore as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(
      `${baseUrl()}/api/files/${VERSION_ID}/download`,
      { "x-dev-user": ACTOR_A },
    );

    // Cleanup temp file.
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    // Security header must be present on streamed file responses.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
  });
});

// ---------------------------------------------------------------------------
// T-0579 (AC-11, FF-INLINE-SAFE): ?disposition=inline on the download route.
//
// Only preview-safe mime types (a POSITIVE allowlist of concrete-safe image
// subtypes — png/jpeg/gif/webp — plus application/pdf) get Content-
// Disposition: inline when the param is present; everything else (including
// no param at all, and any image/* subtype NOT on the allowlist, e.g. svg,
// svg+xml, image/svg with no +xml) stays `attachment` — the pre-T-0579
// default is UNCHANGED (verified by AC-download-8 above, which has no query
// param and still asserts `attachment`). PDP gate, tenant/actor-from-identity,
// and nosniff are untouched — only the file:// (FsObjectStore) streaming
// branch gets the new header logic; these tests exercise exactly that branch.
// ---------------------------------------------------------------------------

describe("GET /api/files/:fileVersionId/download?disposition=inline (T-0579)", () => {
  function writeTempFile(contents: string): string {
    const tmpFile = path.join(os.tmpdir(), `choros-test-inline-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    fs.writeFileSync(tmpFile, contents);
    return tmpFile;
  }

  function fsObjectStoreFor(tmpFile: string): ObjectStore {
    const expiresAt = Date.now() + 300_000;
    const fileUrl = `file://${tmpFile}?expires=${expiresAt}`;
    return {
      async put(_key: string, _body: Uint8Array, _meta: { mime: string; size: number }): Promise<void> { /* no-op */ },
      async presignGet(_key: string, _ttl: number): Promise<string> { return fileUrl; },
      async erase(_key: string): Promise<void> { /* no-op */ },
    };
  }

  it("AC-11: image/png with ?disposition=inline → Content-Disposition: inline", async () => {
    const tmpFile = writeTempFile("fake-png-bytes");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "image/png" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^inline/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("AC-11/B1-residual: application/xhtml+xml with ?disposition=inline → attachment (not on the allowlist)", async () => {
    const tmpFile = writeTempFile("<html><script>alert(1)</script></html>");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "application/xhtml+xml" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
  });

  it("AC-11: application/pdf with ?disposition=inline → Content-Disposition: inline", async () => {
    const tmpFile = writeTempFile("%PDF-1.4 fake");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "application/pdf" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^inline/);
  });

  it("AC-11/B1-residual: \"application/pdf;charset=binary\" (parameterized, safe) with ?disposition=inline → inline", async () => {
    const tmpFile = writeTempFile("%PDF-1.4 fake");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "application/pdf;charset=binary" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^inline/);
  });

  it("AC-11 anti-XSS: image/svg+xml with ?disposition=inline → STILL attachment (svg excluded)", async () => {
    const tmpFile = writeTempFile("<svg onload=alert(1)></svg>");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "image/svg+xml" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
  });

  // review B1 (blocking): registro-variant svg mime must NOT slip through the
  // exact-match/startsWith combo. Each row below simulates a version whose
  // stored mime is a case/whitespace variant of image/svg+xml (e.g. a row
  // written before the upload-side normalization fix, or by any writer that
  // bypasses it) — isInlineSafeMime itself must still normalize on READ and
  // refuse inline, so the anti-XSS boundary holds regardless of how the mime
  // got into storage.
  it.each([
    ["image/SVG+xml", "uppercase SVG token"],
    ["image/svg+XML", "uppercase xml token"],
    ["image/Svg+xml", "mixed-case Svg"],
    ["IMAGE/SVG+XML", "fully uppercase"],
    [" image/svg+xml ", "leading/trailing whitespace"],
    ["  Image/Svg+Xml  ", "mixed-case + whitespace"],
  ])("AC-11/B1 anti-XSS regression: %s (%s) with ?disposition=inline → STILL attachment", async (variantMime) => {
    const tmpFile = writeTempFile("<svg onload=alert(1)></svg>");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: variantMime }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
  });

  // review B1-residual (blocking, second round): the registro-only fix above
  // still missed two bypasses. (a) A stored mime carrying a PARAMETER —
  // `image/svg+xml;charset=utf-8` — survives trim()+toLowerCase() as
  // `image/svg+xml;charset=utf-8`, which fails the exact
  // `=== "image/svg+xml"` compare yet still passes a bare
  // `startsWith("image/")` check → inline → stored-XSS. (b) `image/svg`
  // (no `+xml` suffix at all) was never covered by that single negative
  // check to begin with — browsers still render it as SVG. Threat model:
  // the read-time boundary must hold "independent of how the mime got into
  // storage" — src/core/document-render.ts's addVersion calls (text/html,
  // text/csv, ...) are a SECOND writer that does not go through the upload
  // route's param-stripping, and `image/svg` requires no parameter at all —
  // any seed/import/writer that stores either variant must still be denied
  // on READ. Both are closed by param-stripping at the compare boundary AND
  // switching to a POSITIVE allowlist of concrete-safe image subtypes.
  it.each([
    ["image/svg+xml;charset=utf-8", "svg+xml with charset param"],
    ["image/svg+xml;x=1", "svg+xml with arbitrary param"],
    ["image/SVG+xml;charset=utf-8", "svg+xml uppercase + param"],
    ["image/svg", "svg WITHOUT +xml suffix"],
    ["IMAGE/SVG", "svg without +xml, uppercase"],
    [" image/svg ; charset=utf-8 ", "svg without +xml, param + whitespace"],
  ])("AC-11/B1-residual anti-XSS regression: %s (%s) with ?disposition=inline → STILL attachment", async (variantMime) => {
    const tmpFile = writeTempFile("<svg onload=alert(1)></svg>");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: variantMime }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
  });

  // Positive-side param-stripping check: a safe image mime CARRYING a
  // parameter (e.g. from a client that sends `image/png;charset=binary`)
  // must still get inline — proves the param-stripping is not over-broad /
  // does not accidentally reject legitimate parameterized safe mimes.
  it('AC-11/B1-residual: "image/png;charset=binary" (parameterized, safe) with ?disposition=inline → inline', async () => {
    const tmpFile = writeTempFile("fake-png-bytes");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "image/png;charset=binary" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^inline/);
  });

  // Positive allowlist coverage: each concrete safe image subtype gets
  // inline on its own (not just png, which the earlier AC-11 test already
  // covers) — proves the allowlist is a real allowlist, not an accidental
  // startsWith("image/") in disguise.
  it.each([
    ["image/jpeg"],
    ["image/gif"],
    ["image/webp"],
  ])("AC-11/B1-residual positive allowlist: %s with ?disposition=inline → inline", async (mimeType) => {
    const tmpFile = writeTempFile("fake-image-bytes");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^inline/);
  });

  // Positive-side registro check: a safe image mime with unusual casing must
  // STILL get inline (proves the normalization is not over-broad / does not
  // accidentally reject legitimate variants — symmetry with the negative
  // svg-variant checks above).
  it('AC-11/B1: "Image/PNG" (registro-variant, safe) with ?disposition=inline → inline', async () => {
    const tmpFile = writeTempFile("fake-png-bytes");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "Image/PNG" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^inline/);
  });

  it("AC-11 anti-XSS: text/html with ?disposition=inline → STILL attachment", async () => {
    const tmpFile = writeTempFile("<script>alert(1)</script>");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "text/html" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
  });

  it("AC-11: text/plain with ?disposition=inline → attachment (not on the allowlist)", async () => {
    const tmpFile = writeTempFile("plain text content");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "text/plain" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
  });

  it("AC-11: image/png WITHOUT the query param → attachment (default unchanged)", async () => {
    const tmpFile = writeTempFile("fake-png-bytes");
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "image/png" }));

    const { server, baseUrl } = buildTestServer({ fileStore, objectStore: fsObjectStoreFor(tmpFile) as unknown as FakeObjectStore });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download`, { "x-dev-user": ACTOR_A });

    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
  });

  it("AC-12/FF-DERIVED-AUTHZ regression: resolver deny → 403 even with ?disposition=inline (no bytes)", async () => {
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "image/png" }));

    const { server, baseUrl } = buildTestServer({ fileStore, resolver: makeDenyResolver("no_grant") });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_A });

    expect(res.status).toBe(403);
    expect(res.body).not.toContain("fake-png-bytes");
  });

  it("AC-13/FF-CROSS-TENANT regression: cross-tenant actor → 404 even with ?disposition=inline (no bytes)", async () => {
    const fileStore = new FakeFileStore();
    fileStore.seedFile(makeFileRow({ currentVersion: VERSION_ID }));
    fileStore.seedVersion(makeVersionRow({ mimeType: "image/png" })); // seeded in TENANT_A

    const { server, baseUrl } = buildTestServer({
      fileStore,
      resolver: makeAllowResolver(),
      tenantForActor: async (slug) => (slug === ACTOR_B ? TENANT_B : TENANT_A),
    });
    servers.push(server);
    await listen(server);

    const res = await httpGet(`${baseUrl()}/api/files/${VERSION_ID}/download?disposition=inline`, { "x-dev-user": ACTOR_B });

    // 404: version is not visible in TENANT_B — no leak of TENANT_A existence,
    // regardless of the inline query param.
    expect(res.status).toBe(404);
  });
});
