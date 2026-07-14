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
import { buildObjectKey, getFileContentUrl } from '../../../src/core/file-attachment.js';
import type { ObjectStore } from '../../../src/core/file-attachment.js';
import {
  makeFileRecordResolver,
  type GrantSource,
  type RecordSource,
  type ResolverDeps,
} from '../../../src/core/grant-resolver.js';
import type { Grant, AncestryOracle } from '../../../src/core/grant-lattice.js';
import type { ResolveSubject, ResourceRef } from '../../../src/core/object-handle.js';

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

// --- AC-9 derived-authz seed helpers (employee / role / assignment / grant) ---

async function seedEmployee(c: pg.Client, tenantId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $3, 0, 0)`,
    [tenantId, id, `file-emp-${id.slice(0, 8)}`],
  );
  return id;
}

async function seedRole(c: pg.Client, tenantId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'AC-9 file derived-authz role', 0, 0)`,
    [tenantId, id, `file-role-${id.slice(0, 8)}`],
  );
  return id;
}

async function seedRoleAssignment(
  c: pg.Client,
  tenantId: string,
  employeeId: string,
  roleId: string,
): Promise<void> {
  const orgScope = JSON.stringify({
    kind: 'node',
    hierarchy: 'org',
    nodeId: 'b0000000-0000-0000-0000-000000000001',
    nodeLevel: 'department',
  });
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
        source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'test', 'seed', NULL, 'seed', 0, 0)`,
    [tenantId, crypto.randomUUID(), employeeId, roleId, orgScope],
  );
}

/** Seed a record/read grant scoped at the RECORD node (so containment is
 *  equality-only — the AncestryOracle below is a===b, no resource hierarchy to
 *  stand up). This is the grant whose presence/absence the AC-9 probe toggles. */
async function seedRecordReadGrant(
  c: pg.Client,
  tenantId: string,
  roleId: string,
  recordId: string,
): Promise<void> {
  const scope = JSON.stringify({
    kind: 'node',
    hierarchy: 'resource',
    nodeId: recordId,
    nodeLevel: 'record',
  });
  // resource_facet MUST be NON-NULL for a record grant (FF-13 / AC-13, enforced
  // DB-globally by bundle-coherence.test.ts in the shared db tier). The record's
  // data is {} so an empty well-formed facet still yields a COVERING grant
  // (denied:false) — all getFileContentUrl needs — without a hanging null facet
  // that would pollute the sibling FF-13 suite.
  const facet = JSON.stringify({ fields: [] });
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable,
        granted_by, valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'record', $4::jsonb, 'read', $5::jsonb, NULL, false, 'seed', NULL, NULL, 0)`,
    [tenantId, crypto.randomUUID(), roleId, facet, scope],
  );
}

// --- PG-backed ResolverDeps ports for the live AC-9 probe -------------------
//
// These wire the REAL T-0021 PDP (resolveFor via makeFileRecordResolver) to live
// Postgres: grants come from choros."grant" JOIN choros.role_assignment (the
// production join, mirrors src/http/invoke.ts loadCallerInvokeGrants), the record
// is read from choros.record, and the ancestry oracle is equality-only because
// the grant is scoped exactly at the record node. NOTHING in-memory decides authz.

/** GrantSource: the subject's current grants via their role assignments, live. */
function pgGrantSource(pool: pg.Pool): GrantSource {
  return {
    async getGrants(subject: ResolveSubject): Promise<Grant[]> {
      const { rows } = await pool.query<{
        id: string; role_id: string; resource_type: string; resource_facet: unknown;
        operation: string; scope: unknown; constraint: unknown; delegable: boolean;
        granted_by: string; valid_from: string | null; valid_until: string | null; created_at: string;
      }>(
        `SELECT g.id, g.role_id, g.resource_type, g.resource_facet,
                g.operation, g.scope, g."constraint", g.delegable,
                g.granted_by, g.valid_from, g.valid_until, g.created_at
           FROM choros."grant" g
           JOIN choros.role_assignment ra
             ON ra.tenant_id = g.tenant_id AND ra.role_id = g.role_id
          WHERE g.tenant_id = $1 AND ra.employee_id = $2`,
        [subject.tenantId, subject.subjectId],
      );
      return rows.map((g) => ({
        tenantId: subject.tenantId,
        id: g.id,
        roleId: g.role_id,
        resourceType: g.resource_type as Grant['resourceType'],
        resourceFacet: (g.resource_facet ?? undefined) as Grant['resourceFacet'],
        operation: g.operation as Grant['operation'],
        scope: g.scope as Grant['scope'],
        constraint: (g.constraint ?? undefined) as Grant['constraint'],
        delegable: g.delegable,
        grantedBy: g.granted_by,
        validFrom: g.valid_from != null ? Number(g.valid_from) : undefined,
        validUntil: g.valid_until != null ? Number(g.valid_until) : undefined,
        createdAt: Number(g.created_at),
      }));
    },
  };
}

