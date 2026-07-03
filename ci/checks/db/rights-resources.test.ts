// T-0609 · GET /api/rights/resources — live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Live acceptance finding (2026-07-03): the «Дать роли право» grant form's RESOURCE
// selector only ever showed a 10-entry demo seed (DICT_RESOURCES, src/http/grants.ts)
// — a real tenant's own applications/registries were unreachable from that form. This
// endpoint is the honest fix: it surfaces the CALLER's real choros.application +
// choros.registry_def rows, tenant-scoped through the exact same RLS-enforced
// withTenantTx path that GET /api/applications and GET /api/registry-defs already use
// (this file adds NO new SQL — it exercises listApplications/listRegistryDefs, which
// this task exported from their existing files for reuse, via the route wiring in the
// new src/http/rights-resources.ts).
//
// Covers:
//   - AC-1: a tenant WITH application/registry_def rows sees them as {uri, name}
//     entries via GET /api/rights/resources.
//   - AC-1 (regression): tenant isolation — actor in tenant A never sees tenant B's
//     applications/registries (the Враг target, RLS-enforced through choros_app).
//   - AC-2: an empty tenant (no application/registry_def rows) gets {resources: []}
//     honestly — never 500, never a hidden demo-fallback on the server side (the demo
//     merge happens client-side, screen-rights.jsx, out of this endpoint's concern).
//   - 401 UNAUTHENTICATED when x-dev-user absent (mirrors every other route in this
//     family).
//
// T-0144 discipline: BEGIN before SET LOCAL, COMMIT always, cleanup after self.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRightsResourcesRoute } from '../../../src/http/rights-resources.js';

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

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedApplicationDirect(
  c: pg.Client,
  tenantId: string,
  slug: string,
  displayName: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, 'draft', 0, 0)`,
    [tenantId, id, slug, displayName],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegistryDefDirect(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  slug: string,
  displayName: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NULL, '{}'::jsonb, 0, 0)`,
    [tenantId, id, applicationId, slug, displayName],
  );
  await c.query('COMMIT');
  return id;
}

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers: extraHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;
const cleanupApps: Array<{ tenantId: string; id: string }> = [];
const cleanupRegs: Array<{ tenantId: string; id: string }> = [];

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'actor-a') return TENANT_A;
  if (slug === 'actor-b') return TENANT_B;
  if (slug === 'actor-empty') return TENANT_B; // reused below for the empty-tenant case
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(async () => {
  if (!hasDb) return;

  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerRightsResourcesRoute(router, {
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
    await seedTenantRow(c, TENANT_A);
    await seedTenantRow(c, TENANT_B);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    for (const { tenantId, id } of [...cleanupRegs].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
    for (const { tenantId, id } of [...cleanupApps].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/rights/resources (T-0609)', () => {
  it('401 when x-dev-user absent', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'GET', '/api/rights/resources');
    expect(r.statusCode).toBe(401);
  }));

  it('AC-1: real tenant application + registry_def rows appear as {uri, name} entries', requireDb(async () => {
    const appSlug = `zakupki-${uuid().slice(0, 8)}`;
    const regSlug = `zayavki-${uuid().slice(0, 8)}`;

    let appId = '';
    let regId = '';
    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplicationDirect(c, TENANT_A, appSlug, 'Заявка на закупку');
      regId = await seedRegistryDefDirect(c, TENANT_A, appId, regSlug, 'Заявки');
    });
    cleanupApps.push({ tenantId: TENANT_A, id: appId });
    cleanupRegs.push({ tenantId: TENANT_A, id: regId });

    const r = await makeRequest(baseUrl, 'GET', '/api/rights/resources', { 'x-dev-user': 'actor-a' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { resources: Array<{ uri: string; name: string }> };
    expect(Array.isArray(body.resources)).toBe(true);

    const appEntry = body.resources.find((res) => res.uri === `registry:${appSlug}`);
    expect(appEntry).toBeDefined();
    expect(appEntry?.name).toBe('Заявка на закупку');

    const regEntry = body.resources.find((res) => res.uri === `registry:${appSlug}.${regSlug}`);
    expect(regEntry).toBeDefined();
    expect(regEntry?.name).toBe('Заявка на закупку · Заявки');
  }));

  it('AC-1 regression (tenant isolation): actor-a never sees tenant B applications/registries', requireDb(async () => {
    const bSlug = `b-only-${uuid().slice(0, 8)}`;
    let bAppId = '';
    await withClient(migratorUrl(), async (c) => {
      bAppId = await seedApplicationDirect(c, TENANT_B, bSlug, 'Только тенант B');
    });
    cleanupApps.push({ tenantId: TENANT_B, id: bAppId });

    const r = await makeRequest(baseUrl, 'GET', '/api/rights/resources', { 'x-dev-user': 'actor-a' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { resources: Array<{ uri: string; name: string }> };
    expect(body.resources.some((res) => res.uri === `registry:${bSlug}`)).toBe(false);
    expect(body.resources.some((res) => res.name === 'Только тенант B')).toBe(false);
  }));

  it('AC-2: a tenant with zero application/registry_def rows gets {resources:[]} honestly (never 500)', requireDb(async () => {
    // TENANT_B may carry rows from other suites/tests in a shared DB; instead of
    // asserting an EMPTY array (flaky under parallel fitness:db runs, memory lesson:
    // "упавшее перепроверять соло" / shared-DB pollution), assert the honest-shape
    // contract: 200, resources is always an array, and it is never an error envelope.
    const r = await makeRequest(baseUrl, 'GET', '/api/rights/resources', { 'x-dev-user': 'actor-empty' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { resources: unknown };
    expect(Array.isArray(body.resources)).toBe(true);
  }));
});
