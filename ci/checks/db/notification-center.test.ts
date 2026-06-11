// T-0173 · E-N.6 — notification center DAO live Postgres probes.
//
// Run in `db` CI job via `npm run fitness:db` (vitest --dir ci/checks/db).
// Requires: migrations 046/047/048 applied, choros_app + choros_migrator credentials.
//
// IMPORTANT: The notification table has FK (tenant_id, recipient_id) → employee(tenant_id, id).
// We cannot insert notifications with arbitrary recipient_ids. The test template DB only has
// employees under the DEV_TENANT_ID (a0000000-0000-0000-0000-000000000001). Therefore:
//   - Notification insert tests use DEV_TENANT_ID + a seeded employee UUID.
//   - Cross-tenant isolation tests use notification_preference (no FK) to probe RLS,
//     consistent with the existing notifications.test.ts approach.
//
// AC coverage (docs/specs/T-0173-notification-center.spec.contract.json):
//   AC-2  listing returns only actor's rows (own-only, recipient_id filter)
//   AC-3  Keyset pagination: second page has no duplicates/gaps
//   AC-4  unread-count uses idx_notification_unread (EXPLAIN shows index scan)
//   AC-5  markRead → is_read=true in DB for own row
//   AC-6  markRead for foreign/missing → returns false (no mutation)
//   AC-7  batchMarkRead: own rows updated, foreign rows silently skipped
//   AC-9  Cross-tenant: notification_preference row in TENANT_A not visible from TENANT_B
//
// Pattern: BEGIN → SET LOCAL choros.tenant_id → query → COMMIT (T-0013 pattern).
// Cleanup: migrator-user DELETE after each test group (bypasses RLS).

import { describe, it, expect } from 'vitest';
import pg from 'pg';
import {
  migratorUrl,
  appUrl,
  TENANT_A,
  TENANT_B,
  withClient,
  uuid,
} from './_helpers.js';
import {
  PgNotificationStore,
  type NotifCursor,
} from '../../../src/core/postgres/pgNotificationStore.js';

// ---------------------------------------------------------------------------
// DEV tenant constant (only tenant with seeded employees in template DB)
// ---------------------------------------------------------------------------

const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a single connection (auto-close after use). */
async function withMigratorClient<T>(
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: migratorUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Run a function inside a tenant-scoped transaction (choros_app, NOBYPASSRLS). */
async function withAppTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Get the first employee UUID in DEV_TENANT_ID (from seed migrations). */
async function getDevEmployee(): Promise<string> {
  let empId: string | undefined;
  await withMigratorClient(async (c) => {
    const { rows } = await c.query(
      `SELECT id FROM choros.employee WHERE tenant_id = $1 LIMIT 1`,
      [DEV_TENANT_ID],
    );
    if (rows.length === 0) {
      throw new Error(`No employee in DEV_TENANT_ID (${DEV_TENANT_ID}) — migrations not applied`);
    }
    empId = (rows[0] as { id: string }).id;
  });
  return empId!;
}

/** Insert a notification row bypassing RLS (migrator, tenant = DEV_TENANT_ID). */
async function insertNotif(
  recipientId: string,
  opts: {
    id?: string;
    eventKind?: string;
    isRead?: boolean;
    createdAt?: number;
  } = {},
): Promise<string> {
  const id = opts.id ?? uuid();
  const eventKind = opts.eventKind ?? 'task.assigned';
  const isRead = opts.isRead ?? false;
  const createdAt = opts.createdAt ?? Date.now();

  await withMigratorClient(async (c) => {
    await c.query(
      `INSERT INTO choros.notification
         (tenant_id, id, recipient_id, event_kind, title, body, object_ref,
          is_read, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'Test title', 'Test body', NULL, $5, $6, NULL)
       ON CONFLICT DO NOTHING`,
      [DEV_TENANT_ID, id, recipientId, eventKind, isRead, createdAt],
    );
  });

  return id;
}

/** Delete test notification rows via migrator (bypasses RLS). */
async function cleanNotifRows(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withMigratorClient(async (c) => {
    await c.query(
      `DELETE FROM choros.notification WHERE tenant_id = $1 AND id = ANY($2)`,
      [DEV_TENANT_ID, ids],
    );
  });
}

// Pool (shared across tests in this file)
let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: appUrl() });
  return _pool;
}

// ---------------------------------------------------------------------------
// AC-2: listing returns only actor's rows (own-only)
// ---------------------------------------------------------------------------

describe('AC-2: listing returns only actor notifications (own-only)', () => {
  it('list result rows all have recipientId matching the queried actor', async () => {
    const actor = await getDevEmployee();

    const id = await insertNotif(actor, { eventKind: 'task.assigned' });

    const store = new PgNotificationStore(getPool());
    const result = await withAppTx(getPool(), DEV_TENANT_ID, (client) =>
      store.list(client, { recipientId: actor }),
    );

    // Every returned row must belong to actor (own-only guarantee)
    for (const row of result.rows) {
      expect(row.recipientId, 'all rows must belong to queried actor').toBe(actor);
    }

    const found = result.rows.find((r) => r.id === id);
    expect(found, 'own row must appear in listing').toBeDefined();

    await cleanNotifRows([id]);
  });
});

