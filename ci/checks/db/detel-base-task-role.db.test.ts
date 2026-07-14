// T-0575 [W1/деТЭЛ] BUG-015 — FF-2 (AC-1, AC-2, AC-4): LIVE Flowable + LIVE
// Postgres integration proof that the BASE (`process.started`) inbox task of a
// GENERIC process carries the REAL `candidateGroups[0]`/`name` of its BPMN
// user-task, read from the live engine at start time — NOT the process-agnostic
// ТЭЛ constants (`role-approver` / "Согласование" / "Согласовать заявку") — the
// exact defect class ADR-T0575-detel-primitives.md §2.1 fixes.
//
// Run in the `db` lane locally (requires BOTH a live Postgres AND a live
// Flowable — this test SKIPS gracefully when either is absent, mirroring
// ci/checks/db/engine-drive-generic.db.test.ts):
//
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   FLOWABLE_PORT=8082 FLOWABLE_REST_APP_ADMIN_PASSWORD=choros_flowable_dev_pw \
//   npm run fitness:db
//
// WHAT THIS PROVES (AC-1 / AC-2 / AC-4 exactly):
//   1. Deploy a GENERIC BPMN whose FIRST (and only) user-task has
//      candidateGroups AND name DIFFERENT from "role-approver" /
//      "Согласование" / "Согласовать заявку" (deliberately, D-064 anti-case).
//   2. Start the instance via the EXPLICIT launcher path (POST
//      /api/processes/start — process-start.ts, the OTHER call site BUG-015
//      touches besides records.ts on_create).
//   3. Read back the process.started audit_event payload and assert
//      task_role == the REAL candidateGroups[0], task_name/task_step == the
//      REAL BPMN user-task name — NOT the ТЭЛ literals (AC-4: exact assertion
//      on the payload fields appendProcessStarted writes).
//   4. Anti-case (AC-4 unit-equiv / D-064): repeat with a SECOND generic
//      process using different role/name values — proves the fix is not keyed
//      off any specific string.
//   5. Regression (frozen ТЭЛ path, AC-8 companion — not re-asserted here,
//      covered by ci/checks/flowable/tel-linear-smoke.sh + e2e/journeys):
//      when the engine has NO active user-task yet (or is unreachable), the
//      payload still falls back to the config-primitive default
//      (resolveDefaultApproverRole/Step/TaskName) — proven at the unit level
//      by src/__tests__/process-start.test.ts (appendProcessStarted's own ??
//      fallback) and not re-proven against live infra here.
//
// RED on the pre-T-0575 code: process-start.ts calls appendProcessStarted
// WITHOUT approverRole/step/taskName → the payload ALWAYS carries the constants
// regardless of the BPMN's real candidateGroups/name. GREEN after the fix:
// process-start.ts reads flowable.getActiveUserTasks(instanceId) BEFORE calling
// appendProcessStarted and passes the resolved values through.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerProcessesRoutes } from '../../../src/http/processes.js';
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
// Minimal generic BPMN — deliberately NOT tel-linear.bpmn20.xml (D-064 anti-
// case): candidateGroups and the user-task NAME are both caller-supplied,
// intentionally distinct from role-approver/Согласование/Согласовать заявку.
// ---------------------------------------------------------------------------

