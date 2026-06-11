/**
 * src/core/postgres/pgNotificationStore.ts — T-0173 E-N.6
 *
 * Postgres-backed DAO for choros.notification (migration 046).
 * Implements NotifInsertPort from notification-router.ts plus list/countUnread/markRead.
 *
 * DESIGN INVARIANTS (ADR T-0120 §2.2/§2.7/§5 E-N.6):
 *  - Implements NotifInsertPort (insert) imported from notification-router.ts — NOT redeclared.
 *  - list: keyset pagination by (created_at, id) via idx_notification_listing.
 *  - countUnread: COUNT(*) WHERE is_read=false — uses idx_notification_unread (partial index).
 *  - markRead / batchMarkRead: UPDATE WHERE recipient_id = actor (own-only, no cross-user mutation).
 *  - No appendAuditEvent anywhere (FF-NO-ISREAD-AUDIT / FF-NO-DELIVERY-AUDIT: is_read not audited).
 *  - All operations require caller to SET LOCAL choros.tenant_id GUC in active transaction.
 *  - Fail-closed: without GUC, RLS returns 0 rows / blocks DML (Postgres-enforced).
 *  - No new at-least-once: mark-read = direct UPDATE, not outbox.
 *
 * Semantic contract: docs/design/T-0120-notifications.adr.md §2.2/§2.7; spec T-0173.
 */

import type { Pool, PoolClient } from "pg";
import type { NotifInsertPort, NotifInsertRow } from "../notification-router.js";

// ---------------------------------------------------------------------------
// Minimal client surface (transaction-scoped, GUC already set by caller)
// ---------------------------------------------------------------------------

/**
 * Minimal pg client surface used inside transactions.
 * Compatible with pg.PoolClient (already inside BEGIN ... COMMIT).
 */
export interface PgNotifClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

// ---------------------------------------------------------------------------
// DB row shape
// ---------------------------------------------------------------------------

interface NotifDbRow {
  tenant_id: string;
  id: string;
  recipient_id: string;
  event_kind: string;
  title: string;
  body: string;
  object_ref: string | null;
  is_read: boolean;
  created_at: string;   // bigint comes back as string from pg
  expires_at: string | null;
}

// ---------------------------------------------------------------------------
// Public row type (camelCase)
// ---------------------------------------------------------------------------

export interface NotificationRow {
  readonly tenantId: string;
  readonly id: string;
  readonly recipientId: string;
  readonly eventKind: string;
  readonly title: string;
  readonly body: string;
  readonly objectRef: string | null;
  readonly isRead: boolean;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

function rowToNotification(r: NotifDbRow): NotificationRow {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    recipientId: r.recipient_id,
    eventKind: r.event_kind,
    title: r.title,
    body: r.body,
    objectRef: r.object_ref,
    isRead: r.is_read,
    createdAt: Number(r.created_at),
    expiresAt: r.expires_at !== null ? Number(r.expires_at) : null,
  };
}

// ---------------------------------------------------------------------------
// Keyset cursor
// ---------------------------------------------------------------------------

/**
 * Opaque keyset cursor for listing pagination.
 * Encodes the last row's (createdAt, id) position.
 */
export interface NotifCursor {
  readonly createdAt: number;
  readonly id: string;
}

/**
 * Serialize cursor to a base64 string for use in REST responses.
 */
