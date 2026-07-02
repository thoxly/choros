/**
 * ci/checks/db/migration-120-ownerless-unarm.test.ts — T-0594
 * (ADR-T0594 §4/§6, FF-1/FF-2/FF-3)
 *
 * Run in the `db` CI job / locally:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
 *
 * migrations/120_ownerless_tenant_zero_unarm.sql removes the dangling
 * role-configurator armament (assistant-agent role_assignment + 4 grants,
 * both migration-118-backfill-marked) for any tenant that has NO confirmed
 * role_assignment on role slug='tenant-owner' — the R-2 finding of the
 * T-0573 review (docs/review/T-0573.review.json) and the exact mixed-state
 * scenario the T-0573 tester's adversarial probe reproduced
 * (docs/test/T-0573.test-report.json, T_FULL/T_PARTIAL/T_OWNERLESS naming
 * reused here for direct traceability finding -> test).
 *
 * This file proves:
 *
 *   FF-1 (AC-1). On a mixed fixture of three tenants seeded in the SAME
 *     database — T_FULL (already-complete 9-row tenant-zero invariant),
 *     T_PARTIAL (role-configurator + a CONFIRMED tenant-owner assignment
 *     exist, but employee/agent_card/role_assignment-on-configurator/grants
 *     are missing — an owner EXISTS), T_OWNERLESS (role-configurator +
 *     assistant-agent employee + agent_card + the assistant-agent role
 *     assignment + all 4 grants exist — i.e. migration 118's A1/A2/A3/A5/
 *     A6/A7 already ran for it — but NO confirmed role_assignment on
 *     tenant-owner exists at all) — running migration 120's body:
 *       - deletes T_OWNERLESS's assistant-agent->role-configurator
 *         role_assignment and all 4 backfill-marked grants (0 rows left);
 *       - leaves T_OWNERLESS's role/employee/agent_card untouched (F3);
 *       - migration 118's own AC-1 invariant predicate (verbatim, reused
 *         from migration-118-tenant-zero-backfill.test.ts) still reports
 *         exactly 1 violation for T_OWNERLESS (unchanged from before 120 —
 *         now for the honest reason: missing owner-facing rows, not merely
 *         "armed but unreachable by a human");
 *       - T_FULL and T_PARTIAL are COMPLETELY unaffected (byte-identical
 *         row counts before/after — N1 non-regression).
 *   FF-2 (AC-2). Re-running migration 120's SQL body a second time on the
 *     same fixture is a no-op: zero additional deletes, state stable.
 *   FF-3 (AC-3). Static: migrations/120_*.sql contains no literal tenant
 *     UUID and is driven by joins against choros.role_assignment/role (same
 *     regex-class as ci/checks/migrations/no-hardcoded-tenant-uuid.sh uses
 *     for migration 118).
 *   FF-4 (AC-4, regression). The EXISTING migration-118 test file
 *     (migration-118-tenant-zero-backfill.test.ts) is NOT modified by this
 *     task and is asserted green in the same CI run (see package.json
 *     fitness:db — this file simply must not break it; verified separately
 *     by running that file unmodified alongside this one).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';

const LIVE = !!process.env['DATABASE_URL'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_120_PATH = path.resolve(HERE, '../../../migrations/120_ownerless_tenant_zero_unarm.sql');

/**
 * The AC-1 invariant query — VERBATIM copy of countInvariantViolations() in
 * migration-118-tenant-zero-backfill.test.ts (spec §8 AC-1 of T-0573). Kept
 * byte-identical in SQL SHAPE (not literally imported, since that file is
 * not a module export surface) so a divergence between what migration 118
 * considers "complete" and what this test asserts would be a bug in THIS
 * file, not a silently different standard.
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

async function countRows(c: pg.Client, tenantId: string): Promise<{
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

/** Insert a bare tenant row (no organizational structure at all yet). */
async function insertTenant(c: pg.Client, tenantId: string, slug: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, slug],
  );
  await c.query('COMMIT');
}