/** RecordSource: raw record fields for a `record` ref (read only after allow). */
function pgRecordSource(pool: pg.Pool): RecordSource {
  return {
    async getRecord(ref: ResourceRef): Promise<Record<string, unknown> | null> {
      if (ref.kind !== 'record') return null;
      const { rows } = await pool.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM choros.record WHERE tenant_id = $1 AND id = $2`,
        [ref.tenantId, ref.recordId],
      );
      return rows.length === 0 ? null : (rows[0].data ?? {});
    },
  };
}

/** Equality-only oracle: the grant is scoped exactly at the record node, so the
 *  handle's record node is contained iff it IS the grant's node (a===b). */
const EQUALITY_ORACLE: AncestryOracle = {
  isDescendantOrSelf: (_h, a, b) => a === b,
};

function pgResolverDeps(pool: pg.Pool): ResolverDeps {
  return {
    grants: pgGrantSource(pool),
    records: pgRecordSource(pool),
    ancestry: EQUALITY_ORACLE,
  };
}

/** A no-byte ObjectStore stub: presignGet is the ONLY method the AC-9 download
 *  path calls (and only AFTER a PDP allow). put/erase are never reached here. */
const PRESIGN_STORE: ObjectStore = {
  async put() { throw new Error('AC-9 probe must not put'); },
  async presignGet(key: string, ttl: number): Promise<string> {
    return `https://example.invalid/${encodeURIComponent(key)}?ttl=${ttl}`;
  },
  async erase() { throw new Error('AC-9 probe must not erase'); },
};

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
    'AC-9 FF-DERIVED-AUTHZ (live): no record read-grant ⇒ download denied; with grant ⇒ allowed — REAL PDP against Postgres',
    requireDb(async () => {
      const store = new PgFileStore(poolA);
      const recordId = seeded[TENANT_A].recordId;

      // Seed a file + one (non-erased) version to download.
      const file = mkFile(TENANT_A, recordId);
      await store.insertFile(file);
      const v1 = mkVersion(TENANT_A, file.id, 1, 'ac9-hash');
      await store.insertVersion(v1);
      await store.setCurrentVersion(TENANT_A, file.id, v1.id, 1);

      // Seed an employee + role + assignment (migrator bypasses RLS for setup).
      // The grant is seeded LATER (toggled) to prove derived-authz both ways.
      let employeeId = '';
      let roleId = '';
      await withClient(migratorUrl(), async (c) => {
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        employeeId = await seedEmployee(c, TENANT_A);
        roleId = await seedRole(c, TENANT_A);
        await seedRoleAssignment(c, TENANT_A, employeeId, roleId);
      });

      const subject: ResolveSubject = { tenantId: TENANT_A, subjectId: employeeId };
      const deps = {
        // The REAL op-carrying PDP seam over resolveFor against live Postgres.
        resolver: makeFileRecordResolver(pgResolverDeps(poolA)),
        store: PRESIGN_STORE,
        meta: store,
        ttl: 120,
      };

      // (1) WITHOUT a record read-grant ⇒ deny (no_grant), no presign.
      const denied = await getFileContentUrl(deps, v1.id, subject);
      expect(denied.denied).toBe(true);
      if (denied.denied) expect(denied.reason).toBe('no_grant');

      // (2) Grant the role a record/read scoped to this record, then retry ⇒ allow.
      await withClient(migratorUrl(), async (c) => {
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        await seedRecordReadGrant(c, TENANT_A, roleId, recordId);
      });

      const allowed = await getFileContentUrl(deps, v1.id, subject);
      expect(allowed.denied).toBe(false);
      if (!allowed.denied) {
        expect(allowed.url).toContain('https://example.invalid/');
        expect(allowed.expiresAt).toBeGreaterThan(0);
      }
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
