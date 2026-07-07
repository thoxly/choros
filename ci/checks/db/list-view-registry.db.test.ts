// T-0581 (view registry) — LIVE Postgres integration proofs.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// PROVES against the REAL choros_app (NOBYPASSRLS) role — the production RLS
// path, not a query-filter shim:
//
//   AC-2   list_view of tenant A is invisible/unmodifiable from tenant B
//          (GET/PUT/DELETE by id from the wrong tenant → 404, RLS-filtered).
//   AC-3   A saved view's filter/sort, applied via GET /api/records?view_id=,
//          returns ONLY the matching rows in the declared order; the default
//          (no view_id) path still returns the full set.
//   R-3    Numeric (money) sort casts to ::numeric — "10000" sorts after
//          "9000" (lexicographic string order would invert this).
//   R-4    is_empty/is_not_empty correctly distinguish an ABSENT JSONB key
//          from a present one; gt on an absent key never matches (standard
//          SQL NULL semantics, not a crash).
//   AC-6   READ-PDP (isRecordReadable) still gates the view-filtered page: a
//          row that matches the filter but lacks a covering READ grant is
//          absent from the response.
//   AC-9   GET /api/records with NO view params is unaffected (still returns
//          the full unfiltered set in default order).
//   AC-10  The partial unique index enforces ≤1 is_default=true per
//          (tenant, registry_def_id) at the DB layer (duplicate insert fails).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';
import { registerListViewRoutes } from '../../../src/http/list-views.js';
import type { ReadVisibilityResolver } from '../../../src/http/records.js';
import { getGrantsForSubject } from '../../../src/db/grants-dao.js';
import { loadTenantOrgAncestry } from '../../../src/db/org-ancestry.js';
import { makeResourceAncestryOracle } from '../../../src/db/resource-ancestry.js';
import { RESOURCE_ROOT_NODE_ID, type RowAncestry } from '../../../src/core/read-visibility.js';

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!process.env['DATABASE_URL']) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

const hasDb = Boolean(process.env['DATABASE_URL']);

const SCHEMA = {
  type: 'object',
  properties: {
    amount: { type: 'number', title: 'Сумма', 'x-money': { currency: 'RUB' } },
    status: { type: 'string', title: 'Статус', enum: ['open', 'won', 'lost'] },
    notes: { type: 'string', title: 'Заметка' },
  },
  required: [],
  additionalProperties: false,
  'x-field-order': ['amount', 'status', 'notes'],
};

// ---------------------------------------------------------------------------
// Seed helpers (migrator role; SET LOCAL tenant for the RLS WITH CHECK).
// ---------------------------------------------------------------------------

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedApp(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 'published', 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegDef(c: pg.Client, tenantId: string, appId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
    [tenantId, id, appId, slug, JSON.stringify(SCHEMA)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecord(
  c: pg.Client,
  tenantId: string,
  registryId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, 'seed')`,
    [tenantId, id, registryId, JSON.stringify(data)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedEmployee(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $3, 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRole(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedAssignment(c: pg.Client, tenantId: string, empId: string, roleId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, granted_by, confirmed_by, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'seed', 'seed', 'seed', 0, 0)`,
    [tenantId, uuid(), empId, roleId, JSON.stringify({ kind: 'set', members: [] })],
  );
  await c.query('COMMIT');
}

function rootScope(): unknown {
  return { kind: 'node', hierarchy: 'resource', nodeLevel: 'application', nodeId: RESOURCE_ROOT_NODE_ID };
}
function recordScope(recordId: string): unknown {
  return { kind: 'node', hierarchy: 'resource', nodeLevel: 'record', nodeId: recordId };
}

async function seedReadGrant(c: pg.Client, tenantId: string, roleId: string, scope: unknown): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
        "constraint", delegable, granted_by, proposed_by, confirmed_by,
        valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'record', NULL, 'read', $4::jsonb,
             NULL, true, 'seed', NULL, 'seed', NULL, NULL, 0)`,
    [tenantId, uuid(), roleId, JSON.stringify(scope)],
  );
  await c.query('COMMIT');
}

async function seedListView(
  c: pg.Client,
  tenantId: string,
  registryDefId: string,
  applicationId: string,
  name: string,
  config: unknown,
  isDefault = false,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.list_view
       (tenant_id, id, registry_def_id, application_id, type, name, is_default,
        config, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4, 'list', $5, $6, $7::jsonb, 0, 0, 'seed')`,
    [tenantId, id, registryDefId, applicationId, name, isDefault, JSON.stringify(config)],
  );
  await c.query('COMMIT');
  return id;
}

