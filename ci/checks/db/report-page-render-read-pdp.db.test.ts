// T-0632 (security, столп 4) · Floor-1 aggregate READ-PDP live probe.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// THE DEFECT (adversary finding T-0587, ADR-T0587 §1.1): `GET
// /api/report-pages/:id/render`'s Floor-1 aggregate (buildAggSql) used to
// compute SUM/COUNT/... as a raw SQL aggregate over EVERY record in a
// registry, gated ONLY by an application-level `checkReadGrant` — never a
// record-level READ-PDP check (isRecordReadable, T-0570). An actor holding a
// narrow record-scope READ grant (sees only a subset of a registry's rows)
// nonetheless received an aggregate computed over rows they cannot read
// individually.
//
// This live probe proves, against the REAL choros_app (RLS-enforced) role and
// the REAL src/server.ts composition root (createServer(), same
// resolveReadVisibility wiring as GET /api/records):
//
//   AC-T0632-1 (mutational): a narrow-grant actor's Floor-1 SUM is STRICTLY
//     LESS than the wide-grant actor's SUM over the SAME registry/page_def —
//     the narrow actor's aggregate never includes the hidden record's value.
//   AC-T0632-2: an actor holding the application-level read grant but ZERO
//     covering record-level grants sees an honest EMPTY aggregate
//     (count:0 / sum:0), not 403/500 and not the full registry total.
//   AC-T0632-3: genesis-owner (isGenesisOwner short-circuit) is UNAFFECTED —
//     still sees the FULL aggregate over every record (no regression).
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { createServer } from '../../../src/server.js';
import { resetRenderPoolForTesting } from '../../../src/http/report-page-render.js';
import { resetPoolForTesting } from '../../../src/http/report-pages.js';

const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!process.env['DATABASE_URL']) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'draft', 0, 0)`,
    [tenantId, id, `t0632-app-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegistryDef(c: pg.Client, tenantId: string, appId: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '{"properties":{"amount":{"type":"number","title":"Amount"}}}'::jsonb, 'draft', 0, 0)`,
    [tenantId, id, appId, `t0632-reg-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecord(c: pg.Client, tenantId: string, registryId: string, amount: number): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, 't0632-test')`,
    [tenantId, id, registryId, JSON.stringify({ amount })],
  );
  await c.query('COMMIT');
  return id;
}

async function seedFloor1SumPage(
  c: pg.Client,
  tenantId: string,
  appId: string,
  regId: string,
): Promise<string> {
  const id = uuid();
  const slug = `t0632-f1-${id.slice(0, 8)}`;
  const pageDef = JSON.stringify([
    { source_registry_def_id: regId, field_key: 'amount', agg: 'sum' },
  ]);
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.report_page
       (tenant_id, id, app_id, slug, title, floor, tier, page_def, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '1', 'draft', $5::jsonb, 0, 0)`,
    [tenantId, id, appId, slug, pageDef],
  );
  await c.query('COMMIT');
  return id;
}

