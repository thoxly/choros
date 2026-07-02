/**
 * ci/checks/db/migration-118-tenant-zero-backfill.test.ts — T-0573
 * (ADR-T0573 §2.1, FF-1/FF-2/FF-3)
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * migrations/118_assistant_tenant_zero_backfill.sql closes the FULL tenant-
 * zero assistant gap (role-configurator + employee assistant-agent +
 * agent_card + 2 role_assignment + 4 grant) for tenants registered BEFORE
 * register.ts (T-0373/T-0475/T-0574) seeded this invariant at registration
 * time. This file proves:
 *
 *   FF-1 (AC-1). After the migration, the AC-1 invariant query (spec
 *     §8 AC-1 — "does any tenant lack any of the 9 rows") returns ZERO rows
 *     for a tenant simulated as pre-T-0373 (NO role-configurator, NO
 *     assistant-agent employee, NO agent_card, NO role_assignment, NO
 *     grant — the deepest anti-case LIVE_PROOF T-0574 found).
 *   FF-2 (AC-1 anti-drift). The SAME invariant query ALSO returns zero rows
 *     for a tenant registered through the REAL registerTenant() (register.ts)
 *     — proving both seed-sites (TS transaction, SQL migration) satisfy one
 *     shared predicate.
 *   FF-3 (AC-2). Re-running the migration's SQL body a second (and third)
 *     time is a no-op: zero new rows in role/employee/agent_card/
 *     role_assignment/grant, and the invariant query still returns 0.
 *   Static (AC-3, companion to ci/checks/migrations/no-hardcoded-tenant-uuid.sh):
 *     the migration file contains no literal tenant UUID and is driven by
 *     `FROM choros.tenant`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_118_PATH = path.resolve(HERE, '../../../migrations/118_assistant_tenant_zero_backfill.sql');

async function seedTenant(c: pg.Client, tenantId: string, ownerEmployeeId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
  // Pre-T-0373 shape: only tenant-owner role + owner employee + confirmed
  // assignment exist — NOTHING from the 3e-3j-bis tenant-zero block (no
  // role-configurator, no assistant-agent employee, no agent_card, no
  // role_assignment/grant for the configurator role at all).
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'tenant-owner', 'Владелец', 0, 0)`,
    [tenantId],
  );
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'human', 'Owner', NULL, 0, 0)`,
    [tenantId, ownerEmployeeId, `owner-${ownerEmployeeId.slice(0, 8)}`],
  );
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM choros.role WHERE tenant_id = $1 AND slug = 'tenant-owner'`,
    [tenantId],
  );
  const ownerRoleId = rows[0]!.id;
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, granted_by, confirmed_by, source, created_at, updated_at)
     VALUES ($1, gen_random_uuid(), $2::uuid, $3, '{"kind":"set","members":[]}'::jsonb, $2::text, $2::text, 'registration', 0, 0)`,
    [tenantId, ownerEmployeeId, ownerRoleId],
  );
  await c.query('COMMIT');
}

/**
 * The AC-1 invariant query (spec §8 AC-1, verbatim): returns one row PER
 * tenant that is missing ANY of the 9 tenant-zero rows. A clean state is
 * ZERO rows for the tenant(s) under test.
 */
