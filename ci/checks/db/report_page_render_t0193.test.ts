// T-0193 · scope-containment in render-path (R-6 fix)
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Covers the two-app deny/allow live probe (AC spec):
//   AC-T0193-DENY:  actor holds grant(read, application, scope=App-A) →
//                   page of App-B → 403 NO_READ_GRANT.
//   AC-T0193-ALLOW: actor holds grant(read, application, scope=App-A) →
//                   page of App-A → 200.
//
// Both Floor-1 (/render) and Floor-2 (/data) are probed for each case.
//
// This is the authoritative live probe for T-0193 R-6 scope-containment fix.
// Nevyrождение: AC-6 probes from report_page_render_ac6.test.ts remain green.
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { createServer } from '../../../src/server.js';
import {
  resetRenderPoolForTesting,
} from '../../../src/http/report-page-render.js';
import { resetPoolForTesting } from '../../../src/http/report-pages.js';

const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// requireDb helper
// ---------------------------------------------------------------------------

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
    [tenantId, id, `t0193-app-${id.slice(0, 8)}`],
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
     VALUES ($1, $2, $3, $4, $4, '{"properties":{"val":{"type":"number"}}}'::jsonb, 'draft', 0, 0)`,
    [tenantId, id, appId, `t0193-reg-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecord(c: pg.Client, tenantId: string, registryId: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, '{"val":1}'::jsonb, 0, 0, 't0193-test')`,
    [tenantId, id, registryId],
  );
  await c.query('COMMIT');
  return id;
}

async function seedFloor1Page(
  c: pg.Client,
  tenantId: string,
  appId: string,
  regId: string,
): Promise<string> {
  const id = uuid();
  const slug = `t0193-f1-${id.slice(0, 8)}`;
  const pageDef = JSON.stringify([
    { source_registry_def_id: regId, field_key: 'val', agg: 'count' },
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
  const slug = `t0193-f2-${id.slice(0, 8)}`;
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
  const slug = `t0193-role-${id.slice(0, 8)}`;
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'T-0193 test role', 0, 0)`,
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

/**
 * Seed an application/read grant scoped to a SPECIFIC appId.
 * T-0193: the scope nodeId must equal the target appId for containment to hold.
 */
async function seedApplicationReadGrantForApp(
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
    // T-0675: grant is CONFIRMED (confirmed_by='seed'). Previously this seed
    // omitted confirmed_by (NULL = unconfirmed) but expected the scope-containment
    // read gate to PASS — the exact T-0675 asymmetry. The gate now enforces the
    // grant's confirmed_by (canonical parity with getGrantsForSubject), so the
    // T-0193 scope-containment intent is tested with a genuinely confirmed grant.
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

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'x-dev-user': 'e-owner',
      ...extraHeaders,
    };
    const parsed = new URL(baseUrl + path);
    const options = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test server + cleanup tracking
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl: string;
const cleanupFns: Array<() => Promise<void>> = [];

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

function addCleanup(fn: () => Promise<void>): void {
  cleanupFns.push(fn);
}

// ---------------------------------------------------------------------------
// AC-T0193-DENY: actor holds grant scoped to App-A; page belongs to App-B → 403
//
// Setup:
//   - App-A and App-B: two distinct applications.
//   - allow-actor: employee + role + role_assignment + grant(application,read,scope=App-A).
//   - Page for App-B: report_page with app_id = App-B UUID.
// Expected: grant scoped to App-A does NOT cover App-B page → 403 NO_READ_GRANT.
// ---------------------------------------------------------------------------

