// T-0181 review fix (R-3) — AC-6 live DB probes: NO_READ_GRANT deny + allow via real
// application/read grant on both Floor-1 /render and Floor-2 /data.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// This is a NEW file (not a modification of report_page_render.test.ts) to comply
// with frozen-file discipline (FF-T147-2: existing db test-files must not be modified
// post-REVIEW commit). Pattern: report_page_agent_gate.test.ts.
//
// Covers:
//   AC-6-DENY-FLOOR1:  GET /render as actor without application/read grant → 403 NO_READ_GRANT.
//   AC-6-DENY-FLOOR2:  GET /data  as actor without application/read grant → 403 NO_READ_GRANT.
//   AC-6-ALLOW-FLOOR1: GET /render as actor WITH application/read grant   → 200.
//   AC-6-ALLOW-FLOOR2: GET /data  as actor WITH application/read grant    → 200.
//
// Setup:
//   - deny-actor:  seeded employee (no role_assignment, no grant) → always denied.
//   - allow-actor: seeded employee + role + role_assignment + grant(application,read) → allowed.
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

// DEV_TENANT_ID matches the HTTP layer.
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
// Seed helpers (bypass RLS via migratorUrl)
// ---------------------------------------------------------------------------

async function seedEmployee(
  c: pg.Client,
  tenantId: string,
  slug: string,
): Promise<string> {
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
  const slug = `ac6-role-${id.slice(0, 8)}`;
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'AC-6 test role', 0, 0)`,
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
  // org_scope: single-node scope (department b0000000-...-0001)
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
 * T-0193 (R-6 fix): appId parameter added so the grant scope contains the
 * specific application being granted access to. Previously used a fixed test
 * nodeId which worked before scope-containment was enforced.
 */
async function seedApplicationReadGrant(
  c: pg.Client,
  tenantId: string,
  roleId: string,
  appId: string,
): Promise<string> {
  const id = uuid();
  // T-0193: scope must contain the specific appId — not a fixed test node.
  // isNarrowerOrEqual(targetAppScope, grantScope) → grantScope nodeId must match appId.
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
    // omitted confirmed_by (defaulting NULL = unconfirmed) yet expected the read
    // gate to PASS — encoding the exact T-0675 hole (defaultCheckReadGrant did not
    // check the grant's confirmed_by). The gate now requires it, so the seed must
    // supply a confirmed grant to exercise the intended AC-6 allow path.
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

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'draft', 0, 0)`,
    [tenantId, id, `ac6-app-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegistryDef(
  c: pg.Client,
  tenantId: string,
  appId: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '{"properties":{"val":{"type":"number"}}}'::jsonb, 'draft', 0, 0)`,
    [tenantId, id, appId, `ac6-reg-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecord(
  c: pg.Client,
  tenantId: string,
  registryId: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, '{"val":1}'::jsonb, 0, 0, 'ac6-test')`,
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
  const slug = `ac6-f1-${id.slice(0, 8)}`;
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
  const slug = `ac6-f2-${id.slice(0, 8)}`;
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
      'x-dev-user': 'e-owner', // default; overridden per test
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
// AC-6-DENY: actor without application/read grant → 403 on Floor-1 + Floor-2
//
// deny-actor: seeded employee with no role_assignment / no grant.
// defaultCheckReadGrant: not genesis → no application/read grant found → 403.
// ---------------------------------------------------------------------------

describe('AC-6 NO_READ_GRANT deny probe: non-genesis actor without grant → 403', () => {
  it('AC-6-DENY-FLOOR1: GET /render without grant → 403 NO_READ_GRANT', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;
    let pageId: string;
    let denyActorSlug: string;
    let denyEmployeeId: string;

    denyActorSlug = `ac6-deny-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!);
      await seedRecord(c, tenantId, regId!);
      pageId = await seedFloor1Page(c, tenantId, appId!, regId!);
      // Seed deny-actor: employee only, no role_assignment, no grant
      denyEmployeeId = await seedEmployee(c, tenantId, denyActorSlug);
    });

    const r = await makeRequest(
      baseUrl, 'GET',
      `/api/report-pages/${pageId!}/render`,
      { 'x-dev-user': denyActorSlug },
    );

    expect(r.statusCode).toBe(403);
    const body = JSON.parse(r.body) as { error?: Record<string, unknown> };
    expect(body.error?.['code']).toBe('NO_READ_GRANT');

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        // Delete record before registry_def (FK: record → registry_def)
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND registry_id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId!]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, denyEmployeeId]);
        await c.query('COMMIT');
      });
    });
  }));

  it('AC-6-DENY-FLOOR2: GET /data without grant → 403 NO_READ_GRANT', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;
    let pageId: string;
    let denyActorSlug: string;
    let denyEmployeeId: string;

    denyActorSlug = `ac6-deny2-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!);
      pageId = await seedFloor2Page(c, tenantId, appId!);
      // Seed deny-actor: employee only, no role_assignment, no grant
      denyEmployeeId = await seedEmployee(c, tenantId, denyActorSlug);
    });

    const r = await makeRequest(
      baseUrl, 'GET',
      `/api/report-pages/${pageId!}/data?registry_def_id=${regId!}`,
      { 'x-dev-user': denyActorSlug },
    );

    expect(r.statusCode).toBe(403);
    const body = JSON.parse(r.body) as { error?: Record<string, unknown> };
    expect(body.error?.['code']).toBe('NO_READ_GRANT');

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId!]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, denyEmployeeId]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// AC-6-ALLOW: actor WITH application/read grant → 200 on Floor-1 + Floor-2
//
// allow-actor: seeded employee + role + role_assignment + grant(application,'read').
// defaultCheckReadGrant: not genesis → query finds application/read grant → ok:true → 200.
// This probe catches the R-2 bug: if defaultCheckReadGrant used mgmt_object:* grants
// (which never have operation='read'), this test would return 403 instead of 200.
// ---------------------------------------------------------------------------

