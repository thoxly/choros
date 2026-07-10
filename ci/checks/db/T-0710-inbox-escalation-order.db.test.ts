// ci/checks/db/T-0710-inbox-escalation-order.db.test.ts
//
// T-0710 [E16, capstone T-0691 P2, bug #3] — live-DB / HTTP-route probe:
// GET /api/inbox's DEFAULT ordering puts a genuine (non-escalated) approver-
// waiting task ahead of an agent escalation (defer row), end to end through the
// real route + a real Postgres. The pure-function proof lives in
// src/__tests__/inbox-escalation-order.test.ts (stableSortEscalatedLast); this
// file proves the wiring — the route actually applies it to a real merged
// (defer + instance) response.
//
// Run: DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db -- T-0710-inbox-escalation-order

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerInboxRoutes } from '../../../src/http/inbox.js';
import { makePgAuditWriter } from '../../../src/db/audit-writer.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';
import type { AuditEventInput } from '../../../src/core/audit-grant-encoder.js';
import { appendProcessStarted } from '../../../src/http/process-projection.js';

const { Client } = pg;
const hasDb = Boolean(process.env['DATABASE_URL']);
const writer = makePgAuditWriter();
const PROC_KEY = 'proc-t0710-fixture';

async function withTenantTx<T>(tenantId: string, fn: (tx: PgClientLike) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query('SET LOCAL search_path TO choros');
    const result = await fn(c as unknown as PgClientLike);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

type EmpFx = { id: string; slug: string; deptId: string };

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t0710-order-${tenantId.slice(0, 8)}`],
  );
}

async function seedEmployee(c: pg.Client, tenantId: string, slug: string, displayName: string): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [tenantId, deptId, `t0710-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [tenantId, posId, deptId, `t0710-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'human', $4, $5, 0, 0)`,
    [tenantId, empId, posId, slug, displayName],
  );
  return { id: empId, slug, deptId };
}

async function seedRole(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 0, 0)`,
    [tenantId, id, slug],
  );
  return id;
}

async function seedAssignment(c: pg.Client, tenantId: string, args: { empId: string; roleId: string }): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until, source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'seed', 'seed', NULL, 'seed', 0, 0)`,
    [tenantId, uuid(), args.empId, args.roleId, JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' })],
  );
}

/** Seed ONE agent.deferred (escalation) audit event addressed to `deferRole`. */
async function seedDeferEvent(c: pg.Client, opts: { taskId: string; agentEmployeeId: string; deferRole: string }): Promise<void> {
  const input: AuditEventInput = {
    id: opts.taskId,
    type: 'agent.deferred',
    actor: opts.agentEmployeeId,
    subject: `agent:${opts.agentEmployeeId}`,
    scope: { proc_key: PROC_KEY, signal: 'dormant', via: 'agent-dispatch' },
    via: 'agent-dispatch',
    proposed_by: null,
    confirmed_by: null,
    payload: {
      doubt_reason: 'T-0710 fixture escalation',
      signal: 'dormant',
      inbox_task_id: opts.taskId,
      instance_id: null,
      proc_key: PROC_KEY,
      defer_role: opts.deferRole,
      defer_sla_minutes: null,
      defer_name: 'Проверить: T-0710 fixture escalation',
      agent_draft: null,
    },
    occurred_at: Date.now(),
  };
  await writer.appendAuditEvent(c as unknown as PgClientLike, input);
}

function makeRequest(baseUrl: string, method: string, path: string, extraHeaders: Record<string, string> = {}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers: extraHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  if (!hasDb) return;
  const router = new Router();
  registerInboxRoutes(router);
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (!hasDb) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('T-0710 bug #3 (route) — GET /api/inbox default order: approver-waiting task ranks ahead of an escalation', () => {
  it('a genuine (non-escalated) instance task appears BEFORE an agent-deferred escalation, though the escalation was written FIRST', async () => {
    if (!hasDb) return;
    const tenantId = uuid();
    const roleSlug = `t0710-role-order-${uuid().slice(0, 6)}`;
    const holderSlug = `t0710-holder-order-${uuid().slice(0, 6)}`;

    const c = new Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const holder = await seedEmployee(c, tenantId, holderSlug, 'Т-0710 Держатель порядка');
      await seedAssignment(c, tenantId, { empId: holder.id, roleId });
      // Escalation written FIRST (older occurred_at) — under the pre-fix merge
      // order (defer rows always first) it would rank first by construction
      // regardless of age. The instance task is written SECOND (newer).
      await seedDeferEvent(c, { taskId: uuid(), agentEmployeeId: `agent-t0710-${uuid().slice(0, 6)}`, deferRole: roleSlug });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    const instanceId = uuid();
    await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: PROC_KEY,
        actor: 'e-t0710-initiator',
        nowMs: Date.now(),
        approverRole: roleSlug,
        step: 'step-t0710-order',
      }),
    );

    const res = await makeRequest(baseUrl, 'GET', '/api/inbox', { 'x-dev-user': holderSlug });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { items: Array<Record<string, unknown>> };

    const escIdx = body.items.findIndex((i) => i['escalated'] === true);
    const plainIdx = body.items.findIndex((i) => i['inst'] === instanceId);
    expect(escIdx).toBeGreaterThanOrEqual(0);
    expect(plainIdx).toBeGreaterThanOrEqual(0);
    // THE FIX: the non-escalated approver-waiting task ranks BEFORE the
    // escalation in the default (no `sort=`) response, though the escalation
    // was written first.
    expect(plainIdx).toBeLessThan(escIdx);
  });

  it('?sort=sla is untouched — an overdue escalation still sorts first under an explicit urgency request', async () => {
    if (!hasDb) return;
    const tenantId = uuid();
    const roleSlug = `t0710-role-sla-${uuid().slice(0, 6)}`;
    const holderSlug = `t0710-holder-sla-${uuid().slice(0, 6)}`;

    const c = new Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const holder = await seedEmployee(c, tenantId, holderSlug, 'Т-0710 Держатель SLA');
      await seedAssignment(c, tenantId, { empId: holder.id, roleId });
      await seedDeferEvent(c, { taskId: uuid(), agentEmployeeId: `agent-t0710-${uuid().slice(0, 6)}`, deferRole: roleSlug });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    const instanceId = uuid();
    await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: PROC_KEY,
        actor: 'e-t0710-initiator',
        nowMs: Date.now(),
        approverRole: roleSlug,
        step: 'step-t0710-sla',
      }),
    );

    // Explicit urgency sort: defer rows use a 60-min default SLA (deferred-inbox-
    // store.ts), instance tasks default to 240-min (inbox.ts baseItems) — the
    // defer/escalation row has LESS headroom, so sort=sla ranks it first. This
    // is the operator's own explicit choice and must be unaffected by T-0710.
    const res = await makeRequest(baseUrl, 'GET', '/api/inbox?sort=sla', { 'x-dev-user': holderSlug });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { items: Array<Record<string, unknown>> };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.items[0]!['escalated']).toBe(true);
  });
});
