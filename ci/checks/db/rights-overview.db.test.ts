// T-0572 (D2/D5, rights UI writes) · GET /api/rights/tenant-state — LIVE
// Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//     npm run fitness:db
//
// Covers the fitness criteria of the T-0572 ADR §5 for the new READ endpoint:
//   FF-T0572-1  — for a tenant with N>0 roles, the admin projection returns
//                 EXACTLY those N roles (sverka with a direct SELECT). (AC-1)
//   FF-T0572-2  — a tenant with 0 roles returns {roles:[]} honestly (no
//                 demo:true / fixture substitution). (AC-2)
//   FF-T0572-8  — a semi-confirmed (confirmed_by set, confirmed2_by NULL,
//                 proposed_by set) grant AND assignment land in
//                 roles[].pending.*, NEVER in roles[].grants/assignments —
//                 in BOTH the admin and self projections. (AC-8)
//   FF-T0572-9  — an ordinary actor (no mgmt_object:role/grant, not genesis
//                 owner) gets scope:"self", can_manage:false, and only their
//                 OWN roles. (AC-9)
//   FF-T0572-10 — the self projection for actor X never contains another
//                 actor Y's roles — there is no client parameter to spoof
//                 employee_id with (the endpoint takes none). (AC-10)
//
// Seeding uses a FRESH per-test tenant UUID (never the shared dev silo or the
// TENANT_A/TENANT_B constants — T-0205 lesson) through migratorUrl()
// (BYPASSRLS); the route runs on a real server (createServer()) so
// resolveActorTenant / loadAdminContext exercise the actual production
// lookup, not a stub.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migratorUrl, withClient, uuid } from './_helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

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

// ---------------------------------------------------------------------------
// Seed helpers (migrator role; SET LOCAL tenant for the RLS WITH CHECK —
// mirrors ci/checks/db/records-read-pdp.db.test.ts, the T-0570 predecessor).
// ---------------------------------------------------------------------------

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedEmployee(
  c: pg.Client,
  tenantId: string,
  slug: string,
  kind: 'human' | 'agent' = 'human',
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $4, $3, $3, 0, 0)`,
    [tenantId, id, slug, kind],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRole(c: pg.Client, tenantId: string, slug: string, name: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 0, 0)`,
    [tenantId, id, slug, name],
  );
  await c.query('COMMIT');
  return id;
}

interface AssignmentSeed {
  confirmedBy: string | null;
  confirmed2By: string | null;
  proposedBy: string | null;
}

async function seedAssignment(
  c: pg.Client,
  tenantId: string,
  empId: string,
  roleId: string,
  s: AssignmentSeed,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, granted_by,
        proposed_by, confirmed_by, confirmed2_by, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'seed', $6, $7, $8, 'seed', 0, 0)`,
    [tenantId, id, empId, roleId, JSON.stringify({ kind: 'set', members: [] }), s.proposedBy, s.confirmedBy, s.confirmed2By],
  );
  await c.query('COMMIT');
  return id;
}

interface GrantSeed {
  confirmedBy: string | null;
  confirmed2By: string | null;
  proposedBy: string | null;
}

async function seedGrant(
  c: pg.Client,
  tenantId: string,
  roleId: string,
  resourceType: string,
  operation: string,
  s: GrantSeed,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
        "constraint", delegable, granted_by, proposed_by, confirmed_by, confirmed2_by,
        valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb,
             NULL, true, 'seed', $7, $8, $9, NULL, NULL, 0)`,
    [
      tenantId, id, roleId, resourceType, operation,
      JSON.stringify({ kind: 'set', members: [] }),
      s.proposedBy, s.confirmedBy, s.confirmed2By,
    ],
  );
  await c.query('COMMIT');
  return id;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface TenantStateBody {
  scope: 'tenant' | 'self';
  can_manage: boolean;
  roles: Array<{
    id: string;
    slug: string;
    name: string | null;
    assignments: Array<{ id: string; employee_id: string; org_scope: unknown; valid_from: number | null; valid_until: number | null }>;
    grants: Array<{ id: string; resource_type: string; operation: string }>;
    pending: {
      assignments: Array<{ id: string }>;
      grants: Array<{ id: string }>;
    };
  }>;
}

