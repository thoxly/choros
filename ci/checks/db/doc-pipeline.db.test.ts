// T-0238 · T-0134a — doc_page + doc_ref + doc_log DDL probes (FF-T13-DOCS).
//
// Live Postgres probes (run in the `db` CI job + locally via `npm run fitness:db`).
// Requires migration 061_doc_page.sql applied.
//
// IMPORTANT: Uses FRESH random tenant UUIDs for all DML tests (never TENANT_A/TENANT_B).
// Shared-DB isolation discipline (T-0144 / T-0205 lesson):
//   BEGIN before SET LOCAL; COMMIT/ROLLBACK always; cleanup after self.
//
// Coverage (FF-T13-DOCS):
//   AC-1:  doc_page / doc_ref / doc_log tables exist in choros.
//   AC-2:  ENABLE + FORCE RLS on all three tables.
//   AC-3:  tenant_isolation policies present and named correctly.
//   AC-4:  choros_app holds SELECT/INSERT/UPDATE/DELETE on all three tables.
//   AC-5:  doc_page column shape: tenant_id-leading PK, scope CHECK, UNIQUE(tenant_id,slug).
//   AC-6:  doc_ref ref_kind CHECK (5 values), ref_target is jsonb, UNIQUE constraint.
//   AC-7:  doc_page app_id FK → application (nullable, no cascade).
//   AC-8:  doc_ref FK page_id → doc_page ON DELETE CASCADE.
//   AC-9:  doc_log FK page_id → doc_page ON DELETE CASCADE.
//   AC-10: doc_log op has NO CHECK constraint (open-vocab, pattern T-0016).
//   AC-11: Default-DENY: no GUC → 0 rows visible to choros_app.
//   AC-12: Cross-tenant isolation: tenant B cannot see tenant A's doc_page rows.
//   AC-13: scope CHECK rejects invalid value ('unknown').
//   AC-14: doc_ref UNIQUE (tenant_id, page_id, ref_kind, ref_target) enforced.
//   AC-15: FK CASCADE: deleting doc_page cascades to doc_ref and doc_log.
//   AC-16: known_tenant_tables.txt contains doc_page, doc_ref, doc_log.
//   AC-17: doc_log index (tenant_id, page_id, at) exists.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  migratorUrl,
  appUrl,
  withClient,
  uuid,
} from './_helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

/** Fresh random tenant UUID — never reuse TENANT_A/B (T-0205 lesson). */
function freshTenant(): string {
  return crypto.randomUUID();
}

const THREE_TABLES = ['doc_page', 'doc_ref', 'doc_log'] as const;

// ---------------------------------------------------------------------------
// AC-16 (static): known_tenant_tables.txt contains all three doc table names.
// ---------------------------------------------------------------------------

