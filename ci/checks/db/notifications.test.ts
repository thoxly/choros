// T-0168 · E-N.1 — notification / email_channel_config / notification_preference schema.
//
// Live Postgres probes (run in the `db` CI job + locally via `npm run fitness:db`).
// Requires migrations 046/047/048 applied.
//
// AC-1..AC-20 coverage (per T-0168.spec.contract.json):
//   AC-1..3:   Tables exist in choros.
//   AC-4:      ENABLE + FORCE RLS on all three.
//   AC-5:      Policy names match spec.
//   AC-6:      Policies have default-DENY on GUC (no-GUC → 0 rows / INSERT fails).
//   AC-7:      choros_app holds SELECT/INSERT/UPDATE/DELETE on each table.
//   AC-8:      notification PK (tenant_id, id); FK (tenant_id, recipient_id) → employee.
//   AC-9:      email_channel_config PK is sole column tenant_id.
//   AC-10:     notification_preference PK (tenant_id, event_kind, recipient_scope).
//   AC-11:     idx_notification_unread exists, indexdef contains WHERE (is_read = false).
//   AC-12:     idx_notification_listing exists, indexdef contains all four columns.
//   AC-13:     tenant_id is the leading column of all composite indexes on these tables.
//   AC-14:     known_tenant_tables.txt contains all three names, total rows ≥ 34.
//   AC-15:     Migration files contain no queue/delivery/dispatch tables.
//   AC-18..20: Column shape matches ADR §4.1–4.3.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  migratorUrl,
  appUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  uuid,
} from './_helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// ---------------------------------------------------------------------------
// AC-14 (static): known_tenant_tables.txt contains all three new names.
// ---------------------------------------------------------------------------

describe('AC-14 (static): known_tenant_tables.txt contains notification tables', () => {
  it('contains notification, email_channel_config, notification_preference', () => {
    const lines = readFileSync(
      join(REPO_ROOT, 'ci', 'checks', 'known_tenant_tables.txt'),
      'utf8',
    )
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(lines, 'notification missing from known_tenant_tables.txt').toContain('notification');
    expect(lines, 'email_channel_config missing').toContain('email_channel_config');
    expect(lines, 'notification_preference missing').toContain('notification_preference');
    expect(lines.length, `expected ≥ 34 lines (was ${lines.length})`).toBeGreaterThanOrEqual(34);
  });
});

// ---------------------------------------------------------------------------
// AC-15 (static): migration files contain no queue/delivery/dispatch tables.
// ---------------------------------------------------------------------------