async function seedFloor1CountPage(
  c: pg.Client,
  tenantId: string,
  appId: string,
  regId: string,
): Promise<string> {
  const id = uuid();
  const slug = `t0632-f1c-${id.slice(0, 8)}`;
  const pageDef = JSON.stringify([
    { source_registry_def_id: regId, field_key: 'amount', agg: 'count' },
  ]);
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.report_page
       (tenant_id, id, app_id, slug, title, floor, tier, page_def, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '1', 'draft', $5::jsonb, 0, 0)`,
    [tenantId, id, appId, slug, pageDef],
  );
  await c.query('COMMIT');
  return id;
}

async function seedFloor2Page(
  c: pg.Client,
  tenantId: string,
  appId: string,
): Promise<string> {
  const id = uuid();
  const slug = `t0632-f2-${id.slice(0, 8)}`;
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.report_page
       (tenant_id, id, app_id, slug, title, floor, tier, page_code, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '2', 'draft', 'export default function(){return null;}', 0, 0)`,
    [tenantId, id, appId, slug],
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

async function seedRole(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const slug = `t0632-role-${id.slice(0, 8)}`;
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'T-0632 test role', 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRoleAssignment(
  c: pg.Client,
  tenantId: string,
  employeeId: string,
  roleId: string,
): Promise<string> {
  const id = uuid();
  const orgScope = JSON.stringify({
    kind: 'node',
    hierarchy: 'org',
    nodeId: 'b0000000-0000-0000-0000-000000000001',
    nodeLevel: 'department',
  });
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
        source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'test', 'seed', NULL, 'seed', 0, 0)`,
    [tenantId, id, employeeId, roleId, orgScope],
  );
  await c.query('COMMIT');
  return id;
}

/** Application-level `read` grant scoped to a specific appId (T-0193 R-6 shape). */
async function seedApplicationReadGrant(
  c: pg.Client,
  tenantId: string,
  roleId: string,
  appId: string,
): Promise<string> {
  const id = uuid();
  const scope = JSON.stringify({
    kind: 'node',
    hierarchy: 'resource',
    nodeId: appId,
    nodeLevel: 'application',
  });
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable,
        granted_by, confirmed_by, valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'application', NULL, 'read', $4::jsonb, NULL, false, 'seed', 'seed', NULL, NULL, 0)`,
    [tenantId, id, roleId, scope],
  );
  await c.query('COMMIT');
  return id;
}

/**
 * Record-level `read` grant, narrowly scoped to ONE specific record id
 * (T-0570 self-match rule, ADR §2.1 rule 1 — mirrors records-read-pdp.db.test.ts's
 * `recordScope`). This is the grant shape a narrow READ-PDP actor holds.
 */
async function seedRecordReadGrant(
  c: pg.Client,
  tenantId: string,
  roleId: string,
  recordId: string,
): Promise<string> {
  const id = uuid();
  const scope = JSON.stringify({
    kind: 'node',
    hierarchy: 'resource',
    nodeId: recordId,
    nodeLevel: 'record',
  });
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable,
        granted_by, confirmed_by, valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'record', NULL, 'read', $4::jsonb, NULL, true, 'seed', 'seed', NULL, NULL, 0)`,
    [tenantId, id, roleId, scope],
  );
  await c.query('COMMIT');
  return id;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function makeRequest(
  baseUrl: string,
  path: string,
  actor: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'x-dev-user': actor },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server + cleanup tracking
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
const cleanupFns: Array<() => Promise<void>> = [];

function addCleanup(fn: () => Promise<void>): void {
  cleanupFns.push(fn);
}

if (process.env['DATABASE_URL']) {
  resetPoolForTesting();
  resetRenderPoolForTesting();
  server = createServer();
  server.listen(0, 'localhost');
  server.on('listening', () => {
    const addr = server.address();
    if (addr && typeof addr !== 'string') {
      baseUrl = `http://localhost:${addr.port}`;
    }
  });
}

