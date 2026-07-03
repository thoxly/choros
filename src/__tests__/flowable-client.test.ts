/**
 * T-0064: Unit tests for makeFlowableClient.
 *
 * All run without a live Flowable instance — HTTP mocked via vi.stubGlobal.
 * delayFn injected as () => Promise.resolve() so retry loops are synchronous.
 * Covers AC-2..AC-13.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFlowableClient } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_DELAY = () => Promise.resolve();

/** Minimal test config — no retries by default (override per test). */
function testConfig(overrides: Partial<Parameters<typeof makeFlowableClient>[0]> = {}) {
  return makeFlowableClient({
    baseUrl: "http://flowable-test:8082/flowable-rest/service",
    adminUser: "test-user",
    adminPassword: "test-pass",
    timeoutMs: 500,
    maxRetries: 0,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    delayFn: NO_DELAY,
    ...overrides,
  });
}

/** Build a mock Response object. */
function mockResponse(status: number, body?: unknown): Response {
  return {
    status,
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {}),
    ok: status >= 200 && status < 300,
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// AC-2: deployBpmn → HTTP 201 → { ok: true, deploymentId }
// ---------------------------------------------------------------------------
describe("deployBpmn", () => {
  it("AC-2: returns { ok: true, deploymentId } on HTTP 201", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(201, { id: "deploy-123" }),
    );
    const client = testConfig();
    const result = await client.deployBpmn("<bpmn>...</bpmn>");
    expect(result).toEqual({ ok: true, deploymentId: "deploy-123" });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/repository/deployments");
    expect((init.headers as Record<string, string>)["Authorization"]).toMatch(/^Basic /);
  });

  // AC-3: deployBpmn → HTTP 400 → { ok: false, code: "BAD_BPMN" }
  it("AC-3: returns { ok: false, code: BAD_BPMN } on HTTP 400", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(400, {}));
    const client = testConfig();
    const result = await client.deployBpmn("<bad/>");
    expect(result).toEqual({ ok: false, code: "BAD_BPMN" });
  });

  it("returns UNAUTHORIZED on HTTP 401", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(401));
    const client = testConfig();
    const result = await client.deployBpmn("<bpmn/>");
    expect(result).toEqual({ ok: false, code: "UNAUTHORIZED" });
  });
});

