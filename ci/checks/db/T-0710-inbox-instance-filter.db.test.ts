// ci/checks/db/T-0710-inbox-instance-filter.db.test.ts
//
// T-0710 [E16, capstone T-0691 P2, bug #2] — live-DB probe for
// "GET /api/inbox?instance=<id> is ignored (does not narrow the list)".
//
// TWO things are proven here, both required for the fix to be "honest" rather
// than a post-fetch filter over an already-truncated page:
//
//   1. SQL-level honesty (listInstanceInboxTasks / readEvents): the instance
//      filter is pushed into the SQL WHERE clause, so a task belonging to an
//      instance whose base process.started row falls OUTSIDE the naive
//      "ORDER BY occurred_at ASC LIMIT N" window (a tenant with more than N
//      process.started rows) is STILL found — a post-fetch-only filter over the
//      LIMIT-capped page would silently return nothing for it.
//
//   2. Route-level wiring (GET /api/inbox?instance=<id>): the query param is
//      actually read and narrows the response — before this fix it was parsed
//      nowhere (findInboxItems ran BEFORE the query was even parsed) and simply
//      discarded.
//
// Run: DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db -- T-0710-inbox-instance-filter

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerInboxRoutes } from '../../../src/http/inbox.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';
import { appendProcessStarted, listInstanceInboxTasks } from '../../../src/http/process-projection.js';

const { Client } = pg;
const hasDb = Boolean(process.env['DATABASE_URL']);
const PROC_KEY = 'proc-t0710-fixture';

function freshTenant(): string {
  return crypto.randomUUID();
}

async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: PgClientLike) => Promise<T>,
): Promise<T> {
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

// ---------------------------------------------------------------------------
// Part 1 — SQL-level honesty (no HTTP, direct function call, small controlled
// `limit` so the test does not need to seed hundreds of rows).
// ---------------------------------------------------------------------------

describe('T-0710 bug #2 (SQL honesty) — listInstanceInboxTasks({instanceId}) finds a task OUTSIDE the naive LIMIT window', () => {
  it('unscoped read with a small limit drops the target instance (sanity: the truncation is real); scoped read finds it regardless', async () => {
    if (!hasDb) return;
    const tenantId = freshTenant();
    const t0 = Date.now();

    // 4 unrelated (OLDER) instances + 1 target (NEWEST). readEvents orders
    // occurred_at ASC LIMIT N, so with limit=3 the oldest 3 unrelated rows fill
    // the window and the target (newest) falls outside it.
    const unrelatedIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const instanceId = uuid();
      unrelatedIds.push(instanceId);
      await withTenantTx(tenantId, (tx) =>
        appendProcessStarted(tx, {
          instanceId,
          procKey: PROC_KEY,
          actor: 'e-t0710-initiator',
          nowMs: t0 + i, // oldest
        }),
      );
    }
    const targetInstanceId = uuid();
    await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, {
        instanceId: targetInstanceId,
        procKey: PROC_KEY,
        actor: 'e-t0710-initiator',
        nowMs: t0 + 1_000, // newest — outside a LIMIT=3 oldest-first window
      }),
    );

    const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
    try {
      // Sanity: WITHOUT the instance scope and a tight limit, the target is
      // genuinely truncated out — proves the LIMIT-window trap this fix defeats
      // is real, not a hypothetical.
      const unscoped = await listInstanceInboxTasks(pool, tenantId, { limit: 3 });
      expect(unscoped.some((t) => t.inst === targetInstanceId)).toBe(false);

      // THE FIX: scoping by instanceId pushes the filter into the SQL WHERE
      // clause — the target is found regardless of the limit / how many other
      // instances exist for this tenant.
      const scoped = await listInstanceInboxTasks(pool, tenantId, { limit: 3, instanceId: targetInstanceId });
      expect(scoped.length).toBe(1);
      expect(scoped[0]!.inst).toBe(targetInstanceId);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2 — route-level wiring (GET /api/inbox?instance=<id> actually narrows).
// ---------------------------------------------------------------------------

type EmpFx = { id: string; slug: string; deptId: string };

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t0710-inbox-${tenantId.slice(0, 8)}`],
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

describe('T-0710 bug #2 (route) — GET /api/inbox?instance=<id> narrows the list to that instance', () => {
  it('two instance-backed waiting tasks for the SAME actor/role — filtering by one instance excludes the other', async () => {
    if (!hasDb) return;
    const tenantId = uuid();
    const roleSlug = `t0710-role-${uuid().slice(0, 6)}`;
    const holderSlug = `t0710-holder-${uuid().slice(0, 6)}`;

    const c = new Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const holder = await seedEmployee(c, tenantId, holderSlug, 'Т-0710 Держатель');
      await seedAssignment(c, tenantId, { empId: holder.id, roleId });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    const instanceA = uuid();
    const instanceB = uuid();
    await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, { instanceId: instanceA, procKey: PROC_KEY, actor: 'e-t0710-initiator', nowMs: Date.now(), approverRole: roleSlug, step: 'step-a' }),
    );
    await withTenantTx(tenantId, (tx) =>
      appendProcessStarted(tx, { instanceId: instanceB, procKey: PROC_KEY, actor: 'e-t0710-initiator', nowMs: Date.now(), approverRole: roleSlug, step: 'step-b' }),
    );

    // Unscoped: both instances' tasks are present.
    const allRes = await makeRequest(baseUrl, 'GET', '/api/inbox', { 'x-dev-user': holderSlug });
    expect(allRes.statusCode, allRes.body).toBe(200);
    const all = JSON.parse(allRes.body) as { items: Array<Record<string, unknown>> };
    expect(all.items.some((i) => i['inst'] === instanceA)).toBe(true);
    expect(all.items.some((i) => i['inst'] === instanceB)).toBe(true);

    // THE FIX: ?instance=<A> narrows to ONLY instance A's task.
    const scopedRes = await makeRequest(baseUrl, 'GET', `/api/inbox?instance=${instanceA}`, { 'x-dev-user': holderSlug });
    expect(scopedRes.statusCode, scopedRes.body).toBe(200);
    const scoped = JSON.parse(scopedRes.body) as { items: Array<Record<string, unknown>> };
    expect(scoped.items.length).toBeGreaterThan(0);
    expect(scoped.items.every((i) => i['inst'] === instanceA)).toBe(true);
    expect(scoped.items.some((i) => i['inst'] === instanceB)).toBe(false);
  });
});
