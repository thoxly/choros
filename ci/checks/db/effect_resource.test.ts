// T-0034 · FF-ER1 / FF-ER2 — effect_resource schema + cross-tenant isolation.
//
// Live Postgres probes (run in the `db` CI job + locally via `npm run
// fitness:db`). They assume migrations have been applied (the db job runs the
// runner ×2 before this suite).
//
// FF-ER1: effect_resource is a tenant table — present, tenant_id-leading PK,
//         ENABLE+FORCE RLS, choros_app DML grant, kind CHECK enumerates the
//         closed EffectKind set, NO cross-table FK (self-contained PK table).
// FF-ER2: cross-tenant isolation — an effect_resource row written under TENANT_A
//         is invisible to a session bound to TENANT_B from the choros_app role
//         (NOBYPASSRLS): red without RLS, green with FORCE.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  appUrl,
  migratorUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  uuid,
} from './_helpers.js';

const TABLE = 'effect_resource';

describe('FF-ER1: effect_resource is a well-formed tenant table', () => {
  it('the table exists in choros', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT 1 FROM information_schema.tables
           WHERE table_schema='choros' AND table_name=$1`,
        [TABLE],
      );
      expect(rows.length, `choros.${TABLE} missing`).toBe(1);
    });
  });

  it('has ENABLE + FORCE row level security', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT relrowsecurity, relforcerowsecurity
           FROM pg_class cls JOIN pg_namespace ns ON cls.relnamespace = ns.oid
          WHERE ns.nspname='choros' AND cls.relname=$1`,
        [TABLE],
      );
      expect(rows.length, 'table not found in pg_class').toBeGreaterThan(0);
      expect(rows[0].relrowsecurity, 'ENABLE RLS').toBe(true);
      expect(rows[0].relforcerowsecurity, 'FORCE RLS').toBe(true);
    });
  });

  it('primary key leads with tenant_id', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT att.attname AS first_col
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN pg_attribute att ON att.attrelid = con.conrelid
                                 AND att.attnum = con.conkey[1]
          WHERE ns.nspname='choros' AND cls.relname=$1 AND con.contype='p'`,
        [TABLE],
      );
      expect(rows.length, 'no PK found').toBeGreaterThan(0);
      expect(rows[0].first_col).toBe('tenant_id');
    });
  });

  it('carries NO foreign key (self-contained PK table — T-0017 FK lesson)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT con.conname
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
          WHERE ns.nspname='choros' AND cls.relname=$1 AND con.contype='f'`,
        [TABLE],
      );
      expect(rows).toEqual([]);
    });
  });

  it('kind CHECK enumerates exactly the closed EffectKind set', async () => {
    // A valid kind inserts; an out-of-set kind is rejected by the CHECK.
    await withClient(migratorUrl(), async (c) => {
      // Valid kind — should succeed.
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(
        `INSERT INTO choros.effect_resource
           (tenant_id, id, kind, scope, metadata, created_at)
         VALUES ($1, $2, 'integration_endpoint', '{}'::jsonb, NULL, 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, uuid()],
      );
      await c.query('COMMIT');

      // Invalid kind — must be rejected with check_violation (23514).
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(
          `INSERT INTO choros.effect_resource
             (tenant_id, id, kind, scope, metadata, created_at)
           VALUES ($1, $2, 'unknown_kind', '{}'::jsonb, NULL, 0)`,
          [TENANT_A, uuid()],
        ),
      ).rejects.toMatchObject({ code: '23514' }); // check_violation
      await c.query('ROLLBACK');
    });
  });

  it('choros_app holds SELECT/INSERT/UPDATE/DELETE on the table', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema='choros' AND table_name=$1 AND grantee='choros_app'
          ORDER BY privilege_type`,
        [TABLE],
      );
      const privs = rows.map((r: { privilege_type: string }) => r.privilege_type).sort();
      expect(privs).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });
  });
});

describe('FF-ER2: cross-tenant isolation of an effect_resource row', () => {
  // Stable resource id seeded under TENANT_A in beforeAll.
  const resourceIdA = uuid();

  beforeAll(async () => {
    // Seed one effect_resource row under TENANT_A (migrator bypasses RLS for the write).
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.effect_resource
           (tenant_id, id, kind, scope, metadata, created_at)
         VALUES ($1, $2, 'messaging_channel', '{}'::jsonb, NULL, 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, resourceIdA],
      );
      await c.query('COMMIT');
    });
  });

  it('a TENANT_A effect_resource row is invisible to a TENANT_B-bound choros_app session', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.effect_resource
           WHERE tenant_id = $1 AND id = $2`,
        [TENANT_A, resourceIdA],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'TENANT_A effect_resource row leaked to TENANT_B').toBe(0);
    });
  });

  it('the same TENANT_A row IS visible to a TENANT_A-bound session (RLS lets own tenant through)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.effect_resource
           WHERE id = $1`,
        [resourceIdA],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'own-tenant effect_resource row must be visible').toBe(1);
    });
  });

  it('cross-tenant SELECT with explicit WHERE tenant_id=TENANT_A returns 0 rows when context=TENANT_B', async () => {
    // This specifically validates the RLS FORCE policy: even when the WHERE clause
    // targets TENANT_A, the RLS policy blocks the read from TENANT_B context.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.effect_resource
           WHERE tenant_id = $1`,
        [TENANT_A],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'FORCE RLS must block cross-tenant reads').toBe(0);
    });
  });
});
