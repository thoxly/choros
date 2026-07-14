/**
 * src/db/audit-writer.ts
 *
 * T-0068: the canonical audit writer `appendAuditEvent` (T-0016 §4.4), deferred by
 * T-0016 §6.3 to "T-0053 + dependent build tasks" and owned here as the first
 * dependent build task that needs it. This module is the SINGLE sanctioned write
 * path to choros.audit_event / choros.audit_head (FF-11) — no other production
 * module issues SQL against those tables.
 *
 * The writer runs INSIDE the caller's open transaction (enqueueInTx pattern,
 * T-0062): it takes a PgClientLike already under withTenant (choros.tenant_id GUC
 * set), never opens/commits its own BEGIN. Per-tenant serialization is via
 * `audit_head ... FOR UPDATE` only — NEVER a global SEQUENCE / advisory lock (NF-2).
 *
 * DESIGN INVARIANTS (ADR §4.2 / §5):
 *  - Append+head advance happen in the caller's tx → caller ROLLBACK undoes both.
 *  - Only INSERT on audit_event (append-only, NF-6) — no UPDATE/DELETE.
 *  - InMemoryAuditWriter computes the SAME preimage/row_hash as the Postgres path
 *    (one canonicalPreimage module) so static-now and live-DB never diverge.
 */

import type { AuditEventInput } from "../core/audit-grant-encoder.js";
import {
  canonicalPreimage,
  GENESIS_PREV_HASH,
  GENESIS_SEQ,
  VOCAB_VERSION,
  type CanonicalAuditRow,
} from "../core/audit-preimage.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/** Result of one append: the assigned seq and the computed row_hash. */
export interface AppendedAuditEvent {
  seq: number;
  rowHash: Buffer;
}

/**
 * Minimal pg client surface (compatible with pg.PoolClient) — a client already
 * inside an open transaction under withTenant. The writer does NOT take a pool.
 */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The canonical audit writer port. */
export interface AuditWriter {
  appendAuditEvent(tx: PgClientLike, input: AuditEventInput): Promise<AppendedAuditEvent>;
}

// ---------------------------------------------------------------------------
// Shared: assemble the canonical row + compute row_hash (one encoding path).
// ---------------------------------------------------------------------------

function buildRow(
  tenantId: string,
  seq: number,
  prevHash: Buffer,
  input: AuditEventInput,
): CanonicalAuditRow {
  return {
    tenant_id: tenantId,
    seq,
    id: input.id,
    type: input.type,
    actor: input.actor,
    subject: input.subject,
    scope: input.scope ?? null,
    via: input.via,
    proposed_by: input.proposed_by,
    confirmed_by: input.confirmed_by,
    payload: input.payload,
    occurred_at: input.occurred_at,
    prev_hash: prevHash,
    vocab_version: VOCAB_VERSION,
  };
}

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

interface HeadRow {
  seq: string | number;
  row_hash: Buffer;
  vocab_version: number;
}

// ---------------------------------------------------------------------------
// Postgres implementation (ADR §4.2 algorithm).
// ---------------------------------------------------------------------------

// The seed-head sentinel: a head row pre-created at seq = GENESIS_SEQ - 1 = 0 with
// row_hash = GENESIS_PREV_HASH, so EVERY append (including the first) goes through
// the single FOR UPDATE → UPDATE-advance path. This serializes concurrent appends
// per tenant from the very first one — no event-INSERT race (ADR §4.2 alternative).
const SEED_SEQ = GENESIS_SEQ - 1; // = 0

