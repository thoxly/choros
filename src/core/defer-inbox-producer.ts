/**
 * src/core/defer-inbox-producer.ts — T-0221 PURE defer-task planner (planDeferTask).
 *
 * PURE: no pg / node:http / https / net / fetch / child_process / process.env.
 * IO-free: transforms a defer-outcome + context into a DeferTaskPlan.
 *
 * INV: planDeferTask is total; doubtReason is always non-empty in the output.
 * Invariant enforced: if input doubtReason is empty/"pending", it is normalised
 * to a safe fallback string.
 *
 * Design: §5.1 of T-0221 ADR. Analogous to classifyOutcome (agent-precheck-motor.ts)
 * — a pure classifier/transformer, static-now-testable without DB or network.
 */

import type { PrecheckAnswer, PrecheckOutcome } from "./agent-precheck-motor.js";

// ---------------------------------------------------------------------------
// DeferTaskPlan — the planned inbox task shape for a defer-to-human outcome.
// ---------------------------------------------------------------------------

export interface DeferTaskPlan {
  /** Role/position the task is addressed to (from PrecheckArgs.deferRole). */
  readonly role: string;
  /** Human-readable name: «Проверить: <doubtReason>» (truncated to 120 chars). */
  readonly name: string;
  /** Non-empty doubt reason (INV: AC-5). Always populated. */
  readonly doubtReason: string;
  /** Source is always "agent" (defer comes from an agent runtime decision). */
  readonly execType: "agent";
  /** employeeId of the agent that deferred. */
  readonly execName: string;
  /** SLA in minutes, optional (comes from PrecheckArgs.deferSlaMinutes). */
  readonly slaMinutes?: number;
  /** Origin of the plan — always "defer". */
  readonly originOutcome: "defer";
  /**
   * F5 — agent draft for prefilled human escalation form.
   * Present when the agent's LLM call produced a partial answer before the
   * autonomy gate rejected it. The human reviewer can accept / edit / reject
   * without starting from scratch. Absent when the LLM was dormant or errored.
   */
  readonly agentDraft?: PrecheckAnswer;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length for the task name field. */
const NAME_MAX_LEN = 120;

/** Fallback doubt reason when the input is empty or the "pending" sentinel. */
const FALLBACK_DOUBT_REASON = "требуется проверка агентом-человеком";

// ---------------------------------------------------------------------------
// humanizeDoubtReason — T-0638 (defect #3): translate KNOWN structural
// doubtReason literals (authored by the engine itself — run-agent-step.ts,
// run-precheck.ts, agent-precheck-motor.ts classifyOutcome) into human-readable
// Russian. Exact-match table ONLY — this is a dictionary of ENGINEERING
// constants (D-064 anti-case: these are code literals we author, not case
// content), never a rewrite of free-form text. Any string NOT in the table
// (an LLM-authored draft summary, a dynamic "model confidence 0.42 below
// floor 0.70" message, or a future signal not yet catalogued here) passes
// through byte-identical — never losing diagnostic detail for an unfamiliar
// reason, mirroring the "unmapped code still legible" principle already used
// by actionErrorMessage/claimErrorMessage (web/src/screens/screen-inbox.jsx).
// ---------------------------------------------------------------------------

/**
 * Exact-match table: raw engine-authored doubtReason literal → human Russian
 * sentence. Keys are the literal strings emitted by run-agent-step.ts /
 * run-precheck.ts / agent-precheck-motor.ts (classifyOutcome's own ??
 * defaults) — the FULL closed set of structural (non-LLM-generated) reasons
 * as of T-0638. New structural reasons introduced later should add an entry
 * here rather than leaving the raw English literal to leak to the human
 * reviewer.
 */
const DOUBT_REASON_TRANSLATIONS: ReadonlyMap<string, string> = new Map([
  [
    "no published instruction for agent",
    "агенту не назначена инструкция — требуется настройка перед автономной работой",
  ],
  [
    "llm runtime dormant — inference not available",
    "модель агента не подключена (нет активного ключа) — решение принимает человек",
  ],
  [
    "llm runtime dormant — no inference available",
    "модель агента не подключена (нет активного ключа) — решение принимает человек",
  ],
  [
    "autonomy threshold not met",
    "агент не уверен в решении настолько, чтобы действовать самостоятельно",
  ],
  [
    "answer marked ambiguous",
    "ответ агента признан неоднозначным — нужна проверка человеком",
  ],
  [
    "critical operation — agent never executes critical steps (F3); escalated to human",
    "это критичный шаг — агенту не разрешено выполнять его самостоятельно",
  ],
  [
    "instance budget exhausted — deferred to human",
    "у процесса исчерпан бюджет на автономные действия агента — дальше решает человек",
  ],
]);

/**
 * Translate a raw doubtReason to human-readable Russian when it exactly
 * matches a known structural literal; otherwise return it unchanged (honest
 * passthrough — never drops diagnostic content for an unfamiliar reason,
 * e.g. LLM-generated draft summaries or a dynamic confidence-value message).
 */
export function humanizeDoubtReason(raw: string): string {
  return DOUBT_REASON_TRANSLATIONS.get(raw) ?? raw;
}

// ---------------------------------------------------------------------------
// planDeferTask — pure transform.
// ---------------------------------------------------------------------------

/**
 * Build a DeferTaskPlan from a defer-to-human outcome and caller context.
 *
 * Total function: never throws; normalises empty/pending doubtReason to
 * a safe fallback so the INV (AC-5: doubt_reason non-empty) always holds.
 *
 * @param outcome  - the defer-to-human PrecheckOutcome from classifyOutcome/runLegalPrecheck.
 * @param ctx      - caller context: role to address, agent employee id, optional SLA.
 */
export function planDeferTask(
  outcome: Extract<PrecheckOutcome, { kind: "defer-to-human" }>,
  ctx: {
    readonly role: string;
    readonly agentEmployeeId: string;
    readonly slaMinutes?: number;
  },
): DeferTaskPlan {
  // Normalise doubtReason — must be non-empty (INV AC-5).
  const rawDoubt = outcome.doubtReason;
  const normalisedDoubt =
    !rawDoubt || rawDoubt.trim() === "" || rawDoubt === "pending"
      ? FALLBACK_DOUBT_REASON
      : rawDoubt.trim();
  // T-0638 (defect #3): translate KNOWN structural literals to human Russian.
  // Unknown/free-form text (LLM draft summaries, dynamic confidence messages)
  // passes through unchanged — see humanizeDoubtReason doc-comment.
  const doubtReason = humanizeDoubtReason(normalisedDoubt);

  // Build name: «Проверить: <doubtReason>» truncated to NAME_MAX_LEN.
  const prefix = "Проверить: ";
  const nameBody = doubtReason;
  const fullName = `${prefix}${nameBody}`;
  const name =
    fullName.length > NAME_MAX_LEN
      ? `${fullName.slice(0, NAME_MAX_LEN - 1)}…`
      : fullName;

  return {
    role: ctx.role,
    name,
    doubtReason,
    execType: "agent",
    execName: ctx.agentEmployeeId,
    slaMinutes: ctx.slaMinutes,
    originOutcome: "defer",
    agentDraft: outcome.agentDraft,
  };
}
