/**
 * src/adapters/s3-object-store.ts — T-0201 / T-0119
 *
 * ObjectStore adapters for the file/attachment content plane (ADR §4.3 / §8).
 *
 * The `ObjectStore` port (src/core/file-attachment.ts) abstracts the object
 * storage provider so the core never knows the concrete backend: dev = MinIO,
 * prod = a deploy-time S3-compatible provider (the founder-gated GT-4 choice).
 * Swapping provider = swapping the adapter wired at the composition root + env
 * (endpoint/bucket/region/credentials/presign_ttl) — no core change.
 *
 * This file ships TWO adapters behind that single interface, both usable for
 * local/dev + tests WITHOUT pulling an external S3 SDK dependency (the repo is
 * zero-dep beyond `pg`; an `@aws-sdk/client-s3`-backed `S3ObjectStore` is a
 * deploy-time wiring concern, deferred to the runner where MinIO is up):
 *
 *  - InMemoryObjectStore : a Map-backed store for unit tests + ephemeral dev.
 *  - FsObjectStore       : a filesystem-backed store (one file per object_key)
 *                          for the local dev-stack round-trip. The presigned url
 *                          is a `file://` url with a short-lived expiry token —
 *                          a faithful stand-in for the S3 presign contract until
 *                          the MinIO SDK adapter is wired on the runner.
 *
 * Both honor the port invariants:
 *  - `put` writes under a deterministic key produced ONLY by buildObjectKey;
 *    the same key is never overwritten on the write-path (addVersion mints a
 *    fresh versionId per version), so immutability holds at the content plane.
 *  - `presignGet` is the short-lived read url; the CORE only calls it after a
 *    PDP allow (FF-PRESIGN-AFTER-ALLOW) — the adapter does no authorization.
 *  - `erase` physically removes the object (retention); metadata/audit untouched.
 */

import { mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ObjectStore } from "../core/file-attachment.js";

// ---------------------------------------------------------------------------
// InMemoryObjectStore — Map-backed; unit tests + ephemeral dev.
// ---------------------------------------------------------------------------

export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();
  /** Set of keys that were overwritten — asserted EMPTY by the immutability test. */
  public readonly overwritten = new Set<string>();

  async put(key: string, body: Uint8Array, _meta: { mime: string; size: number }): Promise<void> {
    if (this.objects.has(key)) {
      // The write-path never reuses a key (fresh versionId per version). If this
      // fires, an immutability invariant was violated upstream — record it so the
      // FF-V test can assert zero overwrites.
      this.overwritten.add(key);
    }
    this.objects.set(key, body.slice());
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    // A faithful presign stand-in: an opaque, short-lived url carrying the key +
    // an expiry token. No bytes are returned here — the (test) client would GET it.
    const expiresAt = Date.now() + ttlSeconds * 1000;
    return `mem://object/${encodeURIComponent(key)}?expires=${expiresAt}`;
  }

  async erase(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** Test helper: read back the bytes stored under a key (null if absent/erased). */
  read(key: string): Uint8Array | null {
    const v = this.objects.get(key);
    return v ? v.slice() : null;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}

// ---------------------------------------------------------------------------
// FsObjectStore — filesystem-backed; local dev-stack round-trip.
// ---------------------------------------------------------------------------

/**
 * Filesystem-backed ObjectStore: each object_key maps to a file under `rootDir`.
 * The object_key is tenant-prefixed (`<tenant>/<file>/<version>`) so the on-disk
 * layout mirrors the S3 prefix layout. `rootDir` is the dev-stack data volume
 * (analogous to the MinIO bucket); it is supplied at the composition root, never
 * read from process.env inside the core.
 */
export class FsObjectStore implements ObjectStore {
  constructor(private readonly rootDir: string) {}

  private pathFor(key: string): string {
    // Resolve under rootDir and reject any path that escapes it (defense in depth;
    // keys are tenant-prefixed and produced by buildObjectKey, but never trust).
    const full = resolve(join(this.rootDir, key));
    const root = resolve(this.rootDir);
    if (full !== root && !full.startsWith(root + "/")) {
      throw new Error(`FsObjectStore: key escapes root: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Uint8Array, _meta: { mime: string; size: number }): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const p = this.pathFor(key);
    return `file://${p}?expires=${expiresAt}`;
  }

  async erase(key: string): Promise<void> {
    const p = this.pathFor(key);
    await rm(p, { force: true });
  }

  /** Test/dev helper: read back the bytes under a key (null if absent). */
  async read(key: string): Promise<Uint8Array | null> {
    const p = this.pathFor(key);
    try {
      await access(p);
    } catch {
      return null;
    }
    return new Uint8Array(await readFile(p));
  }
}
