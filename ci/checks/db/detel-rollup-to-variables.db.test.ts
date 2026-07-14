// T-0575 [W1/деТЭЛ] BUG-016 — FF-3 (AC-5, AC-3): LIVE Flowable + LIVE Postgres
// integration proof that a computed (x-rollup) field, declared in the on_create
// binding's field_mapping, actually REACHES the variables passed to
// flowable.startInstance — the exact class of defect ADR-T0575-detel-primitives.md
// §2.4 fixes.
//
// Run in the `db` lane locally (requires BOTH a live Postgres AND a live Flowable —
// this test SKIPS gracefully when either is absent, mirroring
// ci/checks/db/engine-drive-generic.db.test.ts):
//
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   FLOWABLE_PORT=8082 FLOWABLE_REST_APP_ADMIN_PASSWORD=choros_flowable_dev_pw \
//   npm run fitness:db
//
// WHAT THIS PROVES (AC-5 / AC-3 exactly):
//   1. Seed a PARENT registry whose record_schema declares `totalAmount` as an
//      `x-rollup` field (sum over a CHILD registry's `value`, matched by
//      `data->>'parentRef' = parent_record_id` — PD-20 doctrine: totalAmount is
//      NEVER stored in the parent's record.data).
//   2. Seed an on_create process_app_binding whose field_mapping maps the engine
//      variable "amount" → the record field path "totalAmount" (the DERIVED key,
//      not a raw submitted field).
//   3. Deploy a GENERIC BPMN (deliberately NOT tel-linear) with a plain JUEL
//      exclusiveGateway condition `${amount > 500000}` — no DMN involved, isolating
//      BUG-016 from the unrelated DMN-precompute machinery.
//   4. PRE-SEED CHILD records whose `data.value` sums to MORE than 500000, keyed
//      to a record id the test controls deterministically (node:crypto's
//      randomUUID is mocked for the ONE call records.ts's createRecord makes to
//      mint the new parent id — every OTHER randomUUID call in the same process,
//      e.g. inside the audit writer, still gets a real random value).
//   5. POST /api/records (application_id + registry_def_id, data={}) through the
//      REAL HTTP route (registerRecordRoutes) — the SAME handler production
//      traffic hits — triggering the REAL on_create → REAL startInstance call.
//   6. Assert — against the LIVE Flowable engine, not a mock — that the started
//      instance is waiting at the HIGH-VALUE branch task (gw condition true),
//      NOT the default branch — proving `amount` (== the rollup sum) really
//      reached flowable.startInstance's variables map.
//
// RED on the pre-T-0575 code: `projectEngineVariables` reads ONLY record.data;
// the rollup key is never in `data` (PD-20) → `amount` is always `undefined` →
// the JUEL condition `${amount > 500000}` evaluates false → the instance takes
// the DEFAULT branch regardless of the (correctly summed, >500000) child rows —
// this is the EXACT symptom LIVE_PROOF T-0571 observed on tel-linear.
// GREEN after the fix: computeAllDerivedFields overlays the rollup value before
// projectEngineVariables runs → `amount` is the real sum → the HIGH-VALUE branch
// is taken.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';
import { makeFlowableClient } from '../../../src/core/flowable-client.js';

// ---------------------------------------------------------------------------
// Deterministic record-id seam (module-level mock — node:crypto's randomUUID
// exports are non-configurable, so vi.spyOn cannot redefine them directly; the
// importOriginal indirection is the standard Vitest pattern for builtin
// overrides). `nextForcedId` is set to a KNOWN uuid IMMEDIATELY before the ONE
// POST /api/records call whose minted parent-record id we need to predict (so
// pre-seeded child rows' `parentRef` can point at it); every OTHER randomUUID()
// call in the same process (audit events, outbox rows, etc.) falls through to
// the REAL implementation untouched.
// ---------------------------------------------------------------------------
let nextForcedId: string | null = null;

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: (...args: unknown[]) => {
      if (nextForcedId !== null) {
        const v = nextForcedId;
        nextForcedId = null;
        return v;
      }
      return (actual.randomUUID as (...a: unknown[]) => string)(...args);
    },
  };
});

const hasDb = Boolean(process.env['DATABASE_URL']);

