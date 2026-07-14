// T-0736 [security P1, substrate] · GET /api/rights/sod-check subjectId-
// override authority gate — LIVE Postgres integration probe.
//
// THE BUG (T-0726 §5.2 finding — the MOST dangerous of the three; confirmed
// by the T-0726 judge): `subjectId` defaulted to the caller but was
// caller-overridable to ANY other slug with ZERO privilege check — any
// tenant member could read ANY colleague's SoD conflicts (which roles they
// hold, and which pairs collide) by supplying that colleague's slug.
//
// THE FIX (T-0736, src/http/rights-sod.ts): self-view (subjectId===actorId,
// or omitted) needs no extra gate — the established §B "self-scoped"
// doctrine (actor-active-route-coverage.sh whitelist §B: notifications.ts /
// user-prefs.ts — self data needs no authority resolver). An OVERRIDE
// (subjectId !== actorId) now requires resolveActorPrivilege(...)
// .isOwnerOrAdmin — the SAME admin/owner bar as GET /api/grant-trail.
//
// Run:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npx vitest run --dir ci/checks/db --no-file-parallelism \
//     ci/checks/db/T-0736-rights-sod-check-authz.db.test.ts
//
// COVERAGE (real http.Server + the real production route, real migrator pool):
//   AC-1  self-view (no subjectId, ordinary active member)        -> 200, own data
//   AC-2  owner/admin OVERRIDES to a DIFFERENT real subject         -> 200,
//         returns THAT subject's conflicts (not the caller's, not empty —
//         proves it is a real read, not a silently-substituted self-view)
//   AC-3  ordinary member (no admin/owner) OVERRIDES to a colleague -> 403,
//         and the response carries NEITHER subject's conflict data (no leak)
//   AC-4  DEACTIVATED owner (still-live dev-header) OVERRIDES        -> 403
//         (loadAdminContext's isGenesisOwner query is fail-closed on
//         deactivation — the privilege check itself denies, not a stale cache)
//
// Generic by construction (D-064): every slug/role is uuid()-suffixed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerSodRoutes } from '../../../src/http/rights-sod.js';

const hasDb = Boolean(process.env['DATABASE_URL']);

const TENANT = uuid();

type EmpFx = { id: string; slug: string };
const EMPTY_EMP: EmpFx = { id: '', slug: '' };

const fx: {
  owner: EmpFx;
  plainMember: EmpFx;
  deactivatedOwner: EmpFx;
  subject: EmpFx; // the target employee whose SoD conflicts are being read
  roleAId: string;
  roleBId: string;
  constraintId: string;
} = {
  owner: EMPTY_EMP,
  plainMember: EMPTY_EMP,
  deactivatedOwner: EMPTY_EMP,
  subject: EMPTY_EMP,
  roleAId: '',
  roleBId: '',
  constraintId: '',
};

const ORG_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });
const SOD_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });

async function seedEmployee(
  c: pg.Client,
  slug: string,
  opts?: { deactivatedAt?: number },
): Promise<EmpFx> {
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, NULL, 'human', $3, $3, 0, 0, $4)`,
    [TENANT, empId, slug, opts?.deactivatedAt ?? null],
  );
  return { id: empId, slug };
}

// `choros.role` has UNIQUE(tenant_id, slug) — a tenant may only have ONE
// 'tenant-owner' role row. Two fixtures in this tenant (owner + deactivated
// owner) share the SAME role via this module-scoped cache instead of each
// inserting its own (which would violate the unique constraint).
let ownerRoleId: string | null = null;
async function ensureOwnerRole(c: pg.Client): Promise<string> {
  if (ownerRoleId) return ownerRoleId;
  ownerRoleId = uuid();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, 'tenant-owner', 'Tenant Owner', NULL, 0, 0)`,
    [TENANT, ownerRoleId],
  );
  return ownerRoleId;
}

async function seedOwnerAssignment(c: pg.Client, emp: EmpFx): Promise<void> {
  const roleId = await ensureOwnerRole(c);
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             NULL, $6, NULL, 0, 0)`,
    [TENANT, uuid(), emp.id, roleId, ORG_SCOPE, emp.slug],
  );
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

async function seedConfirmedAssignment(c: pg.Client, emp: EmpFx, roleId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             NULL, $6, $6, 0, 0)`,
    [TENANT, uuid(), emp.id, roleId, ORG_SCOPE, emp.slug],
  );
}

