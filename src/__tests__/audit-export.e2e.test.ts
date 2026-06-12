/**
 * T-0138: E2E tests for GET /api/audit/export (write-path «Экспорт лога»).
 *
 * Covers:
 *   AC-1: 401 when x-dev-user header is absent
 *   AC-2: 200 with Content-Disposition: attachment on default export
 *   AC-3: response body is valid JSON matching AuditData shape
 *   AC-4: ?instance=INS-7731 exports the named instance
 *   AC-5: ?instance=UNKNOWN returns 404
 *   AC-6: /api/audit/:instanceId still works (export route does not shadow it)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";
import type { AuditData } from "../http/audit.js";

describe("Audit export E2E (T-0138)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer(undefined, undefined, "memory");
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

  function request(
    method: string,
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(url, { method, headers }, (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
        });
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, body: buf, headers: res.headers }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  // AC-1: 401 when x-dev-user header is absent
  it("returns 401 when x-dev-user is absent", async () => {
    const result = await request("GET", "/api/audit/export");
    expect(result.statusCode).toBe(401);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.error as Record<string, unknown>)?.code).toBe("UNAUTHENTICATED");
  });

  // AC-2: 200 with Content-Disposition: attachment on default export
  it("returns 200 with attachment Content-Disposition for default export", async () => {
    const result = await request("GET", "/api/audit/export", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("application/json");
    const disposition = result.headers["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("filename=");
  });

  // AC-3: response body is valid JSON matching AuditData shape
  it("returns valid AuditData JSON body", async () => {
    const result = await request("GET", "/api/audit/export", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as AuditData;
    expect(data).toHaveProperty("instance");
    expect(data).toHaveProperty("trace");
    expect(typeof data.instance.id).toBe("string");
    expect(Array.isArray(data.trace)).toBe(true);
  });

  // AC-4: ?instance=INS-7731 exports the named instance
  it("exports named instance when ?instance= param is provided", async () => {
    const result = await request("GET", "/api/audit/export?instance=INS-7731", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as AuditData;
    expect(data.instance.id).toBe("INS-7731");
  });

  // AC-5: 404 for unknown instance
  it("returns 404 for unknown instance id", async () => {
    const result = await request("GET", "/api/audit/export?instance=DOES-NOT-EXIST", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(404);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.error as Record<string, unknown>)?.code).toBe("NOT_FOUND");
  });

  // AC-6: /api/audit/:instanceId still routes correctly (export route does not shadow it)
  it("GET /api/audit/INS-7731 still returns 200 (not captured by export route)", async () => {
    const result = await request("GET", "/api/audit/INS-7731");
    // No auth header — but this route has no auth gate, so 200 is expected
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as AuditData;
    expect(data.instance.id).toBe("INS-7731");
    // Verify there is no Content-Disposition attachment header (not an export)
    const disposition = result.headers["content-disposition"] ?? "";
    expect(disposition).not.toContain("attachment");
  });
});
