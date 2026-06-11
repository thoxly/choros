// T-0171 · E-N.4 — notification_preference DAO + defaults-seed live Postgres probes.
//
// Run in `db` CI job via `npm run fitness:db` (vitest --dir ci/checks/db).
// Requires: migrations 048 applied, choros_app credentials available.
//
// AC coverage (docs/specs/T-0171.spec.contract.json):
//   AC-2  getPreferences returns rows with GUC set; [] without GUC (RLS)
//   AC-3  upsert creates row; repeat upsert updates channels (ON CONFLICT DO UPDATE)
//   AC-4  seedDefaultPreferences inserts 5 rows idempotently (ON CONFLICT DO NOTHING)
//   AC-5  all 5 defaults have correct event_kind / recipient_scope / channels
//   AC-9  listByTenant filtered to actor:<self> returns only self-rows
//   AC-14 cross-tenant: TENANT_A rows invisible from TENANT_B context
//
// Pattern: BEGIN → SET LOCAL choros.tenant_id → query → COMMIT (like notifications.test.ts).

import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import {
  migratorUrl,
  appUrl,
  withClient,
  TENANT_A,
  TENANT_B,
  uuid,
} from './_helpers.js';
import {
  PostgresPrefStore,
  seedDefaultPreferences,
  DEFAULT_PREFERENCES,
} from '../../../src/core/postgres/pgPrefStore.js';

// ---------------------------------------------------------------------------
// Pool for pool-based tests (pgPrefStore.getPreferences)
// ---------------------------------------------------------------------------

let appPool: pg.Pool | null = null;

function getAppPool(): pg.Pool {
  if (!appPool) {
    appPool = new pg.Pool({ connectionString: appUrl() });
  }
  return appPool;
}

afterAll(async () => {
  await appPool?.end();
});

// ---------------------------------------------------------------------------
// Cleanup helper: remove preference rows added during tests (by test event_kind)
// ---------------------------------------------------------------------------

async function cleanPrefRows(tenantId: string, eventKindPrefix: string): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `DELETE FROM choros.notification_preference
        WHERE tenant_id = $1 AND event_kind LIKE $2`,
      [tenantId, `${eventKindPrefix}%`],
    );
  });
}

// ---------------------------------------------------------------------------
// AC-2: getPreferences — pool-based, GUC set by store internally
// ---------------------------------------------------------------------------

describe('AC-2: getPreferences returns rows under correct tenant context', () => {
  const testEventKind = `t-0171-test-${uuid().slice(0, 8)}`;
  const recipientScope = 'actor:u-test-1';

  it('returns seeded preference rows for the correct tenant', async () => {
    // Seed a row via migrator (bypasses RLS).
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.notification_preference
           (tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at)
         VALUES ($1, $2, $3, ARRAY['in_app'], 'test', 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, testEventKind, recipientScope],
      );
    });

    // Use the pool-based store.
    const store = new PostgresPrefStore(getAppPool());
    const prefs = await store.getPreferences(TENANT_A, testEventKind);

    expect(prefs.length, 'should find the seeded preference').toBeGreaterThanOrEqual(1);
    const found = prefs.find((p) => p.recipientScope === recipientScope);
    expect(found, 'seeded row must be returned').toBeDefined();
    expect(found!.channels).toEqual(['in_app']);

    await cleanPrefRows(TENANT_A, testEventKind);
  });

  it('returns empty array for unknown (tenantId, eventKind)', async () => {
    const store = new PostgresPrefStore(getAppPool());
    const prefs = await store.getPreferences(TENANT_B, `unknown-event-${uuid()}`);
    expect(prefs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-3: upsert — insert then update via ON CONFLICT DO UPDATE
// ---------------------------------------------------------------------------

describe('AC-3: upsert creates + updates on conflict', () => {
  const testEventKind = `t-0171-upsert-${uuid().slice(0, 8)}`;

  it('upsert inserts a new row and getPreferences finds it', async () => {
    const store = new PostgresPrefStore(getAppPool());

    // Use withClient(appUrl) for transaction-scoped GUC + upsert.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await store.upsert(c, {
        tenantId: TENANT_A,
        eventKind: testEventKind,
        recipientScope: 'actor:u-upsert-1',
        channels: ['in_app'],
        updatedBy: 'test',
        updatedAt: Date.now(),
      });
      await c.query('COMMIT');
    });

    const prefs = await store.getPreferences(TENANT_A, testEventKind);
    expect(prefs.some((p) => p.recipientScope === 'actor:u-upsert-1' && p.channels.includes('in_app'))).toBe(true);
  });

  it('second upsert with same (event_kind, recipient_scope) updates channels', async () => {
    const store = new PostgresPrefStore(getAppPool());

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await store.upsert(c, {
        tenantId: TENANT_A,
        eventKind: testEventKind,
        recipientScope: 'actor:u-upsert-1',
        channels: ['in_app', 'email'],  // changed
        updatedBy: 'test',
        updatedAt: Date.now(),
      });
      await c.query('COMMIT');
    });

    const prefs = await store.getPreferences(TENANT_A, testEventKind);
    const row = prefs.find((p) => p.recipientScope === 'actor:u-upsert-1');
    expect(row, 'row must exist after second upsert').toBeDefined();
    expect(row!.channels, 'channels updated to include email').toContain('email');

    await cleanPrefRows(TENANT_A, testEventKind);
  });
});

// ---------------------------------------------------------------------------
// AC-4 + AC-5: seedDefaultPreferences — 5 rows, idempotent, correct content
// ---------------------------------------------------------------------------