class PgAuditWriter implements AuditWriter {
  async appendAuditEvent(
    tx: PgClientLike,
    input: AuditEventInput,
  ): Promise<AppendedAuditEvent> {
    // The tenant_id is sourced from the GUC the caller set (withTenant), mirroring
    // every other tenant DAO. We read it once for the preimage tenant_id field.
    const tenantRes = (await tx.query(
      `SELECT current_setting('choros.tenant_id', false)::uuid AS tenant_id`,
    )) as { rows: Array<{ tenant_id: string }> };
    const tenantId = tenantRes.rows[0].tenant_id;
    const now = input.occurred_at;

    // 1. Ensure the per-tenant head row exists (seed at seq=0/GENESIS_PREV_HASH).
    //    ON CONFLICT DO NOTHING makes concurrent seeds idempotent; the row is the
    //    serialization anchor. This does NOT trip the advance trigger (INSERT, not
    //    UPDATE). updated_at uses `now` for the seed; the first real append rewrites it.
    await tx.query(
      `INSERT INTO choros.audit_head (tenant_id, seq, row_hash, updated_at, vocab_version)
       VALUES (current_setting('choros.tenant_id', false)::uuid, $1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [SEED_SEQ, GENESIS_PREV_HASH, now, VOCAB_VERSION],
    );

    // 2. Per-tenant lock — FOR UPDATE serializes concurrent appends of this tenant.
    const headRes = (await tx.query(
      `SELECT seq, row_hash, vocab_version
         FROM choros.audit_head
        WHERE tenant_id = current_setting('choros.tenant_id', false)::uuid
        FOR UPDATE`,
    )) as { rows: HeadRow[] };

    const head = headRes.rows[0];
    // head is guaranteed present (we just seeded it). seq advances by exactly +1.
    const seq = Number(head.seq) + 1;
    const prevHash = head.row_hash;

    const row = buildRow(tenantId, seq, prevHash, input);
    const rowHash = sha256(canonicalPreimage(row));

    // 3. INSERT the event row (append-only). scope/payload bound as JSON text →
    //    pg stores as jsonb; the canonical hash bytes come from canonicalPreimage,
    //    independent of pg's storage form.
    await tx.query(
      `INSERT INTO choros.audit_event
         (tenant_id, seq, id, type, actor, subject, scope, via,
          proposed_by, confirmed_by, payload, occurred_at, prev_hash, row_hash, vocab_version)
       VALUES
         (current_setting('choros.tenant_id', false)::uuid,
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        seq,
        input.id,
        input.type,
        input.actor,
        input.subject,
        input.scope === null || input.scope === undefined ? null : JSON.stringify(input.scope),
        input.via,
        input.proposed_by,
        input.confirmed_by,
        JSON.stringify(input.payload),
        input.occurred_at,
        prevHash,
        rowHash,
        VOCAB_VERSION,
      ],
    );

    // 4. Forward-only advance (trigger 007 enforces NEW.seq = OLD.seq + 1).
    await tx.query(
      `UPDATE choros.audit_head
          SET seq = $1, row_hash = $2, updated_at = $3, vocab_version = $4
        WHERE tenant_id = current_setting('choros.tenant_id', false)::uuid`,
      [seq, rowHash, now, VOCAB_VERSION],
    );

    return { seq, rowHash };
  }
}

/** Production Postgres audit writer (single canonical write path). */
export function makePgAuditWriter(): AuditWriter {
  return new PgAuditWriter();
}

// ---------------------------------------------------------------------------
// In-memory implementation (static-now unit tests) — same preimage/row_hash.
// ---------------------------------------------------------------------------

export interface AuditRowSnapshot {
  tenantId: string;
  seq: number;
  id: string;
  type: string;
  actor: string;
  subject: string | null;
  scope: unknown | null;
  via: string | null;
  proposedBy: string | null;
  confirmedBy: string | null;
  payload: unknown;
  occurredAt: number;
  prevHash: Buffer;
  rowHash: Buffer;
  vocabVersion: number;
}

interface MemHead {
  seq: number;
  rowHash: Buffer;
}

/**
 * In-memory AuditWriter for static-now tests. The `tx` argument is ignored (no
 * SQL); the tenant id is supplied via the constructed withTenant-style wrapper in
 * tests. To keep the port identical, callers pass the tenant through a wrapping
 * tx object carrying `__tenantId`. The chain math is byte-identical to Postgres.
 */
export class InMemoryAuditWriter implements AuditWriter {
  private readonly heads = new Map<string, MemHead>();
  private readonly chain = new Map<string, AuditRowSnapshot[]>();

  async appendAuditEvent(
    tx: PgClientLike,
    input: AuditEventInput,
  ): Promise<AppendedAuditEvent> {
    const tenantId = tenantIdOf(tx);
    const head = this.heads.get(tenantId);
    const isGenesis = head === undefined;

    const seq = isGenesis ? GENESIS_SEQ : head.seq + 1;
    const prevHash = isGenesis ? GENESIS_PREV_HASH : head.rowHash;

    const row = buildRow(tenantId, seq, prevHash, input);
    const rowHash = sha256(canonicalPreimage(row));

    this.heads.set(tenantId, { seq, rowHash });
    const rows = this.chain.get(tenantId) ?? [];
    rows.push({
      tenantId,
      seq,
      id: input.id,
      type: input.type,
      actor: input.actor,
      subject: input.subject,
      scope: input.scope ?? null,
      via: input.via,
      proposedBy: input.proposed_by,
      confirmedBy: input.confirmed_by,
      payload: input.payload,
      occurredAt: input.occurred_at,
      prevHash,
      rowHash,
      vocabVersion: VOCAB_VERSION,
    });
    this.chain.set(tenantId, rows);

    return { seq, rowHash };
  }

  /** Snapshot of a tenant's appended rows (for assertions). */
  rows(tenantId: string): ReadonlyArray<AuditRowSnapshot> {
    return this.chain.get(tenantId) ?? [];
  }
}

/**
 * Tx carrier for the in-memory path: a tx object may carry a `__tenantId` marker
 * so InMemoryAuditWriter can serialize a per-tenant chain without a real GUC.
 */
export interface InMemoryTx extends PgClientLike {
  __tenantId: string;
}

/** Build a tx-like carrier for the in-memory writer with the given tenant. */
export function inMemoryTx(tenantId: string): InMemoryTx {
  return {
    __tenantId: tenantId,
    query: async () => ({ rows: [] }),
  };
}

function tenantIdOf(tx: PgClientLike): string {
  const t = (tx as Partial<InMemoryTx>).__tenantId;
  if (typeof t !== "string") {
    throw new Error("InMemoryAuditWriter requires a tx built via inMemoryTx(tenantId)");
  }
  return t;
}
