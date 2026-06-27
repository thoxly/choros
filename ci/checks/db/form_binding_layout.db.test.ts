// T-0506 · POST /api/forms/binding — snake_case keys + layout persistence.
//
// Regression guard: FormDesigner sends { process_key, form_key, layout } (snake_case);
// the old handler only read camelCase → 400. This test proves:
//  (A) snake_case { process_key, form_key, layout } → 201, layout column persisted.
//  (B) camelCase  { processKey, stepKey, fields }   → 200 on second upsert (FormBuilder
//      path not regressed).
//
// Run:
//   DATABASE_URL=postgres://choros_migrator:choros_migrator_dev_pw@localhost:5432/choros \
//   npx vitest run --dir ci/checks/db --no-file-parallelism \
//     ci/checks/db/form_binding_layout.db.test.ts \
//     --testTimeout=120000 --hookTimeout=120000

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerBindingRoutes } from '../../../src/http/binding.js';

// ---------------------------------------------------------------------------
// Skip helpers when DATABASE_URL not set
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Isolated tenant + actor for this test run
// ---------------------------------------------------------------------------

const TENANT = uuid();
const OWNER = `t0506-owner-${TENANT.slice(0, 8)}`;

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === OWNER) return TENANT;
  throw new Error(`unknown test actor: ${slug}`);
}

async function seedMinimalTenant(c: pg.Client, tenantId: string, ownerSlug: string): Promise<void> {
  // tenant row (tenant table has tenant_id as leading PK per known_tenant_tables)
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $3, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`, `Tenant ${tenantId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0)`,
    [tenantId, empId, ownerSlug, `Owner ${ownerSlug}`],
  );
  await c.query('COMMIT');
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerBindingRoutes(router, appPool, {
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
    await seedMinimalTenant(c, TENANT, OWNER);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    await c.query(`DELETE FROM choros.form_binding WHERE tenant_id = $1`, [TENANT]);
    await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [TENANT]);
    await c.query('COMMIT');
    await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [TENANT]);
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const LAYOUT_DOC = {
  schemaVersion: 1,
  source: 'FormDesigner',
  root: { type: 'column', children: [] },
};

describe('T-0506: POST /api/forms/binding — snake_case + layout', () => {
  const procKey = `t0506-proc-${TENANT.slice(0, 8)}`;
  const formKey = `t0506-form-${TENANT.slice(0, 8)}`;
  let createdId: string;

  it('(A) snake_case { process_key, form_key, layout } → 201 (was 400)', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/binding', {
      process_key: procKey,
      form_key: formKey,
      layout: LAYOUT_DOC,
    });
    expect(res.statusCode, `expected 201, got: ${JSON.stringify(res.json)}`).toBe(201);
    createdId = (res.json as { id: string }).id;
    expect(typeof createdId).toBe('string');
    expect(createdId.length).toBeGreaterThan(0);
  }));

  it('(A) layout column persisted in DB equals the sent layout', requireDb(async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const { rows } = await c.query<{ layout: unknown }>(
        `SELECT layout FROM choros.form_binding
          WHERE tenant_id = $1 AND process_key = $2 AND form_key = $3`,
        [TENANT, procKey, formKey],
      );
      await c.query('COMMIT');
      expect(rows.length, 'row must be present').toBe(1);
      expect(rows[0]!.layout).toEqual(LAYOUT_DOC);
    });
  }));

  it('(B) camelCase { processKey, stepKey, fields } → 200 on upsert (FormBuilder not regressed)', requireDb(async () => {
    // Second call on same (process_key, form_key) → UPDATE → 200
    const res = await request(baseUrl, 'POST', '/api/forms/binding', {
      processKey: procKey,
      stepKey: formKey,
      fields: [{ key: 'amount', type: 'number', required: true }],
    });
    expect(res.statusCode, `expected 200, got: ${JSON.stringify(res.json)}`).toBe(200);
    expect((res.json as { version: number }).version).toBe(2);
  }));

  it('(B) fields updated correctly after camelCase upsert', requireDb(async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const { rows } = await c.query<{ fields: Array<{ key: string }> }>(
        `SELECT fields FROM choros.form_binding
          WHERE tenant_id = $1 AND process_key = $2 AND form_key = $3`,
        [TENANT, procKey, formKey],
      );
      await c.query('COMMIT');
      expect(rows.length).toBe(1);
      const keys = rows[0]!.fields.map((f) => f.key);
      expect(keys).toContain('amount');
    });
  }));

  it('(B) layout preserved after FormBuilder upsert (no layout sent) — regression guard', requireDb(async () => {
    // The FormBuilder POST (test B above) sent NO layout. The FormDesigner layout saved in
    // test A must still be present — COALESCE($2::jsonb, form_binding.layout) ensures this.
    // If the UPDATE were layout = $2::jsonb unconditionally, layout would be NULL here.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const { rows } = await c.query<{ layout: unknown }>(
        `SELECT layout FROM choros.form_binding
          WHERE tenant_id = $1 AND process_key = $2 AND form_key = $3`,
        [TENANT, procKey, formKey],
      );
      await c.query('COMMIT');
      expect(rows.length, 'row must still be present').toBe(1);
      expect(
        rows[0]!.layout,
        'FormDesigner layout must be preserved after FormBuilder upsert (no layout sent)',
      ).toEqual(LAYOUT_DOC);
    });
  }));

  it('400 when neither fields nor layout provided', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/binding', {
      processKey: procKey,
      stepKey: formKey,
      // no fields, no layout
    });
    expect(res.statusCode).toBe(400);
  }));

  it('400 when processKey is missing', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/binding', {
      form_key: formKey,
      layout: LAYOUT_DOC,
    });
    expect(res.statusCode).toBe(400);
  }));

  it('400 when layout is an array (not an object)', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/binding', {
      process_key: procKey,
      form_key: formKey,
      layout: [1, 2, 3],
    });
    expect(res.statusCode).toBe(400);
  }));
});