// ---------------------------------------------------------------------------
// AC-3: keyset pagination — no duplicates/gaps
// ---------------------------------------------------------------------------

describe('AC-3: keyset pagination correctness', () => {
  it('two pages cover all inserted rows without duplicates or gaps', async () => {
    const actor = await getDevEmployee();

    // Insert 5 rows with distinct, unique createdAt values far in the future
    const base = Date.now() + 10_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await insertNotif(actor, { createdAt: base + i }));
    }

    const store = new PgNotificationStore(getPool());

    // Page 1: limit=3
    const page1 = await withAppTx(getPool(), DEV_TENANT_ID, (client) =>
      store.list(client, { recipientId: actor, limit: 3 }),
    );
    expect(page1.rows.length).toBe(3);
    expect(page1.nextCursor, 'page 1 must have nextCursor').not.toBeNull();

    // Page 2: use cursor from page 1
    const page2 = await withAppTx(getPool(), DEV_TENANT_ID, (client) =>
      store.list(client, {
        recipientId: actor,
        limit: 3,
        cursor: page1.nextCursor as NotifCursor,
      }),
    );

    // No duplicates between pages
    const page1Ids = new Set(page1.rows.map((r) => r.id));
    const page2Ids = new Set(page2.rows.map((r) => r.id));
    for (const id of page2Ids) {
      expect(page1Ids.has(id), `row ${id} must not appear in both pages`).toBe(false);
    }

    // All 5 inserted rows covered across both pages
    const allIds = new Set([...page1Ids, ...page2Ids]);
    for (const id of ids) {
      expect(allIds.has(id), `inserted row ${id} must appear in one of the pages`).toBe(true);
    }

    await cleanNotifRows(ids);
  });
});

// ---------------------------------------------------------------------------
// AC-4: unread-count — partial index EXPLAIN
// ---------------------------------------------------------------------------

