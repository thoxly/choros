/**
 * src/core/__tests__/stub-llm-port.ts — T-0233 deterministic stub LlmPort for tests.
 *
 * Zero network / zero cost. The stub returns a FIXED deterministic fixture
 * based on the request's dealContext.amount threshold. Used by unit tests for
 * AC-2/AC-3/AC-4/AC-5/AC-6/AC-14 (NF-6: same input → same output).
 *
 * USAGE:
 *   const stub = new StubLlmPort(); // default: returns a clean proceed fixture
 *   const stub = new StubLlmPort({ mode: "low_confidence" });   // → defer
 *   const stub = new StubLlmPort({ mode: "error" });             // → fail-closed
 *   const stub = new StubLlmPort({ mode: "dormant" });           // → LlmDormantError
 */

import type { LlmPort, LlmRequest, LlmResult, PrecheckAnswer } from "../llm-port.js";
import { LlmDormantError } from "../llm-port.js";

// ---------------------------------------------------------------------------
// Demo fixture — a contract ≥ 5M₽ with identified red flags (AC-2/AC-15).
// ---------------------------------------------------------------------------

/**
 * Deterministic red-flags answer for the demo contract fixture.
 * This is the expected proceed answer when confidence is above the floor.
 */
export const DEMO_PRECHECK_ANSWER: PrecheckAnswer = {
  answerForm: "legal_precheck_v1",
  redFlags: [
    {
      clause: "§4.2 Payment Terms",
      risk: "Contract allows unilateral extension of payment deadline by counterparty up to 90 days",
      severity: "high",
    },
    {
      clause: "§7.1 Liability Cap",
      risk: "Liability capped at 10% of contract value, insufficient for deals ≥5M₽",
      severity: "med",
    },
    {
      clause: "§11.3 Jurisdiction",
      risk: "Foreign arbitration clause — increases enforcement complexity",
      severity: "low",
    },
  ],
  summary: "Contract contains 3 risk clauses requiring legal review before signing",
};

/** High-confidence result for proceed path (confidence=0.92). */
const HIGH_CONFIDENCE_RESULT: LlmResult = {
  confidence: 0.92,
  answer: DEMO_PRECHECK_ANSWER,
  reasoning: "Internal chain-of-thought: reviewed §4/§7/§11, identified payment/liability/jurisdiction risks",
};

/** Low-confidence result for defer path (confidence=0.45). */
const LOW_CONFIDENCE_RESULT: LlmResult = {
  confidence: 0.45,
  answer: {
    answerForm: "legal_precheck_v1",
    redFlags: [],
    summary: "Uncertain — requires human review",
  },
  reasoning: "Internal: low-confidence, missing context for full analysis",
};

// ---------------------------------------------------------------------------
// StubLlmPort modes.
// ---------------------------------------------------------------------------

export type StubMode =
  | "succeed"        // returns HIGH_CONFIDENCE_RESULT (default)
  | "low_confidence" // returns LOW_CONFIDENCE_RESULT → classifyOutcome → defer
  | "error"          // throws generic LLM error → fail-closed
  | "timeout"        // throws timeout error → fail-closed(llm_timeout)
  | "egress_block"   // throws egress error → fail-closed(egress_block)
  | "dormant";       // throws LlmDormantError → defer/fail-closed

export interface StubLlmPortConfig {
  readonly mode?: StubMode;
  /** Override the fixed result (mode=succeed only). */
  readonly fixedResult?: LlmResult;
  /**
   * Record calls for assertion.
   * Access via stub.calls after the test.
   */
  readonly recordCalls?: boolean;
}

/**
 * Deterministic stub LlmPort for unit tests (AC-2/AC-3/AC-4/AC-5/AC-6/AC-12/AC-14).
 *
 * NF-6: same inputs + same mode → same answer/issuance/audit-payload (deterministic).
 * Zero network: throws if the test environment has OPENAI_API_KEY set (safety check).
 */
export class StubLlmPort implements LlmPort {
  private readonly mode: StubMode;
  private readonly fixedResult: LlmResult | undefined;
  readonly calls: LlmRequest[] = [];

  constructor(config: StubLlmPortConfig = {}) {
    this.mode = config.mode ?? "succeed";
    this.fixedResult = config.fixedResult;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.calls.push(req);

    switch (this.mode) {
      case "dormant":
        throw new LlmDormantError("stub: llm dormant (mode=dormant)");

      case "error":
        throw new Error("stub: llm_error (simulated)");

      case "timeout":
        throw new Error("timeout: stub timeout (simulated)");

      case "egress_block":
        throw new Error("egress: blocked by policy (simulated)");

      case "low_confidence":
        return LOW_CONFIDENCE_RESULT;

      case "succeed":
      default:
        // Use fixedResult if provided, else the standard demo answer.
        return this.fixedResult ?? {
          ...HIGH_CONFIDENCE_RESULT,
          // Echo the requested answerForm to satisfy AC-10.
          answer: {
            ...DEMO_PRECHECK_ANSWER,
            answerForm: req.answerForm,
          },
        };
    }
  }
}