/** Insert role(tenant-owner) + owner employee + a CONFIRMED role_assignment (an owner exists). */
async function seedOwner(c: pg.Client, tenantId: string, ownerEmployeeId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
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
 * Insert the FULL tenant-zero armament (role-configurator + assistant-agent
 * employee + agent_card + the assistant-agent role_assignment + 4 grants)
 * exactly as migration 118's A1/A2/A3/A5/A6/A7 blocks would produce, WITHOUT
 * requiring an owner (this simulates "migration 118 already ran on this
 * tenant" — used for both T_OWNERLESS, which never gets A4, and as the base
 * for T_FULL, which additionally gets an owner + A4).
 */
async function armTenantZero(c: pg.Client, tenantId: string, agentEmployeeId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'role-configurator', 'Конфигуратор системы', 0, 0)`,
    [tenantId],
  );
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
     VALUES ($1, $2, 'assistant-agent', 'agent', 'Ассистент (AI-агент)', NULL, 0, 0)`,
    [tenantId, agentEmployeeId],
  );
  const { rows: roleRows } = await c.query<{ id: string }>(
    `SELECT id FROM choros.role WHERE tenant_id = $1 AND slug = 'role-configurator'`,
    [tenantId],
  );
  const cfgRoleId = roleRows[0]!.id;
  await c.query(
    `INSERT INTO choros.agent_card
       (tenant_id, id, employee_id, employee_kind, agent_type, kc_client_id,
        llm_endpoint, llm_model, llm_secret_handle, llm_connection_id,
        autonomy_threshold, created_at, updated_at)
     VALUES ($1, gen_random_uuid(), $2, 'agent', 'assistant', $3,
             NULL, NULL, NULL, NULL, NULL, 0, 0)`,
    [tenantId, agentEmployeeId, `assistant-agent-${tenantId}`],
  );
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, granted_by, confirmed_by, source, created_at, updated_at)
     VALUES ($1, gen_random_uuid(), $2::uuid, $3, '{"kind":"set","members":[]}'::jsonb, 'backfill', 'backfill', 'backfill', 0, 0)`,
    [tenantId, agentEmployeeId, cfgRoleId],
  );
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
        "constraint", delegable, granted_by, proposed_by, confirmed_by,
        valid_from, valid_until, created_at)
     SELECT $1, gen_random_uuid(), $2, vals.resource_type, NULL, vals.operation,
            '{"kind":"set","members":[]}'::jsonb, NULL, false, 'backfill', NULL, 'backfill', NULL, NULL, 0
       FROM (VALUES
         ('authoring_draft', 'create'), ('authoring_draft', 'update'),
         ('llm_connection:configure', 'configure'), ('system_agent:operate', 'operate')
       ) AS vals(resource_type, operation)`,
    [tenantId, cfgRoleId],
  );
  await c.query('COMMIT');
}

