/**
 * src/core/postgres/pgPrefStore.ts — T-0171 E-N.4
 *
 * Postgres-backed notification_preference store.
 * Implements NotificationPrefStore (port used by notification-router T-0169)
 * plus CRUD operations used by the admin/self REST endpoints.
 *
 * DESIGN INVARIANTS:
 *  - Implements NotificationPrefStore from notification-router.ts (pure port, no re-decl).
 *  - All SQL operates under RLS: caller MUST SET choros.tenant_id GUC before calling
 *    read/write methods via a transaction (appUrl / NOBYPASSRLS).
 *  - Fail-closed: without GUC → RLS returns 0 rows (Postgres-enforced).
 *  - UPSERT: ON CONFLICT (tenant_id, event_kind, recipient_scope) DO UPDATE channels.
 *  - seedDefaultPreferences: idempotent (ON CONFLICT DO NOTHING, like T-0026 genesis-owner).
 *  - No new ACL mechanism: authorization is the caller's responsibility (PDP T-0021).
 *  - No second outbox/dispatcher: this module touches only notification_preference table.
 *
 * Semantic contract: docs/design/T-0120-notifications.adr.md §2.4/§4.3/§5 E-N.4.
 * Spec: docs/specs/T-0171-notification-preferences.spec.md.
 */

import pg from "pg";
import type {
  NotificationPreference,
  NotificationPrefStore,
} from "../notification-router.js";

// ---------------------------------------------------------------------------
// DB row shape (snake_case → camelCase mapping)
// ---------------------------------------------------------------------------

interface PrefDbRow {
  tenant_id: string;
  event_kind: string;
  recipient_scope: string;
  channels: string[];  // pg returns text[] as JS string[] via pg driver
  updated_by: string;
  updated_at: string;  // bigint comes back as string from pg
}

function rowToPreference(r: PrefDbRow): NotificationPreference {
  return {
    tenantId: r.tenant_id,
    eventKind: r.event_kind,
    recipientScope: r.recipient_scope,
    channels: Array.isArray(r.channels) ? r.channels : [],
  };
}

// ---------------------------------------------------------------------------
// pgPrefStore — injectable client (transaction-scoped) variant
// ---------------------------------------------------------------------------

/**
 * Minimal pg client surface — compatible with pg.PoolClient already inside an
 * open transaction under withTenant (SET LOCAL choros.tenant_id GUC already set).
 * The caller owns the transaction; this module does NOT open/commit/rollback.
 */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Full preference row for upsert (all fields including audit trail).
 */
export interface PrefUpsertRow {
  readonly tenantId: string;
  readonly eventKind: string;
  readonly recipientScope: string;
  readonly channels: string[];
  readonly updatedBy: string;
  readonly updatedAt: number;
}

/**
 * PostgresPrefStore: implements NotificationPrefStore (read port for router T-0169)
 * plus upsert / listByTenant / delete operations for REST endpoints.
 *
 * Pool-based (each operation acquires a connection, sets GUC, releases it).
 * For transactional use (e.g. combined with appendAuditEvent), pass a PgClientLike
 * directly to the static methods below.
 */
export class PostgresPrefStore implements NotificationPrefStore {
  constructor(private readonly pool: pg.Pool) {}

  // ---------------------------------------------------------------------------
  // NotificationPrefStore port (used by publishNotificationEvent in router T-0169)
  // ---------------------------------------------------------------------------

