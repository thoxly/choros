// T-0750 [security P1, substrate — ACTOR_ACTIVE wave finale] · GET /api/inbox/:id
// authority gate — LIVE Postgres integration probe.
//
// Run: DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db  (or vitest run against this file directly)
//
// WHY THIS EXISTS (docs/tasks/T-0750.adr.md): the T-0740/T-0726 judges confirmed
// this was the LAST finding of actor-active-route-coverage.sh (FF-726-1): the
// DETAIL route (src/http/inbox.ts, GET /api/inbox/:id) found its item via
// findInboxItems(actor) — tenant-scoped ONLY, zero authority-resolver reachable
// in its handler block — so ANY tenant member (addressed or not, active or not)
// could read ANY task by id for the tenant-scoped id-space, and a DEACTIVATED
// actor's still-live residual-window access-JWT (T-0702) kept full read access.
// LIST already closed the SAME class for tab=pool/badges via T-0738's hardened
// resolveRolesForActor (composes getRoleSlugsForActor, ACTOR_ACTIVE_SQL on both
// lookups). This task reuses that SAME resolver on DETAIL (no second authority
// path) plus the SAME isGenesisOwnerForTenant owner bypass this file already
// uses for orphan-claim (isOwnerOrphanClaimEligible).
//
// COVERAGE (T-0750.adr.md §... — mirrors T-0738's AC-numbering style):
//   AC-1 — role-addressee (active, holds the task's role) → 200.
//   AC-2 — outsider (active, tenant member, holds an UNRELATED role, never
//          claimed, not the owner) → 404 (honest-404, not 403 — T-0570/T-0721
//          precedent: never confirm the task's existence to an unauthorized
//          caller).
//   AC-3 — DEACTIVATED addressee (role_assignment intact, NOT separately
//          revoked, employee.deactivated_at set — the T-0702 residual-JWT-
//          window shape) → 404 (the actual security fix under test).
//   AC-4 — tenant-owner bypass: an actor holding ONLY 'tenant-owner' (not the
//          task's role) still sees the detail (isGenesisOwnerForTenant,
//          deactivation-safe by construction, T-0658).
//   AC-5 — claimant ("mine") bypass: an actor who claimed the task (task.
//          claimed audit event) sees the detail even without holding the
//          role; AND a same-role colleague who did NOT claim it STILL sees it
//          (role-addressing is invariant across claim state — see the
//          route's own doc comment in inbox.ts, T-0750 §"Решение").
//   AC-6 — regression: GET /api/inbox?tab=pool (T-0738's own live route) is
//          unaffected by this task's DETAIL-only change — the addressee still
//          sees the pool task, the deactivated addressee still sees an empty
//          pool tab.
//
// Generic by construction (D-064): no case literals — every slug/role/scope
// value is a fresh uuid()-suffixed fixture, mirroring
// grants-dao-role-slug-deactivation.db.test.ts (T-0738).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerInboxRoutes } from '../../../src/http/inbox.js';
import { appendProcessStarted } from '../../../src/http/process-projection.js';
import { appendTaskClaimed } from '../../../src/http/claim-projection.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';

let appPool: pg.Pool;
let server: http.Server;
let baseUrl = '';

function makeRequest(
  method: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
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

type EmpFx = { id: string; slug: string };

async function seedEmployee(
  c: pg.Client,
  tenantId: string,
  slug: string,
  opts?: { deactivatedAt?: number },
): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [tenantId, deptId, `t0750-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [tenantId, posId, deptId, `t0750-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, $3, 'human', $4, $4, 0, 0, $5)`,
    [tenantId, empId, posId, slug, opts?.deactivatedAt ?? null],
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

const ORG_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });

async function seedAssignment(c: pg.Client, tenantId: string, args: { empId: string; roleId: string }): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             NULL, 'seed', NULL, 0, 0)`,
    [tenantId, uuid(), args.empId, args.roleId, ORG_SCOPE],
  );
}

