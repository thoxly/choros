// T-0588 (FR-1) · claim-eligibility Tier-2 substitution — LIVE Postgres integration
// probe. Run in the `db` CI job / locally: DATABASE_URL=... npm run fitness:db
//
// WHY THIS EXISTS (spec §1.3 / ADR §"Дыра №1"): POST /api/inbox/:id/claim gated
// eligibility strictly on role_assignment (myRoles.includes(taskRole)). A Tier-2
// substitute (substitution_rule.ttl_grant_id SET — a TTL'd grant, NOT a
// role_assignment) got 403 NOT_ELIGIBLE despite an effective rule. This probe
// hits the REAL HTTP route (registerInboxRoutes, the same handler production
// traffic uses) against a REAL Postgres, proving:
//
//   AC-1 — a confirmed, in-window Tier-2 substitute CAN claim a pool task
//          addressed to the absent holder's role → 200, and the task.claimed
//          audit payload carries on_behalf_of = the absent holder's slug.
//   AC-2 — the SAME substitute is 403 NOT_ELIGIBLE when the rule is UNCONFIRMED
//          (confirmed_by IS NULL) or OUT OF WINDOW (valid_until in the past).
//   AC-11 (regression) — a plain role_assignment holder still claims their OWN
//          pool task → 200 with NO on_behalf_of key in the payload.
//
// No live engine/Flowable needed: the pool task is seeded via the SAME
// appendProcessStarted audit-event projection engine-drive-generic.db.test.ts
// and process-projection.test.ts use — listInstanceInboxTasks/findWaitingInstanceTask
// read this projection with taskDefKey=null (resolve-by-instance signal), which the
// claim route only needs to resolve the pool task's `id`/`role` — it never touches
// the engine on the claim path itself.
//
// Seeding goes through migratorUrl() (BYPASSRLS, mirrors grants-dao-dual-control.db.test.ts);
// the claim HTTP route runs through the module's own getOrgPool() (DATABASE_URL, same
// as migratorUrl() here) so the seeded rows are visible on the exact production read path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerInboxRoutes, type InboxWriteDeps } from '../../../src/http/inbox.js';
import { appendProcessStarted } from '../../../src/http/process-projection.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';

const hasDb = Boolean(process.env['DATABASE_URL']);

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
// Server (shared across this file's describe blocks)
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

beforeAll(async () => {
  if (!hasDb) return;

  appPool = new pg.Pool({ connectionString: appUrl() });
  const router = new Router();
  const writeDeps: InboxWriteDeps = {
    pool: appPool,
    resolveActorTenant: async () => {
      throw new Error('unused — the claim route resolves tenant via db/org.ts resolveActorTenant against the real employee table');
    },
    // no flowableClient: the claim path never touches the engine.
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
});

afterAll(async () => {
  if (!hasDb) return;
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Seed helpers — ALL run against the migrator (BYPASSRLS) connection, mirroring
// grants-dao-dual-control.db.test.ts. The claim HTTP route reads through
// getOrgPool() which resolves DATABASE_URL (the SAME migrator credentials in
// this local/CI setup), so seeded rows are visible on the real read path.
// ---------------------------------------------------------------------------

type EmpFx = { id: string; slug: string };

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t0588-claim-${tenantId.slice(0, 8)}`],
  );
}

async function seedEmployee(c: pg.Client, tenantId: string, slug: string): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [tenantId, deptId, `t0588-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [tenantId, posId, deptId, `t0588-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0)`,
    [tenantId, empId, posId, slug],
  );
  return { id: empId, slug };
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

async function seedAssignment(
  c: pg.Client,
  tenantId: string,
  args: { empId: string; roleId: string },
): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             NULL, 'seed', NULL, 0, 0)`,
    [
      tenantId, uuid(), args.empId, args.roleId,
      JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' }),
    ],
  );
}

/** Tier-2 mint: a TTL'd grant row + a substitution_rule with ttl_grant_id SET. */
async function seedTier2Grant(c: pg.Client, tenantId: string, roleId: string): Promise<string> {
  const grantId = uuid();
  const scope = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable, granted_by,
        valid_from, valid_until, created_at,
        proposed_by, confirmed_by, confirmed2_by)
     VALUES ($1, $2, $3, 'mcp://record.x', NULL,
             'read', $4::jsonb, NULL, false, 'seed',
             NULL, NULL, 0,
             'seed', 'seed', NULL)`,
    [tenantId, grantId, roleId, scope],
  );
  return grantId;
}

