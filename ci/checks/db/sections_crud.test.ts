// T-0551 · E-NAV-IA — sections (разделы) CRUD live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Covers:
//   - GET /api/sections → 200, sorted (sort_order, name).
//   - POST /api/sections → 201; 409 CONFLICT on duplicate name within the tenant.
//   - PATCH /api/sections/:id → rename + reorder; identity preserved.
//   - DELETE /api/sections/:id → SOFT: bound apps' section_id → NULL, section removed,
//     apps NOT deleted; 404 on second delete.
//   - 401 UNAUTHENTICATED when x-dev-user absent.
//   - TENANT ISOLATION: actor A never sees/mutates/deletes tenant B's sections.
//   - PATCH /api/applications/:id { section_id } assigns/clears; foreign section_id → 404.
//
// Tenant scoping is driven through registerSectionRoutes' injected resolveActorTenant
// (actor-a → TENANT_A, actor-b → TENANT_B). Routes run withTenantTx under SET LOCAL
// choros.tenant_id (FORCE RLS), via the choros_app (NOBYPASSRLS) role — so the
// isolation proven here is the production RLS path, not a query-filter shim.
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerSectionRoutes } from '../../../src/http/sections.js';
import { registerApplicationRoutes } from '../../../src/http/applications.js';

const hasDb = Boolean(process.env['DATABASE_URL']);

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!hasDb) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedSectionDirect(c: pg.Client, tenantId: string, name: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.section (tenant_id, id, name, sort_order, created_at, updated_at)
     VALUES ($1, $2, $3, 0, 0, 0)`,
    [tenantId, id, name],
  );
  await c.query('COMMIT');
  return id;
}

async function seedApplicationDirect(
  c: pg.Client,
  tenantId: string,
  slug: string,
  sectionId: string | null = null,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, description, section_id, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, $4, 'draft', 0, 0)`,
    [tenantId, id, slug, sectionId],
  );
  await c.query('COMMIT');
  return id;
}

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { ...extraHeaders };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const parsed = new URL(baseUrl + path);
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
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;
const cleanupSections: Array<{ tenantId: string; id: string }> = [];
const cleanupApps: Array<{ tenantId: string; id: string }> = [];

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'actor-a') return TENANT_A;
  if (slug === 'actor-b') return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerSectionRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
  registerApplicationRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
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
    for (const { tenantId, id } of [...cleanupApps].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
    for (const { tenantId, id } of [...cleanupSections].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.section WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('sections API — CRUD (T-0551)', () => {
  it('401 when x-dev-user absent', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'POST', '/api/sections', { name: 'X' });
    expect(r.statusCode).toBe(401);
  }));

  it('400 VALIDATION on empty name', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'POST', '/api/sections', { name: '   ' }, { 'x-dev-user': 'actor-a' });
    expect(r.statusCode).toBe(400);
  }));

  it('create → list → patch → delete (tenant A)', requireDb(async () => {
    const name = `Sec ${uuid().slice(0, 8)}`;

    const created = await makeRequest(
      baseUrl, 'POST', '/api/sections',
      { name, sort_order: 5 },
      { 'x-dev-user': 'actor-a' },
    );
    expect(created.statusCode).toBe(201);
    const cb = JSON.parse(created.body) as Record<string, unknown>;
    expect(typeof cb['id']).toBe('string');
    expect(cb['name']).toBe(name);
    expect(cb['sort_order']).toBe(5);
    const id = cb['id'] as string;
    cleanupSections.push({ tenantId: TENANT_A, id });

    // LIST includes it.
    const listed = await makeRequest(baseUrl, 'GET', '/api/sections', undefined, { 'x-dev-user': 'actor-a' });
    expect(listed.statusCode).toBe(200);
    const lb = JSON.parse(listed.body) as { sections: Array<Record<string, unknown>> };
    expect(lb.sections.some((s) => s['id'] === id)).toBe(true);

    // PATCH rename + reorder.
    const renamed = `${name} renamed`;
    const patched = await makeRequest(
      baseUrl, 'PATCH', `/api/sections/${id}`,
      { name: renamed, sort_order: 1 },
      { 'x-dev-user': 'actor-a' },
    );
    expect(patched.statusCode).toBe(200);
    const pb = JSON.parse(patched.body) as Record<string, unknown>;
    expect(pb['id']).toBe(id); // identity preserved
    expect(pb['name']).toBe(renamed);
    expect(pb['sort_order']).toBe(1);

    // DELETE.
    const del = await makeRequest(baseUrl, 'DELETE', `/api/sections/${id}`, undefined, { 'x-dev-user': 'actor-a' });
    expect(del.statusCode).toBe(204);
    // Second delete → 404.
    const del2 = await makeRequest(baseUrl, 'DELETE', `/api/sections/${id}`, undefined, { 'x-dev-user': 'actor-a' });
    expect(del2.statusCode).toBe(404);
  }));

  it('409 CONFLICT on duplicate section name within tenant', requireDb(async () => {
    const name = `Dup ${uuid().slice(0, 8)}`;
    const first = await makeRequest(baseUrl, 'POST', '/api/sections', { name }, { 'x-dev-user': 'actor-a' });
    expect(first.statusCode).toBe(201);
    cleanupSections.push({ tenantId: TENANT_A, id: (JSON.parse(first.body) as { id: string }).id });

    const second = await makeRequest(baseUrl, 'POST', '/api/sections', { name }, { 'x-dev-user': 'actor-a' });
    expect(second.statusCode).toBe(409);
  }));

  it('SOFT delete: apps move to section_id=NULL, apps NOT deleted', requireDb(async () => {
    // Create section + app bound to it.
    const sec = await makeRequest(
      baseUrl, 'POST', '/api/sections', { name: `Soft ${uuid().slice(0, 8)}` }, { 'x-dev-user': 'actor-a' },
    );
    const secId = (JSON.parse(sec.body) as { id: string }).id;

    let appId = '';
    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplicationDirect(c, TENANT_A, `soft-app-${uuid().slice(0, 8)}`, secId);
    });
    cleanupApps.push({ tenantId: TENANT_A, id: appId });

    // Delete the section.
    const del = await makeRequest(baseUrl, 'DELETE', `/api/sections/${secId}`, undefined, { 'x-dev-user': 'actor-a' });
    expect(del.statusCode).toBe(204);

    // App still exists, section_id cleared.
    const got = await makeRequest(baseUrl, 'GET', `/api/applications/${appId}`, undefined, { 'x-dev-user': 'actor-a' });
    expect(got.statusCode).toBe(200);
    const gb = JSON.parse(got.body) as Record<string, unknown>;
    expect(gb['section_id']).toBe(null);
  }));

  it('PATCH /api/applications/:id { section_id } assigns + clears; carries section_name', requireDb(async () => {
    const secName = `Assign ${uuid().slice(0, 8)}`;
    const sec = await makeRequest(baseUrl, 'POST', '/api/sections', { name: secName }, { 'x-dev-user': 'actor-a' });
    const secId = (JSON.parse(sec.body) as { id: string }).id;
    cleanupSections.push({ tenantId: TENANT_A, id: secId });

    let appId = '';
    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplicationDirect(c, TENANT_A, `assign-app-${uuid().slice(0, 8)}`);
    });
    cleanupApps.push({ tenantId: TENANT_A, id: appId });

    // Assign.
    const assigned = await makeRequest(
      baseUrl, 'PATCH', `/api/applications/${appId}`, { section_id: secId }, { 'x-dev-user': 'actor-a' },
    );
    expect(assigned.statusCode).toBe(200);
    const ab = JSON.parse(assigned.body) as Record<string, unknown>;
    expect(ab['section_id']).toBe(secId);
    expect(ab['section_name']).toBe(secName);

    // Clear.
    const cleared = await makeRequest(
      baseUrl, 'PATCH', `/api/applications/${appId}`, { section_id: null }, { 'x-dev-user': 'actor-a' },
    );
    expect(cleared.statusCode).toBe(200);
    const clb = JSON.parse(cleared.body) as Record<string, unknown>;
    expect(clb['section_id']).toBe(null);
    expect(clb['section_name']).toBe(null);
  }));

  it('PATCH application with FOREIGN section_id → 404', requireDb(async () => {
    // Section in TENANT_B.
    let bSecId = '';
    await withClient(migratorUrl(), async (c) => {
      bSecId = await seedSectionDirect(c, TENANT_B, `foreign-${uuid().slice(0, 8)}`);
    });
    cleanupSections.push({ tenantId: TENANT_B, id: bSecId });

    let appId = '';
    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplicationDirect(c, TENANT_A, `foreign-app-${uuid().slice(0, 8)}`);
    });
    cleanupApps.push({ tenantId: TENANT_A, id: appId });

    // Actor A tries to bind its app to B's section → 404 (not a raw FK error).
    const r = await makeRequest(
      baseUrl, 'PATCH', `/api/applications/${appId}`, { section_id: bSecId }, { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(404);
  }));

  it('TENANT ISOLATION: actor A list never contains tenant B sections', requireDb(async () => {
    const bName = `iso-b-${uuid().slice(0, 8)}`;
    let bId = '';
    await withClient(migratorUrl(), async (c) => {
      bId = await seedSectionDirect(c, TENANT_B, bName);
    });
    cleanupSections.push({ tenantId: TENANT_B, id: bId });

    const listed = await makeRequest(baseUrl, 'GET', '/api/sections', undefined, { 'x-dev-user': 'actor-a' });
    expect(listed.statusCode).toBe(200);
    const lb = JSON.parse(listed.body) as { sections: Array<Record<string, unknown>> };
    expect(lb.sections.some((s) => s['id'] === bId)).toBe(false);
    expect(lb.sections.some((s) => s['name'] === bName)).toBe(false);
  }));

  it('TENANT ISOLATION: actor A cannot DELETE tenant B section → 404', requireDb(async () => {
    let bId = '';
    await withClient(migratorUrl(), async (c) => {
      bId = await seedSectionDirect(c, TENANT_B, `iso-del-b-${uuid().slice(0, 8)}`);
    });
    cleanupSections.push({ tenantId: TENANT_B, id: bId });

    const del = await makeRequest(baseUrl, 'DELETE', `/api/sections/${bId}`, undefined, { 'x-dev-user': 'actor-a' });
    expect(del.statusCode).toBe(404);

    // Sanity: it still exists for B.
    const listB = await makeRequest(baseUrl, 'GET', '/api/sections', undefined, { 'x-dev-user': 'actor-b' });
    const lbB = JSON.parse(listB.body) as { sections: Array<Record<string, unknown>> };
    expect(lbB.sections.some((s) => s['id'] === bId)).toBe(true);
  }));
});
