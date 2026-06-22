/**
 * src/runtime/agent-dispatch/run-agent-step.ts — T-0378 [D4] (PD-2 dispatcher).
 *
 * The domain-NEUTRAL motor orchestrator: the de-legal-precheck'd sibling of
 * run-precheck.ts. It does NOT mutate the legal-precheck orchestrator (which keeps
 * its narrow skill/gate path intact). It REUSES the pure classifier verbatim:
 *   classifyOutcome / OutcomeSignals / CONFIDENCE_FLOOR (agent-precheck-motor.ts)
 *   LlmPort / LlmRequest / dormantLlmPort / LlmDormantError (llm-port.ts)
 *
 * Flow (ADR §3 / §4):
 *   1. Gate B (criticality) — critical step → force defer (signal=threshold),
 *      NEVER spend an LLM call. (F3: agent never does critical itself.)
 *   2. Gate C (budget) — exhausted → force defer. (No LLM call.)
 *   3. Missing instruction → force defer (signal=dormant). (No LLM call.)
 *   4. Live-gate — pick dormantLlmPort unless liveEnabled AND llm_* configured.
 *   5. Build a NEUTRAL LlmRequest from objective (instruction + record snapshot).
 *   6. Call port.complete (catches LlmDormantError / timeout / egress / error).
 *   7. Build OutcomeSignals (gate A = autonomy_threshold + CONFIDENCE_FLOOR).
 *   8. classifyOutcome — INV-DEFAULT: fail-closed > defer > proceed.
 *
 * DORMANT keystone: with a dormant agent_card (llm_* NULL) OR liveEnabled=false the
 * port is dormantLlmPort → complete() throws LlmDormantError → classifyOutcome →
 * defer-to-human (signal=dormant). ZERO LLM spend, full weld proven. The live
 * `proceed` path is coded here and exercised once llm_* is flipped on (no code
 * change). The motor performs NO write — the caller (dispatch-outcome.ts) decomposes.
 */

import {
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  dormantLlmPort,
  LlmDormantError,
} from "../../core/llm-port.js";
import {
  type PrecheckOutcome,
  type OutcomeSignals,
  classifyOutcome,
  CONFIDENCE_FLOOR,
} from "../../core/agent-precheck-motor.js";
import { MIN_AUTONOMY_THRESHOLD } from "../../core/agent-hire.js";
import type { AgentStepContext } from "./agent-step-context.js";

// Re-export the outcome union for the dispatch loop / outcome decomposer.
export type { PrecheckOutcome };

// ---------------------------------------------------------------------------
// F4 — DEFAULT_AUTONOMY_THRESHOLD: tenant-level default for gate A.
//
// Applied when agent_card.autonomy_threshold IS NULL (no per-agent override).
// This is the "tenant default" called out in spec §7/F4. No new table: a
// conservative hard-coded constant covers day-1. A future tenant-config column
// (e.g. tenant_settings.autonomy_threshold) would shadow this via DI at the
// composition root without touching the motor logic here.
//
// Value 0.85 (85%) is more conservative than CONFIDENCE_FLOOR (0.70): an agent
// proceeds autonomously only with very high confidence. This asymmetry is
// intentional — CONFIDENCE_FLOOR is a hard structural floor (below it the model
// self-assessment is unreliable); the autonomy threshold is a policy gate
// (above CONFIDENCE_FLOOR but below threshold → the model is confident BUT the
// tenant policy requires human oversight for the step).
// ---------------------------------------------------------------------------
export const DEFAULT_AUTONOMY_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// RunAgentStepDeps — injected (DI, mirrors PrecheckDeps minus the PDP).
// ---------------------------------------------------------------------------

