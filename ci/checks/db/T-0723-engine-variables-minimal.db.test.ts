// T-0723 (D-064, P3+hardening из T-0714 assessment §5 item 4 — security/PDP) ·
// emit-site hardening — LIVE Postgres probe (no live Flowable engine needed;
// this only captures the `variables` argument a STUB FlowableClient's
// `startInstance` receives, mirroring approval-registry-guard.db.test.ts's
// makeStubFlowable pattern).
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// THE CLAIM UNDER TEST (T-0723 spec §3, emit-site map): by F2 doctrine
// (product-decisions.md — business truth lives in the RECORD, never the
// process), Flowable's `variables` map at create=start is projected via
// `projectEngineVariables` (records.ts) SCOPED to the on_create binding's
// `field_mapping` — an explicit, process-designer-authored allow-list. A
// record field NOT named in `field_mapping` must NEVER reach the engine's
// variables, even when it sits right next to a field that IS mapped (and
// legitimately drives an authored gateway condition).
//
// PROVES:
//   VM-1: a record field that IS in field_mapping ("amount" → gateway
//     condition `${amount>500000}`-shaped consumer) reaches startInstance's
//     variables with its real value — branching consumers stay intact.
//   VM-2 (the anti-case): a SENSITIVE record field that is NOT in
//     field_mapping ("ssn") never appears as a KEY in the captured variables,
//     and its raw VALUE never appears anywhere in the captured variables
//     either (defense in depth against an accidental rename/alias).
//   VM-3: an object-shaped field (never a legitimate scalar variable per
//     RECORD_IN_PAYLOAD, T-0351) is dropped even when named in field_mapping
//     (belt-and-suspenders — projectEngineVariables's scalar-only guard).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';
import type { FlowableClient, StartResult } from '../../../src/core/flowable-client.js';

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

const TENANT_ID = uuid();
const ACTOR = 'vm-actor';

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === ACTOR) return TENANT_ID;
  throw new Error(`unknown test actor: ${slug}`);
}

/**
 * Capturing stub FlowableClient — startInstance records the (processKey,
 * variables) it was called with instead of talking to a real engine; every
 * other method is an inert stub (unused by the create=start path this file
 * exercises). Mirrors approval-registry-guard.db.test.ts's makeStubFlowable.
 */
interface CapturedStart {
  readonly processKey: string;
  readonly variables: Record<string, unknown>;
}

function makeCapturingFlowable(instanceId: string, captured: CapturedStart[]): FlowableClient {
  const startResult: StartResult = { ok: true, instanceId };
  return {
    deployBpmn: async () => ({ ok: false, code: 'UNKNOWN' as const }),
    startInstance: async (processKey: string, variables?: Record<string, unknown>) => {
      captured.push({ processKey, variables: variables ?? {} });
      return startResult;
    },
    fetchAndLock: async () => ({ ok: false, code: 'UNKNOWN' as const }),
    completeTask: async () => ({ ok: false, code: 'UNKNOWN' as const }),
    failTask: async () => ({ ok: false, code: 'UNKNOWN' as const }),
    getFirstActiveUserTask: async () => ({ ok: true, taskId: null }),
    completeUserTask: async () => ({ ok: true }),
    getActiveUserTasks: async () => ({ ok: true, tasks: [] }),
    getMessageCatchWaits: async () => ({ ok: true, waits: [] }),
    correlateMessage: async () => ({ ok: true }),
    isInstanceEnded: async () => ({ ok: true, ended: false }),
  };
}

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedApplication(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 'published', 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

/**
 * A registry whose schema declares BOTH a field the on_create binding maps
 * into engine variables ("amount", the gateway-condition consumer) and a
 * SENSITIVE field the binding deliberately does NOT map ("ssn") — the exact
 * shape VM-2 needs: two scalar fields side by side, only one authored into
 * field_mapping.
 */
async function seedRegistry(c: pg.Client, tenantId: string, applicationId: string, slug: string): Promise<string> {
  const id = uuid();
  const schema = {
    type: 'object',
    properties: {
      amount: { type: 'number', title: 'Amount' },
      ssn: { type: 'string', title: 'SSN (sensitive, NOT mapped)' },
      profile: { type: 'object', title: 'Profile (object, never a scalar variable)' },
    },
    required: [],
    additionalProperties: false,
  };
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
    [tenantId, id, applicationId, slug, JSON.stringify(schema)],
  );
  await c.query('COMMIT');
  return id;
}

/**
 * on_create binding whose field_mapping ONLY names "amount" (→ record field
 * "amount") — "ssn" and "profile" are deliberately absent from the map, the
 * SAME shape a real process author would configure for an authored gateway
 * condition like `${amount > 500000}`.
 */