afterAll(async () => {
  for (const fn of [...cleanupFns].reverse()) {
    try { await fn(); } catch (e) { console.warn('[cleanup error]', e); }
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// AC-T0632-1 (mutational): narrow record-scope grant → SUM strictly less than
// the wide-grant actor's SUM over the same registry/page.
// ---------------------------------------------------------------------------

describe('AC-T0632-1: narrow record-scope READ grant restricts the Floor-1 aggregate to the visible subset', () => {
  it('narrow-grant actor SUM < wide-grant actor SUM on the SAME page; narrow SUM equals only the covered record', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    const regId = await withClient(migratorUrl(), (c) => seedRegistryDef(c, tenantId, appId));

    let record1Id = '';
    let record2Id = '';
    let pageId = '';
    let narrowActor = '';
    let wideActor = '';
    let narrowEmpId = '';
    let wideEmpId = '';
    let narrowRoleId = '';
    let wideRoleId = '';
    let narrowRaId = '';
    let wideRaId = '';
    let narrowAppGrantId = '';
    let wideAppGrantId = '';
    let narrowRecordGrantId = '';
    let wideRecordGrant1Id = '';
    let wideRecordGrant2Id = '';

    await withClient(migratorUrl(), async (c) => {
      record1Id = await seedRecord(c, tenantId, regId, 100);
      record2Id = await seedRecord(c, tenantId, regId, 900); // the "hidden" record for the narrow actor
      pageId = await seedFloor1SumPage(c, tenantId, appId, regId);

      // Narrow actor: application-read grant (page visibility) + a SINGLE
      // record-scope READ grant covering ONLY record1Id (sees 1 of 2 rows).
      narrowActor = `t0632-narrow-${uuid().slice(0, 8)}`;
      narrowEmpId = await seedEmployee(c, tenantId, narrowActor);
      narrowRoleId = await seedRole(c, tenantId);
      narrowRaId = await seedRoleAssignment(c, tenantId, narrowEmpId, narrowRoleId);
      narrowAppGrantId = await seedApplicationReadGrant(c, tenantId, narrowRoleId, appId);
      narrowRecordGrantId = await seedRecordReadGrant(c, tenantId, narrowRoleId, record1Id);

      // Wide actor: application-read grant + record-scope READ grants covering
      // BOTH records (a non-owner, but "sees everything relevant" actor).
      wideActor = `t0632-wide-${uuid().slice(0, 8)}`;
      wideEmpId = await seedEmployee(c, tenantId, wideActor);
      wideRoleId = await seedRole(c, tenantId);
      wideRaId = await seedRoleAssignment(c, tenantId, wideEmpId, wideRoleId);
      wideAppGrantId = await seedApplicationReadGrant(c, tenantId, wideRoleId, appId);
      wideRecordGrant1Id = await seedRecordReadGrant(c, tenantId, wideRoleId, record1Id);
      wideRecordGrant2Id = await seedRecordReadGrant(c, tenantId, wideRoleId, record2Id);
    });

    const narrowResp = await makeRequest(baseUrl, `/api/report-pages/${pageId}/render`, narrowActor);
    expect(narrowResp.statusCode).toBe(200);
    const narrowBody = JSON.parse(narrowResp.body) as { metrics: Array<{ result: unknown }> };
    const narrowSum = Number(narrowBody.metrics[0]?.result ?? NaN);

    const wideResp = await makeRequest(baseUrl, `/api/report-pages/${pageId}/render`, wideActor);
    expect(wideResp.statusCode).toBe(200);
    const wideBody = JSON.parse(wideResp.body) as { metrics: Array<{ result: unknown }> };
    const wideSum = Number(wideBody.metrics[0]?.result ?? NaN);

    // THE mutational proof: the narrow actor's aggregate is STRICTLY LESS —
    // it must equal ONLY record1's value (100), never 100+900=1000. If the
    // record-level READ-PDP filter were absent (pre-T-0632 behavior), both
    // actors would see the SAME full-registry SUM (1000), and this assertion
    // would fail.
    expect(narrowSum).toBe(100);
    expect(wideSum).toBe(1000);
    expect(narrowSum).toBeLessThan(wideSum);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        for (const gid of [narrowAppGrantId, narrowRecordGrantId, wideAppGrantId, wideRecordGrant1Id, wideRecordGrant2Id]) {
          await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, gid]);
        }
        for (const raid of [narrowRaId, wideRaId]) {
          await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raid]);
        }
        for (const rid of [narrowRoleId, wideRoleId]) {
          await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, rid]);
        }
        for (const eid of [narrowEmpId, wideEmpId]) {
          await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, eid]);
        }
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND registry_id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// AC-T0632-2: application-read grant present, ZERO record-level covering
// grants → honest empty aggregate (count:0), not 403/500, not the full total.
// ---------------------------------------------------------------------------

