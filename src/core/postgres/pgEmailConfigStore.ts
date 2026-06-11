/**
 * src/core/postgres/pgEmailConfigStore.ts — T-0170 E-N.3
 *
 * Postgres-backed implementation of EmailConfigWritePort (notification-email.ts).
 * Mirrors choros.email_channel_config (migration 047).
 *
 * RLS invariants (T-0013/T-0053):
 *   - upsert / delete / get: caller MUST have SET choros.tenant_id GUC
 *     (transaction-scoped). RLS + FORCE enforce tenant isolation.
 *   - Fail-closed (NF-1): without GUC → Postgres RLS blocks the operation.
 *
 * Uses raw pg SQL with parameterised queries (NF-3: no ORM).
 * Clock injection follows pgOutboxStore/pgTimerStore pattern.
 */

import type { Pool } from "pg";
import type { EmailChannelConfig, EmailConfigWritePort } from "../notification-email.js";

// ---------------------------------------------------------------------------
// DB row shape (snake_case → camelCase)
// ---------------------------------------------------------------------------

interface EmailConfigDbRow {
  tenant_id: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: boolean;
  from_address: string;
  from_name: string | null;
  smtp_handle: string;
  is_enabled: boolean;
  updated_by: string;
  updated_at: string;   // bigint comes back as string from pg
}

function rowToConfig(row: EmailConfigDbRow): EmailChannelConfig {
  return {
    tenantId: row.tenant_id,
    smtpHost: row.smtp_host,
    smtpPort: Number(row.smtp_port),
    smtpTls: row.smtp_tls,
    fromAddress: row.from_address,
    fromName: row.from_name,
    smtpHandle: row.smtp_handle,
    isEnabled: row.is_enabled,
    updatedBy: row.updated_by,
    updatedAt: Number(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// PgEmailConfigStore — production Postgres implementation
// ---------------------------------------------------------------------------

/**
 * Production Postgres implementation of EmailConfigWritePort.
 * Caller must SET choros.tenant_id GUC before calling upsert/delete/get
 * (RLS + FORCE enforce isolation; without it all operations fail closed).
 */
export class PgEmailConfigStore implements EmailConfigWritePort {
  constructor(private readonly pool: Pool) {}

  /**
   * Upsert email channel config for a tenant.
   * ON CONFLICT (tenant_id) → UPDATE all mutable fields.
   * Caller must have SET choros.tenant_id GUC (RLS enforced).
   */
  async upsert(config: EmailChannelConfig): Promise<void> {
    await this.pool.query(
      `INSERT INTO choros.email_channel_config
         (tenant_id, smtp_host, smtp_port, smtp_tls, from_address, from_name,
          smtp_handle, is_enabled, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id) DO UPDATE SET
         smtp_host    = EXCLUDED.smtp_host,
         smtp_port    = EXCLUDED.smtp_port,
         smtp_tls     = EXCLUDED.smtp_tls,
         from_address = EXCLUDED.from_address,
         from_name    = EXCLUDED.from_name,
         smtp_handle  = EXCLUDED.smtp_handle,
         is_enabled   = EXCLUDED.is_enabled,
         updated_by   = EXCLUDED.updated_by,
         updated_at   = EXCLUDED.updated_at`,
      [
        config.tenantId,
        config.smtpHost,
        config.smtpPort,
        config.smtpTls,
        config.fromAddress,
        config.fromName,
        config.smtpHandle,
        config.isEnabled,
        config.updatedBy,
        config.updatedAt,
      ],
    );
  }

  /**
   * Delete email channel config for a tenant.
   * Returns true if a row was deleted, false if not found.
   * Caller must have SET choros.tenant_id GUC (RLS enforced).
   */
  async delete(tenantId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM choros.email_channel_config WHERE tenant_id = $1`,
      [tenantId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Get email channel config for a tenant.
   * Returns null if not configured.
   * Caller must have SET choros.tenant_id GUC (RLS enforced).
   */
  async get(tenantId: string): Promise<EmailChannelConfig | null> {
    const { rows } = await this.pool.query<EmailConfigDbRow>(
      `SELECT tenant_id, smtp_host, smtp_port, smtp_tls, from_address, from_name,
              smtp_handle, is_enabled, updated_by, updated_at
       FROM choros.email_channel_config
       WHERE tenant_id = $1`,
      [tenantId],
    );
    if (rows.length === 0) return null;
    return rowToConfig(rows[0]);
  }
}