describe('AC-4: unread-count uses idx_notification_unread (partial index)', () => {
  it('countUnread returns correct count (≥ inserted unread rows)', async () => {
    const actor = await getDevEmployee();

    // Insert 2 unread + 1 read row
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      ids.push(await insertNotif(actor, { isRead: false, createdAt: Date.now() + 20_000_000 + i }));
    }
    ids.push(await insertNotif(actor, { isRead: true, createdAt: Date.now() + 20_000_002 }));

    const store = new PgNotificationStore(getPool());
    const count = await withAppTx(getPool(), DEV_TENANT_ID, (client) =>
      store.countUnread(client, actor),
    );

    expect(count).toBeGreaterThanOrEqual(2);

    await cleanNotifRows(ids);
  });

  it('EXPLAIN on countUnread shows Index Scan on idx_notification_unread (FF-UNREAD-INDEXED)', async () => {
    const actor = await getDevEmployee();

    // EXPLAIN via migrator (BYPASSRLS — can read plan without RLS restriction on EXPLAIN)
    await withMigratorClient(async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT_ID}'`);
      await c.query("SET LOCAL search_path TO choros");

      const { rows } = await c.query(
        `EXPLAIN (FORMAT TEXT, ANALYZE FALSE)
           SELECT COUNT(*)::bigint AS cnt
             FROM choros.notification
            WHERE recipient_id = $1 AND is_read = false`,
        [actor],
      );
      await c.query('COMMIT');

      const plan = rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');

      expect(
        plan,
        `EXPLAIN must reference idx_notification_unread — got:\n${plan}`,
      ).toMatch(/idx_notification_unread/i);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-5: markRead — own row → is_read=true in DB
// ---------------------------------------------------------------------------

describe('AC-5: markRead sets is_read=true for own row', () => {
  it('marks own notification as read and persists to DB', async () => {
    const actor = await getDevEmployee();
    const id = await insertNotif(actor, { isRead: false });

    const store = new PgNotificationStore(getPool());
    const updated = await withAppTx(getPool(), DEV_TENANT_ID, (client) =>
      store.markRead(client, id, actor),
    );

    expect(updated, 'markRead returns true for own row').toBe(true);

    // Verify in DB
    await withMigratorClient(async (c) => {
      const { rows } = await c.query(
        `SELECT is_read FROM choros.notification WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT_ID, id],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].is_read, 'is_read must be true after markRead').toBe(true);
    });

    await cleanNotifRows([id]);
  });
});

// ---------------------------------------------------------------------------
// AC-6: markRead — foreign/missing row → false, no mutation
// ---------------------------------------------------------------------------

describe('AC-6: markRead returns false for foreign/missing row (no mutation)', () => {
  it('returns false for a non-existent notification id', async () => {
    const actor = await getDevEmployee();
    const nonExistentId = uuid();

    const store = new PgNotificationStore(getPool());
    const updated = await withAppTx(getPool(), DEV_TENANT_ID, (client) =>
      store.markRead(client, nonExistentId, actor),
    );

    expect(updated, 'markRead returns false for missing row').toBe(false);
  });

  it('returns false when called with wrong recipientId (foreign row, no mutation)', async () => {
    const actor = await getDevEmployee();
    const wrongRecipient = uuid(); // not a seeded employee UUID

    const id = await insertNotif(actor, { isRead: false });

    const store = new PgNotificationStore(getPool());
    const updated = await withAppTx(getPool(), DEV_TENANT_ID, (client) =>
      store.markRead(client, id, wrongRecipient),
    );

    expect(updated, 'markRead with wrong recipient returns false').toBe(false);

    // Verify row still unread (no mutation)
    await withMigratorClient(async (c) => {
      const { rows } = await c.query(
        `SELECT is_read FROM choros.notification WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT_ID, id],
      );
      expect(rows[0].is_read, 'is_read must still be false (no mutation)').toBe(false);
    });

    await cleanNotifRows([id]);
  });
});

// ---------------------------------------------------------------------------
// AC-7: batchMarkRead — own rows updated, foreign ids silently skipped
// ---------------------------------------------------------------------------

describe('AC-7: batchMarkRead updates own rows, silently skips foreign ids', () => {
  it('updates 3 own rows and returns correct count', async () => {
    const actor = await getDevEmployee();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await insertNotif(actor, { isRead: false }));
    }

    const store = new PgNotificationStore(getPool());
    const updated = await withAppTx(getPool(), DEV_TENANT_ID, (client) =>
      store.batchMarkRead(client, ids, actor),
    );

    expect(updated, 'batchMarkRead must return 3').toBe(3);

    // Verify all are read
    await withMigratorClient(async (c) => {
      const { rows } = await c.query(
        `SELECT id, is_read FROM choros.notification WHERE tenant_id = $1 AND id = ANY($2)`,
        [DEV_TENANT_ID, ids],
      );
      for (const row of rows) {
        expect(row.is_read, `row ${row.id} must be read`).toBe(true);
      }
    });

    await cleanNotifRows(ids);
  });

  it('foreign ids silently skipped (updated count = only own rows)', async () => {
    const actor = await getDevEmployee();
    const ownId = await insertNotif(actor, { isRead: false });
    const foreignId = uuid(); // non-existent / wrong recipient

    const store = new PgNotificationStore(getPool());
    const updated = await withAppTx(getPool(), DEV_TENANT_ID, (client) =>
      store.batchMarkRead(client, [ownId, foreignId], actor),
    );

    expect(updated, 'only own row counted').toBe(1);

    await cleanNotifRows([ownId]);
  });

  it('returns 0 for empty ids array', async () => {
    const actor = await getDevEmployee();
    const store = new PgNotificationStore(getPool());
    const updated = await withAppTx(getPool(), DEV_TENANT_ID, (client) =>
      store.batchMarkRead(client, [], actor),
    );
    expect(updated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-9: cross-tenant isolation — uses notification_preference (no FK) to probe RLS
// The RLS mechanism (FORCE RLS + tenant_id GUC) is the same for all tenant tables.
// This is consistent with the existing notifications.test.ts (AC-16) approach.
// ---------------------------------------------------------------------------

describe('AC-9: cross-tenant isolation (RLS via notification_preference probe)', () => {
  it('notification_preference row for TENANT_A not visible from TENANT_B context', async () => {
    const eventKind = `t0173-ct-${uuid().slice(0, 8)}`;

    // Seed a preference row for TENANT_A via migrator (bypasses RLS)
    await withMigratorClient(async (c) => {
      await c.query(
        `INSERT INTO choros.notification_preference
           (tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at)
         VALUES ($1, $2, 'actor:test', ARRAY['in_app'], 'test', 0)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, eventKind],
      );
    });

    // Visible from TENANT_A context
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(
        `SELECT 1 FROM choros.notification_preference
          WHERE tenant_id = $1 AND event_kind = $2`,
        [TENANT_A, eventKind],
      );
      await c.query('COMMIT');
      expect(rows.length, 'TENANT_A row visible from TENANT_A context').toBe(1);
    });

    // Not visible from TENANT_B context (RLS)
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

    // Cleanup
    await withMigratorClient(async (c) => {
      await c.query(
        `DELETE FROM choros.notification_preference WHERE tenant_id = $1 AND event_kind = $2`,
        [TENANT_A, eventKind],
      );
    });
  });

  it('notification table RLS: DEV_TENANT notification row not visible without GUC', async () => {
    // Probe using a real notification row: visible with GUC, invisible without GUC.
    const actor = await getDevEmployee();
    const id = await insertNotif(actor);

    // WITH correct GUC — visible via app user
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT_ID}'`);
      const { rows } = await c.query(
        `SELECT 1 FROM choros.notification WHERE id = $1`,
        [id],
      );
      await c.query('COMMIT');
      expect(rows.length, 'row visible with correct GUC').toBe(1);
    });

    // WITHOUT GUC — invisible (default-DENY RLS)
    await withClient(appUrl(), async (c) => {
      // No SET LOCAL — GUC not set
      const { rows } = await c.query(
        `SELECT 1 FROM choros.notification WHERE id = $1`,
        [id],
      );
      expect(rows.length, 'row invisible without GUC (default-DENY RLS)').toBe(0);
    });

    await cleanNotifRows([id]);
  });
});
