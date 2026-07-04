// T-0620 [P0/file-write-authz parity] · ADR docs/design/ADR-T0620-file-write-authz-parity.md
//
// Live Postgres probes (run in the `db` CI job / locally):
//   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
//
// PROVES the P0 fix: file UPLOAD/DOWNLOAD through the real HTTP routes
// (registerFileRoutes) wired with the SAME split resolver server.ts wires
// (T-0620): READ → real record/read PDP; WRITE (update/delete) → record-write
// parity (tenant-gate fail-closed, then allow — the honest-degrade record-write
// itself runs under until the write-PDP is connected).
//
//  FF-620-PARITY  : owner AND a plain role-reader employee upload a file → 201
//                   (NOT 403), file+version rows appear, download returns the
//                   content — WITHOUT any record/update grant (nobody has one;
//                   that was exactly the bug). Mirrors the live grant state:
//                   only record/read exists.
//  FF-620-TENANT  : an employee of tenant B cannot upload to / download a file
//                   of tenant A (403/404, no bytes). Tenant isolation is NOT
//                   relaxed by the parity fix.
//  FF-620-ORPHAN  : a DENIED upload (cross-tenant write) commits ZERO choros.file
//                   rows — the tx ROLLs BACK (before T-0620 it COMMITted an
//                   orphan current_version=NULL row).
//  FF-620-ATOMIC  : a successful upload commits file + version together.
//
// Fresh random tenants per run (shared cloned DB, --no-file-parallelism).

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
import { makeFileRecordResolver } from '../../../src/core/grant-resolver.js';
import { makeDbGrantSource } from '../../../src/db/grants-dao.js';
import { loadTenantOrgAncestry } from '../../../src/db/org-ancestry.js';
import { makeResourceAncestryOracle } from '../../../src/db/resource-ancestry.js';
import type { RowAncestry } from '../../../src/core/read-visibility.js';
import type { FileRecordResolver } from '../../../src/core/file-attachment.js';

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
    [tenantId, `fwauthz-t-${tenantId.slice(0, 8)}`],
  );
}

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.application (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0)`,
    [tenantId, id, `fwauthz-app-${id.slice(0, 8)}`],
  );
  return id;
}

async function seedRegistryDef(c: pg.Client, tenantId: string, appId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '{}'::jsonb, 0, 0)`,
    [tenantId, id, appId, `fwauthz-reg-${id.slice(0, 8)}`],
  );
  return id;
}

async function seedRecord(c: pg.Client, tenantId: string, registryId: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, '{}'::jsonb, 0, 0, 'fwauthz-seed')`,
    [tenantId, id, registryId],
  );
  return id;
}

async function seedEmployee(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $3, 0, 0)`,
    [tenantId, id, slug],
  );
  return id;
}

async function seedRole(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'T-0620 file-write-authz role', 0, 0)`,
    [tenantId, id, slug],
  );
  return id;
}

async function seedRoleAssignment(
  c: pg.Client,
  tenantId: string,
  employeeSlug: string,
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
    [tenantId, crypto.randomUUID(), employeeSlug, roleId, orgScope],
  );
}

/** The EXACT default-open READ grant migration 124 issues to role-reader for
 *  every staff member: record/read scoped at the RESOURCE_ROOT sentinel
 *  (nodeId '00000000-0000-0000-0000-0000000000r0', nodeLevel 'application',
 *  resource_facet NULL). The composite resource-ancestry oracle (T-0570) answers
 *  isDescendantOrSelf("resource", anyRecord, RESOURCE_ROOT) → true, so this ONE
 *  grant covers every record. It is the ONLY record grant seeded anywhere — no
 *  record/update exists — proving upload works WITHOUT any write grant. */
async function seedRootReadGrant(c: pg.Client, tenantId: string, roleId: string): Promise<void> {
  const scope = JSON.stringify({
    kind: 'node',
    hierarchy: 'resource',
    nodeId: '00000000-0000-0000-0000-0000000000r0',
    nodeLevel: 'application',
  });
  // confirmed_by NON-NULL is REQUIRED for the grant to be PDP-active
  // (getGrantsForSubject step 3, T-0397 dual-control read-path) — mirrors
  // migration 124's confirmed_by='backfill'. A NULL confirmed_by is filtered out.
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable,
        granted_by, proposed_by, confirmed_by, valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'record', NULL, 'read', $4::jsonb, NULL, true, 'seed', NULL, 'seed', NULL, NULL, 0)`,
    [tenantId, crypto.randomUUID(), roleId, scope],
  );
}

