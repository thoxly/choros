/**
 * src/http/operational-analytics.ts — T-0405 [PD-20]
 *
 * Оперативная аналитика (не BI): GROUP BY на индексе, маленький результат в браузер.
 * Граница (ТЗ инж.ресурсов): таблица → бар → Гант; глубокий анализ = выгрузка.
 *
 * Routes:
 *   GET /api/operational-analytics        — агрегаты за периоды (нагрузка + суммы)
 *   GET /api/operational-analytics/export — выгрузка .xlsx / .csv
 *
 * Параметры запроса (GET):
 *   ?process_key=<str>          — фильтр по процессу (необязательно)
 *   ?registry_def_id=<uuid>     — для агрегата сумм по записям (необязательно)
 *   ?field_key=<str>            — числовое поле для суммирования (вместе с registry_def_id)
 *   ?period=day|week|month      — период для экспорта (по умолчанию day)
 *   ?format=xlsx|csv            — только для /export (по умолчанию csv)
 *
 * Auth: x-dev-user / Keycloak Bearer (идентичный паттерну spend.ts + report-page-render.ts).
 * Tenant: resolveActorTenant (T-0489 fail-closed) → DEV_TENANT_ID в unit-тестах.
 *
 * NON-GOAL: нет BI-движка, нет склада, нет тяжёлых вычислений на сервере приложений —
 * вся математика делается в SQL GROUP BY на БД-индексе.
 */

import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import {
  loadOperationalAnalytics,
  type LoadOperationalAnalyticsParams,
  type OperationalAnalyticsResult,
  type WorkloadPeriodRow,
  type RecordSumPeriodRow,
  type ActorWorkloadRow,
} from "../db/operational-analytics-dao.js";
import { toCsv, toXlsx, sanitizeSheetName, type Tabular } from "./tabular-export.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface OperationalAnalyticsDeps {
  pool: pg.Pool;
  resolveActorTenant?: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD_KEY_RE = /^[a-zA-Z0-9_-]+$/;

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Auth helpers (mirrors report-page-render.ts pattern)
// ---------------------------------------------------------------------------

async function extractActor(
  req: import("node:http").IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing auth header");
  }
  return devUser;
}

async function resolveTenant(
  actor: string,
  resolveActorTenant: ActorTenantResolver | undefined,
): Promise<string> {
  return resolveActorTenant ? resolveActorTenant(actor) : DEV_TENANT_ID;
}

// ---------------------------------------------------------------------------
// Query param parsing
// ---------------------------------------------------------------------------

function parseQueryParams(url: URL): {
  processKey: string | undefined;
  registryDefId: string | undefined;
  fieldKey: string | undefined;
  period: "day" | "week" | "month";
  format: "xlsx" | "csv";
} {
  // process_key — any string (will be passed as bound param, no injection risk)
  const rawProcessKey = url.searchParams.get("process_key");
  const processKey =
    rawProcessKey !== null && rawProcessKey !== "" ? rawProcessKey : undefined;

  // registry_def_id — UUID guard
  const rawRegistryDefId = url.searchParams.get("registry_def_id");
  let registryDefId: string | undefined;
  if (rawRegistryDefId !== null && rawRegistryDefId !== "") {
    if (!UUID_RE.test(rawRegistryDefId)) {
      throw new HttpError(400, "VALIDATION", "registry_def_id must be a valid UUID");
    }
    registryDefId = rawRegistryDefId;
  }

  // field_key — charset guard (mirrors report-page-render.ts dual-guard)
  const rawFieldKey = url.searchParams.get("field_key");
  let fieldKey: string | undefined;
  if (rawFieldKey !== null && rawFieldKey !== "") {
    if (!FIELD_KEY_RE.test(rawFieldKey)) {
      throw new HttpError(
        400,
        "VALIDATION",
        "field_key must match [a-zA-Z0-9_-]+",
      );
    }
    fieldKey = rawFieldKey;
  }

  // period
  const rawPeriod = url.searchParams.get("period");
  let period: "day" | "week" | "month" = "day";
  if (rawPeriod === "week" || rawPeriod === "month") {
    period = rawPeriod;
  } else if (rawPeriod !== null && rawPeriod !== "" && rawPeriod !== "day") {
    throw new HttpError(400, "VALIDATION", "period must be day|week|month");
  }

  // format
  const rawFormat = url.searchParams.get("format");
  let format: "xlsx" | "csv" = "csv";
  if (rawFormat === "xlsx") {
    format = "xlsx";
  } else if (rawFormat !== null && rawFormat !== "" && rawFormat !== "csv") {
    throw new HttpError(400, "VALIDATION", "format must be xlsx|csv");
  }

  return { processKey, registryDefId, fieldKey, period, format };
}