async function seedOnCreateBinding(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  processKey: string,
): Promise<void> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, trigger_type, field_mapping, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'on_create', $5::jsonb, 0, 0)`,
    [tenantId, id, processKey, applicationId, JSON.stringify({ amount: 'amount' })],
  );
  await c.query('COMMIT');
}

/** Sibling binding whose field_mapping maps a NAME onto the object-shaped "profile" field (VM-3). */
async function seedOnCreateBindingObjectMapped(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  processKey: string,
): Promise<void> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, trigger_type, field_mapping, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'on_create', $5::jsonb, 0, 0)`,
    [tenantId, id, processKey, applicationId, JSON.stringify({ profileVar: 'profile' })],
  );
  await c.query('COMMIT');
}

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
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers },
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

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;
let captured: CapturedStart[];

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });
  captured = [];
  const flowable = makeCapturingFlowable('inst-vm-default', captured);
  const router = new Router();
  registerRecordRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant, flowable });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
  await withClient(migratorUrl(), (c) => seedTenant(c, TENANT_ID));
});

afterAll(async () => {
  if (!hasDb) return;
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('T-0723 VM-1/VM-2 (live PG): create=start engine variables are field_mapping-scoped, not a record dump', () => {
  it(
    'VM-1 (branching consumer intact): the field_mapping-mapped "amount" reaches startInstance variables with its real value',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) => seedApplication(c, TENANT_ID, `vm-app-${Date.now()}`));
      const registryId = await withClient(migratorUrl(), (c) => seedRegistry(c, TENANT_ID, applicationId, 'vm-reg'));
      const processKey = `vmProcess${Date.now()}`;
      await withClient(migratorUrl(), (c) => seedOnCreateBinding(c, TENANT_ID, applicationId, processKey));

      const before = captured.length;
      const r = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: registryId, data: { amount: 600000, ssn: '123-45-6789' } },
        { 'x-dev-user': ACTOR },
      );
      expect(r.statusCode, r.body).toBe(201);

      expect(captured.length).toBe(before + 1);
      const start = captured[captured.length - 1]!;
      expect(start.processKey).toBe(processKey);
      expect(start.variables['amount']).toBe(600000);
    }),
  );

  it(
    'VM-2 (D-064 anti-case, the sensitive-duplicate check): the UNMAPPED "ssn" field is absent from startInstance variables — neither as a key nor anywhere as a value',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) => seedApplication(c, TENANT_ID, `vm-app2-${Date.now()}`));
      const registryId = await withClient(migratorUrl(), (c) => seedRegistry(c, TENANT_ID, applicationId, 'vm-reg2'));
      const processKey = `vmProcessSensitive${Date.now()}`;
      await withClient(migratorUrl(), (c) => seedOnCreateBinding(c, TENANT_ID, applicationId, processKey));

      const SENSITIVE_VALUE = '123-45-6789';
      const before = captured.length;
      const r = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: registryId, data: { amount: 750000, ssn: SENSITIVE_VALUE } },
        { 'x-dev-user': ACTOR },
      );
      expect(r.statusCode, r.body).toBe(201);

      expect(captured.length).toBe(before + 1);
      const start = captured[captured.length - 1]!;
      // Not as a key under its own name.
      expect(Object.prototype.hasOwnProperty.call(start.variables, 'ssn')).toBe(false);
      // Not as a value under ANY key (defense in depth against an accidental
      // rename/alias re-introducing the same raw value under a different name).
      expect(Object.values(start.variables)).not.toContain(SENSITIVE_VALUE);
      // The mapped field is still there (this is a NARROWING proof, not a
      // "nothing gets through" proof — VM-1 already covers the positive case,
      // repeated here so a future regression that empties field_mapping
      // entirely does not accidentally satisfy this test too).
      expect(start.variables['amount']).toBe(750000);
    }),
  );

  it(
    'VM-3 (RECORD_IN_PAYLOAD, T-0351 precedent): an object-shaped field is dropped even when explicitly named in field_mapping',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) => seedApplication(c, TENANT_ID, `vm-app3-${Date.now()}`));
      const registryId = await withClient(migratorUrl(), (c) => seedRegistry(c, TENANT_ID, applicationId, 'vm-reg3'));
      const processKey = `vmProcessObject${Date.now()}`;
      await withClient(migratorUrl(), (c) => seedOnCreateBindingObjectMapped(c, TENANT_ID, applicationId, processKey));

      const before = captured.length;
      const r = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: registryId, data: { profile: { name: 'x', ssn: '999-99-9999' } } },
        { 'x-dev-user': ACTOR },
      );
      expect(r.statusCode, r.body).toBe(201);

      expect(captured.length).toBe(before + 1);
      const start = captured[captured.length - 1]!;
      expect(Object.prototype.hasOwnProperty.call(start.variables, 'profileVar')).toBe(false);
    }),
  );
});