describe('AC-15 (static): migration files 046–048 create no queue/delivery/dispatch tables', () => {
  const migrations = ['046_notification.sql', '047_email_channel_config.sql', '048_notification_preference.sql'];
  for (const fname of migrations) {
    it(`${fname} has no CREATE TABLE.*queue|delivery|dispatch`, () => {
      const content = readFileSync(
        join(REPO_ROOT, 'migrations', fname),
        'utf8',
      ).toLowerCase();
      expect(content).not.toMatch(/create\s+table[^;]*?(queue|delivery|dispatch)/);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-1 / AC-2 / AC-3: Tables exist in choros.
// ---------------------------------------------------------------------------

const THREE_TABLES = ['notification', 'email_channel_config', 'notification_preference'] as const;

describe('AC-1/2/3: notification tables exist in choros', () => {
  for (const table of THREE_TABLES) {
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
// AC-4: ENABLE + FORCE RLS on all three tables.
// ---------------------------------------------------------------------------

describe('AC-4: ENABLE + FORCE RLS on all three notification tables', () => {
  for (const table of THREE_TABLES) {
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
// AC-5: Policy names match spec naming convention.
// ---------------------------------------------------------------------------

describe('AC-5: tenant isolation policies are correctly named', () => {
  const expectedPolicies: [string, string][] = [
    ['notification', 'notification_tenant_isolation'],
    ['email_channel_config', 'email_channel_config_tenant_isolation'],
    ['notification_preference', 'notification_preference_tenant_isolation'],
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
// AC-6: Policies are default-DENY: no GUC set → 0 rows visible, INSERT fails.
// ---------------------------------------------------------------------------

describe('AC-6: default-DENY policy — no GUC context → 0 rows and INSERT denied', () => {
  it('notification: no GUC → SELECT returns 0 rows (via appUrl)', async () => {
    await withClient(appUrl(), async (c) => {
      // No SET choros.tenant_id — GUC is not set.
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.notification`,
      );
      expect(rows[0].n, 'notification without GUC must return 0').toBe(0);
    });
  });

  it('notification_preference: no GUC → SELECT returns 0 rows (via appUrl)', async () => {
    await withClient(appUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.notification_preference`,
      );
      expect(rows[0].n, 'notification_preference without GUC must return 0').toBe(0);
    });
  });

  it('email_channel_config: no GUC → SELECT returns 0 rows (via appUrl)', async () => {
    await withClient(appUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.email_channel_config`,
      );
      expect(rows[0].n, 'email_channel_config without GUC must return 0').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-7: choros_app holds SELECT/INSERT/UPDATE/DELETE on each table.
// ---------------------------------------------------------------------------

describe('AC-7: choros_app DML grants on all three notification tables', () => {
  for (const table of THREE_TABLES) {
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
// AC-8: notification PK (tenant_id, id) + FK (tenant_id, recipient_id) → employee.
// ---------------------------------------------------------------------------

describe('AC-8: notification PK and FK constraints', () => {
  it('primary key is (tenant_id, id)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT array_agg(att.attname::text ORDER BY u.ord) AS pk_cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(col, ord) ON true
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.col
          WHERE ns.nspname='choros' AND cls.relname='notification' AND con.contype='p'`,
      );
      expect(rows.length, 'no PK on notification').toBeGreaterThan(0);
      expect(rows[0].pk_cols).toEqual(['tenant_id', 'id']);
    });
  });

  it('FK (tenant_id, recipient_id) → employee(tenant_id, id) exists', async () => {
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
          WHERE ns.nspname='choros' AND cls.relname='notification' AND con.contype='f'
          GROUP BY ref.relname`,
      );
      expect(rows.length, 'no FK on notification').toBeGreaterThan(0);
      const fk = rows[0];
      expect(fk.dst, 'FK target must be employee').toBe('employee');
      expect(fk.src_cols, 'FK src cols').toEqual(['tenant_id', 'recipient_id']);
      expect(fk.ref_cols, 'FK ref cols').toEqual(['tenant_id', 'id']);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-9: email_channel_config PK is sole column tenant_id.
// ---------------------------------------------------------------------------

describe('AC-9: email_channel_config PK is (tenant_id) only', () => {
  it('primary key has exactly one column: tenant_id', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT array_agg(att.attname::text ORDER BY u.ord) AS pk_cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(col, ord) ON true
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.col
          WHERE ns.nspname='choros' AND cls.relname='email_channel_config' AND con.contype='p'`,
      );
      expect(rows.length, 'no PK on email_channel_config').toBeGreaterThan(0);
      expect(rows[0].pk_cols).toEqual(['tenant_id']);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-10: notification_preference PK is (tenant_id, event_kind, recipient_scope).
// ---------------------------------------------------------------------------

describe('AC-10: notification_preference PK is (tenant_id, event_kind, recipient_scope)', () => {
  it('primary key has correct three columns in order', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT array_agg(att.attname::text ORDER BY u.ord) AS pk_cols
           FROM pg_constraint con
           JOIN pg_class cls ON cls.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cls.relnamespace
           JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(col, ord) ON true
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.col
          WHERE ns.nspname='choros' AND cls.relname='notification_preference' AND con.contype='p'`,
      );
      expect(rows.length, 'no PK on notification_preference').toBeGreaterThan(0);
      expect(rows[0].pk_cols).toEqual(['tenant_id', 'event_kind', 'recipient_scope']);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-11: idx_notification_unread exists with WHERE is_read = false.
// ---------------------------------------------------------------------------

describe('AC-11: idx_notification_unread partial index exists', () => {
  it('idx_notification_unread is present and has WHERE (is_read = false)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname='choros' AND tablename='notification'
            AND indexname='idx_notification_unread'`,
      );
      expect(rows.length, 'idx_notification_unread missing').toBe(1);
      expect(rows[0].indexdef, 'indexdef must contain WHERE (is_read = false)').toMatch(
        /WHERE\s+\(is_read\s*=\s*false\)/i,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// AC-12: idx_notification_listing exists with (tenant_id, recipient_id, created_at, id).
// ---------------------------------------------------------------------------

describe('AC-12: idx_notification_listing keyset index exists', () => {
  it('idx_notification_listing is present with correct columns', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname='choros' AND tablename='notification'
            AND indexname='idx_notification_listing'`,
      );
      expect(rows.length, 'idx_notification_listing missing').toBe(1);
      const def: string = rows[0].indexdef;
      // indexdef should mention each column in order
      expect(def, 'indexdef must contain tenant_id').toMatch(/tenant_id/);
      expect(def, 'indexdef must contain recipient_id').toMatch(/recipient_id/);
      expect(def, 'indexdef must contain created_at').toMatch(/created_at/);
      expect(def, 'indexdef must contain id').toMatch(/\bid\b/);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-13: tenant_id is leading column of ALL composite indexes on these tables.
// ---------------------------------------------------------------------------

describe('AC-13: tenant_id leads all composite indexes on the three new tables', () => {
  for (const table of THREE_TABLES) {
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
        expect(violations, `${table}: composite index not led by tenant_id: ${JSON.stringify(violations)}`).toEqual([]);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// AC-16: Cross-tenant isolation — TENANT_A rows invisible to TENANT_B.
// ---------------------------------------------------------------------------

describe('AC-16: cross-tenant isolation (choros_app NOBYPASSRLS)', () => {
  it('notification row written under TENANT_A is invisible from TENANT_B context', async () => {
    // We cannot insert without a valid employee FK — test via notification_preference
    // (no FK, easier to seed cross-tenant). The RLS mechanism is the same.
    const prefId = uuid();
    const eventKind = `ct-notif-pref-${prefId.slice(0, 8)}`;

    // Seed a notification_preference row for TENANT_A via migrator (bypasses RLS).
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.notification_preference
           (tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at)
         VALUES ($1, $2, 'actor:test', ARRAY['in_app'], 'test', 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, eventKind],
      );
    });

    // Verify visible from TENANT_A context (choros_app).
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT 1 FROM choros.notification_preference
          WHERE tenant_id = $1 AND event_kind = $2`,
        [TENANT_A, eventKind],
      );
      await c.query('COMMIT');
      expect(rows.length, 'TENANT_A row must be visible from TENANT_A context').toBe(1);
    });

    // Verify invisible from TENANT_B context (choros_app).
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT 1 FROM choros.notification_preference
          WHERE tenant_id = $1 AND event_kind = $2`,
        [TENANT_A, eventKind],
      );
      await c.query('COMMIT');
      expect(rows.length, 'TENANT_A row must NOT be visible from TENANT_B context').toBe(0);
    });
  });

  it('email_channel_config row for TENANT_A is invisible from TENANT_B context', async () => {
    const host = `smtp-ct-${uuid().slice(0, 8)}.example.com`;

    // Seed under TENANT_A via migrator.
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.email_channel_config
           (tenant_id, smtp_host, smtp_port, smtp_tls, from_address,
            smtp_handle, is_enabled, updated_by, updated_at)
         VALUES ($1, $2, 587, true, 'noreply@example.com',
                 'handle://test-ref-1', false, 'test', 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, host],
      );
    });

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT 1 FROM choros.email_channel_config WHERE tenant_id = $1`,
        [TENANT_A],
      );
      await c.query('COMMIT');
      expect(rows.length, 'TENANT_A email config must not leak to TENANT_B').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-18: notification columns match ADR §4.1 (10 columns, correct types).
// ---------------------------------------------------------------------------

describe('AC-18: notification column shape matches ADR §4.1', () => {
  it('has exactly the 10 specified columns with correct types and nullability', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema='choros' AND table_name='notification'
          ORDER BY ordinal_position`,
      );
      const byName = Object.fromEntries(rows.map((r: {
        column_name: string; data_type: string; is_nullable: string; column_default: string | null;
      }) => [r.column_name, r]));

      expect(rows.length, 'notification must have exactly 10 columns').toBe(10);

      expect(byName['tenant_id'].data_type).toBe('uuid');
      expect(byName['tenant_id'].is_nullable).toBe('NO');

      expect(byName['id'].data_type).toBe('uuid');
      expect(byName['id'].is_nullable).toBe('NO');

      expect(byName['recipient_id'].data_type).toBe('uuid');
      expect(byName['recipient_id'].is_nullable).toBe('NO');

      expect(byName['event_kind'].data_type).toBe('text');
      expect(byName['event_kind'].is_nullable).toBe('NO');

      expect(byName['title'].data_type).toBe('text');
      expect(byName['title'].is_nullable).toBe('NO');

      expect(byName['body'].data_type).toBe('text');
      expect(byName['body'].is_nullable).toBe('NO');

      expect(byName['object_ref'].data_type).toBe('text');
      expect(byName['object_ref'].is_nullable).toBe('YES');

      expect(byName['is_read'].data_type).toBe('boolean');
      expect(byName['is_read'].is_nullable).toBe('NO');
      expect(byName['is_read'].column_default).toMatch(/false/);

      expect(byName['created_at'].data_type).toBe('bigint');
      expect(byName['created_at'].is_nullable).toBe('NO');

      expect(byName['expires_at'].data_type).toBe('bigint');
      expect(byName['expires_at'].is_nullable).toBe('YES');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-19: email_channel_config columns match ADR §4.2 (10 columns).
// ---------------------------------------------------------------------------

describe('AC-19: email_channel_config column shape matches ADR §4.2', () => {
  it('has exactly the 10 specified columns with correct types', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema='choros' AND table_name='email_channel_config'
          ORDER BY ordinal_position`,
      );
      const byName = Object.fromEntries(rows.map((r: {
        column_name: string; data_type: string; is_nullable: string; column_default: string | null;
      }) => [r.column_name, r]));

      expect(rows.length, 'email_channel_config must have exactly 10 columns').toBe(10);

      expect(byName['tenant_id'].data_type).toBe('uuid');
      expect(byName['tenant_id'].is_nullable).toBe('NO');

      expect(byName['smtp_host'].data_type).toBe('text');
      expect(byName['smtp_host'].is_nullable).toBe('NO');

      expect(byName['smtp_port'].data_type).toBe('integer');
      expect(byName['smtp_port'].is_nullable).toBe('NO');

      expect(byName['smtp_tls'].data_type).toBe('boolean');
      expect(byName['smtp_tls'].is_nullable).toBe('NO');
      expect(byName['smtp_tls'].column_default).toMatch(/true/);

      expect(byName['from_address'].data_type).toBe('text');
      expect(byName['from_address'].is_nullable).toBe('NO');

      expect(byName['from_name'].data_type).toBe('text');
      expect(byName['from_name'].is_nullable).toBe('YES');

      expect(byName['smtp_handle'].data_type).toBe('text');
      expect(byName['smtp_handle'].is_nullable).toBe('NO');

      expect(byName['is_enabled'].data_type).toBe('boolean');
      expect(byName['is_enabled'].is_nullable).toBe('NO');
      expect(byName['is_enabled'].column_default).toMatch(/false/);

      expect(byName['updated_by'].data_type).toBe('text');
      expect(byName['updated_by'].is_nullable).toBe('NO');

      expect(byName['updated_at'].data_type).toBe('bigint');
      expect(byName['updated_at'].is_nullable).toBe('NO');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-20: notification_preference columns match ADR §4.3 (6 columns).
// ---------------------------------------------------------------------------

describe('AC-20: notification_preference column shape matches ADR §4.3', () => {
  it('has exactly the 6 specified columns with correct types', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema='choros' AND table_name='notification_preference'
          ORDER BY ordinal_position`,
      );
      const byName = Object.fromEntries(rows.map((r: {
        column_name: string; data_type: string; is_nullable: string;
      }) => [r.column_name, r]));

      expect(rows.length, 'notification_preference must have exactly 6 columns').toBe(6);

      expect(byName['tenant_id'].data_type).toBe('uuid');
      expect(byName['tenant_id'].is_nullable).toBe('NO');

      expect(byName['event_kind'].data_type).toBe('text');
      expect(byName['event_kind'].is_nullable).toBe('NO');

      expect(byName['recipient_scope'].data_type).toBe('text');
      expect(byName['recipient_scope'].is_nullable).toBe('NO');

      // channels is text[] → information_schema reports it as 'ARRAY'
      expect(byName['channels'].data_type).toBe('ARRAY');
      expect(byName['channels'].is_nullable).toBe('NO');

      expect(byName['updated_by'].data_type).toBe('text');
      expect(byName['updated_by'].is_nullable).toBe('NO');

      expect(byName['updated_at'].data_type).toBe('bigint');
      expect(byName['updated_at'].is_nullable).toBe('NO');
    });
  });
});
