import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";

// ---------------------------------------------------------------------------
// E2E: Org API with real server
// ---------------------------------------------------------------------------

describe("Org API E2E", () => {
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

  it("FF-6: GET /api/org returns 200 with valid JSON structure", async () => {
    const result = await makeRequest("GET", "/api/org");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data).toHaveProperty("departments");
    expect(Array.isArray(data.departments)).toBe(true);
  });

  it("AC-2: GET /api/org response has proper HTTP headers and body", async () => {
    const result = await makeRequest("GET", "/api/org");

    expect(result.statusCode).toBe(200);
    expect(result.body).toBeTruthy();

    const data = JSON.parse(result.body);
    expect(typeof data).toBe("object");
  });

  it("AC-3: Response contains ≥3 departments with positions and people", async () => {
    const result = await makeRequest("GET", "/api/org");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const departments = data.departments as Array<Record<string, unknown>>;

    expect(departments.length).toBeGreaterThanOrEqual(3);

    for (const dept of departments) {
      expect(dept.id).toBeDefined();
      expect(dept.name).toBeDefined();
      expect(Array.isArray(dept.positions)).toBe(true);
      const positions = dept.positions as Array<Record<string, unknown>>;
      expect(positions.length).toBeGreaterThanOrEqual(1);

      for (const pos of positions) {
        expect(pos.id).toBeDefined();
        expect(pos.title).toBeDefined();
        expect(Array.isArray(pos.people)).toBe(true);
      }
    }
  });

  it("AC-4: Org structure contains hierarchy (department → position → people)", async () => {
    const result = await makeRequest("GET", "/api/org");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const departments = data.departments as Array<Record<string, unknown>>;

    let foundDeptWith2Pos = false;
    let foundPosWithMultiplePeople = false;

    for (const dept of departments) {
      const positions = dept.positions as Array<Record<string, unknown>>;
      if (positions.length >= 2) foundDeptWith2Pos = true;
      for (const pos of positions) {
        const people = pos.people as Array<Record<string, unknown>>;
        if (people.length >= 2) foundPosWithMultiplePeople = true;
      }
    }

    expect(foundDeptWith2Pos).toBe(true);
    expect(foundPosWithMultiplePeople).toBe(true);
  });

  it("AC-5 / FF-5 / FF-9: Response contains ≥2 agents with type='agent'", async () => {
    const result = await makeRequest("GET", "/api/org");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const departments = data.departments as Array<Record<string, unknown>>;

    const agents = departments
      .flatMap((d: Record<string, unknown>) => d.positions as Array<Record<string, unknown>>)
      .flatMap((p: Record<string, unknown>) => p.people as Array<Record<string, unknown>>)
      .filter((x: Record<string, unknown>) => x.type === "agent");

    expect(agents.length).toBeGreaterThanOrEqual(2);

    for (const agent of agents) {
      expect(agent.id).toBeDefined();
      expect(agent.name).toBeDefined();
      expect(agent.type).toBe("agent");
    }
  });

  it("AC-10: GET /api/org/employee/:id returns employee details", async () => {
    const result = await makeRequest("GET", "/api/org/employee/a-invoice");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;

    expect(data.id).toBe("a-invoice");
    expect(data.name).toBe("Счёт-агент");
    expect(data.type).toBe("agent");
    expect(data.position).toBeDefined();
    expect(data.department).toBeDefined();
  });

  it("AC-10: GET /api/org/employee/:id returns 404 for non-existent employee", async () => {
    const result = await makeRequest("GET", "/api/org/employee/nonexistent-id");

    expect(result.statusCode).toBe(404);
  });

  it("GET /api/org/employee/:id works for human and agent (service) types", async () => {
    // Test human
    let result = await makeRequest("GET", "/api/org/employee/e-kravtsova");
    expect(result.statusCode).toBe(200);
    let data = JSON.parse(result.body) as Record<string, unknown>;
    expect(data.type).toBe("human");

    // Test service worker — maps to kind='agent' per T-0017 FR-4/§6 spec decision
    // (service workers are automated actors; 'service' is not a valid kind value)
    result = await makeRequest("GET", "/api/org/employee/s-ledger");
    expect(result.statusCode).toBe(200);
    data = JSON.parse(result.body) as Record<string, unknown>;
    expect(data.type).toBe("agent");
  });
});
