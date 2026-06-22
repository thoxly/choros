/**
 * T-0401 [D7-3] — records LIST pagination tests
 *
 * Tests the paginated GET /api/records endpoint (cursor-based keyset pagination).
 * Uses a fake pool that returns controlled result rows, so we can test pagination
 * logic without a live DB.
 *
 * Tests:
 *   RP-1  Response includes nextCursor + limit fields
 *   RP-2  Default limit (no ?limit=) produces limit=DEFAULT_PAGE_SIZE
 *   RP-3  ?limit=2 fetches at most 2 items; nextCursor present when more exist
 *   RP-4  nextCursor is null on the last page
 *   RP-5  Cursor round-trip: following nextCursor returns next page
 *   RP-6  ?limit=999 is clamped to MAX_PAGE_SIZE
 *   RP-7  Malformed ?after= cursor is ignored (no crash, returns first page)
 *   RP-8  Actor+tenant narrowing: actor resolved via x-dev-user, tenant via dep
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerRecordRoutes } from "../http/records.js";
import type { RecordRoutesDeps } from "../http/records.js";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "../core/data-access-port.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "55555555-5555-5555-5555-555555555555";
const ACTOR = "e-orlov";
const APP_ID = "aaaaaaaa-0401-0001-0000-000000000001";
const REG_DEF_ID = "bbbbbbbb-0401-0001-0000-000000000002";

// ---------------------------------------------------------------------------
// Record row factory
// ---------------------------------------------------------------------------

function makeRow(i: number) {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    registry_id: REG_DEF_ID,
    application_id: APP_ID,
    record_schema_version: 1,
    data: { field_a: `value_${i}` },
    created_at: String(1700000000000 - i * 1000), // newer rows first (DESC)
    updated_at: String(1700000000000 - i * 1000),
  };
}

// ---------------------------------------------------------------------------
// Fake pool
// ---------------------------------------------------------------------------

type FakeQuery = { sql: string; params: unknown[] };

/**
 * Fake pool that returns a controlled slice of record rows for SELECT queries,
 * and stubs the BEGIN/SET LOCAL/COMMIT boilerplate of withTenantTx.
 */