  /**
   * Read preferences for (tenantId, eventKind).
   * Caller MUST ensure GUC is set (the pool connection used here uses choros_app
   * credentials with NOBYPASSRLS — RLS enforces tenant isolation automatically
   * when tenant_id GUC matches).
   *
   * Implementation: opens a short-lived transaction, sets GUC SET LOCAL, queries,
   * commits — mirrors pgOutboxStore.claimBatch pattern.
   */
  async getPreferences(tenantId: string, eventKind: string): Promise<NotificationPreference[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const { rows } = await client.query(
        `SELECT tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at
           FROM choros.notification_preference
          WHERE tenant_id = $1 AND event_kind = $2
          ORDER BY recipient_scope`,
        [tenantId, eventKind],
      );
      await client.query("COMMIT");
      return (rows as PrefDbRow[]).map(rowToPreference);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // CRUD operations for REST handlers
  // ---------------------------------------------------------------------------

  /**
   * UPSERT a preference row.
   * ON CONFLICT (tenant_id, event_kind, recipient_scope) DO UPDATE channels + audit fields.
   * Caller-provided client must have GUC set (called inside a withTenantTx callback).
   */
  async upsert(client: PgClientLike, row: PrefUpsertRow): Promise<void> {
    await client.query(
      `INSERT INTO choros.notification_preference
         (tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, event_kind, recipient_scope)
       DO UPDATE SET
         channels   = EXCLUDED.channels,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at`,
      [row.tenantId, row.eventKind, row.recipientScope, row.channels, row.updatedBy, row.updatedAt],
    );
  }

  /**
   * List all preferences for the current tenant (RLS-enforced).
   * Caller-provided client must have GUC set.
   */
  async listByTenant(client: PgClientLike): Promise<NotificationPreference[]> {
    const { rows } = await client.query(
      `SELECT tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at
         FROM choros.notification_preference
        ORDER BY event_kind, recipient_scope`,
    );
    return (rows as PrefDbRow[]).map(rowToPreference);
  }

  /**
   * List preferences for the current tenant filtered to a specific event_kind.
   * Caller-provided client must have GUC set.
   */
  async listByEventKind(client: PgClientLike, eventKind: string): Promise<NotificationPreference[]> {
    const { rows } = await client.query(
      `SELECT tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at
         FROM choros.notification_preference
        WHERE event_kind = $1
        ORDER BY recipient_scope`,
      [eventKind],
    );
    return (rows as PrefDbRow[]).map(rowToPreference);
  }

  /**
   * Delete a preference by (event_kind, recipient_scope) for current tenant.
   * Caller-provided client must have GUC set.
   */
  async delete(client: PgClientLike, eventKind: string, recipientScope: string): Promise<void> {
    await client.query(
      `DELETE FROM choros.notification_preference
        WHERE event_kind = $1 AND recipient_scope = $2`,
      [eventKind, recipientScope],
    );
  }
}

// ---------------------------------------------------------------------------
// seedDefaultPreferences — idempotent genesis-tenant defaults
// ADR §2.4: 5 day-1 subscriptions per T-0171 spec §FR-3.
// Uses ON CONFLICT DO NOTHING (like T-0026 genesis-owner seed).
// ---------------------------------------------------------------------------

/**
 * Default preference rows to seed at genesis-tenant time.
 * Keys: event_kind + recipient_scope. Channels follow ADR §2.4.
 *
 * NOTE: 'actor:assignee' / 'actor:approver' are sentinel scope values — they do not
 * refer to a specific employee UUID. publishNotificationEvent's expandScope will
 * return [] for unknown actor IDs, making these rows effectively silent at fanout
 * until real employee-specific rows are configured by the tenant-admin or via the
 * self-endpoint. This is correct: genesis defaults define the channel policy, not
 * the concrete recipients.
 */
export const DEFAULT_PREFERENCES: ReadonlyArray<{
  eventKind: string;
  recipientScope: string;
  channels: string[];
}> = [
  { eventKind: "task.assigned",      recipientScope: "actor:assignee",   channels: ["in_app"] },
  { eventKind: "approval.requested", recipientScope: "actor:approver",   channels: ["in_app"] },
  { eventKind: "sla.warning",        recipientScope: "object_owner",     channels: ["in_app", "email"] },
  { eventKind: "sla.breach",         recipientScope: "object_owner",     channels: ["in_app", "email"] },
  { eventKind: "escalation.raised",  recipientScope: "escalation_chain", channels: ["in_app", "email"] },
];

/**
 * Seed the 5 default notification preferences for a genesis tenant.
 * Idempotent: ON CONFLICT DO NOTHING — existing rows are not modified.
 * Runs inside the caller's open transaction (caller sets GUC via SET LOCAL).
 *
 * Pattern: verbatim T-0026 genesis-owner seed (additive INSERT, ON CONFLICT DO NOTHING).
 *
 * @param client   - pg client with choros.tenant_id GUC set (transaction-scoped)
 * @param tenantId - UUID of the tenant being seeded
 * @param updatedAt - epoch ms for the seed rows' audit trail
 */
export async function seedDefaultPreferences(
  client: PgClientLike,
  tenantId: string,
  updatedAt: number = 0,
): Promise<void> {
  for (const def of DEFAULT_PREFERENCES) {
    await client.query(
      `INSERT INTO choros.notification_preference
         (tenant_id, event_kind, recipient_scope, channels, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, 'seed', $5)
       ON CONFLICT DO NOTHING`,
      [tenantId, def.eventKind, def.recipientScope, def.channels, updatedAt],
    );
  }
}
