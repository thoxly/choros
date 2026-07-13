/**
 * src/composition/customer-onboarding-effects.ts — T-0249 (B-11)
 *
 * The CASE-QUARANTINE binding: it declares that, for the `customer-onboarding`
 * process, completing the "Выпустить активационный ключ" step runs the issue-key
 * effect (applyIssueKeyStep → runIssueKey + record write-back). This is the one
 * place a customer/onboarding literal is bound to a generic seam — the composition
 * root, D-064's sanctioned case-quarantine boundary (alongside issue-key-live.ts).
 *
 * The GENERIC dispatcher (src/core/completion-effect.ts) and the completion seam
 * (src/http/inbox.ts) carry NO case literal — they key off opaque (procKey,
 * activity) strings. This module supplies the concrete strings + the wired effect.
 * ci/checks/customer-crm-anti-case.sh enforces the generic/quarantine split.
 *
 * DEPENDENCY INJECTION: the PDP resolver, audit + actor-event writers, entitlement
 * port and live flag are INJECTED by the server root (which already owns those
 * builders for records.ts / inbox.ts). This module never reads env, opens a pool,
 * or constructs a private-key adapter — it only composes the injected pieces into
 * the IssueKeyDeps the effect needs, per invocation (resolver + actor-event writer
 * are tenant/actor-scoped, so they are built lazily from ctx).
 *
 * ALWAYS REGISTERED, FAIL-VISIBLE (T-0249 review CE-1/CE-2): the bindings are
 * registered UNCONDITIONALLY in the composition root (completion-effects-root.ts →
 * server.ts) — no env gate on the wire itself, because the seam is a strict no-op
 * for every other (process, step). What the CUSTOMER_ONBOARDING_LIVE env gate
 * controls is the ENTITLEMENT PORT (live vs dormant, T-0246 §1.V-1): with the
 * dormant port, completing the issue-key step FAILS VISIBLY (422
 * STEP_EFFECT_FAILED, approve tx rolled back, step stays open) — never a silent
 * «done» without a key (T-0571 AC-7 fail-visible doctrine).
 */

import type { PgClientLike, AuditWriter } from "../db/audit-writer.js";
import type { ResolverDeps } from "../core/grant-resolver.js";
import type { ActorEventWriter } from "../core/actor-event.js";
import type { EntitlementPort } from "../runtime/customer-onboarding/entitlement-port.js";
import type { CompletionEffectBinding } from "../core/completion-effect.js";
import { applyIssueKeyStep } from "../runtime/customer-onboarding/issue-key-effect.js";
import type { IssueKeyDeps } from "../runtime/customer-onboarding/issue-key.js";
// HttpError: sanctioned cross-layer import — router.ts has zero internal deps
// (the same precedent src/db/step-applier.ts cites for StepTargetUnresolvedError).
import { HttpError } from "../http/router.js";

/**
 * T-0249 review CE-2 (fail-VISIBLE, T-0571 AC-7 doctrine): the typed error code
 * the /action route surfaces when the issue-key effect FAILS (pdp_denied /
 * port_error incl. dormant / bad_record_data / bad_transition). The throw
 * propagates out of runCompletionEffect → the approve tx ROLLBACKs (task.approved
 * undone, the step stays OPEN, the record untouched — nothing half-done) and the
 * route returns 422 with this code — never a silent «done»+200 without a key.
 */
export const STEP_EFFECT_FAILED = "STEP_EFFECT_FAILED";

/**
 * The customer-onboarding process key (matches seed/vendor-crm/processes/
 * customer-onboarding.bpmn `<process id="customer-onboarding">` and the
 * process_app_binding.process_key seeded by migration 134). A case literal, by
 * design confined to this quarantine module + the seed.
 */
export const CUSTOMER_ONBOARDING_PROC_KEY = "customer-onboarding";

/**
 * The issue-key step discriminators. The inbox completion seam matches the
 * completed step by EITHER its BPMN taskDefinitionKey OR its name (whichever the
 * engine surfaces — taskDefinitionKey is null for base process.started rows, so
 * the name is the reliable fallback). Both map to the same effect; registering
 * both makes the match robust to which signal the engine yields.
 */
export const ISSUE_KEY_TASK_DEF_KEY = "task-issue-key";
export const ISSUE_KEY_TASK_NAME = "Выпустить активационный ключ";

// ---------------------------------------------------------------------------
// Injected deps
// ---------------------------------------------------------------------------

export interface CustomerOnboardingEffectDeps {
  /** The entitlement port (live T0242EntitlementPort or dormant stub). */
  readonly entitlement: EntitlementPort;
  /** deploy-time live flag (makeEntitlementWiring().liveEnabled). */
  readonly liveEnabled: boolean;
  /** Canonical audit sink (makePgAuditWriter()). */
  readonly auditWriter: AuditWriter;
  /**
   * Per-invocation PDP resolver builder. The server root supplies the SAME
   * grant/record/ancestry wiring records.ts / inbox.ts already use (single
   * resolver, T-0331). Built from ctx (tenant + actor) at completion time —
   * async because the org-ancestry oracle is loaded from the DB per tenant
   * (mirrors server.ts's resolveReadVisibility composition).
   */
  readonly resolverDepsFor: (tenantId: string, actor: string) => Promise<ResolverDeps>;
  /** Per-tenant actor-event writer builder (T-0019 guarded transition sink). */
  readonly actorEventWriterFor: (tenantId: string) => ActorEventWriter;
}

// ---------------------------------------------------------------------------
// Bindings factory
// ---------------------------------------------------------------------------

/**
 * Build the completion-effect bindings for the customer-onboarding process. Feed
 * the result into makeCompletionEffectRegistry (src/core/completion-effect.ts)
 * and pass that registry to registerInboxRoutes.
 */
export function makeCustomerOnboardingEffectBindings(
  deps: CustomerOnboardingEffectDeps,
): CompletionEffectBinding[] {
  const handler: CompletionEffectBinding["handler"] = async (client, ctx) => {
    const issueKeyDeps: IssueKeyDeps = {
      entitlement: deps.entitlement,
      resolverDeps: await deps.resolverDepsFor(ctx.tenantId, ctx.actor),
      auditWriter: deps.auditWriter,
      actorEventWriter: deps.actorEventWriterFor(ctx.tenantId),
      liveEnabled: deps.liveEnabled,
    };
    const outcome = await applyIssueKeyStep(client as PgClientLike, issueKeyDeps, {
      tenantId: ctx.tenantId,
      registryId: ctx.registryId,
      recordId: ctx.recordId,
      actor: ctx.actor,
      nowMs: ctx.nowMs,
    });

    // CE-2 (fail-VISIBLE, T-0571 AC-7): a non-ok outcome must NEVER surface as a
    // silent «done»+200 without a key. Throw a typed 422 → runCompletionEffect
    // propagates → the approve tx ROLLBACKs (task.approved undone, record
    // untouched, step stays OPEN for an honest retry) and the /action route
    // returns the visible, typed error envelope.
    if (!outcome.ok) {
      throw new HttpError(
        422,
        STEP_EFFECT_FAILED,
        `Выпуск активационного ключа не выполнен (${outcome.reason}` +
          `${outcome.detail ? `: ${outcome.detail}` : ""}) — шаг остаётся открытым, решение не записано`,
      );
    }
  };

  return [
    { procKey: CUSTOMER_ONBOARDING_PROC_KEY, activity: ISSUE_KEY_TASK_DEF_KEY, handler },
    { procKey: CUSTOMER_ONBOARDING_PROC_KEY, activity: ISSUE_KEY_TASK_NAME, handler },
  ];
}
