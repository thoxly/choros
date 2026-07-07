// T-0662 (security/системный, столп 4) · 7th authority path — the dual-control
// change-request APPROVE/REJECT deactivation gate. LIVE Postgres integration probe.
//
// Run on the server CI / locally against the compose Postgres:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// WHY THIS EXISTS (review round-2, judge R2-P1-1, severity P1): the T-0662
// accounting scan SURFACED src/http/rights-change-requests.ts:assertApproverIsHuman
// as an employee actor slug-lookup, but round-1 triage mis-filed it into the gate
// ALLOWLIST with a FALSE reason ("the deactivation control lives on the grant/approve
// path it precedes"). The approve path is:
//   POST /api/rights/change-requests/:id/approve
//     -> withAuth (token validity only; a deactivated human's still-live KC token or a
//        dev-header survive — T-0658 premise)
//     -> extractActorFromReq / resolveActorSlugFromAuth (identity mapping, un-gated)
//     -> resolveActorTenant (tenant mapping, un-gated by design)
//     -> assertApproverIsHuman (BEFORE the fix: SELECT kind ... WHERE slug=$ — NO
//        deactivated_at predicate)
//     -> approveChangeRequest (DC-1/DC-2 distinct-person only; NO owner/grant resolver)
// So a DEACTIVATED human could deliver the SECOND dual-control signature
// (confirmed2_by) — ACTIVATING a semi-confirmed grant/role_assignment — and could
// reject/hard-delete pending changes. That is the exact T-0658 bug class, alive on
// the dual-control path.
//
// THE FIX (T-0662 round-2): assertApproverIsHuman now carries `${ACTOR_ACTIVE_SQL}`
// (deactivated_at IS NULL) in its WHERE, and it is REGISTERED in
// ci/checks/actor-authority-deactivation-gate.sh AUTHORITY_RESOLVERS. A deactivated
// actor yields ZERO rows -> the function throws 403 FORBIDDEN (fail-closed, no oracle)
// on BOTH the approve and reject routes.
//
// COVERAGE (assertions drive the REAL routes through a real http.Server + a real
// choros_app Pool — the production path, NOT a stubbed pool):
//   AC-1  DEACTIVATED distinct human approving a pending GRANT       -> 403, confirmed2_by stays NULL
//   AC-2  DEACTIVATED distinct human approving a pending ASSIGNMENT  -> 403, confirmed2_by stays NULL
//   AC-3  DEACTIVATED distinct human REJECTING a pending GRANT       -> 403, row still present
//   AC-4  positive control: ACTIVE distinct human approving a GRANT  -> 200, confirmed2_by SET
//         (proves the gate blocks ONLY deactivation, not every second approver)
//
// Generic by construction (D-064): no case literals; every employee/dept/pos/role
// slug is uuid()-suffixed. Seeding goes through migratorUrl() (BYPASSRLS); the routes
// run through a choros_app Pool (RLS-enforced) — the real production write path. A
// fresh per-suite tenant keeps rows off the dev seed. Dev auth mode (CHOROS_AUTH_MODE
// default 'dev') lets the x-dev-user header carry the actor slug; a still-live token
// and a dev-header are the SAME threat surface for this gate (both bypass KC's
// enabled:false, which blocks only NEW token issuance).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRightsChangeRequestRoutes } from '../../../src/http/rights-change-requests.js';

const DEACT_AT = 500_000; // epoch-ms; any non-null value marks the row deactivated.

// The production server passes `grantsPool` = new Pool({ connectionString:
// DATABASE_URL }) — the BYPASSRLS choros_migrator role (src/server.ts:399-401) —
// to registerRightsChangeRequestRoutes. resolveActorTenant / the approve/reject
// SELECTs rely on that BYPASSRLS reach (they run without a per-request tenant GUC).
// We MUST mirror that here (migratorUrl), not the RLS-enforced app pool, or
// resolveActorTenant returns 0 rows and every request 403s on ACTOR_TENANT_UNRESOLVED
// (masking the gate under test). This is the real production write path.
let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: migratorUrl() });
  return _pool;
}

const TENANT = uuid();

type EmpFx = { id: string; slug: string };
const EMPTY_EMP: EmpFx = { id: '', slug: '' };

