/**
 * src/db/operational-analytics-dao.ts — T-0405 [PD-20]
 *
 * Оперативная аналитика: лёгкие GROUP BY агрегаты на индексе.
 * НЕ строим BI-склад — считаем в БД, возвращаем маленький результат.
 *
 * Источники:
 *   - choros.audit_event   → нагрузка по периодам (сколько шагов/инстанций за день/неделю/месяц)
 *   - choros.record        → суммы по числовым полям реестра за период
 *   - choros.spend_ledger  → уже покрыто spend-ledger-dao.ts; здесь — агрегат
 *
 * QUERIES (все на индексах, никакого seq-scan по сырым строкам):
 *   1. loadPeriodWorkload   — COUNT(*) GROUP BY period (day/week/month) из audit_event
 *   2. loadRecordSumsByPeriod — SUM(numeric field) GROUP BY period из record.data
 *   3. loadActorWorkloadByPeriod — COUNT(*) GROUP BY (period, actor) из audit_event
 *
 * DESIGN INVARIANTS:
 *   - Reads ONLY. No writes, no outbox.
 *   - NO import from http/*. Pure DB module.
 *   - All user-supplied values (tenantId, processKey, fieldKey) are STRICTLY $N params
 *     or go through assertUuid/assertSafeIdent guards before any SQL construction.
 *   - withTenant enforces RLS (SET LOCAL choros.tenant_id + FORCE RLS).
 */

import pg from "pg";

// ---------------------------------------------------------------------------
// UUID + ident guards
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

/**
 * Guard for field_key used as jsonb path literal. Mirrors the dual-guard from
 * report-page-render.ts: allow only `[a-zA-Z0-9_-]+` (same charset).
 * field_key is never interpolated into SQL directly — only used as a literal
 * JSON key in `data->>'<field_key>'` after this guard.
 */
