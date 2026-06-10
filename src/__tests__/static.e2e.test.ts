/**
 * src/__tests__/static.e2e.test.ts
 *
 * E2E tests for static file serving and SPA fallback.
 * Uses a temp dist fixture to avoid dependency on web build.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

describe("Static File Serving E2E", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpDir: string;

  // Set up temp dist before importing createServer
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), "choros-dist-"));

    // Create fixture files
    const indexHtml = "<!doctype html><title>Choros</title><div id=root></div>";
    fs.writeFileSync(join(tmpDir, "index.html"), indexHtml);

    // Create assets directory
    fs.mkdirSync(join(tmpDir, "assets"), { recursive: true });
    fs.writeFileSync(join(tmpDir, "assets", "app.js"), "console.log('x')");

    // Set environment before importing createServer
    process.env["CHOROS_WEB_DIST"] = tmpDir;

    // Now import createServer (lazy import ensures env is set first)
    const { createServer } = await import("../server.js");

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
    delete process.env["CHOROS_WEB_DIST"];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRequest(method: string, path: string, headers?: Record<string, string>): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(url, { method, headers }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 200,
            body,
            headers: res.headers,
          });
        });
      });
      req.on("error", (err: Error) => {
        reject(err);
      });
      req.end();
    });
  }

  it("Regression: GET /health returns 200 JSON", async () => {
    const result = await makeRequest("GET", "/health");
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data.status).toBe("ok"); // T-0114: response now includes queue metrics
  });

  it("Regression: GET /api/inbox returns 200 with items", async () => {
    const result = await makeRequest("GET", "/api/inbox");
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data).toHaveProperty("items");
    expect(Array.isArray(data.items)).toBe(true);
  });

  it("Regression: GET /api/org returns 200 with departments", async () => {
    const result = await makeRequest("GET", "/api/org");
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body);
    expect(data).toHaveProperty("departments");
  });

  it("Regression: GET /api/me without auth header returns 401", async () => {
    const result = await makeRequest("GET", "/api/me");
    expect(result.statusCode).toBe(401);
    // Verify it's a JSON error envelope, not HTML
    const data = JSON.parse(result.body);
    expect(data).toHaveProperty("error");
  });

  it("API guard: GET /api/does-not-exist returns 404 with JSON error envelope", async () => {
    const result = await makeRequest("GET", "/api/does-not-exist");
    expect(result.statusCode).toBe(404);
    const data = JSON.parse(result.body);
    expect(data).toHaveProperty("error");
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("Static file: GET /index.html returns 200 with text/html", async () => {
    const result = await makeRequest("GET", "/index.html");
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.body).toContain("Choros");
  });

  it("Static file: GET /assets/app.js returns 200 with text/javascript", async () => {
    const result = await makeRequest("GET", "/assets/app.js");
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("text/javascript");
    expect(result.body).toBe("console.log('x')");
  });

  it("SPA fallback: GET /some/spa/route (no file) returns 200 with index.html", async () => {
    const result = await makeRequest("GET", "/some/spa/route");
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.body).toContain("Choros");
  });

  it("Path traversal guard: GET /../../etc/passwd does not expose file system", async () => {
    const result = await makeRequest("GET", "/../../etc/passwd");
    // Should either fall back to SPA (200) or 404, but NOT expose system files
    expect([200, 404]).toContain(result.statusCode);
    expect(result.body).not.toContain("root:");
  });

  it("Root path: GET / redirects to index.html via SPA fallback", async () => {
    const result = await makeRequest("GET", "/");
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.body).toContain("Choros");
  });

  it("Query strings: GET /index.html?v=123 ignores query and serves file", async () => {
    const result = await makeRequest("GET", "/index.html?v=123");
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("Choros");
  });

  it("Static file with query: GET /assets/app.js?v=1 serves file without query", async () => {
    const result = await makeRequest("GET", "/assets/app.js?v=1");
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("console.log('x')");
  });

  it("Non-existent nested route: GET /admin/settings falls back to SPA", async () => {
    const result = await makeRequest("GET", "/admin/settings");
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.body).toContain("Choros");
  });
});