// ---------------------------------------------------------------------------
// AC-4: startInstance → HTTP 201 → { ok: true, instanceId }
// ---------------------------------------------------------------------------
describe("startInstance", () => {
  it("AC-4: returns { ok: true, instanceId } on HTTP 201", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(201, { id: "inst-456" }),
    );
    const client = testConfig();
    const result = await client.startInstance("chorosSmoke");
    expect(result).toEqual({ ok: true, instanceId: "inst-456" });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/runtime/process-instances");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["processDefinitionKey"]).toBe("chorosSmoke");
  });

  // AC-5: variables containing record object → RECORD_IN_PAYLOAD, no fetch call
  it("AC-5: rejects record-kind object in variables without calling engine", async () => {
    const client = testConfig();
    const variables = {
      badVar: { kind: "record", tenantId: "t1", registryId: "r1", recordId: "rec1" },
    };
    const result = await client.startInstance("chorosSmoke", variables);
    expect(result).toEqual({ ok: false, code: "RECORD_IN_PAYLOAD" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("AC-5: rejects object with data field without calling engine", async () => {
    const client = testConfig();
    const variables = { bad: { data: { name: "Alice" }, fields: [] } };
    const result = await client.startInstance("chorosSmoke", variables as Record<string, unknown>);
    expect(result).toEqual({ ok: false, code: "RECORD_IN_PAYLOAD" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("passes primitive variables to engine", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(201, { id: "inst-789" }),
    );
    const client = testConfig();
    const result = await client.startInstance("chorosSmoke", {
      name: "test",
      count: 42,
    });
    expect(result).toEqual({ ok: true, instanceId: "inst-789" });
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["variables"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-6 / AC-7: fetchAndLock
// ---------------------------------------------------------------------------
describe("fetchAndLock", () => {
  it("AC-6: returns { ok: true, tasks } on HTTP 200 with tasks", async () => {
    // Flowable 7.1.0 external-job-api returns a bare JSON array (not { data: [...] })
    // topic is echoed from the request (not in the wire response)
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(200, [
        {
          id: "job-1",
          processInstanceId: "proc-1",
          variables: [{ name: "x", value: 1 }],
          lockOwner: "ci-worker",
          lockExpirationTime: "2099-01-01T00:00:00Z",
        },
      ]),
    );
    const client = testConfig();
    const result = await client.fetchAndLock("smoke-topic", "ci-worker", 30000, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]!.id).toBe("job-1");
      expect(result.tasks[0]!.topic).toBe("smoke-topic"); // echoed from request
    }
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    // AC-6 / deviation guard: must use the /external-job-api/ servlet (not /service/)
    expect(url).toContain("/external-job-api/");
    expect(url).toContain("acquire/jobs");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["topic"]).toBe("smoke-topic");
    expect(body["workerId"]).toBe("ci-worker");
    expect(body["numberOfTasks"]).toBe(1); // not "maxJobs"
  });

  it("AC-7: returns { ok: true, tasks: [] } on HTTP 200 with empty array", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(200, []),
    );
    const client = testConfig();
    const result = await client.fetchAndLock("smoke-topic", "ci-worker", 30000, 1);
    expect(result).toEqual({ ok: true, tasks: [] });
  });
});

// ---------------------------------------------------------------------------
// AC-8 / AC-9 / AC-10: completeTask
// ---------------------------------------------------------------------------
describe("completeTask", () => {
  it("AC-8: returns { ok: true } on HTTP 204 (no variables)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(204));
    const client = testConfig();
    const result = await client.completeTask("task-1", "ci-worker");
    expect(result).toEqual({ ok: true });
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("task-1");
    expect(url).toContain("complete");
  });

  it("AC-9: rejects record-kind object in variables without calling engine", async () => {
    const client = testConfig();
    const variables = {
      rec: { kind: "record", tenantId: "t1", registryId: "r1", recordId: "r1" },
    };
    const result = await client.completeTask("task-1", "ci-worker", variables);
    expect(result).toEqual({ ok: false, code: "RECORD_IN_PAYLOAD" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("AC-10: valid primitive variables → calls engine → { ok: true }", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(204));
    const client = testConfig();
    const result = await client.completeTask("task-1", "ci-worker", {
      status: "done",
      count: 5,
    });
    expect(result).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["variables"]).toBeDefined();
    expect(body["workerId"]).toBe("ci-worker");
  });
});

// ---------------------------------------------------------------------------
// AC-11: failTask
// ---------------------------------------------------------------------------
describe("failTask", () => {
  it("AC-11: returns { ok: true } on HTTP 204", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(204));
    const client = testConfig();
    const result = await client.failTask("task-2", "ci-worker", "timeout", 2, 5000);
    expect(result).toEqual({ ok: true });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("task-2");
    expect(url).toContain("fail");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["errorMessage"]).toBe("timeout");
    expect(body["retries"]).toBe(2);
    expect(body["retryTimeout"]).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// AC-12: Retry on 5xx
// ---------------------------------------------------------------------------
describe("retry behaviour", () => {
  it("AC-12 (partial): retries on 5xx and succeeds on next attempt", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(204));
    const client = testConfig({ maxRetries: 3 });
    const result = await client.failTask("task-3", "w", "err", 0, 0);
    expect(result).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("AC-12: exhausts retries on repeated 5xx → { ok: false, code: ENGINE_UNAVAILABLE }", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse(500));
    const client = testConfig({ maxRetries: 3 });
    const result = await client.deployBpmn("<bpmn/>");
    expect(result).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
    // 4 calls: 1 initial + 3 retries
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it("AC-12: network error retried, eventually ENGINE_UNAVAILABLE", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));
    const client = testConfig({ maxRetries: 2 });
    const result = await client.deployBpmn("<bpmn/>");
    expect(result).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
    // 3 calls: 1 initial + 2 retries
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("4xx is not retried", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse(404));
    const client = testConfig({ maxRetries: 3 });
    const result = await client.startInstance("missing");
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC-13: Timeout
// ---------------------------------------------------------------------------
describe("timeout", () => {
  it("AC-13: returns { ok: false, code: TIMEOUT } when fetch never resolves in time", async () => {
    // fetch returns a promise that never resolves
    vi.mocked(globalThis.fetch).mockReturnValue(new Promise(() => {/* never */}) as Promise<Response>);
    const client = testConfig({ timeoutMs: 10, maxRetries: 0 });
    const result = await client.fetchAndLock("smoke-topic", "w", 30000, 1);
    expect(result).toEqual({ ok: false, code: "TIMEOUT" });
  });
});

// ---------------------------------------------------------------------------
// Factory: missing password throws
// ---------------------------------------------------------------------------
describe("factory validation", () => {
  it("throws if FLOWABLE_REST_APP_ADMIN_PASSWORD is absent and not injected", () => {
    const saved = process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"];
    delete process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"];
    expect(() =>
      makeFlowableClient({
        baseUrl: "http://x",
        adminUser: "u",
        // no adminPassword
      }),
    ).toThrow("FLOWABLE_REST_APP_ADMIN_PASSWORD is required");
    if (saved !== undefined) process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"] = saved;
  });
});

// ---------------------------------------------------------------------------
// T-0483: pingEngine — readiness probe (single GET to /management/engine)
// ---------------------------------------------------------------------------
describe("T-0483 pingEngine", () => {
  it("reachable: true on HTTP 200 (hits /management/engine, single shot)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { name: "default" }));
    const client = testConfig();
    const result = await client.pingEngine!();
    expect(result).toEqual({ ok: true, reachable: true });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
    expect(url).toContain("/management/engine");
  });

  it("reachable: false + ENGINE_UNAVAILABLE on HTTP 500", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500));
    const client = testConfig();
    const result = await client.pingEngine!();
    expect(result).toEqual({ ok: true, reachable: false, code: "ENGINE_UNAVAILABLE" });
  });

  it("reachable: false + ENGINE_UNAVAILABLE on a network error (never throws)", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const client = testConfig();
    const result = await client.pingEngine!();
    expect(result).toEqual({ ok: true, reachable: false, code: "ENGINE_UNAVAILABLE" });
  });
});

