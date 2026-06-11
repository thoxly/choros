// T-0072 · AC-1 / AC-2 / NF-3 — form_binding schema + cross-tenant isolation.
//
// Live Postgres probes (run in the `db` CI job + locally via `npm run fitness:db`).
// Requires migrations applied (including 045_form_binding.sql).
//
// AC-1: form_binding table exists; ENABLE+FORCE RLS; UNIQUE(tenant_id,process_key,form_key);
//       choros_app DML grant; dev-seed row exists and is idempotent (re-applying
//       the migration's ON CONFLICT DO NOTHING produces no error).
//
// AC-2 / NF-3: cross-tenant isolation — a form_binding row written under TENANT_A
//              is invisible (SELECT returns 0 rows) to a choros_app session bound
//              to TENANT_B (NOBYPASSRLS + FORCE RLS).
//
// AC-11: dev-seed row is present for the dev tenant with keys supplier/category/decision.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  appUrl,
  migratorUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  uuid,
} from './_helpers.js';

const TABLE = 'form_binding';
const DEV_TENANT = '00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// AC-1: schema shape
// ---------------------------------------------------------------------------

describe('AC-1 / FF-FB1: form_binding is a well-formed tenant table', () => {
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
      expect(rows[0].relrowsecurity, 'ENABLE RLS must be true').toBe(true);
      expect(rows[0].relforcerowsecurity, 'FORCE RLS must be true').toBe(true);
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

  it('has UNIQUE (tenant_id, process_key, form_key) constraint', async () => {
    await withClient(migratorUrl(), async (c) => {
      // Check for a unique constraint that covers all three columns.
      // pg client returns PostgreSQL arrays as strings: "{col1,col2,...}".
      // We query each column name individually for reliability.
      const { rows } = await c.query(
        `SELECT con.conname,
                count(*) FILTER (WHERE att.attname = 'tenant_id')  AS has_tenant_id,
                count(*) FILTER (WHERE att.attname = 'process_key') AS has_process_key,
                count(*) FILTER (WHERE att.attname = 'form_key')   AS has_form_key,
                count(*) AS total_cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN pg_attribute att ON att.attrelid = con.conrelid
                                 AND att.attnum = ANY(con.conkey)
          WHERE ns.nspname='choros' AND cls.relname=$1 AND con.contype='u'
          GROUP BY con.conname`,
        [TABLE],
      );
      const naturalKey = rows.find((r: {
        has_tenant_id: string; has_process_key: string; has_form_key: string; total_cols: string;
      }) =>
        Number(r.has_tenant_id) === 1 &&
        Number(r.has_process_key) === 1 &&
        Number(r.has_form_key) === 1 &&
        Number(r.total_cols) === 3,
      );
      expect(naturalKey, 'UNIQUE(tenant_id, process_key, form_key) not found').toBeDefined();
    });
  });

  it('choros_app has SELECT, INSERT, UPDATE, DELETE grants', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT privilege_type
           FROM information_schema.role_table_grants
          WHERE table_schema='choros' AND table_name=$1 AND grantee='choros_app'`,
        [TABLE],
      );
      const privs = rows.map((r: { privilege_type: string }) => r.privilege_type);
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(privs, `choros_app missing ${p} privilege`).toContain(p);
      }
    });
  });

  it('migration is idempotent — dev-seed ON CONFLICT DO NOTHING does not error on re-insert', async () => {
    // Re-insert the dev-seed row; ON CONFLICT DO NOTHING must succeed silently.
    await withClient(migratorUrl(), async (c) => {
      await c.query(`SET search_path TO choros`);
      await expect(
        c.query(
          `INSERT INTO choros.form_binding
             (tenant_id, id, process_key, form_key, fields, version, created_at, updated_at)
           VALUES (
             '00000000-0000-0000-0000-000000000001',
             '0072feed-0000-0000-0000-000000000001',
             'purchase-approval',
             'purchase-form',
             '[{"key":"supplier","type":"string","required":true,"label":"Supplier"}]'::jsonb,
             1, 0, 0
           )
           ON CONFLICT DO NOTHING`,
        ),
      ).resolves.not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// AC-11: dev-seed content
// ---------------------------------------------------------------------------

describe('AC-11: dev-seed row contains supplier/category/decision fields', () => {
  it('dev-tenant purchase-form binding has all three field keys', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT fields FROM choros.form_binding
          WHERE tenant_id = $1
            AND process_key = 'purchase-approval'
            AND form_key = 'purchase-form'`,
        [DEV_TENANT],
      );
      expect(rows.length, 'dev-seed row missing').toBeGreaterThan(0);
      const bindingFields = rows[0].fields as Array<{ key: string }>;
      const keys = bindingFields.map((f) => f.key);
      expect(keys).toContain('supplier');
      expect(keys).toContain('category');
      expect(keys).toContain('decision');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-2 / NF-3: cross-tenant isolation (choros_app NOBYPASSRLS)
// ---------------------------------------------------------------------------

describe('AC-2 / NF-3 / FF-FB2: cross-tenant isolation — form_binding row invisible across tenants', () => {
  let rowIdA: string;

  beforeAll(async () => {
    // Seed a form_binding row under TENANT_A via migrator (bypasses RLS).
    // Use uuid-based process_key + form_key to guarantee uniqueness across
    // repeated test runs (avoids the (tenant_id, process_key, form_key) UNIQUE
    // constraint silently skipping the insert on re-runs).
    rowIdA = uuid();
    const procKey = `ct-proc-fb-${rowIdA.slice(0, 8)}`;
    const formKey = `ct-form-fb-${rowIdA.slice(0, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.form_binding
           (tenant_id, id, process_key, form_key, fields, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4,
                 '[{"key":"ctKey","type":"string","required":false}]'::jsonb,
                 1, 0, 0)`,
        [TENANT_A, rowIdA, procKey, formKey],
      );
    });
  });

  it('TENANT_A row is visible from TENANT_A context (choros_app)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT id FROM choros.form_binding WHERE id = $1`,
        [rowIdA],
      );
      await c.query('COMMIT');
      expect(rows.length, 'TENANT_A row should be visible from TENANT_A context').toBe(1);
    });
  });

  it('TENANT_A row is NOT visible from TENANT_B context (choros_app, NOBYPASSRLS)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT id FROM choros.form_binding WHERE id = $1`,
        [rowIdA],
      );
      await c.query('COMMIT');
      expect(rows.length, 'TENANT_A row must not be visible from TENANT_B context').toBe(0);
    });
  });

  it('SELECT without WHERE from TENANT_B context returns 0 TENANT_A rows', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT tenant_id FROM choros.form_binding`,
      );
      await c.query('COMMIT');
      const tenantALeaks = rows.filter((r: { tenant_id: string }) => r.tenant_id === TENANT_A);
      expect(tenantALeaks.length, 'TENANT_A rows must not leak to TENANT_B context').toBe(0);
    });
  });
});