describe('AC-T0632-2: zero covering record-level grants → honest empty aggregate', () => {
  it('actor with application-read grant but no record grant sees count:0 on a non-empty registry', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    const regId = await withClient(migratorUrl(), (c) => seedRegistryDef(c, tenantId, appId));

    let recordId = '';
    let pageId = '';
    let actorSlug = '';
    let empId = '';
    let roleId = '';
    let raId = '';
    let appGrantId = '';

    await withClient(migratorUrl(), async (c) => {
      recordId = await seedRecord(c, tenantId, regId, 500);
      pageId = await seedFloor1CountPage(c, tenantId, appId, regId);

      actorSlug = `t0632-zerogrant-${uuid().slice(0, 8)}`;
      empId = await seedEmployee(c, tenantId, actorSlug);
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, empId, roleId);
      // Application-level read grant ONLY — no record-level grant at all.
      appGrantId = await seedApplicationReadGrant(c, tenantId, roleId, appId);
    });

    const resp = await makeRequest(baseUrl, `/api/report-pages/${pageId}/render`, actorSlug);
    expect(resp.statusCode).toBe(200); // NOT 403 — page-level gate passed
    const body = JSON.parse(resp.body) as { metrics: Array<{ result: unknown }> };
    expect(Number(body.metrics[0]?.result ?? NaN)).toBe(0); // honest empty, not the full registry's count (1)

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, appGrantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND registry_id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// AC-T0632-3: genesis-owner (e-owner) is UNAFFECTED — sees the FULL aggregate
// (regression guard: the checkReadGrant genesis short-circuit continues to
// short-circuit; the new record-level filter does not narrow the owner).
// ---------------------------------------------------------------------------

describe('AC-T0632-3: genesis-owner sees the full aggregate (no regression)', () => {
  it('e-owner (genesis) SUM = the full registry total, unaffected by the READ-PDP filter', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    const regId = await withClient(migratorUrl(), (c) => seedRegistryDef(c, tenantId, appId));

    let pageId = '';

    await withClient(migratorUrl(), async (c) => {
      await seedRecord(c, tenantId, regId, 300);
      await seedRecord(c, tenantId, regId, 700);
      pageId = await seedFloor1SumPage(c, tenantId, appId, regId);
    });

    const resp = await makeRequest(baseUrl, `/api/report-pages/${pageId}/render`, 'e-owner');
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { metrics: Array<{ result: unknown }> };
    expect(Number(body.metrics[0]?.result ?? NaN)).toBe(1000);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND registry_id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// LEAK A (adversary opus, HIGH) — Floor-2 /data raw-record dump READ-PDP.
//
// GET /api/report-pages/:id/data (dataFloor2) is the raw-row sibling of the
// /render aggregate: it used to dump the FULL data of EVERY record in a
// registry + an exact full-registry COUNT(*), gated ONLY by the
// application-level checkReadGrant. A narrow record-scope actor read the FULL
// data of records they cannot see, bypassing the record-level READ-PDP the
// /render fix added. This probe proves the fix against the REAL createServer()
// composition root (same resolveReadVisibility wiring as GET /api/records):
//
//   AC-DATA-1 (mutational): a narrow-grant actor's /data returns ONLY the
//     record(s) they can read + total_count = visible count (not the full
//     registry). A wide/owner actor still sees every record.
//   AC-DATA-2: an actor with the application-read grant but ZERO record-level
//     grants gets an empty records[] + total_count:0 — not 403/500, not the
//     full dump.
// ---------------------------------------------------------------------------

describe('LEAK A: Floor-2 /data raw-record dump is filtered by record-level READ-PDP', () => {
  it('narrow record-scope actor sees ONLY the visible record + visible total_count; wide actor sees both; zero-grant sees none', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    const regId = await withClient(migratorUrl(), (c) => seedRegistryDef(c, tenantId, appId));

    let record1Id = '';
    let record2Id = '';
    let pageId = '';
    let narrowActor = '';
    let wideActor = '';
    let zeroActor = '';
    let narrowEmpId = '';
    let wideEmpId = '';
    let zeroEmpId = '';
    let narrowRoleId = '';
    let wideRoleId = '';
    let zeroRoleId = '';
    let narrowRaId = '';
    let wideRaId = '';
    let zeroRaId = '';
    const grantIds: string[] = [];

    await withClient(migratorUrl(), async (c) => {
      record1Id = await seedRecord(c, tenantId, regId, 100);
      record2Id = await seedRecord(c, tenantId, regId, 900);
      pageId = await seedFloor2Page(c, tenantId, appId);

      narrowActor = `t0632-data-narrow-${uuid().slice(0, 8)}`;
      narrowEmpId = await seedEmployee(c, tenantId, narrowActor);
      narrowRoleId = await seedRole(c, tenantId);
      narrowRaId = await seedRoleAssignment(c, tenantId, narrowEmpId, narrowRoleId);
      grantIds.push(await seedApplicationReadGrant(c, tenantId, narrowRoleId, appId));
      grantIds.push(await seedRecordReadGrant(c, tenantId, narrowRoleId, record1Id));

      wideActor = `t0632-data-wide-${uuid().slice(0, 8)}`;
      wideEmpId = await seedEmployee(c, tenantId, wideActor);
      wideRoleId = await seedRole(c, tenantId);
      wideRaId = await seedRoleAssignment(c, tenantId, wideEmpId, wideRoleId);
      grantIds.push(await seedApplicationReadGrant(c, tenantId, wideRoleId, appId));
      grantIds.push(await seedRecordReadGrant(c, tenantId, wideRoleId, record1Id));
      grantIds.push(await seedRecordReadGrant(c, tenantId, wideRoleId, record2Id));

      zeroActor = `t0632-data-zero-${uuid().slice(0, 8)}`;
      zeroEmpId = await seedEmployee(c, tenantId, zeroActor);
      zeroRoleId = await seedRole(c, tenantId);
      zeroRaId = await seedRoleAssignment(c, tenantId, zeroEmpId, zeroRoleId);
      grantIds.push(await seedApplicationReadGrant(c, tenantId, zeroRoleId, appId)); // app grant only, no record grant
    });

    const path = `/api/report-pages/${pageId}/data?registry_def_id=${regId}`;

    // Narrow actor: only record1 (id + data), total_count = 1 (not 2).
    const narrowResp = await makeRequest(baseUrl, path, narrowActor);
    expect(narrowResp.statusCode).toBe(200);
    const narrowBody = JSON.parse(narrowResp.body) as { records: Array<{ id: string }>; total_count: number };
    expect(narrowBody.records.map((r) => r.id)).toEqual([record1Id]);
    expect(narrowBody.records.some((r) => r.id === record2Id)).toBe(false);
    expect(narrowBody.total_count).toBe(1);

    // Wide actor: both records, total_count = 2.
    const wideResp = await makeRequest(baseUrl, path, wideActor);
    expect(wideResp.statusCode).toBe(200);
    const wideBody = JSON.parse(wideResp.body) as { records: Array<{ id: string }>; total_count: number };
    expect(wideBody.records.map((r) => r.id).sort()).toEqual([record1Id, record2Id].sort());
    expect(wideBody.total_count).toBe(2);

    // Zero-grant actor: application-read grant passes the page gate (200), but
    // no record is visible → empty dump + total_count 0 (not 403, not full dump).
    const zeroResp = await makeRequest(baseUrl, path, zeroActor);
    expect(zeroResp.statusCode).toBe(200);
    const zeroBody = JSON.parse(zeroResp.body) as { records: unknown[]; total_count: number };
    expect(zeroBody.records.length).toBe(0);
    expect(zeroBody.total_count).toBe(0);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        for (const gid of grantIds) {
          await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, gid]);
        }
        for (const raid of [narrowRaId, wideRaId, zeroRaId]) {
          await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raid]);
        }
        for (const rid of [narrowRoleId, wideRoleId, zeroRoleId]) {
          await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, rid]);
        }
        for (const eid of [narrowEmpId, wideEmpId, zeroEmpId]) {
          await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, eid]);
        }
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND registry_id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));
});