function getTenantState(
  baseUrl: string,
  actor: string,
): Promise<{ statusCode: number; body: TenantStateBody }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/rights/tenant-state`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      res.on('end', () => {
        const body = JSON.parse(raw) as TenantStateBody;
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server + fixtures
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

let TENANT_MAIN: string;
let TENANT_EMPTY: string;

// TENANT_MAIN fixtures
let roleAdminId = '';
let roleWorkerId = '';
let adminEmpId = '';
let workerAId = '';
let workerBId = '';
const ADMIN_SLUG_PREFIX = 'ro-admin-';
const WORKER_A_PREFIX = 'ro-worker-a-';
const WORKER_B_PREFIX = 'ro-worker-b-';
let adminSlug = '';
let workerASlug = '';
let workerBSlug = '';

let pendingAssignmentId = '';
let pendingGrantId = '';
let activeAssignmentId = '';
let activeGrantId = '';

beforeAll(
  requireDb(async () => {
    TENANT_MAIN = uuid();
    TENANT_EMPTY = uuid();

    const { createServer } = await import(join(REPO_ROOT, 'src', 'server.js'));
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const addr = server.address();
    baseUrl = addr && typeof addr !== 'string' ? `http://127.0.0.1:${addr.port}` : '';

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, TENANT_MAIN);
      await seedTenantRow(c, TENANT_EMPTY);

      adminSlug = `${ADMIN_SLUG_PREFIX}${TENANT_MAIN.slice(0, 8)}`;
      workerASlug = `${WORKER_A_PREFIX}${TENANT_MAIN.slice(0, 8)}`;
      workerBSlug = `${WORKER_B_PREFIX}${TENANT_MAIN.slice(0, 8)}`;

      adminEmpId = await seedEmployee(c, TENANT_MAIN, adminSlug);
      workerAId = await seedEmployee(c, TENANT_MAIN, workerASlug);
      workerBId = await seedEmployee(c, TENANT_MAIN, workerBSlug);

      // Admin role: holds a delegable mgmt_object:role + mgmt_object:grant
      // grant (what loadAdminContext checks for can_manage:true).
      roleAdminId = await seedRole(c, TENANT_MAIN, `ro-role-admin-${TENANT_MAIN.slice(0, 8)}`, 'Admin role');
      await seedAssignment(c, TENANT_MAIN, adminEmpId, roleAdminId, {
        proposedBy: null, confirmedBy: 'seed', confirmed2By: null,
      });
      await seedGrant(c, TENANT_MAIN, roleAdminId, 'mgmt_object:role', 'create', {
        proposedBy: null, confirmedBy: 'seed', confirmed2By: null,
      });
      await seedGrant(c, TENANT_MAIN, roleAdminId, 'mgmt_object:grant', 'create', {
        proposedBy: null, confirmedBy: 'seed', confirmed2By: null,
      });

      // Worker role: ordinary resource grant, held by workerA only.
      roleWorkerId = await seedRole(c, TENANT_MAIN, `ro-role-worker-${TENANT_MAIN.slice(0, 8)}`, 'Worker role');
      activeAssignmentId = await seedAssignment(c, TENANT_MAIN, workerAId, roleWorkerId, {
        proposedBy: null, confirmedBy: 'seed', confirmed2By: null,
      });
      activeGrantId = await seedGrant(c, TENANT_MAIN, roleWorkerId, 'record', 'read', {
        proposedBy: null, confirmedBy: 'seed', confirmed2By: null,
      });

      // Semi-confirmed (pending) assignment for workerB — confirmed_by set,
      // confirmed2_by NULL, proposed_by set (the escalating-path shape).
      pendingAssignmentId = await seedAssignment(c, TENANT_MAIN, workerBId, roleWorkerId, {
        proposedBy: 'seed-proposer', confirmedBy: 'seed-proposer', confirmed2By: null,
      });

      // Semi-confirmed (pending) grant on the worker role.
      pendingGrantId = await seedGrant(c, TENANT_MAIN, roleWorkerId, 'record', 'write', {
        proposedBy: 'seed-proposer', confirmedBy: 'seed-proposer', confirmed2By: null,
      });
    });
  }),
);

afterAll(
  requireDb(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await withClient(migratorUrl(), async (c) => {
      for (const t of [TENANT_MAIN, TENANT_EMPTY]) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [t]);
        await c.query('COMMIT');
      }
      await c.query(`DELETE FROM choros.tenant WHERE id = ANY($1::uuid[])`, [[TENANT_MAIN, TENANT_EMPTY]]);
    });
    await appPool?.end();
  }),
);

