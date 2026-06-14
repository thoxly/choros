/**
 * src/core/card-action.ts — T-0200 / T-0125
 *
 * Card action = a declarative typed button on a record card. Each button is a
 * grant-gated, audited, engine-bound transition over a record or a bound process
 * instance — "show how a solution assembles from primitives": one authority
 * mechanism (PDP `resolveFor`, T-0021), one audit family (`audit_event`, T-0016),
 * one channel to the engine (engine-bridge, T-0058), one reference-consistency
 * mechanism (`checkBindingCompat`, T-0072). No second authorizer, no UI flag.
 *
 * DESIGN INVARIANTS (docs/design/T-0125-card-actions.adr.md §1/§5/§8):
 *  - FF-CA-1 — Visibility == executability == PDP. Both card-render (batch resolve)
 *    and click route through `resolveFor`; no module renders/executes on a UI flag.
 *    There is NO `actionEnabled`/`canShow`/`allowedFlag` authorizer in this module.
 *  - FF-CA-2 — `operation` is only a member of the closed `Operation` enum
 *    (grant-lattice.ts); `semantics` is only a member of the closed
 *    {transition,terminate,message,invoke} set. Card actions introduce NO new
 *    right-type and do NOT widen the Operation enum.
 *  - FF-CA-3 — terminate/message run ONLY through the engine-bridge (FlowableClient,
 *    T-0058); this module has NO own fetch/http/axios to the engine.
 *  - FF-CA-4 — action↔fields binding uses `checkBindingCompat` (T-0072), not a
 *    fourth consistency mechanism.
 *  - FF-CA-5 — a dormant-semantics action does NOT execute until its path is ready:
 *    a click on a dormant action fails closed → audit_event(denied, path_not_ready),
 *    no mutation, no engine call.
 *  - FF-CA-7 — every firing (executed AND denied) writes exactly one audit_event
 *    (T-0016 open-vocab `card_action.executed` / `card_action.denied`); a
 *    `transition` additionally appends one actor_event (T-0019).
 *  - FF-CA-8 — tenant fail-closed: a cross-tenant handle is denied by `resolveFor`
 *    BEFORE any mutation/engine call.
 *  - FF-CA-9 — the default card set is generated from the object model (T-0014) +
 *    status model (T-0019) without manual authoring.
 *
 * Pure-core: NO pg/fs/net/http(s)/fetch/child_process. All IO behind injected
 * ports (resolveFor closure, ActorEventWriter, AuditWriter, engine bridge, clock).
 * The terminate/message engine path and the custom-layer store are DORMANT behind
 * a machine-checkable readiness gate (§5) until T-0058 REST + lattice extension and
 * the form_def table land (B-8 / B-9).
 *
 * Semantic contract: docs/design/T-0125-card-actions.adr.md §2/§3/§5/§6.
 */

import { randomUUID } from "node:crypto";

import type { Operation } from "./grant-lattice.js";
import type { ObjectHandle, ResolveSubject } from "./object-handle.js";
import type {
  ResolverDeps,
  GuardContext,
} from "./grant-resolver.js";
import { resolveFor } from "./grant-resolver.js";
import type {
  ActorEventWriter,
  ActorEventVerb,
} from "./actor-event.js";
import { checkBindingCompat, type BindingField } from "./binding-compat.js";

