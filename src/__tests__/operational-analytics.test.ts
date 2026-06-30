/**
 * src/__tests__/operational-analytics.test.ts — T-0405 [PD-20]
 *
 * Unit-тесты для оперативной аналитики.
 * NO DATABASE_URL required — используем FakePool (mirrors report-page-render.test.ts).
 *
 * AC coverage:
 *   OA-1  GET /api/operational-analytics → 200 JSON с нужными полями
 *   OA-2  GET /api/operational-analytics/export?format=csv → text/csv attachment
 *   OA-3  GET /api/operational-analytics/export?format=xlsx → spreadsheetml attachment (PK zip)
 *   OA-4  Unauthenticated → 401
 *   OA-5  Invalid registry_def_id → 400 VALIDATION
 *   OA-6  Invalid field_key → 400 VALIDATION
 *   OA-7  Invalid period → 400 VALIDATION
 *   OA-8  Invalid format → 400 VALIDATION
 *   OA-9  flattenAnalyticsToTable — колонки без record_sums
 *   OA-10 flattenAnalyticsToTable — колонки с record_sums
 *   OA-11 flattenActorWorkloadToTable — shape
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import {
  registerOperationalAnalyticsRoutes,
  flattenAnalyticsToTable,
  flattenActorWorkloadToTable,
  type OperationalAnalyticsDeps,
} from "../http/operational-analytics.js";
import type { OperationalAnalyticsResult } from "../db/operational-analytics-dao.js";

// ---------------------------------------------------------------------------
// FakePool (в каждом вызове query возвращает следующий набор строк из очереди)
// ---------------------------------------------------------------------------

interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number;
}

class FakePoolClient {
  private _idx = 0;
  private _sets: unknown[][];
  constructor(sets: unknown[][]) {
    this._sets = sets;
  }
  async query(_sql: string, _params?: unknown[]): Promise<FakeQueryResult> {
    const rows = (this._sets[this._idx] ?? []) as unknown[];
    this._idx++;
    return { rows, rowCount: rows.length };
  }
  release(): void {/* no-op */}
}

