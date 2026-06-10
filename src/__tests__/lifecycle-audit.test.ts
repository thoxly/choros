/**
 * T-0068 · Unit tests for the lifecycle → audit mapper and onDispatched bridge.
 *
 * Covers FF-5 (AC-8/9/10), FF-6 (AC-7), FF-7 (AC-11/12) with the InMemoryAuditWriter.
 */

import { describe, it, expect, vi } from "vitest";
import {
  encodeLifecycleAuditEvent,
  projectActorType,
  makeAuditOnDispatched,
  type LifecycleAuditInput,
  type ActorType,
} from "../core/lifecycle-audit.js";
import {
  InMemoryAuditWriter,
  inMemoryTx,
  type PgClientLike,
} from "../db/audit-writer.js";
import {
  runOutboxOnce,
  type OnDispatched,
} from "../core/outboxDispatcher.js";
import type { OutboxRow } from "../core/outboxTypes.js";
import { rowHash, GENESIS_PREV_HASH, type CanonicalAuditRow } from "../core/audit-preimage.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const FIXED_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function outboxRow(over: Partial<OutboxRow>): OutboxRow {
  return {
    tenantId: TENANT,
    id: "99999999-9999-9999-9999-999999999999",
    aggregateKind: "external_task",
    aggregateId: "job-7",
    eventType: "task_completed",
    payload: {},
    state: "dispatched",
    idempotencyKey: "ext-1",
    attempts: 0,
    createdAt: 0,
    availableAt: 0,
    dispatchedAt: 1,
    lastError: undefined,
    ...over,
  };
}

describe("projectActorType (FF-7 / AC-11/13)", () => {
  it("human kind → human", () => {
    expect(projectActorType("human", "engine")).toBe("human");
    expect(projectActorType("human", "external-worker")).toBe("human");
  });
  it("agent over agent-runtime/user-task → agent", () => {
    expect(projectActorType("agent", "engine")).toBe("agent");
    expect(projectActorType("agent", "user-task")).toBe("agent");
  });
  it("agent over external-worker/service → service", () => {
    expect(projectActorType("agent", "external-worker")).toBe("service");
    expect(projectActorType("agent", "service")).toBe("service");
  });
  it("union of outputs is exactly {human,agent,service}", () => {
    const got = new Set<ActorType>([
      projectActorType("human", "engine"),
      projectActorType("agent", "user-task"),
      projectActorType("agent", "external-worker"),
    ]);
    expect([...got].sort()).toEqual(["agent", "human", "service"]);
  });
});

describe("encodeLifecycleAuditEvent (FF-6 / FF-7)", () => {
  it("instance.started → subject=instanceId, payload carries actorType + instanceId", () => {
    const input: LifecycleAuditInput = {
      kind: "instance.started",
      instanceId: "pi-9001",
      processKey: "invoice",
      actor: "e-larina",
      actorType: "human",
    };
    const ev = encodeLifecycleAuditEvent(input, 1700000000000, FIXED_ID);
    expect(ev.type).toBe("instance.started");
    expect(ev.subject).toBe("pi-9001");
    expect(ev.via).toBe("engine");
    expect((ev.payload as Record<string, unknown>)["actorType"]).toBe("human");
    expect((ev.payload as Record<string, unknown>)["instanceId"]).toBe("pi-9001");
    expect((ev.payload as Record<string, unknown>)["processKey"]).toBe("invoice");
  });

  it("task.completed → type=task.completed, jobId in payload.aggregateId, via=external-worker", () => {
    const ev = encodeLifecycleAuditEvent(
      { kind: "task.completed", instanceId: null, jobId: "job-7", actor: "s-ledger", actorType: "service" },
      1,
      FIXED_ID,
    );
    expect(ev.type).toBe("task.completed");
    expect(ev.via).toBe("external-worker");
    expect((ev.payload as Record<string, unknown>)["actorType"]).toBe("service");
    expect((ev.payload as Record<string, unknown>)["aggregateId"]).toBe("job-7");
  });

  it("task.failed → type=task.failed, errorMessage threaded", () => {
    const ev = encodeLifecycleAuditEvent(
      {
        kind: "task.failed",
        instanceId: "pi-1",
        jobId: "job-9",
        actor: "s-ocr",
        actorType: "service",
        errorMessage: "boom",
      },
      1,
      FIXED_ID,
    );
    expect(ev.type).toBe("task.failed");
    expect((ev.payload as Record<string, unknown>)["errorMessage"]).toBe("boom");
  });

  it("actorType tamper is hash-covered (AC-12)", () => {
    const ev = encodeLifecycleAuditEvent(
      { kind: "task.completed", instanceId: null, jobId: "job-7", actor: "a", actorType: "service" },
      1,
      FIXED_ID,
    );
    const base: CanonicalAuditRow = {
      tenant_id: TENANT,
      seq: 1,
      id: ev.id,
      type: ev.type,
      actor: ev.actor,
      subject: ev.subject,
      scope: ev.scope ?? null,
      via: ev.via,
      proposed_by: ev.proposed_by,
      confirmed_by: ev.confirmed_by,
      payload: ev.payload,
      occurred_at: ev.occurred_at,
      prev_hash: GENESIS_PREV_HASH,
      vocab_version: 1,
    };
    const tampered: CanonicalAuditRow = {
      ...base,
      payload: { ...(ev.payload as Record<string, unknown>), actorType: "human" },
    };
    expect(rowHash(base).equals(rowHash(tampered))).toBe(false);
  });
});

