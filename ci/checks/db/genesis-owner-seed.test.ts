// T-0029 · genesis owner seed (migration 026) — live Postgres probes.
//
// Run in the `db` CI job / locally: DATABASE_URL=... npm run fitness:db
//
// Covers (AC-12/13/16 live half — ADR §3 "Live verification"):
//   AC-12 — genesis seed present + idempotent: exactly 17 mgmt-grants attached to
//           tenant-owner (16 CRUD over 4 kinds + 1 invoke), exactly 1 confirmed
//           genesis assignment wiring e-owner → tenant-owner at the 3-root org-set;
//           re-running the seed inserts 0 rows (ON CONFLICT DO NOTHING).
//   AC-13 — exactly one tenant-owner role per tenant; the genesis assignment is the
//           single un-parented root (confirmed, source='genesis').
//   AC-16 — vacuous: mgmt-grants ride the already-registered `grant` table; no new
//           tenant table (asserted statically in scoped-admin-isolation.sh).

import { describe, it, expect } from 'vitest';
import { migratorUrl, withClient } from './_helpers.js';

const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const DEV_ROLE_OWNER = 'e0000000-0000-0000-0000-000000000001';
const DEV_EMP_OWNER = 'd0000000-0000-0000-0000-0000000000ff';
const DEV_RA_GENESIS = 'f0000000-0000-0000-0000-0000000000ff';
const DEV_DEPT_FIN = 'b0000000-0000-0000-0000-000000000001';
const DEV_DEPT_CS = 'b0000000-0000-0000-0000-000000000002';
const DEV_DEPT_PLAT = 'b0000000-0000-0000-0000-000000000003';

const FOREST_SET = {
  kind: 'set',
  members: [
    { kind: 'node', hierarchy: 'org', nodeId: DEV_DEPT_FIN, nodeLevel: 'department' },
    { kind: 'node', hierarchy: 'org', nodeId: DEV_DEPT_CS, nodeLevel: 'department' },
    { kind: 'node', hierarchy: 'org', nodeId: DEV_DEPT_PLAT, nodeLevel: 'department' },
  ],
};

