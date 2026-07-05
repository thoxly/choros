// T-0621 [P0/file-robustness] · substrate (changes_product=0)
//
// Live Postgres probes (run in the `db` CI job / locally):
//   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
//
// PROVES the P0 fix: insertFile + addVersion's DAO calls (getFile/maxVersionNo/
// insertVersion/setCurrentVersion) now run on the SAME `pg.PoolClient` the
// upload route's `withTenantTx` opens — not on PgFileStore's own autocommitting
// pool connection. T-0620 already closed the PDP-DENY instance of the orphan
// bug (authorize before insertFile, so a clean deny never reaches insertFile).
// This file closes the OTHER instance named in T-0620's pr-handoff residual
// note ("withTenantTx is cosmetic for PgFileStore"): a genuine MID-TRANSACTION
// DB error — thrown AFTER insertFile has run but BEFORE the version row
// commits — must roll back BOTH, not just fail to insert the version while
// leaving the file row durable on its own connection.
//
//  FF-621-ATOMIC-FAIL : insertVersion throws (simulated mid-way DB error,
//                       AFTER insertFile ran in the SAME callback) → the
//                       upload request fails (500, not 201) AND zero
//                       choros.file rows exist afterward — the tx rolled back
//                       insertFile too. Before T-0621, insertFile ran on its
//                       own autocommitting connection and would have survived
//                       this throw as an orphan (current_version=NULL, 0
//                       versions) regardless of the outer ROLLBACK.
//  FF-621-ATOMIC-OK   : the regression guard — a normal, successful upload
//                       still commits file + version together (unchanged
//                       behaviour for the happy path; mirrors FF-620-ATOMIC).
//  FF-621-TENANT      : the tx client carries the SAME SET LOCAL
//                       choros.tenant_id GUC withTenantTx already sets — a
//                       file inserted via the bound executor is invisible to
//                       a different tenant (tenant-scoping is inherited, not
//                       silently dropped, by the executor-threading change).
//
// Fresh random tenant per test run (shared cloned DB, --no-file-parallelism).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';
import { migratorUrl, withClient } from './_helpers.js';
import { registerFileRoutes } from '../../../src/http/files.js';
import { Router } from '../../../src/http/router.js';
import { PgFileStore } from '../../../src/core/postgres/pgFileStore.js';
import { FsObjectStore } from '../../../src/adapters/s3-object-store.js';
import type { FileRecordResolver } from '../../../src/core/file-attachment.js';
import type { FileRow, FileVersionRow } from '../../../src/core/file-attachment.js';
import type { Queryable } from '../../../src/core/postgres/pgFileStore.js';

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!process.env['DATABASE_URL']) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();

// -- seed helpers (migrator bypasses RLS) -----------------------------------

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `fstx-t-${tenantId.slice(0, 8)}`],
  );
}

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.application (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0)`,
    [tenantId, id, `fstx-app-${id.slice(0, 8)}`],
  );
  return id;
}

async function seedRegistryDef(c: pg.Client, tenantId: string, appId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '{}'::jsonb, 0, 0)`,
    [tenantId, id, appId, `fstx-reg-${id.slice(0, 8)}`],
  );
  return id;
}

