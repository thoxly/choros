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
  registerProcessDefsRoutes(router, pool, flowable);
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
const AUTH_HEADERS = { "x-dev-user": "alice", "x-tenant-id": TENANT_ID };

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
    const r = await httpReq("POST", `${base}/api/process-defs`, { "x-tenant-id": TENANT_ID }, {
      processKey: "k", name: "N", bpmnXml: CLEAN_BPMN,
    });
    expect(r.status).toBe(401);
  });

  it("POST /api/process-defs/:key/publish → 401", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs/myKey/publish`, { "x-tenant-id": TENANT_ID });
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

  it("returns 400 when processKey is missing", async () => {
    const r = await httpReq("POST", `${base}/api/process-defs`, AUTH_HEADERS, {
      name: "N", bpmnXml: CLEAN_BPMN,
    });
    expect(r.status).toBe(400);
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
    const r = await httpReq("GET", `${base}/api/process-defs`, { "x-tenant-id": TENANT_ID });
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
    const r = await httpReq("GET", `${base}/api/process-defs/myKey`, { "x-tenant-id": TENANT_ID });
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    expect(body["processKey"]).toBe("myKey");
    expect(body["status"]).toBe("draft");
    expect(typeof body["bpmnXml"]).toBe("string");
  });

  it("returns 404 for unknown key", async () => {
    const r = await httpReq("GET", `${base}/api/process-defs/unknown-key`, { "x-tenant-id": TENANT_ID });
    expect(r.status).toBe(404);
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
