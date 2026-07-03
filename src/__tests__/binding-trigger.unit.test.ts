/**
 * src/__tests__/binding-trigger.unit.test.ts — T-0351 E16
 *
 * Unit tests for the on_create trigger seam in records.ts:
 *   1. projectEngineVariables — scalar projection + RECORD_IN_PAYLOAD doctrine.
 *   2. on_create binding fires process start in the same tx: engine fail → record rolled back.
 *   3. Scalars only: objects/arrays in record data are NOT projected (RECORD_IN_PAYLOAD guard).
 *
 * No live Postgres. Uses the same stub-pool + stub-flowable pattern as process-start.test.ts.
 * DB-round-trip tests (on_create with real postgres, binding row lookup) are server-PG gated
 * — marked [DB-UNTESTED] in comments.
 */

import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerRecordRoutes, type RecordRoutesDeps } from "../http/records.js";
import type { ActiveUserTask, FlowableClient, StartResult } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Stub FlowableClient — configurable startInstance result.
 *
 * T-0604 [P0/целостность согласований]: the on_create skip-submit gate
 * (records.ts) now consolidates on a SINGLE flowable.getActiveUserTasks call
 * (no more getFirstActiveUserTask in that path — see ADR-T0604 §1.3) and
 * gates completeUserTask on binding.submit_task_key matching the live
 * engine's first active task's taskDefinitionKey. `activeTasks` lets each
 * test declare what the "live engine" reports as active user-tasks right
 * after startInstance; defaults to [] (mirrors the pre-T-0604 default of "no
 * active user task" — auto-complete never fires, existing tests relying on
 * this default are unaffected).
 */
function makeStubFlowable(result: StartResult, activeTasks: ActiveUserTask[] = []): FlowableClient {
  return {
    deployBpmn: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    startInstance: vi.fn().mockResolvedValue(result),
    fetchAndLock: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    completeTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    failTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    // T-0368: kept as a stub for interface completeness — T-0604 removed its
    // only caller (records.ts on_create block now uses getActiveUserTasks
    // exclusively, see ADR-T0604 §1.3). Not asserted on by these tests.
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null }),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
    // T-0443 / T-0604: the on_create block's SOLE engine-state read — drives
    // both the submit_task_key gate and the BUG-015 projection fallback.
    getActiveUserTasks: vi.fn().mockResolvedValue({ ok: true, tasks: activeTasks }),
    getMessageCatchWaits: vi.fn().mockResolvedValue({ ok: true, waits: [] }),
    correlateMessage: vi.fn().mockResolvedValue({ ok: true }),
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
  };
}

/**
 * Stub pg PoolClient. Simulates:
 *   - BEGIN/COMMIT/ROLLBACK/SET LOCAL → no-op
 *   - The registry_def lookup → returns one registry_def row (schema = { type: 'object', properties: {}, additionalProperties: true })
 *   - The record INSERT → no-op
 *   - The audit INSERT → no-op
 *   - The process_app_binding lookup → returns `bindingRow` (or null if undefined)
 *   - The record readback → returns a joined row
 */
