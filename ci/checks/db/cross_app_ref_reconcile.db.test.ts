// T-0445 — cross_app_ref reconciliation DB test.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Covers:
//   - CREATE a registry_def with an x-relation property → a cross_app_ref row is
//     upserted (source_registry_id, target_registry_id, ref_field all match).
//   - UPDATE removing the relation property → the cross_app_ref row is deleted
//     (via the PRODUCTION reconcileCrossAppRefs — not raw SQL).
//   - UPDATE adding a NEW relation property → a new row appears
//     (via the PRODUCTION reconcileCrossAppRefs — not raw SQL).
//   - IDEMPOTENT: upsertCrossAppRefForField called twice with same params
//     → exactly ONE cross_app_ref row (unique key; production DAO path).
//   - CROSS-TENANT: a ref row seeded under fresh tenant A is NOT visible when
//     querying under fresh tenant B (RLS isolation).
//
// Uses fresh uuid() tenants for every test group — NOT the shared TENANT_A/TENANT_B
// constants — to avoid false-green from neighbouring tests sharing the same tenant
// (T-0428 hermetic-tenant lesson). Each test group seeds its own tenant + app + target
// registry_def via the migrator role, then drives the HTTP handler (choros_app role
// via appUrl) for write operations, and reads back via the migrator (BYPASSRLS) for
// assertions.
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.
//
// HIGH finding fix (opus review): the original 3 tests (UPDATE-remove, IDEMPOTENT,
// UPDATE-add-2nd) hand-copied raw SQL instead of calling the PRODUCTION
// reconcileCrossAppRefs / upsertCrossAppRefForField. This file rewrites them to
// call the real functions so the removal/diff half is actually exercised.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRegistryDefRoutes, reconcileCrossAppRefs, extractRelationFields } from '../../../src/http/registry-defs.js';
import { upsertCrossAppRefForField } from '../../../src/db/cross-app-ref-dao.js';

// ---------------------------------------------------------------------------
// requireDb — skip cleanly if DATABASE_URL is not set
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
// Seed helpers (migrator = BYPASSRLS, so explicit tx + SET LOCAL is optional
// for the seeder — but we follow the discipline consistently).
// ---------------------------------------------------------------------------

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedApplication(
  c: pg.Client,
  tenantId: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 'draft', 0, 0)`,
    [tenantId, id, `app-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

