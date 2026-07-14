// T-0642 [столп1/P0] · resolveRoleSlugsByIds — LIVE Postgres integration probe.
//
// Run in the `db` CI job / locally: DATABASE_URL=... npm run fitness:db
//
// WHY THIS EXISTS: LIVE_PROOF T-0588 found that a userTask with a panel-assigned
// role (choros:assignedRoleId, the role's UUID) published WITHOUT
// flowable:candidateGroups — because nothing translated the UUID into the SLUG
// every routing consumer (executor-resolver.ts, getHoldersForRole, inbox.ts)
// actually matches against. resolveRoleSlugsByIds (grants-dao.ts) is the fix's
// DB-backed resolution: role.id → role.slug, tenant-scoped. This probe proves it
// against a REAL Postgres + RLS, seeding fresh hermetic tenants (never the
// shared dev-silo tenant, to avoid cross-suite pollution — mirrors
// applications_delete_cascade / registry_def_cascade_relation's own-tenant
// discipline).
//
// COVERAGE:
//   - resolves multiple role ids to their slugs in one tenant
//   - a role id from ANOTHER tenant does NOT resolve (RLS/tenant-scope holds
//     even though the caller passes a syntactically valid UUID that exists —
//     just in the wrong tenant)
//   - an id with no role row at all (never existed) does not resolve
//   - partial resolution: a mix of resolvable + unresolvable ids returns only
//     the resolvable subset (mirrors filterProvisionedAgentEmployeeIds' DAO
//     contract for agentRef — same non-blocking-degradation shape)

import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { resolveRoleSlugsByIds } from '../../../src/db/grants-dao.js';

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: appUrl() });
  return _pool;
}

afterAll(async () => {
  if (_pool) await _pool.end();
});

async function withMigrator<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: migratorUrl() });
  await client.connect();
  try {
    await client.query('SET search_path TO choros;');
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Seed a fresh hermetic tenant with the given roles ({id, slug} pairs). */
async function seedTenantWithRoles(
  roles: Array<{ id: string; slug: string }>,
): Promise<string> {
  const tenantId = uuid();
  await withMigrator(async (c) => {
    await c.query(
      `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
       VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
      [tenantId, `t0642-${tenantId.slice(0, 8)}`],
    );
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    for (const r of roles) {
      await c.query(
        `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 0, 0)`,
        [tenantId, r.id, r.slug, r.slug],
      );
    }
    await c.query('COMMIT');
  });
  return tenantId;
}

describe('resolveRoleSlugsByIds (live Postgres)', () => {
  it('resolves multiple role ids to their slugs within one tenant', async () => {
    const roleBuh = uuid();
    const roleDir = uuid();
    const tenantId = await seedTenantWithRoles([
      { id: roleBuh, slug: 't0642-buhgalter' },
      { id: roleDir, slug: 't0642-direktor' },
    ]);

    const resolved = await resolveRoleSlugsByIds(getPool(), tenantId, [roleBuh, roleDir]);

    expect(resolved).toEqual(
      new Map([
        [roleBuh, 't0642-buhgalter'],
        [roleDir, 't0642-direktor'],
      ]),
    );
  });

  it('does NOT resolve a role id that belongs to a DIFFERENT tenant (tenant-scope holds)', async () => {
    const roleId = uuid();
    const tenantA = await seedTenantWithRoles([{ id: roleId, slug: 't0642-scope-a' }]);
    // A second tenant that does NOT have this role id at all.
    const tenantB = await seedTenantWithRoles([]);

    // Asking tenant B to resolve tenant A's role id must come back empty —
    // even though the UUID is well-formed and genuinely exists (in tenant A).
    const resolvedFromB = await resolveRoleSlugsByIds(getPool(), tenantB, [roleId]);
    expect(resolvedFromB.has(roleId)).toBe(false);
    expect(resolvedFromB.size).toBe(0);

    // Sanity: tenant A itself resolves it fine (same id, correct tenant).
    const resolvedFromA = await resolveRoleSlugsByIds(getPool(), tenantA, [roleId]);
    expect(resolvedFromA.get(roleId)).toBe('t0642-scope-a');
  });

  it('does not resolve an id with no role row at all (deleted / never existed)', async () => {
    const tenantId = await seedTenantWithRoles([]);
    const neverExisted = uuid();

    const resolved = await resolveRoleSlugsByIds(getPool(), tenantId, [neverExisted]);
    expect(resolved.size).toBe(0);
  });

  it('returns only the resolvable subset for a mix of real + unresolvable ids', async () => {
    const roleReal = uuid();
    const roleGhost = uuid(); // never inserted
    const tenantId = await seedTenantWithRoles([{ id: roleReal, slug: 't0642-real-role' }]);

    const resolved = await resolveRoleSlugsByIds(getPool(), tenantId, [roleReal, roleGhost]);

    expect(resolved.size).toBe(1);
    expect(resolved.get(roleReal)).toBe('t0642-real-role');
    expect(resolved.has(roleGhost)).toBe(false);
  });
});
