// T-0191 R-N1 — AC-7b: force=true + non-genesis actor with seeded apply-grant → 200
//
// Closes review nit R-N1 (T-0191): spec contract AC-7 required live coverage of the
// non-owner path (seeded mgmt_object:schema_destructive/apply grant), not just the
// genesis-owner short-circuit. This file houses that coverage separately to comply
// with FF-T147-2 (existing db test files must not be modified post-REVIEW commit).
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
//
// Setup: seeds employee + role + role_assignment + grant (apply, delegable=true).
// Actor uses the seeded slug — not genesis-owner → isGenesisOwner=false.
// The gate checks adminGrants.some(g.resource_type === 'mgmt_object:schema_destructive'
//   && g.operation === 'apply') → true → ok:true → 200.
//
// ADR T-0121 §6 / FF-RDP5: 'apply' is a widening-cast string comparison, not in frozen
// Operation union; delegated via validateAdminDelegation when genesis-owner uses grant API.
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { createServer } from '../../../src/server.js';
import { resetPoolForTesting } from '../../../src/http/registry-defs.js';

// DEV_TENANT_ID must match the value used by the HTTP layer (registry-defs.ts).
const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Seed helpers (local — mirrors schema_change_api.test.ts helpers)
// ---------------------------------------------------------------------------

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'draft', 0, 0)`,
    [tenantId, id, `ac7b-app-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegistryDef(
  c: pg.Client,
  tenantId: string,
  appId: string,
  schema: object,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5::jsonb, 'draft', 0, 0)`,
    [tenantId, id, appId, `ac7b-reg-${id.slice(0, 8)}`, JSON.stringify(schema)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedReportPage(
  c: pg.Client,
  tenantId: string,
  appId: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.report_page
       (tenant_id, id, app_id, slug, title, floor, tier, page_def, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '1', 'draft',
             '[{"source_registry_def_id":"r1","field_key":"value","agg":"sum"}]'::jsonb, 0, 0)`,
    [tenantId, id, appId, `ac7b-page-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedReportPageDep(
  c: pg.Client,
  tenantId: string,
  pageId: string,
  registryDefId: string,
  fieldKey: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.report_page_dep
       (tenant_id, id, page_id, registry_def_id, field_key, dep_kind, stale, created_at)
     VALUES ($1, $2, $3, $4, $5, 'aggregate', false, 0)`,
    [tenantId, id, pageId, registryDefId, fieldKey],
  );
  await c.query('COMMIT');
  return id;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

type HttpResult = { statusCode: number; body: string };

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-dev-user': 'sc-tester',
      ...(headers ?? {}),
    };
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let chunk = '';
      res.on('data', (c: Buffer) => { chunk += c.toString(); });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: chunk }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl: string;
const cleanupFns: Array<() => Promise<void>> = [];

const originalDbUrl = process.env['DATABASE_URL'];

if (originalDbUrl) {
  resetPoolForTesting();
  server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
}

afterAll(async () => {
  for (const fn of cleanupFns.reverse()) {
    await fn().catch(() => { /* best-effort cleanup */ });
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (originalDbUrl !== undefined) {
    process.env['DATABASE_URL'] = originalDbUrl;
  }
});

function requireDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    if (!originalDbUrl) {
      console.log('SKIP: DATABASE_URL not set');
      return;
    }
    await fn();
  };
}

// ---------------------------------------------------------------------------
// AC-7b (T-0191 R-N1) — force=true + non-owner actor WITH seeded apply-grant → 200
//
// Seeds: employee (position_id=NULL) + role + role_assignment (confirmed_by set) +
//   grant(resource_type='mgmt_object:schema_destructive', operation='apply', delegable=true)
// The seeded actor is not genesis-owner → isGenesisOwner=false.
// loadAdminContext finds role_assignment → loads mgmt_object:* grants for that role →
//   adminGrants.some(g.resource_type==='mgmt_object:schema_destructive' &&
//     (g.operation as string)==='apply') → true → ok:true → 200.
//
// org_scope = org-set over the three root departments (same as migration 026).
// ---------------------------------------------------------------------------

