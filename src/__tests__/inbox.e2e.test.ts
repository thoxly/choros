import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";

// ---------------------------------------------------------------------------
// E2E: Inbox API with real server
// ---------------------------------------------------------------------------

describe("Inbox API E2E", () => {
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

  function makeRequest(method: string, path: string, headers?: Record<string, string>): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(url, { method, headers }, (res) => {
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

  it("T-0106: GET /api/inbox returns 200 with valid JSON structure", async () => {
    const result = await makeRequest("GET", "/api/inbox");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data).toHaveProperty("items");
    expect(Array.isArray(data.items)).toBe(true);
  });

  it("T-0106: GET /api/inbox response has proper HTTP headers and body", async () => {
    const result = await makeRequest("GET", "/api/inbox");

    expect(result.statusCode).toBe(200);
    expect(result.body).toBeTruthy();

    const data = JSON.parse(result.body);
    expect(typeof data).toBe("object");
  });

  it("T-0106: Response items array is non-empty", async () => {
    const result = await makeRequest("GET", "/api/inbox");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;

    expect(items.length).toBeGreaterThan(0);
  });

  it("T-0106: Each inbox item has required fields (id, status, name, step, inst, sla, due)", async () => {
    const result = await makeRequest("GET", "/api/inbox");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;

    for (const item of items) {
      expect(item.id).toBeDefined();
      expect(typeof item.id).toBe("string");

      expect(item.status).toBeDefined();
      expect(["running", "waiting", "failed", "done", "paused"]).toContain(item.status);

      expect(item.name).toBeDefined();
      expect(typeof item.name).toBe("string");

      expect(item.step).toBeDefined();
      expect(typeof item.step).toBe("string");

      expect(item.inst).toBeDefined();
      expect(typeof item.inst).toBe("string");

      expect(item.sla).toBeDefined();
      expect(typeof item.sla).toBe("object");
      expect(item.sla).toHaveProperty("min");
      expect(item.sla).toHaveProperty("left");
      expect(typeof (item.sla as Record<string, unknown>).min).toBe("number");
      expect(typeof (item.sla as Record<string, unknown>).left).toBe("number");

      expect(item.due).toBeDefined();
      expect(typeof item.due).toBe("string");
    }
  });

  it("T-0106: Items have either (execType + execName) or pool property", async () => {
    const result = await makeRequest("GET", "/api/inbox");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;

    for (const item of items) {
      const hasExecutor = item.execType !== undefined && item.execName !== undefined;
      const isPooled = item.pool === true;
      expect(hasExecutor || isPooled).toBe(true);

      if (hasExecutor) {
        expect(["agent", "human", "service"]).toContain(item.execType);
        expect(typeof item.execName).toBe("string");
      }

      if (isPooled) {
        expect(item.pool).toBe(true);
      }
    }
  });

  it("T-0106: Response contains at least 1 pooled item (pool=true)", async () => {
    const result = await makeRequest("GET", "/api/inbox");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;

    const pooledItems = items.filter((item) => item.pool === true);
    expect(pooledItems.length).toBeGreaterThanOrEqual(1);
  });

  it("T-0106: Response contains at least 1 agent executor", async () => {
    const result = await makeRequest("GET", "/api/inbox");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;

    const agentItems = items.filter((item) => item.execType === "agent");
    expect(agentItems.length).toBeGreaterThanOrEqual(1);
  });

  it("T-0106: Response contains 12 hardcoded inbox items with ids t1..t12", async () => {
    const result = await makeRequest("GET", "/api/inbox");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;

    expect(items.length).toBe(12);

    const ids = items.map((item) => item.id).sort();
    const expectedIds = ["t1", "t10", "t11", "t12", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"];

    expect(ids).toEqual(expectedIds);
  });

  it("T-0106: Items match the exact shape from screen-inbox.jsx TASKS", async () => {
    const result = await makeRequest("GET", "/api/inbox");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;

    // Spot-check a few items to match screen data
    const t1 = items.find((item) => item.id === "t1") as Record<string, unknown>;
    expect(t1.status).toBe("running");
    expect(t1.name).toBe("Проверить реквизиты счёта №4471");
    expect(t1.execType).toBe("agent");
    expect(t1.execName).toBe("Счёт-агент");

    const t3 = items.find((item) => item.id === "t3") as Record<string, unknown>;
    expect(t3.pool).toBe(true);
    expect(t3.status).toBe("waiting");

    const t6 = items.find((item) => item.id === "t6") as Record<string, unknown>;
    expect(t6.pool).toBe(true);
    expect(t6.status).toBe("failed");
  });

  it("T-0112: GET /api/inbox with X-Dev-User header resolves mine flag", async () => {
    const result = await makeRequest("GET", "/api/inbox", { "x-dev-user": "e-kravtsova" });

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;

    // Find items assigned to А. Кравцова (t2 has execName "А. Кравцова")
    const t2 = items.find((item) => item.id === "t2") as Record<string, unknown>;
    expect(t2).toBeDefined();
    expect(t2.execName).toBe("А. Кравцова");
    expect(t2.mine).toBe(true);

    // At least one item should have mine === true
    const mineTasks = items.filter((item) => item.mine === true);
    expect(mineTasks.length).toBeGreaterThanOrEqual(1);
  });

  it("T-0112: GET /api/inbox without X-Dev-User header sets all mine to false", async () => {
    const result = await makeRequest("GET", "/api/inbox");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;

    // All items should have mine === false when no header provided
    for (const item of items) {
      expect(item.mine).toBe(false);
    }
  });

  it("T-0112: GET /api/inbox mine flag only true for human execType", async () => {
    const result = await makeRequest("GET", "/api/inbox", { "x-dev-user": "e-kravtsova" });

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;

    // Items with mine === true should have execType === "human"
    for (const item of items) {
      if (item.mine === true) {
        expect(item.execType).toBe("human");
      }
    }
  });
});
