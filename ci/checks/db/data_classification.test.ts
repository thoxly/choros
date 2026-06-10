// T-0033 · FF-DC1 / FF-DC2 — data_classification schema + cross-tenant isolation.
//
// Live Postgres probes (run in the `db` CI job + locally via `npm run
// fitness:db`). They assume migrations have been applied (the db job runs the
// runner ×2 before this suite).
//
// FF-DC1: data_classification is a tenant table — present, tenant_id-leading PK,
//         ENABLE+FORCE RLS, choros_app DML grant, class CHECK enumerates the
//         closed DataClass set, NO cross-table FK (logical descriptor table).
// FF-DC2: cross-tenant isolation — a class row written under TENANT_A is
//         invisible to a session bound to TENANT_B from the choros_app role
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

const TABLE = 'data_classification';

describe('FF-DC1: data_classification is a well-formed tenant table', () => {
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
      expect(rows[0].first_col).toBe('tenant_id');
    });
  });

  it('carries NO foreign key (logical descriptor table — T-0017 FK lesson)', async () => {
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

  it('class CHECK enumerates exactly the closed DataClass set', async () => {
    // A valid class inserts; an out-of-set class is rejected by the CHECK.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(
        `INSERT INTO choros.data_classification
           (tenant_id, resource_type, facet_field, facet_schema_version, class, created_at, updated_at)
         VALUES ($1, 'record', $2, 0, 'restricted', 0, 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, `dc1-ok-${uuid().slice(0, 8)}`],
      );
      await c.query('COMMIT');

      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(
          `INSERT INTO choros.data_classification
             (tenant_id, resource_type, facet_field, facet_schema_version, class, created_at, updated_at)
           VALUES ($1, 'record', $2, 0, 'top-secret', 0, 0)`,
          [TENANT_A, `dc1-bad-${uuid().slice(0, 8)}`],
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
      [TABLE]);
      const privs = rows.map((r) => r.privilege_type).sort();
      expect(privs).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });
  });
});

describe('FF-DC2: cross-tenant isolation of a classification row', () => {
  const fieldA = `dc2-a-${uuid().slice(0, 8)}`;

  beforeAll(async () => {
    // Seed one class row under TENANT_A (migrator bypasses RLS for the write).
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.data_classification
           (tenant_id, resource_type, facet_field, facet_schema_version, class, created_at, updated_at)
         VALUES ($1, 'record', $2, 0, 'confidential', 0, 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, fieldA],
      );
      await c.query('COMMIT');
    });
  });

  it('a TENANT_A class row is invisible to a TENANT_B-bound choros_app session', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.data_classification
           WHERE tenant_id = $1 AND facet_field = $2`,
        [TENANT_A, fieldA],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'TENANT_A class row leaked to TENANT_B').toBe(0);
    });
  });

  it('the same TENANT_A row IS visible to a TENANT_A-bound session (RLS lets own tenant through)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.data_classification
           WHERE facet_field = $1`,
        [fieldA],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'own-tenant class row must be visible').toBe(1);
    });
  });
});