const FLOWABLE_PORT = process.env['FLOWABLE_PORT'] ?? '8082';
const FLOWABLE_ADMIN_USER = process.env['FLOWABLE_REST_APP_ADMIN_USER_ID'] ?? 'admin';
const FLOWABLE_ADMIN_PASSWORD = process.env['FLOWABLE_REST_APP_ADMIN_PASSWORD'] ?? 'choros_flowable_dev_pw';
const FLOWABLE_BASE_URL = `http://localhost:${FLOWABLE_PORT}/flowable-rest/service`;

let flowableReachable = false;

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
// Minimal generic BPMN with a plain JUEL exclusiveGateway condition — NOT DMN,
// deliberately isolating BUG-016 (the rollup→variables gap) from the unrelated
// DMN-precompute machinery (preComputeGatewayVariable). Two branches: high-value
// (amount > 500000) and default (explicit `default` attribute on the gateway,
// avoiding "no outgoing flow selected" ambiguity when BOTH the condition is
// false and the unconditioned flow would otherwise look ambiguous to the
// engine — same discipline as an authored process).
//
// task-submit FIRST (mirrors tel-linear's shape): the on_create path's
// "skip-submit" auto-complete (records.ts T-0368) unconditionally completes
// the FIRST active user task after start — by DESIGN, for the common ТЭЛ-shaped
// "task-submit is always first" case. Without a task-submit-equivalent node
// here, that auto-complete would swallow the very gateway-target task this
// test observes. Naming it "task-submit" makes the BPMN's shape match what
// on_create actually expects (any real authored on_create process has this
// same submit-then-decide shape).
// ---------------------------------------------------------------------------