async function countInvariantViolations(c: pg.Client, tenantId: string): Promise<number> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  const { rows } = await c.query(
    `SELECT t.id AS tenant_id
       FROM choros.tenant t
      WHERE t.id = $1
        AND (
          NOT EXISTS (
            SELECT 1 FROM choros.role r
             WHERE r.tenant_id = t.id AND r.slug = 'role-configurator'
          )
          OR NOT EXISTS (
            SELECT 1 FROM choros.employee e
             WHERE e.tenant_id = t.id AND e.slug = 'assistant-agent' AND e.kind = 'agent'
          )
          OR NOT EXISTS (
            SELECT 1 FROM choros.agent_card ac
             JOIN choros.employee e ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
             WHERE ac.tenant_id = t.id AND e.slug = 'assistant-agent'
          )
          OR NOT EXISTS (
            SELECT 1 FROM choros.role_assignment ra
             JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
             JOIN choros.role_assignment owner_ra
               ON owner_ra.tenant_id = ra.tenant_id AND owner_ra.employee_id = ra.employee_id
             JOIN choros.role owner_role
               ON owner_role.tenant_id = owner_ra.tenant_id AND owner_role.id = owner_ra.role_id
                  AND owner_role.slug = 'tenant-owner'
             WHERE ra.tenant_id = t.id AND r.slug = 'role-configurator'
               AND ra.confirmed_by IS NOT NULL
          )
          OR NOT EXISTS (
            SELECT 1 FROM choros.role_assignment ra
             JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
             JOIN choros.employee e ON e.tenant_id = ra.tenant_id AND e.id = ra.employee_id
             WHERE ra.tenant_id = t.id AND r.slug = 'role-configurator'
               AND e.slug = 'assistant-agent' AND ra.confirmed_by IS NOT NULL
          )
          OR (
            SELECT COUNT(*) FROM choros."grant" g
             JOIN choros.role r ON r.tenant_id = g.tenant_id AND r.id = g.role_id
             WHERE g.tenant_id = t.id AND r.slug = 'role-configurator'
               AND g.resource_type = 'authoring_draft' AND g.operation IN ('create','update')
               AND g.confirmed_by IS NOT NULL
          ) < 2
          OR (
            SELECT COUNT(*) FROM choros."grant" g
             JOIN choros.role r ON r.tenant_id = g.tenant_id AND r.id = g.role_id
             WHERE g.tenant_id = t.id AND r.slug = 'role-configurator'
               AND g.resource_type IN ('llm_connection:configure','system_agent:operate')
               AND g.confirmed_by IS NOT NULL
          ) < 2
        )`,
    [tenantId],
  );
  await c.query('COMMIT');
  return rows.length;
}

async function countTenantZeroRows(c: pg.Client, tenantId: string): Promise<{
  roles: number; employees: number; agentCards: number; roleAssignments: number; grants: number;
}> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  const roles = await c.query(`SELECT COUNT(*)::int AS c FROM choros.role WHERE tenant_id = $1 AND slug = 'role-configurator'`, [tenantId]);
  const employees = await c.query(`SELECT COUNT(*)::int AS c FROM choros.employee WHERE tenant_id = $1 AND slug = 'assistant-agent' AND kind = 'agent'`, [tenantId]);
  const agentCards = await c.query(
    `SELECT COUNT(*)::int AS c FROM choros.agent_card ac
       JOIN choros.employee e ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
      WHERE ac.tenant_id = $1 AND e.slug = 'assistant-agent'`, [tenantId],
  );
  const roleAssignments = await c.query(
    `SELECT COUNT(*)::int AS c FROM choros.role_assignment ra
       JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
      WHERE ra.tenant_id = $1 AND r.slug = 'role-configurator' AND ra.confirmed_by IS NOT NULL`, [tenantId],
  );
  const grants = await c.query(
    `SELECT COUNT(*)::int AS c FROM choros."grant" g
       JOIN choros.role r ON r.tenant_id = g.tenant_id AND r.id = g.role_id
      WHERE g.tenant_id = $1 AND r.slug = 'role-configurator' AND g.confirmed_by IS NOT NULL`, [tenantId],
  );
  await c.query('COMMIT');
  return {
    roles: (roles.rows[0] as { c: number }).c,
    employees: (employees.rows[0] as { c: number }).c,
    agentCards: (agentCards.rows[0] as { c: number }).c,
    roleAssignments: (roleAssignments.rows[0] as { c: number }).c,
    grants: (grants.rows[0] as { c: number }).c,
  };
}

