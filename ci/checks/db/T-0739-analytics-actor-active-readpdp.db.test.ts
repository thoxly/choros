// T-0739 (security P2, столп 4) · ACTOR_ACTIVE/READ-PDP live probe for the
// three routes ci/checks/actor-active-route-coverage.sh (T-0726) flagged as
// having ZERO authority-resolver touch:
//   1. GET /api/operational-analytics[/export]
//   2. GET /api/process-analytics
//   3. GET /api/records/:id/links
//
// Run against the compose Postgres:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// Drives the REAL src/server.ts composition root (createServer()) — the SAME
// `reportAggReadVisibility` resolver instance production wires into
// registerOperationalAnalyticsRoutes / registerReportPageRenderRoutes /
// registerRecordLinksRoutes (ADR-T0739 §2, single resolver, no second
// authority path). Mirrors ci/checks/db/report-page-render-read-pdp.db.test.ts
// (T-0632) and ci/checks/db/audit-route-deactivation-gate.db.test.ts (T-0737)
// seeding conventions.

import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { createServer } from '../../../src/server.js';
import { resetRenderPoolForTesting } from '../../../src/http/report-page-render.js';
import { resetPoolForTesting } from '../../../src/http/report-pages.js';

const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';
const DEACT_AT = 500_000; // epoch-ms; any non-null value marks the row deactivated.

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
// Seed helpers (mirrors report-page-render-read-pdp.db.test.ts / T-0632)
// ---------------------------------------------------------------------------

async function seedEmployee(
  c: pg.Client,
  tenantId: string,
  slug: string,
  opts?: { deactivatedAt?: number },
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, NULL, 'human', $3, $3, 0, 0, $4)`,
    [tenantId, id, slug, opts?.deactivatedAt ?? null],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRole(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const slug = `t0739-role-${id.slice(0, 8)}`;
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'T-0739 test role', 0, 0)`,
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

