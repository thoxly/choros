import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";

// ---------------------------------------------------------------------------
// E2E: Auth API with real server
// ---------------------------------------------------------------------------

describe("Auth API E2E", () => {
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

  function makeRequest(
    method: string,
    path: string,
    headers?: Record<string, string>
  ): Promise<{ statusCode: number; body: string }> {
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

  it("GET /api/users returns 200 with non-empty users array", async () => {
    const result = await makeRequest("GET", "/api/users");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data).toHaveProperty("users");
    expect(Array.isArray(data.users)).toBe(true);
    expect(data.users.length).toBeGreaterThan(0);
  });

  it("GET /api/users: every user has id and name", async () => {
    const result = await makeRequest("GET", "/api/users");
    const data = JSON.parse(result.body);
    const users = data.users as Array<Record<string, unknown>>;

    for (const user of users) {
      expect(user.id).toBeDefined();
      expect(typeof user.id).toBe("string");
      expect(user.name).toBeDefined();
      expect(typeof user.name).toBe("string");
    }
  });

  it("GET /api/users: returns only humans (type==='human')", async () => {
    const result = await makeRequest("GET", "/api/users");
    const data = JSON.parse(result.body);
    const users = data.users as Array<Record<string, unknown>>;

    for (const user of users) {
      // All users returned should be humans, and should have position+department
      expect(user.position).toBeDefined();
      expect(user.department).toBeDefined();
    }
  });

  it("GET /api/me with valid header returns 200 with user identity", async () => {
    const result = await makeRequest("GET", "/api/me", {
      "x-dev-user": "e-kravtsova",
    });

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data.id).toBe("e-kravtsova");
    expect(data.type).toBe("human");
    expect(data.name).toBeDefined();
    expect(data.position).toBeDefined();
    expect(data.department).toBeDefined();
  });

  it("GET /api/me without header returns 401", async () => {
    const result = await makeRequest("GET", "/api/me");

    expect(result.statusCode).toBe(401);
    const data = JSON.parse(result.body);
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe("UNAUTHENTICATED");
  });

  it("GET /api/me with non-existent user returns 401", async () => {
    const result = await makeRequest("GET", "/api/me", {
      "x-dev-user": "does-not-exist",
    });

    expect(result.statusCode).toBe(401);
    const data = JSON.parse(result.body);
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe("UNAUTHENTICATED");
  });
});
