// T-0262 · E13 — applications create/list/get live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Covers:
//   - POST /api/applications → 201, tenant-scoped row created (slug/display_name/
//     description mapped; tier='draft'; created_at present).
//   - create → list → get roundtrip within one tenant.
//   - 400 VALIDATION on bad slug / missing display_name.
//   - 409 CONFLICT on duplicate slug within the same tenant (UNIQUE (tenant_id, slug), AC-8).
//   - 401 UNAUTHENTICATED when x-dev-user absent.
//   - TENANT ISOLATION (the Враг target): an actor in tenant A cannot list or get
//     tenant B's application — RLS-enforced through the real choros_app role.
//
// Tenant scoping is driven through registerApplicationRoutes' injected
// resolveActorTenant: actor 'actor-a' → TENANT_A, 'actor-b' → TENANT_B. The route
// then runs withTenantTx under SET LOCAL choros.tenant_id (FORCE RLS), so the
// isolation proven here is the production RLS path, not a query-filter shim.
//
// The pool passed to the route uses the choros_app (NOBYPASSRLS) role via appUrl()
// so cross-tenant denial is enforced by the DB policy, exactly as in production.
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerApplicationRoutes } from '../../../src/http/applications.js';

// ---------------------------------------------------------------------------
// requireDb — skip cleanly if no DATABASE_URL
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

const hasDb = Boolean(process.env['DATABASE_URL']);

// ---------------------------------------------------------------------------
// Seed helper — direct INSERT under the migrator role (bypass RLS).
// ---------------------------------------------------------------------------

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
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 'draft', 0, 0)`,
    [tenantId, id, slug],
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

// ---------------------------------------------------------------------------
// Server + cleanup
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;
const cleanupIds: Array<{ tenantId: string; id: string }> = [];

// Stub resolver: dev-user slug → tenant. Exercises cross-tenant isolation
// (actor-a is bound to TENANT_A, actor-b to TENANT_B) without Keycloak.
async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'actor-a') return TENANT_A;
  if (slug === 'actor-b') return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(async () => {
  if (!hasDb) return;

  // App-role pool (NOBYPASSRLS) — cross-tenant denial enforced by the DB policy.
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerApplicationRoutes(router, {
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

  // Ensure both tenant rows exist (FORCE RLS on application requires nothing here,
  // but a tenant row is good hygiene + matches the cross-tenant fixture).
  await withClient(migratorUrl(), async (c) => {
    await seedTenantRow(c, TENANT_A);
    await seedTenantRow(c, TENANT_B);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  // Delete every application this suite created/seeded (reverse order).
  await withClient(migratorUrl(), async (c) => {
    for (const { tenantId, id } of [...cleanupIds].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applications API — create/list/get (T-0262)', () => {
  it('401 when x-dev-user absent', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'POST', '/api/applications', {
      slug: `app-${uuid().slice(0, 8)}`,
      display_name: 'X',
    });
    expect(r.statusCode).toBe(401);
  }));

  it('400 VALIDATION on bad slug', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/applications',
      { slug: 'Not A Slug!', display_name: 'X' },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('400 VALIDATION on missing display_name', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/applications',
      { slug: `app-${uuid().slice(0, 8)}` },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('create → list → get roundtrip (tenant A)', requireDb(async () => {
    const slug = `crud-app-${uuid().slice(0, 8)}`;

    // CREATE
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/applications',
      { slug, display_name: 'Roundtrip App', description: 'desc here' },
      { 'x-dev-user': 'actor-a' },
    );
    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.body) as Record<string, unknown>;
    expect(typeof createdBody['id']).toBe('string');
    expect(createdBody['slug']).toBe(slug);
    expect(createdBody['display_name']).toBe('Roundtrip App');
    expect(createdBody['description']).toBe('desc here');
    expect(createdBody['tier']).toBe('draft');
    expect(typeof createdBody['created_at']).toBe('number');
    const id = createdBody['id'] as string;
    cleanupIds.push({ tenantId: TENANT_A, id });

    // GET one
    const got = await makeRequest(baseUrl, 'GET', `/api/applications/${id}`, undefined, {
      'x-dev-user': 'actor-a',
    });
    expect(got.statusCode).toBe(200);
    const gotBody = JSON.parse(got.body) as Record<string, unknown>;
    expect(gotBody['id']).toBe(id);
    expect(gotBody['slug']).toBe(slug);

    // LIST — must include the created app.
    const listed = await makeRequest(baseUrl, 'GET', '/api/applications', undefined, {
      'x-dev-user': 'actor-a',
    });
    expect(listed.statusCode).toBe(200);
    const listBody = JSON.parse(listed.body) as { applications: Array<Record<string, unknown>> };
    expect(Array.isArray(listBody.applications)).toBe(true);
    expect(listBody.applications.some((a) => a['id'] === id)).toBe(true);
  }));

  it('409 CONFLICT on duplicate slug within the same tenant (AC-8)', requireDb(async () => {
    const slug = `dup-app-${uuid().slice(0, 8)}`;
    const first = await makeRequest(
      baseUrl,
      'POST',
      '/api/applications',
      { slug, display_name: 'First' },
      { 'x-dev-user': 'actor-a' },
    );
    expect(first.statusCode).toBe(201);
    cleanupIds.push({ tenantId: TENANT_A, id: (JSON.parse(first.body) as { id: string }).id });

    const second = await makeRequest(
      baseUrl,
      'POST',
      '/api/applications',
      { slug, display_name: 'Second' },
      { 'x-dev-user': 'actor-a' },
    );
    expect(second.statusCode).toBe(409);
  }));

  it('TENANT ISOLATION: actor A cannot GET tenant B\'s application → 404', requireDb(async () => {
    // Seed an application directly into TENANT_B (bypass RLS via migrator).
    let bId = '';
    await withClient(migratorUrl(), async (c) => {
      bId = await seedApplicationDirect(c, TENANT_B, `iso-b-${uuid().slice(0, 8)}`);
    });
    cleanupIds.push({ tenantId: TENANT_B, id: bId });

    // Actor A (→ TENANT_A) tries to read B's app by id → RLS filters it → 404.
    const got = await makeRequest(baseUrl, 'GET', `/api/applications/${bId}`, undefined, {
      'x-dev-user': 'actor-a',
    });
    expect(got.statusCode).toBe(404);

    // Sanity: actor B (→ TENANT_B) CAN read its own app → 200.
    const gotB = await makeRequest(baseUrl, 'GET', `/api/applications/${bId}`, undefined, {
      'x-dev-user': 'actor-b',
    });
    expect(gotB.statusCode).toBe(200);
  }));

  it('TENANT ISOLATION: actor A list never contains tenant B\'s rows', requireDb(async () => {
    // Seed a uniquely-slugged app into TENANT_B.
    const bSlug = `iso-list-b-${uuid().slice(0, 8)}`;
    let bId = '';
    await withClient(migratorUrl(), async (c) => {
      bId = await seedApplicationDirect(c, TENANT_B, bSlug);
    });
    cleanupIds.push({ tenantId: TENANT_B, id: bId });

    const listed = await makeRequest(baseUrl, 'GET', '/api/applications', undefined, {
      'x-dev-user': 'actor-a',
    });
    expect(listed.statusCode).toBe(200);
    const listBody = JSON.parse(listed.body) as { applications: Array<Record<string, unknown>> };
    expect(listBody.applications.some((a) => a['id'] === bId)).toBe(false);
    expect(listBody.applications.some((a) => a['slug'] === bSlug)).toBe(false);
  }));
});
