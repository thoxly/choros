// T-0725 (N-1, review T-0711 §6) · POST /api/forms/document-ops — ambiguity
// pre-flight for the agent seam — live Postgres proof.
//
// T-0711 threaded an optional `applicationId` pin through classifyLayoutSave
// (binding.ts) and both HTTP routes (binding.ts, forms-document-ops.ts). The
// human path (FormDesigner) ALWAYS sends it (the "Приложение" picker drives
// the save call — T-0711 review §1(a)); an agent driver calling document-ops
// directly has no picker and MAY omit it. Before this task, omitting it on a
// process bound to 2+ applications silently resolved the T-0711 deterministic
// fallback (oldest binding) — the agent could save/validate against a schema
// it never chose, with no signal.
//
// This suite seeds ONE tenant with:
//   - a MULTI process bound to TWO applications (A, B), each with a DIFFERENT
//     live schema, and an existing form_binding.layout to patch;
//   - a SINGLE process bound to ONE application only, with its own layout.
// … and proves against the REAL database:
//   AC-c  MULTI process, no applicationId → 422 AMBIGUOUS_APPLICATION; the
//         underlying form_binding row is NOT modified (no silent guess-save).
//   AC-a  MULTI process, applicationId=B + a B-only field → 200 (resolves
//         against the PINNED binding, reusing T-0711's classifyLayoutSave).
//   AC-b  MULTI process, applicationId=A + the SAME B-only field → 409
//         WRONG_FLOOR (the pin genuinely changes which schema validates).
//   AC-d  SINGLE process, no applicationId → 200 (T-0711 fallback unaffected
//         — single-binding processes are NOT broken by this task).
//
// Fixtures are NEUTRAL (t0725-*) — no case literals (anti-case-lock, D-064).
//
// Run (targeted — NOT the full fitness:db chain):
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npx vitest run --dir ci/checks/db --no-file-parallelism \
//     ci/checks/db/T-0725-document-ops-application-id-gate.db.test.ts \
//     --testTimeout=120000 --hookTimeout=120000

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerFormDocumentOpsRoute } from '../../../src/http/forms-document-ops.js';

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
const OWNER = `t0725-owner-${TENANT.slice(0, 8)}`;
const PROC_MULTI = `t0725-multi-proc-${TENANT.slice(0, 8)}`;
const FORM_MULTI = `t0725-multi-form-${TENANT.slice(0, 8)}`;
const FORM_MULTI_2 = `t0725-multi-form2-${TENANT.slice(0, 8)}`;
const PROC_SINGLE = `t0725-single-proc-${TENANT.slice(0, 8)}`;
const FORM_SINGLE = `t0725-single-form-${TENANT.slice(0, 8)}`;
const APP_A = uuid();
const APP_B = uuid();
const APP_SOLO = uuid();
const SLUG_A = 't0725-fields-alpha';
const SLUG_B = 't0725-fields-beta';
const SLUG_SOLO = 't0725-fields-solo';
const SCHEMA_A = { properties: { alpha_only: { type: 'string' } } };
const SCHEMA_B = { properties: { beta_only: { type: 'string' } } };
const SCHEMA_SOLO = { properties: { solo_field: { type: 'string' } } };