function makeStubClient(opts: {
  bindingRow?: {
    id: string;
    process_key: string;
    trigger_type: string;
    start_form_key: string | null;
    field_mapping: Record<string, string> | null;
    /**
     * T-0604: the declared submit-task defKey (migration 121). Optional here
     * for backward-compat with pre-T-0604 test fixtures that never mention
     * it — the stub SQL response below defaults an absent key to `null`
     * (mirrors the real column's NULL default for every row that predates
     * migration 121 / never sets this explicitly).
     */
    submit_task_key?: string | null;
  } | null;
  trackRollback?: { called: boolean };
  /**
   * T-0603: optional record_schema override so a test can declare derived
   * (x-rollup) fields and exercise the on_create derived-precompute overlay.
   * Defaults to the schema-less object used by the original T-0351 tests.
   */
  recordSchema?: Record<string, unknown>;
}) {
  const { bindingRow, trackRollback, recordSchema } = opts;
  const fakeRegistryDef = {
    id: "ae000000-0000-0000-0000-000000000001",
    application_id: "a0000000-0000-0000-0000-000000000001",
    record_schema: recordSchema ?? { type: "object", properties: {}, additionalProperties: true },
    record_schema_version: 1,
  };
  const fakeRecord = {
    id: "ac000000-0000-0000-0000-000000000001",
    registry_id: fakeRegistryDef.id,
    application_id: fakeRegistryDef.application_id,
    record_schema_version: 1,
    data: { amount: 100 },
    created_at: "1000",
    updated_at: "1000",
  };

  const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
  return {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      // BEGIN/COMMIT/ROLLBACK/SET LOCAL
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/i.test(sql.trim())) {
        if (/^ROLLBACK/i.test(sql.trim()) && trackRollback) {
          trackRollback.called = true;
        }
        return { rows: [] };
      }
      // audit-writer: SELECT current_setting('choros.tenant_id', ...)
      if (/current_setting\s*\(\s*'choros\.tenant_id'/i.test(sql) && !/INSERT|UPDATE/i.test(sql)) {
        return { rows: [{ tenant_id: TENANT_ID }] };
      }
      // audit-writer: INSERT INTO choros.audit_head (seed + lock)
      if (/INSERT INTO choros\.audit_head/i.test(sql)) {
        return { rows: [] };
      }
      // audit-writer: SELECT ... FROM choros.audit_head ... FOR UPDATE
      if (/FROM choros\.audit_head/i.test(sql)) {
        return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
      }
      // audit-writer: UPDATE choros.audit_head
      if (/UPDATE choros\.audit_head/i.test(sql)) {
        return { rows: [] };
      }
      // process_app_binding SELECT (getOnCreateBinding) — T-0606: this query's
      // WHERE clause now embeds a nested `FROM choros.registry_def` subquery
      // (the NULL-trigger_registry_id "primary registry" fallback), so it
      // MUST be checked BEFORE the generic registry_def branch below, else
      // the subquery text would misroute this call to the plain registry_def
      // responder instead of the binding-row responder.
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        if (bindingRow === null || bindingRow === undefined) {
          return { rows: [] };
        }
        // T-0604: mirror the real column's NULL default when a fixture omits
        // submit_task_key entirely (pre-T-0604 test literals).
        // T-0606: mirror the real column's NULL default when a fixture omits
        // trigger_registry_id entirely (pre-T-0606 test literals) — NULL means
        // "fires on the application's primary registry", which this stub's
        // fakeRegistryDef.id always satisfies (see the nested subquery below).
        return { rows: [{ submit_task_key: null, trigger_registry_id: null, ...bindingRow }] };
      }
      // registry_def SELECT (both the createRecord governing-registry lookup
      // AND getOnCreateBinding's nested "primary registry" subquery resolve
      // to the SAME single fakeRegistryDef in this stub — there is only one
      // registry_def in play, so it is trivially always the "primary" one).
      if (/FROM choros\.registry_def/i.test(sql)) {
        return { rows: [{ ...fakeRegistryDef, engine_managed: false }] };
      }
      // record INSERT
      if (/INSERT INTO choros\.record/i.test(sql)) {
        return { rows: [] };
      }
      // audit_event INSERT (appendAuditEvent)
      if (/INSERT INTO choros\.audit_event/i.test(sql)) {
        return { rows: [] };
      }
      // record readback SELECT (joined)
      if (/FROM choros\.record r/i.test(sql)) {
        return { rows: [fakeRecord] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

function makeStubPool(opts: Parameters<typeof makeStubClient>[0]) {
  const client = makeStubClient(opts);
  return {
    connect: async () => client as unknown as import("pg").PoolClient,
    _client: client,
  } as unknown as import("pg").Pool & { _client: ReturnType<typeof makeStubClient> };
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

function buildServer(deps: RecordRoutesDeps): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  registerRecordRoutes(router, deps);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  return {
    server,
    baseUrl: () => {
      const addr = server.address() as { port: number } | null;
      if (!addr) throw new Error("server not listening");
      return `http://127.0.0.1:${addr.port}`;
    },
  };
}

async function httpReq(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
    }, (res) => {
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: text });
        }
      });
    });
    req.on("error", reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test: projectEngineVariables — scalar projection + RECORD_IN_PAYLOAD guard
// ---------------------------------------------------------------------------
// We test the exported pure function indirectly via the route, but the core
// scalar-only guard is verifiable without a DB.

describe("T-0351 projectEngineVariables — scalar projection (RECORD_IN_PAYLOAD doctrine)", () => {
  it("projects string, number, boolean, null scalars from record data via field_mapping", async () => {
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-001" });
    const bindingRow = {
      id: "bind-001",
      process_key: "invoiceApproval",
      trigger_type: "on_create",
      start_form_key: null,
      field_mapping: {
        // These map engine var names → field paths in record data
        "amount": "summa",
        "approved": "isApproved",
        "label": "name",
        "nothing": "missing_field",
      } as Record<string, string>,
    };

    // Record data to be created — contains scalar + object (object must NOT be projected)
    const recordData = {
      summa: 42000,
      isApproved: false,
      name: "Инвойс-001",
      nested: { should: "be ignored" },   // object — RECORD_IN_PAYLOAD guard
      arr: [1, 2, 3],                      // array — RECORD_IN_PAYLOAD guard
    };

    const pool = makeStubPool({ bindingRow });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: "a0000000-0000-0000-0000-000000000001",
          data: recordData,
        },
      );
      expect(res.status).toBe(201);

      // The flowable.startInstance must have been called with ONLY scalar projections.
      expect(flowable.startInstance).toHaveBeenCalledOnce();
      const [calledKey, calledVars] = (flowable.startInstance as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown> | undefined];
      expect(calledKey).toBe("invoiceApproval");
      // Scalars projected correctly
      expect(calledVars).toBeDefined();
      expect(calledVars!["amount"]).toBe(42000);
      expect(calledVars!["approved"]).toBe(false);
      expect(calledVars!["label"]).toBe("Инвойс-001");
      // 'nothing' maps to 'missing_field' which is undefined → sent as null
      expect(calledVars!["nothing"]).toBe(null);
      // Objects and arrays from record data are NEVER in the variables (RECORD_IN_PAYLOAD)
      expect(calledVars!["nested"]).toBeUndefined();
      expect(calledVars!["arr"]).toBeUndefined();
      // 'nested' and 'arr' are not in field_mapping, so they can't appear.
      // More importantly: if field_mapping had pointed to them, they'd be dropped.
    } finally {
      server.close();
    }
  });

  it("no binding → record created, startInstance NOT called", async () => {
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-002" });
    const pool = makeStubPool({ bindingRow: null });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: "a0000000-0000-0000-0000-000000000001",
          data: { amount: 100 },
        },
      );
      expect(res.status).toBe(201);
      // No binding → no engine call
      expect(flowable.startInstance).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("no flowable dep → record created without engine call", async () => {
    const pool = makeStubPool({ bindingRow: null });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      // No flowable — honest-degrade
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: "a0000000-0000-0000-0000-000000000001",
          data: { amount: 200 },
        },
      );
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: engine fail → transaction rolled back (record NOT persisted)
// ---------------------------------------------------------------------------

