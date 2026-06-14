// T-0201 / T-0119 · ADR docs/design/T-0119-files-attachments.adr.md §4 (AC-7/AC-10/AC-11).
//
// Live Postgres probes (run in the `db` CI job / locally):
//   DATABASE_URL=postgres://choros_migrator:...@localhost:5432/choros npm run fitness:db
//
// Proves the file/attachment data-model + tenant isolation at the DB layer:
//   - PgFileStore.insertFile / insertVersion / getFile / getVersion / setCurrentVersion
//     write & read choros.file + choros.file_version (migration 058) through the
//     choros_app role under RLS.
//   - TENANT ISOLATION (T-0013 / FF-T13, the 152-FZ invariant): from choros_app
//     (NOBYPASSRLS), tenant A CANNOT see tenant B's file/version rows — get-by-id
//     across tenants returns null (FF-CROSS-TENANT at the data plane).
//   - IMMUTABLE VERSIONS readable after replace (FF-VERSION-READABLE): v1 stays
//     readable by its object_key after current_version moves to v2; hashes differ.
//   - RETENTION (FF-RETENTION-DENY at the data plane): markContentErased stamps
//     content_erased_at while the metadata row + hash survive.
//   - getFile JOINs choros.record (the owner) to surface registry_id — proving the
//     file↔record ownership link is real (composite tenant-leading FK).
//
// FRESH TENANTS: the db-tier runs all files against ONE shared cloned DB
// (globalSetup, --no-file-parallelism). To avoid cross-file contamination of the
// shared TENANT_A/_B fixtures, this suite mints its OWN random tenant ids per run
// (like connector.test.ts / external_participant.test.ts).
//
// Seeds (tenant/app/registry/record) go through migratorUrl() (bypasses RLS). The
// DAO ops run through GUC-scoped choros_app pools (one per tenant) so RLS is what
// is under test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, withClient } from './_helpers.js';
import { PgFileStore } from '../../../src/core/postgres/pgFileStore.js';
import type { FileRow, FileVersionRow } from '../../../src/core/file-attachment.js';
import { buildObjectKey } from '../../../src/core/file-attachment.js';

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

/** GUC-scoped choros_app pool: every pooled conn SETs the tenant GUC so the DAO
 *  runs under RLS for exactly this tenant (production wiring pattern). */
function makeTenantPool(tenantId: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: appUrl() });
  pool.on('connect', (c: pg.PoolClient) => {
    void c.query(`SET "choros.tenant_id" = '${tenantId.replace(/'/g, "''")}'`);
  });
  return pool;
}

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `file-tenant-${tenantId.slice(0, 8)}`],
  );
}

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.application (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0)`,
    [tenantId, id, `file-app-${id.slice(0, 8)}`],
  );
  return id;
}

async function seedRegistryDef(c: pg.Client, tenantId: string, appId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '{}'::jsonb, 0, 0)`,
    [tenantId, id, appId, `file-reg-${id.slice(0, 8)}`],
  );
  return id;
}