describe('AC-6 allow probe: non-genesis actor WITH application/read grant → 200', () => {
  it('AC-6-ALLOW-FLOOR1: GET /render with application/read grant → 200', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;
    let pageId: string;
    let allowActorSlug: string;
    let allowEmployeeId: string;
    let roleId: string;
    let raId: string;
    let grantId: string;

    allowActorSlug = `ac6-allow-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!);
      await seedRecord(c, tenantId, regId!);
      pageId = await seedFloor1Page(c, tenantId, appId!, regId!);

      // Seed allow-actor: employee + role + confirmed role_assignment + application/read grant
      allowEmployeeId = await seedEmployee(c, tenantId, allowActorSlug);
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, allowEmployeeId, roleId);
      // T-0193 R-6: grant scope must match the specific appId of the page.
      grantId = await seedApplicationReadGrant(c, tenantId, roleId, appId!);
    });

    const r = await makeRequest(
      baseUrl, 'GET',
      `/api/report-pages/${pageId!}/render`,
      { 'x-dev-user': allowActorSlug },
    );

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body['floor']).toBe('1');
    expect(body['page_id']).toBe(pageId!);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, allowEmployeeId]);
        // Delete record before registry_def (FK: record → registry_def)
        await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND registry_id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId!]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));

  it('AC-6-ALLOW-FLOOR2: GET /data with application/read grant → 200', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;
    let pageId: string;
    let allowActorSlug: string;
    let allowEmployeeId: string;
    let roleId: string;
    let raId: string;
    let grantId: string;

    allowActorSlug = `ac6-allow2-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!);
      pageId = await seedFloor2Page(c, tenantId, appId!);

      // Seed allow-actor: employee + role + confirmed role_assignment + application/read grant
      allowEmployeeId = await seedEmployee(c, tenantId, allowActorSlug);
      roleId = await seedRole(c, tenantId);
      raId = await seedRoleAssignment(c, tenantId, allowEmployeeId, roleId);
      // T-0193 R-6: grant scope must match the specific appId of the page.
      grantId = await seedApplicationReadGrant(c, tenantId, roleId, appId!);
    });

    const r = await makeRequest(
      baseUrl, 'GET',
      `/api/report-pages/${pageId!}/data?registry_def_id=${regId!}`,
      { 'x-dev-user': allowActorSlug },
    );

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body['floor']).toBe('2');
    expect(body['page_id']).toBe(pageId!);

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, allowEmployeeId]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId!]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));
});
