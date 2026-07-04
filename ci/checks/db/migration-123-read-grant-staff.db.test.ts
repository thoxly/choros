// ci/checks/db/migration-123-read-grant-staff.db.test.ts — T-0619
// (ADR-T0619 §2.4, FF-619-4/FF-619-5/FF-619-7)
//
// Run in the `db` CI job / locally (solo — no parallel):
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//     npm run fitness:db
//
// migrations/123_read_grant_all_staff_backfill.sql extends the covering READ
// grant (role-reader) to EVERY EXISTING human staff member of EVERY tenant —
// not just the owner. Before this migration a rank-and-file human hired before
// the release held NO covering READ grant → src/http/records.ts served an empty
// LIST / 404 DETAIL (LIVE_PROOF wave 2). This file proves, against the REAL
// choros_app (NOBYPASSRLS) role and the production-shaped READ-PDP resolver:
//
//   FF-619-4 (AC): a rank-and-file human seeded WITHOUT a role-reader
//     assignment sees ZERO records before the migration (404 DETAIL); AFTER the
//     migration it reads records (200). Re-running the migration is a no-op
//     (WHERE NOT EXISTS) — no duplicate assignment. An AGENT is NOT assigned
//     role-reader (§2.2 boundary — agents keep their own grant circuit).
//   FF-619-5 (§2.4/NF-3): tenant isolation is NOT weakened — the backfilled
//     tenant-A human cannot see tenant-B records (RLS is primary; the grant is
//     tenant-scoped, its RESOURCE_ROOT nodeId carries no tenant identity).
//   FF-619-7 (static): the migration has NO literal tenant UUID (comments
//     stripped) and is driven by FROM choros.tenant / FROM choros.employee.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';
import type { ReadVisibilityResolver } from '../../../src/http/records.js';
import { getGrantsForSubject } from '../../../src/db/grants-dao.js';
import { loadTenantOrgAncestry } from '../../../src/db/org-ancestry.js';
import { makeResourceAncestryOracle } from '../../../src/db/resource-ancestry.js';
import { RESOURCE_ROOT_NODE_ID, READER_ROLE_SLUG, type RowAncestry } from '../../../src/core/read-visibility.js';

const LIVE = !!process.env['DATABASE_URL'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_123_PATH = path.resolve(HERE, '../../../migrations/123_read_grant_all_staff_backfill.sql');

// Slugs used as x-dev-user actors; resolveActorTenant maps them to their tenant.
const HUMAN_A_SLUG = 'a-t0619-staff-human';
const AGENT_A_SLUG = 'a-t0619-staff-agent';

// ---------------------------------------------------------------------------
// Seed: a "pre-fix" tenant — owner (with role-reader + grant, like migration
// 117 gave), a rank-and-file human WITHOUT a role-reader assignment, and an
// agent employee. Plus one record. Mirrors migration-118 / records-read-pdp
// seed helpers.
// ---------------------------------------------------------------------------

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedEmployee(c: pg.Client, tenantId: string, slug: string, kind: 'human' | 'agent'): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4, $4, 0, 0)`,
    [tenantId, id, kind, slug],
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
     VALUES ($1, $2, $3, $3, 0, 0) ON CONFLICT (tenant_id, slug) DO NOTHING`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM choros.role WHERE tenant_id=$1 AND slug=$2`, [tenantId, slug],
  );
  return rows[0]!.id;
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

async function seedReaderGrant(c: pg.Client, tenantId: string, roleId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
        "constraint", delegable, granted_by, proposed_by, confirmed_by,
        valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'record', NULL, 'read', $4::jsonb,
             NULL, true, 'seed', NULL, 'seed', NULL, NULL, 0)`,
    [tenantId, uuid(), roleId,
     JSON.stringify({ kind: 'node', hierarchy: 'resource', nodeLevel: 'application', nodeId: RESOURCE_ROOT_NODE_ID })],
  );
  await c.query('COMMIT');
}

