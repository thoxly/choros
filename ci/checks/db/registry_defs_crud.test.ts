// T-0263 · E13 — registry_def create/list/get live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Covers:
//   - POST /api/registry-defs → 201, tenant-scoped row created under an application
//     (application_id/slug/display_name/record_schema mapped; record_schema_version=1).
//   - create → list (filtered by ?application_id=) → get roundtrip within one tenant.
//   - 400 VALIDATION on bad field-schema (record-schema-validator rejects a malformed
//     JSON-Schema definition: unknown field `type`).
//   - 400 VALIDATION on bad slug / missing display_name / bad application_id.
//   - 409 CONFLICT on duplicate slug for the same application (UNIQUE (tenant_id,
//     application_id, slug), migration 004).
//   - 401 UNAUTHENTICATED when x-dev-user absent.
//   - VERSIONING (migration 070): a PUT that changes record_schema bumps
//     record_schema_version (1 → 2) and the GET surfaces the new version.
//   - TENANT ISOLATION (the Враг target): an actor in tenant A cannot list or get
//     tenant B's registry_def — RLS-enforced through the real choros_app role.
//
// Tenant scoping is driven through registerRegistryDefRoutes' injected crudDeps
// resolveActorTenant: actor 'actor-a' → TENANT_A, 'actor-b' → TENANT_B. The route
// then runs withTenantTx under SET LOCAL choros.tenant_id (FORCE RLS), so the
// isolation proven here is the production RLS path, not a query-filter shim.
//
// The pool passed to the route uses the choros_app (NOBYPASSRLS) role via appUrl()
// so cross-tenant denial is enforced by the DB policy, exactly as in production.
//
// The PUT/PATCH schema-change handler keys tenancy off DEV_TENANT_ID (T-0177), so
// the versioning probe sets DEV_TENANT_ID = TENANT_A and seeds in TENANT_A.
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRegistryDefRoutes } from '../../../src/http/registry-defs.js';

// The PUT/PATCH schema-change path (T-0177) scopes to DEV_TENANT_ID, captured by
// registry-defs.ts at import time (ESM import is hoisted, so the test cannot
// override it after the fact — same constraint as schema_change_api.test.ts).
// The versioning probe therefore runs against the DEV_TENANT_ID tenant via a
// dedicated actor ('actor-dev' → DEV_TENANT_ID); the create/list/get + isolation
// probes use TENANT_A / TENANT_B through the resolveActorTenant resolver.
const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

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
// Seed helpers — direct INSERT under the migrator role (bypass RLS).
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

