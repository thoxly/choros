/**
 * T-0356 (E16) — Unit tests for appendProcessStarted recordId parameter.
 *
 * Verifies:
 *   PP-1: when recordId is supplied, the process.started audit event payload
 *         carries record_id = that value.
 *   PP-2: when recordId is absent, the process.started payload does NOT contain
 *         record_id (backward-compat — process-start.ts launcher path).
 *
 * No live Postgres. Uses the same FakeDb stub approach as inbox-detail.test.ts,
 * which exercises the real appendAuditEvent / PgAuditWriter code paths without
 * requiring a DB connection (FE-s27-0002: no DATABASE_URL).
 */

import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import { appendProcessStarted, PROCESS_STARTED_TYPE } from "../http/process-projection.js";
import type { PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// Minimal in-memory FakeDb (mirrors inbox-detail.test.ts pattern)
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  occurred_at: number;
}

class FakeDb {
  events: AuditRow[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  head: { seq: number; row_hash: any } = { seq: 0, row_hash: Buffer.alloc(32) };
}

function makeFakeClient(db: FakeDb, tenantId: string): PgClientLike {
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (sql: string, paramsArg?: unknown[]): Promise<any> => {
      const params = paramsArg ?? [];
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
      if (/SET LOCAL/i.test(text)) return { rows: [] };
      if (/SET search_path/i.test(text)) return { rows: [] };
      if (/SAVEPOINT/i.test(text)) return { rows: [] };
      if (/current_setting\('choros\.tenant_id', false\)::uuid AS tenant_id/.test(text)) {
        return { rows: [{ tenant_id: tenantId }] };
      }
      if (/INSERT INTO choros\.audit_head/i.test(text)) {
        return { rows: [] };
      }
      if (/FROM choros\.audit_head/i.test(text) && /FOR UPDATE/i.test(text)) {
        return { rows: [{ seq: db.head.seq, row_hash: db.head.row_hash, vocab_version: 1 }] };
      }
      if (/INSERT INTO choros\.audit_event/i.test(text)) {
        const id = params[1] as string;
        const type = params[2] as string;
        const actor = params[3] as string;
        const payloadJson = params[9] as string;
        const occurredAt = params[10] as number;
        db.events.push({
          id,
          type,
          actor,
          payload: JSON.parse(payloadJson),
          occurred_at: occurredAt,
        });
        db.head = { seq: (db.head.seq ?? 0) + 1, row_hash: params[12] };
        return { rows: [] };
      }
      if (/UPDATE choros\.audit_head/i.test(text)) {
        db.head = { seq: params[0] as number, row_hash: params[1] };
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  return client as unknown as PgClientLike;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "b0000000-0000-0000-0000-000000000001";
const INSTANCE_ID = "b0000000-0000-0000-0000-000000000002";
const PROC_KEY = "telLinear";
const ACTOR = "e-orlov";
const NOW_MS = 1700000000000;
const RECORD_ID = "b0000000-0000-0000-0000-000000000099";

// ---------------------------------------------------------------------------
// PP-1: recordId present → payload.record_id set
// ---------------------------------------------------------------------------

describe("appendProcessStarted — T-0356 recordId parameter", () => {
  it("PP-1: recordId supplied → process.started payload carries record_id", async () => {
    const db = new FakeDb();
    const client = makeFakeClient(db, TENANT_ID);

    await appendProcessStarted(client, {
      instanceId: INSTANCE_ID,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: NOW_MS,
      tenantId: TENANT_ID,
      recordId: RECORD_ID, // T-0356: on_create trigger path
    });

    // Find the process.started event (may be followed by instance.started + task.created)
    const started = db.events.find((e) => e.type === PROCESS_STARTED_TYPE);
    expect(started).toBeDefined();
    expect(started!.payload["record_id"]).toBe(RECORD_ID);
    // Core fields still present
    expect(started!.payload["inst"]).toBe(INSTANCE_ID);
    expect(started!.payload["proc_key"]).toBe(PROC_KEY);
  });

  // -------------------------------------------------------------------------
  // PP-2: recordId absent → payload.record_id absent (launcher path compat)
  // -------------------------------------------------------------------------

  it("PP-2: recordId absent → process.started payload has no record_id (launcher path)", async () => {
    const db = new FakeDb();
    const client = makeFakeClient(db, TENANT_ID);

    await appendProcessStarted(client, {
      instanceId: INSTANCE_ID,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: NOW_MS,
      // No recordId — explicit launch path (process-start.ts)
    });

    const started = db.events.find((e) => e.type === PROCESS_STARTED_TYPE);
    expect(started).toBeDefined();
    // T-0356: must NOT set record_id when not provided (no null/undefined spillage)
    expect(started!.payload).not.toHaveProperty("record_id");
    // Core fields still present
    expect(started!.payload["inst"]).toBe(INSTANCE_ID);
    expect(started!.payload["proc_key"]).toBe(PROC_KEY);
  });
});
