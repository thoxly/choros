/**
 * src/db/external-participant.ts — T-0205 · ADR T-0122 §2.1 (FR-1).
 *
 * External participant — v1 = DATA ONLY (directory record).
 *
 * An external participant (контрагент по договору, посетитель сайта) is modelled
 * as an ORDINARY tenant `record` (T-0014) under the system "external-participant"
 * directory (registry_def, seeded by migration 056). It is NOT a Keycloak account,
 * NOT a tenant-user, NOT a role (ADR §2.1 / spec FR-1). This module is the v1
 * data-access layer for that directory: create / get / list of external-participant
 * records, tenant-isolated by T-0013 RLS, with a T-0016 audit event on creation.
 *
 * EXPLICITLY OUT OF SCOPE (Stage-2, ADR §2.2–§2.9): the tokenized «внешняя
 * поверхность» channel (external_surface / external_token, derived grant, presign,
 * token-routing). This module introduces NO new authority subsystem and NO new
 * table — the record rides choros.application → registry_def → record, already
 * FORCE-RLS tenant tables proven cross-tenant-isolated by cross_tenant.test.ts.
 *
 * TENANT ISOLATION (T-0013): every query runs inside withTenantTx, which sets
 *   SET LOCAL choros.tenant_id = <tenant>
 * under choros_app (NOBYPASSRLS). A record of tenant B is structurally invisible
 * when the context is tenant A (RLS default-DENY) — same seam as registry-defs.ts.
 *
 * AUDIT (T-0016): creation appends an `external_participant.create` event via the
 * canonical makePgAuditWriter, inside the SAME transaction as the INSERT (so a
 * rollback undoes both). open-vocab `type` = string, not a new table (ADR FR-6).
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { makePgAuditWriter, type PgClientLike } from "./audit-writer.js";

// ---------------------------------------------------------------------------
// Constants — directory identity (matches migration 056 stable UUIDs)
// ---------------------------------------------------------------------------

/** registry_def id of the system "external-participant" directory (migration 056). */
export const EXTERNAL_PARTICIPANT_REGISTRY_ID =
  "a5000000-0000-0000-0000-000000000002";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Pool (lazy singleton — same pattern as registry-defs.ts / org.ts)
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

export function getExternalParticipantPool(): pg.Pool {
  if (!_pool) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      throw new Error("DATABASE_URL not set — cannot build external-participant pool");
    }
    _pool = new pg.Pool({ connectionString: url });
  }
  return _pool;
}