const fx: {
  proposer: EmpFx;        // first confirmer / proposed_by on every pending row
  deactApprover: EmpFx;   // a DISTINCT human, DEACTIVATED — the vector under test
  activeApprover: EmpFx;  // a DISTINCT human, ACTIVE — the positive control
  pendingGrantId: string;         // AC-1: grant approved by the deactivated actor
  pendingAssignmentId: string;    // AC-2: assignment approved by the deactivated actor
  pendingGrantRejectId: string;   // AC-3: grant rejected by the deactivated actor
  pendingGrantActiveId: string;   // AC-4: grant approved by the ACTIVE actor
  roleId: string;
} = {
  proposer: EMPTY_EMP,
  deactApprover: EMPTY_EMP,
  activeApprover: EMPTY_EMP,
  pendingGrantId: '',
  pendingAssignmentId: '',
  pendingGrantRejectId: '',
  pendingGrantActiveId: '',
  roleId: '',
};

const ORG_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });
const GRANT_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });

async function seedEmployee(
  c: pg.Client,
  slug: string,
  opts?: { deactivatedAt?: number },
): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [TENANT, deptId, `t0662-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [TENANT, posId, deptId, `t0662-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0, $5)`,
    [TENANT, empId, posId, slug, opts?.deactivatedAt ?? null],
  );
  return { id: empId, slug };
}

async function seedRole(c: pg.Client, slug: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 0, 0)`,
    [TENANT, id, slug],
  );
  return id;
}

/** A SEMI-CONFIRMED grant: confirmed_by set (first approver), confirmed2_by NULL
 *  (awaiting the distinct second approver — the "pending change request" shape). */
async function seedPendingGrant(c: pg.Client, args: { roleId: string; confirmedBy: string }): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable, granted_by,
        valid_from, valid_until, created_at,
        proposed_by, confirmed_by, confirmed2_by)
     VALUES ($1, $2, $3, 'mcp://record.x', NULL,
             'approve', $4::jsonb, NULL, false, 'seed',
             NULL, NULL, 0,
             $5, $5, NULL)`,
    [TENANT, id, args.roleId, GRANT_SCOPE, args.confirmedBy],
  );
  return id;
}

/** A SEMI-CONFIRMED role_assignment: confirmed_by set, confirmed2_by NULL. */
async function seedPendingAssignment(c: pg.Client, args: { empId: string; roleId: string; confirmedBy: string }): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             $6, $6, NULL, 0, 0)`,
    [TENANT, id, args.empId, args.roleId, ORG_SCOPE, args.confirmedBy],
  );
  return id;
}

// ---------------------------------------------------------------------------
// Real HTTP server driving the REAL routes (registerRightsChangeRequestRoutes).
// ---------------------------------------------------------------------------

let baseUrl = '';
let closeServer: () => Promise<void> = async () => {};

function req(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const url = new URL(baseUrl + path);
    const httpReq = http.request(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(bodyStr !== undefined
            ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    httpReq.on('error', reject);
    if (bodyStr !== undefined) httpReq.write(bodyStr);
    httpReq.end();
  });
}

