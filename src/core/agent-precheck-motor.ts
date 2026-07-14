/**
 * src/core/agent-precheck-motor.ts — T-0233 legal_precheck skill motor (PURE).
 *
 * PURE: no pg / node:http / https / net / fetch / child_process / process.env.
 * IO-free: all IO is behind injected ports in the orchestrator (run-precheck.ts).
 *
 * Exports:
 *   PrecheckOutcome      — discriminated union of the three T-0220 outcomes.
 *   OutcomeSignals       — input to classifyOutcome (all signal flags).
 *   classifyOutcome      — deterministic classifier (T-0220 §3/§4, INV-DEFAULT).
 *
 * Re-exports from llm-port.ts (single source of truth):
 *   PrecheckAnswer / RedFlag — form-bound answer type (D-139: no reasoning).
 *
 * INV-DEFAULT (T-0220 §4): classifyOutcome NEVER returns proceed unless ALL
 *   of: !pdpDenied && !llmError && !llmDormant && !thresholdFailed &&
 *       confidence >= CONFIDENCE_FLOOR && !ambiguous && answer != null.
 * Any undefined / missing signal defaults to defer (soft, default-to-human).
 * Structural failure (no answer) → fail-closed.
 *
 * Priority: fail-closed (1) > defer-to-human (2) > proceed (3).
 */

// Re-export the answer type so orchestrator imports from one place.
export type { PrecheckAnswer, RedFlag } from "./llm-port.js";

// ---------------------------------------------------------------------------
// PrecheckOutcome — T-0220 discriminated union (three outcomes).
// ---------------------------------------------------------------------------

/**
 * The three outcomes of the legal_precheck skill step (T-0220 §3).
 *
 * `proceed` — all gates green, answer is the structured red-flags form.
 * `defer-to-human` — model/threshold uncertainty; inbox-task reference = audit id.
 * `fail-closed` — hard block (PDP deny / LLM error / timeout / egress / dormant).
 */
export type PrecheckOutcome =
  | {
      readonly kind: "proceed";
      readonly answer: import("./llm-port.js").PrecheckAnswer;
    }
  | {
      readonly kind: "defer-to-human";
      readonly doubtReason: string;
      /** Signal category driving the deferral. */
      readonly signal: "threshold" | "model" | "ambiguity" | "dormant";
      /**
       * ID of the `agent.deferred` audit event — the canonical day-1 DB-backed
       * record (audit-floor IS the seam, D-061 ratified no-new-table).
       *
       * T-0221: == audit_event.id == payload.inbox_task_id (self-referential back-link,
       * minted BEFORE append so the reference is stable and exact). The defer record
       * lives on choros.audit_event (open-vocab type='agent.deferred'); there is NO
       * separate task table. Read-projection: src/db/deferred-inbox-store.ts.
       */
      readonly inboxTaskRef: string;
      /**
       * F5 — agent draft for prefilled human escalation. When the LLM completed
       * but fell below the autonomy threshold (or confidence floor), the agent's
       * partial answer is carried here so the human reviewer can accept/edit/reject
       * it rather than starting from scratch. Absent when the LLM was dormant or
       * errored (no draft available).
       */
      readonly agentDraft?: import("./llm-port.js").PrecheckAnswer;
    }
  | {
      readonly kind: "fail-closed";
      readonly cause:
        | "pdp_deny"
        | "llm_error"
        | "llm_timeout"
        | "egress_block"
        | "dormant_no_probe";
      /** For pdp_deny: the deny reason from resolveFor. */
      readonly denyReason?: string;
    };

// ---------------------------------------------------------------------------
// OutcomeSignals — all classification signals fed into classifyOutcome.
// ---------------------------------------------------------------------------

/**
 * All signals from the motor run, fed into classifyOutcome.
 * Each field corresponds to a gate in the INV-DEFAULT classifier.
 *
 * Undefined / missing optional signals default conservatively
 * (undefined confidence → defer; missing answer → fail-closed).
 */
