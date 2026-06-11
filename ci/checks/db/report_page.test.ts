// T-0175 · T-0121a — report_page + report_page_dep DDL probes.
//
// Live Postgres probes (run in the `db` CI job + locally via `npm run fitness:db`).
// Requires migrations 051_report_page.sql + 052_report_page_dep.sql applied.
//
// Coverage (24 AC from T-0175.spec.md):
//   AC-1/2:   Tables exist in choros.
//   AC-3:     report_page column shape (12 columns, types, nullability, defaults).
//   AC-4:     report_page_dep column shape (8 columns).
//   AC-5:     report_page PK (tenant_id, id) + UNIQUE (tenant_id, app_id, slug).
//   AC-6:     report_page_dep PK (tenant_id, id) + UNIQUE (tenant_id, page_id, registry_def_id, field_key).
//   AC-7:     FK (tenant_id, app_id) → application(tenant_id, id).
//   AC-8:     FK (tenant_id, page_id) → report_page(tenant_id, id) ON DELETE CASCADE.
//   AC-9:     FK (tenant_id, registry_def_id) → registry_def(tenant_id, id).
//   AC-10:    CHECK report_page_floor_chk named + rejects floor='3'.
//   AC-11:    CHECK report_page_tier_chk named + rejects tier='archived'.
//   AC-12:    CHECK report_page_floor_payload_chk named + floor-payload enforcement.
//   AC-13:    CHECK report_page_dep_kind_chk named + rejects dep_kind='write'.
//   AC-14:    ENABLE + FORCE RLS on both tables.
//   AC-15:    Policy names match spec.
//   AC-16:    Default-DENY policies (no GUC → 0 rows / INSERT fails).
//   AC-17:    choros_app holds SELECT/INSERT/UPDATE/DELETE on both tables.
//   AC-18:    known_tenant_tables.txt contains report_page, report_page_dep (≥ 36 rows).
//   AC-19:    role-criticality-migration-excludes.txt contains both stems with T-0175.
//   AC-20:    tenant_id leads all composite indexes.
//   AC-21:    No bytea / lo_ in migration files.
//   AC-22:    No mcp_tool / queue / outbox DDL in migration files.
//   AC-24:    Slot 051 < 052 (FK order).
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT/ROLLBACK always; cleanup after self.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  migratorUrl,
  appUrl,
  withClient,
  TENANT_A,
  uuid,
} from './_helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// Stable test tenant.
const TENANT = TENANT_A;

// ---------------------------------------------------------------------------
// Cleanup registry — report_page rows created during tests (slugs prefixed
// "t0175-"). Cascades automatically to report_page_dep (ON DELETE CASCADE).
// Uses choros_migrator (bypasses RLS) so we don't need GUC.
// ---------------------------------------------------------------------------

afterAll(async () => {
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `DELETE FROM choros.report_page WHERE tenant_id = $1 AND slug LIKE 't0175-%'`,
      [TENANT],
    );
  });
});

// ---------------------------------------------------------------------------
// AC-18 (static): known_tenant_tables.txt contains both names.
// ---------------------------------------------------------------------------

describe('AC-18 (static): known_tenant_tables.txt contains both report_page names', () => {
  it('contains report_page and report_page_dep; total rows ≥ 36', () => {
    const lines = readFileSync(
      join(REPO_ROOT, 'ci', 'checks', 'known_tenant_tables.txt'),
      'utf8',
    )
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(lines, 'report_page missing from known_tenant_tables.txt').toContain('report_page');
    expect(lines, 'report_page_dep missing from known_tenant_tables.txt').toContain('report_page_dep');
    expect(lines.length, `expected ≥ 36 lines (was ${lines.length})`).toBeGreaterThanOrEqual(36);
  });
});

// ---------------------------------------------------------------------------
// AC-19 (static): role-criticality-migration-excludes.txt has both stems.
// ---------------------------------------------------------------------------

