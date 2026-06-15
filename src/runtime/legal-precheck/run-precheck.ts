/**
 * src/runtime/legal-precheck/run-precheck.ts — T-0233 orchestrator for legal_precheck.
 *
 * THE ONLY runtime path allowed to read agent_instruction (FF-COMP-6 / AC-11).
 * The dormant gate (agent-instruction-runtime-dormant.sh) has this directory in
 * its ALLOWED_RE narrowly: `src/runtime/legal-precheck/`.
 *
 * Orchestration flow (ADR §4):
 *   1. PDP via resolveFor (T-0021) — single authority, fail-closed on deny.
 *   2. Live-gate: pick dormantLlmPort if !liveEnabled OR llm_* not configured.
 *   3. Read agent_instruction via readPublished (T-0123 DAO) — defer on missing.
 *   4. LLM call through port (catches LlmDormantError / timeout / errors).
 *   5. Classify outcome via classifyOutcome (INV-DEFAULT: fail > defer > proceed).
 *   6. Write EXACTLY ONE audit event (agent.blocked / agent.deferred / actor_event).
 *   7. Return PrecheckOutcome.
 *
 * DESIGN INVARIANTS:
 *   - Single PDP: resolveFor only (AC-7, FF-LP-5).
 *   - Single audit-sink: appendAuditEvent only (AC-8, FF-LP-6).
 *   - reasoning in audit payload only, NEVER in outcome/egress (D-139, AC-9).
 *   - No second resolver, no second table, no second audit-writer.
 *   - Tenant isolation: RLS under caller's SET LOCAL choros.tenant_id (AC-14).
 */

import { randomUUID } from "node:crypto";
import type { PgClientLike, AuditWriter } from "../../db/audit-writer.js";
import type { AuditEventInput } from "../../core/audit-grant-encoder.js";
import type { ResolverDeps } from "../../core/grant-resolver.js";
import { resolveFor } from "../../core/grant-resolver.js";
import type { ObjectHandle, ResolveSubject } from "../../core/object-handle.js";
import { readPublished } from "../../db/agent-instruction-store.js";
import {
  type LlmPort,
  type LlmRequest,
  dormantLlmPort,
  LlmDormantError,
} from "../../core/llm-port.js";
import {
  type PrecheckOutcome,
  type OutcomeSignals,
  classifyOutcome,
  CONFIDENCE_FLOOR,
} from "../../core/agent-precheck-motor.js";

// Re-export types for consumers (invoke.ts dispatch stub).
export type { PrecheckOutcome };

// ---------------------------------------------------------------------------
// PrecheckDeps — injected dependencies (DI pattern: ResolverDeps).
// ---------------------------------------------------------------------------

/**
 * All injected dependencies for runLegalPrecheck.
 *
 * llm        — LlmPort; production: OpenAI adapter; test: stub; default: dormantLlmPort.
 * resolverDeps — T-0021 PDP deps (grants/records/ancestry + optional ports).
 * auditWriter  — T-0016 canonical audit sink.
 * liveEnabled  — deploy-time flag; false → force dormantLlmPort (lock #2 of §6).
 */
export interface PrecheckDeps {
  readonly llm: LlmPort;
  readonly resolverDeps: ResolverDeps;
  readonly auditWriter: AuditWriter;
  /** deploy-time live flag; false ⇒ override to dormantLlmPort regardless of llm_* config. */
  readonly liveEnabled: boolean;
}

// ---------------------------------------------------------------------------
// AgentCard fields needed by the motor (from agent_card table, migrations/032).
// ---------------------------------------------------------------------------

/**
 * Minimal agent_card shape for the live-gate check.
 * llm_endpoint / llm_model / llm_secret_handle NULL = dormant (migrations/032).
 */
export interface AgentCardLlmConfig {
  readonly llm_endpoint: string | null;
  readonly llm_model: string | null;
  readonly llm_secret_handle: string | null;
  readonly autonomy_threshold: number | null;
}

