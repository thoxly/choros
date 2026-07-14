/**
 * T-0068 · FF-9 (AC-14) server-wiring + FF-6 (AC-7) instance.started wrapper.
 *
 * - startLifecycleBridge({}, {}) with no FLOWABLE_BASE_URL → no-throw, no-op handle,
 *   stop() idempotent (degraded; T-0067 AC-13/14, NF-5).
 * - auditInstanceStarted → exactly one append (type='instance.started',
 *   subject=processInstanceId, payload.instanceId=processInstanceId).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startLifecycleBridge,
  auditInstanceStarted,
} from "../server/lifecycle-bridge.js";
import { InMemoryAuditWriter, inMemoryTx } from "../db/audit-writer.js";
import { PostgresJobStore } from "../core/postgres/pgJobStore.js";
import { PostgresOutboxStore } from "../core/postgres/pgOutboxStore.js";
import * as flowableClientModule from "../core/flowable-client.js";
import * as externalTaskBridgeModule from "../core/externalTaskBridge.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

describe("startLifecycleBridge (FF-9 / AC-14)", () => {
  it("no FLOWABLE_BASE_URL → returns a no-op handle without throwing", () => {
    const handle = startLifecycleBridge({}, {} as NodeJS.ProcessEnv);
    expect(typeof handle.stop).toBe("function");
    // stop() is idempotent (callable repeatedly, no throw).
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it("FLOWABLE_BASE_URL set but deps missing → degraded no-op (server still starts)", () => {
    const handle = startLifecycleBridge(
      {},
      { FLOWABLE_BASE_URL: "http://flowable:8082" } as unknown as NodeJS.ProcessEnv,
    );
    expect(typeof handle.stop).toBe("function");
    expect(() => handle.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T-0636 (P0-5 / AC-1 / AC-2 / AC-3): credential env names
// ---------------------------------------------------------------------------
describe("startLifecycleBridge — FLOWABLE credential env names (T-0636 P0-5)", () => {
  // A minimal fake pg.Pool-shaped object — never actually queried in these tests
  // (the poll loop's first pass fires after one interval, and we never advance
  // fake timers here; PostgresJobStore/PostgresOutboxStore only store the pool
  // reference at construction time).
  const fakePool = { query: vi.fn(), connect: vi.fn() } as unknown as import("pg").Pool;

  function fullDeps() {
    return {
      pool: fakePool,
      jobStore: new PostgresJobStore(fakePool),
      outboxStore: new PostgresOutboxStore(fakePool),
    };
  }

  beforeEach(() => {
    vi.spyOn(flowableClientModule, "makeFlowableClient");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("AC-2: builds FlowableClient from FLOWABLE_REST_APP_ADMIN_USER_ID/PASSWORD (not the old names)", () => {
    const handle = startLifecycleBridge(fullDeps(), {
      FLOWABLE_BASE_URL: "http://flowable:8082",
      FLOWABLE_REST_APP_ADMIN_USER_ID: "real-admin",
      FLOWABLE_REST_APP_ADMIN_PASSWORD: "real-secret-pw",
    } as unknown as NodeJS.ProcessEnv);

    expect(flowableClientModule.makeFlowableClient).toHaveBeenCalledTimes(1);
    const config = vi.mocked(flowableClientModule.makeFlowableClient).mock.calls[0][0];
    expect(config?.adminUser).toBe("real-admin");
    expect(config?.adminPassword).toBe("real-secret-pw");

    handle.stop();
  });

  it("AC-3: FLOWABLE_BASE_URL set but FLOWABLE_REST_APP_ADMIN_PASSWORD absent → noop-degrade, no throw, makeFlowableClient never called", () => {
    let handle: ReturnType<typeof startLifecycleBridge> | undefined;
    expect(() => {
      handle = startLifecycleBridge(fullDeps(), {
        FLOWABLE_BASE_URL: "http://flowable:8082",
        // FLOWABLE_REST_APP_ADMIN_PASSWORD intentionally absent.
      } as unknown as NodeJS.ProcessEnv);
    }).not.toThrow();

    expect(flowableClientModule.makeFlowableClient).not.toHaveBeenCalled();
    expect(handle).toBeDefined();
    expect(typeof handle!.stop).toBe("function");
    expect(() => handle!.stop()).not.toThrow();
  });

  it("AC-1: never falls back to the literal password 'test' when a real password IS configured", () => {
    const handle = startLifecycleBridge(fullDeps(), {
      FLOWABLE_BASE_URL: "http://flowable:8082",
      FLOWABLE_REST_APP_ADMIN_USER_ID: "real-admin",
      FLOWABLE_REST_APP_ADMIN_PASSWORD: "real-secret-pw",
    } as unknown as NodeJS.ProcessEnv);

    const config = vi.mocked(flowableClientModule.makeFlowableClient).mock.calls[0][0];
    expect(config?.adminPassword).not.toBe("test");

    handle.stop();
  });
});

// ---------------------------------------------------------------------------
// T-0644 (P0/столп4): the SAME workerId must reach BOTH the poll loop's
// fetchAndLock (via startBridgePollLoop's opts.workerId) AND the deliver
// path's completeTask/failTask (via makeExternalTaskDeliver's bridgeWorkerId
// param) — a divergence here is exactly the LIVE_PROOF bug (Flowable rejects
// completeTask when its workerId doesn't match the lock-holder).
// ---------------------------------------------------------------------------
describe("startLifecycleBridge — T-0644: bridgeWorkerId consistency between poll loop and deliver", () => {
  const fakePool = { query: vi.fn(), connect: vi.fn() } as unknown as import("pg").Pool;

  function fullDeps() {
    return {
      pool: fakePool,
      jobStore: new PostgresJobStore(fakePool),
      outboxStore: new PostgresOutboxStore(fakePool),
    };
  }

  beforeEach(() => {
    vi.spyOn(flowableClientModule, "makeFlowableClient").mockReturnValue(
      {} as unknown as ReturnType<typeof flowableClientModule.makeFlowableClient>,
    );
    vi.spyOn(externalTaskBridgeModule, "startBridgePollLoop").mockReturnValue({ stop: () => {} });
    vi.spyOn(externalTaskBridgeModule, "makeExternalTaskDeliver");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("FLOWABLE_WORKER_ID set → startBridgePollLoop's workerId === makeExternalTaskDeliver's bridgeWorkerId (4th arg)", () => {
    const handle = startLifecycleBridge(fullDeps(), {
      FLOWABLE_BASE_URL: "http://flowable:8082",
      FLOWABLE_REST_APP_ADMIN_PASSWORD: "pw",
      FLOWABLE_WORKER_ID: "custom-bridge-identity",
    } as unknown as NodeJS.ProcessEnv);

    const pollLoopOpts = vi.mocked(externalTaskBridgeModule.startBridgePollLoop).mock.calls[0][2];
    const deliverArgs = vi.mocked(externalTaskBridgeModule.makeExternalTaskDeliver).mock.calls[0];

    expect(pollLoopOpts.workerId).toBe("custom-bridge-identity");
    // 4th positional arg of makeExternalTaskDeliver is bridgeWorkerId.
    expect(deliverArgs[3]).toBe("custom-bridge-identity");
    expect(deliverArgs[3]).toBe(pollLoopOpts.workerId);

    handle.stop();
  });

  it("FLOWABLE_WORKER_ID absent → both default to the SAME DEFAULT_BRIDGE_WORKER_ID", () => {
    const handle = startLifecycleBridge(fullDeps(), {
      FLOWABLE_BASE_URL: "http://flowable:8082",
      FLOWABLE_REST_APP_ADMIN_PASSWORD: "pw",
      // FLOWABLE_WORKER_ID intentionally absent.
    } as unknown as NodeJS.ProcessEnv);

    const pollLoopOpts = vi.mocked(externalTaskBridgeModule.startBridgePollLoop).mock.calls[0][2];
    const deliverArgs = vi.mocked(externalTaskBridgeModule.makeExternalTaskDeliver).mock.calls[0];

    expect(pollLoopOpts.workerId).toBe(externalTaskBridgeModule.DEFAULT_BRIDGE_WORKER_ID);
    expect(deliverArgs[3]).toBe(externalTaskBridgeModule.DEFAULT_BRIDGE_WORKER_ID);
    expect(deliverArgs[3]).toBe(pollLoopOpts.workerId);

    handle.stop();
  });
});

describe("auditInstanceStarted (FF-6 / AC-7)", () => {
  it("appends exactly one instance.started row with the right pointers", async () => {
    const writer = new InMemoryAuditWriter();
    await auditInstanceStarted(
      writer,
      inMemoryTx(TENANT),
      { instanceId: "pi-42", processKey: "invoice", actor: "e-larina", actorType: "human" },
      1700000000000,
    );
    const rows = writer.rows(TENANT);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("instance.started");
    expect(rows[0].subject).toBe("pi-42");
    expect((rows[0].payload as Record<string, unknown>)["instanceId"]).toBe("pi-42");
  });
});