function rollupGatewayBpmn(processKey: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://choros.io/bpmn">
  <process id="${processKey}" name="Rollup gateway ${processKey}" isExecutable="true">
    <startEvent id="start"/>
    <sequenceFlow id="f-start-submit" sourceRef="start" targetRef="task-submit"/>
    <userTask id="task-submit" name="Submit" flowable:candidateGroups="role-rollup-reviewer"/>
    <sequenceFlow id="f-submit-gw" sourceRef="task-submit" targetRef="gw-amount"/>
    <exclusiveGateway id="gw-amount" name="Amount gate" default="f-default"/>
    <sequenceFlow id="f-high" sourceRef="gw-amount" targetRef="task-high-value">
      <conditionExpression xsi:type="tFormalExpression">\${amount &gt; 500000}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f-default" sourceRef="gw-amount" targetRef="task-default"/>
    <userTask id="task-high-value" name="High value review"
              flowable:candidateGroups="role-rollup-reviewer"/>
    <userTask id="task-default" name="Default review"
              flowable:candidateGroups="role-rollup-reviewer"/>
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

/**
 * Resolve the LIVE Flowable process-instance id (payload->>'inst') from the
 * process.started audit event keyed by the originating record id
 * (payload->>'record_id' — set by appendProcessStarted's recordId parameter,
 * records.ts on_create call site). The record id (returned by POST
 * /api/records) and the Flowable instance id are DIFFERENT identifiers — the
 * runtime task query below needs the LATTER.
 */
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
// HTTP helper (mirrors engine-drive-generic.db.test.ts's makeRequest).
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
const ACTOR = 'detel-rollup-actor';

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

async function seedChildRegistry(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  slug: string,
): Promise<string> {
  const id = uuid();
  const schema = {
    type: 'object',
    properties: {
      parentRef: { type: 'string', title: 'Parent ref' },
      value: { type: 'number', title: 'Value' },
    },
    required: [],
    additionalProperties: false,
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

/** Parent registry: `totalAmount` is an x-rollup field — NEVER stored in record.data. */
async function seedParentRegistry(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  slug: string,
  childRegistryId: string,
): Promise<string> {
  const id = uuid();
  const schema = {
    type: 'object',
    properties: {
      totalAmount: {
        type: 'number',
        title: 'Total amount (rollup)',
        'x-rollup': {
          source_registry_id: childRegistryId,
          ref_field: 'parentRef',
          aggregate: 'sum',
          value_field: 'value',
        },
      },
    },
    required: [],
    additionalProperties: false,
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
 * T-0603 — Parent registry whose `total` is an EMBEDDED x-rollup field
 * (aggregate over an in-record `lines` collection array; NEUTRAL names — no
 * product-case slugs, D-064 §5). `total` is NEVER stored in record.data.
 */
async function seedEmbeddedRollupRegistry(
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
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            price: { type: 'number', title: 'Price' },
            qty: { type: 'number', title: 'Qty' },
          },
        },
      },
      total: {
        type: 'number',
        title: 'Total (embedded rollup)',
        'x-rollup': { source: 'lines', op: 'sum', value_field: 'price', factor_field: 'qty' },
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
  // T-0764: MUST be explicit, not left to NULL/"primary registry" inference.
  // getOnCreateBinding (T-0606, migration 122) resolves a NULL trigger_registry_id
  // against "the earliest-created non-system registry_def for this application"
  // (ORDER BY created_at ASC, id ASC). Every registry_def row this file seeds
  // carries a LITERAL created_at=0 (see seedChildRegistry/seedParentRegistry/
  // seedEmbeddedRollupRegistry below) — so that ORDER BY ties on created_at and
  // falls through to `id ASC`, i.e. WHICHEVER of the two registries' random
  // uuid()s sorts alphabetically first — a COIN FLIP, not the intended parent
  // registry, on every run. Leaving trigger_registry_id NULL (the pre-T-0764
  // shape of this helper) therefore matched the binding to the PARENT registry
  // (where records are actually posted) only by luck of UUID draw — silently
  // never proven live because this whole file skips without a live Flowable
  // (requireDbAndFlowable). Passing the caller's real registryId explicitly
  // (the T-0606 canonical idiom — see approval-registry-guard.db.test.ts's own
  // seedOnCreateBinding) makes the match deterministic regardless of UUID luck.
  triggerRegistryId: string,
  // T-0764: the rollup field key differs by flavor — 'totalAmount' for the
  // child-records flavor (seedParentRegistry), 'total' for the embedded flavor
  // (seedEmbeddedRollupRegistry). The pre-T-0764 hardcoded 'totalAmount' silently
  // starved the embedded-flavor test's `amount` engine variable (the field never
  // existed under that key on that registry) — never caught for the same reason
  // as above.
  fieldKey: string = 'totalAmount',
): Promise<void> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  // T-0604 [P0/целостность согласований]: on_create auto-complete is now GATED
  // by process_app_binding.submit_task_key (migration 121) — the live engine's
  // first active user-task's taskDefinitionKey must match this declared value
  // for the skip-submit auto-complete to fire at all (NULL = no auto-complete,
  // the new safe default). This test's BPMN (rollupGatewayBpmn, see the
  // module-level comment above) deliberately names its first userTask
  // "task-submit" so it can exercise the SAME submit-then-decide shape a real
  // authored on_create process has — declaring submit_task_key='task-submit'
  // here preserves that intent under the new gate (without it, this seeded
  // binding would default to NULL and the instance would wait at task-submit
  // forever, never reaching the gateway this test observes).
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, trigger_type, field_mapping, submit_task_key, trigger_registry_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'on_create', $5::jsonb, 'task-submit', $6, 0, 0)`,
    [tenantId, id, processKey, applicationId, JSON.stringify({ amount: fieldKey }), triggerRegistryId],
  );
  await c.query('COMMIT');
}

async function seedChildRecord(
  c: pg.Client,
  tenantId: string,
  registryId: string,
  parentRef: string,
  value: number,
): Promise<void> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, 'test-seed')`,
    [tenantId, id, registryId, JSON.stringify({ parentRef, value })],
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
  if (!flowableReachable) return;

  appPool = new pg.Pool({ connectionString: appUrl() });
  const flowableClient = makeFlowableClient({
    baseUrl: FLOWABLE_BASE_URL,
    adminUser: FLOWABLE_ADMIN_USER,
    adminPassword: FLOWABLE_ADMIN_PASSWORD,
  });
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
  if (!hasDb || !flowableReachable) return;
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('T-0575 FF-3/AC-5/AC-3 — computed rollup reaches startInstance variables (live Flowable+Postgres)', () => {
  it(
    'on_create with a >500000 rollup sum takes the HIGH-VALUE gateway branch (BUG-016 fixed)',
    requireDbAndFlowable(async () => {
      const processKey = `rollupGateway${Date.now()}`;

      // 1. Deploy the generic gateway BPMN.
      const flowableClient = makeFlowableClient({
        baseUrl: FLOWABLE_BASE_URL,
        adminUser: FLOWABLE_ADMIN_USER,
        adminPassword: FLOWABLE_ADMIN_PASSWORD,
      });
      const deployResult = await flowableClient.deployBpmn(rollupGatewayBpmn(processKey));
      expect(deployResult.ok).toBe(true);

      // 2. Seed application + child/parent registries + on_create binding.
      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `detel-rollup-app-${Date.now()}`),
      );
      const childRegistryId = await withClient(migratorUrl(), (c) =>
        seedChildRegistry(c, TENANT_ID, applicationId, 'rollup-children'),
      );
      const parentRegistryId = await withClient(migratorUrl(), (c) =>
        seedParentRegistry(c, TENANT_ID, applicationId, 'rollup-parent', childRegistryId),
      );
      await withClient(migratorUrl(), (c) =>
        seedOnCreateBinding(c, TENANT_ID, applicationId, processKey, parentRegistryId),
      );

      // 3. PRE-SEED child records summing to MORE than 500000, keyed to a
      // DETERMINISTIC parent id the test controls (records.ts mints the parent's
      // id via node:crypto randomUUID as literally its first statement in
      // createRecord — intercept exactly ONE call so the child rows' parentRef
      // matches the id the HTTP POST below will actually insert).
      const deterministicParentId = crypto.randomUUID();
      await withClient(migratorUrl(), async (c) => {
        await seedChildRecord(c, TENANT_ID, childRegistryId, deterministicParentId, 300000);
        await seedChildRecord(c, TENANT_ID, childRegistryId, deterministicParentId, 250000);
        // sum = 550000 > 500000 — must take the HIGH-VALUE branch.
      });

      nextForcedId = deterministicParentId;

      // 4. POST /api/records — the REAL on_create HTTP path.
      const r = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: parentRegistryId, data: {} },
        { 'x-dev-user': ACTOR },
      );

      expect(r.statusCode).toBe(201);
      const created = JSON.parse(r.body) as { id: string };
      expect(created.id).toBe(deterministicParentId);

      // 5. THE PROOF (AC-5/AC-3): resolve the LIVE Flowable instance id via the
      // process.started audit event (record id ≠ Flowable instance id), then
      // poll briefly for the engine's async task state, asserting the instance
      // is waiting at task-high-value (gateway condition ${amount>500000} was
      // TRUE) — not task-default. This requires `amount` to have carried the
      // REAL 550000 rollup sum into startInstance's variables.
      const instanceId = await resolveInstanceIdForRecord(TENANT_ID, deterministicParentId);
      let defKeys: string[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        // Flowable start + gateway evaluation is synchronous to startInstance in
        // practice, but poll briefly for CI determinism under load.
        defKeys = await activeTaskDefKeys(instanceId);
        if (defKeys.length > 0) break;
        await new Promise((res) => setTimeout(res, 200));
      }

      expect(defKeys).toContain('task-high-value');
      expect(defKeys).not.toContain('task-default');
    }),
  );

  it(
    'on_create with a rollup sum BELOW threshold takes the DEFAULT branch (anti-case, proves the gate is not always-true)',
    requireDbAndFlowable(async () => {
      const processKey = `rollupGatewayLow${Date.now()}`;
      const flowableClient = makeFlowableClient({
        baseUrl: FLOWABLE_BASE_URL,
        adminUser: FLOWABLE_ADMIN_USER,
        adminPassword: FLOWABLE_ADMIN_PASSWORD,
      });
      const deployResult = await flowableClient.deployBpmn(rollupGatewayBpmn(processKey));
      expect(deployResult.ok).toBe(true);

      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `detel-rollup-app-low-${Date.now()}`),
      );
      const childRegistryId = await withClient(migratorUrl(), (c) =>
        seedChildRegistry(c, TENANT_ID, applicationId, 'rollup-children-low'),
      );
      const parentRegistryId = await withClient(migratorUrl(), (c) =>
        seedParentRegistry(c, TENANT_ID, applicationId, 'rollup-parent-low', childRegistryId),
      );
      await withClient(migratorUrl(), (c) =>
        seedOnCreateBinding(c, TENANT_ID, applicationId, processKey, parentRegistryId),
      );

      const deterministicParentId = crypto.randomUUID();
      await withClient(migratorUrl(), async (c) => {
        await seedChildRecord(c, TENANT_ID, childRegistryId, deterministicParentId, 10000);
        // sum = 10000 < 500000 — must take the DEFAULT branch.
      });

      nextForcedId = deterministicParentId;

      const r = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: parentRegistryId, data: {} },
        { 'x-dev-user': ACTOR },
      );

      expect(r.statusCode).toBe(201);
      const created = JSON.parse(r.body) as { id: string };
      expect(created.id).toBe(deterministicParentId);

      const instanceId = await resolveInstanceIdForRecord(TENANT_ID, deterministicParentId);
      let defKeys: string[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        defKeys = await activeTaskDefKeys(instanceId);
        if (defKeys.length > 0) break;
        await new Promise((res) => setTimeout(res, 200));
      }

      expect(defKeys).toContain('task-default');
      expect(defKeys).not.toContain('task-high-value');
    }),
  );
});

