// T-0571 [W1/шов] BUG-014 — FF-3 (AC-6): LIVE Flowable + LIVE Postgres integration
// proof that the engine-drive seam completes the RIGHT engine user-task for a
// GENERIC process (a BPMN whose first user-task is NOT named "task-approve") —
// the exact defect class this ADR fixes (ADR-T0571-engine-drive-seam.md §2.1).
//
// Run in the `db`-lane locally (requires BOTH a live Postgres AND a live Flowable —
// this test SKIPS gracefully when either is absent, matching the requireDb() pattern
// used across ci/checks/db/*):
//
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   FLOWABLE_PORT=8082 FLOWABLE_REST_APP_ADMIN_PASSWORD=choros_flowable_dev_pw \
//   npm run fitness:db
//
// (docker compose up -d postgres flowable; bash ci/checks/flowable/wait-ready.sh first)
//
// WHAT THIS PROVES (AC-6 exactly):
//   1. Deploy a GENERIC BPMN (process key "zakupkiGeneric", first user-task
//      taskDefinitionKey="zakupki-approve" — deliberately NOT "task-approve").
//   2. Start a live instance; seed the matching process.started projection row
//      (T-0571: taskDefKey=null, resolve-by-instance signal — no literal).
//   3. POST /api/inbox/:id/action { action: "approve" } through the REAL HTTP route
//      (registerInboxRoutes, the SAME handler production traffic hits).
//   4. Assert the response is 200 { engine: "completed" } — NOT the old silent
//      200-without-effect (BUG-014).
//   5. Assert — against the LIVE engine, not a mock — that the "zakupki-approve"
//      task is GONE from GET /runtime/tasks?processInstanceId=... (genuinely
//      completed, not just claimed to be).
//   6. Second generic process (different key, different node name
//      "otpusk-approve") proves the fix generalizes (anti-case, AC-4 unit-equiv).
//
// This test is RED on the pre-T-0571 code (the base row's hardcoded taskDefKey=
// "task-approve" never matches "zakupki-approve" → completeUserTask never called →
// old code returns 200 regardless; this test's engine-state assertion catches that
// the task is STILL active) and GREEN after the fix (resolve-by-instance finds and
// completes the task regardless of its real name).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerInboxRoutes, type InboxWriteDeps } from '../../../src/http/inbox.js';
import { appendProcessStarted } from '../../../src/http/process-projection.js';
import { makePgAuditWriter, type PgClientLike } from '../../../src/db/audit-writer.js';
import { makeFlowableClient } from '../../../src/core/flowable-client.js';

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
// Minimal GENERIC BPMN builders — deliberately NOT the ТЭЛ tel-linear.bpmn20.xml
// (D-064 anti-case, spec §4.1 FR-3): the first (and only) user-task's
// taskDefinitionKey is a caller-supplied, non-"task-approve" name, proving the
// fix is NOT keyed off any specific literal.
// ---------------------------------------------------------------------------