describe("T-0351 on_create: engine fail → tx rolled back (create = start atomicity)", () => {
  it("startInstance ENGINE_UNAVAILABLE → 503 and tx ROLLBACK (record not persisted)", async () => {
    // T-0483: engine unreachable surfaces a typed 503 ENGINE_UNAVAILABLE (transient),
    // not an opaque 502. The record must still NOT persist (create=start atomicity).
    const flowable = makeStubFlowable({ ok: false, code: "ENGINE_UNAVAILABLE" });
    const trackRollback = { called: false };
    const bindingRow = {
      id: "bind-002",
      process_key: "leaveApproval",
      trigger_type: "on_create",
      start_form_key: null,
      field_mapping: {} as Record<string, string>,
    };

    const pool = makeStubPool({ bindingRow, trackRollback });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: "a0000000-0000-0000-0000-000000000001",
          data: { days: 5 },
        },
      );
      // Engine unreachable → typed 503 ENGINE_UNAVAILABLE
      expect(res.status).toBe(503);
      const body = res.json as { error?: { code?: string } };
      expect(body?.error?.code).toBe("ENGINE_UNAVAILABLE");
      // TX was rolled back (no orphan record)
      expect(trackRollback.called).toBe(true);
    } finally {
      server.close();
    }
  });

  it("empty field_mapping → startInstance called with undefined variables", async () => {
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-003" });
    const bindingRow = {
      id: "bind-003",
      process_key: "vacationApproval",
      trigger_type: "on_create",
      start_form_key: null,
      field_mapping: {} as Record<string, string>,
    };
    const pool = makeStubPool({ bindingRow });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: "a0000000-0000-0000-0000-000000000001",
          data: { note: "отпуск" },
        },
      );
      expect(res.status).toBe(201);
      // Empty field_mapping → no variables (undefined, not {})
      const [, calledVars] = (flowable.startInstance as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown];
      expect(calledVars).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T-0604 [P0/целостность согласований]: on_create skip-submit auto-complete
// is gated by process_app_binding.submit_task_key — never unconditional.
// ---------------------------------------------------------------------------
// Live fact (приёмка 2026-07-03): the T-0368 auto-complete unconditionally
// completed the FIRST active user task after startInstance, assuming it was
// always task-submit. In the purchaseApproval process the first task is
// «Проверка руководителем» (task-review) — a REAL approval step, silently
// swallowed in ~35ms once T-0571 made completeUserTask a live call. These
// tests exercise the new gate directly through the REAL HTTP route (same
// pattern as every other describe block in this file): AC-3 (no declared key
// → never auto-complete), AC-4 (declared key matches the live first task →
// auto-complete fires), AC-5 (declared key present but does NOT match → auto-
// complete does not fire, task-review-shaped step is left for a human).