/** Application-level `read` grant (T-0193 shape) — sufficient for the >=1-grant entry gate. */
async function seedApplicationReadGrant(
  c: pg.Client,
  tenantId: string,
  roleId: string,
  appId: string,
): Promise<string> {
  const id = uuid();
  const scope = JSON.stringify({ kind: 'node', hierarchy: 'resource', nodeId: appId, nodeLevel: 'application' });
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet, operation, scope, "constraint", delegable,
        granted_by, confirmed_by, valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'application', NULL, 'read', $4::jsonb, NULL, false, 'seed', 'seed', NULL, NULL, 0)`,
    [tenantId, id, roleId, scope],
  );
  await c.query('COMMIT');
  return id;
}

/** Record-level `read` grant narrowly scoped to ONE record id (T-0570 rule 1). */
async function seedRecordReadGrant(
  c: pg.Client,
  tenantId: string,
  roleId: string,
  recordId: string,
): Promise<string> {
  const id = uuid();
  const scope = JSON.stringify({ kind: 'node', hierarchy: 'resource', nodeId: recordId, nodeLevel: 'record' });
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet, operation, scope, "constraint", delegable,
        granted_by, confirmed_by, valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'record', NULL, 'read', $4::jsonb, NULL, true, 'seed', 'seed', NULL, NULL, 0)`,
    [tenantId, id, roleId, scope],
  );
  await c.query('COMMIT');
  return id;
}

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application (tenant_id, id, slug, display_name, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'draft', 0, 0)`,
    [tenantId, id, `t0739-app-${id.slice(0, 8)}`],
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
    [tenantId, id, appId, `t0739-reg-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecord(c: pg.Client, tenantId: string, registryId: string, amount: number): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, 0, 't0739-test')`,
    [tenantId, id, registryId, JSON.stringify({ amount }), Date.now()],
  );
  await c.query('COMMIT');
  return id;
}

// ---------------------------------------------------------------------------
// HTTP helper — real createServer(), x-dev-user auth
// ---------------------------------------------------------------------------

function makeRequest(baseUrl: string, path: string, actor: string): Promise<{ statusCode: number; body: string }> {
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
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

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
    if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
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
// #1 GET /api/operational-analytics[/export] — ADR-T0739 §3.1
// ---------------------------------------------------------------------------

describe('T-0739 #1 operational-analytics — entry gate (>=1 confirmed grant)', () => {
  it('actor with ZERO grants -> 403 NO_READ_GRANT on GET /api/operational-analytics', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let empId = '';
    let actorSlug = '';
    await withClient(migratorUrl(), async (c) => {
      actorSlug = `t0739-zerogrant-${uuid().slice(0, 8)}`;
      empId = await seedEmployee(c, tenantId, actorSlug);
      // NO role_assignment, NO grant at all.
    });

    const resp = await makeRequest(baseUrl, '/api/operational-analytics', actorSlug);
    expect(resp.statusCode).toBe(403);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
        await c.query('COMMIT');
      });
    });
  }));

  it('DEACTIVATED actor (residual JWT) with an otherwise-valid grant -> 403 on GET /api/operational-analytics/export', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));

    let empId = '';
    let roleId = '';
    let raId = '';
    let grantId = '';
    let actorSlug = '';
    await withClient(migratorUrl(), async (c) => {
      actorSlug = `t0739-deact-${uuid().slice(0, 8)}`;
      empId = await seedEmployee(c, tenantId, actorSlug, { deactivatedAt: DEACT_AT });
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, empId, roleId);
      grantId = await seedApplicationReadGrant(c, tenantId, roleId, appId);
    });

    // getGrantsForSubject's ACTOR_ACTIVE_SQL predicate fails to resolve the
    // employee row -> grants=[] regardless of the role_assignment/grant rows
    // existing in the DB (T-0662 fail-closed semantics).
    const resp = await makeRequest(baseUrl, '/api/operational-analytics/export', actorSlug);
    expect(resp.statusCode).toBe(403);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));

  it('ACTIVE actor with >=1 grant -> 200 (no regression for a legitimate reader)', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));

    let empId = '';
    let roleId = '';
    let raId = '';
    let grantId = '';
    let actorSlug = '';
    await withClient(migratorUrl(), async (c) => {
      actorSlug = `t0739-active-${uuid().slice(0, 8)}`;
      empId = await seedEmployee(c, tenantId, actorSlug);
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, empId, roleId);
      grantId = await seedApplicationReadGrant(c, tenantId, roleId, appId);
    });

    const resp = await makeRequest(baseUrl, '/api/operational-analytics', actorSlug);
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { workload_daily: unknown[]; top_actors: unknown[] };
    expect(Array.isArray(body.workload_daily)).toBe(true);
    expect(Array.isArray(body.top_actors)).toBe(true);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));
});

describe('T-0739 #1 operational-analytics — record_sums narrowed to READ-PDP-visible records (T-0632 parity)', () => {
  it('narrow record-scope grant sum < wide record-scope grant sum on the SAME registry (mutational)', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    const regId = await withClient(migratorUrl(), (c) => seedRegistryDef(c, tenantId, appId));

    let record1Id = '';
    let record2Id = '';
    let narrowActor = '';
    let wideActor = '';
    let narrowEmpId = '';
    let wideEmpId = '';
    let narrowRoleId = '';
    let wideRoleId = '';
    let narrowRaId = '';
    let wideRaId = '';
    let narrowGrant1 = '';
    let narrowGrant2 = '';
    let wideGrant1 = '';
    let wideGrant2 = '';
    let wideGrant3 = '';

    await withClient(migratorUrl(), async (c) => {
      record1Id = await seedRecord(c, tenantId, regId, 100);
      record2Id = await seedRecord(c, tenantId, regId, 900); // "hidden" for the narrow actor

      narrowActor = `t0739-narrow-${uuid().slice(0, 8)}`;
      narrowEmpId = await seedEmployee(c, tenantId, narrowActor);
      narrowRoleId = await seedRole(c, tenantId);
      narrowRaId = await seedRoleAssignment(c, tenantId, narrowEmpId, narrowRoleId);
      narrowGrant1 = await seedApplicationReadGrant(c, tenantId, narrowRoleId, appId); // entry gate
      narrowGrant2 = await seedRecordReadGrant(c, tenantId, narrowRoleId, record1Id); // sees ONLY record1

      wideActor = `t0739-wide-${uuid().slice(0, 8)}`;
      wideEmpId = await seedEmployee(c, tenantId, wideActor);
      wideRoleId = await seedRole(c, tenantId);
      wideRaId = await seedRoleAssignment(c, tenantId, wideEmpId, wideRoleId);
      wideGrant1 = await seedApplicationReadGrant(c, tenantId, wideRoleId, appId);
      wideGrant2 = await seedRecordReadGrant(c, tenantId, wideRoleId, record1Id);
      wideGrant3 = await seedRecordReadGrant(c, tenantId, wideRoleId, record2Id); // sees BOTH
    });

    const qs = `?registry_def_id=${regId}&field_key=amount`;
    const narrowResp = await makeRequest(baseUrl, `/api/operational-analytics${qs}`, narrowActor);
    expect(narrowResp.statusCode).toBe(200);
    const narrowBody = JSON.parse(narrowResp.body) as { record_sums?: Array<{ total: number }> };
    const narrowTotal = (narrowBody.record_sums ?? []).reduce((s, r) => s + r.total, 0);

    const wideResp = await makeRequest(baseUrl, `/api/operational-analytics${qs}`, wideActor);
    expect(wideResp.statusCode).toBe(200);
    const wideBody = JSON.parse(wideResp.body) as { record_sums?: Array<{ total: number }> };
    const wideTotal = (wideBody.record_sums ?? []).reduce((s, r) => s + r.total, 0);

    // THE mutational proof: without T-0739's per-row filter, BOTH actors would
    // see the full-registry SUM (1000) — the narrow actor must see ONLY
    // record1's value.
    expect(narrowTotal).toBe(100);
    expect(wideTotal).toBe(1000);
    expect(narrowTotal).toBeLessThan(wideTotal);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        for (const gid of [narrowGrant1, narrowGrant2, wideGrant1, wideGrant2, wideGrant3]) {
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
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// #2 GET /api/process-analytics — ADR-T0739 §3.2
// ---------------------------------------------------------------------------

describe('T-0739 #2 process-analytics — entry gate (>=1 confirmed grant)', () => {
  it('actor with ZERO grants -> 403 NO_READ_GRANT', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let empId = '';
    let actorSlug = '';
    await withClient(migratorUrl(), async (c) => {
      actorSlug = `t0739-pa-zero-${uuid().slice(0, 8)}`;
      empId = await seedEmployee(c, tenantId, actorSlug);
    });

    const resp = await makeRequest(baseUrl, '/api/process-analytics', actorSlug);
    expect(resp.statusCode).toBe(403);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
        await c.query('COMMIT');
      });
    });
  }));

  it('DEACTIVATED actor (residual JWT, otherwise-valid grant) -> 403', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));

    let empId = '';
    let roleId = '';
    let raId = '';
    let grantId = '';
    let actorSlug = '';
    await withClient(migratorUrl(), async (c) => {
      actorSlug = `t0739-pa-deact-${uuid().slice(0, 8)}`;
      empId = await seedEmployee(c, tenantId, actorSlug, { deactivatedAt: DEACT_AT });
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, empId, roleId);
      grantId = await seedApplicationReadGrant(c, tenantId, roleId, appId);
    });

    const resp = await makeRequest(baseUrl, '/api/process-analytics', actorSlug);
    expect(resp.statusCode).toBe(403);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));

  it('ACTIVE actor with >=1 grant -> 200 (no regression)', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));

    let empId = '';
    let roleId = '';
    let raId = '';
    let grantId = '';
    let actorSlug = '';
    await withClient(migratorUrl(), async (c) => {
      actorSlug = `t0739-pa-active-${uuid().slice(0, 8)}`;
      empId = await seedEmployee(c, tenantId, actorSlug);
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, empId, roleId);
      grantId = await seedApplicationReadGrant(c, tenantId, roleId, appId);
    });

    const resp = await makeRequest(baseUrl, '/api/process-analytics', actorSlug);
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { cycleTime: unknown; actorBreakdown: unknown[] };
    expect(body).toHaveProperty('cycleTime');
    expect(Array.isArray(body.actorBreakdown)).toBe(true);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// #3 GET /api/records/:id/links — ADR-T0739 §3.3
// ---------------------------------------------------------------------------

describe('T-0739 #3 record-links — source-record READ-PDP gate', () => {
  it('actor WITHOUT a covering grant on the source record -> 404 NOT_FOUND (honest-404, no existence leak)', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    const regId = await withClient(migratorUrl(), (c) => seedRegistryDef(c, tenantId, appId));
    const recordId = await withClient(migratorUrl(), (c) => seedRecord(c, tenantId, regId, 42));

    let empId = '';
    let actorSlug = '';
    await withClient(migratorUrl(), async (c) => {
      actorSlug = `t0739-rl-nogrant-${uuid().slice(0, 8)}`;
      empId = await seedEmployee(c, tenantId, actorSlug);
      // NO role_assignment, NO grant -> grants=[] -> isRecordReadable() false.
    });

    const resp = await makeRequest(baseUrl, `/api/records/${recordId}/links`, actorSlug);
    expect(resp.statusCode).toBe(404);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND id=$2`, [tenantId, recordId]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));

  it('DEACTIVATED actor with an otherwise-covering record grant -> 404 (residual JWT closed)', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    const regId = await withClient(migratorUrl(), (c) => seedRegistryDef(c, tenantId, appId));
    const recordId = await withClient(migratorUrl(), (c) => seedRecord(c, tenantId, regId, 42));

    let empId = '';
    let roleId = '';
    let raId = '';
    let grantId = '';
    let actorSlug = '';
    await withClient(migratorUrl(), async (c) => {
      actorSlug = `t0739-rl-deact-${uuid().slice(0, 8)}`;
      empId = await seedEmployee(c, tenantId, actorSlug, { deactivatedAt: DEACT_AT });
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, empId, roleId);
      grantId = await seedRecordReadGrant(c, tenantId, roleId, recordId);
    });

    const resp = await makeRequest(baseUrl, `/api/records/${recordId}/links`, actorSlug);
    expect(resp.statusCode).toBe(404);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND id=$2`, [tenantId, recordId]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));

  it('ACTIVE actor with a covering record-level grant -> 200 { record_id, links: [] } (positive control, no regression)', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    const regId = await withClient(migratorUrl(), (c) => seedRegistryDef(c, tenantId, appId));
    const recordId = await withClient(migratorUrl(), (c) => seedRecord(c, tenantId, regId, 42));

    let empId = '';
    let roleId = '';
    let raId = '';
    let grantId = '';
    let actorSlug = '';
    await withClient(migratorUrl(), async (c) => {
      actorSlug = `t0739-rl-active-${uuid().slice(0, 8)}`;
      empId = await seedEmployee(c, tenantId, actorSlug);
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, empId, roleId);
      grantId = await seedRecordReadGrant(c, tenantId, roleId, recordId);
    });

    const resp = await makeRequest(baseUrl, `/api/records/${recordId}/links`, actorSlug);
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body) as { record_id: string; links: unknown[] };
    expect(body.record_id).toBe(recordId);
    expect(Array.isArray(body.links)).toBe(true); // [] — no cross_app_ref defs seeded, proves the gate, not hop resolution

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND id=$2`, [tenantId, recordId]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });
  }));
});
