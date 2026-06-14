/**
 * T-0201 / T-0119 · Files / attachments — unit fitness.
 *
 * Pure unit — no DB, no real S3. Uses a fake FileMetaSource + InMemoryObjectStore
 * + mock HandleResolver. Covers the static-now fitness functions (ADR §6):
 *   FF-KEY (single tenant-prefixed key constructor),
 *   FF-V / immutable-version (two versions ⇒ two rows, distinct keys/hashes; old readable),
 *   FF-PRESIGN-AFTER-ALLOW (deny ⇒ no presign; allow ⇒ presign with ttl ≤ 300),
 *   FF-FAILCLOSED (no tenant context / cross-tenant ⇒ deny, zero ObjectStore calls),
 *   FF-DERIVED-AUTHZ (no record grant ⇒ deny; with grant ⇒ allow — same PDP),
 *   FF-RETENTION-DENY (erase only from pending_deletion; tombstone, metadata lives),
 *   FF-AUDIT-EVENTS (upload/replace/download/delete emit audit_event rows),
 *   storage round-trip (put → presign-key → read back the same bytes).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";

import {
  buildObjectKey,
  authorizeFileOp,
  getFileContentUrl,
  addVersion,
  eraseForRetention,
  type FileMetaSource,
  type FileRow,
  type FileVersionRow,
  type FileAuditSink,
} from "../core/file-attachment.js";
import { InMemoryObjectStore } from "../adapters/s3-object-store.js";
import {
  type HandleResolver,
  type ResolveSubject,
  type ResolvedView,
} from "../core/object-handle.js";
import { type AuditEventInput } from "../core/audit-grant-encoder.js";

// ---------------------------------------------------------------------------
// Constants — fresh-ish ids; no DB, so static UUIDs are fine here.
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RECORD_A = "11111111-1111-1111-1111-111111111111";
const REGISTRY_A = "22222222-2222-2222-2222-222222222222";
const FILE_A = "33333333-3333-3333-3333-333333333333";
const SUBJECT = "44444444-4444-4444-4444-444444444444";

const subjectA: ResolveSubject = { tenantId: TENANT_A, subjectId: SUBJECT };

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// Fake FileMetaSource — in-memory file + file_version store.
// ---------------------------------------------------------------------------

class FakeFileStore implements FileMetaSource {
  files = new Map<string, FileRow>();
  versions = new Map<string, FileVersionRow>();

  private fk(t: string, id: string) {
    return `${t}::${id}`;
  }

  putFile(f: FileRow) {
    this.files.set(this.fk(f.tenantId, f.id), f);
  }

  async getFile(tenantId: string, fileId: string): Promise<FileRow | null> {
    return this.files.get(this.fk(tenantId, fileId)) ?? null;
  }
  async getVersion(tenantId: string, versionId: string): Promise<FileVersionRow | null> {
    const v = this.versions.get(this.fk(tenantId, versionId)) ?? null;
    return v;
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
    if (this.versions.has(key)) throw new Error("duplicate version insert");
    this.versions.set(key, { ...row });
  }
  async setCurrentVersion(tenantId: string, fileId: string, versionId: string, atMs: number): Promise<void> {
    const f = this.files.get(this.fk(tenantId, fileId));
    if (f) {
      f.currentVersion = versionId;
      f.updatedAt = atMs;
    }
  }
  async markContentErased(tenantId: string, versionId: string, atMs: number): Promise<void> {
    const v = this.versions.get(this.fk(tenantId, versionId));
    if (v && v.contentErasedAt === null) v.contentErasedAt = atMs;
  }
}

// ---------------------------------------------------------------------------
// Mock resolvers (the SAME HandleResolver port the PDP implements).
// ---------------------------------------------------------------------------

const allowResolver: HandleResolver = {
  async resolveHandle(handle, subject): Promise<ResolvedView> {
    if (handle.tenantId !== subject.tenantId) return { denied: true, reason: "cross_tenant" };
    return { denied: false, ref: handle.ref, fields: {} };
  },
};

const denyResolver: HandleResolver = {
  async resolveHandle(): Promise<ResolvedView> {
    return { denied: true, reason: "no_grant" };
  },
};

// A recording audit sink.
function recordingSink(): { sink: FileAuditSink; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return { sink: { async emit(e) { events.push(e); } }, events };
}

function seedFile(store: FakeFileStore, over: Partial<FileRow> = {}): FileRow {
  const f: FileRow = {
    tenantId: TENANT_A,
    id: FILE_A,
    recordId: RECORD_A,
    registryId: REGISTRY_A,
    originalName: "contract.pdf",
    currentVersion: null,
    retentionState: "active",
    retentionPolicyRef: null,
    createdBy: SUBJECT,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
  store.putFile(f);
  return f;
}

const hashDep = (b: Uint8Array) => sha256(b);

// ---------------------------------------------------------------------------
// FF-KEY
// ---------------------------------------------------------------------------

describe("buildObjectKey (FF-KEY)", () => {
  it("leads with the tenant segment, structural prefix", () => {
    const key = buildObjectKey(TENANT_A, FILE_A, "ver-1");
    expect(key).toBe(`${TENANT_A}/${FILE_A}/ver-1`);
    expect(key.startsWith(TENANT_A + "/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FF-DERIVED-AUTHZ — permission derived from record write-perms.
// ---------------------------------------------------------------------------

describe("authorizeFileOp — derived authz (FF-DERIVED-AUTHZ)", () => {
  it("denies when subject has no record grant", async () => {
    const store = new FakeFileStore();
    const file = seedFile(store);
    const v = await authorizeFileOp(denyResolver, file, subjectA, "read");
    expect(v.denied).toBe(true);
    if (v.denied) expect(v.reason).toBe("no_grant");
  });

  it("allows when subject has the record grant (same PDP)", async () => {
    const store = new FakeFileStore();
    const file = seedFile(store);
    const v = await authorizeFileOp(allowResolver, file, subjectA, "read");
    expect(v.denied).toBe(false);
  });

  it("denies cross-tenant before any resolver decision (fail-closed)", async () => {
    const store = new FakeFileStore();
    const file = seedFile(store);
    const otherTenant: ResolveSubject = { tenantId: TENANT_B, subjectId: SUBJECT };
    const v = await authorizeFileOp(allowResolver, file, otherTenant, "read");
    expect(v.denied).toBe(true);
    if (v.denied) expect(v.reason).toBe("cross_tenant");
  });
});

// ---------------------------------------------------------------------------
// FF-PRESIGN-AFTER-ALLOW + FF-FAILCLOSED + storage round-trip
// ---------------------------------------------------------------------------

describe("getFileContentUrl (FF-PRESIGN-AFTER-ALLOW / FF-FAILCLOSED)", () => {
  let store: FakeFileStore;
  let s3: InMemoryObjectStore;
  let versionId: string;

  beforeEach(async () => {
    store = new FakeFileStore();
    seedFile(store);
    s3 = new InMemoryObjectStore();
    // seed one version by going through addVersion with an allow.
    const r = await addVersion(
      { resolver: allowResolver, store: s3, meta: store, hash: hashDep },
      FILE_A,
      subjectA,
      new TextEncoder().encode("v1-bytes"),
      { mime: "application/pdf" },
    );
    expect(r.denied).toBe(false);
    if (!r.denied) versionId = r.versionId;
  });

  it("presign NOT called on deny; result denied", async () => {
    let presignCalls = 0;
    const spyStore = {
      ...s3,
      put: s3.put.bind(s3),
      erase: s3.erase.bind(s3),
      async presignGet(k: string, t: number) {
        presignCalls++;
        return s3.presignGet(k, t);
      },
    };
    const res = await getFileContentUrl(
      { resolver: denyResolver, store: spyStore, meta: store, ttl: 300 },
      versionId,
      subjectA,
    );
    expect(res.denied).toBe(true);
    expect(presignCalls).toBe(0);
  });

  it("presign called on allow with ttl ≤ 300", async () => {
    let seenTtl = -1;
    const spyStore = {
      ...s3,
      put: s3.put.bind(s3),
      erase: s3.erase.bind(s3),
      async presignGet(k: string, t: number) {
        seenTtl = t;
        return s3.presignGet(k, t);
      },
    };
    const res = await getFileContentUrl(
      { resolver: allowResolver, store: spyStore, meta: store, ttl: 9999 },
      versionId,
      subjectA,
    );
    expect(res.denied).toBe(false);
    expect(seenTtl).toBeLessThanOrEqual(300);
    if (!res.denied) expect(res.url).toContain("mem://object/");
  });

  it("fail-closed: cross-tenant subject ⇒ deny, no presign", async () => {
    let presignCalls = 0;
    const spyStore = {
      ...s3,
      put: s3.put.bind(s3),
      erase: s3.erase.bind(s3),
      async presignGet(k: string, t: number) {
        presignCalls++;
        return s3.presignGet(k, t);
      },
    };
    const other: ResolveSubject = { tenantId: TENANT_B, subjectId: SUBJECT };
    // version is keyed by tenant; tenant B has no such version ⇒ not_found, no presign.
    const res = await getFileContentUrl(
      { resolver: allowResolver, store: spyStore, meta: store, ttl: 300 },
      versionId,
      other,
    );
    expect(res.denied).toBe(true);
    expect(presignCalls).toBe(0);
  });

  it("storage round-trip: put → read back the same bytes by object_key", async () => {
    const ver = await store.getVersion(TENANT_A, versionId);
    expect(ver).not.toBeNull();
    const back = s3.read(ver!.objectKey);
    expect(back).not.toBeNull();
    expect(new TextDecoder().decode(back!)).toBe("v1-bytes");
  });
});

// ---------------------------------------------------------------------------
// FF-V — immutable-version: two versions ⇒ two rows, distinct keys/hashes.
// ---------------------------------------------------------------------------

describe("addVersion immutable-version (FF-V)", () => {
  it("two addVersion ⇒ two file_version rows, distinct key/version_no/hash; old readable; no overwrite", async () => {
    const store = new FakeFileStore();
    seedFile(store);
    const s3 = new InMemoryObjectStore();
    const deps = { resolver: allowResolver, store: s3, meta: store, hash: hashDep };

    const r1 = await addVersion(deps, FILE_A, subjectA, new TextEncoder().encode("v1"), { mime: "text/plain" });
    const r2 = await addVersion(deps, FILE_A, subjectA, new TextEncoder().encode("v2-different"), {
      mime: "text/plain",
      cycleRef: "rework-1",
    });
    expect(r1.denied).toBe(false);
    expect(r2.denied).toBe(false);
    if (r1.denied || r2.denied) return;

    // Two distinct rows.
    expect(store.versions.size).toBe(2);
    expect(r1.versionId).not.toBe(r2.versionId);
    expect(r1.objectKey).not.toBe(r2.objectKey);
    expect(r1.versionNo).toBe(1);
    expect(r2.versionNo).toBe(2);

    const v1 = await store.getVersion(TENANT_A, r1.versionId);
    const v2 = await store.getVersion(TENANT_A, r2.versionId);
    expect(v1!.contentHash).not.toBe(v2!.contentHash);

    // current_version points to the NEW version.
    const f = await store.getFile(TENANT_A, FILE_A);
    expect(f!.currentVersion).toBe(r2.versionId);

    // OLD version still readable by its key; no overwrite happened.
    expect(s3.has(r1.objectKey)).toBe(true);
    expect(s3.has(r2.objectKey)).toBe(true);
    expect(s3.overwritten.size).toBe(0);
    expect(new TextDecoder().decode(s3.read(r1.objectKey)!)).toBe("v1");
  });

  it("addVersion denies (no put, no insert) when resolver denies the record update", async () => {
    const store = new FakeFileStore();
    seedFile(store);
    const s3 = new InMemoryObjectStore();
    const r = await addVersion(
      { resolver: denyResolver, store: s3, meta: store, hash: hashDep },
      FILE_A,
      subjectA,
      new TextEncoder().encode("x"),
      { mime: "text/plain" },
    );
    expect(r.denied).toBe(true);
    expect(store.versions.size).toBe(0);
    expect(s3.has(buildObjectKey(TENANT_A, FILE_A, "any"))).toBe(false);
  });

  it("enforces declared limits before any S3 call (size + mime allowlist)", async () => {
    const store = new FakeFileStore();
    seedFile(store);
    const s3 = new InMemoryObjectStore();
    const tooBig = await addVersion(
      { resolver: allowResolver, store: s3, meta: store, hash: hashDep, limits: { maxSizeBytes: 2 } },
      FILE_A, subjectA, new TextEncoder().encode("toolong"), { mime: "text/plain" },
    );
    expect(tooBig.denied).toBe(true);
    if (tooBig.denied) expect(tooBig.reason).toBe("size_exceeded");

    const badMime = await addVersion(
      { resolver: allowResolver, store: s3, meta: store, hash: hashDep, limits: { mimeAllowlist: ["application/pdf"] } },
      FILE_A, subjectA, new TextEncoder().encode("x"), { mime: "text/plain" },
    );
    expect(badMime.denied).toBe(true);
    if (badMime.denied) expect(badMime.reason).toBe("mime_not_allowed");
    expect(store.versions.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FF-RETENTION-DENY
// ---------------------------------------------------------------------------

describe("eraseForRetention deny-by-default (FF-RETENTION-DENY)", () => {
  async function seedVersioned(state: FileRow["retentionState"]) {
    const store = new FakeFileStore();
    seedFile(store, { retentionState: state });
    const s3 = new InMemoryObjectStore();
    const r = await addVersion(
      { resolver: allowResolver, store: s3, meta: store, hash: hashDep },
      FILE_A, subjectA, new TextEncoder().encode("body"), { mime: "text/plain" },
    );
    if (r.denied) throw new Error("seed failed");
    return { store, s3, versionId: r.versionId, objectKey: r.objectKey };
  }

  it("refuses erase for an active file (bytes remain, no tombstone)", async () => {
    const { store, s3, versionId, objectKey } = await seedVersioned("active");
    const res = await eraseForRetention({ store: s3, meta: store }, versionId, TENANT_A, SUBJECT);
    expect(res.erased).toBe(false);
    if (!res.erased) expect(res.reason).toBe("retention_state_forbids_erase");
    expect(s3.has(objectKey)).toBe(true);
    expect((await store.getVersion(TENANT_A, versionId))!.contentErasedAt).toBeNull();
  });

  it("refuses erase for an archived file", async () => {
    const { store, s3, versionId } = await seedVersioned("archived");
    const res = await eraseForRetention({ store: s3, meta: store }, versionId, TENANT_A, SUBJECT);
    expect(res.erased).toBe(false);
  });

  it("erases for pending_deletion: bytes gone, tombstone set, metadata/hash live", async () => {
    const { store, s3, versionId, objectKey } = await seedVersioned("pending_deletion");
    const before = await store.getVersion(TENANT_A, versionId);
    const res = await eraseForRetention({ store: s3, meta: store }, versionId, TENANT_A, SUBJECT);
    expect(res.erased).toBe(true);
    // Bytes physically gone.
    expect(s3.has(objectKey)).toBe(false);
    // Tombstone set; metadata + hash survive (NF-5).
    const after = await store.getVersion(TENANT_A, versionId);
    expect(after!.contentErasedAt).not.toBeNull();
    expect(after!.contentHash).toBe(before!.contentHash);
    expect(after!.objectKey).toBe(before!.objectKey);
  });

  it("a content-erased version is undownloadable (content_erased)", async () => {
    const { store, s3, versionId } = await seedVersioned("pending_deletion");
    await eraseForRetention({ store: s3, meta: store }, versionId, TENANT_A, SUBJECT);
    const res = await getFileContentUrl(
      { resolver: allowResolver, store: s3, meta: store, ttl: 300 },
      versionId, subjectA,
    );
    expect(res.denied).toBe(true);
    if (res.denied) expect(res.reason).toBe("content_erased");
  });
});

// ---------------------------------------------------------------------------
// FF-AUDIT-EVENTS — upload/replace/download/delete emit audit rows.
// ---------------------------------------------------------------------------

describe("audit events (FF-AUDIT-EVENTS)", () => {
  it("emits file.upload / file.replace / file.download / file.delete with record subject + payload", async () => {
    const store = new FakeFileStore();
    seedFile(store);
    const s3 = new InMemoryObjectStore();
    const { sink, events } = recordingSink();

    const r1 = await addVersion(
      { resolver: allowResolver, store: s3, meta: store, hash: hashDep, audit: sink },
      FILE_A, subjectA, new TextEncoder().encode("v1"), { mime: "text/plain" },
    );
    const r2 = await addVersion(
      { resolver: allowResolver, store: s3, meta: store, hash: hashDep, audit: sink },
      FILE_A, subjectA, new TextEncoder().encode("v2"), { mime: "text/plain" },
    );
    if (r1.denied || r2.denied) throw new Error("seed failed");

    await getFileContentUrl(
      { resolver: allowResolver, store: s3, meta: store, ttl: 300, audit: sink },
      r2.versionId, subjectA,
    );

    // move file to pending_deletion then erase ⇒ file.delete
    (await store.getFile(TENANT_A, FILE_A))!.retentionState = "pending_deletion";
    await eraseForRetention({ store: s3, meta: store, audit: sink }, r1.versionId, TENANT_A, SUBJECT);

    const types = events.map((e) => e.type);
    expect(types).toContain("file.upload");
    expect(types).toContain("file.replace");
    expect(types).toContain("file.download");
    expect(types).toContain("file.delete");

    // subject is the record ref; payload carries file/version identity + hash.
    const upload = events.find((e) => e.type === "file.upload")!;
    expect(upload.subject).toBe(`record:${RECORD_A}`);
    const payload = upload.payload as Record<string, unknown>;
    expect(payload["file_id"]).toBe(FILE_A);
    expect(payload["content_hash"]).toBeDefined();
    expect(payload["data_class"]).toBe("internal");
  });
});
