/**
 * src/db/spend-ledger-dao.ts — T-0477 [E-AGENTS L5]
 *
 * Thin DAO for the spend_ledger table (migration 034 + extended by 107).
 * Supports:
 *   (A) Recording a spend row from an LLM chat call (tokens × price).
 *   (B) Aggregating spend for the Расход screen.
 *
 * All operations run INSIDE the caller's tenant-scoped transaction
 * (SET LOCAL choros.tenant_id + FORCE RLS) — same convention as other
 * DAOs (llm-connection-dao.ts, audit-writer.ts).
 *
 * ADDITIVE — never touches the ceiling/reservation wiring in agent_budget /
 * reservation. reservation_id and employee_id are written as NULL (migration 107
 * made them nullable for the LLM tracking path).
 *
 * APPEND-ONLY: the spend_ledger immutable trigger (migration 034) prevents
 * UPDATE/DELETE for ALL roles. This DAO only ever INSERTs.
 *
 * NON-FATAL contract: callers MUST wrap calls to recordLlmSpend in try/catch
 * and log + continue on any error — a ledger write failure must NOT break the
 * chat path. This DAO does NOT enforce that (it just throws); the wrapper
 * (SpendTrackingLlmPort / assistant route) is responsible for the try/catch.
 */

import { randomUUID } from "node:crypto";
import type { PgClientLike } from "./audit-writer.js";

// ---------------------------------------------------------------------------
// Input type for recording an LLM spend row.
// ---------------------------------------------------------------------------

export interface LlmSpendInput {
  /** Tenant UUID (doubles as the RLS check). */
  readonly tenantId: string;
  /** The named connection profile used for this call. NULL if not resolved. */
  readonly llmConnectionId: string | null;
  /** Actor slug (agent/user) for description purposes. NULL → "unknown". */
  readonly actorSlug: string | null;
  /** Prompt (input) tokens from the model's usage object. */
  readonly promptTokens: number | null;
  /** Completion (output) tokens from the model's usage object. */
  readonly completionTokens: number | null;
  /** Total tokens (promptTokens + completionTokens as reported by provider). */
  readonly totalTokens: number | null;
  /**
   * Pre-computed cost in the connection's currency.
   * Computed from: (promptTokens/1000 * price_input_per_1k) +
   *                (completionTokens/1000 * price_output_per_1k).
   * NULL when the connection has no price configured.
   */
  readonly amount: number | null;
  /** ISO-4217-ish currency from the connection row. Default "USD". */
  readonly currency: string;
  /** Human-readable context (e.g. "assistant.chat / e-orlov"). */
  readonly description: string | null;
}

// ---------------------------------------------------------------------------
// recordLlmSpend — insert one append-only row.
// ---------------------------------------------------------------------------

/**
 * Insert one LLM-spend row into spend_ledger (append-only).
 * Skips the insert (no-op) when amount is NULL — recording zero-cost calls
 * is noise (no priced connection configured).
 *
 * Runs inside the caller's tenant-scoped tx. tenant_id leads the INSERT.
 * employee_id and reservation_id are written as NULL (nullable per mig 107).
 *
 * Throws on DB error — caller MUST catch and log (non-fatal contract).
 */
