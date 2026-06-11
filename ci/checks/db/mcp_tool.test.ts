// T-0043 · FF-1 / FF-2 / FF-7 / FF-14 — mcp_tool schema + RLS + CHECK + idempotency.
//
// Live Postgres probes (run in the `db` CI job + locally via `npm run fitness:db`).
// Assumes migrations have been applied (the db job runs the runner ×2 before this suite).
//
// FF-1:  mcp_tool exists with PK(tenant_id,id), UNIQUE(tenant_id,name), all 9 columns,
//        and correct types (AC-1).
// FF-2:  DB CHECK mcp_tool_pure_empty_chk: declares='[]' with pure_compute=false is
//        rejected with a check_violation (AC-7).
// FF-7:  FORCE RLS + choros_app DML-only (AC-2/AC-19);
//        cross-tenant isolation: TENANT_A row is invisible to TENANT_B (AC-3/AC-4).
// FF-14: migration 040 is idempotent: verified by the CI runner running it ×2 (AC-20).

import { describe, it, expect, beforeAll } from 'vitest';
import {
  appUrl,
  migratorUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  uuid,
} from './_helpers.js';

const TABLE = 'mcp_tool';

// Stable row id seeded under TENANT_A in beforeAll.
const toolIdA = uuid();

beforeAll(async () => {
  // Seed one mcp_tool row under TENANT_A (migrator bypasses RLS for the write).
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO choros.mcp_tool
         (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, '[]'::jsonb, true, '[]'::jsonb, 0, 0)
       ON CONFLICT DO NOTHING`,
      [TENANT_A, toolIdA, `db-test-tool-${toolIdA.slice(0, 8)}`],
    );
    await c.query('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// FF-1: schema shape (AC-1)
// ---------------------------------------------------------------------------

describe('FF-1: mcp_tool is a well-formed tenant table (AC-1)', () => {
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

  it('has ENABLE + FORCE row level security (AC-2)', async () => {
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

  it('has UNIQUE constraint on (tenant_id, name)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT con.conname
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
          WHERE ns.nspname='choros' AND cls.relname=$1 AND con.contype='u'`,
        [TABLE],
      );
      expect(rows.length, 'no UNIQUE constraint found').toBeGreaterThan(0);
      // The unique constraint name should be mcp_tool_name_uniq (or similar)
      expect(rows.some((r: { conname: string }) => r.conname.includes('name_uniq') || r.conname.includes('uniq'))).toBe(true);
    });
  });

  it('all 9 FR-1 columns exist with correct types', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema='choros' AND table_name=$1
          ORDER BY ordinal_position`,
        [TABLE],
      );
      const colMap = new Map(
        rows.map((r: { column_name: string; data_type: string; is_nullable: string }) => [
          r.column_name,
          { type: r.data_type, nullable: r.is_nullable },
        ]),
      );
      // tenant_id: uuid NOT NULL
      expect(colMap.has('tenant_id')).toBe(true);
      expect(colMap.get('tenant_id')!.type).toBe('uuid');
      expect(colMap.get('tenant_id')!.nullable).toBe('NO');
      // id: uuid NOT NULL
      expect(colMap.has('id')).toBe(true);
      expect(colMap.get('id')!.type).toBe('uuid');
      expect(colMap.get('id')!.nullable).toBe('NO');
      // name: text NOT NULL
      expect(colMap.has('name')).toBe(true);
      expect(colMap.get('name')!.type).toBe('text');
      expect(colMap.get('name')!.nullable).toBe('NO');
      // description: text NULL
      expect(colMap.has('description')).toBe(true);
      expect(colMap.get('description')!.nullable).toBe('YES');
      // declares: jsonb NOT NULL
      expect(colMap.has('declares')).toBe(true);
      expect(colMap.get('declares')!.type).toBe('jsonb');
      expect(colMap.get('declares')!.nullable).toBe('NO');
      // pure_compute: boolean NOT NULL
      expect(colMap.has('pure_compute')).toBe(true);
      expect(colMap.get('pure_compute')!.type).toBe('boolean');
      expect(colMap.get('pure_compute')!.nullable).toBe('NO');
      // resource_ops: jsonb NOT NULL
      expect(colMap.has('resource_ops')).toBe(true);
      expect(colMap.get('resource_ops')!.type).toBe('jsonb');
      expect(colMap.get('resource_ops')!.nullable).toBe('NO');
      // created_at: bigint NOT NULL
      expect(colMap.has('created_at')).toBe(true);
      expect(colMap.get('created_at')!.type).toBe('bigint');
      expect(colMap.get('created_at')!.nullable).toBe('NO');
      // updated_at: bigint NOT NULL
      expect(colMap.has('updated_at')).toBe(true);
      expect(colMap.get('updated_at')!.type).toBe('bigint');
      expect(colMap.get('updated_at')!.nullable).toBe('NO');
    });
  });

  it('choros_app holds SELECT/INSERT/UPDATE/DELETE on the table (AC-19)', async () => {
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

// ---------------------------------------------------------------------------
// FF-2: DB CHECK mcp_tool_pure_empty_chk (AC-7)
// ---------------------------------------------------------------------------

describe('FF-2: mcp_tool_pure_empty_chk (AC-7)', () => {
  it('declares=[] with pure_compute=true succeeds (the valid floor)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(
        `INSERT INTO choros.mcp_tool
           (tenant_id, id, name, declares, pure_compute, resource_ops, created_at, updated_at)
         VALUES ($1, $2, $3, '[]'::jsonb, true, '[]'::jsonb, 0, 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, uuid(), `chk-pass-${uuid().slice(0, 8)}`],
      );
      await c.query('COMMIT');
    });
  });

  it('declares=[] with pure_compute=false is rejected with check_violation (AC-7)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(
          `INSERT INTO choros.mcp_tool
             (tenant_id, id, name, declares, pure_compute, resource_ops, created_at, updated_at)
           VALUES ($1, $2, $3, '[]'::jsonb, false, '[]'::jsonb, 0, 0)`,
          [TENANT_A, uuid(), `chk-fail-${uuid().slice(0, 8)}`],
        ),
      ).rejects.toMatchObject({ code: '23514' }); // check_violation
      await c.query('ROLLBACK');
    });
  });

  it('non-empty declares with pure_compute=false is accepted (no CHECK violation)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const decl = JSON.stringify([
        { resourceId: uuid(), kind: 'integration_endpoint' },
      ]);
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(
        `INSERT INTO choros.mcp_tool
           (tenant_id, id, name, declares, pure_compute, resource_ops, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, false, '[]'::jsonb, 0, 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, uuid(), `chk-effecting-${uuid().slice(0, 8)}`, decl],
      );
      await c.query('COMMIT');
    });
  });
});

// ---------------------------------------------------------------------------
// FF-7: cross-tenant RLS isolation (AC-3 / AC-4)
// ---------------------------------------------------------------------------

describe('FF-7: cross-tenant isolation of mcp_tool rows (AC-3 / AC-4)', () => {
  it('a TENANT_A mcp_tool row is invisible to a TENANT_B-bound choros_app session (AC-3)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
           WHERE tenant_id = $1 AND id = $2`,
        [TENANT_A, toolIdA],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'TENANT_A mcp_tool row leaked to TENANT_B').toBe(0);
    });
  });

  it('the same TENANT_A row IS visible to a TENANT_A-bound session (own-tenant read)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool WHERE id = $1`,
        [toolIdA],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'own-tenant mcp_tool row must be visible').toBe(1);
    });
  });

  it('cross-tenant SELECT with explicit WHERE tenant_id=TENANT_A returns 0 from TENANT_B context (AC-3)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool WHERE tenant_id = $1`,
        [TENANT_A],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'FORCE RLS must block cross-tenant reads').toBe(0);
    });
  });

  it('cross-tenant INSERT with tenant_id=TENANT_A from TENANT_B context is rejected (AC-4)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      await expect(
        c.query(
          `INSERT INTO choros.mcp_tool
             (tenant_id, id, name, declares, pure_compute, resource_ops, created_at, updated_at)
           VALUES ($1, $2, $3, '[]'::jsonb, true, '[]'::jsonb, 0, 0)`,
          [TENANT_A, uuid(), `ct-write-${uuid().slice(0, 8)}`],
        ),
      ).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege (RLS WITH CHECK)
      await c.query('ROLLBACK');
    });
  });
});