function makeProdShapedResolver(pool: pg.Pool): ReadVisibilityResolver {
  return async (actorSlug: string, tenantId: string, nowMs: number) => {
    const [grants, orgOracle] = await Promise.all([
      getGrantsForSubject(pool, tenantId, actorSlug, nowMs),
      loadTenantOrgAncestry(pool, tenantId),
    ]);
    return { grants, ancestry: makeResourceAncestryOracle(orgOracle, new Map<string, RowAncestry>()) };
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpReq(
  baseUrl: string,
  method: string,
  path: string,
  actor: string,
  body?: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const headers: Record<string, string> = { 'x-dev-user': actor };
    if (buf) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(buf.length);
    }
    const req = http.request(url, { method, headers }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
      });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let appPool: pg.Pool;
let server: http.Server;
let baseUrl = '';

let TENANT_A: string;
let TENANT_B: string;
let appAId = '';
let regAId = '';
let appBId = '';
let regBId = '';

let recordOpenHigh = ''; // amount=200000, status=open
let recordOpenLow = '';  // amount=9000,   status=open (numeric-sort probe, R-3)
let recordWon = '';      // amount=50000,  status=won
let recordNoAmount = ''; // status=open, amount ABSENT (R-4 probe)

let viewOpenSortDesc = ''; // filter status=open, sort amount desc

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug.startsWith('a-')) return TENANT_A;
  if (slug.startsWith('b-')) return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(
  requireDb(async () => {
    TENANT_A = uuid();
    TENANT_B = uuid();

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, TENANT_A);
      await seedTenantRow(c, TENANT_B);

      appAId = await seedApp(c, TENANT_A, `lv-app-a-${TENANT_A.slice(0, 8)}`);
      regAId = await seedRegDef(c, TENANT_A, appAId, `lv-reg-a-${TENANT_A.slice(0, 8)}`);
      appBId = await seedApp(c, TENANT_B, `lv-app-b-${TENANT_B.slice(0, 8)}`);
      regBId = await seedRegDef(c, TENANT_B, appBId, `lv-reg-b-${TENANT_B.slice(0, 8)}`);

      recordOpenHigh = await seedRecord(c, TENANT_A, regAId, { amount: 200000, status: 'open', notes: 'big deal' });
      recordOpenLow = await seedRecord(c, TENANT_A, regAId, { amount: 9000, status: 'open', notes: 'small deal' });
      recordWon = await seedRecord(c, TENANT_A, regAId, { amount: 50000, status: 'won', notes: 'closed' });
      recordNoAmount = await seedRecord(c, TENANT_A, regAId, { status: 'open' }); // amount key absent

      // READ-PDP: default-open root-sentinel grant for tenant A's role, so the
      // gated server variant sees all four seeded rows unless narrowed further.
      const empA = await seedEmployee(c, TENANT_A, 'a-reader');
      const roleA = await seedRole(c, TENANT_A, 'lv-role-reader');
      await seedAssignment(c, TENANT_A, empA, roleA);
      await seedReadGrant(c, TENANT_A, roleA, rootScope());

      // A second, NARROWED actor: only recordOpenHigh is in their READ grant.
      const empANarrow = await seedEmployee(c, TENANT_A, 'a-narrow');
      const roleANarrow = await seedRole(c, TENANT_A, 'lv-role-narrow');
      await seedAssignment(c, TENANT_A, empANarrow, roleANarrow);
      await seedReadGrant(c, TENANT_A, roleANarrow, recordScope(recordOpenHigh));

      viewOpenSortDesc = await seedListView(
        c, TENANT_A, regAId, appAId, 'Open deals by amount desc',
        { filters: [{ field_key: 'status', op: 'eq', value: 'open' }], sort: [{ field_key: 'amount', dir: 'desc' }] },
      );
    });

    appPool = new pg.Pool({ connectionString: appUrl() });
    const router = new Router();
    registerRecordRoutes(router, {
      pool: appPool,
      resolveActorTenant: stubResolveActorTenant,
      resolveReadVisibility: makeProdShapedResolver(appPool),
    });
    registerListViewRoutes(router, {
      pool: appPool,
      resolveActorTenant: stubResolveActorTenant,
      resolveActorPrivilege: async () => ({ isOwnerOrAdmin: true, hasAuthoringDraftGrant: false }),
    });
    server = http.createServer((req, res) => router.dispatch(req, res));
    baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, 'localhost', () => {
        const addr = server.address();
        resolve(addr && typeof addr !== 'string' ? `http://localhost:${addr.port}` : '');
      });
    });
  }),
  60_000,
);

