/**
 * T-0252 · process-defs HTTP route unit tests
 *
 * Pure unit — no live Postgres, no live Flowable.
 * Covers:
 *   - POST /api/process-defs upserts a draft (201)
 *   - GET  /api/process-defs lists definitions (200)
 *   - GET  /api/process-defs/:key gets latest (200 / 404)
 *   - POST /api/process-defs/:key/publish rejects unlintable BPMN (422 with violations)
 *   - POST /api/process-defs/:key/publish accepts clean BPMN, calls deployBpmn,
 *     persists deployment_id (200 with deploymentId)
 *   - POST /api/process-defs routes return 401 when x-dev-user is absent
 *   - POST /api/process-defs/:key/publish returns 401 when x-dev-user is absent
 *
 * Live-Flowable round-trips (deployBpmn against a real engine) are gated behind
 * FLOWABLE_INTEGRATION=1 — see flowable-client.integration.test.ts.
 * This file uses a stub FlowableClient so no live engine is required.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerProcessDefsRoutes } from "../http/process-defs.js";
import type { FlowableClient, DeployResult } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// Minimal BPMN fixtures
// ---------------------------------------------------------------------------

/** Well-formed BPMN that passes lintBpmn (no raw-object bindings). */
const CLEAN_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             targetNamespace="http://flowable.org/test">
  <process id="testProcess" name="Test Process" isExecutable="true">
    <startEvent id="start"/>
    <endEvent id="end"/>
    <sequenceFlow id="flow1" sourceRef="start" targetRef="end"/>
  </process>
</definitions>`;

/** BPMN that fails lintBpmn — contains a raw-object binding (registryId key). */
const UNLINTABLE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="http://flowable.org/test">
  <process id="badProcess" name="Bad Process" isExecutable="true">
    <serviceTask id="task1" name="Bad Task" activiti:delegateExpression="${'$'}{someBean}">
      <extensionElements>
        <activiti:field name="payload" stringValue='{"registryId":"r1","recordId":"rec1","data":{}}'/>
      </extensionElements>
    </serviceTask>
  </process>
</definitions>`;

// ---------------------------------------------------------------------------
// Stub FlowableClient
// ---------------------------------------------------------------------------

function makeStubFlowableClient(deployResult: DeployResult): FlowableClient {
  return {
    deployBpmn: vi.fn().mockResolvedValue(deployResult),
    startInstance: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    fetchAndLock: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    completeTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    failTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    // T-0368: skip-submit stubs — not exercised by process-defs tests.
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null }),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
    // T-0443: engine-reconcile stubs — not exercised by process-defs tests.
    getActiveUserTasks: vi.fn().mockResolvedValue({ ok: true, tasks: [] }),
    getMessageCatchWaits: vi.fn().mockResolvedValue({ ok: true, waits: [] }),
    correlateMessage: vi.fn().mockResolvedValue({ ok: true }),
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
  };
}

// ---------------------------------------------------------------------------
// In-memory DB mock (mirrors the process_definition schema)
// ---------------------------------------------------------------------------

interface DefRecord {
  tenant_id: string;
  id: string;
  process_key: string;
  name: string;
  bpmn_xml: string;
  version: number;
  status: string;
  deployment_id: string | null;
  created_at: number;
  updated_at: number;
}