/** Read confirmed2_by for a grant or role_assignment straight from the DB (migrator). */
async function readConfirmed2(kind: 'grant' | 'assignment', id: string): Promise<string | null | 'MISSING'> {
  const c = new pg.Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    await c.query('SET search_path TO choros;');
    const table = kind === 'grant' ? 'choros."grant"' : 'choros.role_assignment';
    const { rows } = await c.query<{ confirmed2_by: string | null }>(
      `SELECT confirmed2_by FROM ${table} WHERE tenant_id = $1 AND id = $2`,
      [TENANT, id],
    );
    if (rows.length === 0) return 'MISSING';
    return rows[0].confirmed2_by;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  const c = new pg.Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    await c.query('SET search_path TO choros;');
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
       VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
      [TENANT, `t0662-${TENANT.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await c.query('BEGIN');
    fx.roleId = await seedRole(c, `t0662-role-${uuid().slice(0, 6)}`);

    // proposer = first confirmer on every pending row (a distinct, active human).
    fx.proposer = await seedEmployee(c, `t0662-proposer-${uuid().slice(0, 6)}`);
    // the vector: a DISTINCT human, DEACTIVATED.
    fx.deactApprover = await seedEmployee(c, `t0662-deact-${uuid().slice(0, 6)}`, { deactivatedAt: DEACT_AT });
    // the positive control: a DISTINCT human, ACTIVE.
    fx.activeApprover = await seedEmployee(c, `t0662-active-${uuid().slice(0, 6)}`);

    // pending rows, all first-confirmed by the proposer, confirmed2_by NULL.
    fx.pendingGrantId = await seedPendingGrant(c, { roleId: fx.roleId, confirmedBy: fx.proposer.slug });
    fx.pendingAssignmentId = await seedPendingAssignment(c, {
      empId: fx.activeApprover.id, roleId: fx.roleId, confirmedBy: fx.proposer.slug,
    });
    fx.pendingGrantRejectId = await seedPendingGrant(c, { roleId: fx.roleId, confirmedBy: fx.proposer.slug });
    fx.pendingGrantActiveId = await seedPendingGrant(c, { roleId: fx.roleId, confirmedBy: fx.proposer.slug });

    await c.query('COMMIT');
  } finally {
    await c.end();
  }

  // Real server over the REAL routes with a REAL app pool.
  const router = new Router();
  registerRightsChangeRequestRoutes(router, getPool());
  const server = http.createServer(router.dispatch.bind(router));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
  closeServer = () => new Promise((res) => server.close(() => res()));
});

afterAll(async () => {
  await closeServer();
  if (_pool) { await _pool.end(); _pool = null; }
});

// ---------------------------------------------------------------------------
// AC-1 — DEACTIVATED distinct human approving a pending GRANT → 403, no confirmed2_by
// ---------------------------------------------------------------------------
describe('T-0662 AC-1 — deactivated approver cannot second-confirm a pending GRANT', () => {
  it('approve as a DEACTIVATED distinct human → 403 and confirmed2_by stays NULL', async () => {
    const r = await req('POST', `/api/rights/change-requests/${fx.pendingGrantId}/approve`, {
      'x-dev-user': fx.deactApprover.slug,
    });
    expect(r.status).toBe(403);
    // The row must NOT have been activated — confirmed2_by still NULL.
    expect(await readConfirmed2('grant', fx.pendingGrantId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-2 — DEACTIVATED distinct human approving a pending ASSIGNMENT → 403
// ---------------------------------------------------------------------------
describe('T-0662 AC-2 — deactivated approver cannot second-confirm a pending ASSIGNMENT', () => {
  it('approve as a DEACTIVATED distinct human → 403 and confirmed2_by stays NULL', async () => {
    const r = await req('POST', `/api/rights/change-requests/${fx.pendingAssignmentId}/approve`, {
      'x-dev-user': fx.deactApprover.slug,
    });
    expect(r.status).toBe(403);
    expect(await readConfirmed2('assignment', fx.pendingAssignmentId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-3 — DEACTIVATED distinct human REJECTING a pending GRANT → 403, row survives
// ---------------------------------------------------------------------------
describe('T-0662 AC-3 — deactivated approver cannot reject/hard-delete a pending GRANT', () => {
  it('reject as a DEACTIVATED distinct human → 403 and the grant row is still present', async () => {
    const r = await req('POST', `/api/rights/change-requests/${fx.pendingGrantRejectId}/reject`, {
      'x-dev-user': fx.deactApprover.slug,
    });
    expect(r.status).toBe(403);
    // Reject hard-deletes grants; the 403 must have blocked it → row still exists.
    expect(await readConfirmed2('grant', fx.pendingGrantRejectId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-4 — positive control: ACTIVE distinct human approving a GRANT → 200
// ---------------------------------------------------------------------------
describe('T-0662 AC-4 — the gate blocks ONLY deactivation, not every second approver', () => {
  it('approve as an ACTIVE distinct human → 200 and confirmed2_by is SET to that actor', async () => {
    const r = await req('POST', `/api/rights/change-requests/${fx.pendingGrantActiveId}/approve`, {
      'x-dev-user': fx.activeApprover.slug,
    });
    expect(r.status).toBe(200);
    expect(await readConfirmed2('grant', fx.pendingGrantActiveId)).toBe(fx.activeApprover.slug);
  });
});
