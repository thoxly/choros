/**
 * src/runtime/customer-onboarding/issue-key.ts — T-0244 B-3
 *
 * Orchestrator for the "Выпустить ключ" (Issue Key) step of the
 * customer-onboarding BPMN process.
 *
 * Flow (ADR §3.6):
 *  1. PDP resolveFor(update) — single authority, fail-closed.
 *  2. Live-gate: use deps.entitlement if liveEnabled, else dormantEntitlementPort.
 *  3. Build IssueEntitlementInput from record data.
 *  4. try issueEntitlement(input); catch (EntitlementDormantError | any) →
 *       audit_event(customer.key_issue_failed), return step-open outcome.
 *  5. Success:
 *       write circuit_id + activation_key_issued_at into record.data
 *       guarded transition → "active" via actor_event (T-0019)
 *       audit_event(customer.key_issued)
 *
 * DESIGN INVARIANTS:
 *  - Single PDP: resolveFor only (no second authority check).
 *  - Single audit-sink: deps.auditWriter only.
 *  - NO import of src/vendor/activation.ts — verified by FF-7
 *    (ci/checks/no-killswitch-in-core.sh extended glob).
 *  - NO direct SDK / fetch / http in this module.
 *  - deps.entitlement is injected: prod adapter | stub | dormant (DI pattern).
 */

import { randomUUID } from "node:crypto";

import type { PgClientLike, AuditWriter } from "../../db/audit-writer.js";
import type { AuditEventInput } from "../../core/audit-grant-encoder.js";
import type { ResolverDeps } from "../../core/grant-resolver.js";
import { resolveFor } from "../../core/grant-resolver.js";
import type { ObjectHandle, ResolveSubject } from "../../core/object-handle.js";
import type { ActorEventWriter } from "../../core/actor-event.js";
import {
  type EntitlementPort,
  type IssueEntitlementInput,
  dormantEntitlementPort,
  EntitlementDormantError,
} from "../../core/customer-subscription/entitlement-port.js";
import {
  type CustomerStatus,
  isAllowedTransition,
  isCustomerStatus,
} from "../../core/customer-subscription/status-model.js";

// ---------------------------------------------------------------------------
// IssueKeyDeps — injected dependencies (DI pattern, mirrors PrecheckDeps)
// ---------------------------------------------------------------------------

export interface IssueKeyDeps {
  /** EntitlementPort: prod adapter | stub | dormantEntitlementPort. */
  readonly entitlement: EntitlementPort;
  /** T-0021 PDP deps. */
  readonly resolverDeps: ResolverDeps;
  /** T-0016 canonical audit sink. */
  readonly auditWriter: AuditWriter;
  /** T-0019 actor-event writer for the guarded transition. */
  readonly actorEventWriter: ActorEventWriter;
  /** deploy-time flag; false ⇒ force dormantEntitlementPort (lock #2). */
  readonly liveEnabled: boolean;
}

// ---------------------------------------------------------------------------
// IssueKeyOutcome
// ---------------------------------------------------------------------------

export type IssueKeyOutcome =
  | { ok: true; circuit_id: string; issued_at: string }
  | { ok: false; reason: "pdp_denied" | "port_error" | "bad_record_data" | "bad_transition"; detail?: string };

// ---------------------------------------------------------------------------
// runIssueKey — the single step orchestrator
// ---------------------------------------------------------------------------

/**
 * Execute the "Выпустить ключ" step under an open tenant-scoped transaction.
 *
 * @param tx        - open PgClientLike already under SET LOCAL choros.tenant_id
 * @param deps      - injected ports
 * @param args      - step arguments: tenant, record handle, subject, circuit_id, clock
 */
