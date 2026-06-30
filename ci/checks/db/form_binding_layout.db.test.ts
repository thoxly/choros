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
// Process/form keys are deterministic from TENANT so beforeAll (registry-binding
// seed, T-0520) and the describe block reference the SAME process key.
const PROC_KEY = `t0506-proc-${TENANT.slice(0, 8)}`;
const FORM_KEY = `t0506-form-${TENANT.slice(0, 8)}`;

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
// T-0520 [D7-5]: the POST /api/forms/binding layout path now runs the
// classifyFloorBoundary content gate (binding.ts §447-497). It resolves the
// LIVE record_schema via resolveLiveSchemaFieldKeys(): process_key →
// process_app_binding.application_id → registry_def(slug='soglasovanie').
// With NO such binding the resolver returns null → fail-closed 409 WRONG_FLOOR.
//
// A real FormDesigner save happens on a process that IS bound to an application
// + registry, so this test must seed that binding for the layout path to be a
// VALID Floor-1 save (the original T-0506 contract: snake_case layout → 201).
// The LAYOUT_DOC below has empty children, so R-4 (named-binding integrity)
// references zero field keys and passes against the (empty) live schema; the
// load-bearing requirement is merely that the live schema RESOLVES (not null).
// ---------------------------------------------------------------------------

async function seedRegistryBinding(
  c: pg.Client,
  tenantId: string,
  procKey: string,
): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  // application
  const appId = uuid();
  const appSlug = `t0506-app-${appId.slice(0, 8)}`;
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0) ON CONFLICT DO NOTHING`,
    [tenantId, appId, appSlug],
  );
  // process_app_binding: procKey → appId (resolveLiveSchemaFieldKeys step 1)
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, form_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, 0, 0) ON CONFLICT DO NOTHING`,
    [tenantId, uuid(), procKey, appId],
  );
  // registry_def: slug MUST be 'soglasovanie' (resolveLiveSchemaFieldKeys step 2).
  // record_schema with one property so the live key-set resolves to a real set.
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, 'soglasovanie', 'Согласование',
             '{"properties":{"amount":{"type":"number"}}}'::jsonb, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, uuid(), appId],
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
    // T-0520: bind the test process to an application + registry so the
    // FormDesigner layout path is a valid Floor-1 save (live schema resolves).
    await seedRegistryBinding(c, TENANT, PROC_KEY);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    await c.query(`DELETE FROM choros.form_binding WHERE tenant_id = $1`, [TENANT]);
    // T-0520 registry-binding seed cleanup (order: child refs before application).
    await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1`, [TENANT]);
    await c.query(`DELETE FROM choros.process_app_binding WHERE tenant_id = $1`, [TENANT]);
    await c.query(`DELETE FROM choros.application WHERE tenant_id = $1`, [TENANT]);
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

// T-0520 [D7-5]: the layout POST runs classifyFloorBoundary's content gate
// (binding.ts §447-497), passing the `layout` object DIRECTLY as the FormDocument.
// The classifier treats the top-level object as the root node — it reads
// `layout.type` / `layout.children`, it does NOT unwrap a nested `root` key
// (see floor-boundary-wire.test.ts: `layout: { type: 'root', children: [...] }`).
//
// A VALID Floor-1 document therefore has top-level `type: 'root'` (the only
// non-leaf type allowed at the root, form-document-format §3) with children
// drawn from FLOOR1_DOC_NODE_TYPES. The original fixture nested the tree under a
// `root` key whose type was 'column' — so `layout.type` was undefined and the
// node fell outside the whitelist → R-3 flagged a non-declarative node → 409
// Floor-2. A real FormDesigner save emits a top-level declarative root; this
// fixture now mirrors that. Empty children → R-4 references zero field keys → passes.
const LAYOUT_DOC = {
  schemaVersion: 1,
  source: 'FormDesigner',
  type: 'root',
  children: [],
};

describe('T-0506: POST /api/forms/binding — snake_case + layout', () => {
  const procKey = PROC_KEY;
  const formKey = FORM_KEY;
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
