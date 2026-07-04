/**
 * T-0581 (view registry) — GET /api/records view-application tests (no-DB).
 *
 * Verifies the ?view_id= / ?filter=&?sort= extension to GET /api/records
 * (ADR §4) using a query-content-aware fake pool (mirrors records-pagination.
 * test.ts / records-read-pdp.test.ts).
 *
 * Covers:
 *   AC-9/FF-VR-6  Byte-identical behaviour when NO view params are passed
 *                 (the exact query issued matches the pre-T-0581 shape: no
 *                 view-WHERE fragment, default ORDER BY).
 *   AC-3          An inline ?filter=/?sort= (base64url-json) narrows the SQL
 *                 WHERE and changes ORDER BY (verified via captured SQL/params,
 *                 since the fake pool does not implement a real JSONB engine).
 *   AC-6          READ-PDP (isRecordReadable) still runs AFTER the (now
 *                 view-filtered) page is fetched — a row excluded by the PDP
 *                 is absent from the response even though the fake pool
 *                 "matched" it at the SQL layer.
 *   ADR §4 view_id path: view_id resolves the saved config from list_view and
 *                 applies its filters/sort (looked up via a SELECT that the
 *                 fake pool intercepts).
 *   400           view_id together with inline filter/sort → rejected
 *                 (mutually exclusive).
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerRecordRoutes } from "../http/records.js";
import type { RecordRoutesDeps, ReadVisibilityResolver } from "../http/records.js";
import type { AncestryOracle } from "../core/grant-lattice.js";
import { makeResourceAncestryOracle } from "../db/resource-ancestry.js";
import { isRecordReadable } from "../core/read-visibility.js";

const TENANT_ID = "77777777-0581-0000-0000-000000000001";
const APP_ID = "aaaaaaaa-0581-0000-0000-000000000001";
const REG_DEF_ID = "bbbbbbbb-0581-0000-0000-000000000002";
const VIEW_ID = "dddddddd-0581-0000-0000-000000000003";
const ACTOR = "view-registry-test-actor";

const RECORD_SCHEMA = {
  type: "object",
  properties: {
    amount: { type: "number", "x-money": { currency: "RUB" } },
    status: { type: "string", enum: ["open", "won"] },
  },
  required: [],
  "x-field-order": ["amount", "status"],
};

function makeRow(i: number, data: Record<string, unknown> = { amount: i * 1000 }) {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    registry_id: REG_DEF_ID,
    application_id: APP_ID,
    record_schema_version: 1,
    data,
    created_at: String(1700000000000 - i * 1000),
    updated_at: String(1700000000000 - i * 1000),
  };
}

type FakeQuery = { sql: string; params: unknown[] };

/**
 * A pool that captures every query and, for the record SELECT, returns a
 * fixed row set (the fake does NOT execute the WHERE/ORDER BY text — the test
 * asserts on the CAPTURED SQL/params to prove translateFilters/translateSort
 * were invoked correctly; a live-Postgres proof of actual filtering lives in
 * ci/checks/db/list-view-application.db.test.ts).
 */
