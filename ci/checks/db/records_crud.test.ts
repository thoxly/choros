// T-0264 · E13 — record create/list/get/update live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Covers:
//   - POST /api/records → 201, tenant-scoped row created under the governing
//     registry_def (data validated; application_id/registry_def_id/record_schema_version
//     surfaced via the registry_def join; created_at present).
//   - create → list (filtered by ?application_id= / ?registry_def_id=) → get → update
//     roundtrip within one tenant.
//   - DATA VALIDATION against the registry_def schema: a record whose data conforms
//     passes (201); a record whose data violates the schema → 400 VALIDATION; the same
//     guard runs on PUT (invalid update → 400).
//   - governing registry_def resolution: explicit registry_def_id; ambiguity (app with
//     2 reg-defs and no registry_def_id) → 409; missing reg-def → 404.
//   - 401 UNAUTHENTICATED when x-dev-user absent.
//   - AUDIT: a record.create / record.update audit event is appended on the chain
//     (read back from choros.audit_event under the migrator role).
//   - TENANT ISOLATION (the Враг target): an actor in tenant A cannot list, get, or
//     update tenant B's record — RLS-enforced through the real choros_app role.
//
// Tenant scoping is driven through registerRecordRoutes' injected resolveActorTenant:
// actor 'actor-a' → TENANT_A, 'actor-b' → TENANT_B. The route then runs withTenantTx
// under SET LOCAL choros.tenant_id (FORCE RLS), so the isolation proven here is the
// production RLS path, not a query-filter shim.
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
import { registerRecordRoutes } from '../../../src/http/records.js';

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