import type { AuditWriter, PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "./audit-grant-encoder.js";

// ---------------------------------------------------------------------------
// Closed semantics axis (ADR §2.1 / §2.3 — FF-CA-2)
// ---------------------------------------------------------------------------

/**
 * Closed card-action semantics axis (ADR §2.1, axis B). Each maps to ONE existing
 * `Operation` and one execution path (§2.3). Adding a member = a design change +
 * this union + the mapping table; an unknown semantics fails closed (no string cast).
 */
export type CardActionSemantics =
  | "transition"
  | "terminate"
  | "message"
  | "invoke";

/** Total predicate over the closed semantics set (fail-closed at the boundary). */
export function isCardActionSemantics(v: unknown): v is CardActionSemantics {
  return (
    v === "transition" || v === "terminate" || v === "message" || v === "invoke"
  );
}

/**
 * Closed map semantics → PDP operation (ADR §2.3). Card actions resolve onto an
 * EXISTING `Operation`; they NEVER introduce a new right-type or widen the enum
 * (FF-CA-2 / NF-1). terminate/message resolve onto `transition` over a
 * `process_instance` ResourceType (dormant, §2.2.1) — NOT a new operation.
 */
export const SEMANTICS_TO_OPERATION: Readonly<
  Record<CardActionSemantics, Operation>
> = {
  transition: "transition",
  terminate: "transition",
  message: "transition",
  invoke: "invoke",
} as const;

/** The closed target-kind axis (ADR §2.2). */
export type CardActionTargetKind = "record" | "process_instance";

/**
 * Action target (ADR §2.2). `record` is a LIVE ResourceRef day-1; `process_instance`
 * is a DORMANT ResourceType (§2.2.1) until the lattice is extended (B-8). The handle
 * carries the (tenant-scoped) ResourceRef the PDP resolves over.
 */
export interface CardActionTarget {
  readonly kind: CardActionTargetKind;
  /** Opaque, tenant-scoped handle the PDP resolves over (record or instance). */
  readonly handle: ObjectHandle;
  /** For kind=process_instance — the engine instance id (used by the bridge). */
  readonly processInstanceId: string | null;
}

/** Readiness of the underlying execution path (ADR §2.1 / §5). */
export type CardActionReadiness = "live" | "dormant";

/** Provenance: generated from model+status (`default`) or authored (`custom`). */
export type CardActionOrigin = "default" | "custom";

// ---------------------------------------------------------------------------
// CardActionDecl — the declaration (ADR §2.1)
// ---------------------------------------------------------------------------

/**
 * A declarative typed card-action button. The declaration NEVER carries an
 * authorization flag — visibility and executability are ALWAYS decided by
 * `resolveFor`. There is intentionally no `visibilityHint` source-of-truth, no
 * `enabled`/`allowed`/`canShow` field (FF-CA-1 / FF-CA-2).
 */
export interface CardActionDecl {
  /** Stable slug, tenant-unique within a form; audit + override key. */
  readonly id: string;
  /** Human-readable label (i18n key allowed). */
  readonly label: string;
  /** The existing PDP operation this action resolves onto (closed enum). */
  readonly operation: Operation;
  /** Target semantics (closed); maps to operation + execution path (§2.3). */
  readonly semantics: CardActionSemantics;
  /** What it acts on (record or bound process instance). */
  readonly target: CardActionTarget;
  /** Binding to form fields / process variables; checked via checkBindingCompat. */
  readonly bindings: readonly BindingField[];
  /** default (generated) or custom (authored). Does NOT affect authorization. */
  readonly origin: CardActionOrigin;
  /** live for transition/invoke; dormant for un-built paths (gate §5). */
  readonly readiness: CardActionReadiness;
}

// ---------------------------------------------------------------------------
// Dormant readiness gate (ADR §5 — FF-CA-5)
// ---------------------------------------------------------------------------

/**
 * Engine-bridge readiness probe (ADR §5). terminate/message are LIVE only once
 * the FlowableClient exports deleteProcessInstance/correlateMessage AND the grant
 * lattice is extended with the `process_instance` ResourceType (B-8). Day-1 BOTH
 * are unbuilt, so this is always false — injected so B-8 flips it without touching
 * the declaration (FF-CA-5).
 */
export interface EngineBridgeReadiness {
  /** false until BOTH the REST path and the lattice extension land (B-8). */
  supports(semantics: "terminate" | "message"): boolean;
}

/** Day-1 engine-bridge readiness: terminate/message UNBUILT → always false. */
export const dormantEngineBridge: EngineBridgeReadiness = {
  supports(): boolean {
    return false;
  },
};

/**
 * The machine-checkable readiness predicate (ADR §5). transition/invoke are LIVE;
 * terminate/message defer to the engine-bridge probe (dormant until B-8).
 */
export function isReady(
  semantics: CardActionSemantics,
  bridge: EngineBridgeReadiness,
): boolean {
  switch (semantics) {
    case "transition":
    case "invoke":
      return true;
    case "terminate":
    case "message":
      return bridge.supports(semantics);
  }
}

// ---------------------------------------------------------------------------
// Execution result + audit reasons
// ---------------------------------------------------------------------------

/** Why a firing was denied (mirrors resolveFor reasons + the dormant gate). */
export type CardActionDenyReason =
  | "no_grant"
  | "cross_tenant"
  | "not_found"
  | "sod_violation"
  | "no_effect_grant"
  | "path_not_ready"
  | "unknown_semantics"
  | "binding_incompatible";

export type CardActionResult =
  | { readonly ok: true; readonly actionId: string }
  | { readonly ok: false; readonly reason: CardActionDenyReason };

/** Action-time parameters (e.g. abort reason) — written to audit + actor_event detail. */
export type CardActionParams = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Ports (IO behind injection — pure-core)
// ---------------------------------------------------------------------------

/**
 * Composition input for the card-action executor. `resolverDeps` is the SAME
 * ResolverDeps the rest of the PDP uses — there is no second authorization edge.
 */
export interface CardActionDeps {
  /** The PDP dependency bundle (grants/records/ancestry/...) — single arbiter. */
  readonly resolverDeps: ResolverDeps;
  /** T-0019 guarded-transition writer (appends one actor_event for transition). */
  readonly actorEventWriter: ActorEventWriter;
  /** T-0016 canonical audit writer (one audit_event per firing). */
  readonly auditWriter: AuditWriter;
  /** Open tx under withTenant (choros.tenant_id GUC set) for the audit writer. */
  readonly tx: PgClientLike;
  /** Engine-bridge readiness probe (dormant day-1). */
  readonly engineBridge: EngineBridgeReadiness;
  readonly clock: { now: () => number };
}

// ---------------------------------------------------------------------------
// Audit emission (T-0016 open-vocab — never a new table; FF-CA-7)
// ---------------------------------------------------------------------------

const TYPE_EXECUTED = "card_action.executed" as const;
const TYPE_DENIED = "card_action.denied" as const;

/**
 * Build the audit subject blob (ADR §2.4): record/instance ref + action id +
 * params. Identity-only ref components — never record field values.
 */
function auditSubject(decl: CardActionDecl, params: CardActionParams): string {
  return JSON.stringify({
    targetKind: decl.target.kind,
    ref: decl.target.handle.ref,
    processInstanceId: decl.target.processInstanceId,
    actionId: decl.id,
    params,
  });
}

async function emitAudit(
  deps: CardActionDeps,
  type: typeof TYPE_EXECUTED | typeof TYPE_DENIED,
  actor: string,
  decl: CardActionDecl,
  params: CardActionParams,
  result: "executed" | "denied",
  reason: CardActionDenyReason | null,
  now: number,
): Promise<void> {
  const auditInput: AuditEventInput = {
    id: randomUUID(),
    type,
    actor,
    subject: auditSubject(decl, params),
    scope: null,
    // `via` carries the attempted operation (and reason on denial) — ADR §2.4.
    via: reason === null ? decl.operation : `${decl.operation}:${reason}`,
    proposed_by: null,
    confirmed_by: null,
    payload: {
      semantics: decl.semantics,
      operation: decl.operation,
      origin: decl.origin,
      readiness: decl.readiness,
      result,
      reason,
      processInstanceId: decl.target.processInstanceId,
    },
    occurred_at: now,
  };
  await deps.auditWriter.appendAuditEvent(deps.tx, auditInput);
}

// ---------------------------------------------------------------------------
// fireCardAction — the single execution pipeline (ADR §5)
// ---------------------------------------------------------------------------

/**
 * Fire a card action (button click). The pipeline (ADR §5):
 *
 *   1. closed-enum guard (FF-CA-2): unknown semantics → denied, audit, no effect.
 *   2. dormant gate (FF-CA-5): a dormant semantics whose path is not ready →
 *      denied(path_not_ready), audit, NO mutation, NO engine call.
 *   3. PDP `resolveFor` (FF-CA-1 / FF-CA-8): the SINGLE arbiter. tenant fail-closed
 *      FIRST. denied → audit_event(denied, reason), STOP (no mutation).
 *   4. allowed → run the semantics path:
 *        transition → appendActorEvent (T-0019) [+ mutation-gateway via resolveFor]
 *        invoke     → invoke-effect verified INSIDE resolveFor (op=invoke)
 *        terminate/message → engine-bridge (dormant; never reached day-1)
 *      → audit_event(executed).
 *
 * `guardCtx` is required for the `transition` path (it carries the action-time
 * attribution the actor_event needs). For `invoke`, `invokeCtx` is threaded via
 * resolverDeps composition (the caller wires deps.effects); here we pass the
 * declares blob through when present.
 */
export async function fireCardAction(
  deps: CardActionDeps,
  decl: CardActionDecl,
  subject: ResolveSubject,
  params: CardActionParams,
  guardCtx?: GuardContext,
  invokeDeclares?: unknown,
): Promise<CardActionResult> {
  const now = deps.clock.now();

  // 1. Closed-enum guard — fail-closed on a widened/unknown semantics.
  if (!isCardActionSemantics(decl.semantics)) {
    await emitAudit(
      deps,
      TYPE_DENIED,
      subject.subjectId,
      decl,
      params,
      "denied",
      "unknown_semantics",
      now,
    );
    return { ok: false, reason: "unknown_semantics" };
  }

  // 2. Dormant gate — a dormant path does NOT execute until declared ready.
  if (!isReady(decl.semantics, deps.engineBridge)) {
    await emitAudit(
      deps,
      TYPE_DENIED,
      subject.subjectId,
      decl,
      params,
      "denied",
      "path_not_ready",
      now,
    );
    return { ok: false, reason: "path_not_ready" };
  }

  // 3. PDP — the SINGLE arbiter. tenant-gate is fail-closed FIRST inside resolveFor.
  const op = SEMANTICS_TO_OPERATION[decl.semantics];
  const view = await resolveFor(
    deps.resolverDeps,
    decl.target.handle,
    subject,
    op,
    invokeDeclares !== undefined ? { declares: invokeDeclares } : undefined,
    guardCtx,
  );
  if (view.denied) {
    const reason = view.reason as CardActionDenyReason;
    await emitAudit(
      deps,
      TYPE_DENIED,
      subject.subjectId,
      decl,
      params,
      "denied",
      reason,
      now,
    );
    return { ok: false, reason };
  }

  // 4. allowed — run the semantics-specific path.
  switch (decl.semantics) {
    case "transition": {
      // T-0019 guarded transition: append exactly ONE actor_event. The action-time
      // attribution (actor/role/verb) comes from guardCtx; absent ⇒ fail-closed
      // (an unattributable transition cannot be recorded).
      if (guardCtx === undefined) {
        await emitAudit(
          deps,
          TYPE_DENIED,
          subject.subjectId,
          decl,
          params,
          "denied",
          "sod_violation",
          now,
        );
        return { ok: false, reason: "sod_violation" };
      }
      await deps.actorEventWriter.appendActorEvent({
        ...refToActorEventRef(decl.target.handle.ref),
        actor: guardCtx.actor,
        onBehalfOf: guardCtx.onBehalfOf ?? null,
        roleAtEvent: guardCtx.roleAtEvent,
        event: guardCtx.verb as ActorEventVerb,
        ...(guardCtx.approveLevel !== undefined
          ? { approveLevel: guardCtx.approveLevel }
          : {}),
        detail: { actionId: decl.id, params },
      });
      break;
    }
    case "invoke": {
      // invoke-effect verification happens INSIDE resolveFor (op=invoke, step 3.5)
      // when deps.effects is wired. Nothing more to append here — the effect call
      // itself is the invoke-path's responsibility (T-0024/T-0034), out of this
      // declarative primitive's scope.
      break;
    }
    case "terminate":
    case "message": {
      // Unreachable day-1: the dormant gate (step 2) denies these before here.
      // When B-8 lands, the engine-bridge call goes here (deleteProcessInstance /
      // correlateMessage) — ONLY via the injected FlowableClient (FF-CA-3).
      break;
    }
  }

  await emitAudit(
    deps,
    TYPE_EXECUTED,
    subject.subjectId,
    decl,
    params,
    "executed",
    null,
    now,
  );
  return { ok: true, actionId: decl.id };
}

/** Map an identity-only ResourceRef to the actor_event object ref (pure, 1:1). */
function refToActorEventRef(
  ref: ObjectHandle["ref"],
):
  | { objectKind: "application"; applicationId: string }
  | { objectKind: "registry"; registryId: string }
  | { objectKind: "record"; recordId: string } {
  switch (ref.kind) {
    case "application":
      return { objectKind: "application", applicationId: ref.applicationId };
    case "registry":
      return { objectKind: "registry", registryId: ref.registryId };
    case "record":
      return { objectKind: "record", recordId: ref.recordId };
  }
}

// ---------------------------------------------------------------------------
// Batch visibility on render (ADR §5 — FF-CA-1)
// ---------------------------------------------------------------------------

/**
 * The per-action render verdict. `executable` is decided ONLY by `resolveFor`
 * (PDP), never a UI flag; a dormant action is structurally non-executable until
 * its path is ready.
 */
export interface CardActionVisibility {
  readonly actionId: string;
  readonly executable: boolean;
  readonly readiness: CardActionReadiness;
  readonly reason: CardActionDenyReason | null;
}

/**
 * Compute the executable subset for a card render (ADR §5 batch-PDP). For each
 * candidate action, executability == `resolveFor` ≠ denied AND the path is ready.
 * Visibility is derived from the PDP — there is NO actionEnabled/canShow flag.
 *
 * Amortization (ADR §5 [iter-2, R-2]): the resolver fetches the record per call;
 * callers SHOULD pass one handle per target so the K grant-resolves share the
 * single already-loaded target. We expose the per-action resolve; N+1 avoidance
 * across a LIST of cards is the caller's loop, not a second authorization edge.
 */
export async function resolveCardVisibility(
  deps: CardActionDeps,
  candidates: readonly CardActionDecl[],
  subject: ResolveSubject,
  guardCtx?: GuardContext,
): Promise<CardActionVisibility[]> {
  const out: CardActionVisibility[] = [];
  for (const decl of candidates) {
    if (!isReady(decl.semantics, deps.engineBridge)) {
      out.push({
        actionId: decl.id,
        executable: false,
        readiness: decl.readiness,
        reason: "path_not_ready",
      });
      continue;
    }
    const op = SEMANTICS_TO_OPERATION[decl.semantics];
    const view = await resolveFor(
      deps.resolverDeps,
      decl.target.handle,
      subject,
      op,
      undefined,
      guardCtx,
    );
    out.push({
      actionId: decl.id,
      executable: !view.denied,
      readiness: decl.readiness,
      reason: view.denied ? (view.reason as CardActionDenyReason) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default-card generation (ADR §3 — FF-CA-9)
// ---------------------------------------------------------------------------

/**
 * A guarded transition available from the current status (sourced from the T-0019
 * status model). The generator projects one `transition` card-action per available
 * transition. Pure input — no custom schema is read for the default set (FF-CA-9).
 */
export interface AvailableTransition {
  /** Stable slug for the transition (becomes the action id). */
  readonly id: string;
  readonly label: string;
  /** Optional field/variable bindings carried by this transition. */
  readonly bindings?: readonly BindingField[];
}

/**
 * Generate the default `CardActionDecl[]` for a record card from the object model
 * (T-0014) + status model (T-0019), WITHOUT reading any custom schema (FF-CA-9):
 *
 *  - one `transition` action per available-from-current-status guarded transition
 *    (readiness=live);
 *  - one `terminate` action on the bound process instance when present
 *    (readiness=dormant — declaration shown, gated by §5);
 *  - `invoke` actions are NOT in the default set (custom only, ADR §3).
 *
 * Visibility of each generated action is STILL decided by `resolveFor` at render
 * time (this only enumerates "what is defined", not "what is permitted").
 */
export function defaultCardActions(
  recordHandle: ObjectHandle,
  availableTransitions: readonly AvailableTransition[],
  boundInstance: { processInstanceId: string; handle: ObjectHandle } | null,
): CardActionDecl[] {
  const out: CardActionDecl[] = [];

  for (const t of availableTransitions) {
    out.push({
      id: t.id,
      label: t.label,
      operation: SEMANTICS_TO_OPERATION.transition,
      semantics: "transition",
      target: {
        kind: "record",
        handle: recordHandle,
        processInstanceId: null,
      },
      bindings: t.bindings ?? [],
      origin: "default",
      readiness: "live",
    });
  }

  if (boundInstance !== null) {
    out.push({
      id: "abort_process",
      label: "Прервать процесс",
      operation: SEMANTICS_TO_OPERATION.terminate,
      semantics: "terminate",
      target: {
        kind: "process_instance",
        handle: boundInstance.handle,
        processInstanceId: boundInstance.processInstanceId,
      },
      bindings: [],
      origin: "default",
      readiness: "dormant",
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Custom layer overlay (ADR §4 — structural authorization prohibition)
// ---------------------------------------------------------------------------

/**
 * Merge custom actions over defaults by `id` (ADR §4.1): a custom action ADDS a
 * new action or OVERRIDES an existing one (label/bindings/target). A custom action
 * can NEVER set an operation/semantics outside the closed enums and has NO
 * authorization flag — `resolveFor` stays the sole arbiter (FF-CA-1 / NF-1).
 *
 * Custom storage/versioning is a DORMANT layer behind the form_def gate (B-9);
 * this overlay is the pure merge contract used once that store lands.
 */
export function mergeCardActions(
  defaults: readonly CardActionDecl[],
  customs: readonly CardActionDecl[],
): CardActionDecl[] {
  const byId = new Map<string, CardActionDecl>();
  for (const d of defaults) byId.set(d.id, d);
  for (const c of customs) {
    // Fail-closed on a widened semantics/operation from an untrusted custom blob.
    if (!isCardActionSemantics(c.semantics)) continue;
    if (c.operation !== SEMANTICS_TO_OPERATION[c.semantics]) continue;
    byId.set(c.id, c);
  }
  return [...byId.values()];
}

/**
 * Validate a card action's bindings against the process variable names via the
 * SAME `checkBindingCompat` used by named-binding / report-page-dep (T-0072) — not
 * a fourth consistency mechanism (FF-CA-4). Returns the compat result verbatim.
 */
export function checkCardActionBindings(
  decl: CardActionDecl,
  bpmnVarNames: ReadonlySet<string>,
) {
  return checkBindingCompat([...decl.bindings], bpmnVarNames);
}