/** Reset the module-level pool singleton. FOR TESTING ONLY. */
export function resetPoolForTesting(): void {
  _pool = null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The v1 data shape of an external participant. Mirrors registry_def 056
 * record_schema. Descriptive data only — NO credentials, NO token, NO access
 * surface (that is Stage-2).
 */
export interface ExternalParticipantData {
  display_name: string;
  kind: "counterparty" | "visitor";
  inn?: string;
  contact_email?: string;
  note?: string;
}

/** A materialised external-participant record (a row of choros.record). */
export interface ExternalParticipant {
  id: string;
  data: ExternalParticipantData;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

interface RecordRow {
  id: string;
  data: ExternalParticipantData;
  created_at: string | number;
  updated_at: string | number;
  created_by: string;
}

function rowToParticipant(r: RecordRow): ExternalParticipant {
  return {
    id: r.id,
    data: r.data,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    createdBy: r.created_by,
  };
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors registry-defs.ts (T-0013 RLS)
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID`);
  }
}

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Validation — v1 data shape (mirrors registry_def 056 required fields)
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set<ExternalParticipantData["kind"]>([
  "counterparty",
  "visitor",
]);

/**
 * Validate the v1 data shape. Returns the normalised data or throws Error with a
 * stable message. Only the descriptive shape is enforced — no auth/token fields
 * exist to validate (Stage-2).
 */
export function validateParticipantData(input: unknown): ExternalParticipantData {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("external participant data must be a JSON object");
  }
  const o = input as Record<string, unknown>;

  const displayName = o["display_name"];
  if (typeof displayName !== "string" || displayName.trim() === "") {
    throw new Error("display_name is required and must be a non-empty string");
  }

  const kind = o["kind"];
  if (typeof kind !== "string" || !VALID_KINDS.has(kind as ExternalParticipantData["kind"])) {
    throw new Error('kind is required and must be one of "counterparty" | "visitor"');
  }

  const data: ExternalParticipantData = {
    display_name: displayName,
    kind: kind as ExternalParticipantData["kind"],
  };

  for (const key of ["inn", "contact_email", "note"] as const) {
    const v = o[key];
    if (v !== undefined && v !== null) {
      if (typeof v !== "string") {
        throw new Error(`${key} must be a string when present`);
      }
      data[key] = v;
    }
  }

  return data;
}

// ---------------------------------------------------------------------------
// createExternalParticipant — insert a directory record + audit event
// ---------------------------------------------------------------------------

/**
 * Create an external-participant directory record for `tenantId`.
 *
 * Runs the INSERT and the T-0016 audit append in ONE transaction under the
 * tenant RLS context. Returns the new record id. The record is an ordinary
 * choros.record under the system external-participant directory — no new entity.
 */
export async function createExternalParticipant(args: {
  pool: pg.Pool;
  tenantId: string;
  actor: string;
  data: unknown;
  nowMs?: number;
  idOverride?: string;
}): Promise<ExternalParticipant> {
  const { pool, tenantId, actor } = args;
  const nowMs = args.nowMs ?? Date.now();
  const id = args.idOverride ?? randomUUID();
  const data = validateParticipantData(args.data);

  return withTenantTx(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO choros.record
         (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6)`,
      [
        tenantId,
        id,
        EXTERNAL_PARTICIPANT_REGISTRY_ID,
        JSON.stringify(data),
        nowMs,
        actor,
      ],
    );

    // Audit (T-0016) — same tx, open-vocab type string, no secret in payload.
    const writer = makePgAuditWriter();
    await writer.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "external_participant.create",
      actor,
      subject: id,
      scope: { registry_def_id: EXTERNAL_PARTICIPANT_REGISTRY_ID, record_id: id },
      via: "external-participant-directory",
      proposed_by: null,
      confirmed_by: actor,
      payload: { kind: data.kind, display_name: data.display_name },
      occurred_at: nowMs,
    });

    return {
      id,
      data,
      createdAt: nowMs,
      updatedAt: nowMs,
      createdBy: actor,
    };
  });
}

// ---------------------------------------------------------------------------
// getExternalParticipant — fetch one record by id (tenant-scoped)
// ---------------------------------------------------------------------------

/**
 * Fetch one external-participant record by id within `tenantId`. Returns null if
 * absent — which, under RLS, also covers "exists but belongs to another tenant"
 * (a cross-tenant id is structurally invisible, so it reads as not-found).
 */
export async function getExternalParticipant(args: {
  pool: pg.Pool;
  tenantId: string;
  id: string;
}): Promise<ExternalParticipant | null> {
  const { pool, tenantId, id } = args;
  assertUuidShape(id, "external participant id");

  return withTenantTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<RecordRow>(
      `SELECT id, data, created_at, updated_at, created_by
         FROM choros.record
        WHERE tenant_id = $1
          AND id = $2
          AND registry_id = $3`,
      [tenantId, id, EXTERNAL_PARTICIPANT_REGISTRY_ID],
    );
    const row = rows[0];
    return row ? rowToParticipant(row) : null;
  });
}

// ---------------------------------------------------------------------------
// listExternalParticipants — list all records in the directory (tenant-scoped)
// ---------------------------------------------------------------------------

/**
 * List all external-participant records visible in `tenantId`. RLS guarantees
 * only this tenant's rows are returned — tenant A never sees tenant B's records.
 */
export async function listExternalParticipants(args: {
  pool: pg.Pool;
  tenantId: string;
}): Promise<ExternalParticipant[]> {
  const { pool, tenantId } = args;

  return withTenantTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<RecordRow>(
      `SELECT id, data, created_at, updated_at, created_by
         FROM choros.record
        WHERE tenant_id = $1
          AND registry_id = $2
        ORDER BY created_at ASC, id ASC`,
      [tenantId, EXTERNAL_PARTICIPANT_REGISTRY_ID],
    );
    return rows.map(rowToParticipant);
  });
}
