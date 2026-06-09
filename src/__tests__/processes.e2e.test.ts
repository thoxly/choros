import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";

// ---------------------------------------------------------------------------
// E2E: Processes API with real server
// ---------------------------------------------------------------------------

describe("Processes API E2E", () => {
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

  it("GET /api/processes returns 200 with instances list", async () => {
    const result = await makeRequest("GET", "/api/processes");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data).toHaveProperty("instances");
    expect(Array.isArray(data.instances)).toBe(true);
  });

  it("GET /api/processes instances array is non-empty", async () => {
    const result = await makeRequest("GET", "/api/processes");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const instances = data.instances as Array<Record<string, unknown>>;

    expect(instances.length).toBeGreaterThan(0);
  });

  it("Each instance has required fields: id, name, status, node, progress, execs", async () => {
    const result = await makeRequest("GET", "/api/processes");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const instances = data.instances as Array<Record<string, unknown>>;

    for (const inst of instances) {
      expect(inst.id).toBeDefined();
      expect(typeof inst.id).toBe("string");
      expect(inst.name).toBeDefined();
      expect(typeof inst.name).toBe("string");
      expect(inst.status).toBeDefined();
      expect(["running", "waiting", "done", "failed"]).toContain(inst.status);
      expect(inst.node).toBeDefined();
      expect(typeof inst.node).toBe("string");
      expect(inst.progress).toBeDefined();
      expect(typeof inst.progress).toBe("object");
      expect((inst.progress as Record<string, unknown>).done).toBeDefined();
      expect((inst.progress as Record<string, unknown>).total).toBeDefined();
      expect(inst.execs).toBeDefined();
      expect(Array.isArray(inst.execs)).toBe(true);
    }
  });

  it("Instance INS-7731 exists with seeded data", async () => {
    const result = await makeRequest("GET", "/api/processes");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const instances = data.instances as Array<Record<string, unknown>>;

    const ins7731 = instances.find((i) => i.id === "INS-7731");
    expect(ins7731).toBeDefined();
    expect(ins7731?.name).toBe("Согласование счёта поставщика");
    expect(ins7731?.procId).toBe("PRC-INV-APPROVE");
    expect(ins7731?.status).toBe("running");
  });

  it("GET /api/processes/:id returns 200 for valid instance", async () => {
    const result = await makeRequest("GET", "/api/processes/INS-7731");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data.id).toBe("INS-7731");
    expect(data.name).toBe("Согласование счёта поставщика");
  });

  it("GET /api/processes/:id returns 404 for nonexistent instance", async () => {
    const result = await makeRequest("GET", "/api/processes/NOPE");

    expect(result.statusCode).toBe(404);
  });
});