function makeMemoryPool(rows: DefRecord[] = []): import("pg").Pool {
  const store: DefRecord[] = [...rows];

  const fakeClient = {
    query: async (sql: string, params?: unknown[]) => {
      const s = sql.trim().replace(/\s+/g, " ");

      // BEGIN / COMMIT / ROLLBACK / SET LOCAL
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s)) return { rows: [] };
      if (/^SET LOCAL/i.test(s)) return { rows: [] };

      // INSERT
      if (/^INSERT INTO choros\.process_definition/i.test(s)) {
        const p = params as [string, string, string, string, string, number, number];
        store.push({
          tenant_id: p[0]!, id: p[1]!, process_key: p[2]!, name: p[3]!,
          bpmn_xml: p[4]!, version: p[5]!, status: "draft",
          deployment_id: null, created_at: p[6]!, updated_at: p[6]!,
        });
        return { rows: [] };
      }

      // UPDATE status='published'
      if (/^UPDATE choros\.process_definition/i.test(s)) {
        const p = params as [string, number, string, string];
        const idx = store.findIndex((r) => r.tenant_id === p[2] && r.id === p[3]);
        if (idx >= 0) {
          store[idx]!.status = "published";
          store[idx]!.deployment_id = p[0]!;
          store[idx]!.updated_at = p[1]!;
        }
        return { rows: [] };
      }

      // SELECT latest version by process_key
      if (/SELECT.*FROM choros\.process_definition.*ORDER BY version DESC.*LIMIT 1/is.test(s)) {
        const p = params as [string, string];
        const matching = store
          .filter((r) => r.tenant_id === p[0] && r.process_key === p[1])
          .sort((a, b) => b.version - a.version);
        return { rows: matching.slice(0, 1) };
      }

      // SELECT DISTINCT ON (process_key) — list all
      if (/SELECT DISTINCT ON \(process_key\)/is.test(s)) {
        const p = params as [string];
        const byKey = new Map<string, DefRecord>();
        for (const r of store.filter((r) => r.tenant_id === p[0]).sort((a, b) => b.version - a.version)) {
          if (!byKey.has(r.process_key)) byKey.set(r.process_key, r);
        }
        return { rows: Array.from(byKey.values()) };
      }

      return { rows: [] };
    },
    release: () => {},
  };

  return {
    connect: async () => fakeClient as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// HTTP test harness
// ---------------------------------------------------------------------------

function buildServer(
  pool: import("pg").Pool,
  flowable: FlowableClient,
): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  // T-0468 [SECURITY]: tenant is resolved from the actor's identity, not an
  // x-tenant-id header. The resolver maps the dev-user actor → TENANT_ID so the
  // tenant-scoped store rows (seeded under TENANT_ID) are reachable.
  registerProcessDefsRoutes(router, pool, flowable, async () => TENANT_ID);
  const server = http.createServer((req, res) => {
    router.dispatch(req, res);
  });
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
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(buf
          ? { "Content-Type": "application/json", "Content-Length": String(buf.length) }
          : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, json: { raw: data } }); }
      });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