function makeFakePool(rowSets: unknown[][]): import("pg").Pool {
  return {
    connect: async () => new FakePoolClient(rowSets) as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

function buildServer(deps: OperationalAnalyticsDeps): {
  server: http.Server;
  baseUrl: () => string;
} {
  const router = new Router();
  registerOperationalAnalyticsRoutes(router, deps);
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

async function withServer(
  deps: OperationalAnalyticsDeps,
  fn: (baseUrl: () => string) => Promise<void>,
): Promise<void> {
  const { server, baseUrl } = buildServer(deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

interface RawResp {
  status: number;
  headers: http.IncomingHttpHeaders;
  buffer: Buffer;
  text: string;
}

async function httpRaw(
  method: string,
  url: string,
  hdrs: Record<string, string> = {},
): Promise<RawResp> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method,
      headers: hdrs,
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

// ---------------------------------------------------------------------------
// Fake row sets — каждый запрос из withTenant получает:
// BEGIN, SET LOCAL ×2, [query], COMMIT
// Итого: 4 «пустых» + 1 реальный per withTenant call.
// loadOperationalAnalytics делает 4 параллельных вызова (daily, weekly, monthly, top_actors)
// Каждый вызов = 1 connection = 5 слотов
// ---------------------------------------------------------------------------

function makeFakeRows(): unknown[][] {
  // daily workload
  const daily = [{ period: "2026-06-30", transition_count: "5", instance_count: "2" }];
  // weekly workload
  const weekly = [{ period: "2026-W26", transition_count: "15", instance_count: "6" }];
  // monthly workload
  const monthly = [{ period: "2026-06", transition_count: "50", instance_count: "20" }];
  // top_actors
  const actors = [{ period: "2026-06-30", actor: "alice", cnt: "3" }];

  // Каждый вызов withTenant: BEGIN(empty), SET LOCAL(empty), SET LOCAL(empty), QUERY(data), COMMIT(empty)
  const wt = (data: unknown[]) => [[], [], [], data, []];

  return [
    ...wt(daily),
    ...wt(weekly),
    ...wt(monthly),
    ...wt(actors),
  ];
}

const DEV_ACTOR = "test-dev-user";

// ---------------------------------------------------------------------------
// OA-1: GET /api/operational-analytics → 200 JSON
// ---------------------------------------------------------------------------

describe("OA-1 — GET /api/operational-analytics → 200 JSON", () => {
  it("returns 200 with workload fields", async () => {
    const pool = makeFakePool(makeFakeRows());
    await withServer({ pool }, async (baseUrl) => {
      const res = await httpRaw("GET", baseUrl() + "/api/operational-analytics", {
        "x-dev-user": DEV_ACTOR,
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.text) as OperationalAnalyticsResult;
      expect(Array.isArray(body.workload_daily)).toBe(true);
      expect(Array.isArray(body.workload_weekly)).toBe(true);
      expect(Array.isArray(body.workload_monthly)).toBe(true);
      expect(Array.isArray(body.top_actors)).toBe(true);
      expect(typeof body.tenant_id).toBe("string");
    });
  });
});

// ---------------------------------------------------------------------------
// OA-2: export?format=csv → text/csv attachment
// ---------------------------------------------------------------------------

describe("OA-2 — export?format=csv → text/csv attachment", () => {
  it("returns 200 text/csv with BOM and attachment header", async () => {
    const pool = makeFakePool(makeFakeRows());
    await withServer({ pool }, async (baseUrl) => {
      const res = await httpRaw("GET", baseUrl() + "/api/operational-analytics/export?format=csv", {
        "x-dev-user": DEV_ACTOR,
      });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      const disp = res.headers["content-disposition"] ?? "";
      expect(disp).toContain("attachment");
      expect(disp).toContain("operational-analytics-day.csv");
      // UTF-8 BOM
      expect(res.text.charCodeAt(0)).toBe(0xfeff);
      // Header row
      expect(res.text).toContain("period");
      expect(res.text).toContain("transitions");
    });
  });
});

// ---------------------------------------------------------------------------
// OA-3: export?format=xlsx → spreadsheetml PK zip
// ---------------------------------------------------------------------------

describe("OA-3 — export?format=xlsx → spreadsheetml attachment PK zip", () => {
  it("returns 200 xlsx with PK magic and attachment header", async () => {
    const pool = makeFakePool(makeFakeRows());
    await withServer({ pool }, async (baseUrl) => {
      const res = await httpRaw("GET", baseUrl() + "/api/operational-analytics/export?format=xlsx", {
        "x-dev-user": DEV_ACTOR,
      });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      const disp = res.headers["content-disposition"] ?? "";
      expect(disp).toContain("attachment");
      expect(disp).toContain("operational-analytics-day.xlsx");
      // PK magic
      expect(res.buffer.length).toBeGreaterThan(100);
      expect(res.buffer[0]).toBe(0x50); // P
      expect(res.buffer[1]).toBe(0x4b); // K
    });
  });
});

// ---------------------------------------------------------------------------
// OA-4: Unauthenticated → 401
// ---------------------------------------------------------------------------

describe("OA-4 — unauthenticated → 401", () => {
  it("returns 401 when no auth header", async () => {
    const pool = makeFakePool([]);
    await withServer({ pool }, async (baseUrl) => {
      const res = await httpRaw("GET", baseUrl() + "/api/operational-analytics", {});
      expect(res.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// OA-5: Invalid registry_def_id → 400 VALIDATION
// ---------------------------------------------------------------------------

describe("OA-5 — invalid registry_def_id → 400 VALIDATION", () => {
  it("returns 400 for non-UUID registry_def_id", async () => {
    const pool = makeFakePool([]);
    await withServer({ pool }, async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + "/api/operational-analytics?registry_def_id=NOT-A-UUID",
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
// OA-6: Invalid field_key → 400 VALIDATION
// ---------------------------------------------------------------------------

describe("OA-6 — invalid field_key → 400 VALIDATION", () => {
  it("returns 400 for field_key with forbidden chars", async () => {
    const pool = makeFakePool([]);
    await withServer({ pool }, async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + "/api/operational-analytics?field_key=bad%20key",
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
// OA-7: Invalid period → 400 VALIDATION
// ---------------------------------------------------------------------------

describe("OA-7 — invalid period → 400 VALIDATION", () => {
  it("returns 400 for period=year", async () => {
    const pool = makeFakePool([]);
    await withServer({ pool }, async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + "/api/operational-analytics/export?period=year",
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
// OA-8: Invalid format → 400 VALIDATION
// ---------------------------------------------------------------------------

describe("OA-8 — invalid format → 400 VALIDATION", () => {
  it("returns 400 for format=pdf", async () => {
    const pool = makeFakePool([]);
    await withServer({ pool }, async (baseUrl) => {
      const res = await httpRaw(
        "GET",
        baseUrl() + "/api/operational-analytics/export?format=pdf",
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
// OA-9: flattenAnalyticsToTable без record_sums
// ---------------------------------------------------------------------------

describe("OA-9 — flattenAnalyticsToTable без record_sums", () => {
  const result: OperationalAnalyticsResult = {
    tenant_id: "t1",
    workload_daily: [
      { period: "2026-06-30", period_type: "day", transition_count: 5, instance_count: 2 },
      { period: "2026-06-29", period_type: "day", transition_count: 3, instance_count: 1 },
    ],
    workload_weekly: [],
    workload_monthly: [],
    top_actors: [],
  };

  it("columns: period, period_type, transitions, instances (no sum cols)", () => {
    const table = flattenAnalyticsToTable(result, "day");
    expect(table.columns).toEqual(["period", "period_type", "transitions", "instances"]);
    expect(table.rows.length).toBe(2);
    expect(table.rows[0]).toEqual(["2026-06-30", "day", 5, 2]);
    expect(table.rows[1]).toEqual(["2026-06-29", "day", 3, 1]);
  });

  it("week variant → workload_weekly (empty → no rows)", () => {
    const table = flattenAnalyticsToTable(result, "week");
    expect(table.rows.length).toBe(0);
    expect(table.columns).toContain("transitions");
  });
});

// ---------------------------------------------------------------------------
// OA-10: flattenAnalyticsToTable с record_sums
// ---------------------------------------------------------------------------

describe("OA-10 — flattenAnalyticsToTable с record_sums", () => {
  it("adds sum(fieldKey) and records_count columns; missing period → null", () => {
    const result: OperationalAnalyticsResult = {
      tenant_id: "t2",
      workload_daily: [
        { period: "2026-06-30", period_type: "day", transition_count: 5, instance_count: 2 },
        { period: "2026-06-29", period_type: "day", transition_count: 3, instance_count: 1 },
      ],
      workload_weekly: [],
      workload_monthly: [],
      top_actors: [],
      record_sums: [
        { period: "2026-06-30", period_type: "day", total: 12345.67, row_count: 4 },
      ],
      field_key: "amount",
      registry_def_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    };

    const table = flattenAnalyticsToTable(result, "day");
    expect(table.columns).toEqual([
      "period", "period_type", "transitions", "instances", "sum(amount)", "records_count",
    ]);
    // 2026-06-30: sum and row_count present
    expect(table.rows[0]).toEqual(["2026-06-30", "day", 5, 2, 12345.67, 4]);
    // 2026-06-29: no record_sums entry → null
    expect(table.rows[1]).toEqual(["2026-06-29", "day", 3, 1, null, null]);
  });
});

// ---------------------------------------------------------------------------
// OA-11: flattenActorWorkloadToTable — shape
// ---------------------------------------------------------------------------

describe("OA-11 — flattenActorWorkloadToTable shape", () => {
  it("returns [period, actor, count] rows", () => {
    const table = flattenActorWorkloadToTable([
      { period: "2026-06-30", period_type: "day", actor: "alice", count: 10 },
      { period: "2026-06-30", period_type: "day", actor: "bob", count: 3 },
    ]);
    expect(table.columns).toEqual(["period", "actor", "count"]);
    expect(table.rows).toEqual([
      ["2026-06-30", "alice", 10],
      ["2026-06-30", "bob", 3],
    ]);
  });

  it("empty input → no rows", () => {
    const table = flattenActorWorkloadToTable([]);
    expect(table.columns).toEqual(["period", "actor", "count"]);
    expect(table.rows).toEqual([]);
  });
});