describe.skipIf(!LIVE)('T-0573 — migration 118 tenant-zero backfill (live Postgres)', () => {
  let migPool: pg.Pool;
  let migrationSql: string;
  const TENANT = uuid();
  const OWNER_EMPLOYEE = uuid();

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
    migrationSql = fs.readFileSync(MIGRATION_118_PATH, 'utf-8');
    await withClient(migratorUrl(), async (c) => {
      await seedTenant(c, TENANT, OWNER_EMPLOYEE);
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [TENANT]);
      await c.query('COMMIT');
    });
    if (migPool) await migPool.end();
  });

  it('AC-3 static: migration 118 has no literal tenant UUID and is driven by FROM choros.tenant', () => {
    const uuidRe = /'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'/;
    const codeOnly = migrationSql.replace(/--.*$/gm, '');
    expect(codeOnly).not.toMatch(uuidRe);
    expect(migrationSql).toMatch(/FROM\s+choros\.tenant\s+t/i);
  });

  it('the seeded pre-T-0373 tenant genuinely lacks the full invariant before any backfill runs', async () => {
    const c = await migPool.connect();
    try {
      const violations = await countInvariantViolations(c, TENANT);
      expect(violations).toBe(1); // this one tenant is missing the invariant
      const rowCounts = await countTenantZeroRows(c, TENANT);
      expect(rowCounts.roles).toBe(0);
      expect(rowCounts.employees).toBe(0);
      expect(rowCounts.agentCards).toBe(0);
    } finally {
      c.release();
    }
  });

  it('FF-1 (AC-1): re-running migration 118 backfills the FULL 9-row invariant for the pre-T-0373 tenant', async () => {
    const c = await migPool.connect();
    try {
      await c.query(migrationSql);

      const violations = await countInvariantViolations(c, TENANT);
      expect(violations).toBe(0);

      const rowCounts = await countTenantZeroRows(c, TENANT);
      expect(rowCounts.roles).toBe(1);
      expect(rowCounts.employees).toBe(1);
      expect(rowCounts.agentCards).toBe(1);
      expect(rowCounts.roleAssignments).toBe(2); // owner→cfg + agent→cfg
      expect(rowCounts.grants).toBe(4); // authoring_draft x2 + capability x2

      // F2: the owner→role-configurator assignment targets the SAME employee
      // that holds the confirmed tenant-owner assignment (not some other row).
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const { rows } = await c.query(
        `SELECT ra.employee_id
           FROM choros.role_assignment ra
           JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
          WHERE ra.tenant_id = $1 AND r.slug = 'role-configurator' AND ra.employee_id = $2`,
        [TENANT, OWNER_EMPLOYEE],
      );
      await c.query('COMMIT');
      expect(rows.length, 'the tenant owner must be assigned to role-configurator by the backfill').toBe(1);
    } finally {
      c.release();
    }
  });

  it('FF-3 (AC-2): running migration 118 a SECOND and THIRD time is a no-op (idempotent, no dup rows)', async () => {
    const c = await migPool.connect();
    try {
      await c.query(migrationSql);
      await c.query(migrationSql);

      const violations = await countInvariantViolations(c, TENANT);
      expect(violations).toBe(0);

      const rowCounts = await countTenantZeroRows(c, TENANT);
      expect(rowCounts.roles).toBe(1);
      expect(rowCounts.employees).toBe(1);
      expect(rowCounts.agentCards).toBe(1);
      expect(rowCounts.roleAssignments).toBe(2);
      expect(rowCounts.grants).toBe(4);
    } finally {
      c.release();
    }
  });

  // -------------------------------------------------------------------------
  // FF-2 (AC-1 anti-drift): a tenant registered through the REAL registerTenant()
  // (register.ts) must ALSO satisfy the SAME invariant predicate with zero
  // violations — proving both seed-sites (TS transaction, SQL migration)
  // agree on one shared contract.
  // -------------------------------------------------------------------------
  it('FF-2: a freshly registerTenant()-registered tenant ALSO satisfies the AC-1 invariant (0 violations)', async () => {
    const kc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await registerTenant(
      { pool: migPool, kc, nowMs: NOW },
      { orgName: `T-0573 anti-drift ${stamp}`, email: `t0573-antidrift-${stamp}@example.com`, password: 'assistant-key-pw-1' },
    );
    try {
      const c = await migPool.connect();
      try {
        const violations = await countInvariantViolations(c, res.tenantId);
        expect(violations, 'a freshly-registered tenant must ALREADY satisfy the AC-1 invariant (register.ts seeds it directly)').toBe(0);
      } finally {
        c.release();
      }
    } finally {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${res.tenantId}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [res.tenantId]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [res.tenantId]);
        await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [res.tenantId]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [res.tenantId]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [res.tenantId]);
        await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [res.tenantId]);
        await c.query('COMMIT');
      });
    }
  });
});
