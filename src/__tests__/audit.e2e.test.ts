import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";

// ---------------------------------------------------------------------------
// E2E: Audit API with real server
// ---------------------------------------------------------------------------

describe("Audit API E2E", () => {
  let server: http.Server;
  let baseUrl: string;

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

  function makeRequest(method: string, path: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(url, { method }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || 200, body });
        });
      });
      req.on("error", (err: Error) => {
        reject(err);
      });
      req.end();
    });
  }

  it("GET /api/audit returns 200 with valid JSON structure", async () => {
    const result = await makeRequest("GET", "/api/audit");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data).toHaveProperty("instance");
    expect(data).toHaveProperty("trace");
    expect(Array.isArray(data.trace)).toBe(true);
  });

  it("GET /api/audit response has instance with required fields", async () => {
    const result = await makeRequest("GET", "/api/audit");

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

  it("GET /api/audit trace has steps with node, name, and events array", async () => {
    const result = await makeRequest("GET", "/api/audit");

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

  it("GET /api/audit/INS-7731 returns 200 with matching instance", async () => {
    const result = await makeRequest("GET", "/api/audit/INS-7731");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const instance = data.instance as Record<string, unknown>;

    expect(instance.id).toBe("INS-7731");
    expect(data).toHaveProperty("trace");
  });

  it("GET /api/audit/NOPE returns 404", async () => {
    const result = await makeRequest("GET", "/api/audit/NOPE");

    expect(result.statusCode).toBe(404);
  });

  it("GET /api/audit returns default instance INS-7731", async () => {
    const result = await makeRequest("GET", "/api/audit");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const instance = data.instance as Record<string, unknown>;

    expect(instance.id).toBe("INS-7731");
  });

  it("Default instance has running status and budget items", async () => {
    const result = await makeRequest("GET", "/api/audit");

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
