// T-0744 (в1 + в2) · orphaned-role routing + owner-claim — LIVE Postgres probe.
// Run: DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros
//      npx vitest run ci/checks/db/T-0744-orphaned-role-owner-claim.db.test.ts
//
// WHY (ADR docs/tasks/T-0729.assessment.md §2.4/§2.6/§3-в): a Tier-1 stand-in who
// does NOT personally hold the role used to MASK an emptied covering pool (routing
// added them unconditionally) while the claim-gate rejected them (403) — the task
// wedged and never fell to the owner (routed_to_fallback was display-only). T-0744
// makes routing agree with the claim-gate (computeEffectivePool over the coverage
// invariant) AND lets the tenant owner claim/approve the genuinely-orphaned task.
//
// These probes hit the REAL HTTP routes (registerInboxRoutes — GET /api/inbox,
// POST :id/claim, POST :id/action) against a REAL Postgres, proving:
//   (a) Tier-1 NON-holder substitute + emptied pool → GET marks the task
//       routed_to_fallback:"role_unfilled" (role honestly unfilled, not masked).
//   (b) the genesis tenant-owner CLAIMS that orphaned task → 200 (was 403), with
//       NO on_behalf_of (owner acts as themselves), and APPROVES → 200 done.
//   (c) regressions — the owner may take ONLY an orphaned task:
//       (c1) Tier-1 substitute who IS a co-holder → pool covered → NOT fallback,
//            owner-claim 403, the co-holder substitute claims 200.
//       (c2) a live role holder present → NOT fallback, owner-claim 403, holder 200.
//       (c3) Tier-2 substitute → pool covered by the substitute → NOT fallback,
//            owner-claim 403 (substitute still claims via T-0588 AC-1).
//
// Seeding via migratorUrl() (BYPASSRLS, mirrors inbox_claim_substitution.db.test.ts);
// the HTTP routes read through getOrgPool()/writeDeps.pool (both DATABASE_URL here).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerInboxRoutes, type InboxWriteDeps } from '../../../src/http/inbox.js';
import { appendProcessStarted } from '../../../src/http/process-projection.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';

const hasDb = Boolean(process.env['DATABASE_URL']);

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
// Server wired with a REAL resolveActorTenant (GET + claim + approve all served).
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
let pool: pg.Pool;

beforeAll(async () => {
  if (!hasDb) return;
  pool = new pg.Pool({ connectionString: migratorUrl() });
  const router = new Router();
  const { resolveActorTenant } = await import('../../../src/db/org.js');
  const writeDeps: InboxWriteDeps = {
    pool,
    resolveActorTenant: (actorSlug: string) => resolveActorTenant(pool, actorSlug),
    // no flowableClient/outboxStore: audit-only claim/approve is sufficient to
    // prove the authz gate + projection advance.
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
  if (pool) await pool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Seed helpers (mirror inbox_claim_substitution.db.test.ts — migrator/BYPASSRLS).
// ---------------------------------------------------------------------------

type EmpFx = { id: string; slug: string; deptId: string };

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t0744-${tenantId.slice(0, 8)}`],
  );
}

async function seedEmployee(c: pg.Client, tenantId: string, slug: string): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [tenantId, deptId, `t0744-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [tenantId, posId, deptId, `t0744-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0, NULL)`,
    [tenantId, empId, posId, slug],
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

/** Seed a genesis tenant-owner: the 'tenant-owner' role + a confirmed assignment. */
async function seedOwner(c: pg.Client, tenantId: string, slug: string): Promise<EmpFx> {
  const owner = await seedEmployee(c, tenantId, slug);
  const ownerRoleId = await seedRole(c, tenantId, 'tenant-owner');
  await seedAssignment(c, tenantId, { empId: owner.id, roleId: ownerRoleId });
  return owner;
}

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
  args: { absentEmpId: string; substituteEmpId: string; roleId: string; ttlGrantId: string | null },
): Promise<void> {
  const scope = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });
  await c.query(
    `INSERT INTO choros.substitution_rule
       (tenant_id, id, absent_employee_id, substitute_employee_id, role_id, org_scope,
        ttl_grant_id, non_inheritable_excluded, proposed_by, confirmed_by,
        valid_from, valid_until, source, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb,
             $7, TRUE, NULL, 'seed',
             NULL, NULL, 'manual', 'seed', 0, 0)`,
    [tenantId, uuid(), args.absentEmpId, args.substituteEmpId, args.roleId, scope, args.ttlGrantId],
  );
}

async function seedPoolTask(c: pg.Client, tenantId: string, roleSlug: string): Promise<string> {
  return appendProcessStarted(c as unknown as PgClientLike, {
    instanceId: uuid(),
    procKey: `t0744-proc-${uuid().slice(0, 6)}`,
    actor: 'system:test-seed',
    nowMs: Date.now(),
    approverRole: roleSlug,
    tenantId,
  });
}

/** Run a seed transaction (BEGIN + tenant GUC + commit). */
async function seedTx(tenantId: string, fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const c = new pg.Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    await c.query('SET search_path TO choros;');
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await fn(c);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    await c.end();
  }
}