async function seedStaticSodConstraint(c: pg.Client, roleAId: string, roleBId: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.sod_constraint
       (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
     VALUES ($1, $2, 'static', $3, $4, false, $5::jsonb, NULL, 0)`,
    [TENANT, id, roleAId, roleBId, SOD_SCOPE],
  );
  return id;
}

let pool: pg.Pool;
let baseUrl = '';
let closeServer: () => Promise<void> = async () => {};

function req(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const httpReq = http.request(url, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    httpReq.on('error', reject);
    httpReq.end();
  });
}

describe('T-0736 · GET /api/rights/sod-check — subjectId-override authority gate (live Postgres)', () => {
  if (!hasDb) {
    it.skip('DATABASE_URL not set — skipping live DB tests', () => {});
    return;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: migratorUrl() });

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
         VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
        [TENANT, `t0736-sod-${TENANT.slice(0, 8)}`],
      );
      await c.query('COMMIT');

      await c.query('BEGIN');
      fx.owner = await seedEmployee(c, `t0736-sod-owner-${uuid().slice(0, 6)}`);
      await seedOwnerAssignment(c, fx.owner);

      fx.plainMember = await seedEmployee(c, `t0736-sod-member-${uuid().slice(0, 6)}`);
      // no role_assignment — ordinary member, no admin/owner authority.

      fx.deactivatedOwner = await seedEmployee(c, `t0736-sod-deactowner-${uuid().slice(0, 6)}`, {
        deactivatedAt: 500_000,
      });
      await seedOwnerAssignment(c, fx.deactivatedOwner);

      fx.subject = await seedEmployee(c, `t0736-sod-subject-${uuid().slice(0, 6)}`);
      fx.roleAId = await seedRole(c, `t0736-sod-role-a-${uuid().slice(0, 6)}`);
      fx.roleBId = await seedRole(c, `t0736-sod-role-b-${uuid().slice(0, 6)}`);
      // The subject holds BOTH conflicting roles -> a real, non-empty SoD conflict.
      await seedConfirmedAssignment(c, fx.subject, fx.roleAId);
      await seedConfirmedAssignment(c, fx.subject, fx.roleBId);
      fx.constraintId = await seedStaticSodConstraint(c, fx.roleAId, fx.roleBId);
      await c.query('COMMIT');
    });

    const router = new Router();
    registerSodRoutes(router, pool);
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
    if (pool) await pool.end();
  });

  // ---------------------------------------------------------------------------
  // AC-1 — self-view (no subjectId param) needs no privilege at all — even an
  // ordinary member with zero admin/owner authority can see their OWN conflicts.
  // ---------------------------------------------------------------------------
  it('AC-1: self-view (no subjectId), ordinary member -> 200, own (empty) data', async () => {
    const r = await req('/api/rights/sod-check', { 'x-dev-user': fx.plainMember.slug });
    expect(r.status, r.body).toBe(200);
    const body = JSON.parse(r.body) as { subjectId: string; conflicts: unknown[] };
    expect(body.subjectId).toBe(fx.plainMember.slug);
  });

  // ---------------------------------------------------------------------------
  // AC-2 — owner/admin overrides subjectId to a DIFFERENT, real subject -> 200
  // with THAT subject's own (non-empty) conflicts.
  // ---------------------------------------------------------------------------
  it('AC-2: owner overrides subjectId to a different subject -> 200, real conflict data', async () => {
    const r = await req(`/api/rights/sod-check?subjectId=${fx.subject.slug}`, {
      'x-dev-user': fx.owner.slug,
    });
    expect(r.status, r.body).toBe(200);
    const body = JSON.parse(r.body) as {
      subjectId: string;
      conflicts: Array<{ constraintId: string }>;
    };
    expect(body.subjectId).toBe(fx.subject.slug);
    expect(body.conflicts.some((cf) => cf.constraintId === fx.constraintId)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC-3 — an ordinary member (no admin/owner) overrides subjectId to a
  // colleague -> 403, and the body carries no conflict/heldRoles leak.
  // ---------------------------------------------------------------------------
  it('AC-3: ordinary member overrides subjectId to a colleague -> 403, no data leak', async () => {
    const r = await req(`/api/rights/sod-check?subjectId=${fx.subject.slug}`, {
      'x-dev-user': fx.plainMember.slug,
    });
    expect(r.status, r.body).toBe(403);
    const body = JSON.parse(r.body) as {
      error?: { code: string };
      subjectId?: string;
      conflicts?: unknown[];
      heldRoles?: unknown[];
    };
    expect(body.error?.code).toBe('FORBIDDEN');
    // No accidental data leak on the error path.
    expect(body.subjectId).toBeUndefined();
    expect(body.conflicts).toBeUndefined();
    expect(body.heldRoles).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // AC-4 — a DEACTIVATED owner (still-live dev-header/JWT) overrides subjectId
  // -> 403. Proves the privilege check itself is fail-closed on deactivation.
  // ---------------------------------------------------------------------------
  it('AC-4: DEACTIVATED owner overrides subjectId -> 403 FORBIDDEN', async () => {
    const r = await req(`/api/rights/sod-check?subjectId=${fx.subject.slug}`, {
      'x-dev-user': fx.deactivatedOwner.slug,
    });
    expect(r.status, r.body).toBe(403);
    const body = JSON.parse(r.body) as { error?: { code: string } };
    expect(body.error?.code).toBe('FORBIDDEN');
  });
});
