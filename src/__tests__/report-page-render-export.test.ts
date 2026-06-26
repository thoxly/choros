/**
 * T-0491 — GET /api/report-pages/:id/export?format=xlsx|csv unit tests.
 *
 * No DATABASE_URL required. Reuses the FakePool + injectable-authz-deps harness
 * from report-page-render.test.ts (T-0181): the export route calls the SAME
 * renderFloor1 path, so the same row-set sequencing applies.
 *
 * AC coverage:
 *   EX-1  export?format=csv → 200, text/csv, attachment filename, body == aggregate.
 *   EX-2  export?format=xlsx → 200, spreadsheetml content-type, non-empty buffer (PK zip).
 *   EX-3  default (no format) → csv.
 *   EX-4  unauthenticated (no x-dev-user) → 401 (same as /render).
 *   EX-5  denied read grant → 403 NO_READ_GRANT (same as /render).
 *   EX-6  foreign-tenant scope: grant scoped to App-A, page of App-B → 403 (isolation holds).
 *   EX-7  empty metrics → valid header-only file (200, columns, no body rows), NOT 500.
 *   EX-8  unknown format → 400 VALIDATION.
 *   EX-9  pure-function: flattenRenderResultToTable shape (scalar + grouped + list).
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import {
  registerReportPageRenderRoutes,
  resetRenderPoolForTesting,
  flattenRenderResultToTable,
  type ReportPageRenderAuthzDeps,
  type RenderResult,
} from "../http/report-page-render.js";
import { Router } from "../http/router.js";
import { escapeCsvCell, toCsv, toXlsx } from "../http/tabular-export.js";

// ---------------------------------------------------------------------------
// Fake pool (mirrors report-page-render.test.ts)
// ---------------------------------------------------------------------------

interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number;
}

class FakePoolClient {
  private _queryIndex = 0;
  private _rowSets: unknown[][];
  constructor(rowSets: unknown[][]) {
    this._rowSets = rowSets;
  }
  async query(_sql: string, _params?: unknown[]): Promise<FakeQueryResult> {
    const rows = (this._rowSets[this._queryIndex] ?? []) as unknown[];
    this._queryIndex++;
    return { rows, rowCount: rows.length };
  }
  release(): void {
    /* no-op */
  }
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

// Allow only for `allowedAppId`; deny any other app_id (cross-tenant/app probe).
const scopedAllowDeps = (allowedAppId: string): ReportPageRenderAuthzDeps => ({
  checkReadGrant: async (_pool, _tenantId, _actorId, appId, _nowMs) =>
    appId === allowedAppId
      ? { ok: true }
      : { ok: false, reason: "no_read_grant_on_application" },
});

// ---------------------------------------------------------------------------
// HTTP harness — raw-buffer aware (xlsx is binary)
// ---------------------------------------------------------------------------

function buildTestServer(
  deps: ReportPageRenderAuthzDeps,
  fakePool?: import("pg").Pool,
): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  registerReportPageRenderRoutes(router, fakePool, deps);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  return {
    server,
    baseUrl: () => {
      const addr = server.address() as { port: number } | null;
      if (!addr) throw new Error("server not listening");
      return `http://127.0.0.1:${addr.port}`;
    },
  };
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  buffer: Buffer;
  text: string;
}