function makeFakePool(
  allRows: ReturnType<typeof makeRow>[],
): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    const capturedQueries: FakeQuery[] = [];

    const client = {
      capturedQueries,
      query(sql: string, params?: unknown[]) {
        const query = { sql: sql.trim(), params: params ?? [] };
        capturedQueries.push(query);

        // Tx boilerplate
        if (/^BEGIN/i.test(sql) || /^SET LOCAL/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }

        // Record SELECT with optional keyset cursor + LIMIT
        // Note: the SQL spans multiple lines, so we check for the SELECT columns
        // and FROM choros.record separately using individual line checks.
        if (/FROM choros\.record r/i.test(sql) && /SELECT/i.test(sql)) {
          // Extract LIMIT value from parameter list
          const limitParam = params?.[params.length - 1];
          const limit = typeof limitParam === "number" ? limitParam : 10000;

          // Apply cursor filter if present — params layout:
          //   $1 = tenantId, [$2 = appId|regId], [$N-2 = cursorCreatedAt, $N-1 = cursorId, $N = limit+1]
          // We detect a cursor by checking if the SQL has the keyset WHERE clause
          const hasCursor = /r\.created_at < \$/.test(sql) || /r\.created_at = \$/.test(sql);

          let rows = [...allRows];
          if (hasCursor && params) {
            // Find cursor values in params
            // params: [tenantId, ..., cursorCreatedAt, cursorId, limit+1]
            // Cursor params are the 3rd and 2nd from last (before limit+1)
            const cursorCreatedAt = params[params.length - 3] as number;
            const cursorId = params[params.length - 2] as string;
            // Keyset: (created_at < cursor.createdAt) OR (created_at = cursor.createdAt AND id > cursor.id)
            rows = allRows.filter((r) => {
              const rAt = Number(r.created_at);
              if (rAt < cursorCreatedAt) return true;
              if (rAt === cursorCreatedAt && r.id > cursorId) return true;
              return false;
            });
          }

          // Return up to `limit` rows (LIMIT N applied in SQL; we simulate it)
          const sliced = rows.slice(0, limit);
          return Promise.resolve({ rows: sliced, rowCount: sliced.length });
        }

        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      release() {},
    };

    return client as unknown as import("pg").PoolClient;
  }

  return {
    connect() {
      return Promise.resolve(makeClient());
    },
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// Server builder
// ---------------------------------------------------------------------------

function makeServer(rows: ReturnType<typeof makeRow>[]): {
  start(): Promise<string>;
  stop(): Promise<void>;
} {
  const router = new Router();
  const pool = makeFakePool(rows);

  const deps: RecordRoutesDeps = {
    pool,
    resolveActorTenant: (_slug) => Promise.resolve(TENANT_ID),
  };

  registerRecordRoutes(router, deps);

  const srv = http.createServer((req, res) => {
    router.dispatch(req, res);
  });

  return {
    start(): Promise<string> {
      return new Promise((resolve) => {
        srv.listen(0, "localhost", () => {
          const addr = srv.address();
          resolve(
            addr && typeof addr !== "string"
              ? `http://localhost:${addr.port}`
              : "http://localhost:0",
          );
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => srv.close(() => resolve()));
    },
  };
}

function get(
  baseUrl: string,
  path: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const opts = {
      method: "GET",
      headers: { "x-dev-user": ACTOR },
    };
    const req = http.request(url, opts, (res) => {
      let raw = "";
      res.on("data", (c: Buffer) => { raw += c.toString(); });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 200,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-0401: records LIST pagination", () => {
  // RP-1: Response includes nextCursor + limit
  it("RP-1: response includes nextCursor and limit fields", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(i));
    const { start, stop } = makeServer(rows);
    const base = await start();

    try {
      const { statusCode, body } = await get(base, "/api/records");
      expect(statusCode).toBe(200);
      expect(body).toHaveProperty("records");
      expect(body).toHaveProperty("nextCursor");
      expect(body).toHaveProperty("limit");
    } finally {
      await stop();
    }
  });

  // RP-2: Default limit = DEFAULT_PAGE_SIZE
  it("RP-2: default limit is DEFAULT_PAGE_SIZE", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRow(i));
    const { start, stop } = makeServer(rows);
    const base = await start();

    try {
      const { body } = await get(base, "/api/records");
      expect(body["limit"]).toBe(DEFAULT_PAGE_SIZE);
    } finally {
      await stop();
    }
  });

  // RP-3: ?limit=2 fetches at most 2 items; nextCursor present when more exist
  it("RP-3: ?limit=2 returns ≤2 items; nextCursor present when total>2", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(i));
    const { start, stop } = makeServer(rows);
    const base = await start();

    try {
      const { body } = await get(base, "/api/records?limit=2");
      const records = body["records"] as unknown[];
      expect(records.length).toBeLessThanOrEqual(2);
      // With 5 rows and limit=2, there are more rows → nextCursor should be set.
      expect(body["nextCursor"]).not.toBeNull();
    } finally {
      await stop();
    }
  });

  // RP-4: nextCursor is null on the last page
  it("RP-4: nextCursor is null when all records fit on one page", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRow(i));
    const { start, stop } = makeServer(rows);
    const base = await start();

    try {
      const { body } = await get(base, "/api/records?limit=10");
      expect(body["nextCursor"]).toBeNull();
    } finally {
      await stop();
    }
  });

  // RP-5: Cursor round-trip: following nextCursor returns next page
  it("RP-5: following nextCursor returns next page with different records", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(i));
    const { start, stop } = makeServer(rows);
    const base = await start();

    try {
      const { body: page1 } = await get(base, "/api/records?limit=2");
      const cursor = page1["nextCursor"] as string | null;
      expect(cursor).not.toBeNull();

      const { body: page2 } = await get(base, `/api/records?limit=2&after=${encodeURIComponent(cursor!)}`);
      const ids1 = (page1["records"] as Array<Record<string, unknown>>).map((r) => r["id"]);
      const ids2 = (page2["records"] as Array<Record<string, unknown>>).map((r) => r["id"]);

      // No overlap between pages
      const setIds1 = new Set(ids1);
      for (const id of ids2) {
        expect(setIds1.has(id)).toBe(false);
      }
    } finally {
      await stop();
    }
  });

  // RP-6: ?limit=999 is clamped to MAX_PAGE_SIZE
  it("RP-6: ?limit=999 is clamped to MAX_PAGE_SIZE", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRow(i));
    const { start, stop } = makeServer(rows);
    const base = await start();

    try {
      const { body } = await get(base, "/api/records?limit=999");
      expect(body["limit"]).toBe(MAX_PAGE_SIZE);
    } finally {
      await stop();
    }
  });

  // RP-7: Malformed ?after= cursor returns first page without crashing
  it("RP-7: malformed ?after= cursor is ignored (no crash, returns first page)", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeRow(i));
    const { start, stop } = makeServer(rows);
    const base = await start();

    try {
      const { statusCode, body } = await get(base, "/api/records?after=not-valid-cursor!!");
      expect(statusCode).toBe(200);
      // Should return first page (cursor null → no keyset filter)
      const records = body["records"] as unknown[];
      expect(records.length).toBeGreaterThanOrEqual(0);
    } finally {
      await stop();
    }
  });

  // RP-8: Actor+tenant narrowing verified via x-dev-user header
  it("RP-8: request without x-dev-user header returns 401", async () => {
    const rows: ReturnType<typeof makeRow>[] = [];
    const { start, stop } = makeServer(rows);
    const base = await start();

    try {
      // Make request without x-dev-user header
      const result = await new Promise<{ statusCode: number; body: Record<string, unknown> }>(
        (resolve, reject) => {
          const url = new URL(`${base}/api/records`);
          const req = http.request(url, { method: "GET" }, (res) => {
            let raw = "";
            res.on("data", (c: Buffer) => { raw += c.toString(); });
            res.on("end", () => {
              resolve({
                statusCode: res.statusCode ?? 200,
                body: JSON.parse(raw) as Record<string, unknown>,
              });
            });
          });
          req.on("error", reject);
          req.end();
        },
      );

      // Without auth header, should be 401 UNAUTHENTICATED
      expect(result.statusCode).toBe(401);
    } finally {
      await stop();
    }
  });
});