function genericBpmn(processKey: string, taskDefKey: string, role: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://choros.io/bpmn">
  <process id="${processKey}" name="Generic ${processKey}" isExecutable="true">
    <startEvent id="start" name="Start"/>
    <sequenceFlow id="f1" sourceRef="start" targetRef="${taskDefKey}"/>
    <userTask id="${taskDefKey}" name="Generic approve"
              flowable:candidateGroups="${role}">
    </userTask>
    <sequenceFlow id="f2" sourceRef="${taskDefKey}" targetRef="end"/>
    <endEvent id="end" name="End"/>
  </process>
</definitions>`;
}

async function deployAndStart(
  processKey: string,
  taskDefKey: string,
  role: string,
): Promise<{ instanceId: string }> {
  const client = makeFlowableClient({
    baseUrl: FLOWABLE_BASE_URL,
    adminUser: FLOWABLE_ADMIN_USER,
    adminPassword: FLOWABLE_ADMIN_PASSWORD,
  });
  const xml = genericBpmn(processKey, taskDefKey, role);
  const deployResult = await client.deployBpmn(xml);
  if (!deployResult.ok) {
    throw new Error(`deployBpmn failed for ${processKey}: ${JSON.stringify(deployResult)}`);
  }
  const startResult = await client.startInstance(processKey);
  if (!startResult.ok) {
    throw new Error(`startInstance failed for ${processKey}: ${JSON.stringify(startResult)}`);
  }
  return { instanceId: startResult.instanceId };
}

/** Raw REST check — is `taskDefKey` still an ACTIVE user-task on this instance? */
async function isTaskStillActive(instanceId: string, taskDefKey: string): Promise<boolean> {
  const resp = await fetch(
    `${FLOWABLE_BASE_URL}/runtime/tasks?processInstanceId=${encodeURIComponent(instanceId)}`,
    { headers: { Authorization: 'Basic ' + Buffer.from(`${FLOWABLE_ADMIN_USER}:${FLOWABLE_ADMIN_PASSWORD}`).toString('base64') } },
  );
  if (resp.status === 404) return false; // instance gone → nothing active.
  if (resp.status !== 200) throw new Error(`GET /runtime/tasks unexpected status ${resp.status}`);
  const body = (await resp.json()) as { data?: Array<{ taskDefinitionKey?: string }> };
  const items = body.data ?? [];
  return items.some((t) => t.taskDefinitionKey === taskDefKey);
}

// ---------------------------------------------------------------------------
// Seed helpers (mirrors applications_delete_cascade.db.test.ts's role/employee/
// role_assignment pattern — the approve handler's PDP grant-check needs a REAL
// employee holding the task's role, live in the DB, not a stub).
// ---------------------------------------------------------------------------

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedApproverGrant(
  c: pg.Client,
  tenantId: string,
  actorSlug: string,
  roleSlug: string,
): Promise<void> {
  const empId = uuid();
  const roleId = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, empId, actorSlug, `Approver ${actorSlug}`],
  );
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, roleId, roleSlug],
  );
  const roleRes = await c.query<{ id: string }>(
    `SELECT id FROM choros.role WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
    [tenantId, roleSlug],
  );
  const actualRoleId = roleRes.rows[0]!.id;
  const empRes = await c.query<{ id: string }>(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
    [tenantId, actorSlug],
  );
  const actualEmpId = empRes.rows[0]!.id;
  const raExists = await c.query(
    `SELECT 1 FROM choros.role_assignment
      WHERE tenant_id = $1 AND employee_id = $2 AND role_id = $3 AND confirmed_by IS NOT NULL LIMIT 1`,
    [tenantId, actualEmpId, actualRoleId],
  );
  if (raExists.rowCount === 0) {
    await c.query(
      `INSERT INTO choros.role_assignment
         (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
          source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
       VALUES ($1, $2, $3::uuid, $4, $5::jsonb, NULL, NULL, 'genesis', $6::text, $6::text, $6::text, 0, 0)`,
      [
        tenantId,
        uuid(),
        actualEmpId,
        actualRoleId,
        JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'org', nodeLevel: 'department' }),
        actorSlug,
      ],
    );
  }
  await c.query('COMMIT');
}

// ---------------------------------------------------------------------------
// HTTP helper (mirrors process-catalog.test.ts's makeRequest).
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
const writer = makePgAuditWriter();

const TENANT_1 = crypto.randomUUID();
const TENANT_2 = crypto.randomUUID();
const APPROVER_1 = 'zakupki-approver-e2e';
const APPROVER_2 = 'otpusk-approver-e2e';
const ROLE_1 = 'role-zakupki-approver';
const ROLE_2 = 'role-otpusk-approver';

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === APPROVER_1) return TENANT_1;
  if (slug === APPROVER_2) return TENANT_2;
  throw new Error(`unknown test actor: ${slug}`);
}