describe('AC-7b (T-0191 R-N1) — force=true + seeded non-owner apply-grant → 200', () => {
  it('non-genesis actor with delegated apply-grant → 200 force_applied:true', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;

    // Pre-generate UUIDs for clean ordered cleanup
    const empId   = uuid();
    const roleId  = uuid();
    const raId    = uuid();
    const grantId = uuid();
    const empSlug = `ac7b-emp-${empId.slice(0, 8)}`;

    // org-set over the three root departments (matches genesis seed org scope)
    const orgScope = JSON.stringify({
      kind: 'set',
      members: [
        { kind: 'node', hierarchy: 'org', nodeId: 'b0000000-0000-0000-0000-000000000001', nodeLevel: 'department' },
        { kind: 'node', hierarchy: 'org', nodeId: 'b0000000-0000-0000-0000-000000000002', nodeLevel: 'department' },
        { kind: 'node', hierarchy: 'org', nodeId: 'b0000000-0000-0000-0000-000000000003', nodeLevel: 'department' },
      ],
    });

    let regId: string | undefined;
    let appId: string | undefined;
    let pageId: string | undefined;

    await withClient(migratorUrl(), async (c) => {
      // 1. Employee — position_id=NULL (same pattern as genesis seed migration 026)
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.employee
           (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, NULL, 'human', $3, $3, 0, 0)`,
        [tenantId, empId, empSlug],
      );
      await c.query('COMMIT');

      // 2. Role — standalone admin-capable role (not tenant-owner)
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.role
           (tenant_id, id, slug, display_name, description, created_at, updated_at)
         VALUES ($1, $2, $3, $3, NULL, 0, 0)`,
        [tenantId, roleId, `ac7b-role-${roleId.slice(0, 8)}`],
      );
      await c.query('COMMIT');

      // 3. Role assignment — confirmed_by set = effective assignment
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
            source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL,
                 'ac7b-test', 'ac7b-test', NULL, 'ac7b-test', 0, 0)`,
        [tenantId, raId, empId, roleId, orgScope],
      );
      await c.query('COMMIT');

      // 4. Grant — mgmt_object:schema_destructive / apply (delegable=true)
      //    operation='apply' uses widening-cast string comparison (ADR T-0121 §6.2, FF-RDP5).
      //    loadAdminContext queries WHERE resource_type LIKE 'mgmt_object:%' AND delegable=true,
      //    then defaultCheckDestructiveGrant checks adminGrants.some(
      //      g.resource_type==='mgmt_object:schema_destructive' &&
      //      (g.operation as string)==='apply').
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, resource_facet, operation,
            scope, "constraint", delegable, granted_by, valid_from, valid_until, created_at)
         VALUES ($1, $2, $3, 'mgmt_object:schema_destructive', NULL, 'apply',
                 $4::jsonb, NULL, true, 'ac7b-test', NULL, NULL, 0)`,
        [tenantId, grantId, roleId, orgScope],
      );
      await c.query('COMMIT');

      // 5. Registry data: app + registry_def with a field + page + dep (destructive setup)
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId, { properties: { value: { type: 'string' } } });
      pageId = await seedReportPage(c, tenantId, appId);
      await seedReportPageDep(c, tenantId, pageId, regId, 'value');

      // Cleanup: reverse insertion order; grant/ra/role/employee are tenant-scoped rows
      cleanupFns.push(async () => {
        await withClient(migratorUrl(), async (cc) => {
          await cc.query('BEGIN');
          await cc.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await cc.query(`DELETE FROM choros."grant"         WHERE tenant_id=$1 AND id=$2`, [tenantId, grantId]);
          await cc.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, raId]);
          await cc.query(`DELETE FROM choros.role            WHERE tenant_id=$1 AND id=$2`, [tenantId, roleId]);
          await cc.query(`DELETE FROM choros.employee        WHERE tenant_id=$1 AND id=$2`, [tenantId, empId]);
          // Registry data cleanup (report_page_dep may cascade on page delete, delete explicitly)
          await cc.query(`DELETE FROM choros.report_page_dep WHERE tenant_id=$1 AND page_id=$2`, [tenantId, pageId!]);
          await cc.query(`DELETE FROM choros.report_page     WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId!]);
          await cc.query(`DELETE FROM choros.registry_def    WHERE tenant_id=$1 AND id=$2`, [tenantId, regId!]);
          await cc.query(`DELETE FROM choros.application     WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
          await cc.query('COMMIT');
        });
      });
    });

    // PUT with force=true; actor = seeded slug (non-genesis)
    // isGenesisOwner=false → steps through adminGrants check
    // adminGrants contains the seeded grant → ok:true → HTTP 200
    const result = await makeRequest(
      baseUrl,
      'PUT',
      `/api/registry-defs/${regId}`,
      { record_schema: { properties: {} }, force: true }, // drop 'value' → destructive
      { 'x-dev-user': empSlug },
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body['updated']).toBe(true);
    expect(body['force_applied']).toBe(true);
  }));
});