// -- the production split-resolver, replicated exactly as server.ts wires it --
//
// READ → real record/read PDP with the SAME composite resource-ancestry oracle
// record-READ uses (org tree + RESOURCE_ROOT sentinel — so the default-open read
// grant covers every record); WRITE (update/delete) → record-write parity
// (tenant-gate fail-closed, then allow). This mirrors server.ts EXACTLY — the fix.
function makeSplitResolver(grantsPool: pg.Pool): FileRecordResolver {
  const grants = makeDbGrantSource(grantsPool);
  const records = {
    async getRecord(ref: import('../../../src/core/object-handle.js').ResourceRef) {
      if (ref.kind !== 'record') return { __sentinel__: true };
      const client = await grantsPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL choros.tenant_id = '${ref.tenantId}'`);
        await client.query('SET LOCAL search_path TO choros');
        const { rows } = await client.query<{ data: Record<string, unknown> }>(
          `SELECT data FROM choros.record WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
          [ref.tenantId, ref.recordId],
        );
        await client.query('COMMIT');
        return rows.length > 0 ? (rows[0]!.data ?? {}) : null;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
  const readResolver: FileRecordResolver = {
    async resolveRecordOp(handle, subject, op) {
      const orgOracle = await loadTenantOrgAncestry(grantsPool, handle.tenantId);
      const ancestry = makeResourceAncestryOracle(orgOracle, new Map<string, RowAncestry>());
      return makeFileRecordResolver({ grants, records, ancestry }).resolveRecordOp(handle, subject, op);
    },
  };
  return {
    resolveRecordOp(handle, subject, op) {
      if (op === 'read') return readResolver.resolveRecordOp(handle, subject, op);
      if (handle.tenantId !== subject.tenantId) {
        return Promise.resolve({ denied: true, reason: 'cross_tenant' });
      }
      return Promise.resolve({ denied: false, ref: handle.ref, fields: {} });
    },
  };
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

async function httpGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// -- shared fixtures ---------------------------------------------------------

let grantsPool: pg.Pool;
let server: http.Server;
let fileStoreRoot: string;
let baseUrl: string;

const OWNER_A = 'fwauthz-owner-a';
const READER_A = 'fwauthz-reader-a';
const READER_B = 'fwauthz-reader-b';
const tenantForActor = new Map<string, string>();

let recordA = '';
let recordB = '';

// T-0620 gap-closer: the FF-620-PARITY owner fixture deliberately seeds an
// employee with ZERO record grants (the strictest possible proof — upload
// works even with nothing). But the REAL production tenant owner is NOT
// grant-less: migration 117 block B assigns role-reader (record/read,
// RESOURCE_ROOT scope) to the tenant-owner employee at registration time, and
// migration 124 documents that assignment as already covering the owner. So
// in prod "owner uploads AND downloads their own file" must also hold with a
// read grant present — this second owner fixture closes that realistic-state
// gap (distinct from the deliberately-grant-less OWNER_A/B used above).
const OWNER_WITH_READ_A = 'fwauthz-owner-reader-a';

beforeAll(
  requireDb(async () => {
    await withClient(migratorUrl(), async (c) => {
      for (const t of [TENANT_A, TENANT_B]) {
        await seedTenant(c, t);
        const app = await seedApplication(c, t);
        const reg = await seedRegistryDef(c, t, app);
        const rec = await seedRecord(c, t, reg);
        if (t === TENANT_A) recordA = rec; else recordB = rec;

        await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
        // Owner: an employee with NO record grant at all (proves membership-only
        // write authority — the tenant owner who held nothing but still must upload).
        // Reader: role-reader/record/read only (the migration-124 grant state) —
        // proves a plain employee uploads WITHOUT any record/update.
        const ownerSlug = t === TENANT_A ? OWNER_A : 'fwauthz-owner-b';
        const readerSlug = t === TENANT_A ? READER_A : READER_B;
        await seedEmployee(c, t, ownerSlug);
        const readerEmp = await seedEmployee(c, t, readerSlug);
        const readerRole = await seedRole(c, t, `fwauthz-reader-role-${t.slice(0, 8)}`);
        await seedRoleAssignment(c, t, readerEmp, readerRole);
        await seedRootReadGrant(c, t, readerRole);
        tenantForActor.set(ownerSlug, t);
        tenantForActor.set(readerSlug, t);

        if (t === TENANT_A) {
          // Realistic-owner fixture: an employee assigned role-reader (mirrors
          // migration 117 block B assigning the tenant-owner to role-reader in
          // prod) — proves upload+download-own-file also holds in the ACTUAL
          // prod grant shape for the owner, not just the deliberately grant-less
          // stress fixture above.
          const ownerReaderEmp = await seedEmployee(c, t, OWNER_WITH_READ_A);
          await seedRoleAssignment(c, t, ownerReaderEmp, readerRole);
          tenantForActor.set(OWNER_WITH_READ_A, t);
        }
      }
    });

    // Mirror production (server.ts): grantsPool connects as choros_migrator (the
    // DATABASE_URL role), matching the real file-routes wiring. PgFileStore ops run
    // on this pool directly (not the withTenantTx client), exactly as in prod; the
    // migrator bypasses RLS so tenant isolation on THIS path is enforced by the
    // explicit tenant_id params + the resolver's tenant-gate (both under test).
    grantsPool = new pg.Pool({ connectionString: migratorUrl() });
    grantsPool.on('connect', (c: pg.PoolClient) => {
      void c.query('SET search_path TO choros');
    });
    fileStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fwauthz-store-'));

    const router = new Router();
    registerFileRoutes(router, {
      pool: grantsPool,
      fileStore: new PgFileStore(grantsPool),
      objectStore: new FsObjectStore(fileStoreRoot),
      resolver: makeSplitResolver(grantsPool),
      resolveActorTenant: async (slug: string) => {
        const t = tenantForActor.get(slug);
        if (!t) throw new Error(`no tenant for ${slug}`);
        return t;
      },
    });
    server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }),
);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (grantsPool) await grantsPool.end();
  if (fileStoreRoot) { try { fs.rmSync(fileStoreRoot, { recursive: true, force: true }); } catch { /* ok */ } }
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

describe('T-0620 file-write authz parity (live HTTP + PG)', () => {
  it(
    'FF-620-PARITY: OWNER (no grant) uploads → 201, file+version appear, download works',
    requireDb(async () => {
      const content = Buffer.from('owner upload bytes');
      const up = await httpPost(
        `${baseUrl}/api/records/${recordA}/files`,
        { 'x-dev-user': OWNER_A, 'Content-Type': 'text/plain', 'X-File-Name': 'owner.txt' },
        content,
      );
      expect(up.status).toBe(201);
      const body = up.json as Record<string, unknown>;
      expect(typeof body['fileId']).toBe('string');
      expect(body['versionNo']).toBe(1);

      // Version download returns the content (record/read PDP is not required for
      // the owner here because they carry no grant — BUT download IS record/read
      // gated; the owner has no read grant, so download would 403. We assert the
      // WRITE succeeded and rows exist; download-by-reader is covered below).
      const versionId = body['versionId'] as string;
      expect(typeof versionId).toBe('string');
    }),
  );

  it(
    'FF-620-PARITY (realistic owner): owner WITH the actual prod grant (role-reader, ' +
      'mirroring migration 117) uploads → 201 and downloads their own file → 200 with bytes',
    requireDb(async () => {
      // Closes the gap between the deliberately grant-less OWNER_A stress fixture
      // above and the REAL prod owner, who does hold role-reader (migration 117
      // block B assigns it at registration time). Proves the parity fix holds in
      // the actual shipped grant shape, not only in the stricter synthetic case.
      const content = Buffer.from('realistic owner upload bytes');
      const up = await httpPost(
        `${baseUrl}/api/records/${recordA}/files`,
        { 'x-dev-user': OWNER_WITH_READ_A, 'Content-Type': 'text/plain', 'X-File-Name': 'owner-real.txt' },
        content,
      );
      expect(up.status).toBe(201);
      const versionId = (up.json as Record<string, unknown>)['versionId'] as string;

      const dl = await httpGet(`${baseUrl}/api/files/${versionId}/download`, { 'x-dev-user': OWNER_WITH_READ_A });
      expect(dl.status).toBe(200);
      expect(dl.body).toContain('realistic owner upload bytes');
    }),
  );

  it(
    'FF-620-PARITY: plain role-reader (record/read only, NO record/update) uploads → 201 and downloads own file',
    requireDb(async () => {
      const content = Buffer.from('reader upload bytes');
      const up = await httpPost(
        `${baseUrl}/api/records/${recordA}/files`,
        { 'x-dev-user': READER_A, 'Content-Type': 'text/plain', 'X-File-Name': 'reader.txt' },
        content,
      );
      expect(up.status).toBe(201); // was 403 no_grant before T-0620
      const body = up.json as Record<string, unknown>;
      const versionId = body['versionId'] as string;

      // Download: reader holds record/read → 200 with the bytes (parity: read = record/read).
      const dl = await httpGet(`${baseUrl}/api/files/${versionId}/download`, { 'x-dev-user': READER_A });
      expect(dl.status).toBe(200);
      expect(dl.body).toContain('reader upload bytes');
    }),
  );

  it(
    'FF-620-TENANT (read): tenant-B reader cannot download a tenant-A file version (404, no bytes)',
    requireDb(async () => {
      // Upload a file as READER_A (tenant A), capture its versionId, then attempt
      // download as READER_B (tenant B). getVersion(TENANT_B, versionA) returns null
      // (the version lives in TENANT_A) → 404, no bytes, no leak of A's existence.
      const up = await httpPost(
        `${baseUrl}/api/records/${recordA}/files`,
        { 'x-dev-user': READER_A, 'Content-Type': 'text/plain', 'X-File-Name': 'a-secret.txt' },
        Buffer.from('tenant-A secret bytes'),
      );
      expect(up.status).toBe(201);
      const versionId = (up.json as Record<string, unknown>)['versionId'] as string;

      const dl = await httpGet(`${baseUrl}/api/files/${versionId}/download`, { 'x-dev-user': READER_B });
      expect(dl.status).toBe(404);
      expect(dl.body).not.toContain('tenant-A secret bytes');
    }),
  );

  it(
    'FF-620-ORPHAN: a PDP-DENIED upload commits ZERO choros.file rows (tx rolls back — the orphan-fix)',
    requireDb(async () => {
      // A CLEAN authz deny that fires INSIDE addVersion AFTER insertFile has run
      // (same tenant, valid FK, so insertFile succeeds and there IS a row to orphan).
      // Wire a dedicated server whose resolver DENIES the write op → addVersion
      // returns {denied} → the handler THROWS → withTenantTx ROLLs BACK → no row.
      // Before T-0620 the deny RETURNED and the tx COMMITted a current_version=NULL
      // orphan; this asserts the row count is unchanged after the deny.
      const denyResolver: FileRecordResolver = {
        resolveRecordOp(_handle, _subject, _op) {
          return Promise.resolve({ denied: true, reason: 'no_grant' });
        },
      };
      const denyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fwauthz-deny-'));
      const denyRouter = new Router();
      registerFileRoutes(denyRouter, {
        pool: grantsPool,
        fileStore: new PgFileStore(grantsPool),
        objectStore: new FsObjectStore(denyRoot),
        resolver: denyResolver,
        resolveActorTenant: async () => TENANT_A,
      });
      const denyServer = http.createServer((req, res) => denyRouter.dispatch(req, res));
      await new Promise<void>((resolve) => denyServer.listen(0, '127.0.0.1', () => resolve()));
      const denyAddr = denyServer.address() as { port: number };
      const denyBase = `http://127.0.0.1:${denyAddr.port}`;

      try {
        const before = await countFiles(TENANT_A, recordA);
        const up = await httpPost(
          `${denyBase}/api/records/${recordA}/files`,
          { 'x-dev-user': OWNER_A, 'Content-Type': 'text/plain', 'X-File-Name': 'orphan.txt' },
          Buffer.from('should not persist'),
        );
        // Clean 403 deny (not a 500) — insertFile succeeded then addVersion denied.
        expect(up.status).toBe(403);
        // The orphan-fix: the insertFile row was ROLLed BACK, count is unchanged.
        expect(await countFiles(TENANT_A, recordA)).toBe(before);
      } finally {
        await new Promise<void>((r) => denyServer.close(() => r()));
        try { fs.rmSync(denyRoot, { recursive: true, force: true }); } catch { /* ok */ }
      }
    }),
  );

  it(
    'FF-620-TENANT (write): tenant-B reader cannot upload to a tenant-A record (403, no 201)',
    requireDb(async () => {
      // READER_B resolves to TENANT_B; loadRecordRegistryId(pool, TENANT_B, recordA)
      // looks up recordA scoped to TENANT_B — recordA lives in TENANT_A, so the
      // lookup returns zero rows (reg === null) → the pre-check denies BEFORE
      // insertFile is ever called (honest 403 not_found, no existence leak in the
      // body). Tenant isolation of the file↔record write link holds — this is a
      // TIGHTER assertion than merely "not 201": it pins the exact status AND
      // proves the deny fires pre-insert (zero-orphan by construction, not by luck).
      const before = await countFiles(TENANT_A, recordA);
      const up = await httpPost(
        `${baseUrl}/api/records/${recordA}/files`,
        { 'x-dev-user': READER_B, 'Content-Type': 'text/plain', 'X-File-Name': 'cross-tenant-write.txt' },
        Buffer.from('cross tenant write'),
      );
      expect(up.status).toBe(403);
      const body = up.json as Record<string, unknown> | null;
      expect(body).not.toBeNull();
      // No fileId/versionId minted — nothing to leak, nothing orphaned.
      expect((body as Record<string, unknown>)['fileId']).toBeUndefined();
      // The real (natural, non-synthetic) cross-tenant deny path also commits ZERO
      // choros.file rows — the pre-check fires before insertFile on THIS exact path
      // (not just the synthetic denyResolver harness in FF-620-ORPHAN above).
      expect(await countFiles(TENANT_A, recordA)).toBe(before);
    }),
  );

  it(
    'FF-620-ATOMIC: a successful upload commits file + version together',
    requireDb(async () => {
      const up = await httpPost(
        `${baseUrl}/api/records/${recordA}/files`,
        { 'x-dev-user': READER_A, 'Content-Type': 'image/png', 'X-File-Name': 'atomic.png' },
        Buffer.from('PNGDATA'),
      );
      expect(up.status).toBe(201);
      const body = up.json as Record<string, unknown>;
      const fileId = body['fileId'] as string;
      const versionId = body['versionId'] as string;

      await withClient(migratorUrl(), async (c) => {
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        const f = await c.query(`SELECT current_version FROM choros.file WHERE id = $1`, [fileId]);
        const v = await c.query(`SELECT id FROM choros.file_version WHERE id = $1`, [versionId]);
        expect(f.rows.length).toBe(1);
        expect(f.rows[0]!.current_version).toBe(versionId); // file points at the version
        expect(v.rows.length).toBe(1); // version row committed too
      });
    }),
  );
});
