/**
 * src/runtime/intake/intake-types.ts — T-0219 DEMO-2 intake-agent (PURE TYPES).
 *
 * The typed shape of the intake-agent's classification output for the S2 «Триаж»
 * slot of the linear ТЭЛ (T-0218 INTAKE_SLOT). This module CLOSES the T-0218
 * review flag «route output shape is prose» by giving `route` a concrete typed
 * form (IntakeRoute) whose `legal_required` field is the load-bearing S2→S3 link.
 *
 * PURE: zero pg / src/db / network / process.env imports. No competence-instruction
 * table read (the runtime-dormant gate's allowlist is narrow — only legal-precheck).
 */

// ---------------------------------------------------------------------------
// Route (the typed answer to the review's «route = prose» flag).
// ---------------------------------------------------------------------------

/** A mandatory approver role in the demo ТЭЛ routing chain (reference-tel §1.4). */
export type IntakeApproverRole = "fin_controller" | "legal" | "cfo";

/** One ordered, mandatory approver in the route chain. */
export interface IntakeApprover {
  /** Position in the chain (1..N). */
  readonly order: number;
  /** The mandatory approver role. */
  readonly role: IntakeApproverRole;
  /** Why this approver is mandatory (carried into the reasoning-trace). */
  readonly reason: string;
  /** Demo route = only mandatory approvers (no optional/cc step). */
  readonly mandatory: true;
}

/**
 * The typed route derived from amount + category (closes the review flag).
 *
 * `legal_required` is the LOAD-BEARING S2→S3 link: it equals
 * `amount >= TEL_LEGAL_THRESHOLD_RUB` (≡ legalGateFires(amount) in tel-scenario.ts
 * ≡ the legal-precheck slot trigger built by T-0234). The slot feeds S3's
 * dealContext { amount, kind: category, direction } from the same classification.
 */
export interface IntakeRoute {
  /** Ordered chain of mandatory S4 approvers. */
  readonly steps: readonly IntakeApprover[];
  /** amount ≥ 5M₽ → S3 legal-precheck fires (≡ legalGateFires). */
  readonly legal_required: boolean;
  /** Flat ordered list of role codes (UI / audit convenience). */
  readonly approver_chain: readonly string[];
}

// ---------------------------------------------------------------------------
// Classifier input / output.
// ---------------------------------------------------------------------------

/** The submitted request fields the slot consumes (T-0218 INTAKE_SLOT.consumes). */
export interface IntakeInput {
  readonly subject: string;
  readonly amount: number;
  readonly justification: string;
  readonly requester: string;
}

/** Spend/procurement category (demo discrete buckets). */
export type IntakeCategory = "it_expense" | "aho" | "marketing";

/**
 * One structured reasoning-trace step (D-139 safe level: a claim + its basis,
 * NOT chain-of-thought verbatim). Surfaced on S2 as «why the agent decided X».
 */
export interface IntakeReasoningStep {
  /** The decision asserted (e.g. "category=it_expense"). */
  readonly claim: string;
  /** The basis for the decision (e.g. "keyword 'лицензии ПО' in subject"). */
  readonly basis: string;
}

/** The safe external answer the slot produces (answer_form=intake_triage_v1). */
export interface IntakeAnswer {
  readonly category: IntakeCategory;
  readonly budget_article: string;
  readonly direction: "buy" | "sell";
  readonly route: IntakeRoute;
}

/**
 * Full classifier result. `answer` is the safe external form; `reasoning_trace`
 * is the in-process structured «why» (D-139: stays inside the boundary, no
 * external egress — it parallels the answer, never carries raw reasoning out).
 */
export interface IntakeClassification {
  readonly answer: IntakeAnswer;
  readonly reasoning_trace: readonly IntakeReasoningStep[];
  readonly answer_form: "intake_triage_v1";
}
