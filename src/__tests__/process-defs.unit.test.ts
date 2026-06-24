/**
 * src/__tests__/process-defs.unit.test.ts
 * T-0324: Unit tests for process-defs route handlers — NO ambient DATABASE_URL.
 *
 * Tests the route registration and request-handling logic using a fake pg.Pool
 * that never opens a real connection. Covers:
 *   - extractActor: rejects missing x-dev-user with 401
 *   - extractTenantId: rejects missing x-tenant-id with 400
 *   - GET /api/process-defs/:key returns 404 when DB row absent
 *   - GET /api/process-defs/:key returns 200 + bpmnXml when row found
 *   - POST /api/process-defs validates required fields
 *   - POST /api/process-defs/:key/publish calls lint + deployBpmn + persists
 */

// Test doubles (router/pool/req/res stubs) are cast to the real signatures via
// `as any`; matches the repo convention for unit tests (inbox-action.test.ts et al.).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerProcessDefsRoutes } from "../http/process-defs.js";
import type { FlowableClient } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// Minimal router stub — captures registered handlers so tests can invoke them.
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

function makeRouter() {
  const routes: Array<{ method: string; path: string; handler: Handler }> = [];
  return {
    register(method: string, path: string, handler: Handler) {
      routes.push({ method, path, handler });
    },
    find(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
      for (const route of routes) {
        if (route.method !== method) continue;
        // Match static path or param path like /api/process-defs/:key
        const routeParts = route.path.split("/");
        const pathParts = path.split("/");
        if (routeParts.length !== pathParts.length) continue;
        const params: Record<string, string> = {};
        let match = true;
        for (let i = 0; i < routeParts.length; i++) {
          if (routeParts[i]!.startsWith(":")) {
            params[routeParts[i]!.slice(1)] = pathParts[i]!;
          } else if (routeParts[i] !== pathParts[i]) {
            match = false;
            break;
          }
        }
        if (match) return { handler: route.handler, params };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal fake pg.Pool — returns scripted row sets without real DB.
// ---------------------------------------------------------------------------

function makePool(queryResponder: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  return {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation(queryResponder),
      release: vi.fn(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake FlowableClient
// ---------------------------------------------------------------------------

function makeFlowable(overrides: Partial<FlowableClient> = {}): FlowableClient {
  return {
    startInstance: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    fetchAndLock: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    completeTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    failTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    deployBpmn: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    // T-0368: skip-submit stubs — not exercised by process-defs tests.
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null }),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
    // T-0443: engine-reconcile stubs — not exercised by process-defs tests.
    getActiveUserTasks: vi.fn().mockResolvedValue({ ok: true, tasks: [] }),
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Minimal fake IncomingMessage / ServerResponse helpers.
// ---------------------------------------------------------------------------

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const DEV_USER  = "alice";

function makeReq(overrides: {
  headers?: Record<string, string>;
  body?: string;
} = {}): IncomingMessage {
  const headers = {
    "x-dev-user": DEV_USER,
    "x-tenant-id": TENANT_ID,
    ...(overrides.headers ?? {}),
  };
  const bodyStr = overrides.body ?? "";
  const req = {
    headers,
    // Simulate readable stream for readJsonBody — readJsonBody uses Buffer.concat
    // so we must emit Buffer chunks, not raw strings.
    on: vi.fn().mockImplementation((event: string, cb: (data?: Buffer) => void) => {
      if (event === "data" && bodyStr) cb(Buffer.from(bodyStr, "utf8"));
      if (event === "end") (cb as () => void)();
    }),
    setEncoding: vi.fn(),
  } as unknown as IncomingMessage;
  return req;
}

function makeRes() {
  const chunks: string[] = [];
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end(body?: string) { if (body) chunks.push(body); },
    get body() { return chunks.join(""); },
    get json() { return JSON.parse(this.body); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("process-defs routes (unit, no DB)", () => {
  let router: ReturnType<typeof makeRouter>;
  let flowable: FlowableClient;

  beforeEach(() => {
    router = makeRouter();
    flowable = makeFlowable();
  });

  // -------------------------------------------------------------------------
  // Auth guards
  // -------------------------------------------------------------------------

  describe("auth + tenant guards", () => {
    it("GET /api/process-defs/:key — 400 if x-tenant-id missing", async () => {
      // GET /:key only requires tenant header (no actor check — read-only route).
      // We need to construct a req WITHOUT the x-tenant-id header at all.
      const pool = makePool(async (sql) => {
        if (/SET LOCAL|BEGIN|COMMIT/.test(sql)) return { rows: [] };
        return { rows: [] };
      });
      registerProcessDefsRoutes(router as any, pool as any, flowable);
      const route = router.find("GET", "/api/process-defs/my-process");
      expect(route).not.toBeNull();

      // Build req with only x-dev-user, no x-tenant-id
      const req = {
        headers: { "x-dev-user": DEV_USER },
        on: vi.fn().mockImplementation((event: string, cb: () => void) => { if (event === "end") cb(); }),
        setEncoding: vi.fn(),
      } as unknown as IncomingMessage;
      const res = makeRes();

      await expect(
        route!.handler(req as any, res as any, { key: "my-process" }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("POST /api/process-defs — 401 if x-dev-user missing", async () => {
      // Write route: extractActor fires first → 401 before body read.
      const pool = makePool(async () => ({ rows: [] }));
      registerProcessDefsRoutes(router as any, pool as any, flowable);
      const route = router.find("POST", "/api/process-defs");
      expect(route).not.toBeNull();

      // Build req with only x-tenant-id, no x-dev-user
      const req = {
        headers: { "x-tenant-id": TENANT_ID },
        on: vi.fn().mockImplementation((event: string, cb: () => void) => { if (event === "end") cb(); }),
        setEncoding: vi.fn(),
      } as unknown as IncomingMessage;
      const res = makeRes();

      await expect(
        route!.handler(req as any, res as any, {}),
      ).rejects.toMatchObject({ statusCode: 401 });
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/process-defs/:key
  // -------------------------------------------------------------------------

  describe("GET /api/process-defs/:key", () => {
    it("returns 404 when no row found for the key", async () => {
      const pool = makePool(async (sql) => {
        if (/BEGIN|COMMIT|ROLLBACK|SET LOCAL/.test(sql)) return { rows: [] };
        // SELECT returns empty
        return { rows: [] };
      });
      registerProcessDefsRoutes(router as any, pool as any, flowable);
      const route = router.find("GET", "/api/process-defs/my-process");
      expect(route).not.toBeNull();

      const req = makeReq();
      const res = makeRes();

      await expect(
        route!.handler(req as any, res as any, { key: "my-process" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("returns 200 + bpmnXml when row found", async () => {
      const fakeRow = {
        id: "00000000-0000-0000-0000-000000000099",
        process_key: "my-process",
        name: "My Process",
        bpmn_xml: "<xml/>",
        version: 3,
        status: "draft",
        deployment_id: null,
        created_at: "1000",
        updated_at: "2000",
      };

      const pool = makePool(async (sql) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
        if (/SET LOCAL/.test(sql)) return { rows: [] };
        if (/SELECT/.test(sql)) return { rows: [fakeRow] };
        return { rows: [] };
      });

      registerProcessDefsRoutes(router as any, pool as any, flowable);
      const route = router.find("GET", "/api/process-defs/my-process");

      const req = makeReq();
      const res = makeRes();

      await route!.handler(req as any, res as any, { key: "my-process" });

      expect(res.statusCode).toBe(200);
      const body = res.json;
      expect(body.bpmnXml).toBe("<xml/>");
      expect(body.processKey).toBe("my-process");
      expect(body.version).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/process-defs
  // -------------------------------------------------------------------------

  describe("POST /api/process-defs", () => {
    it("T-0377 (B19): auto-assigns key (201) when processKey is omitted", async () => {
      // processKey is now optional — backend generates a slug from name.
      const pool = makePool(async (sql) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
        if (/SET LOCAL/.test(sql)) return { rows: [] };
        if (/ORDER BY version DESC.*LIMIT 1/.test(sql)) return { rows: [] }; // no collision
        if (/INSERT/.test(sql)) return { rows: [] };
        return { rows: [] };
      });
      registerProcessDefsRoutes(router as any, pool as any, flowable);
      const route = router.find("POST", "/api/process-defs");
      expect(route).not.toBeNull();

      const req = makeReq({ body: JSON.stringify({ name: "Invoice Approval", bpmnXml: "<x/>" }) });
      const res = makeRes();

      await route!.handler(req as any, res as any, {});
      expect(res.statusCode).toBe(201);
      // Slug derived from name: "Invoice Approval" → "invoice-approval"
      expect(res.json.processKey).toBe("invoice-approval");
      expect(res.json.assignedKey).toBe("invoice-approval");
    });

    it("201 with id/version on valid body (first insert → version=1)", async () => {
      const pool = makePool(async (sql) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
        if (/SET LOCAL/.test(sql)) return { rows: [] };
        if (/SELECT DISTINCT ON/.test(sql) || /ORDER BY version DESC/.test(sql)) return { rows: [] };
        if (/INSERT/.test(sql)) return { rows: [] };
        return { rows: [] };
      });

      registerProcessDefsRoutes(router as any, pool as any, flowable);
      const route = router.find("POST", "/api/process-defs");

      const req = makeReq({
        body: JSON.stringify({ processKey: "my-proc", name: "My Proc", bpmnXml: "<xml/>" }),
      });
      const res = makeRes();

      await route!.handler(req as any, res as any, {});

      expect(res.statusCode).toBe(201);
      const body = res.json;
      expect(body.processKey).toBe("my-proc");
      expect(body.version).toBe(1);
      expect(body.status).toBe("draft");
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/process-defs/:key/publish
  // -------------------------------------------------------------------------

  describe("POST /api/process-defs/:key/publish", () => {
    it("404 if no definition found for key", async () => {
      const pool = makePool(async (sql) => {
        if (/BEGIN|COMMIT|ROLLBACK|SET LOCAL/.test(sql)) return { rows: [] };
        return { rows: [] };
      });

      registerProcessDefsRoutes(router as any, pool as any, flowable);
      const route = router.find("POST", "/api/process-defs/no-such-key/publish");

      const req = makeReq();
      const res = makeRes();

      await expect(
        route!.handler(req as any, res as any, { key: "no-such-key" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("calls deployBpmn and returns 200 on success", async () => {
      const fakeRow = {
        id: "00000000-0000-0000-0000-000000000001",
        process_key: "pub-proc",
        name: "Pub Process",
        bpmn_xml: `<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://test"><process id="Process_1" isExecutable="false"><startEvent id="Start_1"/><endEvent id="End_1"/></process></definitions>`,
        version: 1,
        status: "draft",
        deployment_id: null,
        created_at: "1000",
        updated_at: "2000",
      };

      const pool = makePool(async (sql) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
        if (/SET LOCAL/.test(sql)) return { rows: [] };
        if (/SELECT/.test(sql)) return { rows: [fakeRow] };
        if (/UPDATE/.test(sql)) return { rows: [] };
        return { rows: [] };
      });

      const flowableSuccess = makeFlowable({
        deployBpmn: vi.fn().mockResolvedValue({ ok: true, deploymentId: "deploy-abc-123" }),
      });

      registerProcessDefsRoutes(router as any, pool as any, flowableSuccess);
      const route = router.find("POST", "/api/process-defs/pub-proc/publish");

      const req = makeReq();
      const res = makeRes();

      await route!.handler(req as any, res as any, { key: "pub-proc" });

      expect(res.statusCode).toBe(200);
      const body = res.json;
      expect(body.status).toBe("published");
      expect(body.deploymentId).toBe("deploy-abc-123");
      expect(flowableSuccess.deployBpmn).toHaveBeenCalledOnce();
    });
  });
});
