// T-0675 (security/системный, столп 4) · application-level read-gate dual-control
// live probe (real Postgres).
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//     npx vitest run ci/checks/db/read-grant-dual-control.db.test.ts
//
// THE ASYMMETRY (found on T-0632): `defaultCheckReadGrant` — the application-level
// read gate behind GET /api/report-pages/:id/render|data — used to query
// `application/read` grants WITHOUT any `confirmed_by` / `confirmed2_by` predicate
// on the grant ROW. The CANONICAL resolver `getGrantsForSubject` (grants-dao.ts
// step 3) enforces the T-0397 dual-control: a grant is PDP-active only when
// `confirmed_by IS NOT NULL` AND, if CRITICAL, `confirmed2_by IS NOT NULL`. So an
// UNCONFIRMED grant, or a CRITICAL read grant (a `read` grant carrying a sensitive
// clearance marker) confirmed by only ONE approver, PASSED the application-level
// gate that the single authority path would reject — dual-control was bypassable
// on the read path.
//
// THE FIX (T-0675): defaultCheckReadGrant's grant query now applies the IDENTICAL
// predicate, reusing the EXPORTED `criticalGrantPredicate` (one source of truth,
// no bespoke re-implementation).
//
// MUTATION-PROOF (this file):
//   (a) a CONFIRMED dual-control critical read-grant (confirmed_by + confirmed2_by)
//       → ALLOWED (ok:true).
//   (b) a SINGLE-CONTROL critical read-grant (confirmed_by only, confirmed2_by NULL)
//       → DENIED (ok:false). Revert the fix → this wrongly returns ok:true (RED).
//   (c) an UNCONFIRMED non-critical read-grant (confirmed_by NULL) → DENIED
//       (ok:false). Revert the fix → wrongly ok:true (RED).
//
// The gate is exercised DIRECTLY (defaultCheckReadGrant is an exported testing
// seam) against the RLS-enforced choros_app role (appUrl()), so the probe pins the
// production PDP path, not a stub.
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, withClient, uuid } from './_helpers.js';
import { defaultCheckReadGrant } from '../../../src/http/report-page-render.js';

const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!process.env['DATABASE_URL']) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

// ---------------------------------------------------------------------------
// App pool (RLS-enforced choros_app role — the production PDP identity).
// ---------------------------------------------------------------------------

let appPool: pg.Pool | null = null;
function getAppPool(): pg.Pool {
  if (!appPool) appPool = new pg.Pool({ connectionString: appUrl() });
  return appPool;
}

// ---------------------------------------------------------------------------
// Seed helpers (mirror report-page-render-read-pdp.db.test.ts). Seeding runs as
// the migrator (BYPASSRLS); the gate reads as choros_app (RLS).
// ---------------------------------------------------------------------------

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'draft', 0, 0)`,
    [tenantId, id, `t0675-app-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedEmployee(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $3, 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRole(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  const slug = `t0675-role-${id.slice(0, 8)}`;
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'T-0675 test role', 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

/** Confirmed, in-window, ROUTINE (proposed_by NULL) role_assignment. */
async function seedRoleAssignment(
  c: pg.Client,
  tenantId: string,
  employeeId: string,
  roleId: string,
): Promise<string> {
  const id = uuid();
  const orgScope = JSON.stringify({
    kind: 'node',
    hierarchy: 'org',
    nodeId: 'b0000000-0000-0000-0000-000000000001',
    nodeLevel: 'department',
  });
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
        source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'test', 'seed', NULL, 'seed', 0, 0)`,
    [tenantId, id, employeeId, roleId, orgScope],
  );
  await c.query('COMMIT');
  return id;
}

/**
 * Application-level `read` grant scoped to a specific appId (T-0193 R-6 shape),
 * with configurable criticality (clearance marker) and dual-control columns.
 *   critical=true  → constraint={clearance:'confidential'} → criticalGrantPredicate
 *                    TRUE → dual-control (confirmed2_by) REQUIRED.
 *   confirmedBy    → grant's first approver (NULL = unconfirmed).
 *   confirmed2By   → grant's second approver (NULL = single-control).
 */
async function seedApplicationReadGrant(
  c: pg.Client,
  tenantId: string,
  roleId: string,
  appId: string,
  opts: { critical: boolean; confirmedBy: string | null; confirmed2By: string | null },
): Promise<string> {
  const id = uuid();
  const scope = JSON.stringify({
    kind: 'node',
    hierarchy: 'resource',
    nodeId: appId,
    nodeLevel: 'application',
  });
  const constraint = opts.critical ? JSON.stringify({ clearance: 'confidential' }) : null;
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable,
        granted_by, proposed_by, confirmed_by, confirmed2_by, valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'application', NULL, 'read', $4::jsonb, $5::jsonb, false,
             'seed', NULL, $6, $7, NULL, NULL, 0)`,
    [tenantId, id, roleId, scope, constraint, opts.confirmedBy, opts.confirmed2By],
  );
  await c.query('COMMIT');
  return id;
}