async function seedApp(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 'published', 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegDef(c: pg.Client, tenantId: string, appId: string, slug: string): Promise<string> {
  const id = uuid();
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false };
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
    [tenantId, id, appId, slug, JSON.stringify(schema)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecord(c: pg.Client, tenantId: string, registryId: string, name: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, 'seed')`,
    [tenantId, id, registryId, JSON.stringify({ name })],
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

function getRecordDetail(baseUrl: string, recordId: string, actor: string):
  Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records/${recordId}`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

function getRecords(baseUrl: string, actor: string):
  Promise<{ statusCode: number; ids: string[] }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      let raw = '';
      res.on('data', (ch: Buffer) => { raw += ch.toString(); });
      res.on('end', () => {
        const b = JSON.parse(raw || '{}') as Record<string, unknown>;
        const recs = (b['records'] as Array<Record<string, unknown>>) ?? [];
        resolve({ statusCode: res.statusCode ?? 0, ids: recs.map((r) => r['id'] as string) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function readerAssignmentCount(c: pg.Client, tenantId: string, empId: string): Promise<number> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  const { rows } = await c.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM choros.role_assignment ra
       JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
      WHERE ra.tenant_id = $1 AND ra.employee_id = $2 AND r.slug = $3
        AND ra.confirmed_by IS NOT NULL`,
    [tenantId, empId, READER_ROLE_SLUG],
  );
  await c.query('COMMIT');
  return rows[0]!.n;
}

describe.skipIf(!LIVE)('T-0619 — migration 123 backfills covering READ to all human staff (live Postgres)', () => {
  let migPool: pg.Pool;
  let appPool: pg.Pool;
  let migrationSql: string;
  let readServer: http.Server;
  let readBase = '';

  const TENANT_A = uuid();
  const TENANT_B = uuid();
  let humanAId = '';
  let agentAId = '';
  let ownerAId = '';
  let recordAId = '';
  let recordBId = '';

  async function resolveActorTenant(slug: string): Promise<string> {
    if (slug.startsWith('a-')) return TENANT_A;
    if (slug.startsWith('b-')) return TENANT_B;
    throw new Error(`unknown test actor: ${slug}`);
  }

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
    appPool = new pg.Pool({ connectionString: appUrl() });
    migrationSql = fs.readFileSync(MIGRATION_123_PATH, 'utf-8');

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, TENANT_A);
      await seedTenantRow(c, TENANT_B);
      // Tenant A: owner already has role-reader + grant (like migration 117);
      // a rank-and-file human has NO reader assignment; an agent exists.
      ownerAId = await seedEmployee(c, TENANT_A, 'a-t0619-owner', 'human');
      const readerRoleA = await seedRole(c, TENANT_A, READER_ROLE_SLUG);
      await seedAssignment(c, TENANT_A, ownerAId, readerRoleA);
      await seedReaderGrant(c, TENANT_A, readerRoleA);

      humanAId = await seedEmployee(c, TENANT_A, HUMAN_A_SLUG, 'human');
      agentAId = await seedEmployee(c, TENANT_A, AGENT_A_SLUG, 'agent');

      const appAId = await seedApp(c, TENANT_A, `t0619-app-a-${uuid().slice(0, 8)}`);
      const regAId = await seedRegDef(c, TENANT_A, appAId, `t0619-reg-a-${uuid().slice(0, 8)}`);
      recordAId = await seedRecord(c, TENANT_A, regAId, 'record-a');

      // Tenant B: its own record (for the isolation check).
      const appBId = await seedApp(c, TENANT_B, `t0619-app-b-${uuid().slice(0, 8)}`);
      const regBId = await seedRegDef(c, TENANT_B, appBId, `t0619-reg-b-${uuid().slice(0, 8)}`);
      recordBId = await seedRecord(c, TENANT_B, regBId, 'record-b');
    });

    const router = new Router();
    registerRecordRoutes(router, {
      pool: appPool,
      resolveActorTenant,
      resolveReadVisibility: makeProdShapedResolver(appPool),
    });
    readServer = http.createServer((req, res) => router.dispatch(req, res));
    readBase = await new Promise<string>((resolve) => {
      readServer.listen(0, '127.0.0.1', () => {
        const a = readServer.address();
        resolve(a && typeof a !== 'string' ? `http://127.0.0.1:${a.port}` : '');
      });
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    await new Promise<void>((resolve) => readServer?.close(() => resolve()));
    await withClient(migratorUrl(), async (c) => {
      for (const t of [TENANT_A, TENANT_B]) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
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
    await migPool?.end();
    await appPool?.end();
  });

  it('FF-619-7 static: migration 123 has no literal tenant UUID and iterates FROM choros.tenant / employee', () => {
    const uuidRe = /'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'/;
    const codeOnly = migrationSql.replace(/--.*$/gm, '');
    // The ONLY UUID-shaped literal allowed is the RESOURCE_ROOT sentinel (non-hex
    // 'r' — never a real tenant id); assert no OTHER tenant-shaped literal exists.
    const hits = codeOnly.match(new RegExp(uuidRe.source, 'g')) ?? [];
    expect(hits, `unexpected tenant-shaped UUID literal(s): ${hits.join(', ')}`).toHaveLength(0);
    expect(migrationSql).toMatch(/FROM\s+choros\.tenant/i);
    expect(migrationSql).toMatch(/FROM\s+choros\.employee/i);
  });

  it('the rank-and-file human genuinely lacks a covering READ grant before the migration (404)', async () => {
    const before = await getRecordDetail(readBase, recordAId, HUMAN_A_SLUG);
    expect(before.statusCode, 'a staff human without role-reader must 404 before the backfill').toBe(404);

    const grants = await getGrantsForSubject(appPool, TENANT_A, HUMAN_A_SLUG, Date.now());
    expect(grants.filter((g) => g.operation === 'read' && g.resourceType === 'record')).toHaveLength(0);
  });

  it('FF-619-4: after migration 123 the rank-and-file human reads records (200); idempotent; agent NOT assigned', async () => {
    await migPool.query(migrationSql);

    // The human now holds exactly ONE confirmed role-reader assignment.
    const cnt = await withClient(migratorUrl(), (c) => readerAssignmentCount(c, TENANT_A, humanAId));
    expect(cnt, 'backfill must assign the staff human to role-reader exactly once').toBe(1);

    // End-to-end read now succeeds.
    const detail = await getRecordDetail(readBase, recordAId, HUMAN_A_SLUG);
    expect(detail.statusCode, 'staff human must read the record after the backfill').toBe(200);
    const list = await getRecords(readBase, HUMAN_A_SLUG);
    expect(list.statusCode).toBe(200);
    expect(list.ids).toContain(recordAId);

    // §2.2 boundary: the AGENT was NOT assigned role-reader.
    const agentCnt = await withClient(migratorUrl(), (c) => readerAssignmentCount(c, TENANT_A, agentAId));
    expect(agentCnt, 'a kind=agent employee must NOT get role-reader from the backfill').toBe(0);

    // Idempotent: a second (and third) run adds no duplicate assignment.
    await migPool.query(migrationSql);
    await migPool.query(migrationSql);
    const cntAfter = await withClient(migratorUrl(), (c) => readerAssignmentCount(c, TENANT_A, humanAId));
    expect(cntAfter, 'a re-run must not plant a duplicate role-reader assignment').toBe(1);

    // Owner (already had role-reader) is untouched — still exactly one.
    const ownerCnt = await withClient(migratorUrl(), (c) => readerAssignmentCount(c, TENANT_A, ownerAId));
    expect(ownerCnt).toBe(1);
  });

  it('FF-619-5: tenant isolation is NOT weakened — backfilled tenant-A human cannot read tenant-B records', async () => {
    // The migration ran in the previous test; the tenant-A human holds role-reader.
    const list = await getRecords(readBase, HUMAN_A_SLUG);
    expect(list.statusCode).toBe(200);
    expect(list.ids, 'tenant-B record must never appear for a tenant-A actor').not.toContain(recordBId);

    const detail = await getRecordDetail(readBase, recordBId, HUMAN_A_SLUG);
    expect(detail.statusCode, 'cross-tenant DETAIL must 404 (RLS primary)').toBe(404);
  });
});