// ---------------------------------------------------------------------------
// FF-T0572-1 (AC-1): admin projection returns exactly the tenant's N roles.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0572 FF-T0572-1: admin projection returns exactly the tenant\'s roles', () => {
  it('returns the same role id-set as a direct SELECT id FROM role', async () => {
    const { statusCode, body } = await getTenantState(baseUrl, adminSlug);
    expect(statusCode).toBe(200);
    expect(body.scope).toBe('tenant');
    expect(body.can_manage).toBe(true);

    const dbRoleIds = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM choros.role WHERE tenant_id = $1`,
        [TENANT_MAIN],
      );
      return rows.map((r) => r.id).sort();
    });

    expect(body.roles.map((r) => r.id).sort()).toEqual(dbRoleIds);
    expect(body.roles).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// FF-T0572-2 (AC-2): empty tenant → honest {roles:[]}, no demo flag.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0572 FF-T0572-2: empty tenant returns honest {roles:[]}', () => {
  it('a tenant with 0 roles returns roles:[] with no demo field', async () => {
    const emptySlug = `ro-empty-${TENANT_EMPTY.slice(0, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await seedEmployee(c, TENANT_EMPTY, emptySlug);
    });

    const { statusCode, body } = await getTenantState(baseUrl, emptySlug);
    expect(statusCode).toBe(200);
    expect(body.roles).toEqual([]);
    expect((body as unknown as Record<string, unknown>)['demo']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FF-T0572-8 (AC-8): semi-confirmed rows land in pending, never in active.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0572 FF-T0572-8: semi-confirmed rows are pending, never active', () => {
  it('admin projection: pending assignment/grant are NOT in roles[].assignments/grants', async () => {
    const { body } = await getTenantState(baseUrl, adminSlug);
    const workerRole = body.roles.find((r) => r.id === roleWorkerId);
    expect(workerRole).toBeDefined();

    // Active rows present.
    expect(workerRole!.assignments.map((a) => a.id)).toContain(activeAssignmentId);
    expect(workerRole!.grants.map((g) => g.id)).toContain(activeGrantId);

    // T-0608 (F-1): every active assignment surfaces org_scope + the validity
    // window (valid_from/valid_until) — the client dedups holders by the FULL
    // composite identity (employee + scope + window), never employee_id alone
    // (migrations/020: NO UNIQUE(employee_id, role_id) — differently-scoped
    // assignments of the same person are distinct, must not collapse/over-revoke).
    const activeRa = workerRole!.assignments.find((a) => a.id === activeAssignmentId);
    expect(activeRa).toBeDefined();
    expect(activeRa!).toHaveProperty('org_scope');
    expect(activeRa!).toHaveProperty('valid_from');
    expect(activeRa!).toHaveProperty('valid_until');

    // Pending (semi-confirmed) rows present ONLY in pending, never active.
    expect(workerRole!.pending.assignments.map((a) => a.id)).toContain(pendingAssignmentId);
    expect(workerRole!.pending.grants.map((g) => g.id)).toContain(pendingGrantId);
    expect(workerRole!.assignments.map((a) => a.id)).not.toContain(pendingAssignmentId);
    expect(workerRole!.grants.map((g) => g.id)).not.toContain(pendingGrantId);
  });

  it('self projection (workerB, the pending-assignment holder): pending assignment is NOT active', async () => {
    const { body } = await getTenantState(baseUrl, workerBSlug);
    expect(body.scope).toBe('self');
    expect(body.can_manage).toBe(false);

    const workerRole = body.roles.find((r) => r.id === roleWorkerId);
    // workerB's ONLY link to this role is the pending assignment — it must
    // surface the role (so the user can see "ждёт подтверждения"), but NOT
    // as an active assignment.
    expect(workerRole).toBeDefined();
    expect(workerRole!.assignments.map((a) => a.employee_id)).not.toContain(workerBId);
    expect(workerRole!.pending.assignments.map((a) => a.id)).toContain(pendingAssignmentId);
  });
});

// ---------------------------------------------------------------------------
// FF-T0572-9 / FF-T0572-10 (AC-9/AC-10): ordinary actor sees only own roles.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0572 FF-T0572-9/10: ordinary actor gets self-scoped, own-only projection', () => {
  it('workerA (no mgmt_object grant) gets scope:self, can_manage:false', async () => {
    const { statusCode, body } = await getTenantState(baseUrl, workerASlug);
    expect(statusCode).toBe(200);
    expect(body.scope).toBe('self');
    expect(body.can_manage).toBe(false);
  });

  it('workerA sees ONLY roles/assignments tied to workerA, never workerB\'s', async () => {
    const { body } = await getTenantState(baseUrl, workerASlug);
    for (const role of body.roles) {
      for (const a of role.assignments) {
        expect(a.employee_id).toBe(workerAId);
      }
    }
    // workerA must NOT see the admin role at all (holds no assignment on it).
    expect(body.roles.map((r) => r.id)).not.toContain(roleAdminId);
  });

  it('there is no client parameter to request another employee\'s self-view (endpoint takes none)', async () => {
    // AC-10: attempt to smuggle an employee_id via query string — the
    // endpoint has no such parameter, so it is silently ignored; the
    // response is still scoped to the AUTHENTICATED actor (workerA).
    const url = new URL(`${baseUrl}/api/rights/tenant-state`);
    url.searchParams.set('employee_id', workerBId);
    const { statusCode, body } = await new Promise<{ statusCode: number; body: TenantStateBody }>((resolve, reject) => {
      const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': workerASlug } }, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(statusCode).toBe(200);
    for (const role of body.roles) {
      for (const a of role.assignments) {
        expect(a.employee_id).toBe(workerAId);
      }
    }
  });
});