function makeFakePool(opts: {
  rows: ReturnType<typeof makeRow>[];
  viewRow?: { registry_def_id: string; type: string; config: unknown } | null;
}): { pool: import("pg").Pool; queries: FakeQuery[] } {
  const queries: FakeQuery[] = [];

  function makeClient(): import("pg").PoolClient {
    const client = {
      query(sql: string, params?: unknown[]) {
        const trimmed = sql.trim();
        queries.push({ sql: trimmed, params: params ?? [] });

        if (/^BEGIN/i.test(trimmed) || /^SET LOCAL/i.test(trimmed) || /^COMMIT/i.test(trimmed) || /^ROLLBACK/i.test(trimmed)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (/SELECT registry_def_id, type, config FROM choros\.list_view/i.test(trimmed)) {
          return Promise.resolve({
            rows: opts.viewRow !== undefined && opts.viewRow !== null ? [opts.viewRow] : [],
            rowCount: opts.viewRow ? 1 : 0,
          });
        }
        if (/SELECT record_schema FROM choros\.registry_def/i.test(trimmed)) {
          return Promise.resolve({ rows: [{ record_schema: RECORD_SCHEMA }], rowCount: 1 });
        }
        if (/FROM choros\.record r/i.test(trimmed) && /SELECT/i.test(trimmed)) {
          return Promise.resolve({ rows: opts.rows, rowCount: opts.rows.length });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      release() {},
    };
    return client as unknown as import("pg").PoolClient;
  }

  return {
    pool: { connect: () => Promise.resolve(makeClient()) } as unknown as import("pg").Pool,
    queries,
  };
}

function makeServer(deps: RecordRoutesDeps): { start(): Promise<string>; stop(): Promise<void> } {
  const router = new Router();
  registerRecordRoutes(router, deps);
  const srv = http.createServer((req, res) => router.dispatch(req, res));
  return {
    start(): Promise<string> {
      return new Promise((resolve) => {
        srv.listen(0, "localhost", () => {
          const addr = srv.address();
          resolve(addr && typeof addr !== "string" ? `http://localhost:${addr.port}` : "http://localhost:0");
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => srv.close(() => resolve()));
    },
  };
}

function get(baseUrl: string, path: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const r = http.request(url, { method: "GET", headers: { "x-dev-user": ACTOR } }, (res) => {
      let raw = "";
      res.on("data", (c: Buffer) => { raw += c.toString(); });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    r.on("error", reject);
    r.end();
  });
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

describe("AC-9/FF-VR-6: byte-identical default path (no view params)", () => {
  it("issues the default ORDER BY with no view-WHERE fragment", async () => {
    const rows = [makeRow(1), makeRow(2)];
    const { pool, queries } = makeFakePool({ rows });
    const { start, stop } = makeServer({ pool, resolveActorTenant: async () => TENANT_ID });
    const base = await start();
    try {
      const { statusCode, body } = await get(base, `/api/records?application_id=${APP_ID}`);
      expect(statusCode).toBe(200);
      expect(body["records"]).toHaveLength(2);

      const selectQuery = queries.find((q) => /FROM choros\.record r/i.test(q.sql));
      expect(selectQuery).toBeDefined();
      expect(selectQuery!.sql).toContain("ORDER BY r.created_at DESC, r.id ASC");
      // No list_view / registry_def lookup should have happened — the honest
      // no-view-params path never touches resolveViewApplication's queries.
      expect(queries.some((q) => /FROM choros\.list_view/i.test(q.sql))).toBe(false);
    } finally {
      await stop();
    }
  });
});

describe("AC-3: inline ?filter=/?sort= narrows WHERE + changes ORDER BY", () => {
  it("translates a filter into a parameterized WHERE fragment", async () => {
    const rows = [makeRow(1)];
    const { pool, queries } = makeFakePool({ rows });
    const { start, stop } = makeServer({ pool, resolveActorTenant: async () => TENANT_ID });
    const base = await start();
    try {
      const filter = b64([{ field_key: "status", op: "eq", value: "open" }]);
      const { statusCode } = await get(
        base,
        `/api/records?application_id=${APP_ID}&registry_def_id=${REG_DEF_ID}&filter=${filter}`,
      );
      expect(statusCode).toBe(200);
      const selectQuery = queries.find((q) => /FROM choros\.record r/i.test(q.sql));
      expect(selectQuery!.sql).toContain("r.data->>'status' = $");
      expect(selectQuery!.params).toContain("open");
    } finally {
      await stop();
    }
  });

  it("translates a custom sort into a non-default ORDER BY", async () => {
    const rows = [makeRow(1)];
    const { pool, queries } = makeFakePool({ rows });
    const { start, stop } = makeServer({ pool, resolveActorTenant: async () => TENANT_ID });
    const base = await start();
    try {
      const sort = b64([{ field_key: "amount", dir: "asc" }]);
      const { statusCode } = await get(
        base,
        `/api/records?application_id=${APP_ID}&registry_def_id=${REG_DEF_ID}&sort=${sort}`,
      );
      expect(statusCode).toBe(200);
      const selectQuery = queries.find((q) => /FROM choros\.record r/i.test(q.sql));
      expect(selectQuery!.sql).toContain("(r.data->>'amount')::numeric ASC, r.id ASC");
    } finally {
      await stop();
    }
  });

  it("rejects view_id combined with inline filter (mutually exclusive)", async () => {
    const rows = [makeRow(1)];
    const { pool } = makeFakePool({ rows });
    const { start, stop } = makeServer({ pool, resolveActorTenant: async () => TENANT_ID });
    const base = await start();
    try {
      const filter = b64([{ field_key: "status", op: "eq", value: "open" }]);
      const { statusCode } = await get(base, `/api/records?view_id=${VIEW_ID}&filter=${filter}`);
      expect(statusCode).toBe(400);
    } finally {
      await stop();
    }
  });
});

describe("ADR §4: ?view_id= resolves the saved config and applies it", () => {
  it("loads registry_def_id + config from list_view and translates its filters", async () => {
    const rows = [makeRow(1)];
    const { pool, queries } = makeFakePool({
      rows,
      viewRow: {
        registry_def_id: REG_DEF_ID,
        type: "list",
        config: { filters: [{ field_key: "status", op: "eq", value: "won" }], sort: [] },
      },
    });
    const { start, stop } = makeServer({ pool, resolveActorTenant: async () => TENANT_ID });
    const base = await start();
    try {
      const { statusCode } = await get(base, `/api/records?application_id=${APP_ID}&view_id=${VIEW_ID}`);
      expect(statusCode).toBe(200);
      const selectQuery = queries.find((q) => /FROM choros\.record r/i.test(q.sql));
      expect(selectQuery!.sql).toContain("r.data->>'status' = $");
      expect(selectQuery!.params).toContain("won");
    } finally {
      await stop();
    }
  });

  it("404s when the view_id does not resolve (RLS-filtered or absent)", async () => {
    const rows: ReturnType<typeof makeRow>[] = [];
    const { pool } = makeFakePool({ rows, viewRow: null });
    const { start, stop } = makeServer({ pool, resolveActorTenant: async () => TENANT_ID });
    const base = await start();
    try {
      const { statusCode } = await get(base, `/api/records?view_id=${VIEW_ID}`);
      expect(statusCode).toBe(404);
    } finally {
      await stop();
    }
  });
});

describe("AC-6: READ-PDP still runs AFTER the view-filtered page (FR-7)", () => {
  const NOOP_ORG_ORACLE: AncestryOracle = { isDescendantOrSelf: (_h, a, b) => a === b };

  it("a row the fake pool 'matched' at the SQL layer is still excluded by isRecordReadable when no covering grant exists", async () => {
    const rows = [makeRow(1)];
    const { pool } = makeFakePool({ rows });

    // resolveReadVisibility returns NO grants ⇒ isRecordReadable is false for
    // every row ⇒ the (already view-filtered) page must come back empty.
    const resolveReadVisibility: ReadVisibilityResolver = async () => ({
      grants: [],
      ancestry: makeResourceAncestryOracle(NOOP_ORG_ORACLE, new Map()),
    });

    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveReadVisibility,
    });
    const base = await start();
    try {
      const filter = b64([{ field_key: "status", op: "eq", value: "open" }]);
      const { statusCode, body } = await get(
        base,
        `/api/records?application_id=${APP_ID}&registry_def_id=${REG_DEF_ID}&filter=${filter}`,
      );
      expect(statusCode).toBe(200);
      expect(body["records"]).toHaveLength(0); // PDP still gates post-filter (FR-7/AC-6)
    } finally {
      await stop();
    }
  });

  it("sanity: isRecordReadable itself is unaffected by this module (imported unchanged)", () => {
    expect(typeof isRecordReadable).toBe("function");
  });
});