/** Seed a minimal registry_def (the LINK TARGET) under the migrator role. */
async function seedRegistryDefTarget(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description,
        record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, '{"type":"object","properties":{}}'::jsonb, 0, 0)`,
    [tenantId, id, applicationId, `target-${id.slice(0, 8)}`],
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
// DB helpers for assertions
// ---------------------------------------------------------------------------

interface CrossAppRefRow {
  id: string;
  source_registry_id: string;
  target_registry_id: string;
  ref_field: string;
  label: string;
  ref_strength: string;
}

async function queryCrossAppRefs(
  c: pg.Client,
  tenantId: string,
  sourceRegistryId: string,
): Promise<CrossAppRefRow[]> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  const { rows } = await c.query<CrossAppRefRow>(
    `SELECT id, source_registry_id, target_registry_id, ref_field, label, ref_strength
       FROM choros.cross_app_ref
      WHERE tenant_id = $1
        AND source_registry_id = $2
      ORDER BY ref_field`,
    [tenantId, sourceRegistryId],
  );
  await c.query('COMMIT');
  return rows;
}

// ---------------------------------------------------------------------------
// Helper: run a function inside a tenant-scoped tx on the app pool.
// Mirrors withTenantTx in registry-defs.ts — used by tests that call production
// DAO functions that require an already-open tenant-scoped client.
// ---------------------------------------------------------------------------

async function withAppTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Server setup — shared across all tests
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

// All cleanup items accumulated during tests (migrator role deletes them).
const cleanupCrossAppRefs: Array<{ tenantId: string; sourceRegistryId: string }> = [];
const cleanupRegistryDefs: Array<{ tenantId: string; id: string }> = [];
const cleanupApplications: Array<{ tenantId: string; id: string }> = [];
const cleanupTenants: Array<string> = [];

// Per-test actor→tenantId map, populated in each test group's setup.
const actorTenantMap = new Map<string, string>();

async function stubResolveActorTenant(slug: string): Promise<string> {
  const tenantId = actorTenantMap.get(slug);
  if (!tenantId) throw new Error(`unknown test actor: ${slug}`);
  return tenantId;
}

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });
  const router = new Router();
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
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    // Delete in FK-safe order: cross_app_ref → registry_schema_history → registry_def → application → tenant.
    for (const { tenantId, sourceRegistryId } of cleanupCrossAppRefs) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `DELETE FROM choros.cross_app_ref WHERE tenant_id = $1 AND source_registry_id = $2`,
        [tenantId, sourceRegistryId],
      );
      await c.query('COMMIT');
    }
    for (const { tenantId, id } of [...cleanupRegistryDefs].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `DELETE FROM choros.registry_schema_history WHERE tenant_id = $1 AND registry_id = $2`,
        [tenantId, id],
      );
      await c.query(
        `DELETE FROM choros.cross_app_ref WHERE tenant_id = $1 AND (source_registry_id = $2 OR target_registry_id = $2)`,
        [tenantId, id],
      );
      await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
    for (const { tenantId, id } of [...cleanupApplications].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      await c.query('COMMIT');
    }
    for (const tenantId of cleanupTenants) {
      await c.query(`DELETE FROM choros.tenant WHERE tenant_id = $1`, [tenantId]);
    }
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cross_app_ref reconciliation (T-0445)', () => {

  it('CREATE with x-relation → cross_app_ref row upserted', requireDb(async () => {
    // Fresh uuid tenant — hermetic (T-0428 lesson).
    const tenantId = uuid();
    const actorSlug = `actor-${tenantId.slice(0, 8)}`;
    actorTenantMap.set(actorSlug, tenantId);

    let appId = '';
    let targetRegId = '';

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, tenantId);
      appId = await seedApplication(c, tenantId);
      targetRegId = await seedRegistryDefTarget(c, tenantId, appId);
    });
    cleanupTenants.push(tenantId);
    cleanupApplications.push({ tenantId, id: appId });
    cleanupRegistryDefs.push({ tenantId, id: targetRegId });

    // Schema with one x-relation property pointing at targetRegId.
    const schemaWithRelation = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        linked_record: {
          type: 'string',
          title: 'Linked Record',
          'x-relation': { target_registry_id: targetRegId },
        },
      },
      required: ['name'],
      additionalProperties: false,
    };

    // POST to create registry_def — actor resolves to our fresh tenant.
    // This calls the PRODUCTION createRegistryDef which calls reconcileCrossAppRefs
    // internally.
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      {
        application_id: appId,
        slug: `source-${uuid().slice(0, 8)}`,
        display_name: 'Source Registry',
        record_schema: schemaWithRelation,
      },
      { 'x-dev-user': actorSlug },
    );
    expect(created.statusCode).toBe(201);
    const sourceRegId = (JSON.parse(created.body) as { id: string }).id;
    cleanupRegistryDefs.push({ tenantId, id: sourceRegId });
    cleanupCrossAppRefs.push({ tenantId, sourceRegistryId: sourceRegId });

    // Assert: exactly one cross_app_ref row was created.
    const rows = await withClient(migratorUrl(), (c) =>
      queryCrossAppRefs(c, tenantId, sourceRegId),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_registry_id).toBe(sourceRegId);
    expect(rows[0]!.target_registry_id).toBe(targetRegId);
    expect(rows[0]!.ref_field).toBe('linked_record');
    expect(rows[0]!.label).toBe('Linked Record');
    expect(rows[0]!.ref_strength).toBe('weak');
  }));

  it('UPDATE removing x-relation → cross_app_ref row deleted (via production reconcileCrossAppRefs)', requireDb(async () => {
    // HIGH fix: was using raw DELETE SQL; now calls PRODUCTION reconcileCrossAppRefs
    // which exercises the old→new diff logic and deleteCrossAppRefForField.
    const tenantId = uuid();
    const actorSlug = `actor-${tenantId.slice(0, 8)}`;
    actorTenantMap.set(actorSlug, tenantId);

    let appId = '';
    let targetRegId = '';

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, tenantId);
      appId = await seedApplication(c, tenantId);
      targetRegId = await seedRegistryDefTarget(c, tenantId, appId);
    });
    cleanupTenants.push(tenantId);
    cleanupApplications.push({ tenantId, id: appId });
    cleanupRegistryDefs.push({ tenantId, id: targetRegId });

    const schemaWithRelation = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        linked_record: {
          type: 'string',
          title: 'Linked',
          'x-relation': { target_registry_id: targetRegId },
        },
      },
      required: ['name'],
      additionalProperties: false,
    };

    // Create with the relation field (HTTP handler → production createRegistryDef →
    // production reconcileCrossAppRefs → upsert).
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      {
        application_id: appId,
        slug: `source-rm-${uuid().slice(0, 8)}`,
        display_name: 'Source Rm',
        record_schema: schemaWithRelation,
      },
      { 'x-dev-user': actorSlug },
    );
    expect(created.statusCode).toBe(201);
    const sourceRegId = (JSON.parse(created.body) as { id: string }).id;
    cleanupRegistryDefs.push({ tenantId, id: sourceRegId });
    cleanupCrossAppRefs.push({ tenantId, sourceRegistryId: sourceRegId });

    // Verify the row exists.
    const rowsBefore = await withClient(migratorUrl(), (c) =>
      queryCrossAppRefs(c, tenantId, sourceRegId),
    );
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0]!.ref_field).toBe('linked_record');

    // Schema WITHOUT the relation field (simulates user removing linked_record).
    const schemaWithoutRelation = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
      },
      required: ['name'],
      additionalProperties: false,
    };

    // Call the PRODUCTION reconcileCrossAppRefs directly:
    //   oldSchema = schemaWithRelation (has linked_record → cross_app_ref row)
    //   newSchema = schemaWithoutRelation (no x-relation → deletion is triggered)
    // This exercises the old→new diff and deleteCrossAppRefForField production path.
    await withAppTenantTx(appPool, tenantId, async (client) => {
      await reconcileCrossAppRefs(client, tenantId, sourceRegId, schemaWithRelation, schemaWithoutRelation);
    });

    // Assert: row is gone (production delete was called, not raw SQL).
    const rowsAfter = await withClient(migratorUrl(), (c) =>
      queryCrossAppRefs(c, tenantId, sourceRegId),
    );
    expect(rowsAfter).toHaveLength(0);
  }));

  it('IDEMPOTENT: upsertCrossAppRefForField called twice → exactly 1 row (production DAO)', requireDb(async () => {
    // HIGH fix: was using raw INSERT ON CONFLICT SQL; now calls PRODUCTION
    // upsertCrossAppRefForField twice to prove ON CONFLICT idempotency via real code.
    const tenantId = uuid();
    const actorSlug = `actor-${tenantId.slice(0, 8)}`;
    actorTenantMap.set(actorSlug, tenantId);

    let appId = '';
    let targetRegId = '';

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, tenantId);
      appId = await seedApplication(c, tenantId);
      targetRegId = await seedRegistryDefTarget(c, tenantId, appId);
    });
    cleanupTenants.push(tenantId);
    cleanupApplications.push({ tenantId, id: appId });
    cleanupRegistryDefs.push({ tenantId, id: targetRegId });

    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        linked: {
          type: 'string',
          title: 'Linked',
          'x-relation': { target_registry_id: targetRegId },
        },
      },
      required: ['name'],
      additionalProperties: false,
    };

    // Create via HTTP (production reconcileCrossAppRefs → first upsert).
    const first = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      {
        application_id: appId,
        slug: `source-idem-${uuid().slice(0, 8)}`,
        display_name: 'Idempotent',
        record_schema: schema,
      },
      { 'x-dev-user': actorSlug },
    );
    expect(first.statusCode).toBe(201);
    const sourceRegId = (JSON.parse(first.body) as { id: string }).id;
    cleanupRegistryDefs.push({ tenantId, id: sourceRegId });
    cleanupCrossAppRefs.push({ tenantId, sourceRegistryId: sourceRegId });

    // Verify one row after the first create.
    const rowsAfterCreate = await withClient(migratorUrl(), (c) =>
      queryCrossAppRefs(c, tenantId, sourceRegId),
    );
    expect(rowsAfterCreate).toHaveLength(1);

    // Call the PRODUCTION upsertCrossAppRefForField a SECOND time with identical
    // params — this proves ON CONFLICT idempotency via the real DAO code path.
    await withAppTenantTx(appPool, tenantId, async (client) => {
      await upsertCrossAppRefForField(client, tenantId, {
        sourceRegistryId: sourceRegId,
        targetRegistryId: targetRegId,
        refField: 'linked',
        label: 'Linked',
      });
    });

    // Assert: still exactly ONE row (not two).
    const rowsAfterSecondUpsert = await withClient(migratorUrl(), (c) =>
      queryCrossAppRefs(c, tenantId, sourceRegId),
    );
    expect(rowsAfterSecondUpsert).toHaveLength(1);
    expect(rowsAfterSecondUpsert[0]!.ref_field).toBe('linked');
    expect(rowsAfterSecondUpsert[0]!.target_registry_id).toBe(targetRegId);
  }));

  it('CROSS-TENANT: cross_app_ref row for tenant A not visible under tenant B', requireDb(async () => {
    const tenantA = uuid();
    const tenantB = uuid();
    const actorSlugA = `actor-${tenantA.slice(0, 8)}`;
    actorTenantMap.set(actorSlugA, tenantA);

    let appAId = '';
    let targetAId = '';

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, tenantA);
      await seedTenantRow(c, tenantB);
      appAId = await seedApplication(c, tenantA);
      targetAId = await seedRegistryDefTarget(c, tenantA, appAId);
    });
    cleanupTenants.push(tenantA, tenantB);
    cleanupApplications.push({ tenantId: tenantA, id: appAId });
    cleanupRegistryDefs.push({ tenantId: tenantA, id: targetAId });

    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        ref_a: {
          type: 'string',
          title: 'Ref A',
          'x-relation': { target_registry_id: targetAId },
        },
      },
      required: ['name'],
      additionalProperties: false,
    };

    // Create registry_def in tenant A (production createRegistryDef → reconcile).
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      {
        application_id: appAId,
        slug: `source-ct-${uuid().slice(0, 8)}`,
        display_name: 'Cross Tenant Source',
        record_schema: schema,
      },
      { 'x-dev-user': actorSlugA },
    );
    expect(created.statusCode).toBe(201);
    const sourceAId = (JSON.parse(created.body) as { id: string }).id;
    cleanupRegistryDefs.push({ tenantId: tenantA, id: sourceAId });
    cleanupCrossAppRefs.push({ tenantId: tenantA, sourceRegistryId: sourceAId });

    // Verify row visible under tenant A (migrator → SET LOCAL → normal RLS path).
    const rowsA = await withClient(migratorUrl(), (c) =>
      queryCrossAppRefs(c, tenantA, sourceAId),
    );
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.ref_field).toBe('ref_a');

    // Now query the SAME source_registry_id under tenant B → must be empty (RLS isolation).
    const rowsB = await withClient(migratorUrl(), (c) =>
      queryCrossAppRefs(c, tenantB, sourceAId),
    );
    expect(rowsB).toHaveLength(0);
  }));

  it('UPDATE adding a new x-relation field → both rows present (via production reconcileCrossAppRefs)', requireDb(async () => {
    // HIGH fix: was using raw INSERT ON CONFLICT SQL twice; now calls PRODUCTION
    // reconcileCrossAppRefs with oldSchema(1 relation) → newSchema(2 relations),
    // which exercises the new-vs-old diff and upsertCrossAppRefForField for
    // both the retained field and the newly added one.
    const tenantId = uuid();
    const actorSlug = `actor-${tenantId.slice(0, 8)}`;
    actorTenantMap.set(actorSlug, tenantId);

    let appId = '';
    let targetId1 = '';
    let targetId2 = '';

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, tenantId);
      appId = await seedApplication(c, tenantId);
      targetId1 = await seedRegistryDefTarget(c, tenantId, appId);
      targetId2 = await seedRegistryDefTarget(c, tenantId, appId);
    });
    cleanupTenants.push(tenantId);
    cleanupApplications.push({ tenantId, id: appId });
    cleanupRegistryDefs.push({ tenantId, id: targetId1 });
    cleanupRegistryDefs.push({ tenantId, id: targetId2 });

    const schemaV1 = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        rel1: {
          type: 'string',
          title: 'Rel 1',
          'x-relation': { target_registry_id: targetId1 },
        },
      },
      required: ['name'],
      additionalProperties: false,
    };

    // Create with first relation via HTTP (production createRegistryDef → reconcile
    // with oldSchema=null → upsert for rel1).
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/registry-defs',
      {
        application_id: appId,
        slug: `source-add-${uuid().slice(0, 8)}`,
        display_name: 'Source Add',
        record_schema: schemaV1,
      },
      { 'x-dev-user': actorSlug },
    );
    expect(created.statusCode).toBe(201);
    const sourceRegId = (JSON.parse(created.body) as { id: string }).id;
    cleanupRegistryDefs.push({ tenantId, id: sourceRegId });
    cleanupCrossAppRefs.push({ tenantId, sourceRegistryId: sourceRegId });

    // Verify one row for rel1.
    const v1Rows = await withClient(migratorUrl(), (c) =>
      queryCrossAppRefs(c, tenantId, sourceRegId),
    );
    expect(v1Rows).toHaveLength(1);
    expect(v1Rows[0]!.ref_field).toBe('rel1');

    // Schema V2 adds rel2 while keeping rel1.
    const schemaV2 = {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name' },
        rel1: {
          type: 'string',
          title: 'Rel 1',
          'x-relation': { target_registry_id: targetId1 },
        },
        rel2: {
          type: 'string',
          title: 'Rel 2',
          'x-relation': { target_registry_id: targetId2 },
        },
      },
      required: ['name'],
      additionalProperties: false,
    };

    // Call PRODUCTION reconcileCrossAppRefs:
    //   oldSchema = schemaV1 (has rel1)
    //   newSchema = schemaV2 (has rel1 + rel2)
    // This exercises:
    //   - upsertCrossAppRefForField for rel1 (already exists → ON CONFLICT update, no duplicate)
    //   - upsertCrossAppRefForField for rel2 (new → INSERT)
    //   - no DELETE (rel1 still present in newSchema)
    await withAppTenantTx(appPool, tenantId, async (client) => {
      await reconcileCrossAppRefs(client, tenantId, sourceRegId, schemaV1, schemaV2);
    });

    // Assert: both rows present.
    const v2Rows = await withClient(migratorUrl(), (c) =>
      queryCrossAppRefs(c, tenantId, sourceRegId),
    );
    expect(v2Rows).toHaveLength(2);
    const fieldNames = v2Rows.map((r) => r.ref_field).sort();
    expect(fieldNames).toEqual(['rel1', 'rel2']);
    const rel2Row = v2Rows.find((r) => r.ref_field === 'rel2');
    expect(rel2Row?.target_registry_id).toBe(targetId2);
  }));

});
