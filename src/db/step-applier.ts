/**
 * src/db/step-applier.ts — T-0335 [E15-S1b]
 *
 * The load-bearing "step → entity" applier seam (machinery plan §3 S1).
 *
 * When a process step completes (today: the inbox approve card-action), this
 * module turns that completion into a DURABLE ENTITY effect inside the CALLER's
 * already-open tenant-scoped transaction — exactly like appendProcessStarted /
 * enqueueInTx run on the caller's open client, never opening their own pool
 * connection. The atomic unit (one tenant tx) is:
 *
 *     record-write (A)  ⊕  audit(record.create)  ⊕  outbox(step_applied)
 *
 * so the approve audit event (task.approved, appended by the caller BEFORE this)
 * and the «Согласование» record commit together — a caller ROLLBACK undoes
 * everything (zero records AND zero approve events).
 *
 * BRANCHING (F1, step-class):
 *   A (default) — append a NEW record into the «Согласование» (approvals) registry
 *                 under the instance's application. This is the DEFAULT: a missing
 *                 or ambiguous step-class marker resolves to A.
 *   B (opt-in)  — inline-update the primary 1:1 record. DEFERRED in T-0335: the
 *                 resolver returns a registryId, not the 1:1 record_id, so B has no
 *                 addressing yet (tracked as T-0344). stepClass==='B' → skip+log.
 *
 * REGISTRY RESOLUTION:
 *   resolveInstanceTargetOnClient → the PRIMARY («Заявки») registry of the
 *   application. For A we resolve the «Согласование» registry SEPARATELY under the
 *   SAME applicationId (by approvals slug, NOT target.registryId). cross_app_ref
 *   (migration 068) tells us which ref_field on the «Согласование» record holds the
 *   primary record's UUID — we set the primary record UUID under that key.
 *
 * FAIL-CLOSED (closes FF-G3):
 *   - unresolved + the step REQUIRES a target (marker present / binding expects a
 *     record) → THROW → the caller's withTenantTx ROLLBACK (approve returns non-2xx,
 *     nothing committed). The old "always success" no-op is gone.
 *   - unresolved + NO app binding (no record expected) → skip+log, COMMIT the
 *     approval (a sanctioned no-op).
 *   - any DB error in the applier → propagate → rollback (no half-applied step).
 *
 * The applier writes the record as the SYSTEM actor (records.ts ~402 system path):
 * intentional + audited — a step-result write is system-originated, not a direct
 * user record-create.
 *
 * IDEMPOTENCY: the outbox idempotency_key UNIQUE (ON CONFLICT DO NOTHING). A
 * replay of the same (instanceId, taskId) enqueues no second step_applied row.
 * markDispatched is the out-of-band dispatcher's job — NOT in this tx (two-phase
 * outbox). The record INSERT carries a server-minted id; an at-most-once approve
 * is already enforced upstream (a done instance drops its waiting task), so the
 * outbox UNIQUE is the durable replay guard.
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import { makePgAuditWriter, type PgClientLike } from "./audit-writer.js";
import {
  resolveInstanceTargetOnClient,
  type InstanceTargetResult,
} from "./process-instance-resolver.js";
import { getCrossAppRef } from "./cross-app-ref-dao.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The slug of the «Согласование» (approvals) registry seeded under an application
 * that hosts an approval process. The applier resolves the approvals registry by
 * THIS slug under the instance's applicationId — NOT by the resolver's primary
 * target.registryId (which is the «Заявки» registry). Seeded by migration
 * 076_soglasovanie_registry_seed.sql (a DATA row, NOT a new table).
 */
export const SOGLASOVANIE_SLUG = "soglasovanie" as const;

/** The outbox event type emitted for an applied step. */
export const STEP_APPLIED_EVENT = "step_applied" as const;

/**
 * The actor recorded for a system-originated step-result write (records.ts ~402
 * system path). A step applier writes on behalf of the process machinery, not a
 * direct user record-create — the human approver is captured separately as the
 * approve audit event's actor.
 */