// T-0468 [SECURITY]: auth is the dev-user identity ALONE. The tenant is resolved
// from that identity by the injected resolver (→ TENANT_ID), NOT from any header.
// No x-tenant-id is sent — proving the route no longer reads a client tenant header.
const AUTH_HEADERS = { "x-dev-user": "alice" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("process-defs: module export", () => {
  it("exports registerProcessDefsRoutes", async () => {
    const mod = await import("../http/process-defs.js");
    expect(typeof mod.registerProcessDefsRoutes).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 401 — auth gate (missing x-dev-user)
// ---------------------------------------------------------------------------

describe("process-defs: 401 without x-dev-user", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const pool = makeMemoryPool();
    const flowable = makeStubFlowableClient({ ok: true, deploymentId: "dep-1" });
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("POST /api/process-defs → 401", async () => {
    // No x-dev-user → 401 (dev-mode identity gate). No tenant header is involved.
    const r = await httpReq("POST", `${base}/api/process-defs`, {}, {
      processKey: "k", name: "N", bpmnXml: CLEAN_BPMN,
    });
    expect(r.status).toBe(401);
  });

  it("POST /api/process-defs/:key/publish → 401", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs/myKey/publish`, {});
    expect(r.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Draft upsert (POST /api/process-defs)
// ---------------------------------------------------------------------------

describe("process-defs: POST /api/process-defs — upsert draft", () => {
  let server: http.Server;
  let base: string;
  const pool = makeMemoryPool();
  const flowable = makeStubFlowableClient({ ok: true, deploymentId: "dep-x" });

  beforeAll(async () => {
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("returns 201 with id/processKey/version/status on success", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs`, AUTH_HEADERS, {
      processKey: "myProcess", name: "My Process", bpmnXml: CLEAN_BPMN,
    });
    expect(r.status).toBe(201);
    const body = r.json as Record<string, unknown>;
    expect(typeof body["id"]).toBe("string");
    expect(body["processKey"]).toBe("myProcess");
    expect(body["version"]).toBe(1);
    expect(body["status"]).toBe("draft");
  });

  it("auto-assigns key (201) when processKey is omitted — T-0377 (B19)", async () => {
    // processKey is now OPTIONAL — backend auto-generates slug from name.
    const r = await httpReq("POST", `${base}/api/process-defs`, AUTH_HEADERS, {
      name: "N", bpmnXml: CLEAN_BPMN,
    });
    // Must succeed, not 400
    expect(r.status).toBe(201);
    const body = r.json as Record<string, unknown>;
    expect(typeof body["processKey"]).toBe("string");
    expect(body["assignedKey"]).toBe(body["processKey"]);
  });

  it("returns 400 when bpmnXml is missing", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs`, AUTH_HEADERS, {
      processKey: "k", name: "N",
    });
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// List (GET /api/process-defs)
// ---------------------------------------------------------------------------

describe("process-defs: GET /api/process-defs — list", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const pool = makeMemoryPool([
      {
        tenant_id: TENANT_ID, id: "aaaa-0001-0001-0001-000000000001",
        process_key: "proc1", name: "Proc 1", bpmn_xml: CLEAN_BPMN,
        version: 1, status: "draft", deployment_id: null,
        created_at: 1000, updated_at: 1000,
      },
    ]);
    const flowable = makeStubFlowableClient({ ok: true, deploymentId: "dep-x" });
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("returns 200 with items array", async () => {
    const r = await httpReq("GET", `${base}/api/process-defs`, AUTH_HEADERS);
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(Array.isArray(body["items"])).toBe(true);
    const items = body["items"] as unknown[];
    expect(items.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Get by key (GET /api/process-defs/:key)
// ---------------------------------------------------------------------------

describe("process-defs: GET /api/process-defs/:key", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const pool = makeMemoryPool([
      {
        tenant_id: TENANT_ID, id: "bbbb-0001-0001-0001-000000000001",
        process_key: "myKey", name: "My Key", bpmn_xml: CLEAN_BPMN,
        version: 1, status: "draft", deployment_id: null,
        created_at: 1000, updated_at: 1000,
      },
    ]);
    const flowable = makeStubFlowableClient({ ok: true, deploymentId: "dep-x" });
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("returns 200 with definition when found", async () => {
    const r = await httpReq("GET", `${base}/api/process-defs/myKey`, AUTH_HEADERS);
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["processKey"]).toBe("myKey");
    expect(body["status"]).toBe("draft");
    expect(typeof body["bpmnXml"]).toBe("string");
  });

  it("returns 404 for unknown key", async () => {
    const r = await httpReq("GET", `${base}/api/process-defs/unknown-key`, AUTH_HEADERS);
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// T-0468 [SECURITY]: a forged x-tenant-id header must NOT change the tenant.
// The tenant is resolved from the actor's IDENTITY. A caller in tenant A who
// presents x-tenant-id naming tenant B sees ONLY tenant A's rows; tenant B's
// process_definition rows are never read or written through the forged header.
// ---------------------------------------------------------------------------

describe("process-defs T-0468: x-tenant-id header is ignored — tenant from identity", () => {
  const TENANT_A = "11111111-1111-1111-1111-111111111111"; // == TENANT_ID; actor's real tenant
  const TENANT_B = "22222222-2222-2222-2222-222222222222"; // a foreign tenant the attacker names

  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    // Store has ONE row in tenant A and ONE row in tenant B.
    const pool = makeMemoryPool([
      {
        tenant_id: TENANT_A, id: "a11a-0001-0001-0001-000000000001",
        process_key: "ownProc", name: "Own Proc", bpmn_xml: CLEAN_BPMN,
        version: 1, status: "draft", deployment_id: null,
        created_at: 1000, updated_at: 1000,
      },
      {
        tenant_id: TENANT_B, id: "b22b-0001-0001-0001-000000000001",
        process_key: "foreignProc", name: "Foreign Proc", bpmn_xml: CLEAN_BPMN,
        version: 1, status: "draft", deployment_id: null,
        created_at: 1000, updated_at: 1000,
      },
    ]);
    const flowable = makeStubFlowableClient({ ok: true, deploymentId: "dep-sec" });
    const router = new Router();
    // The actor ALWAYS resolves to tenant A, regardless of any request header.
    registerProcessDefsRoutes(router, pool, flowable, async () => TENANT_A);
    server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((r) =>
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        base = `http://127.0.0.1:${addr.port}`;
        r();
      }),
    );
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("GET list with forged x-tenant-id=B returns ONLY tenant A's definitions", async () => {
    const r = await httpReq("GET", `${base}/api/process-defs`, {
      "x-dev-user": "alice",
      "x-tenant-id": TENANT_B, // forged — must be ignored
    });
    expect(r.status).toBe(200);
    const items = (r.json as Record<string, unknown>)["items"] as Array<Record<string, unknown>>;
    const keys = items.map((i) => i["processKey"]);
    expect(keys).toContain("ownProc");
    expect(keys).not.toContain("foreignProc"); // tenant B's row is NOT leaked
  });

  it("GET :key for tenant B's process via forged header → 404 (not in actor's tenant)", async () => {
    const r = await httpReq("GET", `${base}/api/process-defs/foreignProc`, {
      "x-dev-user": "alice",
      "x-tenant-id": TENANT_B, // forged — must be ignored
    });
    expect(r.status).toBe(404);
  });

  it("POST write with forged x-tenant-id=B persists under tenant A (identity), not B", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs`, {
      "x-dev-user": "alice",
      "x-tenant-id": TENANT_B, // forged — must be ignored
    }, { processKey: "writeProbe", name: "Write Probe", bpmnXml: CLEAN_BPMN });
    expect(r.status).toBe(201);
    // Read it back WITHOUT any tenant header — identity-scoped to A — it must exist.
    const back = await httpReq("GET", `${base}/api/process-defs/writeProbe`, { "x-dev-user": "alice" });
    expect(back.status).toBe(200);
    expect((back.json as Record<string, unknown>)["processKey"]).toBe("writeProbe");
  });
});

// ---------------------------------------------------------------------------
// Publish — 422 on unlintable BPMN
// ---------------------------------------------------------------------------

describe("process-defs: POST /api/process-defs/:key/publish — 422 on bad BPMN", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const pool = makeMemoryPool([
      {
        tenant_id: TENANT_ID, id: "cccc-0001-0001-0001-000000000001",
        process_key: "badKey", name: "Bad", bpmn_xml: UNLINTABLE_BPMN,
        version: 1, status: "draft", deployment_id: null,
        created_at: 1000, updated_at: 1000,
      },
    ]);
    const flowable = makeStubFlowableClient({ ok: true, deploymentId: "should-not-reach" });
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("returns 422 with violations", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs/badKey/publish`, AUTH_HEADERS);
    expect(r.status).toBe(422);
    const body = r.json as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("BPMN_LINT_FAILED");
    expect(Array.isArray(err["violations"])).toBe(true);
    expect((err["violations"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("does NOT call deployBpmn when lint fails", async () => {
    const pool2 = makeMemoryPool([
      {
        tenant_id: TENANT_ID, id: "cccc-0002-0002-0002-000000000002",
        process_key: "badKey2", name: "Bad2", bpmn_xml: UNLINTABLE_BPMN,
        version: 1, status: "draft", deployment_id: null,
        created_at: 1000, updated_at: 1000,
      },
    ]);
    const flowable2 = makeStubFlowableClient({ ok: true, deploymentId: "should-not-call" });
    const h2 = buildServer(pool2, flowable2);
    const server2 = h2.server;
    await new Promise<void>((r) => server2.listen(0, "127.0.0.1", () => r()));
    const base2 = h2.baseUrl();

    try {
      await httpReq("POST", `${base2}/api/process-defs/badKey2/publish`, AUTH_HEADERS);
      expect(vi.mocked(flowable2.deployBpmn)).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// Publish — success: accepts clean BPMN, persists deployment_id
// ---------------------------------------------------------------------------

describe("process-defs: POST /api/process-defs/:key/publish — success path", () => {
  let server: http.Server;
  let base: string;
  let flowable: FlowableClient;

  beforeAll(async () => {
    const pool = makeMemoryPool([
      {
        tenant_id: TENANT_ID, id: "dddd-0001-0001-0001-000000000001",
        process_key: "cleanKey", name: "Clean", bpmn_xml: CLEAN_BPMN,
        version: 1, status: "draft", deployment_id: null,
        created_at: 1000, updated_at: 1000,
      },
    ]);
    flowable = makeStubFlowableClient({ ok: true, deploymentId: "deployment-abc-123" });
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("returns 200 with deploymentId when BPMN is clean", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs/cleanKey/publish`, AUTH_HEADERS);
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["status"]).toBe("published");
    expect(body["deploymentId"]).toBe("deployment-abc-123");
    expect(body["processKey"]).toBe("cleanKey");
  });

  it("called deployBpmn exactly once", async () => {
    expect(vi.mocked(flowable.deployBpmn)).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for unknown key", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs/no-such-key/publish`, AUTH_HEADERS);
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// T-0483: publish surfaces a CLEAR, TYPED ENGINE_UNAVAILABLE error (503) when the
// engine is unreachable — NOT an opaque "502 ENGINE_ERROR deployBpmn failed: ...".
// The diagram MUST stay a draft (no status flip to published).
// ---------------------------------------------------------------------------

describe("process-defs T-0483: POST /publish — engine unavailable → 503 ENGINE_UNAVAILABLE", () => {
  let server: http.Server;
  let base: string;
  let flowable: FlowableClient;

  beforeAll(async () => {
    const pool = makeMemoryPool([
      {
        tenant_id: TENANT_ID, id: "dddd-0001-0001-0001-000000000099",
        process_key: "engineDownKey", name: "EngineDown", bpmn_xml: CLEAN_BPMN,
        version: 1, status: "draft", deployment_id: null,
        created_at: 1000, updated_at: 1000,
      },
    ]);
    // Engine unreachable: deployBpmn returns ENGINE_UNAVAILABLE (5xx after retries).
    flowable = makeStubFlowableClient({ ok: false, code: "ENGINE_UNAVAILABLE" });
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("returns 503 with typed code ENGINE_UNAVAILABLE and an honest message", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs/engineDownKey/publish`, AUTH_HEADERS);
    expect(r.status).toBe(503);
    const body = r.json as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("ENGINE_UNAVAILABLE");
    expect(String(err["message"])).toContain("Движок процессов недоступен");
    // Must NOT report the diagram as published.
    expect(JSON.stringify(body)).not.toContain("published");
  });
});

// ---------------------------------------------------------------------------
// T-0377 (B19): Auto-key assignment — POST /api/process-defs without processKey
// ---------------------------------------------------------------------------

describe("process-defs T-0377: auto-key assignment when processKey is absent", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const pool = makeMemoryPool(); // empty store
    const flowable = makeStubFlowableClient({ ok: true, deploymentId: "dep-autokey" });
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("assigns a slug-based key when processKey is omitted", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs`, AUTH_HEADERS, {
      // processKey intentionally absent — T-0377 new-process path
      name: "Согласование заявки",
      bpmnXml: CLEAN_BPMN,
    });
    expect(r.status).toBe(201);
    const body = r.json as Record<string, unknown>;
    // Backend must assign a key from the Cyrillic name
    expect(typeof body["processKey"]).toBe("string");
    expect(body["processKey"]).toBeTruthy();
    // assignedKey must be present and equal processKey
    expect(body["assignedKey"]).toBe(body["processKey"]);
    // Slug should be derived from the name (Cyrillic → latin)
    expect(body["processKey"]).toMatch(/^[a-z0-9-]+$/);
    expect(body["version"]).toBe(1);
    expect(body["status"]).toBe("draft");
  });

  it("assigns a Latin slug for a Latin name when processKey is omitted", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs`, AUTH_HEADERS, {
      name: "Invoice Approval",
      bpmnXml: CLEAN_BPMN,
    });
    expect(r.status).toBe(201);
    const body = r.json as Record<string, unknown>;
    expect(body["processKey"]).toBe("invoice-approval");
    expect(body["assignedKey"]).toBe("invoice-approval");
  });

  it("still accepts explicit processKey (backwards-compatible)", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs`, AUTH_HEADERS, {
      processKey: "explicit-key",
      name: "Explicit Key Process",
      bpmnXml: CLEAN_BPMN,
    });
    expect(r.status).toBe(201);
    const body = r.json as Record<string, unknown>;
    expect(body["processKey"]).toBe("explicit-key");
    expect(body["assignedKey"]).toBe("explicit-key");
  });
});

// ---------------------------------------------------------------------------
// T-0377 (B19): Collision handling — duplicate slug gets a numeric suffix
// ---------------------------------------------------------------------------

describe("process-defs T-0377: collision-safe slug — suffix on conflict", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    // Pre-seed: "invoice-approval" already exists so the second save must get "-2"
    const pool = makeMemoryPool([
      {
        tenant_id: TENANT_ID, id: "eeee-0001-0001-0001-000000000001",
        process_key: "invoice-approval", name: "Invoice Approval", bpmn_xml: CLEAN_BPMN,
        version: 1, status: "draft", deployment_id: null,
        created_at: 1000, updated_at: 1000,
      },
    ]);
    const flowable = makeStubFlowableClient({ ok: true, deploymentId: "dep-coll" });
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("appends -2 when base slug is taken", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs`, AUTH_HEADERS, {
      name: "Invoice Approval",
      bpmnXml: CLEAN_BPMN,
    });
    expect(r.status).toBe(201);
    const body = r.json as Record<string, unknown>;
    expect(body["processKey"]).toBe("invoice-approval-2");
    expect(body["assignedKey"]).toBe("invoice-approval-2");
  });
});

// ---------------------------------------------------------------------------
// T-0377 (B19): slugifyProcessName unit — pure function, no HTTP
// ---------------------------------------------------------------------------

import { slugifyProcessName, generateUniqueProcessKey } from "../core/slugify-process-key.js";

describe("slugifyProcessName (T-0377)", () => {
  it("converts Cyrillic to latin slug", () => {
    expect(slugifyProcessName("Согласование заявки")).toBe("soglasovanie-zayavki");
  });

  it("converts Latin name to dash-slug", () => {
    expect(slugifyProcessName("Invoice Approval")).toBe("invoice-approval");
  });

  it("collapses multiple spaces/dashes", () => {
    // "Приём" → п=p, р=r, и=i, ё=e (maps to 'e' per Cyrillic map), м=m → "priem"
    // "Заявки" → з=z, а=a, я=ya, в=v, к=k, и=i → "zayavki"
    expect(slugifyProcessName("Приём  Заявки")).toBe("priem-zayavki");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugifyProcessName("  --Test--  ")).toBe("test");
  });

  it("returns 'process' for empty / whitespace input", () => {
    expect(slugifyProcessName("")).toBe("process");
    expect(slugifyProcessName("   ")).toBe("process");
  });

  it("truncates to 60 chars max", () => {
    const long = "A".repeat(100);
    expect(slugifyProcessName(long).length).toBeLessThanOrEqual(60);
  });
});

describe("generateUniqueProcessKey (T-0377)", () => {
  it("returns base slug when no collision", async () => {
    const key = await generateUniqueProcessKey("Договор", async () => false);
    expect(key).toBe("dogovor");
  });

  it("appends -2 on first collision", async () => {
    let calls = 0;
    const key = await generateUniqueProcessKey("Договор", async () => {
      calls++;
      return calls === 1; // first call (base) → taken; second call → free
    });
    expect(key).toBe("dogovor-2");
  });

  it("appends -3 when both base and -2 are taken", async () => {
    let calls = 0;
    const key = await generateUniqueProcessKey("Договор", async () => {
      calls++;
      return calls <= 2; // base and -2 taken; -3 free
    });
    expect(key).toBe("dogovor-3");
  });

  it("falls back to uuid suffix when 1–10 are all taken", async () => {
    // Always return true (all taken) for 11 calls, then free
    let calls = 0;
    const key = await generateUniqueProcessKey("Договор", async () => {
      calls++;
      return calls <= 11;
    });
    // Should contain the base slug + a uuid-derived suffix
    expect(key).toMatch(/^dogovor(-\S+)?$/);
    expect(key).not.toBe("dogovor"); // must not be plain base
    expect(key.length).toBeGreaterThan("dogovor".length);
  });
});

// ---------------------------------------------------------------------------
// T-0436: gateway_rule_mismatch — HTTP 422 from publish endpoint
// ---------------------------------------------------------------------------

/**
 * BPMN with an exclusiveGateway that uses choros:routingVar = "approvalRequired"
 * and two conditioned outgoing flows: "yes" and "no".
 */
const GATEWAY_BPMN_WITH_ROUTING_VAR = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:choros="http://choros.io/bpmn"
             targetNamespace="http://flowable.org/test">
  <process id="gatewayProcess" name="Gateway Process" isExecutable="true">
    <startEvent id="start"/>
    <exclusiveGateway id="gw1" routingVar="approvalRequired"/>
    <endEvent id="end1"/>
    <endEvent id="end2"/>
    <sequenceFlow id="f0" sourceRef="start" targetRef="gw1"/>
    <sequenceFlow id="f1" sourceRef="gw1" targetRef="end1">
      <conditionExpression>\${approvalRequired == 'yes'}</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f2" sourceRef="gw1" targetRef="end2">
      <conditionExpression>\${approvalRequired == 'no'}</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;

/**
 * A serialized DmnRuleTable definition blob for use in fake dmn_rule_table rows.
 * This table sets routing outcome "approvalRequired" to either "yes" or "no".
 */
const COHERENT_RULE_TABLE_DEFINITION = JSON.stringify({
  id: "rt-coherent-1",
  name: "Approval routing",
  hitPolicy: "FIRST",
  rules: [
    { conditions: [], effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "yes" }] },
    { conditions: [], effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "no" }] },
  ],
});

/**
 * A rule table definition that ONLY covers "yes" — missing "no". This will
 * cause a gateway_rule_mismatch violation for the BPMN above.
 */
const INCOHERENT_RULE_TABLE_DEFINITION = JSON.stringify({
  id: "rt-incoherent-1",
  name: "Partial approval routing",
  hitPolicy: "FIRST",
  rules: [
    { conditions: [], effects: [{ kind: "set_routing_outcome", name: "approvalRequired", value: "yes" }] },
  ],
});

/**
 * Make a memory pool that serves process_definition rows AND dmn_rule_table rows.
 * The `ruleTableDefinition` (stringified JSON) is returned for dmn_rule_table queries.
 * Pass `null` to simulate no published rule tables (empty dmn_rule_table result).
 */
function makeMemoryPoolWithRuleTables(
  processDefs: DefRecord[],
  ruleTableDefinition: string | null,
): import("pg").Pool {
  const store: DefRecord[] = [...processDefs];

  const fakeClient = {
    query: async (sql: string, params?: unknown[]) => {
      const s = sql.trim().replace(/\s+/g, " ");

      // BEGIN / COMMIT / ROLLBACK / SET LOCAL
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s)) return { rows: [] };
      if (/^SET LOCAL/i.test(s)) return { rows: [] };

      // INSERT
      if (/^INSERT INTO choros\.process_definition/i.test(s)) {
        const p = params as [string, string, string, string, string, number, number];
        store.push({
          tenant_id: p[0]!, id: p[1]!, process_key: p[2]!, name: p[3]!,
          bpmn_xml: p[4]!, version: p[5]!, status: "draft",
          deployment_id: null, created_at: p[6]!, updated_at: p[6]!,
        });
        return { rows: [] };
      }

      // UPDATE status='published'
      if (/^UPDATE choros\.process_definition/i.test(s)) {
        const p = params as [string, number, string, string];
        const idx = store.findIndex((r) => r.tenant_id === p[2] && r.id === p[3]);
        if (idx >= 0) {
          store[idx]!.status = "published";
          store[idx]!.deployment_id = p[0]!;
          store[idx]!.updated_at = p[1]!;
        }
        return { rows: [] };
      }

      // SELECT latest version by process_key
      if (/SELECT.*FROM choros\.process_definition.*ORDER BY version DESC.*LIMIT 1/is.test(s)) {
        const p = params as [string, string];
        const matching = store
          .filter((r) => r.tenant_id === p[0] && r.process_key === p[1])
          .sort((a, b) => b.version - a.version);
        return { rows: matching.slice(0, 1) };
      }

      // SELECT DISTINCT ON (process_key) — list all
      if (/SELECT DISTINCT ON \(process_key\)/is.test(s)) {
        const p = params as [string];
        const byKey = new Map<string, DefRecord>();
        for (const r of store.filter((r) => r.tenant_id === p[0]).sort((a, b) => b.version - a.version)) {
          if (!byKey.has(r.process_key)) byKey.set(r.process_key, r);
        }
        return { rows: Array.from(byKey.values()) };
      }

      // SELECT dmn_rule_table rows (called by loadPublishedRuleTables at publish)
      if (/FROM choros\.dmn_rule_table/i.test(s)) {
        if (ruleTableDefinition === null) return { rows: [] };
        // Return one published rule table row
        return {
          rows: [{
            id: "rt-test-uuid-1111-1111-1111-111111111111",
            name: "Test rule table",
            definition: JSON.parse(ruleTableDefinition),
            process_def_id: null,
            status: "published",
            updated_at: 1000000,
          }],
        };
      }

      return { rows: [] };
    },
    release: () => {},
  };

  return {
    connect: async () => fakeClient as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

describe("T-0436: process-defs publish — gateway_rule_mismatch 422 (HTTP level)", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const pool = makeMemoryPoolWithRuleTables(
      [
        {
          tenant_id: TENANT_ID,
          id: "ffff-0001-0001-0001-000000000001",
          process_key: "gatewayProc",
          name: "Gateway Process",
          bpmn_xml: GATEWAY_BPMN_WITH_ROUTING_VAR,
          version: 1,
          status: "draft",
          deployment_id: null,
          created_at: 1000,
          updated_at: 1000,
        },
      ],
      INCOHERENT_RULE_TABLE_DEFINITION, // "no" literal missing → mismatch
    );
    const flowable = makeStubFlowableClient({ ok: true, deploymentId: "should-not-reach" });
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("returns 422 with gateway_rule_mismatch when table doesn't cover all branch literals", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs/gatewayProc/publish`, AUTH_HEADERS);
    expect(r.status).toBe(422);
    const body = r.json as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("BPMN_LINT_FAILED");
    const violations = err["violations"] as Array<Record<string, unknown>>;
    expect(Array.isArray(violations)).toBe(true);
    const mismatch = violations.find((v) => v["type"] === "gateway_rule_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.["elementKind"]).toBe("exclusiveGateway");
    expect(typeof mismatch?.["message"]).toBe("string");
  });
});

describe("T-0436: process-defs publish — coherent gateway → 200 (HTTP level)", () => {
  let server: http.Server;
  let base: string;
  let flowable: FlowableClient;

  beforeAll(async () => {
    const pool = makeMemoryPoolWithRuleTables(
      [
        {
          tenant_id: TENANT_ID,
          id: "aaaa-1111-1111-1111-000000000001",
          process_key: "coherentGateway",
          name: "Coherent Gateway Process",
          bpmn_xml: GATEWAY_BPMN_WITH_ROUTING_VAR,
          version: 1,
          status: "draft",
          deployment_id: null,
          created_at: 1000,
          updated_at: 1000,
        },
      ],
      COHERENT_RULE_TABLE_DEFINITION, // covers both "yes" and "no" → coherent
    );
    flowable = makeStubFlowableClient({ ok: true, deploymentId: "deployment-gateway-ok" });
    const h = buildServer(pool, flowable);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("returns 200 when gateway routingVar matches table outcomes covering all branch literals", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs/coherentGateway/publish`, AUTH_HEADERS);
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["status"]).toBe("published");
    expect(body["deploymentId"]).toBe("deployment-gateway-ok");
  });
});
