/**
 * src/adapters/__tests__/spend-tracking-llm-port.test.ts — T-0477 [E-AGENTS L5]
 *
 * Unit tests for SpendTrackingLlmPort and computeLlmCost.
 *
 * Acceptance criteria verified:
 *   AC-1: chat() records a ledger row when usage × price > 0.
 *   AC-2: ledger-write failure is non-fatal — chat() result still returned.
 *   AC-3: chat() result is passed through unchanged (no mutation).
 *   AC-4: computeLlmCost returns null when both prices are null (no-price connection).
 *   AC-5: computeLlmCost computes correct cost from tokens × prices.
 *   AC-6: row is skipped (not recorded) when no price is configured (null prices).
 *
 * No real DB — uses an in-memory fake that captures insert calls.
 * No network — uses StubChatLlmPort.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SpendTrackingLlmPort,
  type SpendTrackingContext,
} from "../spend-tracking-llm-port.js";
import { computeLlmCost } from "../../db/spend-ledger-dao.js";
import { StubChatLlmPort } from "../../core/__tests__/stub-chat-llm-port.js";
import pg from "pg";

// ---------------------------------------------------------------------------
// Fake pg.Pool — captures all INSERT calls, never touches a real DB.
// ---------------------------------------------------------------------------

interface CapturedQuery {
  text: string;
  values: unknown[] | undefined;
}

function makeFakePool(shouldFail = false): { pool: pg.Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];

  const fakeClient = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (shouldFail && text.trim().toUpperCase().startsWith("INSERT")) {
        throw new Error("simulated DB write failure");
      }
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => fakeClient),
  } as unknown as pg.Pool;

  return { pool, queries };
}

// ---------------------------------------------------------------------------
// SpendTrackingContext factory
// ---------------------------------------------------------------------------

function makeCtx(pool: pg.Pool, overrides: Partial<SpendTrackingContext> = {}): SpendTrackingContext {
  return {
    pool,
    tenantId: "a0000000-0000-0000-0000-000000000001",
    connectionId: "c0000000-0000-0000-0000-000000000001",
    priceInputPer1k: 0.14,
    priceOutputPer1k: 0.28,
    currency: "USD",
    actorSlug: "e-orlov",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeLlmCost tests (pure, no DB)
// ---------------------------------------------------------------------------

describe("computeLlmCost", () => {
  it("AC-4: returns null when both prices are null", () => {
    const result = computeLlmCost(100, 50, null, null);
    expect(result).toBeNull();
  });

  it("AC-5: computes correct cost (input + output tokens × per-1k prices)", () => {
    // 1000 input tokens × $0.14/1k = $0.14
    // 500 output tokens × $0.28/1k = $0.14
    // total = $0.28
    const result = computeLlmCost(1000, 500, 0.14, 0.28);
    expect(result).not.toBeNull();
    expect(result!.amount).toBeCloseTo(0.28, 6);
  });

  it("returns 0 when all token counts are null/zero", () => {
    const result = computeLlmCost(null, null, 0.14, 0.28);
    expect(result).not.toBeNull();
    expect(result!.amount).toBe(0);
  });

  it("handles partial price (only output price set)", () => {
    // 200 input × null → 0, 100 output × $0.28/1k = $0.028
    const result = computeLlmCost(200, 100, null, 0.28);
    expect(result).not.toBeNull();
    expect(result!.amount).toBeCloseTo(0.028, 6);
  });
});

// ---------------------------------------------------------------------------
// SpendTrackingLlmPort tests
// ---------------------------------------------------------------------------

describe("SpendTrackingLlmPort", () => {
  it("AC-1: records a spend row when usage × price > 0", async () => {
    const { pool, queries } = makeFakePool();
    const inner = new StubChatLlmPort();
    // StubChatLlmPort returns { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
    const tracked = new SpendTrackingLlmPort(inner, makeCtx(pool));

    const result = await tracked.chat({
      system: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    // Should have returned the stub result.
    expect(result.text).toBeTruthy();

    // Should have recorded one INSERT into spend_ledger.
    const inserts = queries.filter((q) =>
      q.text.trim().toUpperCase().startsWith("INSERT"),
    );
    expect(inserts.length).toBe(1);

    // The INSERT values should include a positive amount (100/1k*0.14 + 50/1k*0.28 = 0.028).
    const vals = inserts[0].values as unknown[];
    const amount = vals.find((v) => typeof v === "number" && v > 0 && v < 1) as number;
    expect(amount).toBeGreaterThan(0);
  });

  it("AC-3: chat() result is passed through unchanged", async () => {
    const { pool } = makeFakePool();
    const inner = new StubChatLlmPort({ fixedText: "fixed reply" });
    const tracked = new SpendTrackingLlmPort(inner, makeCtx(pool));

    const result = await tracked.chat({
      system: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.text).toBe("fixed reply");
  });

  it("AC-2: ledger-write failure is non-fatal — chat() still returns result", async () => {
    const { pool } = makeFakePool(/* shouldFail= */ true);
    const inner = new StubChatLlmPort();
    const tracked = new SpendTrackingLlmPort(inner, makeCtx(pool));

    // chat() must succeed even though the DB insert will throw.
    const result = await tracked.chat({
      system: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    // Still gets a result.
    expect(result.text).toBeTruthy();
  });

  it("AC-6: no DB insert when no price is configured (both prices null)", async () => {
    const { pool, queries } = makeFakePool();
    const inner = new StubChatLlmPort();
    const tracked = new SpendTrackingLlmPort(
      inner,
      makeCtx(pool, { priceInputPer1k: null, priceOutputPer1k: null }),
    );

    await tracked.chat({
      system: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    // No INSERT should have been executed.
    const inserts = queries.filter((q) =>
      q.text.trim().toUpperCase().startsWith("INSERT"),
    );
    expect(inserts.length).toBe(0);
  });

  it("complete() is passed through to the inner port (no spend tracking)", async () => {
    const { pool, queries } = makeFakePool();
    const inner = new StubChatLlmPort();
    const tracked = new SpendTrackingLlmPort(inner, makeCtx(pool));

    await tracked.complete({
      instruction: "test",
      document: "doc",
      dealContext: { amount: 0, kind: "test", direction: "in" },
      answerForm: "TEST",
    });

    // No INSERT from complete().
    const inserts = queries.filter((q) =>
      q.text.trim().toUpperCase().startsWith("INSERT"),
    );
    expect(inserts.length).toBe(0);
  });
});
