/**
 * src/adapters/spend-tracking-llm-port.ts — T-0477 [E-AGENTS L5]
 *
 * SpendTrackingLlmPort — a transparent wrapper around any LlmPort that
 * records LLM spend (tokens × price) to spend_ledger on each chat() call.
 *
 * NON-FATAL CONTRACT (spec §7 point 2):
 *   A ledger-write failure MUST NOT break the chat call. The chat() result is
 *   returned unconditionally; any error from the ledger write is caught,
 *   logged, and silently discarded. The chat() always succeeds or fails on
 *   its own merits — ledger errors are advisory.
 *
 * PLACEMENT: src/adapters/ (has IO / DB access — not for core/). The
 * composition root (src/server.ts) wires it around the resolved LlmPort.
 *
 * Pattern: mirrors OpenAILlmPort (same file family, similar RL-3 notes).
 * No new secrets flow through here — purely token-count + price arithmetic.
 */

import pg from "pg";
import type {
  LlmPort,
  LlmRequest,
  LlmResult,
  ChatLlmRequest,
  ChatLlmResult,
} from "../core/llm-port.js";
import {
  recordLlmSpend,
  computeLlmCost,
} from "../db/spend-ledger-dao.js";
import type { PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// SpendTrackingContext — the info needed to record spend.
// ---------------------------------------------------------------------------

export interface SpendTrackingContext {
  /** The pg.Pool used to write spend rows. */
  readonly pool: pg.Pool;
  /** The tenant the chat is running for. */
  readonly tenantId: string;
  /**
   * The llm_connection UUID that produced this port, if known.
   * NULL → the row is still inserted (when amount > 0) but with no FK.
   */
  readonly connectionId: string | null;
  /**
   * Input-token price per 1k tokens for this connection, if configured.
   * NULL → no amount computed → row is skipped (no-price connections = no ledger row).
   */
  readonly priceInputPer1k: number | null;
  /**
   * Output-token price per 1k tokens for this connection, if configured.
   */
  readonly priceOutputPer1k: number | null;
  /** ISO-4217-ish currency (from llm_connection.currency). */
  readonly currency: string;
  /** Optional actor slug for the description field (identification only). */
  readonly actorSlug?: string | null;
}

// ---------------------------------------------------------------------------
// SpendTrackingLlmPort
// ---------------------------------------------------------------------------

/**
 * Transparent LlmPort wrapper that records spend to spend_ledger on chat().
 *
 * complete() is passed through unchanged (no token-count contract on the
 * precheck path — the spec focuses on chat()).
 *
 * Usage:
 *   const tracked = new SpendTrackingLlmPort(realPort, ctx);
 *   // inject `tracked` as the llm in AssistantRouteDeps (HandlerContext.llm)
 */
export class SpendTrackingLlmPort implements LlmPort {
  private readonly inner: LlmPort;
  private readonly ctx: SpendTrackingContext;

  constructor(inner: LlmPort, ctx: SpendTrackingContext) {
    this.inner = inner;
    this.ctx = ctx;
  }

  // Pass-through — no spend tracking on the precheck/complete() path.
  complete(req: LlmRequest): Promise<LlmResult> {
    return this.inner.complete(req);
  }

  /**
   * chat() — call the inner port, then record spend non-fatally.
   * The chat result is ALWAYS returned (ledger errors don't propagate).
   */
  async chat(req: ChatLlmRequest): Promise<ChatLlmResult> {
    const result = await this.inner.chat(req);

    // Non-fatal spend recording (spec §7 point 2).
    try {
      const usage = result.usage;
      const cost = usage
        ? computeLlmCost(
            usage.promptTokens,
            usage.completionTokens,
            this.ctx.priceInputPer1k,
            this.ctx.priceOutputPer1k,
          )
        : null;

      // Skip recording if no price is configured (cost === null).
      // Also skip if amount is zero or negative (rounding edge case).
      if (cost !== null && cost.amount > 0) {
        await this._recordSpend(usage ?? null, cost.amount);
      }
    } catch (err) {
      // NON-FATAL: log and continue — the caller already has the result.
      console.error(
        `[T-0477] spend-tracking write failed (non-fatal): ${String(err)}`,
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private: open a fresh tx, write one ledger row, commit.
  // ---------------------------------------------------------------------------

  private async _recordSpend(
    usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null,
    amount: number,
  ): Promise<void> {
    const client: pg.PoolClient = await this.ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${this.ctx.tenantId}'`);
      await client.query("SET LOCAL search_path TO choros");

      await recordLlmSpend(
        client as unknown as PgClientLike,
        {
          tenantId: this.ctx.tenantId,
          llmConnectionId: this.ctx.connectionId,
          actorSlug: this.ctx.actorSlug ?? null,
          promptTokens: usage?.promptTokens ?? null,
          completionTokens: usage?.completionTokens ?? null,
          totalTokens: usage?.totalTokens ?? null,
          amount,
          currency: this.ctx.currency,
          description: this.ctx.actorSlug
            ? `assistant.chat / ${this.ctx.actorSlug}`
            : "assistant.chat",
        },
        Date.now(),
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err; // re-throw so outer try/catch can log it
    } finally {
      client.release();
    }
  }
}
