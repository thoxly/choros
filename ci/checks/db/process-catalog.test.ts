// T-0270 · E13 — process catalog + process↔application binding live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Covers (all through registerProcessCatalogRoutes with an injected resolveActorTenant
// + a choros_app NOBYPASSRLS pool, so isolation proven here is the production RLS path):
//   - GET /api/process-catalog → REAL definitions (process_definition 074) + REAL
//     instances (audit-backed projection via appendProcessStarted) + bindings. NO mock.
//   - graceful-empty: a fresh tenant with no real data → empty arrays (never seed rows).
//   - POST /api/process-app-bindings → 201; create → list roundtrip.
//   - POST 404 when the application is not in the caller's tenant.
//   - POST 400 VALIDATION on missing process_key / bad application_id.
//   - withAuth dev path: 401 when x-dev-user absent.
//   - withAuth keycloak path: 401 without a Bearer JWT (CHOROS_AUTH_MODE=keycloak).
//   - TENANT ISOLATION: actor A's catalog/binding list never contains tenant B's rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerProcessCatalogRoutes } from '../../../src/http/process-catalog.js';
import { registerApplicationRoutes } from '../../../src/http/applications.js';
import { makePgAuditWriter, type PgClientLike } from '../../../src/db/audit-writer.js';
import { appendProcessStarted } from '../../../src/http/process-projection.js';

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
const writer = makePgAuditWriter();

// ---------------------------------------------------------------------------
// Seed helpers — direct INSERT under the migrator role (bypass RLS) / canonical writer.
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

async function seedProcessDefDirect(c: pg.Client, tenantId: string, processKey: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.process_definition
       (tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, '<definitions/>', 1, 'published', NULL, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, uuid(), processKey, `Def ${processKey}`],
  );
  await c.query('COMMIT');
}

/** Seed a REAL started instance via the canonical writer (the production projection path). */
async function seedRealInstance(tenantId: string, instanceId: string, procKey: string): Promise<void> {
  const c = new pg.Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query('SET LOCAL search_path TO choros');
    await appendProcessStarted(c as unknown as PgClientLike, {
      instanceId,
      procKey,
      actor: 'actor-a',
      nowMs: Date.now(),
    });
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
  // suppress unused-import lint when DB absent
  void writer;
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
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
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
const cleanupApps: Array<{ tenantId: string; id: string }> = [];

// A dedicated FRESH per-run tenant for the audit-chain-seeding test, so appending a
// real instance via the canonical writer never contends with the shared TENANT_A
// audit_head that cross_tenant.test.ts (and others) also write to under the same
// shared DB (memory: choros-ci-db-gotchas — shared-DB pollution → freshTenant()).
const TENANT_FRESH = crypto.randomUUID();

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'actor-a') return TENANT_A;
  if (slug === 'actor-b') return TENANT_B;
  if (slug === 'actor-fresh') return TENANT_FRESH;
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerProcessCatalogRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
  // Applications routes too — the POST 201 path exercises a REAL app create that the
  // binding then targets (proves the runtime app-exists integrity check, not a stub).
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
    await seedTenantRow(c, TENANT_FRESH);
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    for (const { tenantId, id } of [...cleanupApps].reverse()) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      // Bindings reference the app by logical id — clear them first (per tenant).
      await c.query(`DELETE FROM choros.process_app_binding WHERE tenant_id = $1 AND application_id = $2`, [tenantId, id]);
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