/**
 * Dependencies for runAgentStep.
 *
 * llm         — LlmPort; production: BYO adapter; test: stub; default: dormantLlmPort.
 * liveEnabled — deploy-time flag; false → force dormant regardless of llm_* config.
 *
 * The PDP read-gate from run-precheck.ts is NOT replicated here for the keystone:
 * the agent's grants are already the basis of its toolset (resolveAgentToolset) and
 * the criticality ceiling (gate B); the record-ref read happened in context assembly.
 * A per-objective PDP read is a follow-up (T-0378-F2, lands with a live toolset that
 * actually reads sensitive fields).
 */
export interface RunAgentStepDeps {
  readonly llm: LlmPort;
  /** deploy-time live flag; false ⇒ override to dormantLlmPort. */
  readonly liveEnabled: boolean;
}

/** Returns true iff all three llm_* fields are non-null (live configured). */
function llmConfigured(llm: AgentStepContext["llm"]): boolean {
  return llm.endpoint != null && llm.model != null && llm.secretHandle != null;
}

// ---------------------------------------------------------------------------
// Neutral LlmRequest builder (ADR §3 / §10 Q3, T-0379 F1 integration).
//
// Reuses the existing LlmRequest shape (instruction + document + answerForm).
// The `document` is now the F1-compiled objective prompt (T-0379) — a structured
// neutral string that includes step name, inputs/outputs, configurator NL hint,
// and the published instruction text, produced by compileObjective in
// objective-compiler.ts.  The record-ref snapshot is included as a supplementary
// JSON block so the LLM has both the structured prose (prompt) and the raw field
// values for precise reasoning.  dealContext is a neutral placeholder.
// ---------------------------------------------------------------------------

function buildNeutralLlmRequest(ctx: AgentStepContext): LlmRequest {
  // The compiled prompt (T-0379) is always present (non-empty string).
  // Supplement it with the raw record snapshot for field-level precision.
  const supplementaryData: Record<string, unknown> = {
    record_snapshot: ctx.recordRef.snapshot,
    objective_fields: ctx.objective.fields,
  };
  const document = [
    ctx.objective.prompt,
    "---",
    JSON.stringify(supplementaryData),
  ].join("\n");

  return {
    instruction: ctx.objective.instruction,
    document,
    // Neutral placeholder — the agent step carries no deal amount/kind/direction.
    dealContext: { amount: 0, kind: ctx.procKey || "agent_step", direction: "" },
    answerForm: ctx.objective.answerForm,
  };
}

// ---------------------------------------------------------------------------
// runAgentStep — the neutral orchestration entry point.
// ---------------------------------------------------------------------------

/**
 * Run one agent step's motor and return exactly one PrecheckOutcome. Performs NO
 * write and NO step close — pure decision. The caller (applyAgentOutcome) decomposes
 * the outcome into audit + record + outbox + job complete/fail under the tenant tx.
 *
 * Gate ordering (spec §6 A∧B∧C): B and C are evaluated BEFORE the LLM call so a
 * critical step or exhausted budget forces defer WITHOUT spending — fail-closed-correct.
 * Gate A (confidence/threshold) is the motor's internal classifyOutcome gate.
 */