// ---------------------------------------------------------------------------
// flattenToTable — конвертирует OperationalAnalyticsResult в Tabular для экспорта
// ---------------------------------------------------------------------------

/**
 * Превращает результат аналитики в плоскую таблицу для экспорта.
 * period=day  → workload_daily
 * period=week → workload_weekly
 * period=month → workload_monthly
 *
 * Формат: period | period_type | transitions | instances | [total | row_count]
 * Если есть record_sums — добавляет доп.столбцы через LEFT JOIN по period.
 */
export function flattenAnalyticsToTable(
  result: OperationalAnalyticsResult,
  period: "day" | "week" | "month" = "day",
): Tabular {
  const workloadMap: Record<typeof period, WorkloadPeriodRow[]> = {
    day: result.workload_daily,
    week: result.workload_weekly,
    month: result.workload_monthly,
  };
  const workload = workloadMap[period];

  const hasSums = Array.isArray(result.record_sums) && result.record_sums.length > 0;
  const sumsByPeriod = new Map<string, RecordSumPeriodRow>();
  if (hasSums) {
    for (const r of result.record_sums!) {
      sumsByPeriod.set(r.period, r);
    }
  }

  const fieldLabel = result.field_key ? `sum(${result.field_key})` : "sum";

  const columns: string[] = hasSums
    ? ["period", "period_type", "transitions", "instances", fieldLabel, "records_count"]
    : ["period", "period_type", "transitions", "instances"];

  const rows: Array<Array<string | number | null>> = workload.map((w) => {
    const base: Array<string | number | null> = [
      w.period,
      w.period_type,
      w.transition_count,
      w.instance_count,
    ];
    if (hasSums) {
      const s = sumsByPeriod.get(w.period);
      base.push(s?.total ?? null, s?.row_count ?? null);
    }
    return base;
  });

  return { columns, rows };
}

/**
 * Таблица нагрузки по исполнителям (last 30 days).
 */
export function flattenActorWorkloadToTable(rows: ActorWorkloadRow[]): Tabular {
  return {
    columns: ["period", "actor", "count"],
    rows: rows.map((r) => [r.period, r.actor, r.count]),
  };
}

// ---------------------------------------------------------------------------
// Handler — GET /api/operational-analytics
// ---------------------------------------------------------------------------

async function handleGet(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver | undefined,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const actor = await extractActor(req, pool);
  const tenantId = await resolveTenant(actor, resolveActorTenant);

  const url = new URL(req.url ?? "/", "http://localhost");
  const { processKey, registryDefId, fieldKey } = parseQueryParams(url);

  const analyticsParams: LoadOperationalAnalyticsParams = {
    processKey,
    registryDefId,
    fieldKey,
  };

  const result = await loadOperationalAnalytics(pool, tenantId, analyticsParams);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// Handler — GET /api/operational-analytics/export
// ---------------------------------------------------------------------------

async function handleExport(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver | undefined,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const actor = await extractActor(req, pool);
  const tenantId = await resolveTenant(actor, resolveActorTenant);

  const url = new URL(req.url ?? "/", "http://localhost");
  const { processKey, registryDefId, fieldKey, period, format } = parseQueryParams(url);

  const analyticsParams: LoadOperationalAnalyticsParams = {
    processKey,
    registryDefId,
    fieldKey,
  };

  const result = await loadOperationalAnalytics(pool, tenantId, analyticsParams);
  const table = flattenAnalyticsToTable(result, period);

  const safePeriod = sanitizeSheetName(`workload_${period}`);

  if (format === "xlsx") {
    const buffer = toXlsx(table, safePeriod);
    res.statusCode = 200;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="operational-analytics-${period}.xlsx"`,
    );
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  } else {
    const body = toCsv(table);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="operational-analytics-${period}.csv"`,
    );
    res.end(body);
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerOperationalAnalyticsRoutes(
  router: Router,
  deps: OperationalAnalyticsDeps,
): void {
  const { pool, resolveActorTenant } = deps;

  router.register(
    "GET",
    "/api/operational-analytics",
    withAuth((req, res) => handleGet(pool, resolveActorTenant, req, res)),
  );

  router.register(
    "GET",
    "/api/operational-analytics/export",
    withAuth((req, res) => handleExport(pool, resolveActorTenant, req, res)),
  );
}