describe('AC-T0193-DENY: grant on App-A, page of App-B → 403 (scope-containment blocks cross-app)', () => {
  it('Floor-1 /render: App-B page with grant scoped to App-A → 403 NO_READ_GRANT', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appAId: string;
    let appBId: string;
    let regBId: string;
    let pageOfBId: string;
    let actorSlug: string;
    let employeeId: string;
    let roleId: string;
    let raId: string;
    let grantId: string;

    actorSlug = `t0193-deny1-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      // Two apps
      appAId = await seedApplication(c, tenantId);
      appBId = await seedApplication(c, tenantId);
      // Registry + page for App-B
      regBId = await seedRegistryDef(c, tenantId, appBId!);
      await seedRecord(c, tenantId, regBId!);
      pageOfBId = await seedFloor1Page(c, tenantId, appBId!, regBId!);
      // Grant: scoped to App-A only
      employeeId = await seedEmployee(c, tenantId, actorSlug);
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, employeeId, roleId);
      grantId = await seedApplicationReadGrantForApp(c, tenantId, roleId, appAId!);
    });

    // Request render for App-B's page — should be denied (grant covers App-A only)
    const r = await makeRequest(
      baseUrl, 'GET',
      `/api/report-pages/${pageOfBId!}/render`,
      { 'x-dev-user': actorSlug },
    );

    expect(r.statusCode).toBe(403);
    const body = JSON.parse(r.body) as { error?: Record<string, unknown> };
    expect(body.error?.['code']).toBe('NO_READ_GRANT');

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, employeeId]);
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND registry_id=$2`, [tenantId, regBId!]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageOfBId!]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regBId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appBId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appAId!]);
        await c.query('COMMIT');
      });
    });
  }));

  it('Floor-2 /data: App-B page with grant scoped to App-A → 403 NO_READ_GRANT', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appAId: string;
    let appBId: string;
    let regBId: string;
    let pageOfBId: string;
    let actorSlug: string;
    let employeeId: string;
    let roleId: string;
    let raId: string;
    let grantId: string;

    actorSlug = `t0193-deny2-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      appAId = await seedApplication(c, tenantId);
      appBId = await seedApplication(c, tenantId);
      regBId = await seedRegistryDef(c, tenantId, appBId!);
      pageOfBId = await seedFloor2Page(c, tenantId, appBId!);
      employeeId = await seedEmployee(c, tenantId, actorSlug);
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, employeeId, roleId);
      grantId = await seedApplicationReadGrantForApp(c, tenantId, roleId, appAId!);
    });

    const r = await makeRequest(
      baseUrl, 'GET',
      `/api/report-pages/${pageOfBId!}/data?registry_def_id=${regBId!}`,
      { 'x-dev-user': actorSlug },
    );

    expect(r.statusCode).toBe(403);
    const body = JSON.parse(r.body) as { error?: Record<string, unknown> };
    expect(body.error?.['code']).toBe('NO_READ_GRANT');

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, employeeId]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageOfBId!]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regBId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appBId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appAId!]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// AC-T0193-ALLOW: actor holds grant scoped to App-A; page belongs to App-A → 200
//
// Setup: same grant scoped to App-A, but page is for App-A.
// Expected: grant covers App-A page → 200.
// ---------------------------------------------------------------------------

describe('AC-T0193-ALLOW: grant on App-A, page of App-A → 200 (scope-containment allows)', () => {
  it('Floor-1 /render: App-A page with grant scoped to App-A → 200', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appAId: string;
    let regAId: string;
    let pageOfAId: string;
    let actorSlug: string;
    let employeeId: string;
    let roleId: string;
    let raId: string;
    let grantId: string;

    actorSlug = `t0193-allow1-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      appAId = await seedApplication(c, tenantId);
      regAId = await seedRegistryDef(c, tenantId, appAId!);
      await seedRecord(c, tenantId, regAId!);
      pageOfAId = await seedFloor1Page(c, tenantId, appAId!, regAId!);
      employeeId = await seedEmployee(c, tenantId, actorSlug);
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, employeeId, roleId);
      // Grant scoped to App-A — page also belongs to App-A → should allow
      grantId = await seedApplicationReadGrantForApp(c, tenantId, roleId, appAId!);
    });

    const r = await makeRequest(
      baseUrl, 'GET',
      `/api/report-pages/${pageOfAId!}/render`,
      { 'x-dev-user': actorSlug },
    );

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body['floor']).toBe('1');
    expect(body['page_id']).toBe(pageOfAId!);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, employeeId]);
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND registry_id=$2`, [tenantId, regAId!]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageOfAId!]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regAId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appAId!]);
        await c.query('COMMIT');
      });
    });
  }));

  it('Floor-2 /data: App-A page with grant scoped to App-A → 200', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appAId: string;
    let regAId: string;
    let pageOfAId: string;
    let actorSlug: string;
    let employeeId: string;
    let roleId: string;
    let raId: string;
    let grantId: string;

    actorSlug = `t0193-allow2-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      appAId = await seedApplication(c, tenantId);
      regAId = await seedRegistryDef(c, tenantId, appAId!);
      pageOfAId = await seedFloor2Page(c, tenantId, appAId!);
      employeeId = await seedEmployee(c, tenantId, actorSlug);
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, employeeId, roleId);
      grantId = await seedApplicationReadGrantForApp(c, tenantId, roleId, appAId!);
    });

    const r = await makeRequest(
      baseUrl, 'GET',
      `/api/report-pages/${pageOfAId!}/data?registry_def_id=${regAId!}`,
      { 'x-dev-user': actorSlug },
    );

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body['floor']).toBe('2');
    expect(body['page_id']).toBe(pageOfAId!);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, employeeId]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageOfAId!]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regAId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appAId!]);
        await c.query('COMMIT');
      });
    });
  }));
});