/** Returns true iff all three llm_* fields are non-null (live configured). */
function llmConfigured(card: AgentCardLlmConfig): boolean {
  return (
    card.llm_endpoint != null &&
    card.llm_model != null &&
    card.llm_secret_handle != null
  );
}

// ---------------------------------------------------------------------------
// DB helpers — read agent_card for the target agent.
// ---------------------------------------------------------------------------

async function loadAgentCard(
  tx: PgClientLike,
  tenantId: string,
  agentEmployeeId: string,
): Promise<AgentCardLlmConfig | null> {
  const res = (await tx.query(
    `SELECT llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold
       FROM choros.agent_card
      WHERE tenant_id = $1 AND employee_id = $2`,
    [tenantId, agentEmployeeId],
  )) as { rows: AgentCardLlmConfig[] };
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Audit helpers — build audit event inputs for each outcome branch.
// ---------------------------------------------------------------------------

function blockedAuditEvent(
  agentEmployeeId: string,
  cause: string,
  denyReason: string | undefined,
  nowMs: number,
): AuditEventInput {
  return {
    id: randomUUID(),
    type: "agent.blocked",
    actor: agentEmployeeId,
    subject: `agent:${agentEmployeeId}`,
    scope: { skill: "legal_precheck" },
    via: "legal-precheck-motor",
    proposed_by: null,
    confirmed_by: null,
    payload: { cause, deny_reason: denyReason ?? null },
    occurred_at: nowMs,
  };
}

function deferredAuditEvent(
  agentEmployeeId: string,
  doubtReason: string,
  signal: string,
  reasoningTraceRef: string | null,
  nowMs: number,
): { id: string; input: AuditEventInput } {
  const id = randomUUID();
  return {
    id,
    input: {
      id,
      type: "agent.deferred",
      actor: agentEmployeeId,
      subject: `agent:${agentEmployeeId}`,
      scope: { skill: "legal_precheck", signal },
      via: "legal-precheck-motor",
      proposed_by: null,
      confirmed_by: null,
      // reasoning_trace_ref is the audit-internal reference to the masked reasoning.
      // doubt_reason surfaces to the human reviewer (no raw reasoning here).
      payload: {
        doubt_reason: doubtReason,
        signal,
        reasoning_trace_ref: reasoningTraceRef,
      },
      occurred_at: nowMs,
    },
  };
}

function proceededAuditEvent(
  agentEmployeeId: string,
  answerForm: string,
  reasoningTraceRef: string | null,
  nowMs: number,
): AuditEventInput {
  return {
    id: randomUUID(),
    type: "agent.legal_precheck.proceeded",
    actor: agentEmployeeId,
    subject: `agent:${agentEmployeeId}`,
    scope: { skill: "legal_precheck", answer_form: answerForm },
    via: "legal-precheck-motor",
    proposed_by: null,
    confirmed_by: null,
    // D-139: reasoning_trace_ref is only a reference (opaque), NOT the raw text.
    // The raw reasoning is masked by T-0139 — this payload is safe to persist.
    payload: { answer_form: answerForm, reasoning_trace_ref: reasoningTraceRef },
    occurred_at: nowMs,
  };
}

// ---------------------------------------------------------------------------
// runLegalPrecheck — the single orchestration entry point (ADR §4).
// ---------------------------------------------------------------------------

/**
 * Run one legal_precheck skill step under the caller's tenant tx.
 *
 * Precondition: the caller has already SET LOCAL choros.tenant_id = tenantId
 *   (i.e., tx is inside a withTenantTx call) — RLS is active.
 *
 * Returns exactly one PrecheckOutcome; writes exactly one audit event.
 * Never proceeds without PDP-allow AND all confidence gates (INV-DEFAULT).
 */
export async function runLegalPrecheck(
  tx: PgClientLike,
  deps: PrecheckDeps,
  args: {
    readonly tenantId: string;
    readonly agentEmployeeId: string;
    readonly documentHandle: ObjectHandle;
    readonly subject: ResolveSubject;
    readonly dealContext: { amount: number; kind: string; direction: string };
    readonly nowMs: number;
  },
): Promise<PrecheckOutcome> {
  const { tenantId, agentEmployeeId, documentHandle, subject, dealContext, nowMs } = args;

  // -----------------------------------------------------------------------
  // Step 1: PDP — resolveFor (T-0021, single authority, AC-7).
  // -----------------------------------------------------------------------
  const pdpResult = await resolveFor(
    deps.resolverDeps,
    documentHandle,
    subject,
    "read",
  );

  if (pdpResult.denied) {
    // fail-closed: PDP deny → agent.blocked audit → return.
    const reason = pdpResult.reason;
    const auditIn = blockedAuditEvent(agentEmployeeId, "pdp_deny", reason, nowMs);
    await deps.auditWriter.appendAuditEvent(tx, auditIn);
    return {
      kind: "fail-closed",
      cause: "pdp_deny",
      denyReason: reason,
    };
  }

  // PDP allowed; we have access to fields (pdpResult.fields).
  const documentBody = (() => {
    const f = (pdpResult as { fields?: Record<string, unknown> }).fields;
    if (f && typeof f["body"] === "string") return f["body"] as string;
    // Fallback: JSON-serialize the visible fields as the document body.
    return JSON.stringify(f ?? {});
  })();

  // -----------------------------------------------------------------------
  // Step 2: Live-gate — pick port (FR-7, §6 three locks).
  // Lock #2: liveEnabled=false → force dormant.
  // Lock #3: dormantLlmPort throws on any call.
  // -----------------------------------------------------------------------
  const agentCard = await loadAgentCard(tx, tenantId, agentEmployeeId);
  const isLiveConfigured = agentCard != null && llmConfigured(agentCard);
  const port: LlmPort =
    deps.liveEnabled && isLiveConfigured ? deps.llm : dormantLlmPort;

  // -----------------------------------------------------------------------
  // Step 3: Read agent instruction (T-0123, narrow allowlist FF-COMP-6).
  // This is the ONLY place in runtime that reads agent_instruction.
  // -----------------------------------------------------------------------
  const instr = await readPublished(tx, agentEmployeeId);

  if (instr == null) {
    // defer-to-human: missing instruction → "dormant" signal (ADR §4 missing-instruction).
    const { id: deferAuditId, input: deferInput } = deferredAuditEvent(
      agentEmployeeId,
      "no published instruction for agent",
      "dormant",
      null,
      nowMs,
    );
    await deps.auditWriter.appendAuditEvent(tx, deferInput);
    return {
      kind: "defer-to-human",
      signal: "dormant",
      doubtReason: "no published instruction for agent",
      inboxTaskRef: deferAuditId,
    };
  }

  // Build the LLM request from the instruction.
  const llmReq: LlmRequest = {
    instruction: instr.instructionText,
    document: documentBody,
    dealContext,
    answerForm: instr.answerForm ?? "legal_precheck_v1",
  };

  // -----------------------------------------------------------------------
  // Step 4: Call model through port (catches LlmDormantError / errors).
  // -----------------------------------------------------------------------
  type LlmOutcome =
    | { ok: true; result: import("../../core/llm-port.js").LlmResult }
    | { ok: false; errorKind: OutcomeSignals["llmError"]; dormant: boolean };

  let llmOutcome: LlmOutcome;
  try {
    const result = await port.complete(llmReq);
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

  // -----------------------------------------------------------------------
  // Step 5: Confidence gates + build signals (T-0220 §5.1).
  // -----------------------------------------------------------------------
  let signals: OutcomeSignals;

  if (!llmOutcome.ok) {
    if (llmOutcome.dormant) {
      // defer-to-human for dormant (day-1 default=defer, not fail-closed).
      const { id: deferAuditId, input: deferInput } = deferredAuditEvent(
        agentEmployeeId,
        "llm runtime dormant — inference not available",
        "dormant",
        null,
        nowMs,
      );
      await deps.auditWriter.appendAuditEvent(tx, deferInput);
      return {
        kind: "defer-to-human",
        signal: "dormant",
        doubtReason: "llm runtime dormant — inference not available",
        inboxTaskRef: deferAuditId,
      };
    }
    // LLM error/timeout/egress → fail-closed signals.
    signals = {
      pdpDenied: false,
      llmError: llmOutcome.errorKind,
      llmDormant: false,
      thresholdFailed: false,
      ambiguous: false,
    };
  } else {
    const result = llmOutcome.result;
    const autonomyThreshold = agentCard?.autonomy_threshold ?? null;

    // thresholdFailed: if autonomy_threshold is set AND confidence < threshold.
    const thresholdFailed =
      autonomyThreshold != null && result.confidence < autonomyThreshold;

    // confidence floor: B.5 model self-assessment gate.
    const belowFloor = result.confidence < CONFIDENCE_FLOOR;

    // ambiguous: answer has no red flags AND summary is empty/unclear.
    // Day-1 heuristic: redFlags empty + summary short = potential ambiguity.
    const ambiguous =
      result.answer.redFlags.length === 0 && result.answer.summary.trim().length < 10;

    signals = {
      pdpDenied: false,
      llmDormant: false,
      modelConfidence: result.confidence,
      thresholdFailed: thresholdFailed || belowFloor,
      ambiguous,
      answer: result.answer,
    };
  }

  // -----------------------------------------------------------------------
  // Step 6: Classify outcome (INV-DEFAULT: fail-closed > defer > proceed).
  // -----------------------------------------------------------------------
  // We need to pre-write audit for defer (to get inboxTaskRef = audit id).
  // For proceed: write after classifying.
  // For fail-closed: write inline.

  // Pre-check if we'll defer (to get the audit id first).
  const tentative = classifyOutcome(signals);

  if (tentative.kind === "fail-closed") {
    const auditIn = blockedAuditEvent(
      agentEmployeeId,
      tentative.cause,
      tentative.denyReason,
      nowMs,
    );
    await deps.auditWriter.appendAuditEvent(tx, auditIn);
    return tentative;
  }

  if (tentative.kind === "defer-to-human") {
    // Determine reasoning_trace_ref: not applicable here (call failed or low-conf).
    const { id: deferAuditId, input: deferInput } = deferredAuditEvent(
      agentEmployeeId,
      tentative.doubtReason !== "pending" ? tentative.doubtReason : "unknown doubt reason",
      tentative.signal,
      null,
      nowMs,
    );
    await deps.auditWriter.appendAuditEvent(tx, deferInput);
    return {
      kind: "defer-to-human",
      signal: tentative.signal,
      doubtReason: tentative.doubtReason !== "pending" ? tentative.doubtReason : "unknown",
      inboxTaskRef: deferAuditId,
    };
  }

  // tentative.kind === "proceed"
  // D-139: reasoning goes ONLY into audit payload, NOT into outcome.
  const llmResult = (llmOutcome as { ok: true; result: import("../../core/llm-port.js").LlmResult }).result;
  // reasoning_trace_ref: we store a masked reference (the reasoning id, not the text).
  // Full text masking (T-0139) is production concern; day-1 we record presence only.
  const reasoningTraceRef = llmResult.reasoning != null ? randomUUID() : null;

  const auditIn = proceededAuditEvent(
    agentEmployeeId,
    tentative.answer.answerForm,
    reasoningTraceRef,
    nowMs,
  );
  await deps.auditWriter.appendAuditEvent(tx, auditIn);

  // Return the proceed outcome — answer is safe (no reasoning).
  return {
    kind: "proceed",
    answer: tentative.answer,
  };
}