/** GET /api/inbox?tab=all as `actorSlug`; return the item with the given id. */
async function getInboxItem(actorSlug: string, taskId: string): Promise<Record<string, unknown> | undefined> {
  const resp = await makeRequest(baseUrl, 'GET', '/api/inbox?tab=all', undefined, { 'x-dev-user': actorSlug });
  expect(resp.statusCode, resp.body).toBe(200);
  const parsed = JSON.parse(resp.body) as { items: Array<Record<string, unknown>> };
  return parsed.items.find((i) => i['id'] === taskId);
}

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
// (a)+(b) — Tier-1 non-holder + emptied pool → orphaned → owner claims + approves
// ---------------------------------------------------------------------------

describe('T-0744 (a)+(b) — Tier-1 non-holder + emptied pool → owner claims the orphaned task', () => {
  it('GET marks routed_to_fallback:role_unfilled; owner claims 200 (no on_behalf_of) and approves → done', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const roleSlug = `t0744-role-ab-${uuid().slice(0, 6)}`;
    const absentSlug = `t0744-absent-ab-${uuid().slice(0, 6)}`;
    const substituteSlug = `t0744-sub-ab-${uuid().slice(0, 6)}`;
    const ownerSlug = `t0744-owner-ab-${uuid().slice(0, 6)}`;
    let taskId = '';

    await seedTx(tenantId, async (c) => {
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const absent = await seedEmployee(c, tenantId, absentSlug); // the only holder, now absent
      const substitute = await seedEmployee(c, tenantId, substituteSlug); // NOT a holder
      await seedOwner(c, tenantId, ownerSlug);
      await seedAssignment(c, tenantId, { empId: absent.id, roleId });
      // Tier-1 rule (ttl_grant_id NULL): substitute does not hold the role. The
      // covering pool (any third holder) is gone → the role is now orphaned.
      await seedSubstitutionRule(c, tenantId, {
        absentEmpId: absent.id,
        substituteEmpId: substitute.id,
        roleId,
        ttlGrantId: null,
      });
      taskId = await seedPoolTask(c, tenantId, roleSlug);
    });

    // (a) routing: the role is honestly unfilled — NOT masked by the Tier-1 stand-in.
    const item = await getInboxItem(ownerSlug, taskId);
    expect(item, 'orphaned instance task must appear in the owner inbox').toBeDefined();
    expect(item!['routed_to_fallback']).toBe('role_unfilled');

    // (b) the Tier-1 non-holder substitute still CANNOT claim (claim-gate 403) —
    // proves the task was genuinely wedged for them (the deadlock).
    const subResp = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': substituteSlug,
    });
    expect(subResp.statusCode).toBe(403);
    expect(JSON.parse(subResp.body).error.code).toBe('NOT_ELIGIBLE');

    // (b) the OWNER claims the orphaned task → 200 (was 403 before T-0744).
    const ownerClaim = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': ownerSlug,
    });
    expect(ownerClaim.statusCode, ownerClaim.body).toBe(200);

    // Owner acts as themselves — NO on_behalf_of; claimer is the owner.
    const payload = await readClaimedPayload(taskId);
    expect(payload).toBeDefined();
    expect('on_behalf_of' in payload!).toBe(false);

    // Owner completes it end-to-end (claim→approve→done).
    const ownerApprove = await makeRequest(
      baseUrl,
      'POST',
      `/api/inbox/${taskId}/action`,
      { action: 'approve' },
      { 'x-dev-user': ownerSlug },
    );
    expect(ownerApprove.statusCode, ownerApprove.body).toBe(200);
    expect(JSON.parse(ownerApprove.body).status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// (c1) — Tier-1 substitute who IS a co-holder → coverage → NOT orphaned
// ---------------------------------------------------------------------------

describe('T-0744 (c1) regression — Tier-1 substitute who is a co-holder provides coverage', () => {
  it('NOT fallback-marked; owner-claim 403; the co-holder substitute claims 200', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const roleSlug = `t0744-role-c1-${uuid().slice(0, 6)}`;
    const absentSlug = `t0744-absent-c1-${uuid().slice(0, 6)}`;
    const coholderSlug = `t0744-coholder-c1-${uuid().slice(0, 6)}`;
    const ownerSlug = `t0744-owner-c1-${uuid().slice(0, 6)}`;
    let taskId = '';

    await seedTx(tenantId, async (c) => {
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const absent = await seedEmployee(c, tenantId, absentSlug);
      const coholder = await seedEmployee(c, tenantId, coholderSlug);
      await seedOwner(c, tenantId, ownerSlug);
      await seedAssignment(c, tenantId, { empId: absent.id, roleId });
      await seedAssignment(c, tenantId, { empId: coholder.id, roleId }); // substitute holds the role too
      await seedSubstitutionRule(c, tenantId, {
        absentEmpId: absent.id,
        substituteEmpId: coholder.id,
        roleId,
        ttlGrantId: null, // Tier-1, but the substitute is a confirmed co-holder
      });
      taskId = await seedPoolTask(c, tenantId, roleSlug);
    });

    const item = await getInboxItem(ownerSlug, taskId);
    expect(item).toBeDefined();
    expect('routed_to_fallback' in item!).toBe(false); // covered → not orphaned

    const ownerClaim = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': ownerSlug,
    });
    expect(ownerClaim.statusCode).toBe(403); // pool non-empty → owner may NOT grab it

    const coholderClaim = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': coholderSlug,
    });
    expect(coholderClaim.statusCode, coholderClaim.body).toBe(200); // holds the role → normal claim
    const payload = await readClaimedPayload(taskId);
    expect('on_behalf_of' in (payload ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c2) — a live role holder present → NOT orphaned
// ---------------------------------------------------------------------------

describe('T-0744 (c2) regression — a live role holder covers the pool', () => {
  it('NOT fallback-marked; owner-claim 403; the live holder claims 200', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const roleSlug = `t0744-role-c2-${uuid().slice(0, 6)}`;
    const holderSlug = `t0744-holder-c2-${uuid().slice(0, 6)}`;
    const ownerSlug = `t0744-owner-c2-${uuid().slice(0, 6)}`;
    let taskId = '';

    await seedTx(tenantId, async (c) => {
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const holder = await seedEmployee(c, tenantId, holderSlug);
      await seedOwner(c, tenantId, ownerSlug);
      await seedAssignment(c, tenantId, { empId: holder.id, roleId }); // no absence — plain live holder
      taskId = await seedPoolTask(c, tenantId, roleSlug);
    });

    const item = await getInboxItem(ownerSlug, taskId);
    expect(item).toBeDefined();
    expect('routed_to_fallback' in item!).toBe(false);

    const ownerClaim = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': ownerSlug,
    });
    expect(ownerClaim.statusCode).toBe(403); // live holder → owner may NOT grab it

    const holderClaim = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': holderSlug,
    });
    expect(holderClaim.statusCode, holderClaim.body).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (c3) — Tier-2 substitute covers the pool → NOT orphaned
