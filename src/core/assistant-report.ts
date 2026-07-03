/**
 * src/core/assistant-report.ts — T-0607 (в2/г): honest reporting of assistant
 * outcomes. PURE — no IO, no DB, no LLM, no process.env.
 *
 * Two honesty guarantees live here:
 *
 *   (в2) buildHonestOpsReport — the final assistant text must reflect the REAL
 *        outcomes of the DRAFT ops that were executed. The configurator's LLM
 *        text and the pure-planner changelog are BOTH optimistic (written before
 *        the DB write happens). A live acceptance run showed «Все поля добавлены
 *        ✅» while 4/4 ops had actually FAILED. This function reconciles the
 *        report against the real per-op results: failed ops are shown as failed
 *        (never as «✅ добавлено»), a duplicate op (the artifact already existed)
 *        is distinguished from «not created».
 *
 *   (г) buildDispatchFailureReply — every user message must get EITHER an answer
 *        OR an honest error IN THE THREAD. When the dispatch fails with an error
 *        that is NOT an LLM-unavailability (which has its own honest-503 path,
 *        T-0573), the route persists an assistant message built here instead of
 *        leaving the thread silent behind a bare 500. The raw error is logged
 *        server-side only; the user sees this canonical, jargon-free sentence.
 *
 * JARGON-FREE (N2): the strings below carry no dev-jargon denylist tokens
 * (LLM_NOT_CONFIGURED / OpenAILlmPort / endpoint / secretHandle / stack) and no
 * raw provider/exception text.
 *
 * D-064 (N1): no case literals — this module is generic; the ops it describes
 * come from the caller as opaque descriptions.
 */

// ---------------------------------------------------------------------------
// OpResult — the real outcome of one executed DRAFT op.
// ---------------------------------------------------------------------------

/**
 * Real outcome of one executed op, produced by the HTTP executor AFTER the DB
 * write (co-equal with the visual constructor's write paths).
 */
export interface OpResult {
  /** Human-readable one-liner for this op (the planner's description). */
  readonly description: string;
  /** True when the DB write succeeded. */
  readonly ok: boolean;
  /** Honest failure reason (our own op-error string) — present iff !ok. NEVER raw provider/exception text. */
  readonly error?: string;
  /**
   * True when the op did not change anything because the artifact already
   * existed (e.g. slug already taken / field already present). Distinguishes
   * «уже было — изменений не потребовалось» from «не создано». Only meaningful
   * when !ok (a soft, non-fatal "already there" outcome the executor surfaces).
   */
  readonly duplicate?: boolean;
}

// ---------------------------------------------------------------------------
// buildHonestOpsReport — reconcile the assistant text with real op outcomes.
// ---------------------------------------------------------------------------

/**
 * Compose the honest assistant reply text from the LLM's (optimistic) final
 * text and the REAL per-op outcomes.
 *
 * Contract:
 *  - No failures at all → return `finalTextFromLlm` unchanged (the optimistic
 *    text is truthful when everything actually succeeded).
 *  - Any failure → do NOT surface the optimistic text as a success. Return a
 *    truthful header + an explicit per-op ✓/✗ list. A duplicate outcome is
 *    labelled «уже было» (not «не создано»), a hard failure gets its honest
 *    reason.
 *  - Empty opResults → return `finalTextFromLlm` unchanged (nothing to
 *    reconcile — a plan-only / analyst-style turn).
 */
export function buildHonestOpsReport(
  finalTextFromLlm: string,
  opResults: readonly OpResult[],
): string {
  if (opResults.length === 0) return finalTextFromLlm;

  const failures = opResults.filter((r) => !r.ok);
  if (failures.length === 0) return finalTextFromLlm;

  const okCount = opResults.length - failures.length;
  // Hard failures = not ok AND not a benign duplicate.
  const hardFailures = failures.filter((r) => !r.duplicate);

  const header =
    okCount > 0
      ? `Выполнено частично: ${okCount} из ${opResults.length} операций прошли, ` +
        `${failures.length} — нет. Ниже — фактические исходы.`
      : `Ни одна из ${opResults.length} операций не была выполнена. Ниже — фактические исходы.`;

  const lines = opResults.map((r) => {
    if (r.ok) return `✓ ${r.description}`;
    if (r.duplicate) {
      // Not a failure of intent — the artifact already existed, no change needed.
      return `• ${r.description} — уже было, изменений не потребовалось.`;
    }
    const reason = r.error && r.error.trim().length > 0 ? ` — ${r.error.trim()}` : "";
    return `✗ ${r.description}${reason}`;
  });

  // Only surface the LLM's own prose when it is NOT a bare success claim that
  // the failures would contradict. We conservatively DROP the optimistic text
  // on any hard failure (the header + list carry the truth); on duplicate-only
  // outcomes we keep nothing extra either (the list is self-explanatory).
  const tail = hardFailures.length > 0
    ? "\n\nЧасть операций не удалась — исправьте причину и повторите. Ничего лишнего не создано и не перезаписано (все изменения — в черновике)."
    : "";

  return `${header}\n\n${lines.join("\n")}${tail}`;
}

// ---------------------------------------------------------------------------
// buildDispatchFailureReply — honest in-thread error for a non-LLM-unavailable
// dispatch failure (г). Canonical, jargon-free, no raw error text.
// ---------------------------------------------------------------------------

/**
 * The single canonical text persisted into the thread when the assistant
 * dispatch fails with an error that is NOT an LLM-unavailability (which has its
 * own honest-503 path). Guarantees the thread never stays silent behind a bare
 * 500. The raw error is the caller's responsibility to log server-side.
 */
export const DISPATCH_FAILURE_REPLY =
  "Не получилось обработать это сообщение из-за внутренней ошибки. " +
  "Попробуйте ещё раз или переформулируйте запрос — если повторяется, " +
  "сообщите администратору вашей организации.";

/** Returns the canonical in-thread dispatch-failure reply (г). */
export function buildDispatchFailureReply(): string {
  return DISPATCH_FAILURE_REPLY;
}