async function seedRecord(c: pg.Client, tenantId: string, registryId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, '{}'::jsonb, 0, 0, 'file-tester')`,
    [tenantId, id, registryId],
  );
  return id;
}

interface Seeded {
  recordId: string;
}

const seeded: Record<string, Seeded> = {};
let poolA: pg.Pool;
let poolB: pg.Pool;

beforeAll(
  requireDb(async () => {
    await withClient(migratorUrl(), async (c) => {
      for (const t of [TENANT_A, TENANT_B]) {
        await seedTenant(c, t);
        const app = await seedApplication(c, t);
        const reg = await seedRegistryDef(c, t, app);
        const rec = await seedRecord(c, t, reg);
        seeded[t] = { recordId: rec };
      }
    });
    poolA = makeTenantPool(TENANT_A);
    poolB = makeTenantPool(TENANT_B);
  }),
);

afterAll(async () => {
  if (poolA) await poolA.end();
  if (poolB) await poolB.end();
});

function mkFile(tenantId: string, recordId: string): Omit<FileRow, 'registryId'> {
  return {
    tenantId,
    id: crypto.randomUUID(),
    recordId,
    originalName: 'contract.pdf',
    currentVersion: null,
    retentionState: 'active',
    retentionPolicyRef: null,
    createdBy: 'file-tester',
    createdAt: 0,
    updatedAt: 0,
  };
}

function mkVersion(tenantId: string, fileId: string, versionNo: number, hash: string): FileVersionRow {
  const id = crypto.randomUUID();
  return {
    tenantId,
    id,
    fileId,
    versionNo,
    objectKey: buildObjectKey(tenantId, fileId, id),
    mimeType: 'application/pdf',
    sizeBytes: 10,
    contentHash: hash,
    dataClass: 'internal',
    isSnapshot: false,
    cycleRef: null,
    contentErasedAt: null,
    uploadedBy: 'file-tester',
    uploadedAt: 0,
  };
}

describe('file/attachment DB model + tenant isolation (T-0201)', () => {
  it(
    'round-trips a file + version; getFile JOINs the owner record registry_id',
    requireDb(async () => {
      const store = new PgFileStore(poolA);
      const file = mkFile(TENANT_A, seeded[TENANT_A].recordId);
      await store.insertFile(file);
      const v1 = mkVersion(TENANT_A, file.id, 1, 'hash-v1');
      await store.insertVersion(v1);
      await store.setCurrentVersion(TENANT_A, file.id, v1.id, 1);

      const got = await store.getFile(TENANT_A, file.id);
      expect(got).not.toBeNull();
      expect(got!.recordId).toBe(file.recordId);
      // The registry_id comes from the JOIN to the owner record — proving the link.
      expect(typeof got!.registryId).toBe('string');
      expect(got!.currentVersion).toBe(v1.id);

      const gotV = await store.getVersion(TENANT_A, v1.id);
      expect(gotV!.objectKey).toBe(v1.objectKey);
      expect(gotV!.objectKey.startsWith(TENANT_A + '/')).toBe(true);
    }),
  );

  it(
    'TENANT ISOLATION: tenant B cannot read tenant A file/version rows (RLS, FF-CROSS-TENANT)',
    requireDb(async () => {
      const storeA = new PgFileStore(poolA);
      const storeB = new PgFileStore(poolB);
      const file = mkFile(TENANT_A, seeded[TENANT_A].recordId);
      await storeA.insertFile(file);
      const v = mkVersion(TENANT_A, file.id, 1, 'iso-hash');
      await storeA.insertVersion(v);

      // From tenant B's GUC-scoped pool, A's rows are invisible (get returns null).
      expect(await storeB.getFile(TENANT_A, file.id)).toBeNull();
      expect(await storeB.getVersion(TENANT_A, v.id)).toBeNull();
      // From A they ARE visible.
      expect(await storeA.getFile(TENANT_A, file.id)).not.toBeNull();
    }),
  );

  it(
    'IMMUTABLE VERSIONS: v1 readable after replace; current=v2; hashes differ (FF-VERSION-READABLE)',
    requireDb(async () => {
      const store = new PgFileStore(poolA);
      const file = mkFile(TENANT_A, seeded[TENANT_A].recordId);
      await store.insertFile(file);
      const v1 = mkVersion(TENANT_A, file.id, 1, 'hash-A');
      await store.insertVersion(v1);
      await store.setCurrentVersion(TENANT_A, file.id, v1.id, 1);
      const v2 = mkVersion(TENANT_A, file.id, 2, 'hash-B');
      await store.insertVersion(v2);
      await store.setCurrentVersion(TENANT_A, file.id, v2.id, 2);

      // v1 still readable by its own id/key; current points to v2; hashes differ.
      const got1 = await store.getVersion(TENANT_A, v1.id);
      const got2 = await store.getVersion(TENANT_A, v2.id);
      expect(got1).not.toBeNull();
      expect(got1!.objectKey).toBe(v1.objectKey);
      expect(got1!.contentHash).not.toBe(got2!.contentHash);
      expect((await store.getFile(TENANT_A, file.id))!.currentVersion).toBe(v2.id);
      expect(await store.maxVersionNo(TENANT_A, file.id)).toBe(2);
    }),
  );

  it(
    'RETENTION: markContentErased tombstones the version; metadata + hash survive (FF-RETENTION-DENY)',
    requireDb(async () => {
      const store = new PgFileStore(poolA);
      const file = mkFile(TENANT_A, seeded[TENANT_A].recordId);
      await store.insertFile(file);
      const v = mkVersion(TENANT_A, file.id, 1, 'erase-hash');
      await store.insertVersion(v);

      await store.markContentErased(TENANT_A, v.id, 999);
      const got = await store.getVersion(TENANT_A, v.id);
      expect(got!.contentErasedAt).toBe(999);
      // Metadata + hash + key survive the byte-erase (NF-5 / T-0016 append-only).
      expect(got!.contentHash).toBe('erase-hash');
      expect(got!.objectKey).toBe(v.objectKey);
    }),
  );

  it(
    'cross-tenant attach is structurally impossible: file.record_id of tenant B FK fails from A',
    requireDb(async () => {
      // Try to insert a file in tenant A pointing at tenant B's record id.
      // Under RLS (tenant A GUC), the composite FK (tenant_id, record_id) can only
      // resolve within tenant A — B's record id is not visible/joinable ⇒ FK error.
      const storeA = new PgFileStore(poolA);
      const badFile = mkFile(TENANT_A, seeded[TENANT_B].recordId);
      await expect(storeA.insertFile(badFile)).rejects.toBeTruthy();
    }),
  );
});