// ---------------------------------------------------------------------------

describe('T-0744 (c3) regression — Tier-2 substitute provides coverage', () => {
  it('NOT fallback-marked; owner-claim 403; the Tier-2 substitute claims 200 (on_behalf_of set)', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const roleSlug = `t0744-role-c3-${uuid().slice(0, 6)}`;
    const absentSlug = `t0744-absent-c3-${uuid().slice(0, 6)}`;
    const substituteSlug = `t0744-sub-c3-${uuid().slice(0, 6)}`;
    const ownerSlug = `t0744-owner-c3-${uuid().slice(0, 6)}`;
    let taskId = '';

    await seedTx(tenantId, async (c) => {
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const absent = await seedEmployee(c, tenantId, absentSlug);
      const substitute = await seedEmployee(c, tenantId, substituteSlug);
      await seedOwner(c, tenantId, ownerSlug);
      await seedAssignment(c, tenantId, { empId: absent.id, roleId });
      const grantId = await seedTier2Grant(c, tenantId, roleId);
      await seedSubstitutionRule(c, tenantId, {
        absentEmpId: absent.id,
        substituteEmpId: substitute.id,
        roleId,
        ttlGrantId: grantId, // Tier-2 — minted grant IS coverage
      });
      taskId = await seedPoolTask(c, tenantId, roleSlug);
    });

    const item = await getInboxItem(ownerSlug, taskId);
    expect(item).toBeDefined();
    expect('routed_to_fallback' in item!).toBe(false); // substitute covers → not orphaned

    const ownerClaim = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': ownerSlug,
    });
    expect(ownerClaim.statusCode).toBe(403); // pool = {substitute} → owner may NOT grab it

    const subClaim = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, undefined, {
      'x-dev-user': substituteSlug,
    });
    expect(subClaim.statusCode, subClaim.body).toBe(200); // T-0588 AC-1 preserved
    const payload = await readClaimedPayload(taskId);
    expect(payload!['on_behalf_of']).toBe(absentSlug);
  });
});
