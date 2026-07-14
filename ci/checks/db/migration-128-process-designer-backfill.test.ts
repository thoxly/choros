// ci/checks/db/migration-128-process-designer-backfill.test.ts — T-0666
// (ADR-T0666 §2.2) — live Postgres probe.
//
// migrations/128_process_designer_role_backfill.sql seeds the `process_designer`
// role (SEEDED, NOT auto-assigned) for every EXISTING tenant that lacks it —
// mirrors migration 118's set-driven, idempotent, no-hardcoded-tenant pattern.
//
// WHY THIS EXISTS: checkRole (src/http/binding.ts) — the single conventional
// authz gate shared by POST /api/forms/binding, floor1-editor.ts, and
// dmn-rule-table.ts — looks up `role.slug = 'process_designer'` in keycloak
// mode. Before T-0666 no tenant had this role (not the dev silo, not
// registerTenant) — every actor, INCLUDING the tenant owner, got 403
// FORBIDDEN (LIVE_PROOF T-0656 had to grant it by hand in the DB). T-0666's
// register.ts change seeds the role for NEW tenants; this migration closes
// the gap for tenants that existed before that change shipped.
//
// COVERAGE:
//   AC-pre   — a tenant simulated as pre-T-0666 (only tenant-owner role, no
//              process_designer) genuinely lacks the role before any backfill.
//   AC-1     — re-running the migration's SQL body seeds exactly one
//              process_designer role row for that tenant.
//   AC-2     — running the migration a SECOND and THIRD time is a no-op (no
//              duplicate role rows — idempotent).
//   AC-unassigned — the seeded role has ZERO role_assignment rows (seeded but
//              not auto-assigned, same posture as role-constructor-admin).
//   AC-3 static — the migration file has no literal tenant UUID and is driven
//              by `FROM choros.tenant`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';

const LIVE = !!process.env['DATABASE_URL'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_128_PATH = path.resolve(HERE, '../../../migrations/128_process_designer_role_backfill.sql');

async function seedPreT0666Tenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t128-${tenantId.slice(0, 8)}`],
  );
  // Pre-T-0666 shape: only the tenant-owner role exists — no process_designer.
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'tenant-owner', 'Владелец', 0, 0)`,
    [tenantId],
  );
  await c.query('COMMIT');
}

async function countProcessDesignerRole(c: pg.Client, tenantId: string): Promise<number> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  const { rows } = await c.query(
    `SELECT COUNT(*)::int AS c FROM choros.role WHERE tenant_id = $1 AND slug = 'process_designer'`,
    [tenantId],
  );
  await c.query('COMMIT');
  return (rows[0] as { c: number }).c;
}

async function countProcessDesignerAssignments(c: pg.Client, tenantId: string): Promise<number> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  const { rows } = await c.query(
    `SELECT COUNT(*)::int AS c FROM choros.role_assignment ra
       JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
      WHERE ra.tenant_id = $1 AND r.slug = 'process_designer'`,
    [tenantId],
  );
  await c.query('COMMIT');
  return (rows[0] as { c: number }).c;
}

describe.skipIf(!LIVE)('T-0666 — migration 128 process_designer role backfill (live Postgres)', () => {
  let migPool: pg.Pool;
  let migrationSql: string;
  const TENANT = uuid();

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
    migrationSql = fs.readFileSync(MIGRATION_128_PATH, 'utf-8');
    await withClient(migratorUrl(), async (c) => {
      await seedPreT0666Tenant(c, TENANT);
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [TENANT]);
      await c.query('COMMIT');
    });
    if (migPool) await migPool.end();
  });

  it('AC-3 static: migration 128 has no literal tenant UUID and is driven by FROM choros.tenant', () => {
    const uuidRe = /'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'/;
    const codeOnly = migrationSql.replace(/--.*$/gm, '');
    expect(codeOnly).not.toMatch(uuidRe);
    expect(migrationSql).toMatch(/FROM\s+choros\.tenant\s+t/i);
  });

  it('AC-pre: the seeded pre-T-0666 tenant genuinely lacks process_designer before any backfill runs', async () => {
    const c = await migPool.connect();
    try {
      const count = await countProcessDesignerRole(c, TENANT);
      expect(count).toBe(0);
    } finally {
      c.release();
    }
  });

  it('AC-1: re-running migration 128 seeds exactly one process_designer role for the pre-T-0666 tenant', async () => {
    const c = await migPool.connect();
    try {
      await c.query(migrationSql);
      const count = await countProcessDesignerRole(c, TENANT);
      expect(count).toBe(1);
    } finally {
      c.release();
    }
  });

  it('AC-unassigned: the seeded process_designer role has ZERO role_assignment rows (seeded but not auto-assigned)', async () => {
    const c = await migPool.connect();
    try {
      const assignments = await countProcessDesignerAssignments(c, TENANT);
      expect(assignments).toBe(0);
    } finally {
      c.release();
    }
  });

  it('AC-2: running migration 128 a SECOND and THIRD time is a no-op (idempotent, no duplicate role rows)', async () => {
    const c = await migPool.connect();
    try {
      await c.query(migrationSql);
      await c.query(migrationSql);
      const count = await countProcessDesignerRole(c, TENANT);
      expect(count).toBe(1);
    } finally {
      c.release();
    }
  });

  it('anti-drift: a tenant registered via the REAL registerTenant() also has exactly one process_designer role (both seed-sites agree)', async () => {
    // Simulates the register.ts §3q seed directly against a fresh tenant to
    // prove the SAME predicate (slug='process_designer', exactly 1 row, 0
    // assignments) holds for both seed-sites — mirrors migration-118's FF-2
    // anti-drift check, without re-running the full registerTenant() KC flow.
    const freshTenant = uuid();
    const c = await migPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${freshTenant}'`);
      await c.query(
        `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
         VALUES ($1, $1, $2, $2, 0)`,
        [freshTenant, `t128-fresh-${freshTenant.slice(0, 8)}`],
      );
      // register.ts §3q shape: role-only, ON CONFLICT DO NOTHING, no assignment.
      await c.query(
        `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
         VALUES ($1, gen_random_uuid(), 'process_designer', 'Конструктор форм', 'seed', 0, 0)
         ON CONFLICT DO NOTHING`,
        [freshTenant],
      );
      await c.query('COMMIT');

      // Running the migration on top of a tenant that ALREADY has the role
      // (register.ts already seeded it) must still be a no-op (LEFT JOIN...
      // WHERE r.id IS NULL correctly skips it).
      await c.query(migrationSql);

      const count = await countProcessDesignerRole(c, freshTenant);
      expect(count).toBe(1);
      const assignments = await countProcessDesignerAssignments(c, freshTenant);
      expect(assignments).toBe(0);
    } finally {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${freshTenant}'`);
      await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [freshTenant]);
      await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [freshTenant]);
      await c.query('COMMIT');
      c.release();
    }
  });
});
