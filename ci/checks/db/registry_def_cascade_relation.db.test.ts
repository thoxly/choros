// Regression — cascade-relate must NOT leave a dangling registry_def reference
// for a NON-Dev-Silo tenant. Live Postgres probe (db CI job / local).
//
// Bug this guards against (field acceptance 2026-06-26, "Закупка оборудования"):
// the visual constructor's relation cascade (screen-app-schema.jsx createRelatedApp)
//   1. POST /api/applications  + POST /api/registry-defs  → related app + section
//      (both resolve the actor's REAL tenant), then
//   2. PUT  /api/registry-defs/:sourceId  → writes the x-relation field onto the
//      SOURCE schema and reconciles cross_app_ref.
// PUT/PATCH historically (T-0177) keyed tenancy off the hardcoded DEV_TENANT_ID
// (Dev Silo), while POST/GET used the actor's real tenant. For any tenant that is
// NOT the Dev Silo the PUT therefore looked up the source under the wrong tenant
// → 404 "registry_def not found": the relation never saved, the related app a
// dangling phantom. The fix makes PUT/PATCH resolve the actor's real tenant (the
// SAME resolution POST/GET use).
//
// This test drives the exact picker sequence under a FRESH random tenant (≠ Dev
// Silo) and asserts the relation persists and resolves with zero dangling refs.
//
// Run:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:5432/choros npm run fitness:db

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerApplicationRoutes } from '../../../src/http/applications.js';
import { registerRegistryDefRoutes } from '../../../src/http/registry-defs.js';

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

// A FRESH random tenant — deliberately NOT the Dev Silo (a0000000-…-001). The bug
// only manifests when the actor's real tenant differs from DEV_TENANT_ID.
const TENANT = uuid();
const OWNER = 'owner-cascade';

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === OWNER) return TENANT;
  throw new Error(`unknown test actor: ${slug}`);
}