afterAll(
  requireDb(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (appPool) await appPool.end();
    // Coherence hygiene (bundle-coherence.test.ts FF-13 scans ALL grants in the
    // shared per-run database, not tenant-scoped): the narrow record-scoped READ
    // grant seeded above for 'a-narrow' (seedReadGrant + recordScope) carries
    // resource_facet=NULL by construction (mirrors records-read-pdp.db.test.ts's
    // identical seeding pattern) — a shape FF-13 legitimately flags as "hanging"
    // outside the sanctioned default-open-root-sentinel carve-out. Delete this
    // suite's own grant/role_assignment/role/employee/tenant rows so no residue
    // survives into a later file's FF-13 scan within the same shared clone
    // (T-0147 isolation is per-run, not per-file).
    await withClient(migratorUrl(), async (c) => {
      for (const tenantId of [TENANT_A, TENANT_B]) {
        if (!tenantId) continue;
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query('DELETE FROM choros."grant" WHERE tenant_id = $1', [tenantId]);
        await c.query('DELETE FROM choros.role_assignment WHERE tenant_id = $1', [tenantId]);
        await c.query('DELETE FROM choros.role WHERE tenant_id = $1', [tenantId]);
        await c.query('DELETE FROM choros.employee WHERE tenant_id = $1', [tenantId]);
        await c.query('COMMIT');
      }
    });
  }),
);