export async function runIssueKey(
  tx: PgClientLike,
  deps: IssueKeyDeps,
  args: {
    tenantId: string;
    recordHandle: ObjectHandle;
    subject: ResolveSubject;
    circuitId: string;
    nowMs: number;
  },
): Promise<IssueKeyOutcome> {
  const { tenantId, recordHandle, subject, circuitId, nowMs } = args;

  // -------------------------------------------------------------------------
  // Step 1: PDP — single authority check (resolveFor, T-0021)
  // -------------------------------------------------------------------------
  const pdpResult = await resolveFor(
    deps.resolverDeps,
    recordHandle,
    subject,
    "update",
  );

  if (pdpResult.denied) {
    await deps.auditWriter.appendAuditEvent(tx, {
      id: randomUUID(),
      type: "card_action.denied",
      actor: subject.subjectId,
      subject: subject.subjectId,
      scope: { resource: "record:customer-subscription", op: "update" },
      via: "customer-onboarding/issue-key",
      proposed_by: null,
      confirmed_by: null,
      payload: {
        reason: pdpResult.reason,
        circuit_id: circuitId,
      },
      occurred_at: nowMs,
    });
    return { ok: false, reason: "pdp_denied", detail: pdpResult.reason };
  }

  // -------------------------------------------------------------------------
  // Step 2: Live-gate — pick port
  // -------------------------------------------------------------------------
  const port: EntitlementPort = deps.liveEnabled
    ? deps.entitlement
    : dormantEntitlementPort;

  // -------------------------------------------------------------------------
  // Step 3: Read record data — extract plan, not_after, notes
  //   (record fields come from resolveFor result.fields)
  // -------------------------------------------------------------------------
  const fields = (pdpResult as Extract<typeof pdpResult, { denied: false }>).fields;
  const plan = typeof fields["plan"] === "string" ? fields["plan"] : "";
  const not_after = typeof fields["not_after"] === "string" ? fields["not_after"] : "";
  const notes = typeof fields["notes"] === "string" ? fields["notes"] : undefined;
  const currentStatus = isCustomerStatus(fields["status"]) ? fields["status"] : null;

  if (!plan || !not_after || currentStatus === null) {
    await deps.auditWriter.appendAuditEvent(tx, {
      id: randomUUID(),
      type: "customer.key_issue_failed",
      actor: subject.subjectId,
      subject: subject.subjectId,
      scope: null,
      via: "customer-onboarding/issue-key",
      proposed_by: null,
      confirmed_by: null,
      payload: { reason: "bad_record_data", plan, not_after, current_status: currentStatus },
      occurred_at: nowMs,
    });
    return { ok: false, reason: "bad_record_data", detail: "missing plan, not_after, or status" };
  }

  // Today's date for valid_from
  const validFrom = new Date(nowMs).toISOString().slice(0, 10);

  const entitlementInput: IssueEntitlementInput = {
    circuit_id: circuitId,
    plan,
    valid_from: validFrom,
    valid_until: not_after,
    source: "pilot",
    notes,
  };

  // -------------------------------------------------------------------------
  // Step 4: Issue entitlement — catch all errors, step stays open on error
  // -------------------------------------------------------------------------
  let issuedAt: string;
  let returnedCircuitId: string;
  try {
    const license = await port.issueEntitlement(entitlementInput);
    issuedAt = license.issued_at;
    returnedCircuitId = license.circuit_id;
  } catch (err) {
    const errorMsg =
      err instanceof EntitlementDormantError
        ? "entitlement_dormant"
        : err instanceof Error
          ? err.message
          : "unknown";

    await deps.auditWriter.appendAuditEvent(tx, {
      id: randomUUID(),
      type: "customer.key_issue_failed",
      actor: subject.subjectId,
      subject: subject.subjectId,
      scope: null,
      via: "customer-onboarding/issue-key",
      proposed_by: null,
      confirmed_by: null,
      payload: { reason: errorMsg, circuit_id: circuitId },
      occurred_at: nowMs,
    });
    // Step stays open — AC-8
    return { ok: false, reason: "port_error", detail: errorMsg };
  }

  // -------------------------------------------------------------------------
  // Step 5a: Validate transition current → active
  // -------------------------------------------------------------------------
  const targetStatus: CustomerStatus = "active";
  if (!isAllowedTransition(currentStatus, targetStatus)) {
    await deps.auditWriter.appendAuditEvent(tx, {
      id: randomUUID(),
      type: "customer.key_issue_failed",
      actor: subject.subjectId,
      subject: subject.subjectId,
      scope: null,
      via: "customer-onboarding/issue-key",
      proposed_by: null,
      confirmed_by: null,
      payload: {
        reason: "transition_not_allowed",
        from: currentStatus,
        to: targetStatus,
      },
      occurred_at: nowMs,
    });
    return {
      ok: false,
      reason: "bad_transition",
      detail: `${currentStatus} → ${targetStatus} not allowed`,
    };
  }

  // -------------------------------------------------------------------------
  // Step 5b: actor_event for the guarded transition (T-0019)
  //   The record objectKind must map to "record"
  // -------------------------------------------------------------------------
  const recordRef = recordHandle.ref;
  if (recordRef.kind !== "record") {
    return { ok: false, reason: "bad_record_data", detail: "handle is not a record ref" };
  }

  await deps.actorEventWriter.appendActorEvent({
    objectKind: "record",
    recordId: recordRef.recordId,
    actor: subject.subjectId,
    onBehalfOf: null,
    roleAtEvent: "vendor-admin",
    event: "release",   // closest verb: "release" = activation/delivery in the closed verb set
    detail: {
      transition_from: currentStatus,
      transition_to: targetStatus,
    },
  });

  // -------------------------------------------------------------------------
  // Step 5c: write circuit_id + activation_key_issued_at into record.data
  // These writes are modelled as a separate DB update with system-actor field grant.
  // In the current phase (no record-write-path), we record the intent via audit only;
  // real field write happens when record-CRUD-stack lands (B-11 boundary).
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Step 5d: audit_event(customer.key_issued) — AC-11
  // -------------------------------------------------------------------------
  await deps.auditWriter.appendAuditEvent(tx, {
    id: randomUUID(),
    type: "customer.key_issued",
    actor: subject.subjectId,
    subject: subject.subjectId,
    scope: { tenant_id: tenantId },
    via: "customer-onboarding/issue-key",
    proposed_by: null,
    confirmed_by: null,
    payload: {
      circuit_id: returnedCircuitId,
      not_after,
      actor: subject.subjectId,
      tenant_id: tenantId,
    },
    occurred_at: nowMs,
  });

  return { ok: true, circuit_id: returnedCircuitId, issued_at: issuedAt };
}
