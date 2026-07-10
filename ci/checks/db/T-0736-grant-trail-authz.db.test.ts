// T-0736 [security P1, substrate] · GET /api/grant-trail authority gate —
// LIVE Postgres integration probe.
//
// THE BUG (T-0726 §5.2 finding, confirmed by the T-0726 judge): the full
// tenant-wide grant/assignment journal — who granted/revoked which right to
// whom, by whom, when — was returned to ANY authenticated tenant member with
// ZERO authority check (no authority resolver on the route at all).
//
// THE FIX (T-0736, src/http/grant-trail.ts): the route now calls
// resolveActorPrivilege(pool, tenantId, actor, nowMs) and requires
// `.isOwnerOrAdmin` (the SAME formula rights-overview.ts's `can_manage`
// already established for tenant-wide rights visibility — isGenesisOwner ||
// adminGrants.length > 0, via loadAdminContext) before querying the trail.
//
// Run:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npx vitest run --dir ci/checks/db --no-file-parallelism \
//     ci/checks/db/T-0736-grant-trail-authz.db.test.ts
//
// COVERAGE (real http.Server + the real production route, real migrator pool
// — the SAME wiring src/server.ts uses):
//   AC-1  genesis tenant-OWNER                        -> 200, sees the seeded row
//   AC-2  ordinary ACTIVE human member (no role at all) -> 403 FORBIDDEN
//   AC-3  DEACTIVATED tenant-owner (deactivated_at set) -> 403 (fail-closed;
//         loadAdminContext's isGenesisOwner query carries ACTOR_ACTIVE_SQL)
//
// Generic by construction (D-064): every tenant/employee/role/dept slug is
// uuid()-suffixed; no case literals.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerGrantTrailRoutes } from '../../../src/http/grant-trail.js';
import { resolveActorTenant } from '../../../src/db/org.js';

const hasDb = Boolean(process.env['DATABASE_URL']);

const TENANT = uuid();
const SEQ_BASE = Math.floor(Math.random() * 8_000_000) + 1_000_000;

type EmpFx = { id: string; slug: string };

const fx: {
  owner: EmpFx;
  member: EmpFx;
  deactivatedOwner: EmpFx;
} = {
  owner: { id: '', slug: '' },
  member: { id: '', slug: '' },
  deactivatedOwner: { id: '', slug: '' },
};

const ORG_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });

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

/** Seed a genesis tenant-owner: role.slug='tenant-owner' + a CONFIRMED role_assignment. */
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

async function seedGrantEvent(c: pg.Client, seq: number, actorSlug: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.audit_event
       (tenant_id, seq, id, type, actor, subject, payload, occurred_at,
        prev_hash, row_hash, vocab_version)
     VALUES ($1, $2, $3, 'grant.create', $4, 't0736-role', '{"resourceType":"record","operation":"read"}'::jsonb, $5,
             '\\x00'::bytea, '\\x01'::bytea, 1)
     ON CONFLICT (tenant_id, seq) DO NOTHING`,
    [TENANT, seq, id, actorSlug, Date.now()],
  );
  return id;
}

let migPool: pg.Pool;
let baseUrl = '';
let closeServer: () => Promise<void> = async () => {};
let seededRowId = '';

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

describe('T-0736 · GET /api/grant-trail — authority gate (live Postgres)', () => {
  if (!hasDb) {
    it.skip('DATABASE_URL not set — skipping live DB tests', () => {});
    return;
  }

  beforeAll(async () => {
    migPool = new pg.Pool({ connectionString: migratorUrl() });

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
         VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
        [TENANT, `t0736-trail-${TENANT.slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO choros.audit_head (tenant_id, seq, row_hash, updated_at, vocab_version)
         VALUES ($1, 0, '\\x00'::bytea, 0, 1) ON CONFLICT DO NOTHING`,
        [TENANT],
      );
      await c.query('COMMIT');

      await c.query('BEGIN');
      fx.owner = await seedEmployee(c, `t0736-owner-${uuid().slice(0, 6)}`);
      await seedOwnerAssignment(c, fx.owner);

      fx.member = await seedEmployee(c, `t0736-member-${uuid().slice(0, 6)}`);
      // No role_assignment at all — an ordinary tenant member, zero authority.

      fx.deactivatedOwner = await seedEmployee(c, `t0736-deactowner-${uuid().slice(0, 6)}`, {
        deactivatedAt: 500_000,
      });
      await seedOwnerAssignment(c, fx.deactivatedOwner);

      seededRowId = await seedGrantEvent(c, SEQ_BASE + 1, fx.owner.slug);
      await c.query('COMMIT');
    });

    const router = new Router();
    registerGrantTrailRoutes(router, {
      pool: migPool,
      resolveActorTenant: (slug: string) => resolveActorTenant(migPool, slug),
    });
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
    if (migPool) await migPool.end();
  });

  // ---------------------------------------------------------------------------
  // AC-1 — genesis tenant-owner sees the trail (legitimate path, not broken).
  // ---------------------------------------------------------------------------
  it('AC-1: genesis tenant-owner -> 200, sees the seeded grant.create row', async () => {
    const r = await req('/api/grant-trail', { 'x-dev-user': fx.owner.slug });
    expect(r.status, r.body).toBe(200);
    const body = JSON.parse(r.body) as { rows: Array<{ id: string }> };
    expect(body.rows.some((row) => row.id === seededRowId)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC-2 — an ordinary ACTIVE member with no role/grant at all -> 403.
  // ---------------------------------------------------------------------------
  it('AC-2: ordinary active member (no admin/owner authority) -> 403 FORBIDDEN', async () => {
    const r = await req('/api/grant-trail', { 'x-dev-user': fx.member.slug });
    expect(r.status, r.body).toBe(403);
    const body = JSON.parse(r.body) as { error?: { code: string } };
    expect(body.error?.code).toBe('FORBIDDEN');
  });

  // ---------------------------------------------------------------------------
  // AC-3 — a DEACTIVATED tenant-owner (still-live dev-header/JWT) -> 403, not 200.
  // Proves the gate is fail-closed on deactivation, not just on role-absence.
  // ---------------------------------------------------------------------------
  it('AC-3: DEACTIVATED tenant-owner -> 403 FORBIDDEN (not the trail)', async () => {
    const r = await req('/api/grant-trail', { 'x-dev-user': fx.deactivatedOwner.slug });
    expect(r.status, r.body).toBe(403);
    const body = JSON.parse(r.body) as { error?: { code: string } };
    expect(body.error?.code).toBe('FORBIDDEN');
  });
});