export const SYSTEM_ACTOR = "system" as const;

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Step class signalled by form_binding (F1). Default-to-A when absent/ambiguous. */
export type StepClass = "A" | "B" | null | undefined;

/**
 * Optional injected ports. Today only the outbox store is required; refDeps is
 * reserved for future seams and is unused by the current applier body (kept on the
 * signature so the seam shape is stable for S2/S3 callers).
 */
export interface StepApplierRefDeps {
  /** Reserved — no read-side hop traversal is wired in T-0335 (follow-up). */
  readonly _reserved?: never;
}

/** Minimal outbox port the applier needs (enqueueInTx on the caller's client). */
export interface OutboxEnqueuePort {
  enqueueInTx(
    client: pg.PoolClient,
    row: {
      aggregateKind: string;
      aggregateId: string;
      eventType: string;
      payload: Record<string, unknown>;
      idempotencyKey: string;
    },
  ): Promise<unknown>;
}

export interface ApplyStepResultArgs {
  /** Tenant UUID (must already match the open tx GUC). */
  readonly tenantId: string;
  /** Flowable instance id (== process.started payload->>'inst'). */
  readonly instanceId: string;
  /** Process-definition key (e.g. "telLinear"). */
  readonly procKey: string;
  /** The step / activity that completed (audit event type or BPMN node). */
  readonly activity: string;
  /** The actor that completed the step (the human approver). */
  readonly actor: string;
  /**
   * The completed task id — the dedup subject for the outbox idempotency key.
   * (== the approved inbox task id; one approve per task is enforced upstream.)
   */
  readonly taskId: string;
  /** F1 step-class marker from form_binding. Default-to-A when null/undefined. */
  readonly stepClass: StepClass;
  /** The step's form data (the body of the new «Согласование» record). */
  readonly formData: Record<string, unknown>;
  /** Wall-clock task duration in ms (F2; threaded into the outbox payload). */
  readonly durationMs: number | null;
  /** Server clock for the write (epoch ms). */
  readonly nowMs: number;
  /** Outbox store (enqueueInTx on the caller's tx). */
  readonly outboxStore: OutboxEnqueuePort;
  /** Reserved injected ports (unused in T-0335). */
  readonly refDeps?: StepApplierRefDeps;
}

/** A — a new «Согласование» record was appended. */
export interface AppliedA {
  readonly kind: "applied-A";
  readonly recordId: string;
}

/** Skipped — no entity effect (B deferred, or unresolved + no app binding). */
export interface Skipped {
  readonly kind: "skipped";
  readonly reason: string;
}

export type ApplyStepResult = AppliedA | Skipped;

// ---------------------------------------------------------------------------
// UUID guard
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// «Согласование» registry resolution (the approvals registry under the app)
// ---------------------------------------------------------------------------

interface ApprovalsRegistryRow {
  id: string;
  application_id: string;
}

/**
 * Resolve the «Согласование» (approvals) registry for an application by its
 * well-known slug. Runs on the caller's open tenant-tx client (RLS-scoped). The
 * BYPASSRLS double-predicate (explicit WHERE tenant_id = $1) mirrors the resolver.
 * Returns null when the application has no approvals registry seeded.
 */