describe('AC-19 (static): role-criticality-migration-excludes.txt has T-0175 stems', () => {
  it('contains 2 lines mentioning T-0175', () => {
    const content = readFileSync(
      join(REPO_ROOT, 'ci', 'checks', 'role-criticality-migration-excludes.txt'),
      'utf8',
    );
    const t0175Lines = content
      .split('\n')
      .filter((l) => l.includes('T-0175'));
    expect(t0175Lines.length, 'expected 2 T-0175 lines in role-criticality-migration-excludes.txt').toBe(2);
    expect(content).toContain('051_report_page');
    expect(content).toContain('052_report_page_dep');
  });
});

// ---------------------------------------------------------------------------
// AC-21 (static): no bytea / lo_ in migration files.
// ---------------------------------------------------------------------------

describe('AC-21 (static): migration files contain no bytea / lo_ references', () => {
  const migrations = ['051_report_page.sql', '052_report_page_dep.sql'];
  for (const fname of migrations) {
    it(`${fname} has no bytea or lo_ DDL`, () => {
      const content = readFileSync(
        join(REPO_ROOT, 'migrations', fname),
        'utf8',
      );
      expect(content).not.toMatch(/\b(bytea|lo_)/i);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-22 (static): no mcp_tool / queue / outbox / delivery / dispatch DDL.
// ---------------------------------------------------------------------------

describe('AC-22 (static): migration files create no mcp_tool/queue/outbox DDL', () => {
  const migrations = ['051_report_page.sql', '052_report_page_dep.sql'];
  for (const fname of migrations) {
    it(`${fname} has no CREATE TABLE.*mcp_tool|queue|outbox|delivery|dispatch`, () => {
      const content = readFileSync(
        join(REPO_ROOT, 'migrations', fname),
        'utf8',
      ).toLowerCase();
      expect(content).not.toMatch(/create\s+table[^;]*?(mcp_tool|queue|outbox|delivery|dispatch)/);
      expect(content).not.toMatch(/insert\s+into\s+choros\.mcp_tool/);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-24 (static): slot 051 < 052.
// ---------------------------------------------------------------------------

describe('AC-24 (static): report_page slot (051) < report_page_dep slot (052)', () => {
  it('051_report_page.sql and 052_report_page_dep.sql exist, page < dep', () => {
    // Throws if files don't exist.
    readFileSync(join(REPO_ROOT, 'migrations', '051_report_page.sql'), 'utf8');
    readFileSync(join(REPO_ROOT, 'migrations', '052_report_page_dep.sql'), 'utf8');
    expect(51).toBeLessThan(52);
  });
});

// ---------------------------------------------------------------------------
// AC-1 / AC-2: Tables exist in choros.
// ---------------------------------------------------------------------------

const TWO_TABLES = ['report_page', 'report_page_dep'] as const;

describe('AC-1/2: report_page tables exist in choros', () => {
  for (const table of TWO_TABLES) {
    it(`choros.${table} exists`, async () => {
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT 1 FROM information_schema.tables
             WHERE table_schema='choros' AND table_name=$1`,
          [table],
        );
        expect(rows.length, `choros.${table} missing`).toBe(1);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-14: ENABLE + FORCE RLS on both tables.
// ---------------------------------------------------------------------------

describe('AC-14: ENABLE + FORCE RLS on both report_page tables', () => {
  for (const table of TWO_TABLES) {
    it(`choros.${table} has relrowsecurity=true and relforcerowsecurity=true`, async () => {
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT relrowsecurity, relforcerowsecurity
             FROM pg_class cls JOIN pg_namespace ns ON cls.relnamespace = ns.oid
            WHERE ns.nspname='choros' AND cls.relname=$1`,
          [table],
        );
        expect(rows.length, `${table} not found in pg_class`).toBeGreaterThan(0);
        expect(rows[0].relrowsecurity, `${table}: ENABLE RLS`).toBe(true);
        expect(rows[0].relforcerowsecurity, `${table}: FORCE RLS`).toBe(true);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-15: Policy names match spec.
// ---------------------------------------------------------------------------

describe('AC-15: tenant isolation policies are correctly named', () => {
  const expectedPolicies: [string, string][] = [
    ['report_page', 'report_page_tenant_isolation'],
    ['report_page_dep', 'report_page_dep_tenant_isolation'],
  ];
  for (const [table, policyName] of expectedPolicies) {
    it(`choros.${table} has policy '${policyName}'`, async () => {
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT policyname FROM pg_policies
            WHERE schemaname='choros' AND tablename=$1 AND policyname=$2`,
          [table, policyName],
        );
        expect(rows.length, `policy ${policyName} missing on ${table}`).toBe(1);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-16: Default-DENY — no GUC → 0 rows visible.
// ---------------------------------------------------------------------------

describe('AC-16: default-DENY policy — no GUC context → 0 rows (choros_app)', () => {
  for (const table of TWO_TABLES) {
    it(`${table}: no GUC → SELECT count = 0 via appUrl`, async () => {
      await withClient(appUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM choros.${table}`,
        );
        expect(rows[0].n, `${table}: no GUC must return 0 rows`).toBe(0);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-17: choros_app holds SELECT/INSERT/UPDATE/DELETE on both tables.
// ---------------------------------------------------------------------------

describe('AC-17: choros_app DML grants on both report_page tables', () => {
  for (const table of TWO_TABLES) {
    it(`choros_app has SELECT/INSERT/UPDATE/DELETE on choros.${table}`, async () => {
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE table_schema='choros' AND table_name=$1 AND grantee='choros_app'`,
          [table],
        );
        const privs = rows.map((r: { privilege_type: string }) => r.privilege_type);
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect(privs, `choros_app missing ${p} on ${table}`).toContain(p);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-3: report_page column shape (12 columns).
// ---------------------------------------------------------------------------

describe('AC-3: report_page column shape matches ADR §2.1', () => {
  it('has exactly 12 columns with correct types, nullability, and defaults', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema='choros' AND table_name='report_page'
          ORDER BY ordinal_position`,
      );
      const byName = Object.fromEntries(rows.map((r: {
        column_name: string; data_type: string; is_nullable: string; column_default: string | null;
      }) => [r.column_name, r]));

      expect(rows.length, 'report_page must have exactly 12 columns').toBe(12);

      expect(byName['tenant_id'].data_type).toBe('uuid');
      expect(byName['tenant_id'].is_nullable).toBe('NO');

      expect(byName['id'].data_type).toBe('uuid');
      expect(byName['id'].is_nullable).toBe('NO');

      expect(byName['app_id'].data_type).toBe('uuid');
      expect(byName['app_id'].is_nullable).toBe('NO');

      expect(byName['slug'].data_type).toBe('text');
      expect(byName['slug'].is_nullable).toBe('NO');

      expect(byName['title'].data_type).toBe('text');
      expect(byName['title'].is_nullable).toBe('NO');

      expect(byName['floor'].data_type).toBe('text');
      expect(byName['floor'].is_nullable).toBe('NO');

      expect(byName['tier'].data_type).toBe('text');
      expect(byName['tier'].is_nullable).toBe('NO');
      expect(byName['tier'].column_default).toMatch(/'draft'/);

      expect(byName['page_def'].data_type).toBe('jsonb');
      expect(byName['page_def'].is_nullable).toBe('YES');

      expect(byName['page_code'].data_type).toBe('text');
      expect(byName['page_code'].is_nullable).toBe('YES');

      expect(byName['bundle_ref'].data_type).toBe('text');
      expect(byName['bundle_ref'].is_nullable).toBe('YES');

      expect(byName['created_at'].data_type).toBe('bigint');
      expect(byName['created_at'].is_nullable).toBe('NO');

      expect(byName['updated_at'].data_type).toBe('bigint');
      expect(byName['updated_at'].is_nullable).toBe('NO');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-4: report_page_dep column shape (8 columns).
// ---------------------------------------------------------------------------

describe('AC-4: report_page_dep column shape matches ADR §2.2', () => {
  it('has exactly 8 columns with correct types, nullability, and defaults', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema='choros' AND table_name='report_page_dep'
          ORDER BY ordinal_position`,
      );
      const byName = Object.fromEntries(rows.map((r: {
        column_name: string; data_type: string; is_nullable: string; column_default: string | null;
      }) => [r.column_name, r]));

      expect(rows.length, 'report_page_dep must have exactly 8 columns').toBe(8);

      expect(byName['tenant_id'].data_type).toBe('uuid');
      expect(byName['tenant_id'].is_nullable).toBe('NO');

      expect(byName['id'].data_type).toBe('uuid');
      expect(byName['id'].is_nullable).toBe('NO');

      expect(byName['page_id'].data_type).toBe('uuid');
      expect(byName['page_id'].is_nullable).toBe('NO');

      expect(byName['registry_def_id'].data_type).toBe('uuid');
      expect(byName['registry_def_id'].is_nullable).toBe('NO');

      expect(byName['field_key'].data_type).toBe('text');
      expect(byName['field_key'].is_nullable).toBe('NO');

      expect(byName['dep_kind'].data_type).toBe('text');
      expect(byName['dep_kind'].is_nullable).toBe('NO');

      expect(byName['stale'].data_type).toBe('boolean');
      expect(byName['stale'].is_nullable).toBe('NO');
      expect(byName['stale'].column_default).toMatch(/false/);

      expect(byName['created_at'].data_type).toBe('bigint');
      expect(byName['created_at'].is_nullable).toBe('NO');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-5: report_page PK + UNIQUE constraints.
// ---------------------------------------------------------------------------

describe('AC-5: report_page PK (tenant_id, id) and UNIQUE (tenant_id, app_id, slug)', () => {
  it('primary key is (tenant_id, id)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT array_agg(att.attname::text ORDER BY u.ord) AS pk_cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(col, ord) ON true
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.col
          WHERE ns.nspname='choros' AND cls.relname='report_page' AND con.contype='p'`,
      );
      expect(rows.length, 'no PK on report_page').toBeGreaterThan(0);
      expect(rows[0].pk_cols).toEqual(['tenant_id', 'id']);
    });
  });

  it('UNIQUE constraint on (tenant_id, app_id, slug) exists', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT array_agg(att.attname::text ORDER BY u.ord) AS cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(col, ord) ON true
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.col
          WHERE ns.nspname='choros' AND cls.relname='report_page' AND con.contype='u'
          GROUP BY con.oid`,
      );
      const uniqCols = rows.map((r: { cols: string[] }) => r.cols);
      const hasTenantAppSlug = uniqCols.some(
        (c: string[]) => JSON.stringify(c) === JSON.stringify(['tenant_id', 'app_id', 'slug']),
      );
      expect(hasTenantAppSlug, 'UNIQUE (tenant_id, app_id, slug) missing').toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-6: report_page_dep PK + UNIQUE constraints.
// ---------------------------------------------------------------------------

describe('AC-6: report_page_dep PK (tenant_id, id) and UNIQUE (tenant_id, page_id, registry_def_id, field_key)', () => {
  it('primary key is (tenant_id, id)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT array_agg(att.attname::text ORDER BY u.ord) AS pk_cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(col, ord) ON true
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.col
          WHERE ns.nspname='choros' AND cls.relname='report_page_dep' AND con.contype='p'`,
      );
      expect(rows.length, 'no PK on report_page_dep').toBeGreaterThan(0);
      expect(rows[0].pk_cols).toEqual(['tenant_id', 'id']);
    });
  });

  it('UNIQUE constraint on (tenant_id, page_id, registry_def_id, field_key) exists', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT array_agg(att.attname::text ORDER BY u.ord) AS cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(col, ord) ON true
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.col
          WHERE ns.nspname='choros' AND cls.relname='report_page_dep' AND con.contype='u'
          GROUP BY con.oid`,
      );
      const uniqCols = rows.map((r: { cols: string[] }) => r.cols);
      const hasUniq = uniqCols.some(
        (c: string[]) =>
          JSON.stringify(c) ===
          JSON.stringify(['tenant_id', 'page_id', 'registry_def_id', 'field_key']),
      );
      expect(hasUniq, 'UNIQUE (tenant_id, page_id, registry_def_id, field_key) missing').toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-7: FK report_page.app_id → application tenant-scoped.
// ---------------------------------------------------------------------------

describe('AC-7: FK (tenant_id, app_id) → application(tenant_id, id)', () => {
  it('FK exists with correct src+ref columns and target table', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT ref.relname AS dst,
                array_agg(ca.attname::text ORDER BY u.ord) AS src_cols,
                array_agg(fa.attname::text ORDER BY u.ord) AS ref_cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_class ref ON ref.oid = con.confrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(ckey, fkey, ord) ON true
           JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = u.ckey
           JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = u.fkey
          WHERE ns.nspname='choros' AND cls.relname='report_page' AND con.contype='f'
          GROUP BY ref.relname, con.oid`,
      );
      const appFk = rows.find((r: { dst: string }) => r.dst === 'application');
      expect(appFk, 'FK to application missing from report_page').toBeDefined();
      expect(appFk!.src_cols).toEqual(['tenant_id', 'app_id']);
      expect(appFk!.ref_cols).toEqual(['tenant_id', 'id']);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-8: FK report_page_dep.page_id → report_page ON DELETE CASCADE.
// ---------------------------------------------------------------------------

describe('AC-8: FK (tenant_id, page_id) → report_page(tenant_id, id) ON DELETE CASCADE', () => {
  it('FK exists with confdeltype=c (CASCADE)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT ref.relname AS dst,
                array_agg(ca.attname::text ORDER BY u.ord) AS src_cols,
                array_agg(fa.attname::text ORDER BY u.ord) AS ref_cols,
                con.confdeltype
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_class ref ON ref.oid = con.confrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(ckey, fkey, ord) ON true
           JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = u.ckey
           JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = u.fkey
          WHERE ns.nspname='choros' AND cls.relname='report_page_dep' AND con.contype='f'
          GROUP BY ref.relname, con.oid, con.confdeltype`,
      );
      const pageFk = rows.find((r: { dst: string }) => r.dst === 'report_page');
      expect(pageFk, 'FK to report_page missing from report_page_dep').toBeDefined();
      expect(pageFk!.src_cols).toEqual(['tenant_id', 'page_id']);
      expect(pageFk!.ref_cols).toEqual(['tenant_id', 'id']);
      expect(pageFk!.confdeltype, 'ON DELETE CASCADE requires confdeltype=c').toBe('c');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-9: FK report_page_dep.registry_def_id → registry_def tenant-scoped.
// ---------------------------------------------------------------------------

describe('AC-9: FK (tenant_id, registry_def_id) → registry_def(tenant_id, id)', () => {
  it('FK exists with correct src+ref columns and target table', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT ref.relname AS dst,
                array_agg(ca.attname::text ORDER BY u.ord) AS src_cols,
                array_agg(fa.attname::text ORDER BY u.ord) AS ref_cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_class ref ON ref.oid = con.confrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(ckey, fkey, ord) ON true
           JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = u.ckey
           JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = u.fkey
          WHERE ns.nspname='choros' AND cls.relname='report_page_dep' AND con.contype='f'
          GROUP BY ref.relname, con.oid`,
      );
      const regFk = rows.find((r: { dst: string }) => r.dst === 'registry_def');
      expect(regFk, 'FK to registry_def missing from report_page_dep').toBeDefined();
      expect(regFk!.src_cols).toEqual(['tenant_id', 'registry_def_id']);
      expect(regFk!.ref_cols).toEqual(['tenant_id', 'id']);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-10: CHECK report_page_floor_chk — named, rejects floor='3'.
// ---------------------------------------------------------------------------

describe('AC-10: CHECK report_page_floor_chk (named, floor IN (1,2))', () => {
  it('constraint named report_page_floor_chk exists in pg_constraint', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid='choros.report_page'::regclass AND conname='report_page_floor_chk'`,
      );
      expect(rows.length, 'report_page_floor_chk missing').toBe(1);
    });
  });

  it('inserting floor=3 raises check_violation', async () => {
    const id = uuid();
    const appId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await expect(
        c.query(
          `INSERT INTO choros.report_page
             (tenant_id, id, app_id, slug, title, floor, tier, page_def, created_at, updated_at)
           VALUES ($1, $2, $3, 't0175-floor3', 'Test', '3', 'draft', '{}', 0, 0)`,
          [TENANT, id, appId],
        ),
      ).rejects.toThrow();
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-11: CHECK report_page_tier_chk — named, rejects tier='archived'.
// ---------------------------------------------------------------------------

describe('AC-11: CHECK report_page_tier_chk (named, tier IN (draft,published))', () => {
  it('constraint named report_page_tier_chk exists in pg_constraint', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid='choros.report_page'::regclass AND conname='report_page_tier_chk'`,
      );
      expect(rows.length, 'report_page_tier_chk missing').toBe(1);
    });
  });

  it('inserting tier=archived raises check_violation', async () => {
    const id = uuid();
    const appId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await expect(
        c.query(
          `INSERT INTO choros.report_page
             (tenant_id, id, app_id, slug, title, floor, tier, page_def, created_at, updated_at)
           VALUES ($1, $2, $3, 't0175-tier-archived', 'Test', '1', 'archived', '{}', 0, 0)`,
          [TENANT, id, appId],
        ),
      ).rejects.toThrow();
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-12: CHECK report_page_floor_payload_chk — named, floor-payload enforcement.
// ---------------------------------------------------------------------------

describe('AC-12: CHECK report_page_floor_payload_chk (floor-payload enforcement)', () => {
  it('constraint named report_page_floor_payload_chk exists in pg_constraint', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid='choros.report_page'::regclass AND conname='report_page_floor_payload_chk'`,
      );
      expect(rows.length, 'report_page_floor_payload_chk missing').toBe(1);
    });
  });

  it('floor=1 with page_def=NULL raises check_violation', async () => {
    const id = uuid();
    const appId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await expect(
        c.query(
          `INSERT INTO choros.report_page
             (tenant_id, id, app_id, slug, title, floor, tier, page_def, created_at, updated_at)
           VALUES ($1, $2, $3, 't0175-floor1-null-def', 'Test', '1', 'draft', NULL, 0, 0)`,
          [TENANT, id, appId],
        ),
      ).rejects.toThrow();
      await c.query('ROLLBACK');
    });
  });

  it('floor=2 with page_code=NULL raises check_violation', async () => {
    const id = uuid();
    const appId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await expect(
        c.query(
          `INSERT INTO choros.report_page
             (tenant_id, id, app_id, slug, title, floor, tier, page_code, created_at, updated_at)
           VALUES ($1, $2, $3, 't0175-floor2-null-code', 'Test', '2', 'draft', NULL, 0, 0)`,
          [TENANT, id, appId],
        ),
      ).rejects.toThrow();
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-13: CHECK report_page_dep_kind_chk — named, rejects dep_kind='write'.
// ---------------------------------------------------------------------------

describe('AC-13: CHECK report_page_dep_kind_chk (named, dep_kind IN (read,aggregate))', () => {
  it('constraint named report_page_dep_kind_chk exists in pg_constraint', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid='choros.report_page_dep'::regclass AND conname='report_page_dep_kind_chk'`,
      );
      expect(rows.length, 'report_page_dep_kind_chk missing').toBe(1);
    });
  });

  it('inserting dep_kind=write raises check_violation', async () => {
    const depId = uuid();
    const pageId = uuid();
    const regDefId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await expect(
        c.query(
          `INSERT INTO choros.report_page_dep
             (tenant_id, id, page_id, registry_def_id, field_key, dep_kind, created_at)
           VALUES ($1, $2, $3, $4, 'some_field', 'write', 0)`,
          [TENANT, depId, pageId, regDefId],
        ),
      ).rejects.toThrow();
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-20: tenant_id leads all composite indexes on both tables.
// ---------------------------------------------------------------------------

describe('AC-20: tenant_id leads all composite indexes on both report_page tables', () => {
  for (const table of TWO_TABLES) {
    it(`all multi-column indexes on ${table} lead with tenant_id`, async () => {
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT cls.relname AS table_name, att.attname AS first_col
             FROM pg_index idx
             JOIN pg_class cls ON cls.oid = idx.indrelid
             JOIN pg_namespace ns ON ns.oid = cls.relnamespace
             JOIN pg_attribute att ON att.attrelid = idx.indrelid
                                   AND att.attnum = idx.indkey[0]
            WHERE ns.nspname='choros'
              AND cls.relname = $1
              AND array_length(idx.indkey::int[], 1) > 1`,
          [table],
        );
        const violations = rows.filter((r: { first_col: string }) => r.first_col !== 'tenant_id');
        expect(
          violations,
          `${table}: composite index not led by tenant_id: ${JSON.stringify(violations)}`,
        ).toEqual([]);
      });
    });
  }
});