function assertSafeFieldKey(value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`field_key contains forbidden characters: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// withTenant helper (mirrors transition-journal.ts)
// ---------------------------------------------------------------------------

async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Один период (день / неделя / месяц) с количеством событий/инстанций. */
export interface WorkloadPeriodRow {
  /** ISO date: YYYY-MM-DD (для day) / ISO week: YYYY-Www / ISO month: YYYY-MM */
  readonly period: string;
  /** Метка типа периода для отображения в UI */
  readonly period_type: "day" | "week" | "month";
  /** Количество переходов (audit_event) за период */
  readonly transition_count: number;
  /** Количество уникальных инстанций процесса за период */
  readonly instance_count: number;
}

/** Суммы числового поля записей за период */
export interface RecordSumPeriodRow {
  readonly period: string;
  readonly period_type: "day" | "week" | "month";
  readonly total: number;
  readonly row_count: number;
}

/** Нагрузка по исполнителю + период */
export interface ActorWorkloadRow {
  readonly period: string;
  readonly period_type: "day" | "week" | "month";
  readonly actor: string;
  readonly count: number;
}

/** Результат GET /api/operational-analytics */
export interface OperationalAnalyticsResult {
  readonly tenant_id: string;
  /** Нагрузка по дням (последние 30 дней) */
  readonly workload_daily: WorkloadPeriodRow[];
  /** Нагрузка по неделям (последние 12 недель) */
  readonly workload_weekly: WorkloadPeriodRow[];
  /** Нагрузка по месяцам (последние 12 месяцев) */
  readonly workload_monthly: WorkloadPeriodRow[];
  /** Топ-20 исполнителей по нагрузке за последние 30 дней */
  readonly top_actors: ActorWorkloadRow[];
  /**
   * Суммы числового поля записей (если запрошено).
   * null — поле не указано в запросе.
   */
  readonly record_sums?: RecordSumPeriodRow[];
  readonly registry_def_id?: string;
  readonly field_key?: string;
}

// ---------------------------------------------------------------------------
// Transition event types (same set as transition-journal.ts)
// ---------------------------------------------------------------------------

const TRANSITION_EVENT_TYPES = [
  "instance.started",
  "task.created",
  "task.claimed",
  "gateway.evaluated",
  "task.completed",
  "instance.ended",
] as const;

// ---------------------------------------------------------------------------
// loadPeriodWorkload — GROUP BY period из audit_event
//
// Counts transitions and unique process instances per period.
// Uses to_char(to_timestamp(ts / 1000), '<format>') for period bucketing —
// ts column is BIGINT (epoch ms). Indexed on (tenant_id, ts DESC) via mig 006.
// ---------------------------------------------------------------------------

async function loadPeriodWorkload(
  pool: pg.Pool,
  tenantId: string,
  processKey: string | undefined,
  cutoffMs: number,
  periodType: "day" | "week" | "month",
  limit: number,
): Promise<WorkloadPeriodRow[]> {
  // period format:
  //   day   → YYYY-MM-DD
  //   week  → IYYY-IW   (ISO week: 2024-W03 style)
  //   month → YYYY-MM
  const fmtMap: Record<typeof periodType, string> = {
    day: "YYYY-MM-DD",
    week: "IYYY-\"W\"IW",
    month: "YYYY-MM",
  };
  const fmt = fmtMap[periodType];

  return withTenant(pool, tenantId, async (client) => {
    const params: unknown[] = [tenantId, TRANSITION_EVENT_TYPES, cutoffMs, limit];
    let processFilter = "";
    if (processKey !== undefined && processKey !== "") {
      params.push(processKey);
      processFilter = `AND (payload -> 'transition_payload' ->> 'process_key') = $${params.length}`;
    }

    const { rows } = await client.query<{
      period: string;
      transition_count: string;
      instance_count: string;
    }>(
      `SELECT
         to_char(to_timestamp(ts / 1000.0) AT TIME ZONE 'UTC', '${fmt}') AS period,
         COUNT(*)                                                           AS transition_count,
         COUNT(DISTINCT
           (payload -> 'transition_payload' ->> 'instance_id')
         )                                                                  AS instance_count
       FROM choros.audit_event
      WHERE tenant_id = $1
        AND type = ANY($2::text[])
        AND ts >= $3
        AND payload ? 'transition_payload'
        ${processFilter}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $4`,
      params,
    );

    return rows.map((r) => ({
      period: r.period,
      period_type: periodType,
      transition_count: parseInt(r.transition_count, 10),
      instance_count: parseInt(r.instance_count, 10),
    }));
  });
}

// ---------------------------------------------------------------------------
// loadActorWorkload — TOP actors по нагрузке за период (last 30 days)
// ---------------------------------------------------------------------------

export async function loadActorWorkload(
  pool: pg.Pool,
  tenantId: string,
  processKey: string | undefined,
  cutoffMs: number,
  topN = 20,
): Promise<ActorWorkloadRow[]> {
  return withTenant(pool, tenantId, async (client) => {
    const params: unknown[] = [tenantId, TRANSITION_EVENT_TYPES, cutoffMs, topN];
    let processFilter = "";
    if (processKey !== undefined && processKey !== "") {
      params.push(processKey);
      processFilter = `AND (payload -> 'transition_payload' ->> 'process_key') = $${params.length}`;
    }

    const { rows } = await client.query<{
      period: string;
      actor: string | null;
      cnt: string;
    }>(
      `SELECT
         to_char(to_timestamp(ts / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS period,
         COALESCE(payload -> 'transition_payload' ->> 'actor', '(не указан)') AS actor,
         COUNT(*)                                                              AS cnt
       FROM choros.audit_event
      WHERE tenant_id = $1
        AND type = ANY($2::text[])
        AND ts >= $3
        AND payload ? 'transition_payload'
        ${processFilter}
      GROUP BY 1, 2
      ORDER BY 1 DESC, cnt DESC
      LIMIT $4`,
      params,
    );

    return rows.map((r) => ({
      period: r.period,
      period_type: "day" as const,
      actor: r.actor ?? "(не указан)",
      count: parseInt(r.cnt, 10),
    }));
  });
}

// ---------------------------------------------------------------------------
// loadRecordSumsByPeriod — SUM числового поля реестра за период
//
// Источник: choros.record.data (jsonb). field_key двойной-охранный.
// Индекс: (tenant_id, registry_id, created_at DESC) из migration 004.
// ---------------------------------------------------------------------------

export async function loadRecordSumsByPeriod(
  pool: pg.Pool,
  tenantId: string,
  registryDefId: string,
  fieldKey: string,
  cutoffMs: number,
  periodType: "day" | "week" | "month",
  limit: number,
): Promise<RecordSumPeriodRow[]> {
  // Both UUID guard and field_key guard before ANY SQL construction.
  assertUuid(registryDefId, "registryDefId");
  assertSafeFieldKey(fieldKey);

  const fmtMap: Record<typeof periodType, string> = {
    day: "YYYY-MM-DD",
    week: "IYYY-\"W\"IW",
    month: "YYYY-MM",
  };
  const fmt = fmtMap[periodType];

  return withTenant(pool, tenantId, async (client) => {
    // fieldKey already validated by assertSafeFieldKey (charset guard).
    // It is used as a JSON path key (data->>'<key>') — PostgreSQL treats the key
    // as a string literal in this operator, not as SQL. The charset guard ensures
    // no injection is possible even in the JSON-operator context.
    const { rows } = await client.query<{
      period: string;
      total: string | null;
      row_count: string;
    }>(
      `SELECT
         to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE 'UTC', '${fmt}') AS period,
         SUM(NULLIF(data->>'${fieldKey}', '')::numeric)::float                    AS total,
         COUNT(*)                                                                  AS row_count
       FROM choros.record
      WHERE tenant_id = $1
        AND registry_id = $2
        AND created_at >= $3
        AND data ? '${fieldKey}'
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $4`,
      [tenantId, registryDefId, cutoffMs, limit],
    );

    return rows.map((r) => ({
      period: r.period,
      period_type: periodType,
      total: r.total != null ? parseFloat(r.total) : 0,
      row_count: parseInt(r.row_count, 10),
    }));
  });
}

// ---------------------------------------------------------------------------
// loadOperationalAnalytics — публичная точка входа
// ---------------------------------------------------------------------------

export interface LoadOperationalAnalyticsParams {
  processKey?: string;
  /** registry_def_id для агрегата по записям. Если не указан — суммы не считаются. */
  registryDefId?: string;
  /** field_key внутри record.data для суммирования (например "amount"). */
  fieldKey?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export async function loadOperationalAnalytics(
  pool: pg.Pool,
  tenantId: string,
  params: LoadOperationalAnalyticsParams = {},
  nowMs: number = Date.now(),
): Promise<OperationalAnalyticsResult> {
  const { processKey, registryDefId, fieldKey } = params;

  // Cutoffs:
  const cutoff30d = nowMs - 30 * DAY_MS;
  const cutoff12w = nowMs - 12 * WEEK_MS;
  const cutoff12m = nowMs - 366 * DAY_MS;   // ~12 месяцев

  // Параллельная загрузка всех агрегатов
  const [daily, weekly, monthly, topActors] = await Promise.all([
    loadPeriodWorkload(pool, tenantId, processKey, cutoff30d, "day", 30),
    loadPeriodWorkload(pool, tenantId, processKey, cutoff12w, "week", 12),
    loadPeriodWorkload(pool, tenantId, processKey, cutoff12m, "month", 12),
    loadActorWorkload(pool, tenantId, processKey, cutoff30d, 20),
  ]);

  // Суммы по записям — только если указан реестр + поле
  let recordSums: RecordSumPeriodRow[] | undefined;
  if (
    registryDefId !== undefined &&
    registryDefId !== "" &&
    fieldKey !== undefined &&
    fieldKey !== ""
  ) {
    recordSums = await loadRecordSumsByPeriod(
      pool,
      tenantId,
      registryDefId,
      fieldKey,
      cutoff30d,
      "day",
      30,
    );
  }

  const result: OperationalAnalyticsResult = {
    tenant_id: tenantId,
    workload_daily: daily,
    workload_weekly: weekly,
    workload_monthly: monthly,
    top_actors: topActors,
  };

  if (recordSums !== undefined) {
    (result as { record_sums?: RecordSumPeriodRow[] }).record_sums = recordSums;
    (result as { registry_def_id?: string }).registry_def_id = registryDefId;
    (result as { field_key?: string }).field_key = fieldKey;
  }

  return result;
}
