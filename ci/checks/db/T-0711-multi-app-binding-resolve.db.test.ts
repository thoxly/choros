// T-0711 (P2, review T-0706 finding #37) · resolveLiveRecordSchema resolves the
// SELECTED application's binding — live Postgres proof.
//
// process_app_binding carries UNIQUE (tenant_id, process_key, application_id)
// (migration 075): ONE process CAN be bound to TWO applications. Before T-0711
// the resolver's step-1 SQL was `WHERE tenant_id=$1 AND process_key=$2 LIMIT 1`
// — no application_id filter, no ORDER BY — so with 2 bindings the server
// validated a form save against WHICHEVER binding row the planner returned,
// independent of the application the author actually picked (T-0669's picker
// legitimately offers both).
//
// This suite seeds ONE tenant with ONE process bound to TWO applications, each
// with a DIFFERENT registry_def schema, and proves against the REAL database:
//   AC-1  resolveLiveRecordSchema(..., appA) → schema A;  (..., appB) → schema B.
//   AC-2  no applicationId → deterministic: the OLDEST binding (created_at ASC,
//         id ASC) — proven by inserting the NEWER-created_at row FIRST
//         physically, so raw insertion order disagrees with the contract order.
//   AC-3  a valid-but-nonexistent applicationId → null (fail-closed, never a
//         silent substitute of the other binding).
//   AC-5  the HTTP seam: POST /api/forms/binding with application_id=B and a
//         layout referencing a B-only field → 201; the SAME layout with
//         application_id=A → 409 WRONG_FLOOR (the gate really pins the schema).
//
// Fixtures are NEUTRAL (t0711-*) — no case literals (anti-case-lock, D-064).
//
// Run (targeted — NOT the full fitness:db chain):
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npx vitest run --dir ci/checks/db --no-file-parallelism \
//     ci/checks/db/T-0711-multi-app-binding-resolve.db.test.ts \
//     --testTimeout=120000 --hookTimeout=120000

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerBindingRoutes } from '../../../src/http/binding.js';
import { resolveLiveRecordSchema } from '../../../src/db/live-form-schema.js';

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
// Isolated tenant + fixtures (neutral, deterministic from the tenant uuid)
// ---------------------------------------------------------------------------

const TENANT = uuid();
const OWNER = `t0711-owner-${TENANT.slice(0, 8)}`;
const PROC_KEY = `t0711-proc-${TENANT.slice(0, 8)}`;
const FORM_KEY = `t0711-form-${TENANT.slice(0, 8)}`;
const APP_A = uuid();
const APP_B = uuid();
// The resolver falls back to resolveDefaultStepResultSlug() when the binding's
// target_registry_slug is NULL — pin EXPLICIT (neutral) slugs on both bindings
// so this test never depends on the env default.
const SLUG_A = 'fields-alpha';
const SLUG_B = 'fields-beta';
// Distinct schemas: only B has `beta_only`; only A has `alpha_only`.
const SCHEMA_A = { properties: { alpha_only: { type: 'string' } } };
const SCHEMA_B = { properties: { beta_only: { type: 'string' } } };

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === OWNER) return TENANT;
  throw new Error(`unknown test actor: ${slug}`);
}

async function seed(c: pg.Client): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $3, 0) ON CONFLICT DO NOTHING`,
    [TENANT, `t-${TENANT.slice(0, 8)}`, `Tenant ${TENANT.slice(0, 8)}`],
  );
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0)`,
    [TENANT, uuid(), OWNER, `Owner ${OWNER}`],
  );
  // Two applications.
  for (const [appId, suffix] of [[APP_A, 'a'], [APP_B, 'b']] as const) {
    await c.query(
      `INSERT INTO choros.application
         (tenant_id, id, slug, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $3, 0, 0) ON CONFLICT DO NOTHING`,
      [TENANT, appId, `t0711-app-${suffix}-${appId.slice(0, 8)}`],
    );
  }
  // Registry defs with DIFFERENT schemas under each app.
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5::jsonb, 0, 0) ON CONFLICT DO NOTHING`,
    [TENANT, uuid(), APP_A, SLUG_A, JSON.stringify(SCHEMA_A)],
  );
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5::jsonb, 0, 0) ON CONFLICT DO NOTHING`,
    [TENANT, uuid(), APP_B, SLUG_B, JSON.stringify(SCHEMA_B)],
  );
  // TWO bindings for the SAME process_key (the natural key allows this).
  //
  // AC-2 setup: binding A is the CONTRACT-oldest (created_at=100) but is
  // inserted SECOND physically; binding B (created_at=200, newer) goes in
  // FIRST. If the resolver's fallback followed physical/planner order instead
  // of the ORDER BY contract, it would surface B — the assertion below pins A.
  const BINDING_B = uuid();
  const BINDING_A = uuid();
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, form_key, target_registry_slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, 200, 200)`,
    [TENANT, BINDING_B, PROC_KEY, APP_B, SLUG_B],
  );
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, form_key, target_registry_slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, 100, 100)`,
    [TENANT, BINDING_A, PROC_KEY, APP_A, SLUG_A],
  );
  await c.query('COMMIT');
}