// ---------------------------------------------------------------------------
// T-0603 — EMBEDDED rollup flavor (aggregate over an in-record collection array)
// reaches startInstance variables AND the GET /api/records/:id derived map.
//
// This is the flavor the interface constructor actually authors and the flavor
// live in production ("total = Σ line price × qty over an items collection inside
// the record's own data"). The T-0575 tests above cover only the child-records
// flavor — this block closes the coverage gap that let the acceptance bug ship.
// NEUTRAL fixture names (lines / price / qty / a generic process key) — no
// product-case slugs (D-064 §5). The collection is POSTed inline in `data`
// (no pre-seeded child records, no deterministic-id mock needed).
// ---------------------------------------------------------------------------
describe('T-0603 — embedded rollup reaches startInstance variables + derived map (live Flowable+Postgres)', () => {
  it(
    'AC-9: on_create with an embedded >500000 rollup sum takes the HIGH-VALUE branch; <threshold/empty → default',
    requireDbAndFlowable(async () => {
      const processKey = `embeddedRollupGw${Date.now()}`;
      const flowableClient = makeFlowableClient({
        baseUrl: FLOWABLE_BASE_URL,
        adminUser: FLOWABLE_ADMIN_USER,
        adminPassword: FLOWABLE_ADMIN_PASSWORD,
      });
      const deployResult = await flowableClient.deployBpmn(rollupGatewayBpmn(processKey));
      expect(deployResult.ok).toBe(true);

      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `t0603-embedded-app-${Date.now()}`),
      );
      const registryId = await withClient(migratorUrl(), (c) =>
        seedEmbeddedRollupRegistry(c, TENANT_ID, applicationId, 'embedded-rollup-parent'),
      );
      await withClient(migratorUrl(), (c) =>
        // T-0764: embedded flavor's rollup field is named 'total' (see
        // seedEmbeddedRollupRegistry above), NOT 'totalAmount' — the hardcoded
        // default that matches only the child-records flavor (seedParentRegistry).
        seedOnCreateBinding(c, TENANT_ID, applicationId, processKey, registryId, 'total'),
      );

      // HIGH-VALUE: Σ price×qty = 300000 + 250000 = 550000 > 500000.
      const rHigh = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        {
          application_id: applicationId,
          registry_def_id: registryId,
          data: { lines: [{ price: 100000, qty: 3 }, { price: 250000, qty: 1 }] },
        },
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

      // AC-10: GET /api/records/:id returns derived[total] = the same 550000 sum
      // (server compute now matches the UI — closes the divergence).
      const detail = await makeRequest(baseUrl, 'GET', `/api/records/${highId}`, undefined, {
        'x-dev-user': ACTOR,
      });
      expect(detail.statusCode).toBe(200);
      const detailBody = JSON.parse(detail.body) as { derived?: Record<string, unknown> };
      expect(detailBody.derived).toBeDefined();
      expect(detailBody.derived!['total']).toBe(550000);

      // LOW: Σ = 10000 × 1 = 10000 < 500000 → default branch (proves the gate is
      // not always-true and the embedded sum is really computed, not hardcoded).
      const rLow = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        {
          application_id: applicationId,
          registry_def_id: registryId,
          data: { lines: [{ price: 10000, qty: 1 }] },
        },
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

      // EMPTY collection → total null → amount null → default branch (honest null).
      const rEmpty = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: registryId, data: { lines: [] } },
        { 'x-dev-user': ACTOR },
      );
      expect(rEmpty.statusCode).toBe(201);
      const emptyId = (JSON.parse(rEmpty.body) as { id: string }).id;
      const emptyInstance = await resolveInstanceIdForRecord(TENANT_ID, emptyId);
      let emptyKeys: string[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        emptyKeys = await activeTaskDefKeys(emptyInstance);
        if (emptyKeys.length > 0) break;
        await new Promise((res) => setTimeout(res, 200));
      }
      expect(emptyKeys).toContain('task-default');
      expect(emptyKeys).not.toContain('task-high-value');
    }),
  );
});