async function seedRecord(c: pg.Client, tenantId: string, registryId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, '{}'::jsonb, 0, 0, 'fstx-seed')`,
    [tenantId, id, registryId],
  );
  return id;
}

// -- an always-allow resolver: this file tests DB-transaction atomicity, not
// authorization (that is T-0619/T-0620's concern) --------------------------
const allowResolver: FileRecordResolver = {
  resolveRecordOp(handle, subject) {
    if (handle.tenantId !== subject.tenantId) {
      return Promise.resolve({ denied: true, reason: 'cross_tenant' });
    }
    return Promise.resolve({ denied: false, ref: handle.ref, fields: {} });
  },
};

// -- a PgFileStore subclass whose insertVersion ALWAYS throws — simulates a
// genuine mid-transaction DB error occurring strictly AFTER insertFile has
// already run in the SAME withTenantTx callback (addVersion calls getFile +
// maxVersionNo successfully first, then insertVersion throws). Every OTHER
// method (insertFile, getFile, maxVersionNo, boundTo, ...) delegates to the
// real PgFileStore unchanged, so this is a single-seam fault injection, not a
// full fake — the rest of the DAO's real SQL still runs against Postgres. ---
class ThrowingInsertVersionFileStore extends PgFileStore {
  override async insertVersion(_row: FileVersionRow, _executor?: Queryable): Promise<void> {
    throw new Error('T-0621 simulated mid-transaction DB error (insertVersion)');
  }

  // boundTo must return a view whose insertVersion ALSO throws (this is what
  // addVersion in core/file-attachment.ts actually calls) — the base class's
  // boundTo binds to `this.insertVersion`, which — because `this` is a
  // ThrowingInsertVersionFileStore instance — already resolves to THIS
  // override via normal JS prototype dispatch. No need to re-override boundTo
  // itself; asserted explicitly by the FF-621-ATOMIC-FAIL test below.
}

// -- HTTP helpers ------------------------------------------------------------

async function httpPost(
  url: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: 'POST',
        headers: { ...headers, 'Content-Length': body.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let json: unknown = null;
          try { json = JSON.parse(raw); } catch { /* ok */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// -- shared fixtures ---------------------------------------------------------

let grantsPool: pg.Pool;
let tenantForActor: Map<string, string>;
let recordA = '';
let recordB = '';

const ACTOR_A = 'fstx-actor-a';
const ACTOR_B = 'fstx-actor-b';

beforeAll(
  requireDb(async () => {
    tenantForActor = new Map<string, string>();
    await withClient(migratorUrl(), async (c) => {
      for (const t of [TENANT_A, TENANT_B]) {
        await seedTenant(c, t);
        const app = await seedApplication(c, t);
        const reg = await seedRegistryDef(c, t, app);
        const rec = await seedRecord(c, t, reg);
        if (t === TENANT_A) recordA = rec; else recordB = rec;
      }
    });
    tenantForActor.set(ACTOR_A, TENANT_A);
    tenantForActor.set(ACTOR_B, TENANT_B);

    grantsPool = new pg.Pool({ connectionString: migratorUrl() });
    grantsPool.on('connect', (c: pg.PoolClient) => {
      void c.query('SET search_path TO choros');
    });
  }),
);

afterAll(async () => {
  if (grantsPool) await grantsPool.end();
});

async function countFiles(tenantId: string, recordId: string): Promise<number> {
  return withClient(migratorUrl(), async (c) => {
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM choros.file WHERE tenant_id = $1 AND record_id = $2`,
      [tenantId, recordId],
    );
    return Number(rows[0]!.n);
  });
}