describe.skipIf(!hasDb)('T-0581 view-registry — LIVE Postgres proofs', () => {
  it('AC-3/R-3: view_id filter+sort returns ONLY matching rows, numeric-sorted (200000 before 9000)', async () => {
    const { statusCode, body } = await httpReq(
      baseUrl, 'GET', `/api/records?application_id=${appAId}&registry_def_id=${regAId}&view_id=${viewOpenSortDesc}`, 'a-reader',
    );
    expect(statusCode).toBe(200);
    const ids = (body['records'] as Array<Record<string, unknown>>).map((r) => r['id']);
    // Only 'open' rows: recordOpenHigh, recordOpenLow, recordNoAmount (status open, amount absent).
    expect(ids).toContain(recordOpenHigh);
    expect(ids).toContain(recordOpenLow);
    expect(ids).not.toContain(recordWon);
    // Numeric sort DESC: 200000 (recordOpenHigh) before 9000 (recordOpenLow) —
    // a plain string sort would have put "9000" BEFORE "200000" (R-3 proof).
    const highIdx = ids.indexOf(recordOpenHigh);
    const lowIdx = ids.indexOf(recordOpenLow);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('R-4: is_empty on amount matches the row where the key is ABSENT', async () => {
    const filter = b64([{ field_key: 'amount', op: 'is_empty', value: null }]);
    const { statusCode, body } = await httpReq(
      baseUrl, 'GET', `/api/records?application_id=${appAId}&registry_def_id=${regAId}&filter=${filter}`, 'a-reader',
    );
    expect(statusCode).toBe(200);
    const ids = (body['records'] as Array<Record<string, unknown>>).map((r) => r['id']);
    expect(ids).toContain(recordNoAmount);
    expect(ids).not.toContain(recordOpenHigh);
    expect(ids).not.toContain(recordOpenLow);
    expect(ids).not.toContain(recordWon);
  });

  it('R-4: gt on amount never matches the row where the key is ABSENT (standard SQL NULL semantics)', async () => {
    const filter = b64([{ field_key: 'amount', op: 'gt', value: 0 }]);
    const { body } = await httpReq(
      baseUrl, 'GET', `/api/records?application_id=${appAId}&registry_def_id=${regAId}&filter=${filter}`, 'a-reader',
    );
    const ids = (body['records'] as Array<Record<string, unknown>>).map((r) => r['id']);
    expect(ids).not.toContain(recordNoAmount);
    expect(ids).toContain(recordOpenHigh);
  });

  it('AC-9: GET /api/records with NO view params returns the full unfiltered set (backcompat)', async () => {
    const { statusCode, body } = await httpReq(
      baseUrl, 'GET', `/api/records?application_id=${appAId}&registry_def_id=${regAId}`, 'a-reader',
    );
    expect(statusCode).toBe(200);
    const ids = (body['records'] as Array<Record<string, unknown>>).map((r) => r['id']);
    expect(ids).toContain(recordOpenHigh);
    expect(ids).toContain(recordOpenLow);
    expect(ids).toContain(recordWon);
    expect(ids).toContain(recordNoAmount);
  });

  it('AC-6: READ-PDP still gates the view-filtered page — narrowed actor sees only their covered row', async () => {
    const { statusCode, body } = await httpReq(
      baseUrl, 'GET', `/api/records?application_id=${appAId}&registry_def_id=${regAId}&view_id=${viewOpenSortDesc}`, 'a-narrow',
    );
    expect(statusCode).toBe(200);
    const ids = (body['records'] as Array<Record<string, unknown>>).map((r) => r['id']);
    // recordOpenLow matches the filter (status=open) but a-narrow's grant only
    // covers recordOpenHigh — PDP excludes it even though SQL matched it.
    expect(ids).toEqual([recordOpenHigh]);
  });

  it('AC-2: list_view of tenant A is invisible to tenant B (GET by id → 404)', async () => {
    const { statusCode } = await httpReq(baseUrl, 'GET', `/api/list-views/${viewOpenSortDesc}`, 'b-anyone'.replace('anyone', 'reader'));
    // stubResolveActorTenant maps 'b-*' → TENANT_B; the view belongs to TENANT_A.
    expect(statusCode).toBe(404);
  });

  it('AC-2: list_view of tenant A cannot be deleted from tenant B (RLS-filtered → 404, row survives)', async () => {
    const { statusCode } = await httpReq(baseUrl, 'DELETE', `/api/list-views/${viewOpenSortDesc}`, 'b-reader');
    expect(statusCode).toBe(404);

    // Verify (migrator role) the row still exists in tenant A.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const res = await c.query('SELECT 1 FROM choros.list_view WHERE tenant_id = $1 AND id = $2', [TENANT_A, viewOpenSortDesc]);
      expect(res.rowCount).toBe(1);
      await c.query('COMMIT');
    });
  });

  it('AC-10: the partial unique index rejects a second is_default=true on the same (tenant, registry_def_id)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(
        `INSERT INTO choros.list_view
           (tenant_id, id, registry_def_id, application_id, type, name, is_default, config, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4, 'list', 'default-1', true, '{}'::jsonb, 0, 0, 'seed')`,
        [TENANT_A, uuid(), regAId, appAId],
      );
      await c.query('COMMIT');

      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(
          `INSERT INTO choros.list_view
             (tenant_id, id, registry_def_id, application_id, type, name, is_default, config, created_at, updated_at, created_by)
           VALUES ($1, $2, $3, $4, 'list', 'default-2', true, '{}'::jsonb, 0, 0, 'seed')`,
          [TENANT_A, uuid(), regAId, appAId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await c.query('ROLLBACK');
    });
  });

  // T-0653 (fix-forward defect #9): the name-uniqueness constraint is now
  // SCOPED by (tenant, source, registry_def, owner_actor) — migration 130
  // replaced the old table-level UNIQUE (tenant_id, registry_def_id, name) that
  // ignored the owner. Two DIFFERENT actors may name their PERSONAL views the
  // same (a name only they can see); a duplicate WITHIN one owner still 23505s.
  it('defect #9: two owners can reuse the same personal-view name; same-owner dup → 23505', async () => {
    await withClient(migratorUrl(), async (c) => {
      const insertPersonal = (owner: string, name: string) =>
        c.query(
          `INSERT INTO choros.list_view
             (tenant_id, id, registry_def_id, application_id, source, owner_actor,
              type, name, is_default, config, created_at, updated_at, created_by)
           VALUES ($1, $2, $3, $4, 'records', $5, 'list', $6, false, '{}'::jsonb, 0, 0, $5)`,
          [TENANT_A, uuid(), regAId, appAId, owner, name],
        );

      // Actor A's personal view named "Мой вид" — succeeds.
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await insertPersonal('a-owner-1', 'Мой вид');
      await c.query('COMMIT');

      // Actor B's personal view with the SAME name on the SAME registry_def —
      // must ALSO succeed (owner is part of the uniqueness key now).
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(insertPersonal('a-owner-2', 'Мой вид')).resolves.toBeTruthy();
      await c.query('COMMIT');

      // A duplicate WITHIN owner a-owner-1 → 23505 (the scoped unique still bites).
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(insertPersonal('a-owner-1', 'Мой вид')).rejects.toMatchObject({ code: '23505' });
      await c.query('ROLLBACK');

      // Cleanup this test's rows so they don't pollute later scans.
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(`DELETE FROM choros.list_view WHERE tenant_id = $1 AND owner_actor IN ('a-owner-1','a-owner-2')`, [TENANT_A]);
      await c.query('COMMIT');
    });
  });

  // AC-13/NF-6 (tester-added, T-0581 TEST phase): the unit tests in
  // src/core/__tests__/view-query.test.ts already prove the PURE translator
  // never string-interpolates a hostile field_key/value into SQL — but that
  // is a proof against the translator in isolation. This test fires the SAME
  // hostile payloads through the REAL HTTP endpoint against the REAL Postgres
  // (not a stub/fake pool) and asserts the table survives and ordinary data
  // is still readable afterward — the strongest available proof that no
  // second, less-careful code path reintroduces string-concatenated SQL
  // between the HTTP boundary and the translator.
  it('AC-13/NF-6 LIVE: a SQL-injection-shaped field_key/value in ?filter= does not corrupt or drop data', async () => {
    // Hostile field_key: not a real record_schema key, contains SQL metachars
    // that would matter if ever concatenated raw into a WHERE/ORDER BY clause.
    const hostileFieldKey = "amount'; DROP TABLE choros.list_view; --";
    const hostileValue = "x'); DELETE FROM choros.record WHERE tenant_id = 'x"; // also SQLi-shaped
    const filter = b64([{ field_key: hostileFieldKey, op: 'eq', value: hostileValue }]);

    const { statusCode, body } = await httpReq(
      baseUrl,
      'GET',
      `/api/records?application_id=${appAId}&registry_def_id=${regAId}&filter=${filter}`,
      'a-reader',
    );
    // A hostile-but-unknown field_key is dropped by the whitelist (translateFilters)
    // — the request must NOT 500/error; it degrades to "no filter applied" (all
    // tenant-A records visible to a-reader's root-sentinel grant), never a crash.
    expect(statusCode).toBe(200);
    const ids = (body['records'] as Array<Record<string, unknown>>).map((r) => r['id']);
    expect(ids).toContain(recordOpenHigh);
    expect(ids).toContain(recordOpenLow);
    expect(ids).toContain(recordWon);
    expect(ids).toContain(recordNoAmount);

    // Also probe a hostile VALUE against a REAL whitelisted field_key (status) —
    // this exercises the bind-parameter path end-to-end against live PG: if the
    // value were ever concatenated raw, this would either error out or mutate
    // data; a parameterized query simply finds zero matches (no row has that
    // literal string as its status) and returns 200 with an empty page.
    const filterRealField = b64([{ field_key: 'status', op: 'eq', value: hostileValue }]);
    const res2 = await httpReq(
      baseUrl,
      'GET',
      `/api/records?application_id=${appAId}&registry_def_id=${regAId}&filter=${filterRealField}`,
      'a-reader',
    );
    expect(res2.statusCode).toBe(200);
    expect((res2.body['records'] as unknown[]).length).toBe(0);

    // PROOF OF NO CORRUPTION: choros.list_view and choros.record both still
    // exist with their expected row counts (the DROP TABLE / DELETE payloads
    // above did NOT execute as SQL — they were only ever bind-parameter text).
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const viewStillThere = await c.query(
        'SELECT 1 FROM choros.list_view WHERE tenant_id = $1 AND id = $2',
        [TENANT_A, viewOpenSortDesc],
      );
      expect(viewStillThere.rowCount).toBe(1);
      const recordsStillThere = await c.query(
        'SELECT count(*)::int AS n FROM choros.record WHERE tenant_id = $1 AND registry_id = $2',
        [TENANT_A, regAId],
      );
      // All 4 seeded records (recordOpenHigh/Low/Won/NoAmount) must still exist —
      // a successful injected DELETE would have dropped this below 4.
      expect(recordsStillThere.rows[0]!.n).toBeGreaterThanOrEqual(4);
      await c.query('COMMIT');
    });
  });
});