// ---------------------------------------------------------------------------
// T-0536 correlateMessage — fire a parked message-catch in the live engine.
// ---------------------------------------------------------------------------

describe("T-0536 correlateMessage", () => {
  it("PUTs action=messageEventReceived with messageName + variables (ok on 200)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, { id: "inst-1" }));
    const client = testConfig();
    const result = await client.correlateMessage("inst-1", "contract-signed", { doc: "ref-1" });
    expect(result).toEqual({ ok: true });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/runtime/process-instances/inst-1");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string);
    expect(body.action).toBe("messageEventReceived");
    expect(body.messageName).toBe("contract-signed");
    expect(body.variables).toEqual([{ name: "doc", value: "ref-1" }]);
  });

  it("ok on 204 (no content)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(204));
    const client = testConfig();
    const result = await client.correlateMessage("inst-1", "m", {});
    expect(result).toEqual({ ok: true });
  });

  it("maps a non-2xx to { ok: false, code } (never throws)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(404));
    const client = testConfig();
    const result = await client.correlateMessage("inst-gone", "m", {});
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-0609 getHistoricVariableInstances — full variable set from the engine's
// HISTORY store (survives after the instance ends), read by the
// process-instance detail page.
// ---------------------------------------------------------------------------

describe("T-0609 getHistoricVariableInstances", () => {
  it("maps { data: [{variableName, value}] } to { name, value } on HTTP 200", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(200, {
        data: [
          { variableName: "amount", value: 42000 },
          { variableName: "approver", value: "e-test-approver" },
        ],
      }),
    );
    const client = testConfig();
    const result = await client.getHistoricVariableInstances!("inst-1");
    expect(result).toEqual({
      ok: true,
      variables: [
        { name: "amount", value: 42000 },
        { name: "approver", value: "e-test-approver" },
      ],
    });
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
    expect(url).toContain("/history/historic-variable-instances");
    expect(url).toContain("processInstanceId=inst-1");
  });

  it("returns { ok: true, variables: [] } when data is absent/not an array", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, {}));
    const client = testConfig();
    const result = await client.getHistoricVariableInstances!("inst-1");
    expect(result).toEqual({ ok: true, variables: [] });
  });

  it("maps a non-2xx to { ok: false, code } (never throws)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(500));
    const client = testConfig();
    const result = await client.getHistoricVariableInstances!("inst-1");
    expect(result).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
  });
});

// ---------------------------------------------------------------------------
// T-0609 getHistoricActivityInstances — ordered BPMN activity history
// (startEvent/userTask/gateway/endEvent), the engine-native replacement for
// the raw SQL a P0 gateway-branch diagnosis previously required.
// ---------------------------------------------------------------------------

describe("T-0609 getHistoricActivityInstances", () => {
  it("maps { data: [...] } to HistoricActivity[] on HTTP 200, sort=startTime in the URL", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(200, {
        data: [
          {
            activityId: "start1",
            activityName: "Начало",
            activityType: "startEvent",
            startTime: "2026-07-03T10:00:00.000+0000",
            endTime: "2026-07-03T10:00:00.000+0000",
            assignee: null,
          },
          {
            activityId: "task-approve",
            activityName: "Утверждение",
            activityType: "userTask",
            startTime: "2026-07-03T10:00:01.000+0000",
            endTime: null,
            assignee: "e-test-approver",
          },
        ],
      }),
    );
    const client = testConfig();
    const result = await client.getHistoricActivityInstances!("inst-1");
    expect(result).toEqual({
      ok: true,
      activities: [
        {
          activityId: "start1",
          activityName: "Начало",
          activityType: "startEvent",
          startTime: "2026-07-03T10:00:00.000+0000",
          endTime: "2026-07-03T10:00:00.000+0000",
          assignee: null,
        },
        {
          activityId: "task-approve",
          activityName: "Утверждение",
          activityType: "userTask",
          startTime: "2026-07-03T10:00:01.000+0000",
          endTime: null,
          assignee: "e-test-approver",
        },
      ],
    });
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
    expect(url).toContain("/history/historic-activity-instances");
    expect(url).toContain("processInstanceId=inst-1");
    expect(url).toContain("sort=startTime");
  });

  it("returns { ok: true, activities: [] } when data is absent/not an array", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(200, {}));
    const client = testConfig();
    const result = await client.getHistoricActivityInstances!("inst-1");
    expect(result).toEqual({ ok: true, activities: [] });
  });

  it("maps a non-2xx to { ok: false, code } (never throws)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(404));
    const client = testConfig();
    const result = await client.getHistoricActivityInstances!("inst-gone");
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});