async function resolveApprovalsRegistry(
  client: pg.PoolClient,
  tenantId: string,
  applicationId: string,
): Promise<ApprovalsRegistryRow | null> {
  const res = await client.query<ApprovalsRegistryRow>(
    `SELECT id, application_id
       FROM choros.registry_def
      WHERE tenant_id = $1
        AND application_id = $2
        AND slug = $3
      LIMIT 1`,
    [tenantId, applicationId, SOGLASOVANIE_SLUG],
  );
  const row = res.rows[0];
  if (!row || !isUuid(row.id)) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Step-class marker resolution (F1) — read from form_binding.fields
// ---------------------------------------------------------------------------

/** The designated form_binding.fields array member key that carries the step class. */
export const STEP_CLASS_MARKER_KEY = "__step_class" as const;

interface FormBindingFieldsRow {
  fields: unknown;
}

/**
 * Resolve the F1 step-class marker for a process from form_binding.fields.
 *
 * DEFAULT-TO-A discipline (ADR F1): the marker is a designated array member
 * `{ key: '__step_class', type: 'B' }` (stored as an ARRAY member so the 045
 * `form_binding_fields_is_array` CHECK holds — NEVER a sibling object). B is
 * returned ONLY when such a member is present with type === 'B'. A MISSING binding,
 * a binding without the marker, or any ambiguous value → 'A' (append to «Согласование»).
 *
 * Runs on the caller's open tenant-tx client (RLS-scoped). NEVER throws on "no
 * binding"; returns 'A' (the safe default) so the applier appends rather than
 * silently updating.
 */
export async function readStepClass(
  client: pg.PoolClient,
  tenantId: string,
  procKey: string,
): Promise<"A" | "B"> {
  if (!isUuid(tenantId)) return "A";
  const res = await client.query<FormBindingFieldsRow>(
    `SELECT fields
       FROM choros.form_binding
      WHERE tenant_id = $1
        AND process_key = $2
      ORDER BY version DESC
      LIMIT 1`,
    [tenantId, procKey],
  );
  const row = res.rows[0];
  if (!row || !Array.isArray(row.fields)) return "A";
  for (const member of row.fields as Array<Record<string, unknown>>) {
    if (
      member &&
      typeof member === "object" &&
      member["key"] === STEP_CLASS_MARKER_KEY &&
      member["type"] === "B"
    ) {
      return "B";
    }
  }
  return "A";
}

// ---------------------------------------------------------------------------
// applyStepResult — the keystone
// ---------------------------------------------------------------------------

/**
 * Apply a completed step's result as a durable entity effect inside the caller's
 * open tenant-scoped tx. See the module header for the atomic unit + fail-closed
 * contract. Returns an `applied-A` (recordId) or a `skipped` (reason) outcome;
 * throws to force a ROLLBACK on the fail-closed paths.
 */
export async function applyStepResult(
  client: pg.PoolClient,
  args: ApplyStepResultArgs,
): Promise<ApplyStepResult> {
  const {
    tenantId,
    instanceId,
    procKey,
    activity,
    taskId,
    stepClass,
    formData,
    durationMs,
    nowMs,
    outboxStore,
  } = args;

  // --- B-branch: DEFERRED (T-0344). B needs the 1:1 record_id, which the resolver
  // does not yield (it returns a registryId). Skip+log; never attempt an update.
  if (stepClass === "B") {
    return {
      kind: "skipped",
      reason: "B-inline-update deferred: needs record_id addressing (T-0344)",
    };
  }

  // --- Resolve the instance's PRIMARY target (application + «Заявки» registry).
  // Shares the caller's approve tx (read + write atomic).
  const target: InstanceTargetResult = await resolveInstanceTargetOnClient(
    client,
    tenantId,
    instanceId,
  );

  // FAIL-CLOSED (FF-G3): a present step-class marker means the step REQUIRES a
  // target. An explicit marker is present iff stepClass is the literal 'A' (the
  // only non-null/non-undefined value that reaches here — 'B' returned above).
  const markerPresent = stepClass === "A";

  if (target.kind === "unresolved") {
    // No app binding at all → no record was ever expected for this process. This is
    // the sanctioned no-op: skip + COMMIT the approval (the engine→screen approve
    // already happened; there is simply no entity to write).
    if (target.reason === "no_app_binding") {
      return {
        kind: "skipped",
        reason: `no app binding for process ${procKey} — approval committed, no entity written`,
      };
    }
    // Any other unresolved reason WHEN a target is required (marker present, or a
    // binding exists but its registry/event is missing) → FAIL CLOSED: throw so the
    // caller's withTenantTx ROLLBACK undoes the approve event too. Never a silent
    // success on a step that should have produced an entity.
    if (markerPresent || target.reason === "no_registry") {
      throw new Error(
        `applyStepResult: step requires a target but instance ${instanceId} is unresolved ` +
          `(${target.reason}: ${target.detail}) — failing closed (FF-G3)`,
      );
    }
    // Defensive: unresolved for an input/validation reason without a required marker.
    // Treat as a no-op skip (no entity expected) rather than corrupting the approve.
    return {
      kind: "skipped",
      reason: `unresolved (${target.reason}) and no target required — approval committed`,
    };
  }

  // --- A-branch: append a NEW record into the «Согласование» registry.
  const approvals = await resolveApprovalsRegistry(
    client,
    tenantId,
    target.applicationId,
  );
  if (approvals === null) {
    // The application is bound but has no «Согласование» registry seeded. A step
    // that resolved an application IS expected to write an approval record — fail
    // closed so a misconfigured app does not silently swallow the step result.
    throw new Error(
      `applyStepResult: application ${target.applicationId} has no «Согласование» ` +
        `(slug='${SOGLASOVANIE_SLUG}') registry — failing closed (FF-G3)`,
    );
  }

  const recordId = randomUUID();

  // cross_app_ref write-side: if a definition links the «Согласование» (source)
  // registry to the primary «Заявки» (target) registry, set the primary record's
  // UUID under the resolved ref_field key. The primary record id is the instance's
  // own primary record — addressed here by the resolver's registry; the concrete
  // primary record UUID is carried via the cross-ref pointer value. We write the
  // INSTANCE id as the pointer when no concrete primary record is resolvable, since
  // the «Заявки» record id is not addressable in T-0335 (same 1:1 gap as B / T-0344);
  // the ref_field is still populated so the link exists once the primary is wired.
  const recordData: Record<string, unknown> = { ...formData };
  const crossRef = await getCrossAppRef(
    client,
    tenantId,
    approvals.id,
    target.registryId,
  );
  if (crossRef !== null) {
    // The pointer value is the PRIMARY record's UUID. The primary «Заявки» record's
    // concrete id is not resolvable in T-0335 (1:1 addressing gap, T-0344); we carry
    // the instance id as the addressable correlation key so the link is non-empty and
    // upgradable to the real record id when 1:1 addressing lands. (Set under the
    // designated ref_field key so resolveHop can traverse it later.)
    recordData[crossRef.refField] = instanceId;
  }

  // INSERT the «Согласование» record (tenant-scoped under the caller's RLS tx),
  // mirroring createRecord at records.ts ~519. System actor (records.ts ~402).
  await client.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6)`,
    [tenantId, recordId, approvals.id, JSON.stringify(recordData), nowMs, SYSTEM_ACTOR],
  );

  // Append ONE audit event (record.create) in the SAME tx (mirror records.ts ~527).
  const writer = makePgAuditWriter();
  await writer.appendAuditEvent(client as unknown as PgClientLike, {
    id: randomUUID(),
    type: "record.create",
    actor: SYSTEM_ACTOR,
    subject: recordId,
    scope: {
      registry_def_id: approvals.id,
      application_id: approvals.application_id,
      via: "step-applier",
    },
    via: "step-applier",
    proposed_by: null,
    confirmed_by: SYSTEM_ACTOR,
    payload: {
      record_id: recordId,
      registry_def_id: approvals.id,
      application_id: approvals.application_id,
      instance_id: instanceId,
      process_key: procKey,
      activity,
    },
    occurred_at: nowMs,
  });

  // Enqueue the step_applied outbox row in the SAME tx. Idempotency key is the
  // UNIQUE replay guard (ON CONFLICT DO NOTHING in pgOutboxStore). markDispatched
  // is the dispatcher's job — NOT here (two-phase outbox).
  await outboxStore.enqueueInTx(client, {
    aggregateKind: "record",
    aggregateId: recordId,
    eventType: STEP_APPLIED_EVENT,
    payload: {
      instanceId,
      processKey: procKey,
      activity,
      duration_ms: durationMs,
      variables: formData,
    },
    idempotencyKey: `step_applied:${instanceId}:${taskId}`,
  });

  return { kind: "applied-A", recordId };
}