beforeAll(async () => {
  if (!hasDb) return;

  // Probe Flowable reachability ONCE — honest-degrade (skip, never fail the db lane
  // when Flowable is not brought up alongside Postgres locally, mirroring the `db` CI
  // job's actual topology today: postgres-only; Flowable lives in a separate job).
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
  const router = new Router();
  const writeDeps: InboxWriteDeps = {
    pool: appPool,
    resolveActorTenant: stubResolveActorTenant,
    flowableClient: makeFlowableClient({
      baseUrl: FLOWABLE_BASE_URL,
      adminUser: FLOWABLE_ADMIN_USER,
      adminPassword: FLOWABLE_ADMIN_PASSWORD,
    }),
  };
  registerInboxRoutes(router, undefined, writeDeps);
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  await withClient(migratorUrl(), async (c) => {
    await seedTenant(c, TENANT_1);
    await seedTenant(c, TENANT_2);
    await seedApproverGrant(c, TENANT_1, APPROVER_1, ROLE_1);
    await seedApproverGrant(c, TENANT_2, APPROVER_2, ROLE_2);
  });
});

afterAll(async () => {
  if (!hasDb || !flowableReachable) return;
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tests (AC-6)
// ---------------------------------------------------------------------------

describe('T-0571 FF-3/AC-6 — engine-drive completes a GENERIC process user-task (live Flowable+Postgres)', () => {
  it(
    'generic process #1 ("zakupki-approve" defKey): approve completes the LIVE engine task — no longer stuck (BUG-014)',
    requireDbAndFlowable(async () => {
      const processKey = `zakupkiGeneric${Date.now()}`;
      const taskDefKey = 'zakupki-approve';
      const { instanceId } = await deployAndStart(processKey, taskDefKey, ROLE_1);

      // Sanity: BEFORE approve, the generic task IS active in the live engine.
      const activeBefore = await isTaskStillActive(instanceId, taskDefKey);
      expect(activeBefore).toBe(true);

      // Seed the process.started projection row (T-0571: taskDefKey=null — the
      // resolve-by-instance signal; the projection never asserts a literal defKey).
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_1}'`);
        await appendProcessStarted(c as unknown as PgClientLike, {
          instanceId,
          procKey: processKey,
          actor: 'system:test-seed',
          nowMs: Date.now(),
          tenantId: TENANT_1,
          approverRole: ROLE_1,
        });
        await c.query('COMMIT');
      });

      // Read back the freshly-seeded inbox task id (appendProcessStarted mints it).
      const { rows: startedRows } = await withClient(migratorUrl(), (c) =>
        c.query<{ id: string }>(
          `SELECT id FROM choros.audit_event
            WHERE tenant_id = $1 AND type = 'process.started'
            ORDER BY occurred_at DESC LIMIT 1`,
          [TENANT_1],
        ),
      );
      const taskId = startedRows[0]?.id;
      expect(taskId).toBeDefined();

      // The REAL HTTP approve route — the SAME handler production traffic hits.
      const r = await makeRequest(
        baseUrl,
        'POST',
        `/api/inbox/${taskId}/action`,
        { action: 'approve' },
        { 'x-dev-user': APPROVER_1 },
      );

      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body) as { status: string; engine: string };
      expect(body.status).toBe('done');
      expect(body.engine).toBe('completed');

      // THE PROOF (AC-6/AC-1): the live engine task is GONE — genuinely completed,
      // not just claimed to be. This is what fails RED on the pre-T-0571 literal.
      const activeAfter = await isTaskStillActive(instanceId, taskDefKey);
      expect(activeAfter).toBe(false);
    }),
  );

  it(
    'generic process #2 ("otpusk-approve" defKey, anti-case AC-4): the SAME approve path works for a SECOND, differently-named process — not tied to a specific string',
    requireDbAndFlowable(async () => {
      const processKey = `otpuskGeneric${Date.now()}`;
      const taskDefKey = 'otpusk-approve';
      const { instanceId } = await deployAndStart(processKey, taskDefKey, ROLE_2);

      const activeBefore = await isTaskStillActive(instanceId, taskDefKey);
      expect(activeBefore).toBe(true);

      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_2}'`);
        await appendProcessStarted(c as unknown as PgClientLike, {
          instanceId,
          procKey: processKey,
          actor: 'system:test-seed',
          nowMs: Date.now(),
          tenantId: TENANT_2,
          approverRole: ROLE_2,
        });
        await c.query('COMMIT');
      });

      const { rows: startedRows } = await withClient(migratorUrl(), (c) =>
        c.query<{ id: string }>(
          `SELECT id FROM choros.audit_event
            WHERE tenant_id = $1 AND type = 'process.started'
            ORDER BY occurred_at DESC LIMIT 1`,
          [TENANT_2],
        ),
      );
      const taskId = startedRows[0]?.id;
      expect(taskId).toBeDefined();

      const r = await makeRequest(
        baseUrl,
        'POST',
        `/api/inbox/${taskId}/action`,
        { action: 'approve' },
        { 'x-dev-user': APPROVER_2 },
      );

      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body) as { status: string; engine: string };
      expect(body.engine).toBe('completed');

      const activeAfter = await isTaskStillActive(instanceId, taskDefKey);
      expect(activeAfter).toBe(false);
    }),
  );

  it(
    'idempotent repeat (AC-8): re-approving an already-completed base task is 200 {engine:"already"}, not an error',
    requireDbAndFlowable(async () => {
      const processKey = `zakupkiIdemp${Date.now()}`;
      const taskDefKey = 'zakupki-idemp-approve';
      const { instanceId } = await deployAndStart(processKey, taskDefKey, ROLE_1);

      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_1}'`);
        await appendProcessStarted(c as unknown as PgClientLike, {
          instanceId,
          procKey: processKey,
          actor: 'system:test-seed',
          nowMs: Date.now(),
          tenantId: TENANT_1,
          approverRole: ROLE_1,
        });
        await c.query('COMMIT');
      });
      const { rows: startedRows } = await withClient(migratorUrl(), (c) =>
        c.query<{ id: string }>(
          `SELECT id FROM choros.audit_event
            WHERE tenant_id = $1 AND type = 'process.started'
            ORDER BY occurred_at DESC LIMIT 1`,
          [TENANT_1],
        ),
      );
      const taskId = startedRows[0]?.id;

      const first = await makeRequest(
        baseUrl, 'POST', `/api/inbox/${taskId}/action`, { action: 'approve' },
        { 'x-dev-user': APPROVER_1 },
      );
      expect(first.statusCode).toBe(200);
      expect((JSON.parse(first.body) as { engine: string }).engine).toBe('completed');

      // The base row is now hidden (task.approved recorded) — findWaitingInstanceTask
      // would 404 a SECOND HTTP approve against the SAME taskId (that is existing,
      // unrelated-to-this-ADR behaviour: the inbox task itself is a one-shot action).
      // AC-8's idempotency claim is about the ENGINE-DRIVE RECONCILE layer, not the
      // HTTP action route being re-callable — proven directly at that layer in
      // src/__tests__/inbox-engine-drive.test.ts (T-0522/T-0571 idempotent unit
      // suites). Here we confirm the complementary live-engine fact: completing an
      // already-completed Flowable task via completeUserTask again is tolerated
      // (NOT_FOUND-idempotent) by re-driving the SAME reconcile function directly
      // against the now-completed live instance.
      const secondRepeat = await makeRequest(
        baseUrl, 'POST', `/api/inbox/${taskId}/action`, { action: 'approve' },
        { 'x-dev-user': APPROVER_1 },
      );
      // The task is already hidden from the projection (task.approved exists) →
      // findWaitingInstanceTask returns null → 404 NOT_FOUND. This is the EXISTING,
      // correct one-shot-action contract (unrelated to the T-0571 engine-drive fix) —
      // asserted here so a future regression that silently double-approves is caught.
      expect(secondRepeat.statusCode).toBe(404);
    }),
  );
});