async function httpRaw(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          buffer,
          text: buffer.toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(
  deps: ReportPageRenderAuthzDeps,
  pool: import("pg").Pool | undefined,
  fn: (baseUrl: () => string) => Promise<void>,
): Promise<void> {
  resetRenderPoolForTesting();
  const { server, baseUrl } = buildTestServer(deps, pool);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEV_ACTOR = "e-owner";
const VALID_PAGE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const VALID_REG_DEF_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VALID_APP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_APP_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb02";

const fakeRegistryDefRow = {
  id: VALID_REG_DEF_ID,
  record_schema: { properties: { amount: { type: "number" } } },
};

function floor1Page(appId: string, pageDef: unknown): Record<string, unknown> {
  return {
    id: VALID_PAGE_ID,
    app_id: appId,
    floor: "1",
    page_def: pageDef,
    page_code: null,
  };
}

// Row sequence for a single-metric Floor-1 render:
// BEGIN, SET LOCAL ×2, SELECT report_page, SELECT registry_def, SELECT aggregate, COMMIT
function makeRenderRowSets(
  aggResult: unknown,
  appId: string = VALID_APP_ID,
): unknown[][] {
  return [
    [],
    [],
    [],
    [floor1Page(appId, [{ source_registry_def_id: VALID_REG_DEF_ID, field_key: "amount", agg: "sum" }])],
    [fakeRegistryDefRow],
    [{ agg_result: aggResult }],
    [],
  ];
}

// Empty-metrics page: page_def = [] → renderFloor1 short-circuits before any
// registry_def / aggregate query. Sequence: BEGIN, SET LOCAL ×2, SELECT page, COMMIT.
function makeEmptyMetricsRowSets(): unknown[][] {
  return [[], [], [], [floor1Page(VALID_APP_ID, [])], []];
}

// ---------------------------------------------------------------------------
// EX-1: CSV export
// ---------------------------------------------------------------------------

describe("EX-1 — export?format=csv → 200 text/csv attachment matching aggregate", () => {
  it("returns CSV with BOM, attachment header, and aggregate value", async () => {
    await withServer(allowDeps, makeFakePool(makeRenderRowSets("365000.00")), async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/export?format=csv`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      const disposition = res.headers["content-disposition"] ?? "";
      expect(disposition).toContain("attachment");
      expect(disposition).toContain(`filename="report-${VALID_PAGE_ID}.csv"`);
      // Body: UTF-8 BOM + header + one data row carrying the aggregate.
      expect(res.text.charCodeAt(0)).toBe(0xfeff);
      expect(res.text).toContain("metric,group,value");
      expect(res.text).toContain("sum(amount)");
      expect(res.text).toContain("365000.00");
    });
  });
});

// ---------------------------------------------------------------------------
// EX-2: XLSX export
// ---------------------------------------------------------------------------

describe("EX-2 — export?format=xlsx → 200 spreadsheetml non-empty zip buffer", () => {
  it("returns a non-empty XLSX (PK zip signature) with attachment header", async () => {
    await withServer(allowDeps, makeFakePool(makeRenderRowSets("365000.00")), async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/export?format=xlsx`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      const disposition = res.headers["content-disposition"] ?? "";
      expect(disposition).toContain("attachment");
      expect(disposition).toContain(`filename="report-${VALID_PAGE_ID}.xlsx"`);
      // Non-empty buffer beginning with the ZIP local-file-header magic "PK\x03\x04".
      expect(res.buffer.length).toBeGreaterThan(100);
      expect(res.buffer[0]).toBe(0x50); // P
      expect(res.buffer[1]).toBe(0x4b); // K
      expect(res.buffer[2]).toBe(0x03);
      expect(res.buffer[3]).toBe(0x04);
      // Content-Length header set and matches.
      expect(Number(res.headers["content-length"])).toBe(res.buffer.length);
    });
  });
});

// ---------------------------------------------------------------------------
// EX-3: default format → csv
// ---------------------------------------------------------------------------

describe("EX-3 — no format param defaults to csv", () => {
  it("returns text/csv when format is omitted", async () => {
    await withServer(allowDeps, makeFakePool(makeRenderRowSets("1.00")), async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/export`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
    });
  });
});

// ---------------------------------------------------------------------------
// EX-4: unauthenticated → 401
// ---------------------------------------------------------------------------

describe("EX-4 — unauthenticated export → 401", () => {
  it("returns 401 when x-dev-user header is absent", async () => {
    await withServer(allowDeps, makeFakePool([]), async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/export?format=csv`,
        {},
      );
      expect(res.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// EX-5: denied read grant → 403
// ---------------------------------------------------------------------------

describe("EX-5 — denied read grant → 403 NO_READ_GRANT", () => {
  it("returns 403 when authz denies", async () => {
    // Page loaded first (for app_id), then denyDeps rejects → ROLLBACK.
    const rowSets: unknown[][] = [[], [], [], [floor1Page(VALID_APP_ID, [])], []];
    await withServer(denyDeps, makeFakePool(rowSets), async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/export?format=csv`,
        { "x-dev-user": "non-owner" },
      );
      expect(res.status).toBe(403);
      const body = JSON.parse(res.text) as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("NO_READ_GRANT");
    });
  });
});

// ---------------------------------------------------------------------------
// EX-6: cross-app/tenant isolation — grant scoped to App-A, page of App-B → 403
// ---------------------------------------------------------------------------

describe("EX-6 — foreign scope: grant on App-A, page of App-B → 403 (isolation holds)", () => {
  it("export of an App-B page with an App-A-scoped grant → 403, no data leaks", async () => {
    const rowSets: unknown[][] = [[], [], [], [floor1Page(OTHER_APP_ID, [])], []];
    await withServer(scopedAllowDeps(VALID_APP_ID), makeFakePool(rowSets), async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/export?format=csv`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(res.status).toBe(403);
      const body = JSON.parse(res.text) as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("NO_READ_GRANT");
      // No spreadsheet/file bytes in an error envelope.
      expect(res.text).not.toContain("PK");
    });
  });
});

// ---------------------------------------------------------------------------
// EX-7: empty metrics → valid header-only file (NOT 500)
// ---------------------------------------------------------------------------

describe("EX-7 — empty metrics → valid header-only file (200, no rows)", () => {
  it("csv: header only, no data rows", async () => {
    await withServer(allowDeps, makeFakePool(makeEmptyMetricsRowSets()), async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/export?format=csv`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(res.status).toBe(200);
      // Strip BOM, then split on CRLF; expect a single header line (+ trailing empty).
      const noBom = res.text.replace(/^﻿/, "");
      const lines = noBom.split("\r\n").filter((l) => l.length > 0);
      expect(lines).toEqual(["metric,group,value"]);
    });
  });

  it("xlsx: header-only is still a valid non-empty zip", async () => {
    await withServer(allowDeps, makeFakePool(makeEmptyMetricsRowSets()), async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/export?format=xlsx`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(res.status).toBe(200);
      expect(res.buffer.length).toBeGreaterThan(100);
      expect(res.buffer[0]).toBe(0x50); // PK
      expect(res.buffer[1]).toBe(0x4b);
    });
  });
});

// ---------------------------------------------------------------------------
// EX-8: unknown format → 400
// ---------------------------------------------------------------------------

describe("EX-8 — unknown format → 400 VALIDATION", () => {
  it("returns 400 for format=pdf", async () => {
    await withServer(allowDeps, makeFakePool([]), async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + `/api/report-pages/${VALID_PAGE_ID}/export?format=pdf`,
        { "x-dev-user": DEV_ACTOR },
      );
      expect(res.status).toBe(400);
      const body = JSON.parse(res.text) as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown> | undefined;
      expect(err?.["code"]).toBe("VALIDATION");
    });
  });
});

// ---------------------------------------------------------------------------
// EX-9: pure flatten function — scalar, grouped, and list aggregates
// ---------------------------------------------------------------------------

describe("EX-9 — flattenRenderResultToTable shape", () => {
  it("scalar + grouped + list metrics flatten to [metric, group, value]", () => {
    const result: RenderResult = {
      page_id: VALID_PAGE_ID,
      floor: "1",
      metrics: [
        {
          source_registry_def_id: VALID_REG_DEF_ID,
          field_key: "amount",
          agg: "sum",
          title: "Итого",
          result: "365000.00",
        },
        {
          source_registry_def_id: VALID_REG_DEF_ID,
          field_key: "amount",
          agg: "sum",
          result: null,
          grouped: [
            { group_key: "ОтделА", result: "100" },
            { group_key: "ОтделБ", result: "265000" },
          ],
        },
        {
          source_registry_def_id: VALID_REG_DEF_ID,
          field_key: "name",
          agg: "list",
          result: ["Иван", "Пётр"],
        },
      ],
    };
    const table = flattenRenderResultToTable(result);
    expect(table.columns).toEqual(["metric", "group", "value"]);
    expect(table.rows).toEqual([
      ["Итого", "", "365000.00"],
      ["sum(amount)", "ОтделА", "100"],
      ["sum(amount)", "ОтделБ", "265000"],
      ['list(name)', "", '["Иван","Пётр"]'],
    ]);
  });

  it("empty metrics → header-only (no rows)", () => {
    const table = flattenRenderResultToTable({ page_id: VALID_PAGE_ID, floor: "1", metrics: [] });
    expect(table.columns).toEqual(["metric", "group", "value"]);
    expect(table.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EX-10: CSV formula injection — escapeCsvCell neutralizes formula triggers
// ---------------------------------------------------------------------------

describe("EX-10 — escapeCsvCell neutralizes spreadsheet formula injection", () => {
  // --- Dangerous formula triggers: must be prefixed with apostrophe ---

  it("=1+1 → neutralized with leading apostrophe", () => {
    const out = escapeCsvCell("=1+1");
    expect(out).toBe(`"'=1+1"`);
    expect(out.startsWith(`"'`)).toBe(true);
  });

  it("+1 → neutralized with leading apostrophe", () => {
    const out = escapeCsvCell("+1");
    expect(out).toBe(`"'+1"`);
    expect(out.startsWith(`"'`)).toBe(true);
  });

  it("@SUM(A1:A10) → neutralized with leading apostrophe", () => {
    const out = escapeCsvCell("@SUM(A1:A10)");
    expect(out).toBe(`"'@SUM(A1:A10)"`);
    expect(out.startsWith(`"'`)).toBe(true);
  });

  it("-2+3 → neutralized with leading apostrophe", () => {
    const out = escapeCsvCell("-2+3");
    expect(out).toBe(`"'-2+3"`);
    expect(out.startsWith(`"'`)).toBe(true);
  });

  it("cell with leading tab → neutralized with leading apostrophe", () => {
    const out = escapeCsvCell("\tmalicious");
    // starts with apostrophe inside quotes
    expect(out).toBe(`"'\tmalicious"`);
    expect(out.startsWith(`"'`)).toBe(true);
  });

  it("DDE attack payload =cmd|'/C calc'!A0 → neutralized", () => {
    const out = escapeCsvCell("=cmd|'/C calc'!A0");
    // The ' inside the value gets doubled per RFC-4180 (only " is doubled, not ')
    // but the leading ' neutralizer is prepended before the body
    expect(out.startsWith(`"'=`)).toBe(true);
  });

  // --- Safe values: must NOT be altered ---

  it("plain string 'abc' → unchanged", () => {
    expect(escapeCsvCell("abc")).toBe("abc");
  });

  it("numeric string '123' → unchanged", () => {
    expect(escapeCsvCell("123")).toBe("123");
  });

  it("string with comma 'a,b' → RFC-4180 quoted, no apostrophe prefix", () => {
    const out = escapeCsvCell("a,b");
    expect(out).toBe(`"a,b"`);
    expect(out).not.toContain("'");
  });

  it("null → empty string", () => {
    expect(escapeCsvCell(null)).toBe("");
  });

  it("empty string → empty string", () => {
    expect(escapeCsvCell("")).toBe("");
  });

  it("number 42 → '42' (not altered)", () => {
    expect(escapeCsvCell(42)).toBe("42");
  });

  // --- XLSX path: formula-looking values still emit as literal inlineStr ---

  it("xlsx: formula-looking value =1+1 emits as literal inlineStr (no <f> tag)", () => {
    const table = {
      columns: ["formula_test"],
      rows: [["=1+1"]],
    };
    const buf = toXlsx(table);
    // Must be a valid ZIP (PK magic)
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf.length).toBeGreaterThan(100);
    // The sheet XML content inside the zip should contain inlineStr, not <f>
    const text = buf.toString("utf8");
    expect(text).toContain("inlineStr");
    expect(text).not.toContain("<f>");
    // The raw formula text appears in the XML (XML-escaped if needed)
    expect(text).toContain("=1+1");
  });

  // --- toCsv: formula in a data row is neutralized end-to-end ---

  it("toCsv: formula value in data row is neutralized", () => {
    const table = {
      columns: ["metric", "group", "value"],
      rows: [["sum(amount)", "", "=HYPERLINK(\"evil.com\")"]],
    };
    const csv = toCsv(table);
    // The value cell must be neutralized (start with ')
    expect(csv).toContain(`"'=HYPERLINK`);
    // BOM + header row present
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("metric,group,value");
  });
});
