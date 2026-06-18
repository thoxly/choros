// T-0264 · FF-10 / AC-10 — records PUT/POST field-mask write-guard live probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// THE CONTRACT (ADR T-0246 §2.3 / AC-10 / field-mask-guard.ts "Integration with
// B-11" / ci/checks/field-mask-hookpoint.sh FF-10):
//   PUT /api/records/:id (and POST, applied consistently) MUST call
//   checkWriteMask(grantWriteFacet, requestedFields) BEFORE any record-data field
//   is written, where requestedFields = the keys of the incoming `data`. A caller
//   whose write facet does NOT confer a system-only field (circuit_id,
//   activation_key_issued_at) is DENIED → HTTP 403 (FIELD_WRITE_FORBIDDEN) +
//   card_action.denied audit event (committed in-tx); the row is NOT written. A
//   caller whose facet permits the requested fields SUCCEEDS.
//
// This is a NEW db test file (records_crud.test.ts is frozen by FF-T147-2). It
// stands up its own server wired with registerRecordRoutes' OPTIONAL
// resolveWriteFacet dep:
//   - 'vendor-admin' → restricted facet ['name'] (system fields blocked)
//   - 'system-actor' → undefined (whole-resource: never denied)
//
// FRESH random tenant (uuid() in beforeAll) — the suite shares one DB clone, so
// the shared TENANT_A/TENANT_B constants are never reused here (audit_head
// pollution discipline; mirrors records_crud.test.ts).
//
// The pool uses the choros_app (NOBYPASSRLS) role via appUrl() so RLS is the
// production path. T-0144 discipline: BEGIN before SET LOCAL; COMMIT always.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';

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

// A schema that PERMITS the system-only fields as data properties — so the denial
// is exercised at the FIELD-MASK layer, not the AJV schema layer (which would 400
// on additionalProperties:false before the mask ever runs).
const MASK_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    circuit_id: { type: 'string', title: 'Circuit Id' },
    activation_key_issued_at: { type: 'string', title: 'Issued At' },
  },
  required: ['name'],
  additionalProperties: false,
};

// vendor-admin write facet: may write `name`, but NOT the system-only fields.
const VENDOR_ADMIN_FACET = ['name'];

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

