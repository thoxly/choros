/**
 * src/core/postgres/pgConnectorStore.ts — T-0128 / T-0206
 *
 * Postgres-backed implementation of ConnectorWritePort (connector.ts).
 * Mirrors choros.connector (migration 054). Mirrors pgEmailConfigStore.ts.
 *
 * RLS invariants (T-0013 / T-0053):
 *   - insert / update / get / list / delete: caller MUST have SET choros.tenant_id GUC
 *     (transaction-scoped). RLS + FORCE enforce tenant isolation.
 *   - Fail-closed (NF-1): without the GUC → Postgres RLS blocks the operation.
 *
 * Uses raw pg SQL with parameterised queries (NF-3: no ORM). This is a thin DAO — it
 * is NOT a connector driver and makes NO external (1С/AD/SMTP/HTTP) call.
 */

import type { Pool } from "pg";
import type { Connector, ConnectorWritePort } from "../connector.js";
import { isConnectorKind, isConnectorStatus } from "../connector.js";

// ---------------------------------------------------------------------------
// DB row shape (snake_case → camelCase)
// ---------------------------------------------------------------------------

interface ConnectorDbRow {
  tenant_id: string;
  id: string;
  kind: string;
  display_name: string;
  config: Record<string, unknown>;
  secret_handle: string | null;
  status: string;
  backs_effect_resource_id: string | null;
  created_by: string;
  created_at: string; // bigint comes back as string from pg
  updated_by: string;
  updated_at: string; // bigint comes back as string from pg
}

function rowToConnector(row: ConnectorDbRow): Connector {
  // kind/status come from a CHECK-constrained column; the guards keep the domain type
  // total and fail-closed if a future migration widens the column unexpectedly.
  if (!isConnectorKind(row.kind)) {
    throw new Error(`pgConnectorStore: unexpected connector kind '${row.kind}'`);
  }
  if (!isConnectorStatus(row.status)) {
    throw new Error(`pgConnectorStore: unexpected connector status '${row.status}'`);
  }
  return {
    tenantId: row.tenant_id,
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    config: row.config ?? {},
    secretHandle: row.secret_handle,
    status: row.status,
    backsEffectResourceId: row.backs_effect_resource_id,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: Number(row.updated_at),
  };
}

const SELECT_COLS = `tenant_id, id, kind, display_name, config, secret_handle, status,
        backs_effect_resource_id, created_by, created_at, updated_by, updated_at`;

// ---------------------------------------------------------------------------
// PgConnectorStore — production Postgres implementation
// ---------------------------------------------------------------------------

/**
 * Production Postgres implementation of ConnectorWritePort.
 * Caller must SET choros.tenant_id GUC before any operation (RLS + FORCE enforce
 * isolation; without it all operations fail closed).
 */
export class PgConnectorStore implements ConnectorWritePort {
  constructor(private readonly pool: Pool) {}

  async insert(c: Connector): Promise<void> {
    await this.pool.query(
      `INSERT INTO choros.connector
         (tenant_id, id, kind, display_name, config, secret_handle, status,
          backs_effect_resource_id, created_by, created_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
      [
        c.tenantId,
        c.id,
        c.kind,
        c.displayName,
        JSON.stringify(c.config),
        c.secretHandle,
        c.status,
        c.backsEffectResourceId,
        c.createdBy,
        c.createdAt,
        c.updatedBy,
        c.updatedAt,
      ],
    );
  }

  async update(c: Connector): Promise<void> {
    await this.pool.query(
      `UPDATE choros.connector SET
         kind                     = $3,
         display_name             = $4,
         config                   = $5::jsonb,
         secret_handle            = $6,
         status                   = $7,
         backs_effect_resource_id = $8,
         updated_by               = $9,
         updated_at               = $10
       WHERE tenant_id = $1 AND id = $2`,
      [
        c.tenantId,
        c.id,
        c.kind,
        c.displayName,
        JSON.stringify(c.config),
        c.secretHandle,
        c.status,
        c.backsEffectResourceId,
        c.updatedBy,
        c.updatedAt,
      ],
    );
  }

  async get(tenantId: string, id: string): Promise<Connector | null> {
    const { rows } = await this.pool.query<ConnectorDbRow>(
      `SELECT ${SELECT_COLS}
       FROM choros.connector
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (rows.length === 0) return null;
    return rowToConnector(rows[0]);
  }

  async list(tenantId: string): Promise<Connector[]> {
    const { rows } = await this.pool.query<ConnectorDbRow>(
      `SELECT ${SELECT_COLS}
       FROM choros.connector
       WHERE tenant_id = $1
       ORDER BY created_at ASC, id ASC`,
      [tenantId],
    );
    return rows.map(rowToConnector);
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM choros.connector WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return (rowCount ?? 0) > 0;
  }
}
