// T-0580 [D-064 §A8 / К4] — FF-14 (AC-15): LIVE Postgres integration proof that
// a scalar-formula field (`x-formula`) is:
//   (a) computed correctly on READ, appearing in GET /api/records/:id's
//       `derived` map (the SAME contour rollup/matrix-lookup use, T-0407/T-0575);
//   (b) reaches Flowable startInstance's engine variables when declared in an
//       on_create binding's field_mapping (the EXACT class of gap T-0575 BUG-016
//       fixed for rollup — this proves the fix generalizes to the formula flavor
//       added by T-0580, per ADR §2.4).
//
// Run in the `db` lane locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
// Part (b) additionally requires a live Flowable (FLOWABLE_PORT, default 8082);
// it SKIPS gracefully when Flowable is unreachable (mirrors
// detel-rollup-to-variables.db.test.ts) — part (a) needs ONLY Postgres.
//
// NEUTRAL fixture names (no product-case slugs, D-064 §5 anti-case discipline):
// "summa"/"nds_rate"/"itogo" are the ADR's OWN worked example (not a demo
// business case) — mirrored 1:1 from ADR-T0580-scalar-formulas.md §2 so the
// fixture is traceable to the design doc, not invented ad hoc.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';
import { makeFlowableClient } from '../../../src/core/flowable-client.js';

const hasDb = Boolean(process.env['DATABASE_URL']);

const FLOWABLE_PORT = process.env['FLOWABLE_PORT'] ?? '8082';
const FLOWABLE_ADMIN_USER = process.env['FLOWABLE_REST_APP_ADMIN_USER_ID'] ?? 'admin';
const FLOWABLE_ADMIN_PASSWORD = process.env['FLOWABLE_REST_APP_ADMIN_PASSWORD'] ?? 'choros_flowable_dev_pw';
const FLOWABLE_BASE_URL = `http://localhost:${FLOWABLE_PORT}/flowable-rest/service`;

let flowableReachable = false;

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!hasDb) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

function requireDbAndFlowable<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!hasDb) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    if (!flowableReachable) {
      console.log('[skip] Flowable not reachable at ' + FLOWABLE_BASE_URL);
      return;
    }
    return fn();
  };
}

// ---------------------------------------------------------------------------
// Minimal generic BPMN (mirrors detel-rollup-to-variables.db.test.ts's
// rollupGatewayBpmn) — task-submit FIRST (records.ts's skip-submit
// auto-complete unconditionally completes the first active user task after
// start), THEN a gateway keyed on the formula's projected value.
// ---------------------------------------------------------------------------
function formulaGatewayBpmn(processKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://choros.io/bpmn">
  <process id="${processKey}" name="Formula gateway ${processKey}" isExecutable="true">
    <startEvent id="start"/>
    <sequenceFlow id="f-start-submit" sourceRef="start" targetRef="task-submit"/>
    <userTask id="task-submit" name="Submit" flowable:candidateGroups="role-formula-reviewer"/>
    <sequenceFlow id="f-submit-gw" sourceRef="task-submit" targetRef="gw-amount"/>
    <exclusiveGateway id="gw-amount" name="Amount gate" default="f-default"/>
    <sequenceFlow id="f-high" sourceRef="gw-amount" targetRef="task-high-value">
      <conditionExpression xsi:type="tFormalExpression">\${itogo &gt; 100000}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f-default" sourceRef="gw-amount" targetRef="task-default"/>
    <userTask id="task-high-value" name="High value review"
              flowable:candidateGroups="role-formula-reviewer"/>
    <userTask id="task-default" name="Default review"
              flowable:candidateGroups="role-formula-reviewer"/>
    <sequenceFlow id="f-high-end" sourceRef="task-high-value" targetRef="end"/>
    <sequenceFlow id="f-default-end" sourceRef="task-default" targetRef="end"/>
    <endEvent id="end"/>
  </process>
</definitions>`;
}

/** All ACTIVE user-task taskDefinitionKeys for a live instance. */
async function activeTaskDefKeys(instanceId: string): Promise<string[]> {
  const resp = await fetch(
    `${FLOWABLE_BASE_URL}/runtime/tasks?processInstanceId=${encodeURIComponent(instanceId)}`,
    { headers: { Authorization: 'Basic ' + Buffer.from(`${FLOWABLE_ADMIN_USER}:${FLOWABLE_ADMIN_PASSWORD}`).toString('base64') } },
  );
  if (resp.status === 404) return [];
  if (resp.status !== 200) throw new Error(`GET /runtime/tasks unexpected status ${resp.status}`);
  const body = (await resp.json()) as { data?: Array<{ taskDefinitionKey?: string }> };
  return (body.data ?? []).map((t) => t.taskDefinitionKey ?? '');
}

/** Resolve the LIVE Flowable process-instance id for a record (mirrors detel-rollup test). */
async function resolveInstanceIdForRecord(tenantId: string, recordId: string): Promise<string> {
  const rows = await withClient(migratorUrl(), (c) =>
    c.query<{ payload: { inst?: string } }>(
      `SELECT payload FROM choros.audit_event
        WHERE tenant_id = $1 AND type = 'process.started' AND payload->>'record_id' = $2
        ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId, recordId],
    ),
  );
  const inst = rows.rows[0]?.payload?.inst;
  if (!inst) throw new Error(`no process.started audit event found for record ${recordId}`);
  return inst;
}

