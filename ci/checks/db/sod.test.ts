// T-0032 · FF-SOD7 / FF-SOD8 — sod_constraint schema + cross-tenant isolation
// + the actor_event_seq no-decrement trigger (FO-T0019-1).
//
// Live Postgres probes (run in the `db` CI job + locally via `npm run
// fitness:db`). Assume migrations have been applied (the db job runs the runner
// ×2 before this suite).
//
// FF-SOD7: sod_constraint is a T-0013 tenant table — present, tenant_id-leading
//          PK, ENABLE+FORCE RLS, choros_app DML grant, closed `kind` CHECK
//          (static|dynamic), the static-shape CHECK (a static row MUST name both
//          roles), NO cross-table FK; a TENANT_B session reads 0 of TENANT_A's
//          rows (NOBYPASSRLS + FORCE RLS).
// FF-SOD8: the actor_event_seq no-decrement trigger — forward +1 advance passes;
//          a backward UPDATE raises (restrict_violation) for BOTH choros_app and
//          the owner choros_migrator (defence in depth — the act_event_immutable
//          pattern). Plus the T-0053 atomicity OBLIGATION (recorded in notes):
//          the Postgres SodSource/reader/writer for one guarded resolveFor are
//          constructed over one withTenant PoolClient.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  appUrl,
  migratorUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  uuid,
} from './_helpers.js';

const TABLE = 'sod_constraint';

describe('FF-SOD7: sod_constraint is a well-formed tenant table', () => {
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

  it('the tenant-isolation policy is present', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT polname FROM pg_policy pol
           JOIN pg_class cls ON cls.oid = pol.polrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
          WHERE ns.nspname='choros' AND cls.relname=$1`,
        [TABLE],
      );
      const names = rows.map((r: { polname: string }) => r.polname);
      expect(names).toContain('sod_constraint_tenant_isolation');
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

  it('kind CHECK enumerates exactly the closed SodKind set (static|dynamic)', async () => {
    await withClient(migratorUrl(), async (c) => {
      // Valid static row (names both roles) — should succeed.
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(
        `INSERT INTO choros.sod_constraint
           (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
         VALUES ($1, $2, 'static', $3, $4, false, '{}'::jsonb, NULL, 0)`,
        [TENANT_A, uuid(), uuid(), uuid()],
      );
      await c.query('COMMIT');

      // Valid dynamic row (no role pair required) — should succeed.
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(
        `INSERT INTO choros.sod_constraint
           (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
         VALUES ($1, $2, 'dynamic', NULL, NULL, true, '{}'::jsonb, NULL, 0)`,
        [TENANT_A, uuid()],
      );
      await c.query('COMMIT');

      // Out-of-set kind — rejected by the CHECK (23514).
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(
          `INSERT INTO choros.sod_constraint
             (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
           VALUES ($1, $2, 'bogus', NULL, NULL, false, '{}'::jsonb, NULL, 0)`,
          [TENANT_A, uuid()],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    });
  });

  it('static-shape CHECK: a static row missing role_a/role_b is rejected', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(
          `INSERT INTO choros.sod_constraint
             (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
           VALUES ($1, $2, 'static', NULL, NULL, false, '{}'::jsonb, NULL, 0)`,
          [TENANT_A, uuid()],
        ),
      ).rejects.toMatchObject({ code: '23514' });
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

describe('FF-SOD7: cross-tenant isolation of a sod_constraint row', () => {
  const resourceIdA = uuid();

  beforeAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.sod_constraint
           (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
         VALUES ($1, $2, 'dynamic', NULL, NULL, true, '{}'::jsonb, NULL, 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, resourceIdA],
      );
      await c.query('COMMIT');
    });
  });

  it('a TENANT_A sod_constraint row is invisible to a TENANT_B-bound choros_app session', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.sod_constraint
           WHERE tenant_id = $1 AND id = $2`,
        [TENANT_A, resourceIdA],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'TENANT_A sod_constraint row leaked to TENANT_B').toBe(0);
    });
  });

  it('the same TENANT_A row IS visible to a TENANT_A-bound session', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.sod_constraint WHERE id = $1`,
        [resourceIdA],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'own-tenant sod_constraint row must be visible').toBe(1);
    });
  });

  it('cross-tenant SELECT with explicit WHERE tenant_id=TENANT_A returns 0 when context=TENANT_B', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.sod_constraint WHERE tenant_id = $1`,
        [TENANT_A],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'FORCE RLS must block cross-tenant reads').toBe(0);
    });
  });
});

describe('FF-SOD8: actor_event_seq no-decrement trigger (FO-T0019-1)', () => {
  // Use a dedicated tenant so we never collide with other suites' seq rows.
  const SEQ_TENANT = '33333333-3333-3333-3333-333333333333';

  beforeAll(async () => {
    // Seed the counter row if absent (owner bypasses RLS for the write). Use
    // DO NOTHING so a re-run against a persisted volume never tries to lower an
    // already-advanced next_seq (which our OWN no-decrement trigger would
    // reject) — the trigger-under-test makes the setup necessarily monotonic.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.actor_event_seq (tenant_id, next_seq)
         VALUES ($1, 10)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [SEQ_TENANT],
      );
      await c.query('COMMIT');
    });
  });

  it('the no-decrement trigger exists on actor_event_seq', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT tgname FROM pg_trigger tg
           JOIN pg_class cls ON cls.oid = tg.tgrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
          WHERE ns.nspname='choros' AND cls.relname='actor_event_seq'
            AND NOT tg.tgisinternal`,
      );
      const names = rows.map((r: { tgname: string }) => r.tgname);
      expect(names).toContain('actor_event_seq_no_decrement_trg');
    });
  });

  it('forward +1 advance passes the trigger (the real writer path)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      // SELECT … FOR UPDATE; UPDATE next_seq = next_seq + 1 (the writer path).
      const before = await c.query(
        `SELECT next_seq FROM choros.actor_event_seq WHERE tenant_id = $1 FOR UPDATE`,
        [SEQ_TENANT],
      );
      const start = BigInt(before.rows[0].next_seq);
      const { rows } = await c.query(
        `UPDATE choros.actor_event_seq
            SET next_seq = next_seq + 1
          WHERE tenant_id = $1
          RETURNING next_seq`,
        [SEQ_TENANT],
      );
      await c.query('COMMIT');
      // Forward advance succeeds and advances by EXACTLY one (re-run-safe).
      expect(BigInt(rows[0].next_seq), 'forward advance must succeed (+1)').toBe(start + 1n);
    });
  });

  it('a backward UPDATE is rejected for the owner choros_migrator', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await expect(
        c.query(
          `UPDATE choros.actor_event_seq SET next_seq = 1 WHERE tenant_id = $1`,
          [SEQ_TENANT],
        ),
      ).rejects.toMatchObject({ code: '23001' }); // restrict_violation (defence-in-depth: owner too)
      await c.query('ROLLBACK');
    });
  });

  it('a backward UPDATE is rejected for choros_app', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${SEQ_TENANT}'`);
      await expect(
        c.query(
          `UPDATE choros.actor_event_seq SET next_seq = 1 WHERE tenant_id = $1`,
          [SEQ_TENANT],
        ),
      ).rejects.toBeDefined();
      await c.query('ROLLBACK');
    });
  });
});
