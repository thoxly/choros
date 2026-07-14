/**
 * T-0031: E2E tests for GET /api/grant-trail
 *
 * Covers AC-12..AC-18, FF-0031-08, FF-0031-09 (in-memory / no DATABASE_URL).
 * All tests run without a real Postgres (static seed fallback path).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";

// Ensure DATABASE_URL is absent so the static fallback path is exercised.
// (The actual env may or may not have it; we force it away for these tests.)
const originalDbUrl = process.env["DATABASE_URL"];

describe("GET /api/grant-trail — static fallback (no DATABASE_URL)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Remove DATABASE_URL so the static seed path is used.
    delete process.env["DATABASE_URL"];

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
    // Restore DATABASE_URL if it was set.
    if (originalDbUrl !== undefined) {
      process.env["DATABASE_URL"] = originalDbUrl;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function makeRequest(
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(url, { method: "GET", headers }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 200, body });
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  // AC-12: basic response shape
  it("AC-12: GET /api/grant-trail returns 200 with { rows, hasMore } shape", async () => {
    const { statusCode, body } = await makeRequest("/api/grant-trail");
    expect(statusCode).toBe(200);
    const data = JSON.parse(body);
    expect(data).toHaveProperty("rows");
    expect(data).toHaveProperty("hasMore");
    expect(Array.isArray(data.rows)).toBe(true);
    expect(typeof data.hasMore).toBe("boolean");
  });

  it("AC-12: each row has required GrantTrailRow fields", async () => {
    const { body } = await makeRequest("/api/grant-trail");
    const data = JSON.parse(body) as { rows: Array<Record<string, unknown>> };
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) {
      expect(row).toHaveProperty("seq");
      expect(row).toHaveProperty("id");
      expect(row).toHaveProperty("type");
      expect(row).toHaveProperty("actor");
      expect(row).toHaveProperty("subject");
      expect(row).toHaveProperty("scope");
      expect(row).toHaveProperty("proposed_by");
      expect(row).toHaveProperty("confirmed_by");
      expect(row).toHaveProperty("payload");
      expect(row).toHaveProperty("occurred_at");
    }
  });

  // AC-13: role_id filter
  it("AC-13: GET /api/grant-trail?role_id=X filters by subject or payload.roleId", async () => {
    const { body } = await makeRequest("/api/grant-trail?role_id=role-fin-approve-250");
    const data = JSON.parse(body) as { rows: Array<Record<string, unknown>> };
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) {
      const matchesSubject = row["subject"] === "role-fin-approve-250";
      const matchesPayload =
        row["payload"] !== null &&
        typeof row["payload"] === "object" &&
        (row["payload"] as Record<string, unknown>)["roleId"] === "role-fin-approve-250";
      expect(matchesSubject || matchesPayload).toBe(true);
    }
  });

  // AC-14: actor filter
  it("AC-14: GET /api/grant-trail?actor=X filters by actor", async () => {
    const { body } = await makeRequest("/api/grant-trail?actor=%D0%90.+%D0%9A%D1%80%D0%B0%D0%B2%D1%86%D0%BE%D0%B2%D0%B0");
    const data = JSON.parse(body) as { rows: Array<Record<string, unknown>> };
    for (const row of data.rows) {
      expect(row["actor"]).toBe("А. Кравцова");
    }
  });

  // AC-15: limit + hasMore
  it("AC-15: GET /api/grant-trail?limit=2 returns at most 2 rows", async () => {
    const { body } = await makeRequest("/api/grant-trail?limit=2");
    const data = JSON.parse(body) as { rows: unknown[]; hasMore: boolean };
    expect(data.rows.length).toBeLessThanOrEqual(2);
    // Seed has 10 rows — hasMore should be true when limit=2
    expect(data.hasMore).toBe(true);
  });

  // AC-16 / FF-0031-08: limit=600 → 400 INVALID_PARAM
  it("AC-16 / FF-0031-08: limit=600 returns 400 INVALID_PARAM", async () => {
    const { statusCode, body } = await makeRequest("/api/grant-trail?limit=600");
    expect(statusCode).toBe(400);
    const data = JSON.parse(body);
    expect(data.error?.code).toBe("INVALID_PARAM");
  });

  // Also test limit=0 → 400
  it("AC-16: limit=0 returns 400 INVALID_PARAM", async () => {
    const { statusCode, body } = await makeRequest("/api/grant-trail?limit=0");
    expect(statusCode).toBe(400);
    const data = JSON.parse(body);
    expect(data.error?.code).toBe("INVALID_PARAM");
  });

  // Also test limit=foo → 400
  it("AC-16: limit=foo returns 400 INVALID_PARAM", async () => {
    const { statusCode, body } = await makeRequest("/api/grant-trail?limit=foo");
    expect(statusCode).toBe(400);
    const data = JSON.parse(body);
    expect(data.error?.code).toBe("INVALID_PARAM");
  });

  // AC-17 / FF-0031-09: before_seq=abc → 400 INVALID_PARAM
  it("AC-17 / FF-0031-09: before_seq=abc returns 400 INVALID_PARAM", async () => {
    const { statusCode, body } = await makeRequest("/api/grant-trail?before_seq=abc");
    expect(statusCode).toBe(400);
    const data = JSON.parse(body);
    expect(data.error?.code).toBe("INVALID_PARAM");
  });

  it("AC-17: before_seq=1.5 returns 400 INVALID_PARAM", async () => {
    const { statusCode, body } = await makeRequest("/api/grant-trail?before_seq=1.5");
    expect(statusCode).toBe(400);
    const data = JSON.parse(body);
    expect(data.error?.code).toBe("INVALID_PARAM");
  });

  // AC-18: no DATABASE_URL → static seed (already guaranteed by beforeAll setup)
  it("AC-18: without DATABASE_URL returns HTTP 200 with seed data (≥1 row)", async () => {
    const { statusCode, body } = await makeRequest("/api/grant-trail");
    expect(statusCode).toBe(200);
    const data = JSON.parse(body) as { rows: unknown[] };
    expect(data.rows.length).toBeGreaterThanOrEqual(1);
  });

  // before_seq cursor pagination on seed data
  it("AC-15/cursor: before_seq=5 returns only rows with seq < 5", async () => {
    const { body } = await makeRequest("/api/grant-trail?before_seq=5");
    const data = JSON.parse(body) as { rows: Array<Record<string, unknown>> };
    for (const row of data.rows) {
      expect(Number(row["seq"])).toBeLessThan(5);
    }
  });
});
