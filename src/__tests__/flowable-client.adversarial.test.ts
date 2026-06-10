/**
 * T-0064 — Adversarial probes (tester-written, TEST phase).
 *
 * (a) completeTask with record-object in payload → RECORD_IN_PAYLOAD, NO engine call
 * (b) bad credentials → UNAUTHORIZED typed code, not raw exception
 * (c) fetchAndLock with engine down (mocked) → ENGINE_UNAVAILABLE + retries=maxRetries+1
 * (d) startInstance with nonexistent process key → typed error code (live probe)
 *
 * Probes (a)/(b)/(c) run without FLOWABLE_INTEGRATION (unit-level, mock HTTP).
 * Probe (d) requires a live Flowable (FLOWABLE_INTEGRATION=1) to confirm typed response.
 */

import { describe, it, expect, vi } from "vitest";
import { makeFlowableClient } from "../core/flowable-client.js";

const TEST_CONFIG = {
  baseUrl: "http://localhost:8082/flowable-rest/service",
  adminUser: "admin",
  adminPassword: "test-pass",
  timeoutMs: 5_000,
  maxRetries: 0,
  retryBaseDelayMs: 0,
  retryMaxDelayMs: 0,
  delayFn: () => Promise.resolve(),
};

describe("T-0064 adversarial probes (unit-level)", () => {
  // ---------------------------------------------------------------------------
  // (a) completeTask with record-object in payload → RECORD_IN_PAYLOAD, NO engine call
  // ---------------------------------------------------------------------------
  describe("(a) completeTask with record-shaped variable → RECORD_IN_PAYLOAD, no engine call", () => {
    it("returns RECORD_IN_PAYLOAD and does NOT call fetch", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const client = makeFlowableClient({ ...TEST_CONFIG });

      // A record-kind ResourceRef value should fail assertVariableValue (record guard)
      // Shape matches isRecordRef(): kind="record" + registryId + recordId
      const result = await client.completeTask("task-1", "worker-1", {
        rec: { kind: "record", tenantId: "tenant-1", registryId: "reg-1", recordId: "rec-1" },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("RECORD_IN_PAYLOAD");
      }
      // Engine must NOT be called when the guard fires
      expect(mockFetch).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });

  // ---------------------------------------------------------------------------
  // (b) bad credentials → UNAUTHORIZED typed code, not raw exception
  // ---------------------------------------------------------------------------
  describe("(b) bad credentials → UNAUTHORIZED typed code", () => {
    it("returns { ok: false, code: UNAUTHORIZED } without throwing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 401,
        json: async () => ({ message: "Unauthorized" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeFlowableClient({ ...TEST_CONFIG });

      let threw = false;
      let result: Awaited<ReturnType<typeof client.startInstance>> | null = null;
      try {
        result = await client.startInstance("chorosSmoke");
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(false);
      if (!result!.ok) {
        expect(result!.code).toBe("UNAUTHORIZED");
      }

      vi.unstubAllGlobals();
    });
  });

  // ---------------------------------------------------------------------------
  // (c) fetchAndLock with engine down → ENGINE_UNAVAILABLE + exact retry count
  // ---------------------------------------------------------------------------
  describe("(c) engine unavailable → ENGINE_UNAVAILABLE + retries exhausted", () => {
    it("retries maxRetries+1 times then returns ENGINE_UNAVAILABLE without throwing", async () => {
      const MAX_RETRIES = 3;
      let callCount = 0;

      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        throw new Error("ECONNREFUSED simulated");
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeFlowableClient({
        ...TEST_CONFIG,
        maxRetries: MAX_RETRIES,
      });

      let threw = false;
      let result: Awaited<ReturnType<typeof client.fetchAndLock>> | null = null;
      try {
        result = await client.fetchAndLock("smoke-topic", "ci-worker", 30_000, 1);
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(false);
      if (!result!.ok) {
        expect(result!.code).toBe("ENGINE_UNAVAILABLE");
      }
      // ADR §4.3: attempt 0, retry 1, retry 2, retry 3 → 4 total calls (maxRetries+1)
      expect(callCount).toBe(MAX_RETRIES + 1);

      vi.unstubAllGlobals();
    });
  });
});

// ---------------------------------------------------------------------------
// (d) startInstance with nonexistent process key → typed error (live probe)
// ---------------------------------------------------------------------------
const INTEGRATION = !!process.env["FLOWABLE_INTEGRATION"];

describe.skipIf(!INTEGRATION)("(d) startInstance nonexistent key → typed error (live)", () => {
  it("returns a typed error code, not a raw exception", async () => {
    const client = makeFlowableClient({
      baseUrl: `http://localhost:${process.env["FLOWABLE_PORT"] ?? "8082"}/flowable-rest/service`,
      adminUser: process.env["FLOWABLE_REST_APP_ADMIN_USER_ID"] ?? "admin",
      adminPassword: process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"] ?? "choros_flowable_dev_pw",
      timeoutMs: 10_000,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0,
      delayFn: () => Promise.resolve(),
    });

    let threw = false;
    let result: Awaited<ReturnType<typeof client.startInstance>> | null = null;
    try {
      result = await client.startInstance("NONEXISTENT_PROCESS_KEY_ADVERSARIAL_XYZ");
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    // Must be a typed FlowableErrorCode, not a raw JS error
    const validCodes = ["NOT_FOUND", "UNKNOWN", "BAD_BPMN", "ENGINE_UNAVAILABLE", "CONFLICT"] as const;
    if (!result!.ok) {
      expect(validCodes).toContain(result!.code);
    }
  });
});