async function seedOwnerTenant(c: pg.Client, tenantId: string, ownerSlug: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
  const empId = uuid();
  const roleId = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0)`,
    [tenantId, empId, ownerSlug, `Owner ${ownerSlug}`],
  );
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, 'tenant-owner', 'Tenant Owner', 0, 0)`,
    [tenantId, roleId],
  );
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
        source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3::uuid, $4, $5::jsonb, NULL, NULL, 'genesis', $6::text, $6::text, $6::text, 0, 0)`,
    [
      tenantId,
      uuid(),
      empId,
      roleId,
      JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'org', nodeLevel: 'department' }),
      ownerSlug,
    ],
  );
  await c.query('COMMIT');
}

function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { 'x-dev-user': OWNER };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown = null;
          try { json = JSON.parse(text); } catch { json = text; }
          resolve({ statusCode: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  // Applications + registry-defs (PUT/PATCH + create/list/get) on one router, wired
  // exactly as server.ts does — crudDeps carry { pool, resolveActorTenant }.
  registerApplicationRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
  registerRegistryDefRoutes(router, undefined, undefined, {
    pool: appPool,
    resolveActorTenant: stubResolveActorTenant,
  });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  await withClient(migratorUrl(), async (c) => {
    await seedOwnerTenant(c, TENANT, OWNER);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  // FK-safe teardown: cross_app_ref → schema-history → registry_def → application
  // → role_assignment → role → employee → tenant.
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    await c.query(`DELETE FROM choros.cross_app_ref WHERE tenant_id = $1`, [TENANT]);
    await c.query(`DELETE FROM choros.registry_schema_history WHERE tenant_id = $1`, [TENANT]);
    await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1`, [TENANT]);
    await c.query(`DELETE FROM choros.application WHERE tenant_id = $1`, [TENANT]);
    await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [TENANT]);
    await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [TENANT]);
    await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [TENANT]);
    await c.query('COMMIT');
    await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [TENANT]);
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('cascade-relate — no dangling registry_def for a non-Dev-Silo tenant', () => {
  it('PUT x-relation onto the source resolves the real tenant; related app + cross_app_ref are not orphaned', requireDb(async () => {
    // --- The visual constructor cascade sequence (screen-app-schema.jsx) ---
    // 1) source application + its primary section.
    const appA = await request(baseUrl, 'POST', '/api/applications', {
      slug: `zakupka-${TENANT.slice(0, 6)}`,
      display_name: 'Закупка оборудования',
    });
    expect(appA.statusCode, JSON.stringify(appA.json)).toBe(201);
    const sourceAppId = (appA.json as { id: string }).id;

    const sdef = await request(baseUrl, 'POST', '/api/registry-defs', {
      application_id: sourceAppId,
      slug: `zakupka-${TENANT.slice(0, 6)}`,
      display_name: 'Закупка',
      record_schema: { type: 'object', properties: {} },
    });
    expect(sdef.statusCode, JSON.stringify(sdef.json)).toBe(201);
    const sourceRegId = (sdef.json as { id: string }).id;

    // 2) createRelatedApp → related application + its primary section.
    const appB = await request(baseUrl, 'POST', '/api/applications', {
      slug: `postavshchik-${TENANT.slice(0, 6)}`,
      display_name: 'Поставщик',
    });
    expect(appB.statusCode, JSON.stringify(appB.json)).toBe(201);
    const relatedAppId = (appB.json as { id: string }).id;

    const rdef = await request(baseUrl, 'POST', '/api/registry-defs', {
      application_id: relatedAppId,
      slug: `postavshchik-${TENANT.slice(0, 6)}`,
      display_name: 'Поставщик',
      record_schema: { type: 'object', properties: {} },
    });
    expect(rdef.statusCode, JSON.stringify(rdef.json)).toBe(201);
    const targetRegId = (rdef.json as { id: string }).id;

    // 3) Save the source schema with the x-relation field pointing at the related
    //    section. THIS is the step that 404'd before the fix (PUT keyed to Dev Silo).
    const put = await request(baseUrl, 'PUT', `/api/registry-defs/${sourceRegId}`, {
      record_schema: {
        type: 'object',
        properties: {
          supplier: {
            type: 'string',
            title: 'Поставщик',
            'x-relation': { target_registry_id: targetRegId },
          },
        },
      },
    });
    expect(put.statusCode, `PUT must resolve the real tenant (not 404): ${JSON.stringify(put.json)}`).toBe(200);
    expect((put.json as { updated: boolean }).updated).toBe(true);

    // --- Assertions: nothing dangling ---
    // (a) The related section resolves (not 404).
    const getR = await request(baseUrl, 'GET', `/api/registry-defs/${targetRegId}`);
    expect(getR.statusCode, 'related registry_def must resolve').toBe(200);

    // (b) The relation field persisted on the source schema.
    const getS = await request(baseUrl, 'GET', `/api/registry-defs/${sourceRegId}`);
    expect(getS.statusCode).toBe(200);
    const sourceSchema = (getS.json as { record_schema: { properties?: Record<string, unknown> } }).record_schema;
    expect(Object.keys(sourceSchema.properties ?? {})).toContain('supplier');

    // (c) cross_app_ref reconciled to the real target, and NO dangling rows.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const refs = await c.query<{ target_registry_id: string; ref_field: string }>(
        `SELECT target_registry_id, ref_field FROM choros.cross_app_ref WHERE tenant_id = $1`,
        [TENANT],
      );
      const dangling = await c.query<{ target_registry_id: string }>(
        `SELECT car.target_registry_id
           FROM choros.cross_app_ref car
           LEFT JOIN choros.registry_def rd
             ON rd.tenant_id = car.tenant_id AND rd.id = car.target_registry_id
          WHERE car.tenant_id = $1 AND rd.id IS NULL`,
        [TENANT],
      );
      await c.query('COMMIT');
      expect(refs.rows).toHaveLength(1);
      expect(refs.rows[0]!.ref_field).toBe('supplier');
      expect(refs.rows[0]!.target_registry_id).toBe(targetRegId);
      expect(dangling.rows, 'no cross_app_ref may point at a missing registry_def').toHaveLength(0);
    });
  }));
});
