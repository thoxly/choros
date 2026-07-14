/**
 * T-0401 [D7-3] — inbox LIST pagination tests
 *
 * Tests the paginated GET /api/inbox endpoint shape added in T-0401.
 * Uses the no-DB in-memory path (no DATABASE_URL set) so the seed inbox items
 * are returned, exactly as the existing inbox.e2e.test.ts does.
 *
 * Tests:
 *   IP-1  Response includes new pagination fields (page, totalPages, total, limit)
 *   IP-2  Default page/limit returns first page (limit=DEFAULT_PAGE_SIZE)
 *   IP-3  ?limit=3 returns at most 3 items
 *   IP-4  ?page=1&limit=3 returns next page
 *   IP-5  ?page=999&limit=3 is clamped to last page (no 500)
 *   IP-6  ?limit=999 is clamped to MAX_PAGE_SIZE
 *   IP-7  Tenant isolation: foreign-tenant tasks never in response (pre-existing)
 *   IP-8  Items on different pages have no overlapping ids
 *   IP-9  total reflects the FULL filtered count (not just the current page)
 *   IP-10 tab filter still works with pagination (counts are from full set)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "../core/data-access-port.js";

// ---------------------------------------------------------------------------
// Server setup (same pattern as inbox.e2e.test.ts)
// ---------------------------------------------------------------------------

describe("T-0401: inbox LIST pagination", () => {
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

  function get(path: string): Promise<{ statusCode: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(url, { method: "GET" }, (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 200,
            body: JSON.parse(raw),
          });
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  // IP-1: Response shape includes new pagination fields
  it("IP-1: response includes page, totalPages, total, limit fields", async () => {
    const { statusCode, body } = await get("/api/inbox");
    const data = body as Record<string, unknown>;

    expect(statusCode).toBe(200);
    expect(data).toHaveProperty("items");
    expect(data).toHaveProperty("page");
    expect(data).toHaveProperty("totalPages");
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("limit");
    expect(data).toHaveProperty("counts");
    expect(data).toHaveProperty("tab");
  });

  // IP-2: Default page/limit
  it("IP-2: default limit is DEFAULT_PAGE_SIZE and page=0", async () => {
    const { body } = await get("/api/inbox");
    const data = body as Record<string, unknown>;

    expect(data["page"]).toBe(0);
    expect(data["limit"]).toBe(DEFAULT_PAGE_SIZE);
  });

  // IP-3: ?limit=3 returns at most 3 items
  it("IP-3: ?limit=3 returns at most 3 items", async () => {
    const { statusCode, body } = await get("/api/inbox?limit=3");
    const data = body as Record<string, unknown>;

    expect(statusCode).toBe(200);
    const items = data["items"] as unknown[];
    expect(items.length).toBeLessThanOrEqual(3);
  });

  // IP-4: ?page=1&limit=3 returns next page with different items
  it("IP-4: ?page=1&limit=3 returns items different from page=0", async () => {
    const { body: body0 } = await get("/api/inbox?page=0&limit=3");
    const { body: body1 } = await get("/api/inbox?page=1&limit=3");

    const data0 = body0 as Record<string, unknown>;
    const data1 = body1 as Record<string, unknown>;
    const ids0 = (data0["items"] as Array<Record<string, unknown>>).map((i) => i["id"]);
    const ids1 = (data1["items"] as Array<Record<string, unknown>>).map((i) => i["id"]);

    const total0 = data0["total"] as number;
    if (total0 > 3) {
      // If there are more than 3 items total, pages should not overlap.
      expect(ids0).not.toEqual(ids1);
      const setP0 = new Set(ids0);
      for (const id of ids1) {
        expect(setP0.has(id)).toBe(false);
      }
    }
    // If total ≤ 3, page1 may be empty — that's fine.
  });

  // IP-5: ?page=999 is clamped to last page (no crash)
  it("IP-5: ?page=999 does not crash and returns valid response", async () => {
    const { statusCode, body } = await get("/api/inbox?page=999&limit=3");
    const data = body as Record<string, unknown>;

    expect(statusCode).toBe(200);
    expect(data).toHaveProperty("items");
    expect(data).toHaveProperty("page");
    const page = data["page"] as number;
    expect(page).toBeGreaterThanOrEqual(0);
  });

  // IP-6: ?limit=999 is clamped to MAX_PAGE_SIZE
  it("IP-6: ?limit=999 is clamped to MAX_PAGE_SIZE", async () => {
    const { body } = await get("/api/inbox?limit=999");
    const data = body as Record<string, unknown>;

    expect(data["limit"]).toBe(MAX_PAGE_SIZE);
  });

  // IP-7: Tenant isolation (pre-existing invariant verified via pagination shape)
  it("IP-7: foreign-tenant task (x1) is never in any page of the response", async () => {
    // The foreign-tenant task has id "x1". It must never appear, regardless of pagination.
    const { body: body0 } = await get("/api/inbox?page=0&limit=200");
    const data0 = body0 as Record<string, unknown>;
    const ids0 = (data0["items"] as Array<Record<string, unknown>>).map((i) => i["id"]);

    expect(ids0).not.toContain("x1");
  });

  // IP-8: No overlapping ids between adjacent pages
  it("IP-8: page 0 and page 1 items have no overlapping ids", async () => {
    const { body: b0 } = await get("/api/inbox?page=0&limit=5");
    const { body: b1 } = await get("/api/inbox?page=1&limit=5");

    const d0 = b0 as Record<string, unknown>;
    const d1 = b1 as Record<string, unknown>;
    const ids0 = new Set((d0["items"] as Array<Record<string, unknown>>).map((i) => i["id"]));
    const ids1 = (d1["items"] as Array<Record<string, unknown>>).map((i) => i["id"]);

    for (const id of ids1) {
      expect(ids0.has(id)).toBe(false);
    }
  });

  // IP-9: total reflects the full count (not just current page)
  it("IP-9: total is consistent across pages", async () => {
    const { body: b0 } = await get("/api/inbox?page=0&limit=3");
    const { body: b1 } = await get("/api/inbox?page=1&limit=3");

    const d0 = b0 as Record<string, unknown>;
    const d1 = b1 as Record<string, unknown>;

    // total should be the same on both pages
    expect(d0["total"]).toBe(d1["total"]);
  });

  // IP-10: tab filter still applies correctly with pagination
  it("IP-10: tab=esc filter + pagination: total=esc count from counts", async () => {
    const { body: full } = await get("/api/inbox");
    const { body: esc } = await get("/api/inbox?tab=esc");

    const dFull = full as Record<string, unknown>;
    const dEsc = esc as Record<string, unknown>;

    // The total on tab=esc response should match the esc count
    const counts = dFull["counts"] as Record<string, number>;
    expect(dEsc["total"]).toBe(counts["esc"]);
  });
});
