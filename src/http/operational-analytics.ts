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
  loadRecordSumsByPeriod,
  loadRecordScanForVisibility,
  DAY_MS,
  RECORD_SCAN_LIMIT,
  type LoadOperationalAnalyticsParams,
  type OperationalAnalyticsResult,
  type WorkloadPeriodRow,
  type RecordSumPeriodRow,
  type ActorWorkloadRow,
} from "../db/operational-analytics-dao.js";
import { toCsv, toXlsx, sanitizeSheetName, type Tabular } from "./tabular-export.js";
import { batchResolveActors, type ResolvedActor } from "../db/actor-resolver.js";
// T-0739 (security P2, столп 4): the SAME per-row READ-PDP predicate T-0632
// (report-page-render.ts) and T-0570 (records.ts) already use — single-
// resolver, NOT a second authority path (NF-1).
import { isRecordReadable, type RowAncestry } from "../core/read-visibility.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";
// T-0739: reuse the EXACT resolver TYPE T-0632 already exports — server.ts
// wires ONE composed instance (getGrantsForSubject + loadTenantOrgAncestry)
// and passes the SAME function reference here and to
// registerReportPageRenderRoutes (ADR-T0739 §2, single source of truth).
import type { ReportAggReadVisibilityResolver } from "./report-page-render.js";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface OperationalAnalyticsDeps {
  pool: pg.Pool;
  resolveActorTenant?: ActorTenantResolver;
  /**
   * T-0739 (security P2, столп 4): OPTIONAL READ-PDP visibility resolver.
   * ADR-T0739 §3.1 — when present: (a) entry gate, the actor must hold >=1
   * confirmed grant of ANY kind (the platform's role-reader default-open
   * backfill, migrations 117/124, guarantees every ACTIVE employee holds at
   * least this one grant; a deactivated actor's residual JWT resolves to
   * `grants=[]` via getGrantsForSubject's ACTOR_ACTIVE_SQL predicate) — absent
   * a grant, 403 NO_READ_GRANT on the WHOLE route; (b) `record_sums` (when
   * requested) is narrowed to READ-PDP-visible records only (T-0632 parity —
   * the exact record-level leak class T-0632 closed for report-page-render.ts's
   * Floor-1 aggregate). Honest-degrade (NF-2): resolver absent → gate skipped,
   * `record_sums` falls back to the legacy full-registry aggregate — test-only,
   * production (server.ts) always wires this.
   */
  resolveReadVisibility?: ReportAggReadVisibilityResolver;
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
// T-0739 (security P2, столп 4): computeVisibleRecordSums — record_sums's
// T-0632-parity path. Fetches a BOUNDED candidate window (RECORD_SCAN_LIMIT,
// mirrors report-page-render.ts's AGG_SCAN_LIMIT), filters EACH row through
// `isRecordReadable` (the SAME predicate GET /api/records and the Floor-1
// aggregate use), and folds only visible rows into a per-day SUM — the
// day-bucketing (`toISOString().slice(0,10)`) reproduces the SQL
// `to_char(to_timestamp(created_at/1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
// format loadRecordSumsByPeriod already uses (record_sums is always computed
// for period="day" regardless of the export ?period= query — see
// loadOperationalAnalytics, unchanged).
// ---------------------------------------------------------------------------

async function computeVisibleRecordSums(
  pool: pg.Pool,
  tenantId: string,
  registryDefId: string,
  fieldKey: string,
  cutoffMs: number,
  visibility: { grants: Grant[]; ancestry: AncestryOracle },
  nowMs: number,
): Promise<RecordSumPeriodRow[]> {
  const candidates = await loadRecordScanForVisibility(
    pool,
    tenantId,
    registryDefId,
    cutoffMs,
    RECORD_SCAN_LIMIT,
  );

  const byPeriod = new Map<string, { total: number; count: number }>();

  for (const row of candidates) {
    const rowAncestry: RowAncestry = {
      recordId: row.id,
      registryId: registryDefId,
      applicationId: row.application_id,
    };
    if (!isRecordReadable(rowAncestry, visibility.grants, visibility.ancestry, nowMs)) continue;

    const data = row.data;
    const raw =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)[fieldKey]
        : undefined;
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;

    const createdAtMs = Number(row.created_at);
    const period = new Date(createdAtMs).toISOString().slice(0, 10);
    const acc = byPeriod.get(period) ?? { total: 0, count: 0 };
    acc.total += n;
    acc.count += 1;
    byPeriod.set(period, acc);
  }

  return [...byPeriod.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)) // ORDER BY 1 DESC
    .map(([period, acc]) => ({
      period,
      period_type: "day" as const,
      total: acc.total,
      row_count: acc.count,
    }));
}

// ---------------------------------------------------------------------------
// T-0739: loadGatedAnalytics — shared entry gate + record_sums narrowing,
// used by BOTH handleGet and handleExport (single implementation, ADR-T0739
// §3.1). Throws 403 NO_READ_GRANT when the resolver is wired and the actor
// holds zero confirmed grants (ACTOR_ACTIVE closure — see
// OperationalAnalyticsDeps.resolveReadVisibility doc comment).
// ---------------------------------------------------------------------------