describe("T-0604 on_create: skip-submit gated by submit_task_key", () => {
  const baseBindingRow = {
    id: "bind-604",
    process_key: "purchaseApprovalGeneric",
    trigger_type: "on_create",
    start_form_key: null,
    field_mapping: {} as Record<string, string>,
  };

  it("AC-3: submit_task_key NULL (no binding config) → completeUserTask NOT called even though an active user task exists", async () => {
    const flowable = makeStubFlowable(
      { ok: true, instanceId: "inst-604a" },
      // The live engine reports an active task — e.g. "Проверка руководителем"
      // (task-review) — but the binding declares NO submit_task_key at all.
      [
        {
          id: "engine-task-604a",
          taskDefinitionKey: "task-review",
          name: "Проверка руководителем",
          candidateGroups: ["role-reviewer"],
        },
      ],
    );
    const bindingRow = { ...baseBindingRow, submit_task_key: null };
    const pool = makeStubPool({ bindingRow });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        { application_id: "a0000000-0000-0000-0000-000000000001", data: {} },
      );
      expect(res.status).toBe(201);
      expect(flowable.startInstance).toHaveBeenCalledOnce();
      // The safe default: no config → the real approval step is left alone.
      expect(flowable.completeUserTask).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("AC-4: submit_task_key set AND first active task's defKey matches → completeUserTask IS called with that task's id", async () => {
    const flowable = makeStubFlowable(
      { ok: true, instanceId: "inst-604b" },
      [
        {
          id: "engine-task-604b",
          taskDefinitionKey: "task-submit",
          name: "Подача заявки",
          candidateGroups: ["role-initiator"],
        },
      ],
    );
    const bindingRow = { ...baseBindingRow, submit_task_key: "task-submit" };
    const pool = makeStubPool({ bindingRow });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        { application_id: "a0000000-0000-0000-0000-000000000001", data: {} },
      );
      expect(res.status).toBe(201);
      expect(flowable.completeUserTask).toHaveBeenCalledOnce();
      expect(flowable.completeUserTask).toHaveBeenCalledWith("engine-task-604b");
    } finally {
      server.close();
    }
  });

  it("AC-5: submit_task_key set but first active task's defKey does NOT match → completeUserTask NOT called (task-review-shaped step stays live)", async () => {
    const flowable = makeStubFlowable(
      { ok: true, instanceId: "inst-604c" },
      // The binding declares 'task-submit' as legitimate, but the live first
      // active task is actually task-review — the purchaseApproval live-fact
      // shape. The mismatch must NOT be treated as an error; the task is
      // simply left for a human.
      [
        {
          id: "engine-task-604c",
          taskDefinitionKey: "task-review",
          name: "Проверка руководителем",
          candidateGroups: ["role-reviewer"],
        },
      ],
    );
    const bindingRow = { ...baseBindingRow, submit_task_key: "task-submit" };
    const pool = makeStubPool({ bindingRow });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        { application_id: "a0000000-0000-0000-0000-000000000001", data: {} },
      );
      expect(res.status).toBe(201);
      expect(flowable.completeUserTask).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("AC-2/AC-6 regression guard: no active user tasks at all (empty getActiveUserTasks) → completeUserTask not called, even with submit_task_key set — mirrors the original T-0368 default-stub behavior", async () => {
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-604d" }, []);
    const bindingRow = { ...baseBindingRow, submit_task_key: "task-submit" };
    const pool = makeStubPool({ bindingRow });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        { application_id: "a0000000-0000-0000-0000-000000000001", data: {} },
      );
      expect(res.status).toBe(201);
      expect(flowable.completeUserTask).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Test: savepoint — projection failure does NOT lose the committed record
// ---------------------------------------------------------------------------
//
// When appendProcessStarted throws (simulated by making the client throw on the
// second UPDATE choros.audit_head — the projection's inner write), the SAVEPOINT
// must contain the failure so the outer tx commits normally (record + instance safe).
// The HTTP response must be 201, proving the record was NOT lost.

describe("T-0351 savepoint: projection failure does not lose the committed record", () => {
  it("appendProcessStarted throws → record still committed (201), tx not poisoned", async () => {
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-proj-err" });

    const bindingRow = {
      id: "bind-save-001",
      process_key: "projErrorProcess",
      trigger_type: "on_create",
      start_form_key: null,
      field_mapping: {} as Record<string, string>,
    };

    const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
    const fakeRegistryDef = {
      id: "ae000000-0000-0000-0000-000000000001",
      application_id: "a0000000-0000-0000-0000-000000000001",
      record_schema: { type: "object", properties: {}, additionalProperties: true },
      record_schema_version: 1,
    };
    const fakeRecord = {
      id: "ac000000-0000-0000-0000-000000000002",
      registry_id: fakeRegistryDef.id,
      application_id: fakeRegistryDef.application_id,
      record_schema_version: 1,
      data: {},
      created_at: "2000",
      updated_at: "2000",
    };

    // Track SAVEPOINT / ROLLBACK TO SAVEPOINT / RELEASE SAVEPOINT calls.
    // Each entry is "<verb> <savepoint_name>" so assertions can scope to a specific savepoint.
    // e.g. "SAVEPOINT proc_proj", "ROLLBACK_TO proc_proj", "RELEASE dmn_precompute"
    const savepointLog: string[] = [];
    // The first UPDATE choros.audit_head is the record.create audit event (must succeed).
    // The second UPDATE choros.audit_head is inside appendProcessStarted (must throw
    // to simulate a projection write failure — triggers the ROLLBACK TO SAVEPOINT path).
    let auditHeadUpdateCount = 0;

    const throwingClient = {
      query: vi.fn(async (sql: string, _params?: unknown[]) => {
        const trimmed = sql.trim();
        // Track SAVEPOINT control commands — capture name so assertions can be scoped.
        const savepointMatch = trimmed.match(/^SAVEPOINT\s+(\S+)/i);
        if (savepointMatch) {
          savepointLog.push(`SAVEPOINT ${savepointMatch[1]!.toLowerCase()}`);
          return { rows: [] };
        }
        const releaseMatch = trimmed.match(/^RELEASE SAVEPOINT\s+(\S+)/i);
        if (releaseMatch) {
          savepointLog.push(`RELEASE ${releaseMatch[1]!.toLowerCase()}`);
          return { rows: [] };
        }
        const rollbackMatch = trimmed.match(/^ROLLBACK TO SAVEPOINT\s+(\S+)/i);
        if (rollbackMatch) {
          savepointLog.push(`ROLLBACK_TO ${rollbackMatch[1]!.toLowerCase()}`);
          return { rows: [] };
        }
        // Standard tx control
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/i.test(trimmed)) {
          return { rows: [] };
        }
        // audit-writer: SELECT current_setting
        if (/current_setting\s*\(\s*'choros\.tenant_id'/i.test(sql) && !/INSERT|UPDATE/i.test(sql)) {
          return { rows: [{ tenant_id: TENANT_ID }] };
        }
        // audit-writer: INSERT INTO choros.audit_head
        if (/INSERT INTO choros\.audit_head/i.test(sql)) {
          return { rows: [] };
        }
        // audit-writer: SELECT ... FROM choros.audit_head ... FOR UPDATE
        if (/FROM choros\.audit_head/i.test(sql)) {
          return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
        }
        // audit-writer: UPDATE choros.audit_head — throw on 2nd call (projection path)
        if (/UPDATE choros\.audit_head/i.test(sql)) {
          auditHeadUpdateCount++;
          if (auditHeadUpdateCount >= 2) {
            throw new Error("simulated projection write failure — DB rejected UPDATE");
          }
          return { rows: [] };
        }
        // registry_def SELECT
        if (/FROM choros\.registry_def/i.test(sql)) {
          return { rows: [fakeRegistryDef] };
        }
        // record INSERT
        if (/INSERT INTO choros\.record/i.test(sql)) {
          return { rows: [] };
        }
        // audit_event INSERT
        if (/INSERT INTO choros\.audit_event/i.test(sql)) {
          return { rows: [] };
        }
        // process_app_binding SELECT
        if (/FROM choros\.process_app_binding/i.test(sql)) {
          return { rows: [bindingRow] };
        }
        // record readback SELECT (joined) — only reached if outer tx was NOT poisoned
        if (/FROM choros\.record r/i.test(sql)) {
          return { rows: [fakeRecord] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const pool = {
      connect: async () => throwingClient as unknown as import("pg").PoolClient,
    } as unknown as import("pg").Pool;

    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: "a0000000-0000-0000-0000-000000000001",
          data: { note: "savepoint-test" },
        },
      );

      // Record must be committed (201) even though projection failed
      expect(res.status).toBe(201);

      // proc_proj savepoint was issued and rolled back (not released) — projection failure
      // contained so the outer tx is not poisoned.
      expect(savepointLog).toContain("SAVEPOINT proc_proj");
      expect(savepointLog).toContain("ROLLBACK_TO proc_proj");
      expect(savepointLog).not.toContain("RELEASE proc_proj");

      // dmn_precompute savepoint succeeded (RELEASE, not ROLLBACK) — new T-0439 behavior.
      expect(savepointLog).toContain("SAVEPOINT dmn_precompute");
      expect(savepointLog).toContain("RELEASE dmn_precompute");

      // startInstance was called (engine succeeded)
      expect(flowable.startInstance).toHaveBeenCalledOnce();
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T-0603: embedded-rollup derived-precompute reaches startInstance variables
// ---------------------------------------------------------------------------
// The core defect (acceptance 2026-07-03): an on_create field_mapping entry that
// points at an EMBEDDED-rollup field (aggregate over a collection array in the
// record's own data) got projected as NULL, because rollup-contract.ts only
// recognized the child-records rollup flavor. These tests drive the REAL on_create
// route with a schema declaring an embedded x-rollup field and assert the computed
// sum reaches flowable.startInstance's variables (not null).

describe("T-0603 on_create: embedded-rollup field reaches startInstance variables", () => {
  // A registry schema with an embedded-rollup 'total' field:
  //   total = Σ(items[].price × items[].qty), never stored in record.data (PD-20).
  const embeddedRollupSchema = {
    type: "object",
    additionalProperties: true,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { price: { type: "number" }, qty: { type: "number" } },
        },
      },
      total: {
        type: "number",
        "x-rollup": { source: "items", op: "sum", value_field: "price", factor_field: "qty" },
      },
    },
  };

  const bindingRow = {
    id: "bind-603",
    process_key: "purchaseApprovalGeneric",
    trigger_type: "on_create",
    start_form_key: null,
    // engine var 'amount' ← the DERIVED field 'total' (not a raw submitted field)
    field_mapping: { amount: "total" } as Record<string, string>,
  };

  it("AC-7: non-empty collection → amount = computed sum (Σ price×qty), NOT null", async () => {
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-603a" });
    const pool = makeStubPool({ bindingRow, recordSchema: embeddedRollupSchema });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: "a0000000-0000-0000-0000-000000000001",
          data: {
            // 100000×3 + 250000×1 + 50000×5 = 300000 + 250000 + 250000 = 800000
            items: [
              { price: 100000, qty: 3 },
              { price: 250000, qty: 1 },
              { price: 50000, qty: 5 },
            ],
          },
        },
      );
      expect(res.status).toBe(201);

      expect(flowable.startInstance).toHaveBeenCalledOnce();
      const [, calledVars] = (flowable.startInstance as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        Record<string, unknown> | undefined,
      ];
      expect(calledVars).toBeDefined();
      // The overlaid embedded-rollup sum reached the engine as a NUMBER.
      expect(calledVars!["amount"]).toBe(800000);
    } finally {
      server.close();
    }
  });

  it("AC-8: empty collection → amount = null (deterministic default-branch contract)", async () => {
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-603b" });
    const pool = makeStubPool({ bindingRow, recordSchema: embeddedRollupSchema });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: "a0000000-0000-0000-0000-000000000001",
          data: { items: [] },
        },
      );
      expect(res.status).toBe(201);

      expect(flowable.startInstance).toHaveBeenCalledOnce();
      const [, calledVars] = (flowable.startInstance as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        Record<string, unknown> | undefined,
      ];
      expect(calledVars).toBeDefined();
      // Empty collection → honest null (never coerced to 0); ${amount>500000} is
      // deterministically false → the gateway takes its default branch.
      expect(calledVars!["amount"]).toBe(null);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T-0606 [approval-registry-guard] Part A: on_create trigger SCOPE
// ---------------------------------------------------------------------------
// getOnCreateBinding (binding-trigger-dao.ts) previously matched an on_create
// binding on application_id ALONE — ANY registry_def sharing that
// application_id fired the SAME binding, including an engine-managed
// "Согласование" projection registry seeded alongside the application's
// primary "Заявки" registry. Migration 122 adds
// process_app_binding.trigger_registry_id: NULL = fires on create in the
// application's PRIMARY registry (first non-system registry_def by
// created_at ASC — the SAME definition process-instance-resolver.ts's Step 3
// already uses), non-NULL = fires ONLY for that exact registry_def id. These
// tests stub TWO distinct registry_def rows under one application: a
// PRIMARY (is_system=false, earlier created_at) and a SECONDARY projection
// registry (is_system=true, later created_at) — mirroring the real ТЭЛ seed
// shape (076/086: purchases is_system=false, soglasovanie stays
// is_system=true).
//
// COVERAGE HONESTY (review T-0606 F-3): the stub client below REIMPLEMENTS
// the trigger-scope match predicate in JS (a stub cannot evaluate the DAO's
// SQL text), so these unit tests pin the CALLER's plumbing (records.ts
// passes reg.id; a match/no-match verdict propagates to startInstance) and
// the OnCreateBindingRow shape — they do NOT pin the real SQL WHERE clause:
// a mutation that guts the DAO's SQL scope filter leaves them green. The
// REAL trigger-scope guarantee is pinned by the live-Postgres test
// (ci/checks/db/approval-registry-guard.db.test.ts Part A), which the
// T-0606 judge's mutation probes A and C both turn red.
// ---------------------------------------------------------------------------

const PRIMARY_REGISTRY_ID = "a7000000-0000-0000-0000-000000000002"; // mirrors ТЭЛ "purchases"
const SECONDARY_REGISTRY_ID = "a7000000-0000-0000-0000-000000000003"; // mirrors ТЭЛ "soglasovanie"
const TRIGGER_SCOPE_APP_ID = "a0000000-0000-0000-0000-000000000001";
const TRIGGER_SCOPE_TENANT_ID = "a0000000-0000-0000-0000-000000000001";

/**
 * Stub pg PoolClient for the trigger-scope tests: TWO registry_def rows
 * under one application (primary + secondary), a configurable binding row
 * (with trigger_registry_id), and a record create targeting a caller-chosen
 * registryId.
 */
function makeTriggerScopeClient(opts: {
  /** Which registry the POST /api/records call targets. */
  targetRegistryId: string;
  bindingRow: {
    id: string;
    process_key: string;
    trigger_type: string;
    start_form_key: string | null;
    field_mapping: Record<string, string>;
    submit_task_key?: string | null;
    trigger_registry_id?: string | null;
  } | null;
}) {
  const { targetRegistryId, bindingRow } = opts;

  const registries: Record<string, { id: string; application_id: string; is_system: boolean; created_at: string }> = {
    [PRIMARY_REGISTRY_ID]: {
      id: PRIMARY_REGISTRY_ID,
      application_id: TRIGGER_SCOPE_APP_ID,
      is_system: false,
      created_at: "0",
    },
    [SECONDARY_REGISTRY_ID]: {
      id: SECONDARY_REGISTRY_ID,
      application_id: TRIGGER_SCOPE_APP_ID,
      is_system: true,
      created_at: "0",
    },
  };

  const targetReg = registries[targetRegistryId];
  if (!targetReg) throw new Error(`unknown targetRegistryId in test fixture: ${targetRegistryId}`);

  const fakeRecord = {
    id: "ac000000-0000-0000-0000-000000000099",
    registry_id: targetRegistryId,
    application_id: TRIGGER_SCOPE_APP_ID,
    record_schema_version: 1,
    data: {},
    created_at: "1000",
    updated_at: "1000",
  };

  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const trimmed = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/i.test(trimmed)) {
        return { rows: [] };
      }
      if (/current_setting\s*\(\s*'choros\.tenant_id'/i.test(sql) && !/INSERT|UPDATE/i.test(sql)) {
        return { rows: [{ tenant_id: TRIGGER_SCOPE_TENANT_ID }] };
      }
      if (/INSERT INTO choros\.audit_head/i.test(sql)) return { rows: [] };
      if (/FROM choros\.audit_head/i.test(sql)) {
        return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
      }
      if (/UPDATE choros\.audit_head/i.test(sql)) return { rows: [] };
      if (/INSERT INTO choros\.audit_event/i.test(sql)) return { rows: [] };
      if (/INSERT INTO choros\.record/i.test(sql)) return { rows: [] };

      // process_app_binding SELECT (getOnCreateBinding) — MUST be checked
      // before the generic registry_def branch: this query embeds a nested
      // `FROM choros.registry_def` subquery for the NULL-fallback primary
      // registry resolution. The stub EVALUATES the same trigger-scope
      // predicate the real SQL's WHERE clause does (params[2] is the
      // registryId argument, $3 in the query): match if
      // trigger_registry_id === registryId, OR trigger_registry_id is NULL
      // AND registryId === the PRIMARY registry — else no row (mirrors a
      // real WHERE clause filtering out a non-matching row, not just
      // returning it unconditionally).
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        if (bindingRow === null || bindingRow === undefined) return { rows: [] };
        const effectiveTriggerRegistryId =
          "trigger_registry_id" in bindingRow ? (bindingRow.trigger_registry_id ?? null) : null;
        const calledRegistryId = (params ?? [])[2] as string | undefined;
        const matches =
          effectiveTriggerRegistryId !== null
            ? effectiveTriggerRegistryId === calledRegistryId
            : calledRegistryId === PRIMARY_REGISTRY_ID;
        if (!matches) return { rows: [] };
        return { rows: [{ submit_task_key: null, trigger_registry_id: null, ...bindingRow }] };
      }

      // registry_def lookups: resolveGoverningRegistryDef's own query (by id)
      // AND getOnCreateBinding's nested "primary registry" subquery
      // (is_system = false ORDER BY created_at ASC LIMIT 1). Distinguish by
      // whether the SQL text carries the is_system predicate.
      if (/FROM choros\.registry_def/i.test(sql)) {
        if (/is_system\s*=\s*false/i.test(sql)) {
          // The nested primary-registry subquery — always resolves to the
          // one PRIMARY (is_system=false) row in this fixture, regardless of
          // which registry the caller is writing into.
          return { rows: [{ id: PRIMARY_REGISTRY_ID }] };
        }
        // resolveGoverningRegistryDef: return the CALLER'S target registry.
        return {
          rows: [
            {
              id: targetReg.id,
              application_id: targetReg.application_id,
              record_schema: { type: "object", properties: {}, additionalProperties: true },
              record_schema_version: 1,
              engine_managed: targetReg.is_system, // mirrors the migration 122 seed pattern
            },
          ],
        };
      }

      if (/FROM choros\.record r/i.test(sql)) {
        return { rows: [fakeRecord] };
      }
      // Defensive: surface unexpected queries loudly (params kept for debugging).
      void params;
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

function makeTriggerScopePool(opts: Parameters<typeof makeTriggerScopeClient>[0]) {
  const client = makeTriggerScopeClient(opts);
  return {
    connect: async () => client as unknown as import("pg").PoolClient,
    _client: client,
  } as unknown as import("pg").Pool;
}

describe("T-0606 Part A: on_create trigger scope (bug #2 — phantom process spawns)", () => {
  it("create in the SECONDARY (non-primary) registry of the same application → process does NOT start", async () => {
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-t0606-a" });
    const bindingRow = {
      id: "bind-t0606-a",
      process_key: "telLinear",
      trigger_type: "on_create",
      start_form_key: null,
      field_mapping: {} as Record<string, string>,
      trigger_registry_id: null, // NULL = fires on the PRIMARY registry only
    };
    const pool = makeTriggerScopePool({ targetRegistryId: SECONDARY_REGISTRY_ID, bindingRow });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => TRIGGER_SCOPE_TENANT_ID,
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: TRIGGER_SCOPE_APP_ID,
          registry_def_id: SECONDARY_REGISTRY_ID,
          data: { decision: "approve" },
        },
      );
      // The secondary registry in this fixture is engine_managed (is_system
      // mirrors engine_managed for this seed shape) — the write-protection
      // guard (Part B) rejects the CREATE itself before on_create is even
      // reached. This is the CORRECT combined behavior (both bugs fixed
      // simultaneously protect this registry), but to isolate the TRIGGER-
      // SCOPE assertion specifically (bug #2), assert on the engine call
      // directly: even though the guard fired first (403, not 201),
      // startInstance must NEVER have been called for this registry.
      expect(res.status).toBe(403);
      expect(flowable.startInstance).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("create in the PRIMARY registry of the same application → process DOES start (regression: telLinear/purchaseApproval scenarios unaffected)", async () => {
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-t0606-b" });
    const bindingRow = {
      id: "bind-t0606-b",
      process_key: "telLinear",
      trigger_type: "on_create",
      start_form_key: null,
      field_mapping: {} as Record<string, string>,
      trigger_registry_id: null, // NULL = fires on the PRIMARY registry
    };
    const pool = makeTriggerScopePool({ targetRegistryId: PRIMARY_REGISTRY_ID, bindingRow });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => TRIGGER_SCOPE_TENANT_ID,
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: TRIGGER_SCOPE_APP_ID,
          registry_def_id: PRIMARY_REGISTRY_ID,
          data: { title: "Заявка" },
        },
      );
      expect(res.status).toBe(201);
      expect(flowable.startInstance).toHaveBeenCalledOnce();
      expect(flowable.startInstance).toHaveBeenCalledWith("telLinear", undefined);
    } finally {
      server.close();
    }
  });

  it("create in a SECONDARY registry that is NOT engine_managed still does not fire an on_create binding scoped (via NULL) to the PRIMARY registry", async () => {
    // Isolates the trigger-scope assertion from the write-protection guard
    // (Part B) by using a secondary registry that is is_system=false /
    // engine_managed=false — a plain second user registry under the same
    // application (not necessarily a "Согласование"-shaped one). The create
    // itself succeeds (201) because there is no write-protection in play,
    // but the on_create binding (NULL trigger_registry_id → primary only)
    // must still NOT fire for it.
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-t0606-c" });
    const bindingRow = {
      id: "bind-t0606-c",
      process_key: "telLinear",
      trigger_type: "on_create",
      start_form_key: null,
      field_mapping: {} as Record<string, string>,
      trigger_registry_id: null,
    };
    // Reuse the trigger-scope stub but override the secondary registry's
    // is_system/engine_managed to false via a custom targetRegistryId path:
    // we simulate this by pointing targetRegistryId at SECONDARY_REGISTRY_ID
    // but patching engine_managed off through a thin wrapper client.
    const basePool = makeTriggerScopeClient({ targetRegistryId: SECONDARY_REGISTRY_ID, bindingRow });
    const wrappedClient = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const result = await basePool.query(sql, params);
        if (/FROM choros\.registry_def/i.test(sql) && !/is_system\s*=\s*false/i.test(sql)) {
          return { rows: result.rows.map((r: Record<string, unknown>) => ({ ...r, engine_managed: false })) };
        }
        return result;
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: async () => wrappedClient as unknown as import("pg").PoolClient,
    } as unknown as import("pg").Pool;

    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => TRIGGER_SCOPE_TENANT_ID,
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        {
          application_id: TRIGGER_SCOPE_APP_ID,
          registry_def_id: SECONDARY_REGISTRY_ID,
          data: { note: "not engine-managed, just a second registry" },
        },
      );
      expect(res.status).toBe(201);
      expect(flowable.startInstance).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it("binding with explicit non-NULL trigger_registry_id pinned to the SECONDARY registry → fires for that registry, NOT the primary", async () => {
    const flowable = makeStubFlowable({ ok: true, instanceId: "inst-t0606-d" });
    const bindingRow = {
      id: "bind-t0606-d",
      process_key: "customProcess",
      trigger_type: "on_create",
      start_form_key: null,
      field_mapping: {} as Record<string, string>,
      trigger_registry_id: SECONDARY_REGISTRY_ID, // explicit pin, not the primary
    };

    // A create in the PRIMARY registry must NOT fire this binding (it's pinned elsewhere).
    const poolPrimary = makeTriggerScopePool({ targetRegistryId: PRIMARY_REGISTRY_ID, bindingRow });
    const { server: serverPrimary, baseUrl: baseUrlPrimary } = buildServer({
      pool: poolPrimary,
      resolveActorTenant: async () => TRIGGER_SCOPE_TENANT_ID,
      flowable,
    });
    await new Promise<void>((r) => serverPrimary.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrlPrimary()}/api/records`,
        { "x-dev-user": "test-actor" },
        { application_id: TRIGGER_SCOPE_APP_ID, registry_def_id: PRIMARY_REGISTRY_ID, data: {} },
      );
      expect(res.status).toBe(201);
      expect(flowable.startInstance).not.toHaveBeenCalled();
    } finally {
      serverPrimary.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T-0606 Part C (T-0604 reviewer AC-3b): submit_task_key=NULL + first live
// active user-task keyed 'task-submit' → auto-complete must still NOT fire.
// Pins the invariant "NULL = disabled, no fallback literal guess" even when
// the live task's defKey HAPPENS to equal the string a hypothetical fallback
// might have guessed.
// ---------------------------------------------------------------------------

describe("T-0606 Part C (T-0604 AC-3b bonus): submit_task_key NULL + live first task keyed 'task-submit' → completeUserTask NOT called", () => {
  it("NULL submit_task_key + first active task defKey coincidentally 'task-submit' → no auto-complete (no fallback literal guess)", async () => {
    const flowable = makeStubFlowable(
      { ok: true, instanceId: "inst-t0606-c1" },
      [
        {
          id: "engine-task-t0606-c1",
          taskDefinitionKey: "task-submit",
          name: "Подача заявки",
          candidateGroups: ["role-initiator"],
        },
      ],
    );
    const bindingRow = {
      id: "bind-t0606-c1",
      process_key: "genericProcess",
      trigger_type: "on_create",
      start_form_key: null,
      field_mapping: {} as Record<string, string>,
      submit_task_key: null, // explicit: disabled, no fallback guess
    };
    const pool = makeStubPool({ bindingRow });
    const { server, baseUrl } = buildServer({
      pool,
      resolveActorTenant: async () => "a0000000-0000-0000-0000-000000000001",
      flowable,
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await httpReq(
        "POST",
        `${baseUrl()}/api/records`,
        { "x-dev-user": "test-actor" },
        { application_id: "a0000000-0000-0000-0000-000000000001", data: {} },
      );
      expect(res.status).toBe(201);
      expect(flowable.startInstance).toHaveBeenCalledOnce();
      // The coincidental defKey match must NOT matter: NULL means "never
      // auto-complete", full stop — not "guess task-submit as a fallback".
      expect(flowable.completeUserTask).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// [DB-UNTESTED] notes
// ---------------------------------------------------------------------------
// The following require a live Postgres + migration 082 applied:
//   - getOnCreateBinding round-trip (real process_app_binding row with trigger_type='on_create')
//   - RLS isolation: binding in tenant A is invisible in tenant B's tx
//   - On_create trigger fires on POST /api/records against a real record + binding row
//   - Field_mapping projection with real jsonb column values
// These tests belong in ci/checks/db/ and are left for the server-PG pass.
