/**
 * T-0181 · T-0121g — Floor-1 aggregate renderer + Floor-2 RLS-gated data API unit tests.
 *
 * No DATABASE_URL required. Uses FakePool with sequenced row-sets.
 * Mirrors report-pages.test.ts (T-0178) infrastructure pattern.
 *
 * AC coverage:
 *   AC-1  Floor-1 GET /api/report-pages/:id/render → 200 { page_id, floor:'1', metrics }
 *   AC-2  Floor-1: metrics executed server-side (no LLM, deterministic — NF-4)
 *   AC-3  Floor-1: 400 WRONG_FLOOR when page is floor=2
 *   AC-4  Floor-2 GET /api/report-pages/:id/data → 200 { records, total_count, limit, offset }
 *   AC-5  Floor-2: 400 WRONG_FLOOR when page is floor=1
 *   AC-6  Floor-2: 403 NO_READ_GRANT when authz denied
 *   AC-7  Floor-2: limit capped at MAX_DATA_LIMIT (100)
 *   AC-8  Floor-2: 400 on invalid registry_def_id
 *   AC-9  404 on non-existent page (both endpoints)
 *   AC-10 401 on missing auth header
 *   AC-11 INJECTION PROBE: field_key with quote/semicolons/space → 400 UNSAFE_FIELD_KEY
 *   AC-12 INJECTION PROBE: field_key ';DROP TABLE...' → 400 UNSAFE_FIELD_KEY (not 422)
 *   AC-13 field_key exists in charset guard but not in schema → 422 FIELD_KEY_NOT_IN_SCHEMA
 *   AC-14 group_by validation: UNSAFE_FIELD_KEY on metacharacters
 *   AC-15 filter.value is parameterized — no interpolation (structural)
 *   AC-16 ReportPageRenderAuthzDeps injectable (FF-NO-2ND-AUTHZ)
 *
 * INJECTION PROBE (mandatory per task spec):
 *   field_key = "amount';DROP TABLE choros.record;--"  → 400 UNSAFE_FIELD_KEY
 *   field_key = "ok_field"  + not in schema            → 422 FIELD_KEY_NOT_IN_SCHEMA
 *   Both probes must fire BEFORE any SQL is constructed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import {
  registerReportPageRenderRoutes,
  resetRenderPoolForTesting,
  MAX_DATA_LIMIT,
  type ReportPageRenderAuthzDeps,
  type ReportAggReadVisibilityResolver,
} from "../http/report-page-render.js";
import { Router } from "../http/router.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Fake pool infrastructure (mirrors report-pages.test.ts)
// ---------------------------------------------------------------------------

interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number;
}

class FakePoolClient {
  private _queryIndex = 0;
  private _rowSets: unknown[][];
  public queries: string[] = [];

  constructor(rowSets: unknown[][]) {
    this._rowSets = rowSets;
  }

  async query(sql: string, _params?: unknown[]): Promise<FakeQueryResult> {
    this.queries.push(sql.trim().slice(0, 80));
    const rows = (this._rowSets[this._queryIndex] ?? []) as unknown[];
    this._queryIndex++;
    return { rows, rowCount: rows.length };
  }

  release(): void { /* no-op */ }
}