async function seedSubstitutionRule(
  c: pg.Client,
  tenantId: string,
  args: {
    absentEmpId: string;
    substituteEmpId: string;
    roleId: string;
    ttlGrantId: string | null;
    confirmed: boolean;
    validFrom?: number | null;
    validUntil?: number | null;
  },
): Promise<string> {
  const id = uuid();
  const scope = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });
  await c.query(
    `INSERT INTO choros.substitution_rule
       (tenant_id, id, absent_employee_id, substitute_employee_id, role_id, org_scope,
        ttl_grant_id, non_inheritable_excluded, proposed_by, confirmed_by,
        valid_from, valid_until, source, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb,
             $7, TRUE, $8, $9,
             $10, $11, 'manual', 'seed', 0, 0)`,
    [
      tenantId, id, args.absentEmpId, args.substituteEmpId, args.roleId, scope,
      args.ttlGrantId,
      args.confirmed ? null : 'seed', // proposed_by set only when NOT confirmed (mirrors write-path shape)
      args.confirmed ? 'seed' : null,
      args.validFrom ?? null,
      args.validUntil ?? null,
    ],
  );
  return id;
}

/** Seed a pool task via the audit-event projection (migrator connection, no engine needed). */
async function seedPoolTask(
  c: pg.Client,
  tenantId: string,
  roleSlug: string,
): Promise<string> {
  return appendProcessStarted(c as unknown as PgClientLike, {
    instanceId: uuid(),
    procKey: `t0588-proc-${uuid().slice(0, 6)}`,
    actor: 'system:test-seed',
    nowMs: Date.now(),
    approverRole: roleSlug,
    tenantId,
  });
}

/** Read back the task.claimed audit_event payload for a given taskId (migrator connection). */
async function readClaimedPayload(taskId: string): Promise<Record<string, unknown> | undefined> {
  const c = new pg.Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    await c.query('SET search_path TO choros;');
    const { rows } = await c.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM choros.audit_event
        WHERE type = 'task.claimed' AND payload->>'task_id' = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [taskId],
    );
    return rows[0]?.payload;
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------------------
// AC-1 — Tier-2 substitute claims a pool task addressed to the absent holder's role
// ---------------------------------------------------------------------------

describe('T-0588 AC-1 — Tier-2 substitute can claim a pool task (was 403, now 200)', () => {
  it('confirmed in-window Tier-2 rule → substitute claims 200, payload.on_behalf_of = absent holder slug', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const roleSlug = `t0588-role-ac1-${uuid().slice(0, 6)}`;
    const absentSlug = `t0588-absent-ac1-${uuid().slice(0, 6)}`;
    const substituteSlug = `t0588-sub-ac1-${uuid().slice(0, 6)}`;
    let taskId = '';

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const absent = await seedEmployee(c, tenantId, absentSlug);
      const substitute = await seedEmployee(c, tenantId, substituteSlug);
      // Absent holder holds the role via role_assignment (Tier-2 mint precondition:
      // pool had a holder at rule-creation time). Substitute does NOT get a
      // role_assignment on this role — only the TTL'd grant + substitution_rule.
      await seedAssignment(c, tenantId, { empId: absent.id, roleId });
      const grantId = await seedTier2Grant(c, tenantId, roleId);
      await seedSubstitutionRule(c, tenantId, {
        absentEmpId: absent.id,
        substituteEmpId: substitute.id,
        roleId,
        ttlGrantId: grantId,
        confirmed: true,
        validFrom: null,
        validUntil: null, // open-ended — definitely in-window
      });
      taskId = await seedPoolTask(c, tenantId, roleSlug);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    const resp = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': substituteSlug,
    });

    expect(resp.statusCode).toBe(200);

    const payload = await readClaimedPayload(taskId);
    expect(payload).toBeDefined();
    expect(payload!['on_behalf_of']).toBe(absentSlug);
  });
});

