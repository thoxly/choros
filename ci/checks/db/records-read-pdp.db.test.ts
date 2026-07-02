// T-0570 (D3, READ-PDP) · records LIST/DETAIL grant-resolver visibility — LIVE
// Postgres probe.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// PROVES against the REAL choros_app (NOBYPASSRLS) role — the production RLS
// path, not a query-filter shim — that:
//
//   FF-RP-3 (AC-3, backfill does not break existing visibility): for a tenant
//     that HELD a covering READ grant on a record BEFORE the READ-PDP gate is
//     wired (honest-degrade path, resolveReadVisibility absent), the actor
//     sees the record; AFTER the gate is wired (resolveReadVisibility present,
//     mirroring migration 117's backfilled default-open grant), the SAME actor
//     still sees the SAME record — no visibility regression on activation.
//
//   FF-RP-1/FF-RP-2 (AC-1/AC-2): an actor with ZERO covering READ grant sees
//     an empty list and gets 404 on detail — fail-closed, not fail-open.
//
//   FF-RP-5 (AC-5): a narrower, record-scoped grant (via the REAL grants-dao
//     read path, not a stub) restricts one actor to a subset while another
//     actor with the wide default-open grant still sees every record.
//
//   FF-RP-12 (AC-10, NF-3): tenant isolation is NOT weakened by the READ-PDP
//     gate — an actor of tenant A, even holding a hypothetically wide grant,
//     cannot see tenant B's records (RLS + explicit tenant filter remain the
//     FIRST, unconditional gate; PDP is additive on top).
//
// resolveReadVisibility here mirrors the PRODUCTION wiring in server.ts:
// getGrantsForSubject (real DAO, real SQL) + makeResourceAncestryOracle over
// loadTenantOrgAncestry (real per-tenant org tree, empty here) — the SAME
// composition, not a stub PDP.
//
// Seeding goes through migratorUrl() (BYPASSRLS); the route calls run through
// a choros_app Pool (RLS-enforced) so SET LOCAL choros.tenant_id scoping is
// the real production path. Fresh per-test tenant UUIDs (never the shared
// TENANT_A/TENANT_B from _helpers.ts) keep rows off other suites' fixtures.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';
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
  properties: { name: { type: 'string', title: 'Name' } },
  required: ['name'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Seed helpers (migrator role; SET LOCAL tenant for the RLS WITH CHECK).
// ---------------------------------------------------------------------------

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
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

async function seedRecord(c: pg.Client, tenantId: string, registryId: string, name: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, 'seed')`,
    [tenantId, id, registryId, JSON.stringify({ name })],
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

/** scope = RESOURCE_ROOT sentinel (the default-open grant, ADR §2.1 rule 2). */
function rootScope(): unknown {
  return { kind: 'node', hierarchy: 'resource', nodeLevel: 'application', nodeId: RESOURCE_ROOT_NODE_ID };
}

/** scope = a specific record node (narrow grant, ADR §2.1 rule 1 self-match). */
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

// ---------------------------------------------------------------------------
// The production-shaped resolveReadVisibility (mirrors server.ts wiring).
// ---------------------------------------------------------------------------

function makeProdShapedResolver(pool: pg.Pool): ReadVisibilityResolver {
  return async (actorSlug: string, tenantId: string, nowMs: number) => {
    const [grants, orgOracle] = await Promise.all([
      getGrantsForSubject(pool, tenantId, actorSlug, nowMs),
      loadTenantOrgAncestry(pool, tenantId),
    ]);
    return {
      grants,
      ancestry: makeResourceAncestryOracle(orgOracle, new Map<string, RowAncestry>()),
    };
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getRecords(
  baseUrl: string,
  actor: string,
): Promise<{ statusCode: number; records: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        resolve({
          statusCode: res.statusCode ?? 0,
          records: (body['records'] as Array<Record<string, unknown>>) ?? [],
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getRecordDetail(
  baseUrl: string,
  recordId: string,
  actor: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records/${recordId}`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server fixtures — one server WITHOUT resolveReadVisibility (pre-gate,
// honest-degrade) and one WITH it (post-gate, production-shaped resolver).
// ---------------------------------------------------------------------------

let appPool: pg.Pool;
let serverPreGate: http.Server;
let serverPostGate: http.Server;
let basePreGate = '';
let basePostGate = '';

let TENANT_A: string;
let TENANT_B: string;

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug.startsWith('a-')) return TENANT_A;
  if (slug.startsWith('b-')) return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

async function startServer(withGate: boolean): Promise<{ server: http.Server; baseUrl: string }> {
  const router = new Router();
  registerRecordRoutes(router, {
    pool: appPool,
    resolveActorTenant: stubResolveActorTenant,
    ...(withGate ? { resolveReadVisibility: makeProdShapedResolver(appPool) } : {}),
  });
  const srv = http.createServer((req, res) => router.dispatch(req, res));
  const baseUrl = await new Promise<string>((resolve) => {
    srv.listen(0, 'localhost', () => {
      const addr = srv.address();
      resolve(addr && typeof addr !== 'string' ? `http://localhost:${addr.port}` : '');
    });
  });
  return { server: srv, baseUrl };
}

// Fixtures.
let appAId = '';
let regAId = '';
let record1Id = '';
let record2Id = '';
let appBId = '';
let regBId = '';
let recordBId = '';

beforeAll(
  requireDb(async () => {
    TENANT_A = uuid();
    TENANT_B = uuid();
    appPool = new pg.Pool({ connectionString: appUrl() });

    const pre = await startServer(false);
    serverPreGate = pre.server;
    basePreGate = pre.baseUrl;
    const post = await startServer(true);
    serverPostGate = post.server;
    basePostGate = post.baseUrl;

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, TENANT_A);
      await seedTenantRow(c, TENANT_B);

      appAId = await seedApp(c, TENANT_A, `rp-app-a-${uuid().slice(0, 8)}`);
      regAId = await seedRegDef(c, TENANT_A, appAId, `rp-reg-a-${uuid().slice(0, 8)}`);
      record1Id = await seedRecord(c, TENANT_A, regAId, 'record-one');
      record2Id = await seedRecord(c, TENANT_A, regAId, 'record-two');

      appBId = await seedApp(c, TENANT_B, `rp-app-b-${uuid().slice(0, 8)}`);
      regBId = await seedRegDef(c, TENANT_B, appBId, `rp-reg-b-${uuid().slice(0, 8)}`);
      recordBId = await seedRecord(c, TENANT_B, regBId, 'record-b-one');
    });
  }),
);