function makeFakePool(rowSets: unknown[][]): import("pg").Pool {
  return {
    connect: async () => new FakePoolClient(rowSets) as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// Auth deps
// ---------------------------------------------------------------------------

const allowDeps: ReportPageRenderAuthzDeps = {
  checkReadGrant: async () => ({ ok: true }),
};

const denyDeps: ReportPageRenderAuthzDeps = {
  checkReadGrant: async () => ({ ok: false, reason: "no_read_grant_on_application" }),
};

// Scope-scoped allow/deny: allow only for VALID_APP_ID, deny for any other app_id.
const scopedAllowDeps = (allowedAppId: string): ReportPageRenderAuthzDeps => ({
  checkReadGrant: async (_pool, _tenantId, _actorId, appId, _nowMs) => {
    if (appId === allowedAppId) return { ok: true };
    return { ok: false, reason: "no_read_grant_on_application" };
  },
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function buildTestServer(
  deps: ReportPageRenderAuthzDeps,
  fakePool?: import("pg").Pool,
): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  registerReportPageRenderRoutes(router, fakePool, deps);
  const server = http.createServer((req, res) => {
    router.dispatch(req, res);
  });
  return {
    server,
    baseUrl: () => {
      const addr = server.address() as { port: number } | null;
      if (!addr) throw new Error("server not listening");
      return `http://127.0.0.1:${addr.port}`;
    },
  };
}

async function httpReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const reqHeaders: Record<string, string> = { ...headers };
    if (buf) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = String(buf.length);
    }
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method,
      headers: reqHeaders,
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let json: unknown = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

const DEV_ACTOR = "e-owner";
const VALID_PAGE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VALID_REG_DEF_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VALID_APP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// Fake Floor-1 page row
const fakeFloor1Page = {
  id: VALID_PAGE_ID,
  app_id: VALID_APP_ID,
  floor: "1",
  page_def: [
    { source_registry_def_id: VALID_REG_DEF_ID, field_key: "amount", agg: "sum" },
  ],
  page_code: null,
};

// Fake Floor-2 page row
const fakeFloor2Page = {
  id: VALID_PAGE_ID,
  app_id: VALID_APP_ID,
  floor: "2",
  page_def: null,
  page_code: "export default function() { return <div/>; }",
};

// Fake registry_def with 'amount' field
const fakeRegistryDefRow = {
  id: VALID_REG_DEF_ID,
  record_schema: { properties: { amount: { type: "number" } } },
};

// Fake registry_def for floor-2 data tests
const fakeRegDefForData = { id: VALID_REG_DEF_ID };

// Fake record rows
const fakeRecordRow = {
  id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  data: { amount: 42 },
  created_at: "0",
  updated_at: "0",
};

// ---------------------------------------------------------------------------
// Row sequence helpers for Floor-1 render
// Row sequence: BEGIN, SET LOCAL ×2, SELECT report_page, SELECT registry_def,
//               SELECT aggregate, COMMIT
// ---------------------------------------------------------------------------

function makeFloor1RenderRowSets(aggResult: unknown): unknown[][] {
  return [
    [],                    // BEGIN
    [],                    // SET LOCAL tenant_id
    [],                    // SET LOCAL search_path
    [fakeFloor1Page],      // SELECT report_page
    [fakeRegistryDefRow],  // SELECT registry_def (schema)
    [{ agg_result: aggResult }], // SELECT aggregate
    [],                    // COMMIT
  ];
}

// ---------------------------------------------------------------------------
// AC-16: ReportPageRenderAuthzDeps injectable (structural)
// ---------------------------------------------------------------------------

describe("AC-16 — ReportPageRenderAuthzDeps injectable", () => {
  it("registerReportPageRenderRoutes accepts deps parameter", () => {
    const router = new Router();
    expect(() =>
      registerReportPageRenderRoutes(router, undefined, allowDeps),
    ).not.toThrow();
  });

  it("MAX_DATA_LIMIT is 100", () => {
    expect(MAX_DATA_LIMIT).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// AC-10: 401 UNAUTHENTICATED on missing header
// ---------------------------------------------------------------------------

describe("AC-10 — 401 on missing auth header", () => {
  let server: http.Server;
  let baseUrl: () => string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        resetRenderPoolForTesting();
        const { server: s, baseUrl: b } = buildTestServer(allowDeps, makeFakePool([]));
        server = s;
        baseUrl = b;
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  it("GET /render without x-dev-user → 401", async () => {
    const { status } = await httpReq(
      "GET",
      baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
      {},
    );
    expect(status).toBe(401);
  });

  it("GET /data without x-dev-user → 401", async () => {
    const { status } = await httpReq(
      "GET",
      baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/data?registry_def_id=${VALID_REG_DEF_ID}`,
      {},
    );
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// AC-1/AC-2: Floor-1 render → 200 with metrics
// ---------------------------------------------------------------------------

describe("AC-1/AC-2 — Floor-1 render returns 200 with metrics", () => {
  let server: http.Server;
  let baseUrl: () => string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        resetRenderPoolForTesting();
        const { server: s, baseUrl: b } = buildTestServer(
          allowDeps,
          makeFakePool(makeFloor1RenderRowSets("12345.00")),
        );
        server = s;
        baseUrl = b;
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  it("returns 200 with page_id, floor=1, and metrics array", async () => {
    const { status, json } = await httpReq(
      "GET",
      baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
      { "x-dev-user": DEV_ACTOR },
    );
    expect(status).toBe(200);
    const body = json as Record<string, unknown>;
    expect(body["page_id"]).toBe(VALID_PAGE_ID);
    expect(body["floor"]).toBe("1");
    expect(Array.isArray(body["metrics"])).toBe(true);
    const metrics = body["metrics"] as unknown[];
    expect(metrics.length).toBe(1);
    const m = metrics[0] as Record<string, unknown>;
    expect(m["field_key"]).toBe("amount");
    expect(m["agg"]).toBe("sum");
    expect(m["result"]).toBe("12345.00");
    expect(m["source_registry_def_id"]).toBe(VALID_REG_DEF_ID);
  });
});

// ---------------------------------------------------------------------------
// AC-3: Floor-1 render on floor=2 page → 400 WRONG_FLOOR
// ---------------------------------------------------------------------------

describe("AC-3 — render on floor=2 page → 400 WRONG_FLOOR", () => {
  it("returns 400 WRONG_FLOOR", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [
      [],                 // BEGIN
      [],                 // SET LOCAL tenant_id
      [],                 // SET LOCAL search_path
      [fakeFloor2Page],   // SELECT report_page → floor=2
      [],                 // COMMIT
    ];
    const { server, baseUrl } = buildTestServer(allowDeps, makeFakePool(rowSets));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(400);
      const body = json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("WRONG_FLOOR");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// AC-9: 404 on non-existent page
// ---------------------------------------------------------------------------

describe("AC-9 — 404 on non-existent page", () => {
  it("render: 404 when page not found", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [
      [],    // BEGIN
      [],    // SET LOCAL tenant_id
      [],    // SET LOCAL search_path
      [],    // SELECT report_page → empty → 404
      [],    // COMMIT
    ];
    const { server, baseUrl } = buildTestServer(allowDeps, makeFakePool(rowSets));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("data: 404 when page not found", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [
      [],    // BEGIN
      [],    // SET LOCAL tenant_id
      [],    // SET LOCAL search_path
      [],    // SELECT report_page → empty → 404
      [],    // COMMIT
    ];
    const { server, baseUrl } = buildTestServer(allowDeps, makeFakePool(rowSets));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/data?registry_def_id=${VALID_REG_DEF_ID}`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// AC-11/AC-12: INJECTION PROBE — field_key with injection chars → 400 UNSAFE_FIELD_KEY
// This is the MANDATORY adversarial AC per task spec.
// ---------------------------------------------------------------------------

describe("AC-11/AC-12 — INJECTION PROBE: unsafe field_key rejected before SQL construction", () => {
  // The injection probe works by placing a crafted field_key in page_def.
  // The fake pool returns a page with injected field_key in page_def,
  // and a registry_def schema that INCLUDES that key (to ensure the charset
  // guard fires FIRST, before the schema whitelist check).

  const makeInjectionRowSets = (injectedFieldKey: string): unknown[][] => {
    return [
      [],   // BEGIN
      [],   // SET LOCAL tenant_id
      [],   // SET LOCAL search_path
      // SELECT report_page — page_def contains injected field_key
      [{
        id: VALID_PAGE_ID,
        app_id: VALID_APP_ID,
        floor: "1",
        page_def: [
          {
            source_registry_def_id: VALID_REG_DEF_ID,
            field_key: injectedFieldKey,
            agg: "sum",
          },
        ],
        page_code: null,
      }],
      // We should never reach here — guard fires before schema lookup
    ];
  };

  it("AC-11: field_key with single-quote → 400 UNSAFE_FIELD_KEY", async () => {
    resetRenderPoolForTesting();
    const injectedKey = "amount'";  // SQL injection attempt
    const { server, baseUrl } = buildTestServer(
      allowDeps,
      makeFakePool(makeInjectionRowSets(injectedKey)),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(400);
      const body = json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("UNSAFE_FIELD_KEY");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("AC-12: field_key = ';DROP TABLE choros.record;--' → 400 UNSAFE_FIELD_KEY", async () => {
    resetRenderPoolForTesting();
    const injectedKey = "';DROP TABLE choros.record;--";
    const { server, baseUrl } = buildTestServer(
      allowDeps,
      makeFakePool(makeInjectionRowSets(injectedKey)),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(400);
      const body = json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("UNSAFE_FIELD_KEY");
      // Confirm: code is UNSAFE_FIELD_KEY (charset guard), NOT FIELD_KEY_NOT_IN_SCHEMA
      // This proves the guard fires BEFORE schema lookup (fail-fast order)
      expect(err?.["code"]).not.toBe("FIELD_KEY_NOT_IN_SCHEMA");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("AC-11: field_key with semicolon → 400 UNSAFE_FIELD_KEY", async () => {
    resetRenderPoolForTesting();
    const injectedKey = "amount;DELETE";
    const { server, baseUrl } = buildTestServer(
      allowDeps,
      makeFakePool(makeInjectionRowSets(injectedKey)),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(400);
      const body = json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("UNSAFE_FIELD_KEY");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("AC-11: field_key with space → 400 UNSAFE_FIELD_KEY", async () => {
    resetRenderPoolForTesting();
    const injectedKey = "amount OR 1=1";
    const { server, baseUrl } = buildTestServer(
      allowDeps,
      makeFakePool(makeInjectionRowSets(injectedKey)),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(400);
      const body = json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("UNSAFE_FIELD_KEY");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// AC-13: field_key safe charset but not in schema → 422 FIELD_KEY_NOT_IN_SCHEMA
// ---------------------------------------------------------------------------

describe("AC-13 — FIELD_KEY_NOT_IN_SCHEMA (safe charset, missing in schema)", () => {
  it("safe-charset field_key absent from record_schema → 422", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [
      [],   // BEGIN
      [],   // SET LOCAL tenant_id
      [],   // SET LOCAL search_path
      // page_def references 'missing_field' (safe charset)
      [{
        id: VALID_PAGE_ID,
        app_id: VALID_APP_ID,
        floor: "1",
        page_def: [
          {
            source_registry_def_id: VALID_REG_DEF_ID,
            field_key: "missing_field",
            agg: "sum",
          },
        ],
        page_code: null,
      }],
      // registry_def schema does NOT have 'missing_field'
      [{ id: VALID_REG_DEF_ID, record_schema: { properties: { amount: { type: "number" } } } }],
      // We should NOT reach aggregate query
    ];
    const { server, baseUrl } = buildTestServer(allowDeps, makeFakePool(rowSets));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(422);
      const body = json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("FIELD_KEY_NOT_IN_SCHEMA");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// AC-14: group_by with metacharacters → 400 UNSAFE_FIELD_KEY
// ---------------------------------------------------------------------------

describe("AC-14 — group_by injection guard", () => {
  it("group_by with quote char → 400 UNSAFE_FIELD_KEY", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [
      [],
      [],
      [],
      [{
        id: VALID_PAGE_ID,
        app_id: VALID_APP_ID,
        floor: "1",
        page_def: [
          {
            source_registry_def_id: VALID_REG_DEF_ID,
            field_key: "amount",
            agg: "sum",
            group_by: "status'--",  // injection in group_by
          },
        ],
        page_code: null,
      }],
      [fakeRegistryDefRow],
    ];
    const { server, baseUrl } = buildTestServer(allowDeps, makeFakePool(rowSets));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(400);
      const body = json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("UNSAFE_FIELD_KEY");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: Floor-2 data API → 200 with records
// ---------------------------------------------------------------------------

describe("AC-4 — Floor-2 data API returns 200 with records", () => {
  it("returns 200 with records array and pagination metadata", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [
      [],                     // BEGIN
      [],                     // SET LOCAL tenant_id
      [],                     // SET LOCAL search_path
      [fakeFloor2Page],       // SELECT report_page
      [fakeRegDefForData],    // SELECT registry_def (existence check)
      [{ total: "1" }],       // SELECT COUNT(*)
      [fakeRecordRow],        // SELECT records
      [],                     // COMMIT
    ];
    const { server, baseUrl } = buildTestServer(allowDeps, makeFakePool(rowSets));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/data?registry_def_id=${VALID_REG_DEF_ID}`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(200);
      const body = json as Record<string, unknown>;
      expect(body["page_id"]).toBe(VALID_PAGE_ID);
      expect(body["floor"]).toBe("2");
      expect(body["registry_def_id"]).toBe(VALID_REG_DEF_ID);
      expect(Array.isArray(body["records"])).toBe(true);
      const records = body["records"] as unknown[];
      expect(records.length).toBe(1);
      expect(body["total_count"]).toBe(1);
      expect(body["limit"]).toBe(MAX_DATA_LIMIT);
      expect(body["offset"]).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5: Floor-2 data on floor=1 page → 400 WRONG_FLOOR
// ---------------------------------------------------------------------------

describe("AC-5 — Floor-2 data on floor=1 page → 400 WRONG_FLOOR", () => {
  it("returns 400 WRONG_FLOOR", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [
      [],
      [],
      [],
      [fakeFloor1Page],  // floor=1 page
      [],
    ];
    const { server, baseUrl } = buildTestServer(allowDeps, makeFakePool(rowSets));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/data?registry_def_id=${VALID_REG_DEF_ID}`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(400);
      const body = json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("WRONG_FLOOR");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6: Floor-2 data with denied read grant → 403 NO_READ_GRANT
// ---------------------------------------------------------------------------

describe("AC-6 — Floor-2 data: NO_READ_GRANT", () => {
  let server: http.Server;
  let baseUrl: () => string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        resetRenderPoolForTesting();
        // T-0193: page is loaded first (to get app_id), then denyDeps rejects.
        // Row sequence: BEGIN, SET LOCAL ×2, SELECT report_page, ROLLBACK.
        const rowSets: unknown[][] = [
          [],               // BEGIN
          [],               // SET LOCAL tenant_id
          [],               // SET LOCAL search_path
          [fakeFloor2Page], // SELECT report_page → page exists (floor=2)
          [],               // ROLLBACK (error path — denyDeps rejects after page load)
        ];
        const { server: s, baseUrl: b } = buildTestServer(denyDeps, makeFakePool(rowSets));
        server = s;
        baseUrl = b;
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  it("returns 403 NO_READ_GRANT", async () => {
    const { status, json } = await httpReq(
      "GET",
      baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/data?registry_def_id=${VALID_REG_DEF_ID}`,
      { "x-dev-user": "non-owner" },
    );
    expect(status).toBe(403);
    const body = json as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown> | undefined;
    expect(err?.["code"]).toBe("NO_READ_GRANT");
  });
});

// ---------------------------------------------------------------------------
// AC-7: limit capped at MAX_DATA_LIMIT
// ---------------------------------------------------------------------------

describe("AC-7 — limit capped at MAX_DATA_LIMIT", () => {
  it("limit=999 is silently capped to 100", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [
      [],
      [],
      [],
      [fakeFloor2Page],
      [fakeRegDefForData],
      [{ total: "0" }],
      [],    // empty records
      [],
    ];
    const { server, baseUrl } = buildTestServer(allowDeps, makeFakePool(rowSets));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/data?registry_def_id=${VALID_REG_DEF_ID}&limit=999`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(200);
      const body = json as Record<string, unknown>;
      expect(body["limit"]).toBe(MAX_DATA_LIMIT);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// AC-8: invalid registry_def_id → 400 VALIDATION
// ---------------------------------------------------------------------------

describe("AC-8 — invalid registry_def_id query param → 400", () => {
  let server: http.Server;
  let baseUrl: () => string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        resetRenderPoolForTesting();
        const { server: s, baseUrl: b } = buildTestServer(allowDeps, makeFakePool([]));
        server = s;
        baseUrl = b;
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  it("returns 400 VALIDATION on missing registry_def_id", async () => {
    const { status } = await httpReq(
      "GET",
      baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/data`,
      { "x-dev-user": DEV_ACTOR },
    );
    expect(status).toBe(400);
  });

  it("returns 400 VALIDATION on non-UUID registry_def_id", async () => {
    const { status } = await httpReq(
      "GET",
      baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/data?registry_def_id=not-a-uuid`,
      { "x-dev-user": DEV_ACTOR },
    );
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// AC-10-FLOOR1: Floor-1 render: 403 NO_READ_GRANT for non-genesis without grant
// ---------------------------------------------------------------------------

describe("AC-10-FLOOR1 — Floor-1 render: 403 NO_READ_GRANT when denied", () => {
  let server: http.Server;
  let baseUrl: () => string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        resetRenderPoolForTesting();
        // T-0193: page is loaded first (to get app_id), then denyDeps rejects.
        // Row sequence: BEGIN, SET LOCAL ×2, SELECT report_page, ROLLBACK.
        const rowSets: unknown[][] = [
          [],               // BEGIN
          [],               // SET LOCAL tenant_id
          [],               // SET LOCAL search_path
          [fakeFloor1Page], // SELECT report_page → page exists (floor=1)
          [],               // ROLLBACK (error path — denyDeps rejects after page load)
        ];
        const { server: s, baseUrl: b } = buildTestServer(denyDeps, makeFakePool(rowSets));
        server = s;
        baseUrl = b;
        server.listen(0, "127.0.0.1", resolve);
      }),
  );

  afterAll(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  it("Floor-1 render with denied read grant → 403 NO_READ_GRANT", async () => {
    const { status, json } = await httpReq(
      "GET",
      baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
      { "x-dev-user": "non-owner" },
    );
    expect(status).toBe(403);
    const body = json as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown> | undefined;
    expect(err?.["code"]).toBe("NO_READ_GRANT");
  });
});

// ---------------------------------------------------------------------------
// T-0193 (R-6): Two-app scope-containment probe
//
// A grant scoped to App-A must allow App-A pages and DENY App-B pages.
// Tests use scopedAllowDeps(allowedAppId) which returns ok:true only for
// the specific appId matching the grant scope.
// ---------------------------------------------------------------------------

const OTHER_APP_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb02";  // different from VALID_APP_ID

// Page belonging to OTHER_APP_ID
const fakeFloor1PageOtherApp = {
  id: VALID_PAGE_ID,
  app_id: OTHER_APP_ID,
  floor: "1",
  page_def: [
    { source_registry_def_id: VALID_REG_DEF_ID, field_key: "amount", agg: "sum" },
  ],
  page_code: null,
};

const fakeFloor2PageOtherApp = {
  id: VALID_PAGE_ID,
  app_id: OTHER_APP_ID,
  floor: "2",
  page_def: null,
  page_code: "export default function() { return <div/>; }",
};

describe("T-0193 R-6 — two-app scope-containment: grant on App-A, page of App-B → 403", () => {
  it("Floor-1 /render: App-B page with grant scoped to App-A → 403 NO_READ_GRANT", async () => {
    resetRenderPoolForTesting();
    // scopedAllowDeps(VALID_APP_ID): allows VALID_APP_ID, denies OTHER_APP_ID.
    // Page has app_id = OTHER_APP_ID → grant does NOT cover → 403.
    const rowSets: unknown[][] = [
      [],                        // BEGIN
      [],                        // SET LOCAL tenant_id
      [],                        // SET LOCAL search_path
      [fakeFloor1PageOtherApp],  // SELECT report_page → app_id=OTHER_APP_ID
      [],                        // ROLLBACK (error path)
    ];
    const { server, baseUrl } = buildTestServer(
      scopedAllowDeps(VALID_APP_ID),  // grant scoped to VALID_APP_ID only
      makeFakePool(rowSets),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(403);
      const body = json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("NO_READ_GRANT");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Floor-2 /data: App-B page with grant scoped to App-A → 403 NO_READ_GRANT", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [
      [],                        // BEGIN
      [],                        // SET LOCAL tenant_id
      [],                        // SET LOCAL search_path
      [fakeFloor2PageOtherApp],  // SELECT report_page → app_id=OTHER_APP_ID
      [],                        // ROLLBACK (error path)
    ];
    const { server, baseUrl } = buildTestServer(
      scopedAllowDeps(VALID_APP_ID),  // grant scoped to VALID_APP_ID only
      makeFakePool(rowSets),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/data?registry_def_id=${VALID_REG_DEF_ID}`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(403);
      const body = json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("NO_READ_GRANT");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Floor-1 /render: App-A page with grant scoped to App-A → 200", async () => {
    resetRenderPoolForTesting();
    // Page has app_id = VALID_APP_ID → grant covers → 200.
    const rowSets = makeFloor1RenderRowSets("42.00");
    const { server, baseUrl } = buildTestServer(
      scopedAllowDeps(VALID_APP_ID),  // grant scoped to VALID_APP_ID, matches page
      makeFakePool(rowSets),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Floor-2 /data: App-A page with grant scoped to App-A → 200", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [
      [],
      [],
      [],
      [fakeFloor2Page],       // app_id = VALID_APP_ID → grant covers
      [fakeRegDefForData],    // registry_def check
      [{ total: "0" }],       // COUNT(*)
      [],                     // empty records
      [],                     // COMMIT
    ];
    const { server, baseUrl } = buildTestServer(
      scopedAllowDeps(VALID_APP_ID),
      makeFakePool(rowSets),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status } = await httpReq(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/data?registry_def_id=${VALID_REG_DEF_ID}`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// T-0495 — GET /api/process-analytics process drill-down
//
// Verifies: (1) the optional ?process_key= query is threaded to the loaders as a
// bound SQL parameter (never interpolated); (2) the response carries the new
// `processKeys` selector list and `selectedProcess` echo; (3) auth is unchanged.
// ---------------------------------------------------------------------------

// Capturing pool that tolerates concurrent connects (the route runs three loaders
// via Promise.all). Each connect returns a fresh client at index 0 over the SAME
// rowSets and records every (sql, params) into a shared `captured` array.
function makeAnalyticsCapturingPool(rowSets: unknown[][]): {
  pool: import("pg").Pool;
  captured: { sql: string; params: unknown[] }[];
} {
  const captured: { sql: string; params: unknown[] }[] = [];
  const pool = {
    connect: async () => {
      let i = 0;
      return {
        query: async (sql: string, params?: unknown[]) => {
          captured.push({ sql, params: params ?? [] });
          const rows = (rowSets[i] ?? []) as unknown[];
          i++;
          return { rows, rowCount: rows.length };
        },
        release: () => {},
      } as unknown as import("pg").PoolClient;
    },
  } as unknown as import("pg").Pool;
  return { pool, captured };
}

// Matches DEV_TENANT_ID fallback in report-page-render.ts (no resolver wired in tests).
const DEV_TENANT_ID_FOR_TEST = "a0000000-0000-0000-0000-000000000001";

describe("T-0495 — GET /api/process-analytics process drill-down", () => {
  it("PA-1: 401 without auth (unchanged)", async () => {
    resetRenderPoolForTesting();
    const { server, baseUrl } = buildTestServer(allowDeps, makeFakePool([]));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status } = await httpReq("GET", baseUrl() + "/api/process-analytics");
      expect(status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("PA-2: WITHOUT process_key → 200, selectedProcess=null, no process filter in SQL", async () => {
    resetRenderPoolForTesting();
    // Each loader's connection runs: BEGIN, SET LOCAL, SET LOCAL, SELECT, COMMIT.
    const rowSets: unknown[][] = [[], [], [], [], []];
    const { pool, captured } = makeAnalyticsCapturingPool(rowSets);
    const { server, baseUrl } = buildTestServer(allowDeps, pool);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + "/api/process-analytics",
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(200);
      const body = json as Record<string, unknown>;
      expect(body["selectedProcess"]).toBeNull();
      expect(Array.isArray(body["processKeys"])).toBe(true);
      expect(body).toHaveProperty("bottleneck");
      expect(body).toHaveProperty("cycleTime");
      expect(body).toHaveProperty("actorBreakdown");
      // No SELECT carried a process_key filter / a 3rd param.
      const analyticsSelects = captured.filter(
        (c) => /^\s*SELECT/i.test(c.sql) && c.sql.includes("transition_payload"),
      );
      expect(analyticsSelects.length).toBeGreaterThan(0);
      for (const sel of analyticsSelects) {
        expect(sel.sql).not.toContain("= $3");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("PA-3: WITH process_key → 200, selectedProcess echoed, filter bound as $3 (param, not SQL)", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [[], [], [], [], []];
    const { pool, captured } = makeAnalyticsCapturingPool(rowSets);
    const { server, baseUrl } = buildTestServer(allowDeps, pool);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const PROC = "purchaseApproval";
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + `/api/process-analytics?process_key=${PROC}`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(200);
      const body = json as Record<string, unknown>;
      expect(body["selectedProcess"]).toBe(PROC);

      // The two filterable analytics SELECTs (cycle-time + actor breakdown) must
      // carry the process key ONLY as bound param $3 — never spliced into SQL.
      const filtered = captured.filter((c) => c.sql.includes("= $3"));
      expect(filtered.length).toBe(2);
      for (const sel of filtered) {
        expect(sel.params[0]).toBe(DEV_TENANT_ID_FOR_TEST); // tenant stays $1
        expect(sel.params[2]).toBe(PROC); // process_key is $3
        expect(sel.sql).not.toContain(PROC); // never interpolated
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("PA-4: empty process_key (?process_key=) → treated as absent, selectedProcess=null", async () => {
    resetRenderPoolForTesting();
    const rowSets: unknown[][] = [[], [], [], [], []];
    const { pool, captured } = makeAnalyticsCapturingPool(rowSets);
    const { server, baseUrl } = buildTestServer(allowDeps, pool);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { status, json } = await httpReq(
        "GET",
        baseUrl() + "/api/process-analytics?process_key=",
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(200);
      const body = json as Record<string, unknown>;
      expect(body["selectedProcess"]).toBeNull();
      expect(captured.some((c) => c.sql.includes("= $3"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// FF-FLOOR2-RLS structural check: no DB credentials in render module
// ---------------------------------------------------------------------------

describe("FF-FLOOR2-RLS structural: no DB credentials exported", () => {
  it("render module exports only route-registration function and testing helpers", async () => {
    const mod = await import("../http/report-page-render.js");
    // Should export registerReportPageRenderRoutes, resetRenderPoolForTesting, MAX_DATA_LIMIT
    expect(typeof mod.registerReportPageRenderRoutes).toBe("function");
    expect(typeof mod.resetRenderPoolForTesting).toBe("function");
    expect(typeof mod.MAX_DATA_LIMIT).toBe("number");
    // No DB credentials, no connection strings exported
    const keys = Object.keys(mod);
    const credentialKeys = keys.filter(k =>
      k.toLowerCase().includes("password") ||
      k.toLowerCase().includes("secret") ||
      k.toLowerCase().includes("credential") ||
      k.toLowerCase().includes("connectionstring")
    );
    expect(credentialKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T-0632 (security, столп 4) — record-level READ-PDP filtering of Floor-1
// aggregates when resolveReadVisibility is wired (unit-level, FakePool).
//
// The adversary finding (T-0587, ADR-T0587 §1.1): buildAggSql computed
// SUM/COUNT/... over EVERY record in a registry, gated only by the
// application-level checkReadGrant — never isRecordReadable. These tests
// exercise the NEW default path (resolveReadVisibility present) against a
// FakePool that returns raw {id,data} rows (not a pre-computed agg_result),
// proving the aggregate is computed over the JS-filtered visible subset.
//
// AC-T0632-1: narrow record-scope grant → aggregate over ONLY the covered
//   record(s), NOT the full registry (mutational proof: the excluded row's
//   huge value never reaches the sum).
// AC-T0632-2: zero covering record grants → count:0 (honest empty aggregate,
//   not 403/500).
// AC-T0632-3: resolveReadVisibility ABSENT → legacy full-registry aggregate
//   unchanged (honest-degrade regression guard).
// ---------------------------------------------------------------------------

describe("T-0632 — record-level READ-PDP filtering of Floor-1 aggregates", () => {
  const RECORD_VISIBLE = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1";
  const RECORD_HIDDEN = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2";

  // Flat equality oracle (mirrors assistant-*.test.ts convention): a grant's
  // scope covers a resource node iff the node id equals the grant's own
  // nodeId — no synthetic hierarchy needed for a record-scope grant test.
  const flatOracle: AncestryOracle = {
    isDescendantOrSelf(_hierarchy, descendantId, ancestorId) {
      return descendantId === ancestorId;
    },
  };

  function recordScopeGrant(recordId: string): Grant {
    return {
      tenantId: "t",
      id: "g1",
      roleId: "r1",
      resourceType: "record",
      operation: "read",
      scope: { kind: "node", hierarchy: "resource", nodeId: recordId, nodeLevel: "record" },
      delegable: true,
      grantedBy: "seed",
      createdAt: 0,
    };
  }

  function makeNarrowResolver(): ReportAggReadVisibilityResolver {
    return async () => ({ grants: [recordScopeGrant(RECORD_VISIBLE)], ancestry: flatOracle });
  }

  function makeZeroGrantResolver(): ReportAggReadVisibilityResolver {
    return async () => ({ grants: [], ancestry: flatOracle });
  }

  // Row sequence for the T-0632 default path (resolveReadVisibility present):
  // BEGIN, SET LOCAL x2, SELECT report_page, SELECT registry_def, SELECT raw
  // record rows (id,data), COMMIT.
  function makeRawRowRenderRowSets(recordRows: Array<{ id: string; data: unknown }>): unknown[][] {
    return [
      [],
      [],
      [],
      [fakeFloor1Page],
      [fakeRegistryDefRow],
      recordRows,
      [],
    ];
  }

  it("AC-T0632-1: narrow record-scope grant → SUM over the visible record ONLY, never the hidden one's huge value", async () => {
    resetRenderPoolForTesting();
    const rowSets = makeRawRowRenderRowSets([
      { id: RECORD_VISIBLE, data: { amount: 42 } },
      { id: RECORD_HIDDEN, data: { amount: 999999 } }, // must NEVER contribute
    ]);
    const router = new Router();
    registerReportPageRenderRoutes(
      router,
      makeFakePool(rowSets),
      allowDeps,
      undefined,
      makeNarrowResolver(),
    );
    const server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const { status, json } = await httpReq(
        "GET",
        baseUrl + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(200);
      const body = json as Record<string, unknown>;
      const metrics = body["metrics"] as Array<Record<string, unknown>>;
      expect(metrics[0]!["result"]).toBe(42);
      expect(metrics[0]!["result"]).not.toBe(42 + 999999);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("AC-T0632-2: zero covering record grants → count:0 aggregate (honest empty, not 403/500)", async () => {
    resetRenderPoolForTesting();
    const countPage = {
      ...fakeFloor1Page,
      page_def: [{ source_registry_def_id: VALID_REG_DEF_ID, field_key: "amount", agg: "count" }],
    };
    const rowSets: unknown[][] = [
      [],
      [],
      [],
      [countPage],
      [fakeRegistryDefRow],
      [
        { id: RECORD_VISIBLE, data: { amount: 42 } },
        { id: RECORD_HIDDEN, data: { amount: 7 } },
      ],
      [],
    ];
    const router = new Router();
    registerReportPageRenderRoutes(
      router,
      makeFakePool(rowSets),
      allowDeps,
      undefined,
      makeZeroGrantResolver(),
    );
    const server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const { status, json } = await httpReq(
        "GET",
        baseUrl + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(200);
      const body = json as Record<string, unknown>;
      const metrics = body["metrics"] as Array<Record<string, unknown>>;
      expect(metrics[0]!["result"]).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("AC-T0632-3: resolveReadVisibility ABSENT → legacy full-registry SQL aggregate unchanged (honest-degrade regression guard)", async () => {
    resetRenderPoolForTesting();
    // Legacy row-shape: {agg_result} — proves the OLD path still runs
    // byte-for-byte when no resolver is injected (test-only degradation).
    const rowSets = makeFloor1RenderRowSets("12345.00");
    const router = new Router();
    registerReportPageRenderRoutes(router, makeFakePool(rowSets), allowDeps);
    const server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const { status, json } = await httpReq(
        "GET",
        baseUrl + `/api/report-pages/${VALID_PAGE_ID}/render`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(status).toBe(200);
      const body = json as Record<string, unknown>;
      const metrics = body["metrics"] as Array<Record<string, unknown>>;
      expect(metrics[0]!["result"]).toBe("12345.00");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
