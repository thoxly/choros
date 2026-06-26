import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";

// ---------------------------------------------------------------------------
// E2E: Audit API with real server.
//
// T-0500: GET /api/audit is now the REAL tenant-wide audit-log read (DB-backed).
// In memory mode (no DATABASE_URL) there is no audit store, so the route fails
// HONESTLY with 503 rather than serving the old fake "Счёт-агент" timeline.
// The demo instance-trace surface (GET /api/audit/:instanceId, .../export) is
// in-memory and UNCHANGED — those assertions live below.
// ---------------------------------------------------------------------------

describe("Audit API E2E", () => {
  let server: http.Server;
  let baseUrl: string;
  const hasDb = !!process.env["DATABASE_URL"];

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function makeRequest(
    method: string,
    path: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(
        url,
        { method, headers: { "x-dev-user": "e-owner" } },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            resolve({ statusCode: res.statusCode || 200, body });
          });
        },
      );
      req.on("error", (err: Error) => {
        reject(err);
      });
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // GET /api/audit — the REAL tenant-wide log.
  // -------------------------------------------------------------------------

  it.skipIf(hasDb)(
    "GET /api/audit without a DB → 503 (honest: no audit store, not a fake timeline)",
    async () => {
      const result = await makeRequest("GET", "/api/audit");
      expect(result.statusCode).toBe(503);
      const data = JSON.parse(result.body) as { error?: { code?: string } };
      expect(data.error?.code).toBe("AUDIT_UNAVAILABLE");
    },
  );

  it.skipIf(!hasDb)(
    "GET /api/audit with a DB → 200 { events, nextCursor } OR a fail-closed auth status",
    async () => {
      const result = await makeRequest("GET", "/api/audit");
      // With an ambient DB the seed owner reads the (possibly empty) event list;
      // an unresolvable identity fails closed (401/403). Never the old shape.
      expect([200, 401, 403]).toContain(result.statusCode);
      if (result.statusCode === 200) {
        const data = JSON.parse(result.body) as Record<string, unknown>;
        expect(Array.isArray(data["events"])).toBe(true);
        expect(data).not.toHaveProperty("trace");
        expect(data).not.toHaveProperty("instance");
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/audit/:instanceId — the demo instance-trace surface (UNCHANGED).
  // -------------------------------------------------------------------------

  it("GET /api/audit/INS-7731 returns 200 with the demo instance trace", async () => {
    const result = await makeRequest("GET", "/api/audit/INS-7731");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const instance = data.instance as Record<string, unknown>;

    expect(instance.id).toBe("INS-7731");
    expect(data).toHaveProperty("trace");
    expect(Array.isArray(data.trace)).toBe(true);
  });

  it("GET /api/audit/INS-7731 instance has required fields", async () => {
    const result = await makeRequest("GET", "/api/audit/INS-7731");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const instance = data.instance as Record<string, unknown>;

    expect(instance.id).toBeDefined();
    expect(instance.process).toBeDefined();
    expect(instance.procId).toBeDefined();
    expect(instance.status).toBeDefined();
    expect(instance.started).toBeDefined();
    expect(instance.elapsed).toBeDefined();
    expect(instance.node).toBeDefined();
    expect(Array.isArray(instance.execs)).toBe(true);
    expect(Array.isArray(instance.budget)).toBe(true);
  });

  it("GET /api/audit/INS-7731 trace steps have node, name, events", async () => {
    const result = await makeRequest("GET", "/api/audit/INS-7731");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const trace = data.trace as Array<Record<string, unknown>>;

    expect(trace.length).toBeGreaterThan(0);

    for (const step of trace) {
      expect(step.node).toBeDefined();
      expect(step.name).toBeDefined();
      expect(Array.isArray(step.events)).toBe(true);
      expect((step.events as Array<unknown>).length).toBeGreaterThan(0);

      for (const event of step.events as Array<Record<string, unknown>>) {
        expect(event.ts).toBeDefined();
        expect(event.type).toBeDefined();
        expect(event.actor).toBeDefined();
        expect(event.action).toBeDefined();
      }
    }
  });

  it("GET /api/audit/NOPE returns 404", async () => {
    const result = await makeRequest("GET", "/api/audit/NOPE");

    expect(result.statusCode).toBe(404);
  });

  it("Demo instance INS-7731 has running status and budget items", async () => {
    const result = await makeRequest("GET", "/api/audit/INS-7731");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const instance = data.instance as Record<string, unknown>;

    expect(instance.status).toBe("running");
    const budget = instance.budget as Array<Record<string, unknown>>;
    expect(budget.length).toBeGreaterThanOrEqual(2);

    for (const item of budget) {
      expect(item.label).toBeDefined();
      expect(item.used).toBeDefined();
      expect(item.total).toBeDefined();
      expect(item.unit).toBeDefined();
    }
  });
});