// A fully-seeded actor holding exactly one application/read grant of a given shape.
interface SeededActor {
  slug: string;
  appId: string;
  empId: string;
  roleId: string;
  raId: string;
  grantId: string;
}

async function seedActorWithGrant(
  tenantId: string,
  appId: string,
  label: string,
  grantOpts: { critical: boolean; confirmedBy: string | null; confirmed2By: string | null },
): Promise<SeededActor> {
  return withClient(migratorUrl(), async (c) => {
    const slug = `t0675-${label}-${uuid().slice(0, 8)}`;
    const empId = await seedEmployee(c, tenantId, slug);
    const roleId = await seedRole(c, tenantId);
    const raId = await seedRoleAssignment(c, tenantId, empId, roleId);
    const grantId = await seedApplicationReadGrant(c, tenantId, roleId, appId, grantOpts);
    return { slug, appId, empId, roleId, raId, grantId };
  });
}

async function cleanupActor(tenantId: string, a: SeededActor): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [tenantId, a.grantId]);
    await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [tenantId, a.raId]);
    await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id=$2`, [tenantId, a.roleId]);
    await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [tenantId, a.empId]);
    await c.query('COMMIT');
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const cleanupFns: Array<() => Promise<void>> = [];
function addCleanup(fn: () => Promise<void>): void {
  cleanupFns.push(fn);
}

afterAll(async () => {
  for (const fn of [...cleanupFns].reverse()) {
    try { await fn(); } catch (e) { console.warn('[cleanup error]', e); }
  }
  if (appPool) await appPool.end();
});

// ---------------------------------------------------------------------------
// AC-T0675 — dual-control enforcement on the application-level read gate.
// ---------------------------------------------------------------------------

describe('T-0675: defaultCheckReadGrant enforces T-0397 grant-row dual-control (canonical parity)', () => {
  it('(a) CONFIRMED dual-control critical read-grant → ALLOWED', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const nowMs = Date.now();
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });

    const actor = await seedActorWithGrant(tenantId, appId, 'dual', {
      critical: true, confirmedBy: 'seed', confirmed2By: 'seed2',
    });
    addCleanup(() => cleanupActor(tenantId, actor));

    const res = await defaultCheckReadGrant(getAppPool(), tenantId, actor.slug, appId, nowMs);
    expect(res.ok).toBe(true);
  }));

  it('(b) SINGLE-CONTROL critical read-grant (confirmed2_by NULL) → DENIED [mutation-proof]', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const nowMs = Date.now();
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });

    const actor = await seedActorWithGrant(tenantId, appId, 'single', {
      critical: true, confirmedBy: 'seed', confirmed2By: null,
    });
    addCleanup(() => cleanupActor(tenantId, actor));

    // Without the T-0675 fix, the bespoke grant query ignored confirmed2_by and
    // this single-control critical grant WRONGLY passed (ok:true). The gate now
    // rejects it — dual-control is no longer bypassable on the read path.
    const res = await defaultCheckReadGrant(getAppPool(), tenantId, actor.slug, appId, nowMs);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_read_grant_on_application');
  }));

  it('(c) UNCONFIRMED non-critical read-grant (confirmed_by NULL) → DENIED [mutation-proof]', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    const nowMs = Date.now();
    const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
        await c.query('COMMIT');
      });
    });

    const actor = await seedActorWithGrant(tenantId, appId, 'unconf', {
      critical: false, confirmedBy: null, confirmed2By: null,
    });
    addCleanup(() => cleanupActor(tenantId, actor));

    // Without the fix, the grant query never checked the grant's own confirmed_by,
    // so this UNCONFIRMED grant WRONGLY passed (ok:true). The gate now requires it.
    const res = await defaultCheckReadGrant(getAppPool(), tenantId, actor.slug, appId, nowMs);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_read_grant_on_application');
  }));
});
