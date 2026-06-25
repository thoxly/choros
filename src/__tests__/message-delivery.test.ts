/**
 * src/__tests__/message-delivery.test.ts — T-0459 [D8-R4].
 *
 * Unit tests for the message-delivery seam (deliverMessageEnvelope) — the impure
 * orchestration around the pure correlation core. Focus:
 *   • bad envelope → fail-closed (no engine call)
 *   • TENANT-FAIL-CLOSED → wrong tenant rejected, the engine is NEVER signalled
 *   • a correlated in-tenant message → the engine IS signalled for the right instance
 *
 * The DB-touching reconcile path is exercised only on the no-task branch (engine
 * getActiveUserTasks → ok:false), so the pool is never accessed: these are pure unit
 * tests. The pool is a tripwire that throws if used.
 */

import { describe, it, expect, vi } from "vitest";
import {
  deliverMessageEnvelope,
  type MessageDeliveryEnginePort,
  type MessageSubscriptionSource,
} from "../http/process-projection.js";
import type { MessageSubscription } from "../core/message-correlation.js";
import type pg from "pg";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/** A pool that throws if touched — proves a code path never hit the DB. */
const tripwirePool = {
  connect: () => {
    throw new Error("pool must not be touched on this path");
  },
} as unknown as pg.Pool;

function subSource(subs: MessageSubscription[]): MessageSubscriptionSource {
  return { listWaitingSubscriptions: async (t) => subs.filter((s) => s.tenant === t) };
}

function env(over: Record<string, unknown> = {}) {
  return {
    tenant: TENANT_A,
    messageName: "contract-signed",
    correlationKey: "CT-100",
    payload: { doc: "ref-1" },
    source: "external-human",
    ...over,
  };
}

describe("T-0459 — deliverMessageEnvelope: fail-closed on a bad envelope", () => {
  it("rejects a malformed envelope and NEVER signals the engine", async () => {
    const correlateMessage = vi.fn();
    const engine: MessageDeliveryEnginePort = {
      correlateMessage,
      getActiveUserTasks: vi.fn(),
    };
    const r = await deliverMessageEnvelope(
      tripwirePool,
      { tenant: "", messageName: "x" }, // missing fields → bad
      subSource([]),
      engine,
    );
    expect(r.delivered).toBe(false);
    if (!r.delivered) expect(r.rejected).toBe("bad-envelope");
    expect(correlateMessage).not.toHaveBeenCalled();
  });
});

describe("T-0459 — deliverMessageEnvelope: TENANT-FAIL-CLOSED", () => {
  it("a message for tenant B does NOT signal a matching instance in tenant A", async () => {
    const correlateMessage = vi.fn();
    const engine: MessageDeliveryEnginePort = {
      correlateMessage,
      getActiveUserTasks: vi.fn(),
    };
    // The subscription source is tenant-scoped (returns only tenant-B subs for a
    // tenant-B query). Even if it leaked tenant-A subs, the pure core re-checks
    // tenant — so we ALSO test a deliberately leaky source below.
    const subs: MessageSubscription[] = [
      { inst: "inst-A", tenant: TENANT_A, messageName: "contract-signed", correlationKey: "CT-100", broadcast: false },
    ];
    const r = await deliverMessageEnvelope(
      tripwirePool,
      env({ tenant: TENANT_B }), // envelope addressed to tenant B
      subSource(subs), // scoped source returns nothing for tenant B
      engine,
    );
    expect(r.delivered).toBe(false);
    expect(correlateMessage).not.toHaveBeenCalled();
  });

  it("even a LEAKY subscription source cannot deliver cross-tenant (core re-checks tenant)", async () => {
    const correlateMessage = vi.fn();
    const engine: MessageDeliveryEnginePort = {
      correlateMessage,
      getActiveUserTasks: vi.fn(),
    };
    // A deliberately leaky source: returns tenant-A subs REGARDLESS of the queried tenant.
    const leaky: MessageSubscriptionSource = {
      listWaitingSubscriptions: async () => [
        { inst: "inst-A", tenant: TENANT_A, messageName: "contract-signed", correlationKey: "CT-100", broadcast: false },
      ],
    };
    const r = await deliverMessageEnvelope(
      tripwirePool,
      env({ tenant: TENANT_B }), // tenant B envelope, leaky source hands back tenant-A subs
      leaky,
      engine,
    );
    expect(r.delivered).toBe(false);
    // The only near-match was blocked solely by the tenant gate → wrong-tenant.
    if (!r.delivered) expect(r.rejected).toBe("wrong-tenant");
    expect(correlateMessage).not.toHaveBeenCalled(); // engine NEVER signalled cross-tenant.
  });
});

describe("T-0459 — deliverMessageEnvelope: correlated in-tenant delivery fires the engine", () => {
  it("signals the engine for the instance whose record-field key matches", async () => {
    const correlateMessage = vi.fn(async () => ({ ok: true as const }));
    // Return ok:false from getActiveUserTasks so the DB-touching reconcile branch is
    // skipped — keeps this a pure unit test (the tripwire pool stays untouched).
    const getActiveUserTasks = vi.fn(async () => ({ ok: false as const, code: "skip" }));
    const engine: MessageDeliveryEnginePort = { correlateMessage, getActiveUserTasks };

    const subs: MessageSubscription[] = [
      { inst: "inst-A", tenant: TENANT_A, messageName: "contract-signed", correlationKey: "CT-999", broadcast: false },
      { inst: "inst-B", tenant: TENANT_A, messageName: "contract-signed", correlationKey: "CT-100", broadcast: false },
    ];

    const r = await deliverMessageEnvelope(
      tripwirePool,
      env({ correlationKey: "CT-100" }),
      subSource(subs),
      engine,
    );

    expect(r.delivered).toBe(true);
    if (r.delivered) expect(r.firedInstances).toEqual(["inst-B"]);
    // The engine was signalled exactly once, for the correlated instance, with payload.
    expect(correlateMessage).toHaveBeenCalledTimes(1);
    expect(correlateMessage).toHaveBeenCalledWith("inst-B", "contract-signed", { doc: "ref-1" });
  });

  it("a no-match in-tenant message is a plain no-match (engine not signalled)", async () => {
    const correlateMessage = vi.fn();
    const engine: MessageDeliveryEnginePort = {
      correlateMessage,
      getActiveUserTasks: vi.fn(),
    };
    const subs: MessageSubscription[] = [
      { inst: "inst-A", tenant: TENANT_A, messageName: "contract-signed", correlationKey: "CT-OTHER", broadcast: false },
    ];
    const r = await deliverMessageEnvelope(
      tripwirePool,
      env({ correlationKey: "CT-100" }),
      subSource(subs),
      engine,
    );
    expect(r.delivered).toBe(false);
    if (!r.delivered) expect(r.rejected).toBe("no-match");
    expect(correlateMessage).not.toHaveBeenCalled();
  });
});