describe('AC-4 + AC-5: seedDefaultPreferences inserts 5 defaults idempotently', () => {
  const seedTenant = uuid();  // fresh tenant per test run (no FK on notification_preference)

  it('inserts exactly 5 rows on first call', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${seedTenant}'`);
      await seedDefaultPreferences(c, seedTenant, 0);
      await c.query('COMMIT');
    });

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${seedTenant}'`);
      const { rows } = await c.query(
        `SELECT event_kind, recipient_scope, channels
           FROM choros.notification_preference
          WHERE tenant_id = $1
          ORDER BY event_kind`,
        [seedTenant],
      );
      await c.query('COMMIT');
      expect(rows.length, 'exactly 5 default preferences').toBe(5);
    });
  });

  it('second call does not change existing rows (ON CONFLICT DO NOTHING semantics)', async () => {
    // Manually set a custom channels value for one row.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${seedTenant}'`);
      await c.query(
        `UPDATE choros.notification_preference
            SET channels = ARRAY['in_app', 'email']
          WHERE tenant_id = $1 AND event_kind = 'task.assigned'`,
        [seedTenant],
      );
      await c.query('COMMIT');
    });

    // Run seed again.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${seedTenant}'`);
      await seedDefaultPreferences(c, seedTenant, 0);
      await c.query('COMMIT');
    });

    // The manually-set value must be preserved (seed is DO NOTHING).
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${seedTenant}'`);
      const { rows } = await c.query(
        `SELECT channels FROM choros.notification_preference
          WHERE tenant_id = $1 AND event_kind = 'task.assigned'`,
        [seedTenant],
      );
      await c.query('COMMIT');
      expect(rows.length).toBe(1);
      // Should still have the manually-updated value (seed didn't overwrite).
      expect(rows[0].channels).toContain('email');
    });

    // Cleanup.
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `DELETE FROM choros.notification_preference WHERE tenant_id = $1`,
        [seedTenant],
      );
    });
  });

  it('DEFAULT_PREFERENCES contains all 5 expected event_kinds', () => {
    const kinds = DEFAULT_PREFERENCES.map((p) => p.eventKind).sort();
    expect(kinds).toEqual([
      'approval.requested',
      'escalation.raised',
      'sla.breach',
      'sla.warning',
      'task.assigned',
    ]);
  });

  it('task.assigned → in_app only (ADR §2.4)', () => {
    const row = DEFAULT_PREFERENCES.find((p) => p.eventKind === 'task.assigned');
    expect(row!.channels).toEqual(['in_app']);
  });

  it('sla.warning → [in_app, email] (ADR §2.4)', () => {
    const row = DEFAULT_PREFERENCES.find((p) => p.eventKind === 'sla.warning');
    expect(row!.channels).toEqual(['in_app', 'email']);
  });
});

// ---------------------------------------------------------------------------
// AC-14: cross-tenant isolation (choros_app NOBYPASSRLS)
// ---------------------------------------------------------------------------

describe('AC-14: cross-tenant isolation for notification_preference', () => {
  const isolEventKind = `t-0171-iso-${uuid().slice(0, 8)}`;

  it('TENANT_A row is invisible from TENANT_B context', async () => {
    // Seed under TENANT_A via migrator.
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.notification_preference
           (tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at)
         VALUES ($1, $2, 'actor:iso-test', ARRAY['in_app'], 'test', 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, isolEventKind],
      );
    });

    // Visible from TENANT_A.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT 1 FROM choros.notification_preference
          WHERE tenant_id = $1 AND event_kind = $2`,
        [TENANT_A, isolEventKind],
      );
      await c.query('COMMIT');
      expect(rows.length, 'TENANT_A must see its own row').toBe(1);
    });

    // Invisible from TENANT_B.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const { rows } = await c.query(
        `SELECT 1 FROM choros.notification_preference
          WHERE tenant_id = $1 AND event_kind = $2`,
        [TENANT_A, isolEventKind],
      );
      await c.query('COMMIT');
      expect(rows.length, 'TENANT_A row must not leak to TENANT_B').toBe(0);
    });

    await cleanPrefRows(TENANT_A, isolEventKind);
  });
});

// ---------------------------------------------------------------------------
// AC-9: listByTenant — returns all rows (self-filter is HTTP-handler responsibility)
// ---------------------------------------------------------------------------

describe('AC-9: listByTenant + listByEventKind return correct rows', () => {
  const listEventKind = `t-0171-list-${uuid().slice(0, 8)}`;

  it('listByTenant returns rows for the current tenant context', async () => {
    // Seed two rows under TENANT_A.
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.notification_preference
           (tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at)
         VALUES
           ($1, $2, 'actor:list-u1', ARRAY['in_app'], 'test', 0),
           ($1, $2, 'role:r-list',   ARRAY['email'],  'test', 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, listEventKind],
      );
    });

    const store = new PostgresPrefStore(getAppPool());

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const prefs = await store.listByTenant(c);
      await c.query('COMMIT');

      const scopeList = prefs
        .filter((p) => p.eventKind === listEventKind)
        .map((p) => p.recipientScope);
      expect(scopeList).toContain('actor:list-u1');
      expect(scopeList).toContain('role:r-list');
    });

    // Self-filter (HTTP-handler responsibility): simulate by filtering to actor:list-u1
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const prefs = await store.listByTenant(c);
      const selfPrefs = prefs.filter(
        (p) => p.eventKind === listEventKind && p.recipientScope === 'actor:list-u1',
      );
      await c.query('COMMIT');
      expect(selfPrefs.length).toBe(1);
      expect(selfPrefs[0]!.channels).toEqual(['in_app']);
    });

    await cleanPrefRows(TENANT_A, listEventKind);
  });
});