async function cleanup(c: pg.Client): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
  await c.query(`DELETE FROM choros.form_binding WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros.process_app_binding WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros.application WHERE tenant_id = $1`, [TENANT]);
  await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [TENANT]);
  await c.query('COMMIT');
  await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [TENANT]);
}

/** Run fn on an RLS-scoped app-role client (the exact runtime posture). */
async function withTenantClient<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    await client.query('SET LOCAL search_path TO choros');
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
// HTTP helper (mirrors form_binding_layout.db.test.ts)
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
// Lifecycle
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

  await withClient(migratorUrl(), async (c) => seed(c));
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => cleanup(c));
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T-0711: resolveLiveRecordSchema with 2 bindings on one process (live PG)', () => {
  it('AC-1: pinned to app A → schema A; pinned to app B → schema B', requireDb(async () => {
    const schemaA = await withTenantClient(appPool, (c) =>
      resolveLiveRecordSchema(c, TENANT, PROC_KEY, APP_A));
    const schemaB = await withTenantClient(appPool, (c) =>
      resolveLiveRecordSchema(c, TENANT, PROC_KEY, APP_B));
    expect(schemaA).toEqual(SCHEMA_A);
    expect(schemaB).toEqual(SCHEMA_B);
  }));

  it('AC-2: no applicationId → deterministic OLDEST binding (created_at), not insertion/planner order', requireDb(async () => {
    // Binding B was inserted FIRST physically but carries created_at=200;
    // binding A was inserted second with created_at=100. The contract picks A.
    // Repeat 5× — a planner-order pick could flap; the contract must not.
    for (let i = 0; i < 5; i++) {
      const schema = await withTenantClient(appPool, (c) =>
        resolveLiveRecordSchema(c, TENANT, PROC_KEY));
      expect(schema, `iteration ${i}`).toEqual(SCHEMA_A);
    }
  }));

  it('AC-3: valid-but-nonexistent applicationId → null (fail-closed, no silent substitute)', requireDb(async () => {
    const ghost = uuid();
    const schema = await withTenantClient(appPool, (c) =>
      resolveLiveRecordSchema(c, TENANT, PROC_KEY, ghost));
    expect(schema).toBeNull();
  }));
});

describe('T-0711: POST /api/forms/binding honors application_id (live PG, HTTP seam)', () => {
  // A layout referencing ONLY the B-schema field.
  const LAYOUT_B_ONLY = {
    schemaVersion: 1,
    source: 'FormDesigner',
    type: 'root',
    children: [{ type: 'field', fieldKey: 'beta_only' }],
  };

  it('AC-5a: application_id=B + a B-only field → 201 (gate resolves the SELECTED binding)', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/binding', {
      process_key: PROC_KEY,
      form_key: FORM_KEY,
      application_id: APP_B,
      layout: LAYOUT_B_ONLY,
    });
    expect(res.statusCode, `expected 201, got: ${JSON.stringify(res.json)}`).toBe(201);
  }));

  it('AC-5b: SAME layout with application_id=A → 409 WRONG_FLOOR (beta_only is dangling in schema A)', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/binding', {
      process_key: PROC_KEY,
      form_key: `${FORM_KEY}-x`,
      application_id: APP_A,
      layout: LAYOUT_B_ONLY,
    });
    expect(res.statusCode, `expected 409, got: ${JSON.stringify(res.json)}`).toBe(409);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe('WRONG_FLOOR');
  }));

  it('AC-5c: malformed application_id → 400 VALIDATION (honest, before any resolution)', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/binding', {
      process_key: PROC_KEY,
      form_key: `${FORM_KEY}-y`,
      application_id: 'not-a-uuid',
      layout: LAYOUT_B_ONLY,
    });
    expect(res.statusCode).toBe(400);
  }));

  it('AC-2-http: no application_id → gate uses the deterministic OLDEST binding (schema A) → 409 for a B-only layout', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/binding', {
      process_key: PROC_KEY,
      form_key: `${FORM_KEY}-z`,
      layout: LAYOUT_B_ONLY,
    });
    // The deterministic fallback resolves binding A (created_at=100) whose
    // schema has no beta_only → dangling → 409. Before T-0711 this outcome
    // depended on whichever row the planner returned.
    expect(res.statusCode, `expected 409, got: ${JSON.stringify(res.json)}`).toBe(409);
  }));
});
