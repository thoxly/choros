/**
 * T-0064: Integration tests for makeFlowableClient (AC-15..AC-18).
 *
 * These tests require a live Flowable instance at http://localhost:8082.
 * They are guarded by FLOWABLE_INTEGRATION=1 and run only in the dedicated
 * `flowable` CI job — never in the ambient-free `ci` job (D-056).
 *
 * To run locally:
 *   FLOWABLE_INTEGRATION=1 FLOWABLE_REST_APP_ADMIN_PASSWORD=choros_flowable_dev_pw \
 *   vitest run src/__tests__/flowable-client.integration.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeFlowableClient } from "../core/flowable-client.js";

const INTEGRATION = !!process.env["FLOWABLE_INTEGRATION"];

const __dirname = dirname(fileURLToPath(import.meta.url));
const BPMN_PATH = join(__dirname, "../../config/flowable/processes/choros-smoke.bpmn20.xml");

describe.skipIf(!INTEGRATION)("FlowableClient integration (AC-15..AC-18)", () => {
  const client = makeFlowableClient({
    // baseUrl is the BPMN /service/* base; the factory derives extJobUrl automatically
    baseUrl: `http://localhost:${process.env["FLOWABLE_PORT"] ?? "8082"}/flowable-rest/service`,
    adminUser: process.env["FLOWABLE_REST_APP_ADMIN_USER_ID"] ?? "admin",
    adminPassword: process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"] ?? "choros_flowable_dev_pw",
    timeoutMs: 15_000,
    maxRetries: 2,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 3_000,
  });

  let instanceId: string;
  let lockedTaskId: string;

  // AC-15: deployBpmn is the first test — it deploys the BPMN and subsequent tests
  // depend on the process definition being available. No separate beforeAll deploy.
  it("AC-15: deployBpmn returns { ok: true, deploymentId }", async () => {
    const xml = readFileSync(BPMN_PATH, "utf-8");
    const result = await client.deployBpmn(xml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.deploymentId).toBe("string");
      expect(result.deploymentId.length).toBeGreaterThan(0);
    }
  });

  // AC-16
  it("AC-16: startInstance returns { ok: true, instanceId }", async () => {
    const result = await client.startInstance("chorosSmoke");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.instanceId).toBe("string");
      expect(result.instanceId.length).toBeGreaterThan(0);
      instanceId = result.instanceId;
    }
  });

  // AC-17
  it("AC-17: fetchAndLock returns tasks with smoke-topic", async () => {
    // Ensure an instance exists
    if (!instanceId) {
      const r = await client.startInstance("chorosSmoke");
      if (r.ok) instanceId = r.instanceId;
    }

    // Poll briefly — external task may need a moment
    let result = await client.fetchAndLock("smoke-topic", "ci-worker-integration", 30_000, 1);
    for (let i = 0; i < 5 && result.ok && result.tasks.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      result = await client.fetchAndLock("smoke-topic", "ci-worker-integration", 30_000, 1);
    }

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tasks.length).toBeGreaterThanOrEqual(1);
      const task = result.tasks[0]!;
      expect(task.topic).toBe("smoke-topic");
      expect(typeof task.id).toBe("string");
      lockedTaskId = task.id;
    }
  });

  // AC-18
  it("AC-18: completeTask returns { ok: true }", async () => {
    if (!lockedTaskId) {
      const lockResult = await client.fetchAndLock("smoke-topic", "ci-worker-integration", 30_000, 1);
      if (lockResult.ok && lockResult.tasks.length > 0) {
        lockedTaskId = lockResult.tasks[0]!.id;
      }
    }
    expect(lockedTaskId).toBeDefined();
    const result = await client.completeTask(lockedTaskId, "ci-worker-integration");
    expect(result).toEqual({ ok: true });
  });
});