async function seedRecordDirect(
  c: pg.Client,
  tenantId: string,
  registryId: string,
  data: object,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, 'seed')`,
    [tenantId, id, registryId, JSON.stringify(data)],
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

// Cleanup stacks (deleted in reverse, child→parent FK order).
const recordCleanup: Array<{ tenantId: string; id: string }> = [];
const regDefCleanup: Array<{ tenantId: string; id: string }> = [];
const appCleanup: Array<{ tenantId: string; id: string }> = [];

// Fixtures created in beforeAll.
let appAId = ''; // tenant A, has exactly one registry_def (regAId)
let regAId = '';
let appAmbigId = ''; // tenant A, has TWO registry_defs → ambiguity probe
let regAmbig1Id = '';
let regAmbig2Id = '';
let appBId = ''; // tenant B, has one registry_def (regBId)
let regBId = '';

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
  registerRecordRoutes(router, {
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

    // Tenant A: an application with exactly one registry_def.
    appAId = await seedApplicationDirect(c, TENANT_A, `rec-app-a-${uuid().slice(0, 8)}`);
    regAId = await seedRegistryDefDirect(c, TENANT_A, appAId, `rec-reg-a-${uuid().slice(0, 8)}`, VALID_SCHEMA);

    // Tenant A: an application with TWO registry_defs (ambiguity probe).
    appAmbigId = await seedApplicationDirect(c, TENANT_A, `rec-app-amb-${uuid().slice(0, 8)}`);
    regAmbig1Id = await seedRegistryDefDirect(c, TENANT_A, appAmbigId, `rec-reg-amb1-${uuid().slice(0, 8)}`, VALID_SCHEMA);
    regAmbig2Id = await seedRegistryDefDirect(c, TENANT_A, appAmbigId, `rec-reg-amb2-${uuid().slice(0, 8)}`, VALID_SCHEMA);

    // Tenant B: an application with one registry_def (isolation probe).
    appBId = await seedApplicationDirect(c, TENANT_B, `rec-app-b-${uuid().slice(0, 8)}`);
    regBId = await seedRegistryDefDirect(c, TENANT_B, appBId, `rec-reg-b-${uuid().slice(0, 8)}`, VALID_SCHEMA);
  });

  regDefCleanup.push({ tenantId: TENANT_A, id: regAId });
  regDefCleanup.push({ tenantId: TENANT_A, id: regAmbig1Id });
  regDefCleanup.push({ tenantId: TENANT_A, id: regAmbig2Id });
  regDefCleanup.push({ tenantId: TENANT_B, id: regBId });
  appCleanup.push({ tenantId: TENANT_A, id: appAId });
  appCleanup.push({ tenantId: TENANT_A, id: appAmbigId });
  appCleanup.push({ tenantId: TENANT_B, id: appBId });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    // record rows first (FK to registry_def), then registry_def (FK to application),
    // then applications.
    for (const { tenantId, id } of [...recordCleanup].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.record WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
    for (const { tenantId, id } of [...regDefCleanup].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
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

// Read the newest audit_event of a given type whose subject = recordId (migrator role).
async function readAuditEventType(
  tenantId: string,
  recordId: string,
): Promise<string[]> {
  return withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    const { rows } = await c.query<{ type: string }>(
      `SELECT type FROM choros.audit_event
        WHERE tenant_id = $1 AND subject = $2
        ORDER BY seq ASC`,
      [tenantId, recordId],
    );
    await c.query('COMMIT');
    return rows.map((r) => r.type);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('records API — create/list/get/update (T-0264)', () => {
  it('401 when x-dev-user absent', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'POST', '/api/records', {
      application_id: appAId,
      data: { name: 'X' },
    });
    expect(r.statusCode).toBe(401);
  }));

  it('400 VALIDATION on bad application_id', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/records',
      { application_id: 'not-a-uuid', data: { name: 'X' } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('400 VALIDATION when data is missing', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/records',
      { application_id: appAId },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('create → list → get → update roundtrip (tenant A) with audit', requireDb(async () => {
    // CREATE — data conforms to VALID_SCHEMA (name required string + amount number).
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/records',
      { application_id: appAId, registry_def_id: regAId, data: { name: 'Alice', amount: 42 } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.body) as Record<string, unknown>;
    expect(typeof createdBody['id']).toBe('string');
    expect(createdBody['application_id']).toBe(appAId);
    expect(createdBody['registry_def_id']).toBe(regAId);
    expect(createdBody['record_schema_version']).toBe(1);
    expect(createdBody['data']).toEqual({ name: 'Alice', amount: 42 });
    expect(typeof createdBody['created_at']).toBe('number');
    const id = createdBody['id'] as string;
    recordCleanup.push({ tenantId: TENANT_A, id });

    // AUDIT — record.create must be on the chain.
    const afterCreate = await readAuditEventType(TENANT_A, id);
    expect(afterCreate).toContain('record.create');

    // GET one
    const got = await makeRequest(baseUrl, 'GET', `/api/records/${id}`, undefined, {
      'x-dev-user': 'actor-a',
    });
    expect(got.statusCode).toBe(200);
    const gotBody = JSON.parse(got.body) as Record<string, unknown>;
    expect(gotBody['id']).toBe(id);
    expect(gotBody['data']).toEqual({ name: 'Alice', amount: 42 });

    // LIST filtered by application_id — must include the created record.
    const listed = await makeRequest(
      baseUrl,
      'GET',
      `/api/records?application_id=${appAId}`,
      undefined,
      { 'x-dev-user': 'actor-a' },
    );
    expect(listed.statusCode).toBe(200);
    const listBody = JSON.parse(listed.body) as { records: Array<Record<string, unknown>> };
    expect(Array.isArray(listBody.records)).toBe(true);
    expect(listBody.records.some((r) => r['id'] === id)).toBe(true);
    expect(listBody.records.every((r) => r['application_id'] === appAId)).toBe(true);

    // LIST filtered by registry_def_id — must include the created record.
    const listedByReg = await makeRequest(
      baseUrl,
      'GET',
      `/api/records?registry_def_id=${regAId}`,
      undefined,
      { 'x-dev-user': 'actor-a' },
    );
    expect(listedByReg.statusCode).toBe(200);
    const listRegBody = JSON.parse(listedByReg.body) as { records: Array<Record<string, unknown>> };
    expect(listRegBody.records.some((r) => r['id'] === id)).toBe(true);

    // UPDATE — new conforming data.
    const updated = await makeRequest(
      baseUrl,
      'PUT',
      `/api/records/${id}`,
      { data: { name: 'Alice2', amount: 99 } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(updated.statusCode).toBe(200);
    const updatedBody = JSON.parse(updated.body) as Record<string, unknown>;
    expect(updatedBody['data']).toEqual({ name: 'Alice2', amount: 99 });
    expect((updatedBody['updated_at'] as number) >= (createdBody['updated_at'] as number)).toBe(true);

    // AUDIT — record.update must now also be on the chain.
    const afterUpdate = await readAuditEventType(TENANT_A, id);
    expect(afterUpdate).toContain('record.create');
    expect(afterUpdate).toContain('record.update');
  }));

  it('400 VALIDATION when data violates the registry_def schema (create)', requireDb(async () => {
    // Missing required `name` + unknown property → AJV rejects (additionalProperties:false).
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/records',
      { application_id: appAId, registry_def_id: regAId, data: { amount: 'not-a-number' } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(JSON.parse(r.body))).toMatch(/schema/i);
  }));

  it('400 VALIDATION when data is not a JSON object (create)', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/records',
      { application_id: appAId, registry_def_id: regAId, data: [1, 2, 3] },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('400 VALIDATION when an update violates the schema (PUT)', requireDb(async () => {
    // Create a valid record first.
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/records',
      { application_id: appAId, registry_def_id: regAId, data: { name: 'Bob' } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(created.statusCode).toBe(201);
    const id = (JSON.parse(created.body) as { id: string }).id;
    recordCleanup.push({ tenantId: TENANT_A, id });

    // PUT a schema-violating update (amount must be a number) → 400, row unchanged.
    const bad = await makeRequest(
      baseUrl,
      'PUT',
      `/api/records/${id}`,
      { data: { name: 'Bob', amount: 'oops' } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(bad.statusCode).toBe(400);

    const got = await makeRequest(baseUrl, 'GET', `/api/records/${id}`, undefined, {
      'x-dev-user': 'actor-a',
    });
    expect((JSON.parse(got.body) as { data: unknown }).data).toEqual({ name: 'Bob' });
  }));

  it('resolves the governing registry_def without registry_def_id (single reg-def app)', requireDb(async () => {
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/records',
      { application_id: appAId, data: { name: 'NoExplicitReg' } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.body) as Record<string, unknown>;
    expect(body['registry_def_id']).toBe(regAId);
    recordCleanup.push({ tenantId: TENANT_A, id: body['id'] as string });
  }));

  it('409 CONFLICT when the application has multiple registry_defs and none is specified', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/records',
      { application_id: appAmbigId, data: { name: 'Ambiguous' } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(409);
  }));

  it('404 when registry_def_id does not belong to the application', requireDb(async () => {
    // regBId belongs to tenant B; under actor-a (tenant A) it is not visible → 404.
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/records',
      { application_id: appAId, registry_def_id: regBId, data: { name: 'X' } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(404);
  }));

  it('404 when the application has no registry_def', requireDb(async () => {
    // Fresh app in tenant A with zero registry_defs.
    let emptyAppId = '';
    await withClient(migratorUrl(), async (c) => {
      emptyAppId = await seedApplicationDirect(c, TENANT_A, `rec-app-empty-${uuid().slice(0, 8)}`);
    });
    appCleanup.push({ tenantId: TENANT_A, id: emptyAppId });

    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/records',
      { application_id: emptyAppId, data: { name: 'X' } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(404);
  }));

  it("TENANT ISOLATION: actor A cannot GET tenant B's record → 404", requireDb(async () => {
    // Seed a record into TENANT_B (bypass RLS via migrator).
    let bRecId = '';
    await withClient(migratorUrl(), async (c) => {
      bRecId = await seedRecordDirect(c, TENANT_B, regBId, { name: 'B-record' });
    });
    recordCleanup.push({ tenantId: TENANT_B, id: bRecId });

    // Actor A (→ TENANT_A) tries to read B's record by id → RLS filters it → 404.
    const got = await makeRequest(baseUrl, 'GET', `/api/records/${bRecId}`, undefined, {
      'x-dev-user': 'actor-a',
    });
    expect(got.statusCode).toBe(404);

    // Sanity: actor B (→ TENANT_B) CAN read its own record → 200.
    const gotB = await makeRequest(baseUrl, 'GET', `/api/records/${bRecId}`, undefined, {
      'x-dev-user': 'actor-b',
    });
    expect(gotB.statusCode).toBe(200);
  }));

  it("TENANT ISOLATION: actor A cannot UPDATE tenant B's record → 404", requireDb(async () => {
    let bRecId = '';
    await withClient(migratorUrl(), async (c) => {
      bRecId = await seedRecordDirect(c, TENANT_B, regBId, { name: 'B-update-target' });
    });
    recordCleanup.push({ tenantId: TENANT_B, id: bRecId });

    // Actor A tries to UPDATE B's record → RLS filters it → 404 (row not visible).
    const upd = await makeRequest(
      baseUrl,
      'PUT',
      `/api/records/${bRecId}`,
      { data: { name: 'hacked' } },
      { 'x-dev-user': 'actor-a' },
    );
    expect(upd.statusCode).toBe(404);

    // B's record is unchanged.
    const got = await makeRequest(baseUrl, 'GET', `/api/records/${bRecId}`, undefined, {
      'x-dev-user': 'actor-b',
    });
    expect((JSON.parse(got.body) as { data: unknown }).data).toEqual({ name: 'B-update-target' });
  }));

  it("TENANT ISOLATION: actor A list never contains tenant B's records", requireDb(async () => {
    let bRecId = '';
    await withClient(migratorUrl(), async (c) => {
      bRecId = await seedRecordDirect(c, TENANT_B, regBId, { name: 'B-list-target' });
    });
    recordCleanup.push({ tenantId: TENANT_B, id: bRecId });

    const listed = await makeRequest(baseUrl, 'GET', '/api/records', undefined, {
      'x-dev-user': 'actor-a',
    });
    expect(listed.statusCode).toBe(200);
    const listBody = JSON.parse(listed.body) as { records: Array<Record<string, unknown>> };
    expect(listBody.records.some((r) => r['id'] === bRecId)).toBe(false);
  }));
});