function genericSingleTaskBpmn(processKey: string, taskName: string, role: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://choros.io/bpmn">
  <process id="${processKey}" name="Generic ${processKey}" isExecutable="true">
    <startEvent id="start"/>
    <sequenceFlow id="f1" sourceRef="start" targetRef="the-task"/>
    <userTask id="the-task" name="${taskName}" flowable:candidateGroups="${role}"/>
    <sequenceFlow id="f2" sourceRef="the-task" targetRef="end"/>
    <endEvent id="end"/>
  </process>
</definitions>`;
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
const ACTOR = 'detel-base-task-actor';

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
  const router = new Router();
  registerProcessesRoutes(router, undefined, {
    pool: appPool,
    resolveActorTenant: stubResolveActorTenant,
    flowable: makeFlowableClient({
      baseUrl: FLOWABLE_BASE_URL,
      adminUser: FLOWABLE_ADMIN_USER,
      adminPassword: FLOWABLE_ADMIN_PASSWORD,
    }),
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

async function readProcessStartedPayload(
  tenantId: string,
  instanceId: string,
): Promise<{ task_role?: string; task_step?: string; task_name?: string }> {
  const res = await withClient(migratorUrl(), (c) =>
    c.query<{ payload: { task_role?: string; task_step?: string; task_name?: string } }>(
      `SELECT payload FROM choros.audit_event
        WHERE tenant_id = $1 AND type = 'process.started' AND payload->>'inst' = $2
        ORDER BY occurred_at DESC LIMIT 1`,
      [tenantId, instanceId],
    ),
  );
  const payload = res.rows[0]?.payload;
  if (!payload) throw new Error(`no process.started audit event found for instance ${instanceId}`);
  return payload;
}

describe('T-0575 FF-2/AC-1/AC-2/AC-4 — base task role/label from live candidateGroups[0]/name (live Flowable+Postgres)', () => {
  it(
    'generic process #1: process.started payload carries the REAL candidateGroups[0]/name — not role-approver/Согласование',
    requireDbAndFlowable(async () => {
      const processKey = `detelBaseTask1_${Date.now()}`;
      const role = 'role-zakupki-owner';
      const taskName = 'Просмотреть заявку на закупку';

      const flowableClient = makeFlowableClient({
        baseUrl: FLOWABLE_BASE_URL,
        adminUser: FLOWABLE_ADMIN_USER,
        adminPassword: FLOWABLE_ADMIN_PASSWORD,
      });
      const deployResult = await flowableClient.deployBpmn(genericSingleTaskBpmn(processKey, taskName, role));
      expect(deployResult.ok).toBe(true);

      const r = await makeRequest(
        baseUrl,
        'POST',
        '/api/processes/start',
        { processKey },
        { 'x-dev-user': ACTOR, 'x-tenant-id': TENANT_ID },
      );
      expect(r.statusCode).toBe(201);
      const started = JSON.parse(r.body) as { instanceId: string };

      const payload = await readProcessStartedPayload(TENANT_ID, started.instanceId);

      // THE PROOF (AC-1/AC-2/AC-4): real candidateGroups[0]/name — not the
      // ТЭЛ-agnostic constants (role-approver / Согласование / Согласовать заявку).
      expect(payload.task_role).toBe(role);
      expect(payload.task_name).toBe(taskName);
      expect(payload.task_step).toBe(taskName);
      expect(payload.task_role).not.toBe('role-approver');
      expect(payload.task_name).not.toBe('Согласовать заявку');
      expect(payload.task_step).not.toBe('Согласование');
    }),
  );

  it(
    'generic process #2 (anti-case, D-064): a SECOND process with DIFFERENT role/name values also resolves correctly — not tied to a specific string',
    requireDbAndFlowable(async () => {
      const processKey = `detelBaseTask2_${Date.now()}`;
      const role = 'role-otpusk-hr';
      const taskName = 'Рассмотреть заявление на отпуск';

      const flowableClient = makeFlowableClient({
        baseUrl: FLOWABLE_BASE_URL,
        adminUser: FLOWABLE_ADMIN_USER,
        adminPassword: FLOWABLE_ADMIN_PASSWORD,
      });
      const deployResult = await flowableClient.deployBpmn(genericSingleTaskBpmn(processKey, taskName, role));
      expect(deployResult.ok).toBe(true);

      const r = await makeRequest(
        baseUrl,
        'POST',
        '/api/processes/start',
        { processKey },
        { 'x-dev-user': ACTOR, 'x-tenant-id': TENANT_ID },
      );
      expect(r.statusCode).toBe(201);
      const started = JSON.parse(r.body) as { instanceId: string };

      const payload = await readProcessStartedPayload(TENANT_ID, started.instanceId);

      expect(payload.task_role).toBe(role);
      expect(payload.task_name).toBe(taskName);
      expect(payload.task_step).toBe(taskName);
    }),
  );
});