// ---------------------------------------------------------------------------
// AC-12 — 17 mgmt-grants on tenant-owner; 1 confirmed genesis assignment; idempotent
// ---------------------------------------------------------------------------
describe('AC-12 · FF-12: genesis seed present + idempotent', () => {
  it('tenant-owner has exactly 17 delegable mgmt_object:* grants over the 3-root forest', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT resource_type, operation, scope, delegable
           FROM choros."grant"
          WHERE tenant_id=$1 AND role_id=$2 AND resource_type LIKE 'mgmt_object:%'`,
        [DEV_TENANT, DEV_ROLE_OWNER],
      );
      // 4 kinds × CRUD (16) + 1 invoke = 17
      expect(rows.length, 'expected 16 CRUD + 1 invoke mgmt-grants').toBe(17);

      // All delegable; all scoped to the 3-root forest set.
      for (const r of rows) {
        expect(r.delegable).toBe(true);
        expect(r.scope).toEqual(FOREST_SET);
        expect(r.resource_type.startsWith('mgmt_object:')).toBe(true);
      }

      // The expected (resource_type, operation) matrix is present exactly.
      const pairs = new Set(rows.map((r) => `${r.resource_type}:${r.operation}`));
      const expected = [
        'mgmt_object:role:create', 'mgmt_object:role:read', 'mgmt_object:role:update', 'mgmt_object:role:delete',
        'mgmt_object:agent:create', 'mgmt_object:agent:read', 'mgmt_object:agent:update', 'mgmt_object:agent:delete',
        'mgmt_object:process:create', 'mgmt_object:process:read', 'mgmt_object:process:update', 'mgmt_object:process:delete',
        'mgmt_object:grant:create', 'mgmt_object:grant:read', 'mgmt_object:grant:update', 'mgmt_object:grant:delete',
        'mgmt_object:agent:invoke',
      ];
      for (const e of expected) {
        expect(pairs.has(e), `missing mgmt-grant ${e}`).toBe(true);
      }
      expect(pairs.size).toBe(expected.length);
    });
  });

  it('exactly one confirmed genesis assignment wires e-owner → tenant-owner at the forest set', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT employee_id, role_id, org_scope, confirmed_by, proposed_by, source
           FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, DEV_RA_GENESIS],
      );
      expect(rows.length, 'genesis assignment must exist').toBe(1);
      const ra = rows[0];
      expect(ra.employee_id).toBe(DEV_EMP_OWNER);
      expect(ra.role_id).toBe(DEV_ROLE_OWNER);
      expect(ra.confirmed_by, 'genesis assignment must be confirmed (effective)').not.toBeNull();
      expect(ra.proposed_by, 'genesis created direct → proposed_by NULL').toBeNull();
      expect(ra.source).toBe('genesis');
      expect(ra.org_scope).toEqual(FOREST_SET);

      // The genesis employee really exists and is human.
      const emp = await c.query(
        `SELECT kind, position_id FROM choros.employee WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, DEV_EMP_OWNER],
      );
      expect(emp.rows.length).toBe(1);
      expect(emp.rows[0].kind).toBe('human');
      expect(emp.rows[0].position_id).toBeNull();

      // Every org node in the forest set really exists as a department.
      for (const m of FOREST_SET.members) {
        const dept = await c.query(`SELECT 1 FROM choros.department WHERE tenant_id=$1 AND id=$2`, [
          DEV_TENANT,
          m.nodeId,
        ]);
        expect(dept.rows.length, `dept ${m.nodeId} must exist`).toBe(1);
      }
    });
  });

  it('re-running the 026 seed inserts 0 rows (ON CONFLICT DO NOTHING — idempotent)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const grantsBefore = (
        await c.query(
          `SELECT count(*)::int AS n FROM choros."grant"
             WHERE tenant_id=$1 AND role_id=$2 AND resource_type LIKE 'mgmt_object:%'`,
          [DEV_TENANT, DEV_ROLE_OWNER],
        )
      ).rows[0].n;
      const raBefore = (
        await c.query(`SELECT count(*)::int AS n FROM choros.role_assignment WHERE tenant_id=$1`, [
          DEV_TENANT,
        ])
      ).rows[0].n;
      const empBefore = (
        await c.query(`SELECT count(*)::int AS n FROM choros.employee WHERE tenant_id=$1`, [
          DEV_TENANT,
        ])
      ).rows[0].n;

      // Re-apply the three seed inserts verbatim-equivalent (stable UUIDs).
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, NULL, 'human', 'e-owner', 'Владелец (genesis)', 0, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, DEV_EMP_OWNER],
      );
      // Re-insert one representative mgmt-grant (stable UUID) — must be a no-op.
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, operation, scope, delegable, granted_by, created_at)
         VALUES ($1, 'e1000000-0000-0000-0000-000000000001', $2, 'mgmt_object:role', 'create', $3::jsonb, true, 'seed', 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, DEV_ROLE_OWNER, JSON.stringify(FOREST_SET)],
      );
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until, source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NULL, NULL, 'genesis', 'seed', NULL, 'seed', 0, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, DEV_RA_GENESIS, DEV_EMP_OWNER, DEV_ROLE_OWNER, JSON.stringify(FOREST_SET)],
      );
      await c.query('COMMIT');

      const grantsAfter = (
        await c.query(
          `SELECT count(*)::int AS n FROM choros."grant"
             WHERE tenant_id=$1 AND role_id=$2 AND resource_type LIKE 'mgmt_object:%'`,
          [DEV_TENANT, DEV_ROLE_OWNER],
        )
      ).rows[0].n;
      const raAfter = (
        await c.query(`SELECT count(*)::int AS n FROM choros.role_assignment WHERE tenant_id=$1`, [
          DEV_TENANT,
        ])
      ).rows[0].n;
      const empAfter = (
        await c.query(`SELECT count(*)::int AS n FROM choros.employee WHERE tenant_id=$1`, [
          DEV_TENANT,
        ])
      ).rows[0].n;

      expect(grantsAfter, 're-seed must not duplicate mgmt-grants').toBe(grantsBefore);
      expect(raAfter, 're-seed must not duplicate the genesis assignment').toBe(raBefore);
      expect(empAfter, 're-seed must not duplicate the genesis employee').toBe(empBefore);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-13 — exactly one tenant-owner per tenant; single un-parented root
// ---------------------------------------------------------------------------
describe('AC-13 · FF-13: exactly one genesis owner per tenant', () => {
  it('exactly one tenant-owner role exists in the dev tenant', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role WHERE tenant_id=$1 AND slug='tenant-owner'`,
        [DEV_TENANT],
      );
      expect(rows[0].n, 'the lattice root cannot be ambiguous').toBe(1);
    });
  });

  it('exactly one genesis (source=genesis) confirmed assignment is the un-parented root', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role_assignment
           WHERE tenant_id=$1 AND role_id=$2 AND source='genesis' AND confirmed_by IS NOT NULL`,
        [DEV_TENANT, DEV_ROLE_OWNER],
      );
      expect(rows[0].n, 'exactly one confirmed genesis assignment').toBe(1);
    });
  });
});
