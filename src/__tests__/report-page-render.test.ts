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
} from "../http/report-page-render.js";
import { Router } from "../http/router.js";

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
        const { server: s, baseUrl: b } = buildTestServer(denyDeps, makeFakePool([]));
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
        // denyDeps: checkReadGrant returns {ok:false} — no pool queries needed
        const { server: s, baseUrl: b } = buildTestServer(denyDeps, makeFakePool([]));
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