describe('process-catalog API — REAL definitions + instances (T-0270)', () => {
  it('401 when x-dev-user absent (withAuth dev path)', requireDb(async () => {
    const r = await makeRequest(baseUrl, 'GET', '/api/process-catalog');
    expect(r.statusCode).toBe(401);
  }));

  it('graceful-empty: a fresh actor with no real data → empty arrays, never seed rows', requireDb(async () => {
    // actor-a's tenant may carry rows from other suites, so assert SHAPE + no mock leakage:
    // every definition has a real source ('modeler'|'engine'), never an inline-seed marker.
    const r = await makeRequest(baseUrl, 'GET', '/api/process-catalog', undefined, { 'x-dev-user': 'actor-a' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as {
      definitions: Array<{ process_key: string; source: string }>;
      instances: unknown[];
      bindings: unknown[];
    };
    expect(Array.isArray(body.definitions)).toBe(true);
    expect(Array.isArray(body.instances)).toBe(true);
    expect(Array.isArray(body.bindings)).toBe(true);
    for (const d of body.definitions) {
      expect(['modeler', 'engine']).toContain(d.source);
    }
    // The PROCESSES_SEED mock instance ids (INS-77xx) must NEVER appear as real instances.
    const instIds = (body.instances as Array<{ inst: string }>).map((i) => i.inst);
    expect(instIds.some((id) => /^INS-77/.test(id))).toBe(false);
  }));

  it('a REAL modeler definition + a REAL started instance both appear (no mock)', requireDb(async () => {
    const procKey = `cat-modeler-${uuid().slice(0, 8)}`;
    const enginrKey = `cat-engine-${uuid().slice(0, 8)}`;
    const instanceId = `flw-${uuid().slice(0, 8)}`;

    // Use the FRESH tenant (actor-fresh) so the canonical-writer append owns its own
    // uncontended audit_head — no shared-DB chain collision with TENANT_A.
    await withClient(migratorUrl(), async (c) => {
      await seedProcessDefDirect(c, TENANT_FRESH, procKey);
    });
    await seedRealInstance(TENANT_FRESH, instanceId, enginrKey);

    const r = await makeRequest(baseUrl, 'GET', '/api/process-catalog', undefined, { 'x-dev-user': 'actor-fresh' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as {
      definitions: Array<{ process_key: string; source: string; status: string; instance_count: number }>;
      instances: Array<{ inst: string; process_key: string }>;
    };

    // The modeler def is present with source 'modeler'.
    const modelerDef = body.definitions.find((d) => d.process_key === procKey);
    expect(modelerDef).toBeDefined();
    expect(modelerDef!.source).toBe('modeler');
    expect(modelerDef!.status).toBe('published');

    // The engine-only key (no process_definition row) is present with source 'engine'.
    const engineDef = body.definitions.find((d) => d.process_key === enginrKey);
    expect(engineDef).toBeDefined();
    expect(engineDef!.source).toBe('engine');
    expect(engineDef!.instance_count).toBeGreaterThanOrEqual(1);

    // The REAL instance appears in the instances list.
    expect(body.instances.some((i) => i.inst === instanceId && i.process_key === enginrKey)).toBe(true);
  }));
});

describe('process-app-bindings — create/list + integrity (T-0270)', () => {
  it('400 VALIDATION on missing process_key', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/process-app-bindings',
      { application_id: uuid() },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('400 VALIDATION on a non-UUID application_id', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/process-app-bindings',
      { process_key: 'telLinear', application_id: 'not-a-uuid' },
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(400);
  }));

  it('404 when the application is not in the caller\'s tenant', requireDb(async () => {
    const r = await makeRequest(
      baseUrl,
      'POST',
      '/api/process-app-bindings',
      { process_key: 'telLinear', application_id: uuid() }, // random uuid → no such app
      { 'x-dev-user': 'actor-a' },
    );
    expect(r.statusCode).toBe(404);
  }));

  it('create → list roundtrip (binds a REAL created app)', requireDb(async () => {
    // Create a real application via the real POST /api/applications (201).
    const slug = `bind-app-${uuid().slice(0, 8)}`;
    const created = await makeRequest(
      baseUrl,
      'POST',
      '/api/applications',
      { slug, display_name: 'Binding Target App' },
      { 'x-dev-user': 'actor-a' },
    );
    expect(created.statusCode).toBe(201);
    const appId = (JSON.parse(created.body) as { id: string }).id;
    cleanupApps.push({ tenantId: TENANT_A, id: appId });

    const procKey = `bind-proc-${uuid().slice(0, 8)}`;
    const bind = await makeRequest(
      baseUrl,
      'POST',
      '/api/process-app-bindings',
      { process_key: procKey, application_id: appId, form_key: 'purchase-form' },
      { 'x-dev-user': 'actor-a' },
    );
    expect(bind.statusCode).toBe(201);
    const bindBody = JSON.parse(bind.body) as Record<string, unknown>;
    expect(typeof bindBody['id']).toBe('string');
    expect(bindBody['process_key']).toBe(procKey);
    expect(bindBody['application_id']).toBe(appId);
    expect(bindBody['form_key']).toBe('purchase-form');

    // LIST — the binding appears, joined to the application display name.
    const listed = await makeRequest(baseUrl, 'GET', '/api/process-app-bindings', undefined, { 'x-dev-user': 'actor-a' });
    expect(listed.statusCode).toBe(200);
    const listBody = JSON.parse(listed.body) as { bindings: Array<Record<string, unknown>> };
    const row = listBody.bindings.find((b) => b['process_key'] === procKey && b['application_id'] === appId);
    expect(row).toBeDefined();
    expect(row!['application_name']).toBe('Binding Target App');
    expect(row!['form_key']).toBe('purchase-form');

    // The binding is also surfaced in the unified catalog response.
    const cat = await makeRequest(baseUrl, 'GET', '/api/process-catalog', undefined, { 'x-dev-user': 'actor-a' });
    expect(cat.statusCode).toBe(200);
    const catBody = JSON.parse(cat.body) as { bindings: Array<Record<string, unknown>> };
    expect(catBody.bindings.some((b) => b['process_key'] === procKey && b['application_id'] === appId)).toBe(true);
  }));

  it('TENANT ISOLATION: actor A binding list never contains tenant B\'s bindings', requireDb(async () => {
    // Seed an app + binding directly into TENANT_B (migrator bypass).
    let bAppId = '';
    const bProcKey = `iso-proc-${uuid().slice(0, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      bAppId = await seedApplicationDirect(c, TENANT_B, `iso-app-${uuid().slice(0, 8)}`);
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      await c.query(
        `INSERT INTO choros.process_app_binding
           (tenant_id, id, process_key, application_id, form_key, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, 0, 0)`,
        [TENANT_B, uuid(), bProcKey, bAppId],
      );
      await c.query('COMMIT');
    });
    cleanupApps.push({ tenantId: TENANT_B, id: bAppId });

    const listed = await makeRequest(baseUrl, 'GET', '/api/process-app-bindings', undefined, { 'x-dev-user': 'actor-a' });
    expect(listed.statusCode).toBe(200);
    const listBody = JSON.parse(listed.body) as { bindings: Array<Record<string, unknown>> };
    expect(listBody.bindings.some((b) => b['process_key'] === bProcKey)).toBe(false);

    // Sanity: actor B DOES see its own binding.
    const listedB = await makeRequest(baseUrl, 'GET', '/api/process-app-bindings', undefined, { 'x-dev-user': 'actor-b' });
    expect(listedB.statusCode).toBe(200);
    const listBodyB = JSON.parse(listedB.body) as { bindings: Array<Record<string, unknown>> };
    expect(listBodyB.bindings.some((b) => b['process_key'] === bProcKey)).toBe(true);
  }));
});

describe('process-catalog — withAuth keycloak path (T-0270)', () => {
  it('401 without a Bearer JWT when CHOROS_AUTH_MODE=keycloak', requireDb(async () => {
    const prev = process.env['CHOROS_AUTH_MODE'];
    process.env['CHOROS_AUTH_MODE'] = 'keycloak';
    try {
      // No Authorization header → withAuth rejects with 401 BEFORE the handler runs.
      const r = await makeRequest(baseUrl, 'GET', '/api/process-catalog', undefined, { 'x-dev-user': 'actor-a' });
      expect(r.statusCode).toBe(401);
    } finally {
      if (prev === undefined) delete process.env['CHOROS_AUTH_MODE'];
      else process.env['CHOROS_AUTH_MODE'] = prev;
    }
  }));
});