async function seedRegistryDefDirect(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  slug: string,
  recordSchema: object,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description,
        record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
    [tenantId, id, applicationId, slug, JSON.stringify(recordSchema)],
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
const regDefCleanup: Array<{ tenantId: string; id: string }> = [];
const appCleanup: Array<{ tenantId: string; id: string }> = [];

// App ids created in beforeAll for the happy-path tests (one per tenant).
let appAId = '';
let appBId = '';

// App id created in DEV_TENANT_ID for the versioning probe (PUT path scopes there).
let appDevId = '';

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'actor-a') return TENANT_A;
  if (slug === 'actor-b') return TENANT_B;
  if (slug === 'actor-dev') return DEV_TENANT_ID;
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(async () => {
  if (!hasDb) return;

  // App-role pool (NOBYPASSRLS) — cross-tenant denial enforced by the DB policy.
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  // PUT/PATCH (authz default) + CRUD (crudDeps) on the SAME module/router.
  registerRegistryDefRoutes(router, appPool, undefined, {
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
    // DEV_TENANT_ID tenant row exists from seed migrations; only the app is needed.
    appAId = await seedApplicationDirect(c, TENANT_A, `regdef-app-a-${uuid().slice(0, 8)}`);
    appBId = await seedApplicationDirect(c, TENANT_B, `regdef-app-b-${uuid().slice(0, 8)}`);
    appDevId = await seedApplicationDirect(c, DEV_TENANT_ID, `regdef-app-dev-${uuid().slice(0, 8)}`);
  });
  appCleanup.push({ tenantId: TENANT_A, id: appAId });
  appCleanup.push({ tenantId: TENANT_B, id: appBId });
  appCleanup.push({ tenantId: DEV_TENANT_ID, id: appDevId });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    // registry_def rows first (FK to application), then schema-history (FK to registry_def),
    // then applications.
    for (const { tenantId, id } of [...regDefCleanup].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `DELETE FROM choros.registry_schema_history WHERE tenant_id = $1 AND registry_id = $2`,
        [tenantId, id],
      );
      await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
    for (const { tenantId, id } of [...appCleanup].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// A valid field-schema definition: name (required string) + amount (number).
const VALID_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    amount: { type: 'number', title: 'Amount' },
  },
  required: ['name'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registry_def API — create/list/get (T-0263)', () => {
  it('401 when x-dev-user absent', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'POST', '/api/registry-defs', {
      application_id: appAId,
      slug: `rd-${uuid().slice(0, 8)}`,
      display_name: 'X',
      record_schema: VALID_SCHEMA,
    });
    expect(r.statusCode).toBe(401);
  }));

  it('400 VALIDATION on bad application_id', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: 'not-a-uuid', slug: `rd-${uuid().slice(0, 8)}`, display_name: 'X', record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('400 VALIDATION on bad slug', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: appAId, slug: 'Not A Slug!', display_name: 'X', record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('400 VALIDATION on missing display_name', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: appAId, slug: `rd-${uuid().slice(0, 8)}`, record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('400 VALIDATION on malformed field-schema (record-schema-validator rejects)', requireDb(async () => {
    // Unknown JSON-Schema `type` → AJV strict-mode compile failure → 400.
    const badSchema = { type: 'object', properties: { foo: { type: 'bogus-type' } } };
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: appAId, slug: `rd-${uuid().slice(0, 8)}`, display_name: 'Bad', record_schema: badSchema },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
    const body = JSON.parse(r.body) as { error?: { message?: string } };
    expect(JSON.stringify(body)).toMatch(/record_schema/i);
  }));

  it('400 VALIDATION when record_schema is an array (not a schema object)', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: appAId, slug: `rd-${uuid().slice(0, 8)}`, display_name: 'Arr', record_schema: [] },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('create → list(by application_id) → get roundtrip (tenant A) — version starts at 1', requireDb(async () => {
    const slug = `rd-crud-${uuid().slice(0, 8)}`;

    // CREATE
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: appAId, slug, display_name: 'Roundtrip Reg', description: 'desc', record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.body) as Record<string, unknown>;
    expect(typeof createdBody['id']).toBe('string');
    expect(createdBody['application_id']).toBe(appAId);
    expect(createdBody['slug']).toBe(slug);
    expect(createdBody['display_name']).toBe('Roundtrip Reg');
    expect(createdBody['description']).toBe('desc');
    expect(createdBody['record_schema_version']).toBe(1);
    expect(typeof createdBody['created_at']).toBe('number');
    expect((createdBody['record_schema'] as { required?: unknown }).required).toEqual(['name']);
    const id = createdBody['id'] as string;
    regDefCleanup.push({ tenantId: TENANT_A, id });

    // GET one
    const got = await makeRequest(baseUrl, 'GET', `/api/registry-defs/${id}`, undefined, {
      'x-dev-user': 'actor-a',
    });
    expect(got.statusCode).toBe(200);
    const gotBody = JSON.parse(got.body) as Record<string, unknown>;
    expect(gotBody['id']).toBe(id);
    expect(gotBody['record_schema_version']).toBe(1);

    // LIST filtered by application_id — must include the created reg-def.
    const listed = await makeRequest(
      baseUrl,
      'GET',
      `/api/registry-defs?application_id=${appAId}`,
      undefined,
      { 'x-dev-user': 'actor-a' },
    );
    expect(listed.statusCode).toBe(200);
    const listBody = JSON.parse(listed.body) as { registry_defs: Array<Record<string, unknown>> };
    expect(Array.isArray(listBody.registry_defs)).toBe(true);
    expect(listBody.registry_defs.some((r) => r['id'] === id)).toBe(true);
    // Every listed row must belong to the filtered application.
    expect(listBody.registry_defs.every((r) => r['application_id'] === appAId)).toBe(true);
  }));

  it('409 CONFLICT on duplicate slug for the same application', requireDb(async () => {
    const slug = `rd-dup-${uuid().slice(0, 8)}`;
    const first = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: appAId, slug, display_name: 'First', record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(first.statusCode).toBe(201);
    regDefCleanup.push({ tenantId: TENANT_A, id: (JSON.parse(first.body) as { id: string }).id });

    const second = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: appAId, slug, display_name: 'Second', record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(second.statusCode).toBe(409);
  }));

  // -------------------------------------------------------------------------
  // T-0650 [UX-study §7]: slug is now OPTIONAL — auto-generated from
  // display_name when omitted, with atomic collision-suffix (-2/…) on the real
  // UNIQUE(tenant_id, application_id, slug) index.
  // -------------------------------------------------------------------------

  it('T-0650: omitted slug → 201 with an auto-generated slug derived from display_name', requireDb(async () => {
    const uniqueName = `Автонабор ${uuid().slice(0, 8)}`;
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: appAId, display_name: uniqueName, record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    regDefCleanup.push({ tenantId: TENANT_A, id: body['id'] as string });
    expect(body['slug']).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(body['slug']).toMatch(/^avtonabor/);
  }));

  it('T-0650: two creates with the SAME display_name under the same app → second gets -2 (not 409)', requireDb(async () => {
    const sameName = `Дубликат набора ${uuid().slice(0, 8)}`;

    const first = await makeRequest(
      baseUrl, 'POST', '/api/registry-defs',
      { application_id: appAId, display_name: sameName, record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.body) as Record<string, unknown>;
    regDefCleanup.push({ tenantId: TENANT_A, id: firstBody['id'] as string });

    const second = await makeRequest(
      baseUrl, 'POST', '/api/registry-defs',
      { application_id: appAId, display_name: sameName, record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(second.statusCode).toBe(201); // NOT 409 — auto-slug resolves the collision.
    const secondBody = JSON.parse(second.body) as Record<string, unknown>;
    regDefCleanup.push({ tenantId: TENANT_A, id: secondBody['id'] as string });

    expect(secondBody['slug']).toBe(`${firstBody['slug']}-2`);
  }));

  it('T-0650: explicit slug still validates as before (backward compat)', requireDb(async () => {
    const r = await makeRequest(
      baseUrl, 'POST', '/api/registry-defs',
      { application_id: appAId, display_name: 'X', slug: 'Not A Slug!', record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('404 when application_id does not exist in the tenant (FK)', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: uuid(), slug: `rd-${uuid().slice(0, 8)}`, display_name: 'Orphan', record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(404);
  }));

  it('VERSIONING (migration 070): PUT that changes record_schema bumps version 1→2', requireDb(async () => {
    // Runs in DEV_TENANT_ID (the tenant the PUT path scopes to). 'actor-dev' →
    // DEV_TENANT_ID via the resolver, so CREATE and PUT hit the same tenant.
    const slug = `rd-ver-${uuid().slice(0, 8)}`;
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      { application_id: appDevId, slug, display_name: 'Versioned', record_schema: VALID_SCHEMA },
      { 'x-dev-user': 'actor-dev' },
    );
    expect(created.statusCode).toBe(201);
    const id = (JSON.parse(created.body) as { id: string }).id;
    regDefCleanup.push({ tenantId: DEV_TENANT_ID, id });
    expect((JSON.parse(created.body) as { record_schema_version: number }).record_schema_version).toBe(1);

    // PUT a changed schema (add a field) — soft change, no deps → 200 updated:true.
    const newSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        amount: { type: 'number', title: 'Amount' },
        note: { type: 'string', title: 'Note' },
      },
      required: ['name'],
      additionalProperties: false,
    };
    const put = await makeRequest(
      baseUrl,
      'PUT',
      `/api/registry-defs/${id}`,
      { record_schema: newSchema },
      { 'x-dev-user': 'actor-dev' },
    );
    expect(put.statusCode).toBe(200);
    expect((JSON.parse(put.body) as { updated: boolean }).updated).toBe(true);

    // GET — version must now be 2 (trigger registry_def_schema_version_increment).
    const got = await makeRequest(baseUrl, 'GET', `/api/registry-defs/${id}`, undefined, {
      'x-dev-user': 'actor-dev',
    });
    expect(got.statusCode).toBe(200);
    expect((JSON.parse(got.body) as { record_schema_version: number }).record_schema_version).toBe(2);

    // History table must hold the v2 row (trigger registry_def_schema_version_audit).
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT_ID}'`);
      const { rows } = await c.query<{ schema_version: number }>(
        `SELECT schema_version FROM choros.registry_schema_history
          WHERE tenant_id = $1 AND registry_id = $2 ORDER BY schema_version`,
        [DEV_TENANT_ID, id],
      );
      await c.query('COMMIT');
      expect(rows.some((row) => Number(row.schema_version) === 2)).toBe(true);
    });
  }));

  it("TENANT ISOLATION: actor A cannot GET tenant B's registry_def → 404", requireDb(async () => {
    // Seed a registry_def into TENANT_B's application (bypass RLS via migrator).
    let bId = '';
    await withClient(migratorUrl(), async (c) => {
      bId = await seedRegistryDefDirect(c, TENANT_B, appBId, `iso-b-${uuid().slice(0, 8)}`, VALID_SCHEMA);
    });
    regDefCleanup.push({ tenantId: TENANT_B, id: bId });

    // Actor A (→ TENANT_A) tries to read B's reg-def by id → RLS filters it → 404.
    const got = await makeRequest(baseUrl, 'GET', `/api/registry-defs/${bId}`, undefined, {
      'x-dev-user': 'actor-a',
    });
    expect(got.statusCode).toBe(404);

    // Sanity: actor B (→ TENANT_B) CAN read its own reg-def → 200.
    const gotB = await makeRequest(baseUrl, 'GET', `/api/registry-defs/${bId}`, undefined, {
      'x-dev-user': 'actor-b',
    });
    expect(gotB.statusCode).toBe(200);
  }));

  it("TENANT ISOLATION: actor A list never contains tenant B's rows", requireDb(async () => {
    const bSlug = `iso-list-b-${uuid().slice(0, 8)}`;
    let bId = '';
    await withClient(migratorUrl(), async (c) => {
      bId = await seedRegistryDefDirect(c, TENANT_B, appBId, bSlug, VALID_SCHEMA);
    });
    regDefCleanup.push({ tenantId: TENANT_B, id: bId });

    const listed = await makeRequest(baseUrl, 'GET', '/api/registry-defs', undefined, {
      'x-dev-user': 'actor-a',
    });
    expect(listed.statusCode).toBe(200);
    const listBody = JSON.parse(listed.body) as { registry_defs: Array<Record<string, unknown>> };
    expect(listBody.registry_defs.some((r) => r['id'] === bId)).toBe(false);
    expect(listBody.registry_defs.some((r) => r['slug'] === bSlug)).toBe(false);
  }));
});