describe('T-0750 — GET /api/inbox/:id authority gate (live PG)', () => {
  const TENANT = uuid();
  const ROLE_SLUG = `t0750-role-${uuid().slice(0, 6)}`;
  const OTHER_ROLE_SLUG = `t0750-other-role-${uuid().slice(0, 6)}`;
  const PROC_KEY = `t0750-proc-${uuid().slice(0, 6)}`;

  let addressee: EmpFx;
  let deactivatedAddressee: EmpFx;
  let outsider: EmpFx;
  let owner: EmpFx;
  let claimant: EmpFx;
  let addresseeTaskId = '';
  let claimedTaskId = '';

  beforeAll(async () => {
    appPool = new pg.Pool({ connectionString: appUrl() });
    const router = new Router();
    registerInboxRoutes(router); // no writeDeps needed: findInboxItems() reads via getOrgPool() directly.
    server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => {
      server.listen(0, 'localhost', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await c.query(
        `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
         VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
        [TENANT, `t0750-${TENANT.slice(0, 8)}`],
      );

      const roleId = await seedRole(c, TENANT, ROLE_SLUG);
      const otherRoleId = await seedRole(c, TENANT, OTHER_ROLE_SLUG);
      const ownerRoleId = await seedRole(c, TENANT, 'tenant-owner');

      addressee = await seedEmployee(c, TENANT, `t0750-addressee-${uuid().slice(0, 6)}`);
      await seedAssignment(c, TENANT, { empId: addressee.id, roleId });

      deactivatedAddressee = await seedEmployee(c, TENANT, `t0750-deact-${uuid().slice(0, 6)}`, {
        deactivatedAt: 500_000,
      });
      await seedAssignment(c, TENANT, { empId: deactivatedAddressee.id, roleId });

      outsider = await seedEmployee(c, TENANT, `t0750-outsider-${uuid().slice(0, 6)}`);
      await seedAssignment(c, TENANT, { empId: outsider.id, roleId: otherRoleId });

      owner = await seedEmployee(c, TENANT, `t0750-owner-${uuid().slice(0, 6)}`);
      await seedAssignment(c, TENANT, { empId: owner.id, roleId: ownerRoleId });

      claimant = await seedEmployee(c, TENANT, `t0750-claimant-${uuid().slice(0, 6)}`);
      await seedAssignment(c, TENANT, { empId: claimant.id, roleId: otherRoleId }); // holds an UNRELATED role

      // One unclaimed pool task addressed to ROLE_SLUG — used by AC-1/2/3/4.
      addresseeTaskId = await appendProcessStarted(c as unknown as PgClientLike, {
        instanceId: uuid(),
        procKey: PROC_KEY,
        actor: 'system:test-seed',
        nowMs: Date.now(),
        approverRole: ROLE_SLUG,
        tenantId: TENANT,
      });

      // A second task, addressed to ROLE_SLUG, then CLAIMED by `claimant` (who
      // holds only OTHER_ROLE_SLUG) — used by AC-5.
      claimedTaskId = await appendProcessStarted(c as unknown as PgClientLike, {
        instanceId: uuid(),
        procKey: PROC_KEY,
        actor: 'system:test-seed',
        nowMs: Date.now(),
        approverRole: ROLE_SLUG,
        tenantId: TENANT,
      });
      await appendTaskClaimed(c as unknown as PgClientLike, {
        taskId: claimedTaskId,
        actor: claimant.slug,
        actorKind: 'human',
        tenantId: TENANT,
        role: ROLE_SLUG,
        nowMs: Date.now(),
      });

      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }
  });

  afterAll(async () => {
    if (appPool) await appPool.end();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('AC-1: role-addressee sees the task detail → 200', async () => {
    const res = await makeRequest('GET', `/api/inbox/${addresseeTaskId}`, { 'x-dev-user': addressee.slug });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { item: { id: string; role: string } };
    expect(body.item.id).toBe(addresseeTaskId);
    expect(body.item.role).toBe(ROLE_SLUG);
  });

  it('AC-2: an outsider (unrelated role, never claimed, not owner) → 404 (honest, not 403)', async () => {
    const res = await makeRequest('GET', `/api/inbox/${addresseeTaskId}`, { 'x-dev-user': outsider.slug });
    expect(res.statusCode, res.body).toBe(404);
  });

  it('AC-3: DEACTIVATED addressee (role_assignment intact, live residual-window token) → 404', async () => {
    const res = await makeRequest('GET', `/api/inbox/${addresseeTaskId}`, { 'x-dev-user': deactivatedAddressee.slug });
    expect(res.statusCode, res.body).toBe(404);
  });

  it('AC-4: tenant-owner bypass — owner (holds ONLY tenant-owner, not the task role) → 200', async () => {
    const res = await makeRequest('GET', `/api/inbox/${addresseeTaskId}`, { 'x-dev-user': owner.slug });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('AC-5a: claimant ("mine") bypass — actor who claimed the task, no matching role → 200', async () => {
    const res = await makeRequest('GET', `/api/inbox/${claimedTaskId}`, { 'x-dev-user': claimant.slug });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { item: { mine?: boolean } };
    expect(body.item.mine).toBe(true);
  });

  it('AC-5b: role-addressing survives claim state — a same-role colleague who did NOT claim it still sees it', async () => {
    const res = await makeRequest('GET', `/api/inbox/${claimedTaskId}`, { 'x-dev-user': addressee.slug });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { item: { mine?: boolean } };
    expect(body.item.mine).not.toBe(true);
  });

  it('AC-6a: regression — GET /api/inbox?tab=pool still shows the pool task to the addressee (T-0738 unaffected)', async () => {
    const res = await makeRequest('GET', '/api/inbox?tab=pool', { 'x-dev-user': addressee.slug });
    expect(res.statusCode, res.body).toBe(200);
    const parsed = JSON.parse(res.body) as { items: Array<{ id: string; role: string }> };
    expect(parsed.items.some((i) => i.id === addresseeTaskId)).toBe(true);
  });

  it('AC-6b: regression — GET /api/inbox?tab=pool still hides it from the deactivated addressee (T-0738 unaffected)', async () => {
    const res = await makeRequest('GET', '/api/inbox?tab=pool', { 'x-dev-user': deactivatedAddressee.slug });
    expect(res.statusCode, res.body).toBe(200);
    const parsed = JSON.parse(res.body) as { items: unknown[]; counts: Record<string, number> };
    expect(parsed.items).toEqual([]);
    expect(parsed.counts['pool']).toBe(0);
  });
});