export async function runAgentStep(
  ctx: AgentStepContext,
  deps: RunAgentStepDeps,
): Promise<PrecheckOutcome> {
  // --- Gate B: criticality ceiling — critical → always to human (F3), no LLM. ---
  if (ctx.criticalityLevel === "critical") {
    return {
      kind: "defer-to-human",
      signal: "threshold",
      doubtReason:
        "critical operation — agent never executes critical steps (F3); escalated to human",
      inboxTaskRef: "pending",
    };
  }

  // --- Gate C: budget exhausted → defer (no LLM). ---
  if (ctx.budget.exhausted) {
    return {
      kind: "defer-to-human",
      signal: "threshold",
      doubtReason: "instance budget exhausted — deferred to human",
      inboxTaskRef: "pending",
    };
  }

  // --- Missing published instruction → defer (signal=dormant), no LLM. ---
  if (!ctx.objective.hasInstruction) {
    return {
      kind: "defer-to-human",
      signal: "dormant",
      doubtReason: "no published instruction for agent",
      inboxTaskRef: "pending",
    };
  }

  // --- Live-gate: pick the port (dormant unless live AND configured). ---
  const port: LlmPort =
    deps.liveEnabled && llmConfigured(ctx.llm) ? deps.llm : dormantLlmPort;

  // --- Call the model through the port (catch dormant / timeout / egress / error). ---
  const req = buildNeutralLlmRequest(ctx);
  type LlmOutcome =
    | { ok: true; result: LlmResult }
    | { ok: false; errorKind: OutcomeSignals["llmError"]; dormant: boolean };

  let llmOutcome: LlmOutcome;
  try {
    const result = await port.complete(req);
    llmOutcome = { ok: true, result };
  } catch (err) {
    if (err instanceof LlmDormantError) {
      llmOutcome = { ok: false, errorKind: undefined, dormant: true };
    } else if (err instanceof Error && err.message.toLowerCase().includes("timeout")) {
      llmOutcome = { ok: false, errorKind: "llm_timeout", dormant: false };
    } else if (err instanceof Error && err.message.toLowerCase().includes("egress")) {
      llmOutcome = { ok: false, errorKind: "egress_block", dormant: false };
    } else {
      llmOutcome = { ok: false, errorKind: "llm_error", dormant: false };
    }
  }

  // --- Build signals + classify (INV-DEFAULT). ---
  if (!llmOutcome.ok) {
    if (llmOutcome.dormant) {
      // Dormant default = defer (day-1, NOT fail-closed) — the keystone path.
      return {
        kind: "defer-to-human",
        signal: "dormant",
        doubtReason: "llm runtime dormant — inference not available",
        inboxTaskRef: "pending",
      };
    }
    // LLM error/timeout/egress → fail-closed.
    return classifyOutcome({
      pdpDenied: false,
      llmError: llmOutcome.errorKind,
      llmDormant: false,
      thresholdFailed: false,
      ambiguous: false,
    });
  }

  // --- Live result: gate A (autonomy_threshold) + CONFIDENCE_FLOOR. ---
  const result = llmOutcome.result;

  // F4: resolve autonomy threshold — per-agent override (agent_card.autonomy_threshold)
  // takes precedence; fall back to DEFAULT_AUTONOMY_THRESHOLD (tenant-level default in
  // code, no new table). Either way gate A is ALWAYS active: proceed only when
  // confidence ≥ threshold (the "activate the threshold" requirement from spec §7/F4).
  //
  // Defense-in-depth: clamp any stored value up to MIN_AUTONOMY_THRESHOLD so that
  // a pre-existing sub-floor row (inserted before T-0398) cannot weaken gate A.
  // The canonical floor is enforced at write time in buildAgentHirePlan; this clamp
  // is the read-side backstop for rows that predate the write-side floor.
  const rawThreshold =
    ctx.autonomyThreshold != null ? ctx.autonomyThreshold : DEFAULT_AUTONOMY_THRESHOLD;
  const autonomyThreshold = Math.max(rawThreshold, MIN_AUTONOMY_THRESHOLD);
  const thresholdFailed = result.confidence < autonomyThreshold;
  const belowFloor = result.confidence < CONFIDENCE_FLOOR;
  const ambiguous =
    result.answer.redFlags.length === 0 && result.answer.summary.trim().length < 10;

  const classified = classifyOutcome({
    pdpDenied: false,
    llmDormant: false,
    modelConfidence: result.confidence,
    thresholdFailed: thresholdFailed || belowFloor,
    ambiguous,
    answer: result.answer,
  });

  // F5: if the gate deferred, attach the agent's draft so the human escalation
  // form is prefilled (spec §6/§9 item 6). The LLM returned a valid answer
  // (the agent "tried" but didn't meet the autonomy bar) — carry it forward so
  // the reviewer can accept / edit / reject rather than starting from scratch.
  // Dormant and error paths produce no draft (there is no LLM answer to carry).
  if (classified.kind === "defer-to-human") {
    return { ...classified, agentDraft: result.answer };
  }

  return classified;
}