async function seedApplicationDirect(c: pg.Client, tenantId: string, slug: string): Promise<string> {
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
// Suite
// ---------------------------------------------------------------------------

describe('records API — field-mask write guard (FF-10 / AC-10)', () => {
  let MASK_TENANT: string;
  let maskServer: http.Server;
  let maskBaseUrl = '';
  let maskPool: pg.Pool;
  let maskAppId = '';
  let maskRegId = '';
  const maskRecordCleanup: Array<{ tenantId: string; id: string }> = [];

  // Per-test actor → facet wiring (flipped per test where needed).
  let currentFacet: string[] | undefined = VENDOR_ADMIN_FACET;

  async function maskResolveActorTenant(slug: string): Promise<string> {
    if (slug === 'vendor-admin' || slug === 'system-actor') return MASK_TENANT;
    throw new Error(`unknown mask test actor: ${slug}`);
  }

  beforeAll(async () => {
    if (!hasDb) return;
    MASK_TENANT = uuid();
    maskPool = new pg.Pool({ connectionString: appUrl() });

    const router = new Router();
    registerRecordRoutes(router, {
      pool: maskPool,
      resolveActorTenant: maskResolveActorTenant,
      // vendor-admin → restricted facet (blocks system fields);
      // system-actor → undefined (whole-resource, never denied).
      resolveWriteFacet: async (actorSlug: string) =>
        actorSlug === 'system-actor' ? undefined : currentFacet,
    });
    maskServer = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => {
      maskServer.listen(0, 'localhost', () => {
        const addr = maskServer.address();
        if (addr && typeof addr !== 'string') maskBaseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, MASK_TENANT);
      maskAppId = await seedApplicationDirect(c, MASK_TENANT, `mask-app-${uuid().slice(0, 8)}`);
      maskRegId = await seedRegistryDefDirect(
        c,
        MASK_TENANT,
        maskAppId,
        `mask-reg-${uuid().slice(0, 8)}`,
        MASK_SCHEMA,
      );
    });
  });

  afterAll(async () => {
    if (!hasDb) return;
    await withClient(migratorUrl(), async (c) => {
      for (const { tenantId, id } of [...maskRecordCleanup].reverse()) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.record WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
        await c.query('COMMIT');
      }
      if (maskRegId) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${MASK_TENANT}'`);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`, [MASK_TENANT, maskRegId]);
        await c.query('COMMIT');
      }
      if (maskAppId) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${MASK_TENANT}'`);
        await c.query(`DELETE FROM choros.application WHERE tenant_id = $1 AND id = $2`, [MASK_TENANT, maskAppId]);
        await c.query('COMMIT');
      }
    });
    if (maskPool) await maskPool.end();
    if (maskServer) await new Promise<void>((resolve) => maskServer.close(() => resolve()));
  });

  // Read audit_event types for a record (migrator role bypasses RLS).
  async function maskAuditTypes(recordId: string): Promise<string[]> {
    return withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${MASK_TENANT}'`);
      const { rows } = await c.query<{ type: string }>(
        `SELECT type FROM choros.audit_event
          WHERE tenant_id = $1 AND subject = $2
          ORDER BY seq ASC`,
        [MASK_TENANT, recordId],
      );
      await c.query('COMMIT');
      return rows.map((r) => r.type);
    });
  }

  // Seed a record (no field-mask restriction at seed time) for PUT tests.
  async function seedMaskRecord(data: object): Promise<string> {
    let recId = '';
    await withClient(migratorUrl(), async (c) => {
      recId = await seedRecordDirect(c, MASK_TENANT, maskRegId, data);
    });
    maskRecordCleanup.push({ tenantId: MASK_TENANT, id: recId });
    return recId;
  }

  it('PUT: a writer LACKING field permission is DENIED (403) when writing circuit_id', requireDb(async () => {
    currentFacet = VENDOR_ADMIN_FACET; // restricted: name only
    const recId = await seedMaskRecord({ name: 'before' });

    const r = await makeRequest(
      maskBaseUrl,
      'PUT',
      `/api/records/${recId}`,
      { data: { name: 'after', circuit_id: 'CIRCUIT-INJECTED' } },
      { 'x-dev-user': 'vendor-admin' },
    );
    expect(r.statusCode).toBe(403);

    // Row UNCHANGED — the field write never happened.
    const got = await makeRequest(maskBaseUrl, 'GET', `/api/records/${recId}`, undefined, {
      'x-dev-user': 'vendor-admin',
    });
    expect((JSON.parse(got.body) as { data: unknown }).data).toEqual({ name: 'before' });

    // The denial is on the audit hash-chain (card_action.denied), committed in-tx.
    const types = await maskAuditTypes(recId);
    expect(types).toContain('card_action.denied');
    expect(types).not.toContain('record.update');
  }));

  it('PUT: a PERMITTED writer SUCCEEDS (200) when writing only facet-allowed fields', requireDb(async () => {
    currentFacet = VENDOR_ADMIN_FACET;
    const recId = await seedMaskRecord({ name: 'before' });

    const r = await makeRequest(
      maskBaseUrl,
      'PUT',
      `/api/records/${recId}`,
      { data: { name: 'after-permitted' } },
      { 'x-dev-user': 'vendor-admin' },
    );
    expect(r.statusCode).toBe(200);
    expect((JSON.parse(r.body) as { data: unknown }).data).toEqual({ name: 'after-permitted' });

    const types = await maskAuditTypes(recId);
    expect(types).toContain('record.update');
    expect(types).not.toContain('card_action.denied');
  }));

  it('PUT: the SYSTEM actor (whole-resource facet=undefined) MAY write system-only fields (200)', requireDb(async () => {
    const recId = await seedMaskRecord({ name: 'before' });

    const r = await makeRequest(
      maskBaseUrl,
      'PUT',
      `/api/records/${recId}`,
      { data: { name: 'issued', circuit_id: 'CIRC-OK', activation_key_issued_at: '2026-06-18' } },
      { 'x-dev-user': 'system-actor' }, // resolver returns undefined → never denied
    );
    expect(r.statusCode).toBe(200);
    expect((JSON.parse(r.body) as { data: Record<string, unknown> }).data['circuit_id']).toBe('CIRC-OK');

    const types = await maskAuditTypes(recId);
    expect(types).toContain('record.update');
    expect(types).not.toContain('card_action.denied');
  }));

  it('POST: a writer lacking field permission is DENIED (403) when creating with circuit_id', requireDb(async () => {
    currentFacet = VENDOR_ADMIN_FACET;
    const r = await makeRequest(
      maskBaseUrl,
      'POST',
      '/api/records',
      { application_id: maskAppId, registry_def_id: maskRegId, data: { name: 'n', circuit_id: 'INJECT' } },
      { 'x-dev-user': 'vendor-admin' },
    );
    expect(r.statusCode).toBe(403);
  }));

  it('POST: a permitted writer SUCCEEDS (201) creating with only facet-allowed fields', requireDb(async () => {
    currentFacet = VENDOR_ADMIN_FACET;
    const r = await makeRequest(
      maskBaseUrl,
      'POST',
      '/api/records',
      { application_id: maskAppId, registry_def_id: maskRegId, data: { name: 'created-ok' } },
      { 'x-dev-user': 'vendor-admin' },
    );
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body) as { id: string; data: unknown };
    expect(body.data).toEqual({ name: 'created-ok' });
    maskRecordCleanup.push({ tenantId: MASK_TENANT, id: body.id });
  }));
});