describe("makeAuditOnDispatched (FF-5 / AC-8/9/10)", () => {
  function makeDeps(writer: InMemoryAuditWriter, actorType: ActorType = "service") {
    const withTenantTx = async <T>(tenantId: string, fn: (tx: PgClientLike) => Promise<T>) =>
      fn(inMemoryTx(tenantId));
    return {
      writer,
      withTenantTx,
      resolveActor: async (_row: OutboxRow) => ({ actor: "s-ledger", actorType }),
      now: () => 1,
    };
  }

  it("task_completed → exactly one append (type=task.completed, aggregateId pointer)", async () => {
    const writer = new InMemoryAuditWriter();
    const cb = makeAuditOnDispatched(makeDeps(writer));
    await cb(outboxRow({ eventType: "task_completed", aggregateId: "job-7" }));
    const rows = writer.rows(TENANT);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("task.completed");
    expect((rows[0].payload as Record<string, unknown>)["aggregateId"]).toBe("job-7");
  });

  it("task_failed → exactly one append (type=task.failed)", async () => {
    const writer = new InMemoryAuditWriter();
    const cb = makeAuditOnDispatched(makeDeps(writer));
    await cb(outboxRow({ eventType: "task_failed", payload: { error: "x" } }));
    const rows = writer.rows(TENANT);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("task.failed");
  });

  it("worker_lock_expired → no-op (0 appends)", async () => {
    const writer = new InMemoryAuditWriter();
    const cb = makeAuditOnDispatched(makeDeps(writer));
    await cb(outboxRow({ eventType: "worker_lock_expired" }));
    expect(writer.rows(TENANT).length).toBe(0);
  });

  it("unknown eventType → no-op (0 appends)", async () => {
    const writer = new InMemoryAuditWriter();
    const cb = makeAuditOnDispatched(makeDeps(writer));
    await cb(outboxRow({ eventType: "some_unknown_thing" }));
    expect(writer.rows(TENANT).length).toBe(0);
  });

  it("exactly-once: dispatcher only fires onDispatched when markDispatched advanced (AC-10)", async () => {
    const writer = new InMemoryAuditWriter();
    const cb: OnDispatched = makeAuditOnDispatched(makeDeps(writer));

    const row = outboxRow({ eventType: "task_completed", aggregateId: "job-7" });
    // Fake store: first markDispatched advances; the second pass (already
    // dispatched) returns false → onDispatched must NOT fire again.
    let advancedOnce = false;
    const store = {
      pendingBuckets: vi.fn(async () => [{ tenantId: TENANT, count: 1 }]),
      claimBatch: vi.fn(async () => [row]),
      markDispatched: vi.fn(async () => {
        if (advancedOnce) return false;
        advancedOnce = true;
        return true;
      }),
      markRetry: vi.fn(async () => "pending" as const),
    };
    const deliver = vi.fn(async () => ({ ok: true }));
    const opts = { batchLimit: 10, maxAttempts: 5, backoff: () => 0, onDispatched: cb };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runOutboxOnce(store as any, deliver, opts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runOutboxOnce(store as any, deliver, opts);

    expect(writer.rows(TENANT).length).toBe(1);
  });
});
