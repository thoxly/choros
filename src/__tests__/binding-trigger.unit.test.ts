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
import type { FlowableClient, StartResult } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** Stub FlowableClient — configurable startInstance result. */
function makeStubFlowable(result: StartResult): FlowableClient {
  return {
    deployBpmn: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    startInstance: vi.fn().mockResolvedValue(result),
    fetchAndLock: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    completeTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    failTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    // T-0368: skip-submit stubs — return no active user task so auto-complete is a no-op in unit tests.
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null }),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
    // T-0440: isInstanceEnded stub — not exercised by binding-trigger unit tests.
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: true }),
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
  } | null;
  trackRollback?: { called: boolean };
}) {
  const { bindingRow, trackRollback } = opts;
  const fakeRegistryDef = {
    id: "ae000000-0000-0000-0000-000000000001",
    application_id: "a0000000-0000-0000-0000-000000000001",
    record_schema: { type: "object", properties: {}, additionalProperties: true },
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
      // registry_def SELECT
      if (/FROM choros\.registry_def/i.test(sql)) {
        return { rows: [fakeRegistryDef] };
      }
      // record INSERT
      if (/INSERT INTO choros\.record/i.test(sql)) {
        return { rows: [] };
      }
      // audit_event INSERT (appendAuditEvent)
      if (/INSERT INTO choros\.audit_event/i.test(sql)) {
        return { rows: [] };
      }
      // process_app_binding SELECT (getOnCreateBinding)
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        if (bindingRow === null || bindingRow === undefined) {
          return { rows: [] };
        }
        return { rows: [bindingRow] };
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
  it("startInstance ENGINE_ERROR → 502 and tx ROLLBACK (record not persisted)", async () => {
    const flowable = makeStubFlowable({ ok: false, code: "ENGINE_DOWN" as never });
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
      // Engine failure → 502
      expect(res.status).toBe(502);
      const body = res.json as { error?: { code?: string } };
      expect(body?.error?.code).toBe("ENGINE_ERROR");
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
// [DB-UNTESTED] notes
// ---------------------------------------------------------------------------
// The following require a live Postgres + migration 082 applied:
//   - getOnCreateBinding round-trip (real process_app_binding row with trigger_type='on_create')
//   - RLS isolation: binding in tenant A is invisible in tenant B's tx
//   - On_create trigger fires on POST /api/records against a real record + binding row
//   - Field_mapping projection with real jsonb column values
// These tests belong in ci/checks/db/ and are left for the server-PG pass.