// ---------------------------------------------------------------------------
// AC-2 — regression guard: unconfirmed / expired rule → still 403
// ---------------------------------------------------------------------------

describe('T-0588 AC-2 — unconfirmed or expired Tier-2 rule does NOT grant claim (403 regression guard)', () => {
  it('UNCONFIRMED rule (confirmed_by IS NULL) → substitute gets 403 NOT_ELIGIBLE', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const roleSlug = `t0588-role-ac2a-${uuid().slice(0, 6)}`;
    const absentSlug = `t0588-absent-ac2a-${uuid().slice(0, 6)}`;
    const substituteSlug = `t0588-sub-ac2a-${uuid().slice(0, 6)}`;
    let taskId = '';

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const absent = await seedEmployee(c, tenantId, absentSlug);
      const substitute = await seedEmployee(c, tenantId, substituteSlug);
      await seedAssignment(c, tenantId, { empId: absent.id, roleId });
      const grantId = await seedTier2Grant(c, tenantId, roleId);
      await seedSubstitutionRule(c, tenantId, {
        absentEmpId: absent.id,
        substituteEmpId: substitute.id,
        roleId,
        ttlGrantId: grantId,
        confirmed: false, // PROPOSAL ONLY — zero capability per T-0035 contract
      });
      taskId = await seedPoolTask(c, tenantId, roleSlug);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    const resp = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': substituteSlug,
    });

    expect(resp.statusCode).toBe(403);
    expect(JSON.parse(resp.body).error.code).toBe('NOT_ELIGIBLE');
  });

  it('EXPIRED rule (valid_until in the past) → substitute gets 403 NOT_ELIGIBLE', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const roleSlug = `t0588-role-ac2b-${uuid().slice(0, 6)}`;
    const absentSlug = `t0588-absent-ac2b-${uuid().slice(0, 6)}`;
    const substituteSlug = `t0588-sub-ac2b-${uuid().slice(0, 6)}`;
    const PAST = 1_000; // epoch-ms far in the past — definitely < Date.now()
    let taskId = '';

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const absent = await seedEmployee(c, tenantId, absentSlug);
      const substitute = await seedEmployee(c, tenantId, substituteSlug);
      await seedAssignment(c, tenantId, { empId: absent.id, roleId });
      const grantId = await seedTier2Grant(c, tenantId, roleId);
      await seedSubstitutionRule(c, tenantId, {
        absentEmpId: absent.id,
        substituteEmpId: substitute.id,
        roleId,
        ttlGrantId: grantId,
        confirmed: true,
        validFrom: null,
        validUntil: PAST, // expired
      });
      taskId = await seedPoolTask(c, tenantId, roleSlug);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    const resp = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': substituteSlug,
    });

    expect(resp.statusCode).toBe(403);
    expect(JSON.parse(resp.body).error.code).toBe('NOT_ELIGIBLE');
  });
});

// ---------------------------------------------------------------------------
// AC-11 (regression) — plain role_assignment holder still claims own task,
// 200, WITHOUT an on_behalf_of key in the payload.
// ---------------------------------------------------------------------------

describe('T-0588 AC-11 — regression: plain role-assignment claim is unaffected (no on_behalf_of)', () => {
  it('holder with a normal role_assignment claims their own pool task → 200, no on_behalf_of key', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const roleSlug = `t0588-role-regr-${uuid().slice(0, 6)}`;
    const holderSlug = `t0588-holder-regr-${uuid().slice(0, 6)}`;
    let taskId = '';

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const holder = await seedEmployee(c, tenantId, holderSlug);
      await seedAssignment(c, tenantId, { empId: holder.id, roleId });
      taskId = await seedPoolTask(c, tenantId, roleSlug);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    const resp = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': holderSlug,
    });

    expect(resp.statusCode).toBe(200);

    const payload = await readClaimedPayload(taskId);
    expect(payload).toBeDefined();
    expect(payload!['on_behalf_of']).toBeUndefined();
    expect('on_behalf_of' in payload!).toBe(false);
  });
});
