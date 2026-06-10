/**
 * T-0068 · FF-9 (AC-14) server-wiring + FF-6 (AC-7) instance.started wrapper.
 *
 * - startLifecycleBridge({}, {}) with no FLOWABLE_BASE_URL → no-throw, no-op handle,
 *   stop() idempotent (degraded; T-0067 AC-13/14, NF-5).
 * - auditInstanceStarted → exactly one append (type='instance.started',
 *   subject=processInstanceId, payload.instanceId=processInstanceId).
 */

import { describe, it, expect } from "vitest";
import {
  startLifecycleBridge,
  auditInstanceStarted,
} from "../server/lifecycle-bridge.js";
import { InMemoryAuditWriter, inMemoryTx } from "../db/audit-writer.js";

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