async function countVersions(tenantId: string, fileId: string): Promise<number> {
  return withClient(migratorUrl(), async (c) => {
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM choros.file_version WHERE tenant_id = $1 AND file_id = $2`,
      [tenantId, fileId],
    );
    return Number(rows[0]!.n);
  });
}

function startServer(fileStore: PgFileStore, objectStore: FsObjectStore): {
  server: http.Server;
  baseUrl: Promise<string>;
} {
  const router = new Router();
  registerFileRoutes(router, {
    pool: grantsPool,
    fileStore,
    objectStore,
    resolver: allowResolver,
    resolveActorTenant: async (slug: string) => {
      const t = tenantForActor.get(slug);
      if (!t) throw new Error(`no tenant for ${slug}`);
      return t;
    },
  });
  const server = http.createServer((req, res) => router.dispatch(req, res));
  const baseUrl = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { server, baseUrl };
}

describe('T-0621 PgFileStore tx-atomicity (live HTTP + PG)', () => {
  it(
    'FF-621-ATOMIC-FAIL: insertVersion throws AFTER insertFile ran in the SAME tx ' +
      '→ upload fails AND zero choros.file rows persist (full rollback, no orphan)',
    requireDb(async () => {
      const throwingStore = new ThrowingInsertVersionFileStore(grantsPool);
      const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fstx-fail-'));
      const { server, baseUrl } = startServer(throwingStore, new FsObjectStore(storeRoot));

      try {
        const url = await baseUrl;
        const before = await countFiles(TENANT_A, recordA);

        const up = await httpPost(
          `${url}/api/records/${recordA}/files`,
          { 'x-dev-user': ACTOR_A, 'Content-Type': 'text/plain', 'X-File-Name': 'midway.txt' },
          Buffer.from('bytes that must not orphan a file row'),
        );

        // The DB error propagates as a request failure (not a clean 201) —
        // the router's default error path returns 5xx for an unhandled throw.
        expect(up.status).toBeGreaterThanOrEqual(500);

        // THE FIX: insertFile ran on the SAME client insertVersion's throw
        // rolled back — zero choros.file rows exist for this record, exactly
        // as if the request had never been sent. Before T-0621, insertFile
        // committed independently on its own pooled connection the instant it
        // ran, and this count would have been `before + 1` (an orphan
        // current_version=NULL row) regardless of the insertVersion throw.
        expect(await countFiles(TENANT_A, recordA)).toBe(before);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
        try { fs.rmSync(storeRoot, { recursive: true, force: true }); } catch { /* ok */ }
      }
    }),
  );

  it(
    'FF-621-ATOMIC-OK: a successful upload still commits file + version together ' +
      '(regression guard — the executor-threading change does not break the happy path)',
    requireDb(async () => {
      const realStore = new PgFileStore(grantsPool);
      const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fstx-ok-'));
      const { server, baseUrl } = startServer(realStore, new FsObjectStore(storeRoot));

      try {
        const url = await baseUrl;
        const up = await httpPost(
          `${url}/api/records/${recordA}/files`,
          { 'x-dev-user': ACTOR_A, 'Content-Type': 'text/plain', 'X-File-Name': 'ok.txt' },
          Buffer.from('bytes that SHOULD persist'),
        );
        expect(up.status).toBe(201);
        const body = up.json as Record<string, unknown>;
        const fileId = body['fileId'] as string;
        const versionId = body['versionId'] as string;
        expect(typeof fileId).toBe('string');
        expect(typeof versionId).toBe('string');

        await withClient(migratorUrl(), async (c) => {
          await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
          const f = await c.query<{ current_version: string | null }>(
            `SELECT current_version FROM choros.file WHERE id = $1`,
            [fileId],
          );
          expect(f.rows.length).toBe(1);
          expect(f.rows[0]!.current_version).toBe(versionId);
        });
        expect(await countVersions(TENANT_A, fileId)).toBe(1);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
        try { fs.rmSync(storeRoot, { recursive: true, force: true }); } catch { /* ok */ }
      }
    }),
  );

  it(
    'FF-621-TENANT: the bound tx executor inherits the SAME tenant GUC withTenantTx sets ' +
      '— a file inserted for tenant A stays invisible under tenant B scoping',
    requireDb(async () => {
      const realStore = new PgFileStore(grantsPool);
      const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fstx-tenant-'));
      const { server, baseUrl } = startServer(realStore, new FsObjectStore(storeRoot));

      try {
        const url = await baseUrl;
        const up = await httpPost(
          `${url}/api/records/${recordA}/files`,
          { 'x-dev-user': ACTOR_A, 'Content-Type': 'text/plain', 'X-File-Name': 'tenant-a-only.txt' },
          Buffer.from('tenant A bytes'),
        );
        expect(up.status).toBe(201);
        const fileId = (up.json as Record<string, unknown>)['fileId'] as string;

        // Reading the same fileId scoped to TENANT_B (RLS/explicit predicate)
        // finds nothing — the tx executor did not leak the row cross-tenant.
        const getFileAsB = await realStore.getFile(TENANT_B, fileId);
        expect(getFileAsB).toBeNull();

        // Scoped to its own tenant, it is visible.
        const getFileAsA = await realStore.getFile(TENANT_A, fileId);
        expect(getFileAsA).not.toBeNull();
        expect((getFileAsA as FileRow).recordId).toBe(recordA);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
        try { fs.rmSync(storeRoot, { recursive: true, force: true }); } catch { /* ok */ }
      }
    }),
  );

  it(
    'FF-621-BOUNDTO-UNIT: PgFileStore.boundTo(client) runs every FileMetaSource op on the ' +
      'SAME client — insertVersion via the bound view is visible on that client before COMMIT',
    requireDb(async () => {
      const store = new PgFileStore(grantsPool);
      const client = await grantsPool.connect();
      const fileId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      const now = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        await client.query('SET LOCAL search_path TO choros');

        await store.insertFile(
          {
            tenantId: TENANT_A,
            id: fileId,
            recordId: recordA,
            originalName: 'bound.txt',
            currentVersion: null,
            retentionState: 'active',
            retentionPolicyRef: null,
            createdBy: 'fstx-unit',
            createdAt: now,
            updatedAt: now,
          },
          client,
        );

        const meta = store.boundTo(client);
        // getFile through the bound view sees the just-inserted row on the
        // SAME (uncommitted) transaction — proving it queries `client`, not a
        // separate pool connection (which would not see this uncommitted row).
        const seen = await meta.getFile(TENANT_A, fileId);
        expect(seen).not.toBeNull();

        await meta.insertVersion({
          tenantId: TENANT_A,
          id: versionId,
          fileId,
          versionNo: 1,
          objectKey: `${TENANT_A}/${fileId}/${versionId}`,
          mimeType: 'text/plain',
          sizeBytes: 5,
          contentHash: 'deadbeef',
          dataClass: 'internal',
          isSnapshot: false,
          cycleRef: null,
          contentErasedAt: null,
          uploadedBy: 'fstx-unit',
          uploadedAt: now,
        });
        await meta.setCurrentVersion(TENANT_A, fileId, versionId, now);

        // Still inside the SAME uncommitted tx — the bound view's own read
        // confirms current_version is now set (all writes visible to reads on
        // the same client, standard read-your-writes within one transaction).
        const afterSet = await meta.getFile(TENANT_A, fileId);
        expect(afterSet?.currentVersion).toBe(versionId);

        // Roll back — none of this should ever have been committed for real;
        // this test only needs to prove same-client visibility, not persist data.
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      // Post-rollback: outside that transaction, the row never existed.
      const goneStore = new PgFileStore(grantsPool);
      const afterRollback = await goneStore.getFile(TENANT_A, fileId);
      expect(afterRollback).toBeNull();
    }),
  );
});
