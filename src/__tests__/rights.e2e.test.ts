import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";

// ---------------------------------------------------------------------------
// E2E: Rights API with real server
// ---------------------------------------------------------------------------

describe("Rights API E2E", () => {
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

  it("GET /api/rights returns 200 with roles array", async () => {
    const result = await makeRequest("GET", "/api/rights");

    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data).toHaveProperty("roles");
    expect(Array.isArray(data.roles)).toBe(true);
    expect(data.roles.length).toBeGreaterThan(0);
  });

  it("GET /api/rights roles have required structure", async () => {
    const result = await makeRequest("GET", "/api/rights");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const roles = data.roles as Array<Record<string, unknown>>;

    for (const role of roles) {
      expect(role.id).toBeDefined();
      expect(typeof role.id).toBe("string");
      expect(role.name).toBeDefined();
      expect(typeof role.name).toBe("string");
      expect(Array.isArray(role.grants)).toBe(true);
      expect(Array.isArray(role.fields)).toBe(true);
      expect(Array.isArray(role.holders)).toBe(true);
    }
  });

  it("GET /api/rights/:roleId returns 200 with specific role", async () => {
    // First get all roles
    let result = await makeRequest("GET", "/api/rights");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const roles = data.roles as Array<Record<string, unknown>>;
    const firstRoleId = roles[0].id as string;

    // Then get specific role
    result = await makeRequest("GET", `/api/rights/${firstRoleId}`);
    expect(result.statusCode).toBe(200);
    const roleData = JSON.parse(result.body) as Record<string, unknown>;
    expect(roleData.id).toBe(firstRoleId);
    expect(roleData.name).toBeDefined();
  });

  it("GET /api/rights/NOPE returns 404", async () => {
    const result = await makeRequest("GET", "/api/rights/NOPE");
    expect(result.statusCode).toBe(404);
  });

  it("GET /api/rights response has proper HTTP headers", async () => {
    const result = await makeRequest("GET", "/api/rights");
    expect(result.statusCode).toBe(200);
    expect(result.body).toBeTruthy();
    const data = JSON.parse(result.body);
    expect(typeof data).toBe("object");
  });

  it("Each role has holders with type and name fields", async () => {
    const result = await makeRequest("GET", "/api/rights");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const roles = data.roles as Array<Record<string, unknown>>;

    for (const role of roles) {
      const holders = role.holders as Array<Record<string, unknown>>;
      for (const holder of holders) {
        expect(holder.type).toBeDefined();
        expect(["human", "agent", "service"].includes(holder.type as string)).toBe(true);
        expect(holder.name).toBeDefined();
        expect(typeof holder.name).toBe("string");
      }
    }
  });

  it("Each grant has res, uri, ops array, and scope", async () => {
    const result = await makeRequest("GET", "/api/rights");
    const data = JSON.parse(result.body) as Record<string, unknown>;
    const roles = data.roles as Array<Record<string, unknown>>;

    for (const role of roles) {
      const grants = role.grants as Array<Record<string, unknown>>;
      for (const grant of grants) {
        expect(grant.res).toBeDefined();
        expect(grant.uri).toBeDefined();
        expect(Array.isArray(grant.ops)).toBe(true);
        expect(grant.scope).toBeDefined();
      }
    }
  });

  // R-1 / AC-16: GET /api/rights/dictionaries must be reachable — no DATABASE_URL
  // required (seed-backed). Must NOT be captured by :roleId catch-all.
  it("GET /api/rights/dictionaries returns 200 with seed data (no DATABASE_URL required)", async () => {
    const result = await makeRequest("GET", "/api/rights/dictionaries");
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect(Array.isArray(data["resources"]), "resources must be an array").toBe(true);
    expect(Array.isArray(data["operations"]), "operations must be an array").toBe(true);
    expect(Array.isArray(data["orgTree"]), "orgTree must be an array").toBe(true);
    expect(Array.isArray(data["scopeTags"]), "scopeTags must be an array").toBe(true);
  });
});