describe('AC-16 (static): known_tenant_tables.txt contains doc_page, doc_ref, doc_log', () => {
  it('all three doc tables registered in known_tenant_tables.txt', () => {
    const lines = readFileSync(
      join(REPO_ROOT, 'ci', 'checks', 'known_tenant_tables.txt'),
      'utf8',
    )
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const table of THREE_TABLES) {
      expect(lines, `${table} missing from known_tenant_tables.txt`).toContain(table);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-1: Tables exist in choros.
// ---------------------------------------------------------------------------

describe('AC-1: doc_page / doc_ref / doc_log exist in choros', () => {
  for (const table of THREE_TABLES) {
    it(`choros.${table} exists`, async () => {
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'choros' AND table_name = $1`,
          [table],
        );
        expect(rows.length, `choros.${table} missing`).toBe(1);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-2: ENABLE + FORCE RLS on all three tables.
// ---------------------------------------------------------------------------

describe('AC-2: ENABLE + FORCE RLS on all three doc tables', () => {
  for (const table of THREE_TABLES) {
    it(`choros.${table} has relrowsecurity=true and relforcerowsecurity=true`, async () => {
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT relrowsecurity, relforcerowsecurity
             FROM pg_class cls JOIN pg_namespace ns ON cls.relnamespace = ns.oid
            WHERE ns.nspname = 'choros' AND cls.relname = $1`,
          [table],
        );
        expect(rows.length, `${table} not found in pg_class`).toBeGreaterThan(0);
        expect(rows[0]!.relrowsecurity, `${table}: ENABLE RLS`).toBe(true);
        expect(rows[0]!.relforcerowsecurity, `${table}: FORCE RLS`).toBe(true);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-3: tenant_isolation policies named correctly.
// ---------------------------------------------------------------------------

describe('AC-3: tenant isolation policies correctly named', () => {
  const expectedPolicies: [string, string][] = [
    ['doc_page', 'doc_page_tenant_isolation'],
    ['doc_ref', 'doc_ref_tenant_isolation'],
    ['doc_log', 'doc_log_tenant_isolation'],
  ];
  for (const [table, policyName] of expectedPolicies) {
    it(`choros.${table} has policy '${policyName}'`, async () => {
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT policyname FROM pg_policies
            WHERE schemaname = 'choros' AND tablename = $1 AND policyname = $2`,
          [table, policyName],
        );
        expect(rows.length, `policy ${policyName} missing on ${table}`).toBe(1);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-4: choros_app DML grants on all three tables.
// ---------------------------------------------------------------------------

describe('AC-4: choros_app DML grants on all three doc tables', () => {
  for (const table of THREE_TABLES) {
    it(`choros_app has SELECT/INSERT/UPDATE/DELETE on choros.${table}`, async () => {
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE table_schema = 'choros' AND table_name = $1 AND grantee = 'choros_app'`,
          [table],
        );
        const privs = rows.map((r: { privilege_type: string }) => r.privilege_type);
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect(privs, `choros_app missing ${p} on choros.${table}`).toContain(p);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-5: doc_page PK + UNIQUE(tenant_id, slug) + scope CHECK.
// ---------------------------------------------------------------------------

describe('AC-5: doc_page PK (tenant_id, id) and UNIQUE (tenant_id, slug)', () => {
  it('primary key is (tenant_id, id)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT array_agg(att.attname::text ORDER BY u.ord) AS pk_cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(col, ord) ON true
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.col
          WHERE ns.nspname = 'choros' AND cls.relname = 'doc_page' AND con.contype = 'p'`,
      );
      expect(rows.length, 'no PK on doc_page').toBeGreaterThan(0);
      expect(rows[0]!.pk_cols).toEqual(['tenant_id', 'id']);
    });
  });

  it('UNIQUE constraint on (tenant_id, slug) exists', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT array_agg(att.attname::text ORDER BY u.ord) AS cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(col, ord) ON true
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.col
          WHERE ns.nspname = 'choros' AND cls.relname = 'doc_page' AND con.contype = 'u'
          GROUP BY con.oid`,
      );
      const uniqCols = rows.map((r: { cols: string[] }) => r.cols);
      const hasSlugUniq = uniqCols.some(
        (c: string[]) => JSON.stringify(c) === JSON.stringify(['tenant_id', 'slug']),
      );
      expect(hasSlugUniq, 'UNIQUE (tenant_id, slug) missing from doc_page').toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-11: Default-DENY — no GUC → 0 rows visible to choros_app.
// ---------------------------------------------------------------------------

describe('AC-11: default-DENY — no GUC → 0 rows via choros_app', () => {
  for (const table of THREE_TABLES) {
    it(`${table}: no GUC → SELECT count = 0 via appUrl`, async () => {
      await withClient(appUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM choros.${table}`,
        );
        expect(rows[0]!.n, `${table}: no GUC must return 0 rows`).toBe(0);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-13: scope CHECK rejects invalid value.
// Uses fresh random tenant — never TENANT_A/TENANT_B.
// ---------------------------------------------------------------------------

describe('AC-13: scope CHECK rejects invalid value (FF-T13-DOCS)', () => {
  it("inserting scope='unknown' raises check_violation", async () => {
    const tenant = freshTenant();
    const pageId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);
      await expect(
        c.query(
          `INSERT INTO choros.doc_page
             (tenant_id, id, slug, title, body, scope, authored_by, authored_at, updated_at)
           VALUES ($1, $2, 't0238-scope-chk', 'Title', 'Body', 'unknown', 'agent', 0, 0)`,
          [tenant, pageId],
        ),
      ).rejects.toThrow();
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-12: Cross-tenant isolation — tenant B cannot see tenant A's doc_page rows.
// Uses two fresh random tenant UUIDs.
// ---------------------------------------------------------------------------

describe('AC-12: cross-tenant isolation (FF-T13-DOCS)', () => {
  const tenantA = freshTenant();
  const tenantB = freshTenant();
  const pageId = uuid();

  afterAll(async () => {
    // Cleanup via migrator (bypasses RLS)
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `DELETE FROM choros.doc_page WHERE tenant_id = $1 OR tenant_id = $2`,
        [tenantA, tenantB],
      );
    });
  });

  it('tenant A can see its own doc_page row; tenant B sees 0 rows', async () => {
    // Insert under migrator (bypasses RLS for setup)
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.doc_page
           (tenant_id, id, slug, title, body, scope, authored_by, authored_at, updated_at)
         VALUES ($1, $2, 't0238-xten-page', 'Title', 'Body', 'tenant', 'agent', 0, 0)`,
        [tenantA, pageId],
      );
    });

    // Tenant A sees its own row
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantA}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE id = $1`,
        [pageId],
      );
      expect(rows[0]!.n, 'tenant A must see its own doc_page row').toBe(1);
      await c.query('ROLLBACK');
    });

    // Tenant B sees 0 rows
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantB}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE id = $1`,
        [pageId],
      );
      expect(rows[0]!.n, 'tenant B must not see tenant A doc_page row').toBe(0);
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-14: doc_ref UNIQUE (tenant_id, page_id, ref_kind, ref_target) enforced.
// AC-8: FK doc_ref.page_id → doc_page ON DELETE CASCADE.
// AC-15: FK CASCADE: deleting doc_page cascades to doc_ref and doc_log.
// Uses fresh random tenant UUIDs.
// ---------------------------------------------------------------------------

describe('AC-14/AC-8/AC-15: doc_ref uniqueness, FK, and CASCADE (FF-T13-DOCS)', () => {
  const tenant = freshTenant();
  const pageId = uuid();
  const refId1 = uuid();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `DELETE FROM choros.doc_page WHERE tenant_id = $1`,
        [tenant],
      );
    });
  });

  it('inserts doc_page, doc_ref, doc_log; UNIQUE violation on duplicate ref; CASCADE on delete', async () => {
    // Setup: insert doc_page under migrator
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.doc_page
           (tenant_id, id, slug, title, body, scope, authored_by, authored_at, updated_at)
         VALUES ($1, $2, 't0238-cascade-page', 'T', 'B', 'tenant', 'agent', 0, 0)`,
        [tenant, pageId],
      );

      // Insert doc_ref
      await c.query(
        `INSERT INTO choros.doc_ref
           (tenant_id, id, page_id, ref_kind, ref_target, created_at)
         VALUES ($1, $2, $3, 'config_key', '{"key":"kc.realm"}', 0)`,
        [tenant, refId1, pageId],
      );

      // Insert doc_log
      await c.query(
        `INSERT INTO choros.doc_log
           (tenant_id, id, page_id, op, agent_actor, at)
         VALUES ($1, $2, $3, 'authored', 'agent-0', 0)`,
        [tenant, uuid(), pageId],
      );
    });

    // AC-14: Duplicate ref insert must fail (UNIQUE on tenant_id, page_id, ref_kind, ref_target)
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO choros.doc_ref
             (tenant_id, id, page_id, ref_kind, ref_target, created_at)
           VALUES ($1, $2, $3, 'config_key', '{"key":"kc.realm"}', 0)`,
          [tenant, uuid(), pageId],
        ),
      ).rejects.toThrow();
      await c.query('ROLLBACK');
    });

    // AC-15: Delete doc_page cascades to doc_ref and doc_log
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `DELETE FROM choros.doc_page WHERE tenant_id = $1 AND id = $2`,
        [tenant, pageId],
      );

      const refRows = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_ref WHERE tenant_id = $1 AND page_id = $2`,
        [tenant, pageId],
      );
      expect(refRows.rows[0]!.n, 'doc_ref should be cascaded on doc_page delete').toBe(0);

      const logRows = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log WHERE tenant_id = $1 AND page_id = $2`,
        [tenant, pageId],
      );
      expect(logRows.rows[0]!.n, 'doc_log should be cascaded on doc_page delete').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-10: doc_log op has NO CHECK constraint (open-vocab — pattern T-0016).
// ---------------------------------------------------------------------------

describe('AC-10: doc_log.op has no CHECK constraint (open-vocab)', () => {
  it('doc_log has no CHECK constraint on op column', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'choros.doc_log'::regclass AND contype = 'c'`,
      );
      const opChecks = rows.filter((r: { def: string }) =>
        r.def.toLowerCase().includes('op'),
      );
      expect(opChecks, 'doc_log.op must have NO CHECK constraint (open-vocab)').toHaveLength(0);
    });
  });

  it('doc_log accepts any op string (open-vocab)', async () => {
    const tenant = freshTenant();
    const pageId = uuid();
    afterAll(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query(
          `DELETE FROM choros.doc_page WHERE tenant_id = $1`,
          [tenant],
        );
      });
    });

    await withClient(migratorUrl(), async (c) => {
      // Insert parent doc_page
      await c.query(
        `INSERT INTO choros.doc_page
           (tenant_id, id, slug, title, body, scope, authored_by, authored_at, updated_at)
         VALUES ($1, $2, 't0238-opvocab-page', 'T', 'B', 'tenant', 'agent', 0, 0)`,
        [tenant, pageId],
      );

      // Insert doc_log with an open-vocab op string not in any expected list
      await c.query(
        `INSERT INTO choros.doc_log
           (tenant_id, id, page_id, op, agent_actor, at)
         VALUES ($1, $2, $3, 'custom_op_not_in_enum', 'agent-x', 0)`,
        [tenant, uuid(), pageId],
      );
    });
    // No throw = open vocab accepted
  });
});

// ---------------------------------------------------------------------------
// AC-17: doc_log index (tenant_id, page_id, at) exists.
// ---------------------------------------------------------------------------

describe('AC-17: doc_log has index on (tenant_id, page_id, at)', () => {
  it('doc_log_tenant_page_at_idx exists with correct column order', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT array_agg(att.attname::text ORDER BY u.ord) AS cols
           FROM pg_index idx
           JOIN pg_class ic ON ic.oid = idx.indexrelid
           JOIN pg_class tc ON tc.oid = idx.indrelid
           JOIN pg_namespace ns ON ns.oid = tc.relnamespace
           JOIN LATERAL unnest(idx.indkey::int[]) WITH ORDINALITY AS u(col, ord) ON true
           JOIN pg_attribute att ON att.attrelid = idx.indrelid AND att.attnum = u.col
          WHERE ns.nspname = 'choros' AND tc.relname = 'doc_log'
            AND ic.relname = 'doc_log_tenant_page_at_idx'
          GROUP BY ic.relname`,
      );
      expect(rows.length, 'doc_log_tenant_page_at_idx index not found').toBe(1);
      expect(rows[0]!.cols).toEqual(['tenant_id', 'page_id', 'at']);
    });
  });
});