afterAll(
  requireDb(async () => {
    await new Promise<void>((resolve) => serverPreGate?.close(() => resolve()));
    await new Promise<void>((resolve) => serverPostGate?.close(() => resolve()));

    await withClient(migratorUrl(), async (c) => {
      for (const t of [TENANT_A, TENANT_B]) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
        // T-0558: applications are seeded PUBLISHED; the tier_published_locked
        // trigger forbids DELETE of published config rows unless the
        // sanctioned-promote GUC is set (mirrors records_crud.test.ts afterAll).
        await c.query(`SET LOCAL choros.promoting = '1'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.record WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [t]);
        await c.query('COMMIT');
      }
      await c.query(`DELETE FROM choros.tenant WHERE id = ANY($1::uuid[])`, [[TENANT_A, TENANT_B]]);
    });
    await appPool?.end();
  }),
);

// ---------------------------------------------------------------------------
// FF-RP-1 / FF-RP-2 (AC-1 / AC-2): fail-closed with zero covering grant.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0570 FF-RP-1/FF-RP-2: fail-closed when actor holds ZERO covering READ grant', () => {
  it('LIST is empty and DETAIL is 404 for an actor with no employee/grant row at all', async () => {
    const { statusCode, records } = await getRecords(basePostGate, 'a-nogrant-actor');
    expect(statusCode).toBe(200);
    expect(records).toHaveLength(0);

    const detail = await getRecordDetail(basePostGate, record1Id, 'a-nogrant-actor');
    expect(detail.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// FF-RP-3 (AC-3): backfill does not regress existing (pre-gate) visibility.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0570 FF-RP-3: backfill preserves pre-gate visibility (AC-3)', () => {
  it('an actor who saw both records via the OLD (RLS-only) path still sees both AFTER the gate + default grant are wired', async () => {
    // Step "was": pre-gate server (honest-degrade, resolveReadVisibility absent)
    // — the actor sees both records regardless of any grant (old RLS-only path).
    const before = await getRecords(basePreGate, 'a-backfill-actor');
    expect(before.statusCode).toBe(200);
    expect(before.records.map((r) => r['id']).sort()).toEqual([record1Id, record2Id].sort());

    // Simulate the migration-117 backfill for this actor: employee + role-reader
    // + role_assignment + RESOURCE_ROOT-scoped read grant (byte-identical shape
    // to what registerTenant / migration 117 seed).
    await withClient(migratorUrl(), async (c) => {
      const empId = await seedEmployee(c, TENANT_A, 'a-backfill-actor');
      const roleId = await seedRole(c, TENANT_A, 'role-reader');
      await seedAssignment(c, TENANT_A, empId, roleId);
      await seedReadGrant(c, TENANT_A, roleId, rootScope());
    });

    // Step "остался": post-gate server (resolveReadVisibility wired, PDP active)
    // — the SAME actor sees the SAME two records, no regression.
    const after = await getRecords(basePostGate, 'a-backfill-actor');
    expect(after.statusCode).toBe(200);
    expect(after.records.map((r) => r['id']).sort()).toEqual([record1Id, record2Id].sort());
  });
});

// ---------------------------------------------------------------------------
// FF-RP-5 (AC-5): a narrower record-scoped grant restricts one actor to a
// subset while another actor with the wide default grant keeps seeing all.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0570 FF-RP-5: record-scoped narrow grant restricts one actor without affecting another (AC-5)', () => {
  it('actor with a grant scoped to record1 ONLY sees record1; actor with the default-open grant sees both', async () => {
    await withClient(migratorUrl(), async (c) => {
      // Narrow actor: covers ONLY record1Id (self-match rule).
      const narrowEmpId = await seedEmployee(c, TENANT_A, 'a-narrow-actor');
      const narrowRoleId = await seedRole(c, TENANT_A, 'role-narrow-570');
      await seedAssignment(c, TENANT_A, narrowEmpId, narrowRoleId);
      await seedReadGrant(c, TENANT_A, narrowRoleId, recordScope(record1Id));

      // Default-open actor: covers everything via the RESOURCE_ROOT sentinel.
      const wideEmpId = await seedEmployee(c, TENANT_A, 'a-wide-actor');
      const wideRoleId = await seedRole(c, TENANT_A, 'role-reader-wide-570');
      await seedAssignment(c, TENANT_A, wideEmpId, wideRoleId);
      await seedReadGrant(c, TENANT_A, wideRoleId, rootScope());
    });

    const narrow = await getRecords(basePostGate, 'a-narrow-actor');
    expect(narrow.statusCode).toBe(200);
    expect(narrow.records.map((r) => r['id'])).toEqual([record1Id]);

    const wide = await getRecords(basePostGate, 'a-wide-actor');
    expect(wide.statusCode).toBe(200);
    expect(wide.records.map((r) => r['id']).sort()).toEqual([record1Id, record2Id].sort());

    // The narrow actor's DETAIL of the covered record succeeds; the uncovered
    // record 404s (indistinguishable from not-found, FR-5).
    const detailCovered = await getRecordDetail(basePostGate, record1Id, 'a-narrow-actor');
    expect(detailCovered.statusCode).toBe(200);
    const detailUncovered = await getRecordDetail(basePostGate, record2Id, 'a-narrow-actor');
    expect(detailUncovered.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// FF-RP-12 (AC-10, NF-3): tenant isolation is primary — RLS + explicit filter
// remain the first gate even under a wide READ-PDP grant.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0570 FF-RP-12: tenant isolation not weakened by READ-PDP (AC-10/NF-3)', () => {
  it('tenant A actor with a wide default-open grant cannot see tenant B records', async () => {
    await withClient(migratorUrl(), async (c) => {
      const empId = await seedEmployee(c, TENANT_A, 'a-cross-tenant-actor');
      const roleId = await seedRole(c, TENANT_A, 'role-reader-crosscheck-570');
      await seedAssignment(c, TENANT_A, empId, roleId);
      // Wide grant scoped in TENANT A only — RLS is what actually stops
      // cross-tenant reach (the nodeId itself carries no tenant identity,
      // ADR §2.1/NF-3), so this grant existing in A cannot leak into B.
      await seedReadGrant(c, TENANT_A, roleId, rootScope());
    });

    const list = await getRecords(basePostGate, 'a-cross-tenant-actor');
    expect(list.statusCode).toBe(200);
    // Only tenant A's own records are visible; tenant B's recordBId never appears.
    expect(list.records.map((r) => r['id'])).not.toContain(recordBId);

    // Direct detail lookup of the cross-tenant record id → 404 (RLS-filtered),
    // even though this actor holds a "wide" grant (scoped to tenant A only).
    const detail = await getRecordDetail(basePostGate, recordBId, 'a-cross-tenant-actor');
    expect(detail.statusCode).toBe(404);
  });
});