export function serializeCursor(cursor: NotifCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * Deserialize cursor from base64 string. Returns null on parse error.
 */
export function deserializeCursor(raw: string): NotifCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      "id" in parsed &&
      typeof (parsed as Record<string, unknown>)["createdAt"] === "number" &&
      typeof (parsed as Record<string, unknown>)["id"] === "string"
    ) {
      return {
        createdAt: (parsed as Record<string, unknown>)["createdAt"] as number,
        id: (parsed as Record<string, unknown>)["id"] as string,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// List parameters
// ---------------------------------------------------------------------------

export interface ListParams {
  /** Recipient UUID — ALWAYS server-constructed from actor identity (never from request body). */
  readonly recipientId: string;
  /** Max rows to return (default 20, max 100). */
  readonly limit?: number;
  /** Keyset cursor — if provided, return rows strictly before this position. */
  readonly cursor?: NotifCursor | null;
  /** Optional is_read filter. */
  readonly isRead?: boolean | null;
}

export interface ListResult {
  readonly rows: NotificationRow[];
  readonly nextCursor: NotifCursor | null;
}

// ---------------------------------------------------------------------------
// PgNotificationStore
// ---------------------------------------------------------------------------

/**
 * Postgres-backed notification DAO.
 * Implements NotifInsertPort (used by publishNotificationEvent T-0169).
 * Provides list / countUnread / markRead / batchMarkRead for REST endpoints.
 *
 * Caller MUST have SET LOCAL choros.tenant_id GUC in active transaction
 * before calling any write/read method.  RLS enforces tenant isolation.
 * Without GUC: SELECT → 0 rows, DML → blocked by RLS.
 */
export class PgNotificationStore implements NotifInsertPort {
  constructor(private readonly pool: Pool) {}

  // ---------------------------------------------------------------------------
  // NotifInsertPort — used by publishNotificationEvent (T-0169)
  // ---------------------------------------------------------------------------

  /**
   * Insert one choros.notification row.
   * Caller must have SET LOCAL choros.tenant_id GUC (RLS-enforced).
   * Uses pool connection — NOT transaction-scoped; fanout callers handle the tx.
   */
  async insert(row: NotifInsertRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO choros.notification
         (tenant_id, id, recipient_id, event_kind, title, body, object_ref,
          is_read, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9)`,
      [
        row.tenantId,
        row.id,
        row.recipientId,
        row.eventKind,
        row.title,
        row.body,
        row.objectRef,
        row.createdAt,
        row.expiresAt,
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // REST operations (transaction-scoped; caller passes PgNotifClientLike)
  // ---------------------------------------------------------------------------

  /**
   * List notifications with keyset pagination.
   * Uses idx_notification_listing (tenant_id, recipient_id, created_at, id).
   * ORDER BY created_at DESC, id DESC — newest first.
   * Cursor: (created_at, id) < cursor position (strict keyset, no duplicates/gaps).
   *
   * recipientId MUST be the authenticated actor — never from request parameters.
   */
  async list(client: PgNotifClientLike, params: ListParams): Promise<ListResult> {
    const limit = Math.min(params.limit ?? 20, 100);
    const fetchLimit = limit + 1;  // fetch one extra to determine if there's a next page

    const args: unknown[] = [params.recipientId, fetchLimit];
    const conditions: string[] = [
      "recipient_id = $1",
    ];

    if (params.isRead !== undefined && params.isRead !== null) {
      args.push(params.isRead);
      conditions.push(`is_read = $${args.length}`);
    }

    if (params.cursor) {
      // Keyset: strictly before (createdAt, id) using row-value comparison
      // (created_at, id) < (cursor.createdAt, cursor.id)
      // This is correctly index-supported by idx_notification_listing.
      args.push(params.cursor.createdAt, params.cursor.id);
      const caIdx = args.length - 1;
      const idIdx = args.length;
      conditions.push(`(created_at, id) < ($${caIdx}, $${idIdx})`);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const sql = `
      SELECT tenant_id, id, recipient_id, event_kind, title, body, object_ref,
             is_read, created_at, expires_at
        FROM choros.notification
        ${whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT $2
    `;

    const { rows: rawRows } = await client.query(sql, args);
    const allRows = (rawRows as NotifDbRow[]).map(rowToNotification);

    const hasNext = allRows.length > limit;
    const rows = hasNext ? allRows.slice(0, limit) : allRows;
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
    const nextCursor: NotifCursor | null = hasNext && lastRow
      ? { createdAt: lastRow.createdAt, id: lastRow.id }
      : null;

    return { rows, nextCursor };
  }

  /**
   * Count unread notifications for a recipient.
   * Uses idx_notification_unread (partial index WHERE is_read = false) — small, hot.
   * EXPLAIN on this query must show Index Scan on idx_notification_unread (FF-UNREAD-INDEXED).
   *
   * recipientId MUST be the authenticated actor.
   */
  async countUnread(client: PgNotifClientLike, recipientId: string): Promise<number> {
    // This query is intentionally simple to maximally use the partial index:
    //   idx_notification_unread ON notification (tenant_id, recipient_id) WHERE is_read = false
    // The WHERE is_read = false predicate matches the partial index condition,
    // so Postgres uses Index Scan / Index Only Scan instead of seq-scan.
    const { rows } = await client.query(
      `SELECT COUNT(*)::bigint AS cnt
         FROM choros.notification
        WHERE recipient_id = $1 AND is_read = false`,
      [recipientId],
    );
    const row = (rows as Array<{ cnt: string }>)[0];
    return row ? Number(row.cnt) : 0;
  }

  /**
   * Mark one notification as read.
   * Only matches rows WHERE id = $notifId AND recipient_id = $recipientId.
   * Cross-user: if recipient_id doesn't match actor → returns false (no mutation).
   * Returns true if the row was found and updated, false otherwise.
   *
   * No appendAuditEvent (FF-NO-ISREAD-AUDIT: is_read not audited per ADR §2.8).
   */
  async markRead(
    client: PgNotifClientLike,
    notifId: string,
    recipientId: string,
  ): Promise<boolean> {
    // UPDATE WHERE id = $1 AND recipient_id = $2 ensures own-only mutation (FF-NO-CROSS-USER).
    // Cross-user or missing row → rowCount = 0 → false.
    const { rowCount } = await client.query(
      `UPDATE choros.notification
          SET is_read = true
        WHERE id = $1 AND recipient_id = $2`,
      [notifId, recipientId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Batch mark-read.
   * UPDATE WHERE id = ANY($1) AND recipient_id = $2.
   * Only own rows are matched; foreign ids are silently skipped (no per-id 403).
   * Returns count of updated rows.
   *
   * No appendAuditEvent (FF-NO-ISREAD-AUDIT).
   */
  async batchMarkRead(
    client: PgNotifClientLike,
    ids: string[],
    recipientId: string,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const { rowCount } = await client.query(
      `UPDATE choros.notification
          SET is_read = true
        WHERE id = ANY($1) AND recipient_id = $2`,
      [ids, recipientId],
    );
    return rowCount ?? 0;
  }
}