// Empty-children layout — Floor-1 safe against ANY live schema (R-4
// references zero field keys), so seeding never depends on which binding the
// gate ultimately resolves.
const NEUTRAL_LAYOUT = {
  schemaVersion: 1,
  source: 't0725-fixture',
  root: { type: 'section', children: [] },
};

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
  // Three applications: A, B (both bound to PROC_MULTI) and SOLO (bound to
  // PROC_SINGLE alone).
  for (const [appId, suffix] of [[APP_A, 'a'], [APP_B, 'b'], [APP_SOLO, 'solo']] as const) {
    await c.query(
      `INSERT INTO choros.application
         (tenant_id, id, slug, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $3, 0, 0) ON CONFLICT DO NOTHING`,
      [TENANT, appId, `t0725-app-${suffix}-${appId.slice(0, 8)}`],
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
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5::jsonb, 0, 0) ON CONFLICT DO NOTHING`,
    [TENANT, uuid(), APP_SOLO, SLUG_SOLO, JSON.stringify(SCHEMA_SOLO)],
  );
  // PROC_MULTI: TWO bindings (A, B).
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, form_key, target_registry_slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, 100, 100)`,
    [TENANT, uuid(), PROC_MULTI, APP_A, SLUG_A],
  );
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, form_key, target_registry_slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, 200, 200)`,
    [TENANT, uuid(), PROC_MULTI, APP_B, SLUG_B],
  );
  // PROC_SINGLE: ONE binding (SOLO) only.
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, form_key, target_registry_slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, 100, 100)`,
    [TENANT, uuid(), PROC_SINGLE, APP_SOLO, SLUG_SOLO],
  );
  // Existing form_binding.layout rows to PATCH (document-ops 404s otherwise).
  await c.query(
    `INSERT INTO choros.form_binding
       (tenant_id, id, process_key, form_key, fields, layout, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, $5::jsonb, 1, 0, 0)`,
    [TENANT, uuid(), PROC_MULTI, FORM_MULTI, JSON.stringify(NEUTRAL_LAYOUT)],
  );
  await c.query(
    `INSERT INTO choros.form_binding
       (tenant_id, id, process_key, form_key, fields, layout, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, $5::jsonb, 1, 0, 0)`,
    [TENANT, uuid(), PROC_MULTI, FORM_MULTI_2, JSON.stringify(NEUTRAL_LAYOUT)],
  );
  await c.query(
    `INSERT INTO choros.form_binding
       (tenant_id, id, process_key, form_key, fields, layout, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, $5::jsonb, 1, 0, 0)`,
    [TENANT, uuid(), PROC_SINGLE, FORM_SINGLE, JSON.stringify(NEUTRAL_LAYOUT)],
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

// ---------------------------------------------------------------------------
// HTTP helper (mirrors T-0711-multi-app-binding-resolve.db.test.ts)
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
  registerFormDocumentOpsRoute(router, appPool, {
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

describe('T-0725: POST /api/forms/document-ops — applicationId ambiguity gate (live PG)', () => {
  it('AC-c: MULTI process, no applicationId → 422 AMBIGUOUS_APPLICATION, naming both candidates', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/document-ops', {
      processKey: PROC_MULTI,
      stepKey: FORM_MULTI,
      op: { kind: 'insert', containerPath: [], node: { type: 'divider' } },
    });
    expect(res.statusCode, `expected 422, got: ${JSON.stringify(res.json)}`).toBe(422);
    const env = res.json as { error?: { code?: string; message?: string } };
    expect(env.error?.code).toBe('AMBIGUOUS_APPLICATION');
    expect(env.error?.message).toContain(APP_A);
    expect(env.error?.message).toContain(APP_B);
  }));

  it('AC-c: the form_binding row was NOT modified by the rejected save (no silent guess-write)', requireDb(async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const { rows } = await c.query<{ version: number; layout: unknown }>(
        `SELECT version, layout FROM choros.form_binding
          WHERE tenant_id = $1 AND process_key = $2 AND form_key = $3`,
        [TENANT, PROC_MULTI, FORM_MULTI],
      );
      await c.query('COMMIT');
      expect(rows.length).toBe(1);
      expect(rows[0]!.version).toBe(1);
      expect(rows[0]!.layout).toEqual(NEUTRAL_LAYOUT);
    });
  }));

  it('AC-a: MULTI process, applicationId=B + a B-only field → 200 (resolves against the PINNED binding)', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/document-ops', {
      processKey: PROC_MULTI,
      stepKey: FORM_MULTI,
      applicationId: APP_B,
      op: { kind: 'insert', containerPath: [], node: { type: 'field', fieldKey: 'beta_only', widget: 'text' } },
    });
    expect(res.statusCode, `expected 200, got: ${JSON.stringify(res.json)}`).toBe(200);
  }));

  it('AC-b: MULTI process, applicationId=A + the SAME B-only field → 409 WRONG_FLOOR (pin genuinely changes the schema)', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/document-ops', {
      processKey: PROC_MULTI,
      stepKey: FORM_MULTI_2,
      applicationId: APP_A,
      op: { kind: 'insert', containerPath: [], node: { type: 'field', fieldKey: 'beta_only', widget: 'text' } },
    });
    expect(res.statusCode, `expected 409, got: ${JSON.stringify(res.json)}`).toBe(409);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe('WRONG_FLOOR');
  }));

  it('AC-d: SINGLE process, no applicationId → 200 (T-0711 fallback unaffected)', requireDb(async () => {
    const res = await request(baseUrl, 'POST', '/api/forms/document-ops', {
      processKey: PROC_SINGLE,
      stepKey: FORM_SINGLE,
      op: { kind: 'insert', containerPath: [], node: { type: 'divider' } },
    });
    expect(res.statusCode, `expected 200, got: ${JSON.stringify(res.json)}`).toBe(200);
  }));
});