// ---------------------------------------------------------------------------
// HTTP helper (mirrors detel-rollup-to-variables.db.test.ts's makeRequest).
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
// Server + fixtures
// ---------------------------------------------------------------------------
let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

const TENANT_ID = crypto.randomUUID();
const ACTOR = 'formula-derived-actor';

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === ACTOR) return TENANT_ID;
  throw new Error(`unknown test actor: ${slug}`);
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
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 'published', 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

/**
 * A registry whose `itogo` field is a scalar FORMULA (ADR §2 worked example:
 * itogo = summa * (1 + nds_rate)). `summa`/`nds_rate` are plain number fields
 * IN record.data; `itogo` is NEVER stored (PD-20) — computed on READ.
 */
async function seedFormulaRegistry(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  slug: string,
): Promise<string> {
  const id = uuid();
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      summa: { type: 'number', title: 'Сумма' },
      nds_rate: { type: 'number', title: 'Ставка' },
      itogo: {
        type: 'number',
        title: 'Итого',
        'x-formula': { expr: 'summa * (1 + nds_rate)', result_type: 'number' },
      },
    },
    required: [],
  };
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description,
        record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
    [tenantId, id, applicationId, slug, JSON.stringify(schema)],
  );
  await c.query('COMMIT');
  return id;
}

/**
 * A registry with a DATE-result formula: deadline = data_podpisaniya + srok_dney
 * (ADR AC-2 worked example).
 */
async function seedDateFormulaRegistry(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  slug: string,
): Promise<string> {
  const id = uuid();
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      data_podpisaniya: { type: 'string', title: 'Дата подписания', 'x-date': true },
      srok_dney: { type: 'number', title: 'Срок (дней)' },
      deadline: {
        type: 'string',
        title: 'Дедлайн',
        'x-formula': { expr: 'data_podpisaniya + srok_dney', result_type: 'date' },
        'x-date': true,
      },
    },
    required: [],
  };
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description,
        record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
    [tenantId, id, applicationId, slug, JSON.stringify(schema)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedOnCreateBinding(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  processKey: string,
): Promise<void> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  // field_mapping maps the engine variable "itogo" → the record field path
  // "itogo" — the DERIVED (formula) key, not a raw submitted field (mirrors
  // detel-rollup-to-variables.db.test.ts's amount→totalAmount mapping).
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, trigger_type, field_mapping, submit_task_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'on_create', $5::jsonb, 'task-submit', 0, 0)`,
    [tenantId, id, processKey, applicationId, JSON.stringify({ itogo: 'itogo' })],
  );
  await c.query('COMMIT');
}

beforeAll(async () => {
  if (!hasDb) return;
  try {
    const resp = await fetch(`${FLOWABLE_BASE_URL}/management/engine`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${FLOWABLE_ADMIN_USER}:${FLOWABLE_ADMIN_PASSWORD}`).toString('base64') },
    });
    flowableReachable = resp.status === 200;
  } catch {
    flowableReachable = false;
  }

  appPool = new pg.Pool({ connectionString: appUrl() });
  const flowableClient = flowableReachable
    ? makeFlowableClient({ baseUrl: FLOWABLE_BASE_URL, adminUser: FLOWABLE_ADMIN_USER, adminPassword: FLOWABLE_ADMIN_PASSWORD })
    : undefined;
  const router = new Router();
  registerRecordRoutes(router, {
    pool: appPool,
    resolveActorTenant: stubResolveActorTenant,
    flowable: flowableClient,
  });
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

