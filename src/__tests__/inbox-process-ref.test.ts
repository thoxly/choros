/**
 * src/__tests__/inbox-process-ref.test.ts — T-0683 (D-064, wave-5 human-layer).
 *
 * PIN: listInstanceInboxTasks must surface the HUMAN process-definition name
 * (processName) AND the originating record id (recordId) on every instance task,
 * so the inbox «ПРОЦЕСС» column can show a human identifier instead of the raw
 * instance-UUID that the capstone T-0647 acceptance found on the operator's main
 * screen.
 *
 * Approach mirrors inbox-engine-drive.test.ts: a hand-rolled fake pg pool over an
 * in-memory audit-event store (no live DB). The process_definition lookup inside
 * resolveDefinitionNames returns no rows against the fake pool, so processName
 * falls back to fallbackDefinitionName(procKey) === procKey — which is exactly
 * the honest human fallback (never a UUID). record_id is read straight from the
 * process.started payload appendProcessStarted persists.
 *
 * MUTATION: reverting the enrichment (dropping processName / recordId from the
 * InstanceInboxTask) makes the two pins below go red — processName becomes
 * undefined, recordId is lost.
 */

import { describe, it, expect } from "vitest";
import type { PgClientLike } from "../db/audit-writer.js";
import { appendProcessStarted, listInstanceInboxTasks } from "../http/process-projection.js";

// ---------------------------------------------------------------------------
// In-memory fake audit store + pg pool (subset of inbox-engine-drive.test.ts's
// FakeAuditDb/makeFakePool — kept local so this pin is self-contained).
// ---------------------------------------------------------------------------

interface StoredEvent {
  tenant_id: string;
  seq: number;
  id: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  occurred_at: number;
  row_hash: Buffer;
}

class FakeAuditDb {
  events: StoredEvent[] = [];
  heads = new Map<string, { seq: number; row_hash: Buffer }>();
}

function makeFakePool(db: FakeAuditDb): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    let tenant = "";
    const client = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: async (sql: string, paramsArg?: unknown[]): Promise<any> => {
        const params = paramsArg ?? [];
        const text = sql.trim();

        const m = /SET LOCAL choros\.tenant_id = '([^']+)'/.exec(text);
        if (m) { tenant = m[1]; return { rows: [] }; }
        if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
        if (/SET LOCAL search_path/i.test(text)) return { rows: [] };
        if (/current_setting\('choros\.tenant_id', false\)::uuid AS tenant_id/.test(text)) {
          return { rows: [{ tenant_id: tenant }] };
        }
        if (/INSERT INTO choros\.audit_head/i.test(text)) {
          if (!db.heads.has(tenant)) {
            db.heads.set(tenant, { seq: Number(params[0]), row_hash: params[1] as Buffer });
          }
          return { rows: [] };
        }
        if (/FROM choros\.audit_head/i.test(text) && /FOR UPDATE/i.test(text)) {
          const head = db.heads.get(tenant) ?? { seq: 0, row_hash: Buffer.alloc(32) };
          return { rows: [{ seq: head.seq, row_hash: head.row_hash, vocab_version: 1 }] };
        }
        if (/INSERT INTO choros\.audit_event/i.test(text)) {
          const seq = params[0] as number;
          const id = params[1] as string;
          const type = params[2] as string;
          const actor = params[3] as string;
          const payloadJson = params[9] as string;
          const occurredAt = params[10] as number;
          const rowHash = params[12] as Buffer;
          db.events.push({
            tenant_id: tenant, seq, id, type, actor,
            payload: JSON.parse(payloadJson), occurred_at: occurredAt, row_hash: rowHash,
          });
          return { rows: [] };
        }
        if (/UPDATE choros\.audit_head/i.test(text)) {
          db.heads.set(tenant, { seq: Number(params[0]), row_hash: params[1] as Buffer });
          return { rows: [] };
        }
        if (/FROM choros\.audit_event/i.test(text) && /WHERE type = \$1/.test(text)) {
          const type = params[0] as string;
          const tid = params[1] as string;
          const rows = db.events
            .filter((e) => e.type === type && e.tenant_id === tid)
            .sort((a, b) => a.occurred_at - b.occurred_at)
            .map((e) => ({ id: e.id, actor: e.actor, payload: e.payload, occurred_at: e.occurred_at }));
          return { rows };
        }
        // Catch-all covers the process_definition SELECT (resolveDefinitionNames):
        // no rows → processName falls back to fallbackDefinitionName(procKey).
        return { rows: [] };
      },
      release: () => {},
    };
    return client as unknown as import("pg").PoolClient;
  }
  return { connect: async () => makeClient() } as unknown as import("pg").Pool;
}

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INST = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PROC_KEY = "purchaseApproval";
const ACTOR = "e-worker";
const RECORD_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

describe("T-0683 — listInstanceInboxTasks surfaces human processName + recordId", () => {
  it("a started instance task carries a human processName (never a raw UUID) and its recordId", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const client = await pool.connect();
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const tx = client as unknown as PgClientLike;

    await appendProcessStarted(tx, {
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 1000,
      tenantId: TENANT,
      recordId: RECORD_ID, // started via on_create → record_id persisted in payload
    });
    client.release();

    const tasks = await listInstanceInboxTasks(pool, TENANT);
    const task = tasks.find((t) => t.inst === INST);
    expect(task).toBeDefined();

    // processName is ALWAYS present and human — never the raw instance-UUID.
    expect(task?.processName).toBeDefined();
    expect(typeof task?.processName).toBe("string");
    expect(task?.processName).not.toBe(INST);
    // With no process_definition row (fake pool), it falls back to the procKey —
    // an honest human handle, not the machine instance id.
    expect(task?.processName).toBe(PROC_KEY);

    // recordId flows through from the started payload — the human disambiguator.
    expect(task?.recordId).toBe(RECORD_ID);
  });

  it("a started instance WITHOUT a record still has processName but no recordId", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const client = await pool.connect();
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    const tx = client as unknown as PgClientLike;

    await appendProcessStarted(tx, {
      instanceId: INST,
      procKey: PROC_KEY,
      actor: ACTOR,
      nowMs: 1000,
      tenantId: TENANT,
      // no recordId — manually started process
    });
    client.release();

    const tasks = await listInstanceInboxTasks(pool, TENANT);
    const task = tasks.find((t) => t.inst === INST);
    expect(task).toBeDefined();
    expect(task?.processName).toBe(PROC_KEY);
    expect(task?.recordId).toBeUndefined();
  });
});
