/**
 * src/__tests__/message-waiting-projection.test.ts — T-0459 [D8-R4].
 *
 * Proves the WAITING PROJECTION is real: an instance parked on a message-catch
 * surfaces as a WAITING inbox row (not stuck, not done) carrying the messageCatch
 * flag + the awaited messageName, and that the message-wait reconcile
 * (surfaceMessageCatchWaits) emits one — idempotently.
 *
 * Reuses the in-memory FakeAuditDb pattern from inbox-engine-drive.test.ts so the
 * append→fold round-trip runs without a live Postgres.
 */

import { describe, it, expect } from "vitest";
import {
  appendNextTaskEvent,
  listInstanceInboxTasks,
  surfaceMessageCatchWaits,
  type MessageSubscriptionSource,
} from "../http/process-projection.js";
import type { MessageSubscription } from "../core/message-correlation.js";

// ---------------------------------------------------------------------------
// In-memory fake audit DB (mirrors inbox-engine-drive.test.ts harness).
// ---------------------------------------------------------------------------

interface AuditRow {
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
  events: AuditRow[] = [];
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
          db.events.push({
            tenant_id: tenant,
            seq: params[0] as number,
            id: params[1] as string,
            type: params[2] as string,
            actor: params[3] as string,
            payload: JSON.parse(params[9] as string),
            occurred_at: params[10] as number,
            row_hash: params[12] as Buffer,
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

function subSource(subs: MessageSubscription[]): MessageSubscriptionSource {
  return { listWaitingSubscriptions: async (t) => subs.filter((s) => s.tenant === t) };
}

describe("T-0459 — waiting projection: a message-catch row surfaces as WAITING", () => {
  it("appendNextTaskEvent(messageCatch) → listInstanceInboxTasks surfaces it with the flag + message name", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);

    await appendNextTaskEvent(pool, TENANT, {
      instanceId: INST,
      procKey: "telLinear",
      actor: "system:message",
      nowMs: 1000,
      taskDefKey: "message-catch:contract-signed",
      taskName: "Ожидает сообщения",
      taskRole: "role-approver",
      taskStep: "Ожидание сообщения",
      inboxTaskId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      via: "message-wait",
      messageCatch: true,
      messageName: "contract-signed",
    });

    const tasks = await listInstanceInboxTasks(pool, TENANT);
    const waitRow = tasks.find((t) => t.inst === INST);
    expect(waitRow).toBeDefined();
    // WAITING (surfaced as an inbox row) — not stuck, not done.
    expect(waitRow?.messageCatch).toBe(true);
    expect(waitRow?.messageName).toBe("contract-signed");
    expect(waitRow?.name).toBe("Ожидает сообщения");
  });
});

describe("T-0459 — surfaceMessageCatchWaits: emits one wait row, idempotently", () => {
  it("emits a wait row for a parked subscription, then dedups on a second pass", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const subs: MessageSubscription[] = [
      { inst: INST, tenant: TENANT, messageName: "contract-signed", correlationKey: "CT-100", broadcast: false },
    ];

    const first = await surfaceMessageCatchWaits(pool, TENANT, subSource(subs), { nowMs: 1000 });
    expect(first).toBe(1);

    // The wait row is now projected; a second pass must NOT re-emit (dedup by inst+name).
    const second = await surfaceMessageCatchWaits(pool, TENANT, subSource(subs), { nowMs: 2000 });
    expect(second).toBe(0);

    // And the projection shows exactly one waiting message-catch row.
    const tasks = await listInstanceInboxTasks(pool, TENANT);
    const waits = tasks.filter((t) => t.messageCatch);
    expect(waits).toHaveLength(1);
    expect(waits[0]?.messageName).toBe("contract-signed");
  });

  it("emits nothing when there are no waiting subscriptions", async () => {
    const db = new FakeAuditDb();
    const pool = makeFakePool(db);
    const n = await surfaceMessageCatchWaits(pool, TENANT, subSource([]), { nowMs: 1000 });
    expect(n).toBe(0);
  });
});