export interface OutcomeSignals {
  /** resolveFor returned denied:true → fail-closed priority 1. */
  readonly pdpDenied: boolean;
  /** PDP deny reason (for pdp_deny cause). */
  readonly pdpReason?: string;
  /** LLM call failed with a specific error kind → fail-closed priority 1. */
  readonly llmError?: "llm_error" | "llm_timeout" | "egress_block" | "dormant_no_probe";
  /** LlmDormantError was thrown (live not configured). */
  readonly llmDormant: boolean;
  /** Model self-confidence from LlmResult.confidence (undefined if call failed). */
  readonly modelConfidence?: number;
  /** autonomy_threshold failed or DMN threshold violated → defer priority 2. */
  readonly thresholdFailed: boolean;
  /** Answer is ambiguous or empty → defer priority 2. */
  readonly ambiguous: boolean;
  /** Structured answer from LlmResult.answer (undefined if call failed). */
  readonly answer?: import("./llm-port.js").PrecheckAnswer;
  /** The inboxTaskRef to use in defer outcome (set by orchestrator after audit write). */
  readonly inboxTaskRef?: string;
  /** doubt reason for defer (set by orchestrator). */
  readonly doubtReason?: string;
}

// ---------------------------------------------------------------------------
// CONFIDENCE_FLOOR — minimum model self-confidence for proceed.
// Default 0.7 (70%). The orchestrator may also apply autonomy_threshold.
// ---------------------------------------------------------------------------

/** Minimum model self-confidence required for a proceed outcome (B.5, T-0220 §5.1). */
export const CONFIDENCE_FLOOR = 0.7;

// ---------------------------------------------------------------------------
// classifyOutcome — deterministic classifier (INV-DEFAULT, T-0220 §3/§4).
// ---------------------------------------------------------------------------

/**
 * Classify an outcome from the collected signals.
 *
 * Priority order (T-0220 §4, INV-DEFAULT):
 *   1. fail-closed  — pdpDenied OR llmError OR (llmDormant AND dormant_no_probe)
 *   2. defer        — llmDormant (signal=dormant) OR thresholdFailed OR
 *                     confidence < CONFIDENCE_FLOOR OR ambiguous OR missing answer
 *   3. proceed      — ONLY when ALL of the above are false AND answer is present
 *
 * `proceed` is the FINAL residual — never a default or optimistic branch.
 */
export function classifyOutcome(signals: OutcomeSignals): PrecheckOutcome {
  // Priority 1: fail-closed — structural/access/hard errors.
  if (signals.pdpDenied) {
    return {
      kind: "fail-closed",
      cause: "pdp_deny",
      denyReason: signals.pdpReason,
    };
  }
  if (signals.llmError != null) {
    return {
      kind: "fail-closed",
      cause: signals.llmError,
    };
  }

  // Priority 2: defer-to-human — uncertainty / dormant / threshold.
  // Dormant default: signal="dormant", NOT fail-closed (day-1 default=defer).
  // The orchestrator may pass cause="dormant_no_probe" via llmError if the
  // process requires a decision and cannot defer — that goes to fail-closed above.
  if (signals.llmDormant) {
    return {
      kind: "defer-to-human",
      signal: "dormant",
      doubtReason: signals.doubtReason ?? "llm runtime dormant — no inference available",
      inboxTaskRef: signals.inboxTaskRef ?? "pending",
    };
  }
  if (signals.thresholdFailed) {
    return {
      kind: "defer-to-human",
      signal: "threshold",
      doubtReason: signals.doubtReason ?? "autonomy threshold not met",
      inboxTaskRef: signals.inboxTaskRef ?? "pending",
    };
  }
  // Confidence gate (B.5 — model self-assessment).
  const conf = signals.modelConfidence;
  if (conf === undefined || conf < CONFIDENCE_FLOOR) {
    return {
      kind: "defer-to-human",
      signal: "model",
      doubtReason: signals.doubtReason ?? `model confidence ${conf ?? "unknown"} below floor ${CONFIDENCE_FLOOR}`,
      inboxTaskRef: signals.inboxTaskRef ?? "pending",
    };
  }
  if (signals.ambiguous) {
    return {
      kind: "defer-to-human",
      signal: "ambiguity",
      doubtReason: signals.doubtReason ?? "answer marked ambiguous",
      inboxTaskRef: signals.inboxTaskRef ?? "pending",
    };
  }
  // No answer → structural fail (should not happen if above gates pass, but fail-closed).
  if (signals.answer == null) {
    return {
      kind: "fail-closed",
      cause: "llm_error",
    };
  }

  // Priority 3: proceed — ALL gates passed.
  return {
    kind: "proceed",
    answer: signals.answer,
  };
}