export async function recordLlmSpend(
  client: PgClientLike,
  input: LlmSpendInput,
  nowMs: number,
): Promise<void> {
  // Skip if no amount — no price configured on the connection.
  if (input.amount === null || input.amount <= 0) {
    return;
  }

  await client.query(
    `INSERT INTO choros.spend_ledger
       (tenant_id, id, reservation_id, tool_call_id, employee_id,
        instance_budget_id, agent_budget_id,
        amount, currency, description, recorded_at,
        llm_connection_id, prompt_tokens, completion_tokens, total_tokens)
     VALUES ($1, $2, NULL, $3, NULL, NULL, NULL, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.tenantId,
      randomUUID(),
      randomUUID(),           // tool_call_id: synthetic per-call UUID (no idempotency needed)
      input.amount,
      input.currency || "USD",
      input.description,
      nowMs,
      input.llmConnectionId,
      input.promptTokens,
      input.completionTokens,
      input.totalTokens,
    ],
  );
}

// ---------------------------------------------------------------------------
// computeLlmCost — helper to calculate cost from tokens × per-1k price.
// ---------------------------------------------------------------------------

/**
 * Compute the cost of an LLM call from token counts and per-1k prices.
 * Returns null when both prices are absent (no pricing configured).
 * Returns 0 when both prices are zero or all token counts are null/zero.
 */
export function computeLlmCost(
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
  priceInputPer1k: number | null,
  priceOutputPer1k: number | null,
): { amount: number; currency?: string } | null {
  if (priceInputPer1k === null && priceOutputPer1k === null) {
    return null;
  }
  const inp = ((promptTokens ?? 0) / 1000) * (priceInputPer1k ?? 0);
  const out = ((completionTokens ?? 0) / 1000) * (priceOutputPer1k ?? 0);
  return { amount: inp + out };
}

// ---------------------------------------------------------------------------
// Spend aggregate types for the Расход screen.
// ---------------------------------------------------------------------------

export interface SpendByConnection {
  llm_connection_id: string | null;
  connection_name: string | null;
  provider: string | null;
  currency: string;
  total_amount: number;
  total_tokens: number;
  row_count: number;
}

export interface SpendByWindow {
  window: "day" | "month" | "total";
  currency: string;
  total_amount: number;
  total_tokens: number;
  row_count: number;
}

export interface SpendRow {
  id: string;
  llm_connection_id: string | null;
  connection_name: string | null;
  provider: string | null;
  amount: number;
  currency: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  description: string | null;
  recorded_at: number;
}

// ---------------------------------------------------------------------------
// Internal DB row types (pg returns untyped rows — cast for type safety).
// ---------------------------------------------------------------------------

interface SpendByConnectionDbRow {
  llm_connection_id: string | null;
  connection_name: string | null;
  provider: string | null;
  currency: string;
  total_amount: string;
  total_tokens: string;
  row_count: string;
}

interface SpendByWindowDbRow {
  window: string;
  currency: string;
  total_amount: string;
  total_tokens: string;
  row_count: string;
}

interface SpendRowDb {
  id: string;
  llm_connection_id: string | null;
  connection_name: string | null;
  provider: string | null;
  amount: string;
  currency: string;
  prompt_tokens: string | null;
  completion_tokens: string | null;
  total_tokens: string | null;
  description: string | null;
  recorded_at: string;
}

// ---------------------------------------------------------------------------
// getSpendByConnection — aggregate grouped by llm_connection_id.
// ---------------------------------------------------------------------------

/**
 * Aggregate spend rows for the tenant grouped by connection profile.
 * Joins to llm_connection for display name + provider.
 * Runs inside the caller's tenant-scoped tx.
 */
export async function getSpendByConnection(
  client: PgClientLike,
  tenantId: string,
  windowDays?: number,
): Promise<SpendByConnection[]> {
  const cutoff = windowDays != null
    ? Date.now() - windowDays * 24 * 60 * 60 * 1000
    : null;

  const { rows } = await client.query(
    `SELECT
       sl.llm_connection_id,
       lc.name            AS connection_name,
       lc.provider        AS provider,
       sl.currency,
       SUM(sl.amount)::float              AS total_amount,
       SUM(COALESCE(sl.total_tokens, 0))  AS total_tokens,
       COUNT(*)                           AS row_count
     FROM choros.spend_ledger sl
     LEFT JOIN choros.llm_connection lc
            ON lc.tenant_id = sl.tenant_id AND lc.id = sl.llm_connection_id
    WHERE sl.tenant_id = $1
      ${cutoff !== null ? "AND sl.recorded_at >= $2" : ""}
    GROUP BY sl.llm_connection_id, lc.name, lc.provider, sl.currency
    ORDER BY total_amount DESC`,
    cutoff !== null ? [tenantId, cutoff] : [tenantId],
  );
  return (rows as SpendByConnectionDbRow[]).map((r) => ({
    llm_connection_id: r.llm_connection_id,
    connection_name: r.connection_name,
    provider: r.provider,
    currency: r.currency,
    total_amount: Number(r.total_amount),
    total_tokens: Number(r.total_tokens),
    row_count: Number(r.row_count),
  }));
}

// ---------------------------------------------------------------------------
// getSpendWindows — aggregate by day / month / total windows.
// ---------------------------------------------------------------------------

/**
 * Return spend totals for the three windows: day (24h), month (30d), total (all).
 * Runs inside the caller's tenant-scoped tx.
 */
export async function getSpendWindows(
  client: PgClientLike,
  tenantId: string,
): Promise<SpendByWindow[]> {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const dayCutoff = now - dayMs;
  const monthCutoff = now - 30 * dayMs;

  // NOTE: "window" is a reserved keyword in PostgreSQL (WINDOW clause). It MUST be
  // double-quoted everywhere it is used as a column alias / ORDER BY target —
  // an unquoted `AS window` / `ORDER BY window` raises a syntax error and 500s
  // the /api/spend route. Quoting keeps the result key as `window` for the mapper.
  const { rows } = await client.query(
    `SELECT
       'total' AS "window",
       COALESCE(currency, 'USD') AS currency,
       SUM(amount)::float                 AS total_amount,
       SUM(COALESCE(total_tokens, 0))     AS total_tokens,
       COUNT(*)                           AS row_count
     FROM choros.spend_ledger
    WHERE tenant_id = $1
    GROUP BY COALESCE(currency, 'USD')

    UNION ALL

    SELECT
       'month' AS "window",
       COALESCE(currency, 'USD') AS currency,
       SUM(amount)::float,
       SUM(COALESCE(total_tokens, 0)),
       COUNT(*)
     FROM choros.spend_ledger
    WHERE tenant_id = $1
      AND recorded_at >= $2
    GROUP BY COALESCE(currency, 'USD')

    UNION ALL

    SELECT
       'day' AS "window",
       COALESCE(currency, 'USD') AS currency,
       SUM(amount)::float,
       SUM(COALESCE(total_tokens, 0)),
       COUNT(*)
     FROM choros.spend_ledger
    WHERE tenant_id = $1
      AND recorded_at >= $3
    GROUP BY COALESCE(currency, 'USD')
    ORDER BY "window"`,
    [tenantId, monthCutoff, dayCutoff],
  );

  return (rows as SpendByWindowDbRow[]).map((r) => ({
    window: r.window as "day" | "month" | "total",
    currency: r.currency,
    total_amount: Number(r.total_amount),
    total_tokens: Number(r.total_tokens),
    row_count: Number(r.row_count),
  }));
}

// ---------------------------------------------------------------------------
// getRecentSpend — recent individual rows for the activity feed.
// ---------------------------------------------------------------------------

/**
 * Return the most recent N spend rows, with connection name resolved.
 * Runs inside the caller's tenant-scoped tx.
 */
export async function getRecentSpend(
  client: PgClientLike,
  tenantId: string,
  limit = 50,
): Promise<SpendRow[]> {
  const { rows } = await client.query(
    `SELECT
       sl.id,
       sl.llm_connection_id,
       lc.name   AS connection_name,
       lc.provider,
       sl.amount::float    AS amount,
       sl.currency,
       sl.prompt_tokens,
       sl.completion_tokens,
       sl.total_tokens,
       sl.description,
       sl.recorded_at
     FROM choros.spend_ledger sl
     LEFT JOIN choros.llm_connection lc
            ON lc.tenant_id = sl.tenant_id AND lc.id = sl.llm_connection_id
    WHERE sl.tenant_id = $1
    ORDER BY sl.recorded_at DESC
    LIMIT $2`,
    [tenantId, limit],
  );
  return (rows as SpendRowDb[]).map((r) => ({
    id: r.id,
    llm_connection_id: r.llm_connection_id,
    connection_name: r.connection_name,
    provider: r.provider,
    amount: Number(r.amount),
    currency: r.currency,
    prompt_tokens: r.prompt_tokens != null ? Number(r.prompt_tokens) : null,
    completion_tokens: r.completion_tokens != null ? Number(r.completion_tokens) : null,
    total_tokens: r.total_tokens != null ? Number(r.total_tokens) : null,
    description: r.description,
    recorded_at: Number(r.recorded_at),
  }));
}