async function loadGatedAnalytics(
  pool: pg.Pool,
  tenantId: string,
  actor: string,
  params: LoadOperationalAnalyticsParams,
  resolveReadVisibility: ReportAggReadVisibilityResolver | undefined,
  nowMs: number,
): Promise<OperationalAnalyticsResult> {
  const visibility = resolveReadVisibility
    ? await resolveReadVisibility(actor, tenantId, nowMs)
    : undefined;
  if (visibility !== undefined && visibility.grants.length === 0) {
    throw new HttpError(403, "NO_READ_GRANT", "no confirmed grant for this tenant");
  }

  const { processKey, registryDefId, fieldKey } = params;

  // workload_*/top_actors are audit_event telemetry (ADR-T0739 §1.1 / ADR-T0632
  // precedent) — computed tenant-wide, unaffected by narrowing. record_sums
  // (choros.record) is requested separately below when both params are given.
  const result = await loadOperationalAnalytics(pool, tenantId, { processKey }, nowMs);

  if (registryDefId !== undefined && fieldKey !== undefined) {
    const cutoff30d = nowMs - 30 * DAY_MS;
    const recordSums = visibility
      ? await computeVisibleRecordSums(pool, tenantId, registryDefId, fieldKey, cutoff30d, visibility, nowMs)
      : await loadRecordSumsByPeriod(pool, tenantId, registryDefId, fieldKey, cutoff30d, "day", 30);
    return {
      ...result,
      record_sums: recordSums,
      registry_def_id: registryDefId,
      field_key: fieldKey,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Handler — GET /api/operational-analytics
// ---------------------------------------------------------------------------

async function handleGet(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver | undefined,
  resolveReadVisibility: ReportAggReadVisibilityResolver | undefined,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const actor = await extractActor(req, pool);
  const tenantId = await resolveTenant(actor, resolveActorTenant);

  const url = new URL(req.url ?? "/", "http://localhost");
  const { processKey, registryDefId, fieldKey } = parseQueryParams(url);

  const result = await loadGatedAnalytics(
    pool,
    tenantId,
    actor,
    { processKey, registryDefId, fieldKey },
    resolveReadVisibility,
    Date.now(),
  );

  // T-0648 (D-064, UX-study §3): «Топ исполнителей» rendered the raw actor slug
  // verbatim (TopActorsTable, screen-operational-analytics.jsx). Batch-resolve
  // every DISTINCT actor across top_actors in ONE additional query (no N+1) and
  // attach the display shape additively — `actor` (raw string) is unchanged for
  // back-compat (CSV/XLSX export, existing tests); the frontend prefers
  // `actorResolved` when present.
  const responseBody: OperationalAnalyticsResult & {
    top_actors: Array<ActorWorkloadRow & { actorResolved?: ResolvedActor }>;
  } = { ...result, top_actors: result.top_actors };
  if (result.top_actors.length > 0) {
    try {
      const ids = [...new Set(result.top_actors.map((r) => r.actor))];
      const resolved = await batchResolveActors(pool, tenantId, ids);
      responseBody.top_actors = result.top_actors.map((r) => ({
        ...r,
        ...(resolved.has(r.actor) ? { actorResolved: resolved.get(r.actor) } : {}),
      }));
    } catch {
      // Degrade gracefully: keep the raw actor strings (read-projection).
    }
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(responseBody));
}

// ---------------------------------------------------------------------------
// Handler — GET /api/operational-analytics/export
// ---------------------------------------------------------------------------

async function handleExport(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver | undefined,
  resolveReadVisibility: ReportAggReadVisibilityResolver | undefined,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const actor = await extractActor(req, pool);
  const tenantId = await resolveTenant(actor, resolveActorTenant);

  const url = new URL(req.url ?? "/", "http://localhost");
  const { processKey, registryDefId, fieldKey, period, format } = parseQueryParams(url);

  const result = await loadGatedAnalytics(
    pool,
    tenantId,
    actor,
    { processKey, registryDefId, fieldKey },
    resolveReadVisibility,
    Date.now(),
  );
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
  const { pool, resolveActorTenant, resolveReadVisibility } = deps;

  // T-0739 (security P2, столп 4): resolveReadVisibility is threaded directly
  // into this call site (not only into handleGet's body) so the ACTOR_ACTIVE
  // marker is visible to ci/checks/actor-active-route-coverage.sh's per-route
  // block scan WITHOUT a ROUTE_WHITELIST §D entry (ADR-T0739 §5) — handleGet
  // is a module-scope helper declared BEFORE this .register( call, which the
  // gate's block-scan otherwise cannot see (ADR-T0726 §2.4 limitation #1).
  router.register(
    "GET",
    "/api/operational-analytics",
    withAuth((req, res) => handleGet(pool, resolveActorTenant, resolveReadVisibility, req, res)),
  );

  router.register(
    "GET",
    "/api/operational-analytics/export",
    withAuth((req, res) => handleExport(pool, resolveActorTenant, resolveReadVisibility, req, res)),
  );
}