describe.skipIf(!LIVE)('T-0594 — migration 120 ownerless-tenant unarm (live Postgres)', () => {
  let pool: pg.Pool;
  let migrationSql: string;

  const T_FULL = uuid();
  const T_FULL_OWNER = uuid();
  const T_FULL_AGENT = uuid();

  const T_PARTIAL = uuid();
  const T_PARTIAL_OWNER = uuid();

  const T_OWNERLESS = uuid();
  const T_OWNERLESS_AGENT = uuid();

  beforeAll(async () => {
    if (!LIVE) return;
    pool = new pg.Pool({ connectionString: migratorUrl() });
    migrationSql = fs.readFileSync(MIGRATION_120_PATH, 'utf-8');

    await withClient(migratorUrl(), async (c) => {
      // T_FULL: complete 9-row invariant — owner AND full tenant-zero armament.
      await insertTenant(c, T_FULL, `t-full-${T_FULL.slice(0, 8)}`);
      await seedOwner(c, T_FULL, T_FULL_OWNER);
      await armTenantZero(c, T_FULL, T_FULL_AGENT);
      // A4-equivalent: owner -> role-configurator (T_FULL has an owner).
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${T_FULL}'`);
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM choros.role WHERE tenant_id = $1 AND slug = 'role-configurator'`,
        [T_FULL],
      );
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, granted_by, confirmed_by, source, created_at, updated_at)
         VALUES ($1, gen_random_uuid(), $2::uuid, $3, '{"kind":"set","members":[]}'::jsonb, 'backfill', 'backfill', 'backfill', 0, 0)`,
        [T_FULL, T_FULL_OWNER, rows[0]!.id],
      );
      await c.query('COMMIT');

      // T_PARTIAL: owner EXISTS (confirmed tenant-owner assignment), but NO
      // tenant-zero armament yet (role-configurator/assistant-agent/agent_card/
      // grants all absent) — a harder partial state (owner present, nothing
      // else) than T_FULL's "everything present".
      await insertTenant(c, T_PARTIAL, `t-partial-${T_PARTIAL.slice(0, 8)}`);
      await seedOwner(c, T_PARTIAL, T_PARTIAL_OWNER);

      // T_OWNERLESS: full tenant-zero armament (role-configurator +
      // assistant-agent employee + agent_card + role_assignment + 4 grants —
      // exactly what migration 118's A1/A2/A3/A5/A6/A7 produce), but NO
      // tenant-owner role AND NO confirmed role_assignment on it at all — the
      // R-2 anti-case.
      await insertTenant(c, T_OWNERLESS, `t-ownerless-${T_OWNERLESS.slice(0, 8)}`);
      await armTenantZero(c, T_OWNERLESS, T_OWNERLESS_AGENT);
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    await withClient(migratorUrl(), async (c) => {
      for (const t of [T_FULL, T_PARTIAL, T_OWNERLESS]) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [t]);
        await c.query('COMMIT');
      }
    });
    if (pool) await pool.end();
  });

  it('AC-3 static: migration 120 has no literal tenant UUID and is driven by joins over choros.role_assignment/role', () => {
    const uuidRe = /'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'/;
    const codeOnly = migrationSql.replace(/--.*$/gm, '');
    expect(codeOnly).not.toMatch(uuidRe);
    expect(migrationSql).toMatch(/FROM\s+choros\.role_assignment\s+ra/i);
    expect(migrationSql).toMatch(/JOIN\s+choros\.role\s+owner_role/i);
  });

  it('the fixture is set up as intended before any run of migration 120', async () => {
    const c = await pool.connect();
    try {
      // T_FULL: complete invariant, 0 violations.
      expect(await countInvariantViolations(c, T_FULL)).toBe(0);
      const fullCounts = await countRows(c, T_FULL);
      expect(fullCounts.roleAssignments).toBe(2); // owner->cfg + agent->cfg
      expect(fullCounts.grants).toBe(4);

      // T_PARTIAL: owner exists, but role-configurator/agent/grants do not —
      // still 1 violation (missing rows), by construction.
      expect(await countInvariantViolations(c, T_PARTIAL)).toBe(1);
      const partialCounts = await countRows(c, T_PARTIAL);
      expect(partialCounts.roles).toBe(0);
      expect(partialCounts.roleAssignments).toBe(0);
      expect(partialCounts.grants).toBe(0);

      // T_OWNERLESS: armed (agent role_assignment + 4 grants exist), but NO
      // owner at all — 1 violation (the owner->role-configurator branch).
      expect(await countInvariantViolations(c, T_OWNERLESS)).toBe(1);
      const ownerlessCounts = await countRows(c, T_OWNERLESS);
      expect(ownerlessCounts.roles).toBe(1);
      expect(ownerlessCounts.employees).toBe(1);
      expect(ownerlessCounts.agentCards).toBe(1);
      expect(ownerlessCounts.roleAssignments).toBe(1); // agent->cfg only, no owner->cfg
      expect(ownerlessCounts.grants).toBe(4);
    } finally {
      c.release();
    }
  });

  it('FF-1 (AC-1): migration 120 unarms ONLY T_OWNERLESS (role_assignment+grants gone), leaves role/employee/agent_card intact, and does not touch T_FULL/T_PARTIAL', async () => {
    const c = await pool.connect();
    try {
      const beforeFull = await countRows(c, T_FULL);
      const beforePartial = await countRows(c, T_PARTIAL);

      await c.query(migrationSql);

      // T_OWNERLESS: role_assignment + grants deleted; role/employee/agent_card intact.
      const afterOwnerless = await countRows(c, T_OWNERLESS);
      expect(afterOwnerless.roles).toBe(1); // F3: untouched
      expect(afterOwnerless.employees).toBe(1); // F3: untouched
      expect(afterOwnerless.agentCards).toBe(1); // F3: untouched
      expect(afterOwnerless.roleAssignments).toBe(0); // deleted
      expect(afterOwnerless.grants).toBe(0); // deleted

      // The AC-1 invariant predicate still reports T_OWNERLESS as
      // non-compliant (1 violation) — same count as before 120, now for the
      // honest reason (missing owner-facing rows, not merely unreachable).
      expect(await countInvariantViolations(c, T_OWNERLESS)).toBe(1);

      // T_FULL and T_PARTIAL are completely unaffected (N1 non-regression).
      const afterFull = await countRows(c, T_FULL);
      expect(afterFull).toEqual(beforeFull);
      expect(await countInvariantViolations(c, T_FULL)).toBe(0);

      const afterPartial = await countRows(c, T_PARTIAL);
      expect(afterPartial).toEqual(beforePartial);
      expect(await countInvariantViolations(c, T_PARTIAL)).toBe(1); // unchanged (still missing rows, not migration-120's concern)
    } finally {
      c.release();
    }
  });

  it('FF-2 (AC-2): running migration 120 a SECOND time is a no-op (idempotent, no further deletes, no oscillation)', async () => {
    const c = await pool.connect();
    try {
      const beforeOwnerless = await countRows(c, T_OWNERLESS);
      const beforeFull = await countRows(c, T_FULL);
      const beforePartial = await countRows(c, T_PARTIAL);

      await c.query(migrationSql); // second run in this test's lifetime (fixture already unarmed by the previous test)
      await c.query(migrationSql); // third run

      expect(await countRows(c, T_OWNERLESS)).toEqual(beforeOwnerless);
      expect(await countRows(c, T_FULL)).toEqual(beforeFull);
      expect(await countRows(c, T_PARTIAL)).toEqual(beforePartial);

      expect(await countInvariantViolations(c, T_OWNERLESS)).toBe(1);
      expect(await countInvariantViolations(c, T_FULL)).toBe(0);
      expect(await countInvariantViolations(c, T_PARTIAL)).toBe(1);
    } finally {
      c.release();
    }
  });
});