// ---------------------------------------------------------------------------
// Part (a): GET /api/records/:id → derived-map (Postgres only, no Flowable needed)
// ---------------------------------------------------------------------------
describe('T-0580 FF-14/AC-15 — scalar formula in derived-map on READ (live Postgres)', () => {
  it(
    'a numeric formula (ADR itogo = summa * (1 + nds_rate)) computes correctly on GET',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `formula-app-${Date.now()}`),
      );
      const registryId = await withClient(migratorUrl(), (c) =>
        seedFormulaRegistry(c, TENANT_ID, applicationId, 'formula-registry'),
      );

      const created = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: registryId, data: { summa: 100000, nds_rate: 0.2 } },
        { 'x-dev-user': ACTOR },
      );
      expect(created.statusCode).toBe(201);
      const recordId = (JSON.parse(created.body) as { id: string }).id;

      const detail = await makeRequest(baseUrl, 'GET', `/api/records/${recordId}`, undefined, {
        'x-dev-user': ACTOR,
      });
      expect(detail.statusCode).toBe(200);
      const body = JSON.parse(detail.body) as { derived?: Record<string, unknown>; data?: Record<string, unknown> };
      expect(body.derived).toBeDefined();
      expect(body.derived!['itogo']).toBe(120000);
      // PD-20: the formula value is NEVER stored in record.data.
      expect(body.data).not.toHaveProperty('itogo');
    }),
  );

  it(
    'a null operand yields derived[itogo] === null (honest, not 0) — anti-case: proves the formula is really computed, not hardcoded',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `formula-app-null-${Date.now()}`),
      );
      const registryId = await withClient(migratorUrl(), (c) =>
        seedFormulaRegistry(c, TENANT_ID, applicationId, 'formula-registry-null'),
      );

      // nds_rate omitted entirely → null operand → whole formula null.
      const created = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: registryId, data: { summa: 100000 } },
        { 'x-dev-user': ACTOR },
      );
      expect(created.statusCode).toBe(201);
      const recordId = (JSON.parse(created.body) as { id: string }).id;

      const detail = await makeRequest(baseUrl, 'GET', `/api/records/${recordId}`, undefined, {
        'x-dev-user': ACTOR,
      });
      const body = JSON.parse(detail.body) as { derived?: Record<string, unknown> };
      expect(body.derived!['itogo']).toBeNull();
    }),
  );

  it(
    'a date-result formula (deadline = data_podpisaniya + srok_dney) computes an ISO date string on GET',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `formula-date-app-${Date.now()}`),
      );
      const registryId = await withClient(migratorUrl(), (c) =>
        seedDateFormulaRegistry(c, TENANT_ID, applicationId, 'formula-date-registry'),
      );

      const created = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        {
          application_id: applicationId,
          registry_def_id: registryId,
          data: { data_podpisaniya: '2026-07-01', srok_dney: 30 },
        },
        { 'x-dev-user': ACTOR },
      );
      expect(created.statusCode).toBe(201);
      const recordId = (JSON.parse(created.body) as { id: string }).id;

      const detail = await makeRequest(baseUrl, 'GET', `/api/records/${recordId}`, undefined, {
        'x-dev-user': ACTOR,
      });
      expect(detail.statusCode).toBe(200);
      const body = JSON.parse(detail.body) as { derived?: Record<string, unknown> };
      expect(body.derived!['deadline']).toBe('2026-07-31');
      expect(typeof body.derived!['deadline']).toBe('string');
    }),
  );
});

// ---------------------------------------------------------------------------
// Part (b): on_create field_mapping → formula reaches Flowable startInstance
// variables (the T-0575 BUG-016 class, proven here for the formula flavor).
// SKIPS gracefully when Flowable is unreachable.
// ---------------------------------------------------------------------------
describe('T-0580 FF-14/AC-15 — formula field reaches startInstance variables via on_create (live Flowable+Postgres)', () => {
  it(
    'itogo > 100000 takes the HIGH-VALUE gateway branch; itogo <= 100000 takes the DEFAULT branch',
    requireDbAndFlowable(async () => {
      const processKey = `formulaGateway${Date.now()}`;
      const flowableClient = makeFlowableClient({
        baseUrl: FLOWABLE_BASE_URL,
        adminUser: FLOWABLE_ADMIN_USER,
        adminPassword: FLOWABLE_ADMIN_PASSWORD,
      });
      const deployResult = await flowableClient.deployBpmn(formulaGatewayBpmn(processKey));
      expect(deployResult.ok).toBe(true);

      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `formula-gw-app-${Date.now()}`),
      );
      const registryId = await withClient(migratorUrl(), (c) =>
        seedFormulaRegistry(c, TENANT_ID, applicationId, 'formula-gw-registry'),
      );
      await withClient(migratorUrl(), (c) => seedOnCreateBinding(c, TENANT_ID, applicationId, processKey));

      // HIGH: itogo = 100000 * 1.2 = 120000 > 100000.
      const rHigh = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: registryId, data: { summa: 100000, nds_rate: 0.2 } },
        { 'x-dev-user': ACTOR },
      );
      expect(rHigh.statusCode).toBe(201);
      const highId = (JSON.parse(rHigh.body) as { id: string }).id;
      const highInstance = await resolveInstanceIdForRecord(TENANT_ID, highId);
      let highKeys: string[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        highKeys = await activeTaskDefKeys(highInstance);
        if (highKeys.length > 0) break;
        await new Promise((res) => setTimeout(res, 200));
      }
      expect(highKeys).toContain('task-high-value');
      expect(highKeys).not.toContain('task-default');

      // DEFAULT: itogo = 10000 * 1.2 = 12000 <= 100000.
      const rLow = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: registryId, data: { summa: 10000, nds_rate: 0.2 } },
        { 'x-dev-user': ACTOR },
      );
      expect(rLow.statusCode).toBe(201);
      const lowId = (JSON.parse(rLow.body) as { id: string }).id;
      const lowInstance = await resolveInstanceIdForRecord(TENANT_ID, lowId);
      let lowKeys: string[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        lowKeys = await activeTaskDefKeys(lowInstance);
        if (lowKeys.length > 0) break;
        await new Promise((res) => setTimeout(res, 200));
      }
      expect(lowKeys).toContain('task-default');
      expect(lowKeys).not.toContain('task-high-value');
    }),
  );
});
