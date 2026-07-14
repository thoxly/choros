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
import type { BindingField } from "../core/binding-compat.js";
import {
  validateFormSubmit,
  type FormSubmitValidationResult,
} from "../core/form-submit-validator.js";
// T-0575 [W1/деТЭЛ] BUG-017 (AC-7): the fail-honest typed error for an
// unresolved step-result target — HttpError is already imported from
// src/http/router.js by src/db/org.ts (sanctioned precedent; router.ts has zero
// internal deps, so this is not a layering violation).
import { HttpError } from "../http/router.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The slug of the «Согласование» (approvals) registry seeded under an application
 * that hosts an approval process. Retained as the NAMED DEFAULT VALUE that
 * resolveDefaultStepResultSlug() falls back to — no longer the unconditional
 * code-path (T-0575 [W1/деТЭЛ] BUG-017; ADR-T0575 §2.3). Seeded by migration
 * 076_soglasovanie_registry_seed.sql (a DATA row, NOT a new table).
 */
export const SOGLASOVANIE_SLUG = "soglasovanie" as const;

/**
 * T-0575 config-primitive (BUG-017): the fallback step-result registry slug used
 * ONLY when a process_app_binding row has NO explicit `target_registry_slug`
 * (migration 119, NULL = "use the default"). Env
 * `CHOROS_DEFAULT_STEP_RESULT_SLUG`, defaulting to "soglasovanie" for backward
 * compatibility with the ТЭЛ seed (076/085). Not read in src/core/ (no-env-in-
 * core.sh boundary) — this module is src/db/.
 */
export function resolveDefaultStepResultSlug(): string {
  const v = process.env["CHOROS_DEFAULT_STEP_RESULT_SLUG"];
  return v !== undefined && v.trim() !== "" ? v : SOGLASOVANIE_SLUG;
}

/**
 * T-0575 [W1/деТЭЛ] BUG-017 (AC-7): typed, structured error for the fail-honest
 * "step requires a target-result registry but none is configured" case. Replaces
 * the old bare `throw new Error(...)` (a plain Error that the router mapped to
 * a bare 500 INTERNAL with no diagnostic code — the BUG-017 symptom). The
 * approve handler (inbox.ts) lets this propagate to the router's HttpError
 * branch, which maps it to the codebase-wide `{error:{code,message}}` envelope
 * at the STATUS this class carries (422 — configuration incomplete, not a
 * transient 5xx). The tx ROLLBACK / fail-closed SEMANTICS are UNCHANGED — only
 * the error's observability improves (structured code + logged context).
 */
export class StepTargetUnresolvedError extends HttpError {
  constructor(detail: {
    readonly tenantId: string;
    readonly processKey: string;
    readonly applicationId: string;
    readonly expectedSlug: string;
  }) {
    super(
      422,
      "STEP_TARGET_UNRESOLVED",
      `no step-result target registry is configured for process ${JSON.stringify(detail.processKey)} ` +
        `under application ${detail.applicationId} (expected registry slug ${JSON.stringify(detail.expectedSlug)}) — ` +
        `configure choros.process_app_binding.target_registry_slug for this (process, application) pair`,
    );
    this.name = "StepTargetUnresolvedError";
    // Non-fatal, structured console log with diagnostic context (BUG-017: "not a
    // silent 500" — the operator sees tenantId/processKey/applicationId/expectedSlug).
    console.warn(
      `[step-applier T-0575 STEP_TARGET_UNRESOLVED] tenantId=${detail.tenantId} ` +
        `processKey=${detail.processKey} applicationId=${detail.applicationId} ` +
        `expectedSlug=${detail.expectedSlug} — no «Согласование»-equivalent registry ` +
        `resolved; failing closed (FF-G3), approve tx will ROLLBACK`,
    );
  }
}

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
 * Resolve the step-result target registry for an application by a SLUG that the
 * caller has ALREADY resolved (T-0575 BUG-017: from process_app_binding.
 * target_registry_slug, falling back to resolveDefaultStepResultSlug() when the
 * binding carries no explicit override — see applyStepResult below). This
 * function itself does NOT default the slug; it is a pure by-slug lookup so it
 * can resolve ANY configured registry, not only the ТЭЛ-named "soglasovanie"
 * one (ADR §2.3, AC-6). Runs on the caller's open tenant-tx client (RLS-scoped).
 * The BYPASSRLS double-predicate (explicit WHERE tenant_id = $1) mirrors the
 * resolver. Returns null when the application has no registry with this slug.
 */
async function resolveApprovalsRegistry(
  client: pg.PoolClient,
  tenantId: string,
  applicationId: string,
  slug: string,
): Promise<ApprovalsRegistryRow | null> {
  const res = await client.query<ApprovalsRegistryRow>(
    `SELECT id, application_id
       FROM choros.registry_def
      WHERE tenant_id = $1
        AND application_id = $2
        AND slug = $3
      LIMIT 1`,
    [tenantId, applicationId, slug],
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
// T-0400 [D7-2]: form-submit validation — load binding + live schema
// ---------------------------------------------------------------------------

/**
 * T-0400 [D7-2] / T-0416 [D7-2-FU]: Load form_binding.fields for a process (the
 * authoring-time snapshot of binding fields for submit-time validation), and the live
 * record_schema of the target registry (for schema-drift detection).
 *
 * Registry resolution: resolves the approvals («Согласование», slug=soglasovanie)
 * registry for the procKey's application via process_app_binding, then fetches its
 * record_schema. Falls back to null when no binding / no registry found.
 *
 * Runs on the caller's open tenant-tx client (RLS-scoped). Returns:
 *   - `bindingFields`: BindingField[] — the snapshot (excludes __step_class marker).
 *   - `liveRecordSchema`: the current registry_def.record_schema JSON (or null).
 *
 * F1 (T-0416) — FAIL-CLOSED on a thrown load error vs ABSENT binding:
 *   A key design goal: distinguish "no binding row exists" from "DB query threw".
 *
 *   - ABSENT binding (query succeeds, 0 rows) → bindingFields = null.
 *     The caller (validateAndFilterFormValues) treats null as "no validation required"
 *     and passes all values through. This is the correct backward-compat posture for
 *     processes that have never had a form binding authored.
 *
 *   - DB ERROR (query throws) → re-throw from this function.
 *     A swallowed DB error would silently turn a binding into a null, bypassing
 *     all runtime field-set validation — that is a fail-OPEN posture on what may be
 *     a transient infrastructure fault. If the DB is unhealthy, the safe response is
 *     to REJECT the submit (the caller's withTenantTx ROLLBACK is the safety net).
 *     The old `catch {} → return null` conflated both cases; this implementation
 *     re-throws DB errors explicitly.
 *
 * F3 (T-0416) — form_key-aware binding selection:
 *   The natural key of form_binding is (tenant_id, process_key, form_key), so a
 *   process with multiple forms can have multiple binding rows. When `formKey` is
 *   provided, the query adds `AND form_key = $3` to pin the binding to the exact
 *   form the submit originated from. When `formKey` is null/undefined (older call
 *   sites or processes that have not yet set a form_key), the query falls back to
 *   ORDER BY version DESC LIMIT 1 across all rows for the process — preserving the
 *   pre-T-0416 single-form behaviour.
 */
async function loadFormBindingForValidation(
  client: pg.PoolClient,
  tenantId: string,
  procKey: string,
  formKey?: string | null,
): Promise<{ bindingFields: BindingField[] | null; liveRecordSchema: unknown }> {
  if (!isUuid(tenantId)) {
    return { bindingFields: null, liveRecordSchema: null };
  }

  let bindingFields: BindingField[] | null = null;
  let liveRecordSchema: unknown = null;

  // F1: do NOT catch here — a DB error must propagate (fail-closed).
  // Only a SUCCESSFUL query that returns 0 rows should yield bindingFields = null.
  // See the F1 comment above for the full reasoning.
  //
  // F3: resolve the effective form_key for this submit:
  //   1. If `formKey` was supplied by the caller (the step's form key, from
  //      process_app_binding.form_key or the inbox task payload), use it directly.
  //   2. Otherwise, look up process_app_binding.form_key for this process. This
  //      makes F3 work automatically even when the caller did not supply it.
  //   3. If still null/absent, fall back to the latest binding for the process
  //      (backward-compat for single-form processes).
  let effectiveFormKey: string | null = formKey ?? null;
  if (!effectiveFormKey) {
    // F3 auto-resolution: look up process_app_binding.form_key for this process.
    // Non-fatal if this query fails — we fall back to the form_key-unaware path.
    // (Keep try/catch ONLY here, not around the binding load below.)
    try {
      const appBindingLookup = await client.query<{ form_key: string | null }>(
        `SELECT form_key
           FROM choros.process_app_binding
          WHERE tenant_id = $1
            AND process_key = $2
          LIMIT 1`,
        [tenantId, procKey],
      );
      effectiveFormKey = appBindingLookup.rows[0]?.form_key ?? null;
    } catch {
      // Non-fatal: fall back to form_key-unaware binding selection.
      effectiveFormKey = null;
    }
  }

  const bindingRes = effectiveFormKey
    ? await client.query<{ fields: unknown }>(
        // F3: form_key-aware selection — pin to the exact form when available.
        `SELECT fields
           FROM choros.form_binding
          WHERE tenant_id = $1
            AND process_key = $2
            AND form_key = $3
          ORDER BY version DESC
          LIMIT 1`,
        [tenantId, procKey, effectiveFormKey],
      )
    : await client.query<{ fields: unknown }>(
        // Fallback (no form_key): take the highest-version binding for the process.
        // Backward-compat for single-form processes and pre-T-0416 call sites.
        `SELECT fields
           FROM choros.form_binding
          WHERE tenant_id = $1
            AND process_key = $2
          ORDER BY version DESC
          LIMIT 1`,
        [tenantId, procKey],
      );

  const bindingRow = bindingRes.rows[0];
  if (bindingRow && Array.isArray(bindingRow.fields)) {
    // Cast the raw JSONB array members to BindingField[]. The authoring-time
    // write (binding.ts) validates the field structure; here we trust the DB.
    bindingFields = bindingRow.fields as BindingField[];
  }
  // If bindingRow is undefined (0 rows), bindingFields stays null → backward-compat
  // fail-open (no binding for this process/form → skip validation).

  // Load the live record_schema from the approvals registry for this process's app.
  // Path: procKey → process_app_binding → applicationId → registry_def (soglasovanie)
  // Non-fatal: schema-drift detection is advisory; a failing schema query must not
  // block the submit. Catch only the schema-load section to keep the fail-closed
  // posture on the binding load above.
  try {
    const appBindingRes = await client.query<{
      application_id: string;
      target_registry_slug: string | null;
    }>(
      `SELECT application_id, target_registry_slug
         FROM choros.process_app_binding
        WHERE tenant_id = $1
          AND process_key = $2
        LIMIT 1`,
      [tenantId, procKey],
    );
    const appRow = appBindingRes.rows[0];
    if (appRow && isUuid(appRow.application_id)) {
      // T-0575 BUG-017: resolve the SAME per-binding slug applyStepResult uses
      // (explicit override, else the config-primitive default) — not the
      // hardcoded ТЭЛ constant unconditionally.
      const schemaSlug =
        appRow.target_registry_slug && appRow.target_registry_slug.trim() !== ""
          ? appRow.target_registry_slug
          : resolveDefaultStepResultSlug();
      const schemaRes = await client.query<{ record_schema: unknown }>(
        `SELECT record_schema
           FROM choros.registry_def
          WHERE tenant_id = $1
            AND application_id = $2
            AND slug = $3
          LIMIT 1`,
        [tenantId, appRow.application_id, schemaSlug],
      );
      const schemaRow = schemaRes.rows[0];
      if (schemaRow) {
        liveRecordSchema = schemaRow.record_schema;
      }
    }
  } catch {
    // Non-fatal: if the schema query fails, skip schema-drift detection.
    liveRecordSchema = null;
  }

  return { bindingFields, liveRecordSchema };
}

/**
 * T-0400 [D7-2] / T-0416 [D7-2-FU]: Validate and filter human-submitted form values
 * before writing to JSONB, enforcing the PD-9 invariant ("forms reference only existing
 * variables") at runtime.
 *
 * Called from the approve handler (inbox.ts) on the open tenant-tx client, BEFORE
 * provenance fields (decision, approved_by, comment) are merged into formData.
 *
 * Three validation rules (spec §3.2):
 *   1. UNKNOWN-KEY REJECTION: keys not declared in form_binding.fields → rejected.
 *   2. ENUM VALIDATION: enum fields checked against BindingField.options[].
 *   3. SCHEMA-DRIFT: binding fields absent from live record_schema are flagged.
 *
 * Returns FormSubmitValidationResult:
 *   ok=true  → safeValues (only validated keys; ready to spread into formData).
 *   ok=false → violations (caller throws HttpError 422).
 *
 * F1 (T-0416): DB errors in the binding load now PROPAGATE (fail-closed) rather than
 * being swallowed. A thrown error here will be caught by the caller's withTenantTx
 * ROLLBACK, preventing any unvalidated write.
 *
 * F2 (T-0416): When bindingFields is null (no form_binding row for the process/form),
 * a one-time WARNING is emitted identifying the process_key so operators can see which
 * processes lack a binding. The write still proceeds (backward-compat fail-open for
 * processes without a binding) — fail-closed for missing bindings is a LATER step,
 * once all live processes carry form_binding rows.
 *
 * F3 (T-0416): The optional `formKey` parameter is threaded to loadFormBindingForValidation
 * so that multi-form processes validate against the correct binding.
 */
export async function validateAndFilterFormValues(
  client: pg.PoolClient,
  tenantId: string,
  procKey: string,
  humanFormValues: Record<string, unknown>,
  formKey?: string | null,
): Promise<FormSubmitValidationResult> {
  // F1: loadFormBindingForValidation now re-throws on DB errors (fail-closed).
  // F3: pass formKey so multi-form processes pick the right binding.
  const { bindingFields, liveRecordSchema } = await loadFormBindingForValidation(
    client,
    tenantId,
    procKey,
    formKey,
  );

  // No form binding for this process/form → skip validation, pass all values through.
  // Backward compat: processes without a form binding are not affected (D7-2 is
  // additive; only bindings that declare their field set are enforced).
  //
  // F2 (T-0416): emit an operator-visible warning so missing bindings are observable.
  // Rate-limiting is inherent (one log line per submit request, not per process).
  // Do NOT fail-closed yet — that is a later step once all live processes carry bindings.
  if (bindingFields === null) {
    const formKeyLabel = formKey ? `/${formKey}` : "";
    console.warn(
      `[step-applier] validateAndFilterFormValues: no form_binding found for ` +
        `process_key="${procKey}"${formKeyLabel} (tenant=${tenantId}); ` +
        `submitted values pass unvalidated — add a form_binding to enable runtime PD-9 enforcement`,
    );
    return { ok: true, safeValues: { ...humanFormValues } };
  }

  // Run the pure validation core.
  return validateFormSubmit(humanFormValues, bindingFields, liveRecordSchema);
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

  // --- A-branch: append a NEW record into the step-result registry.
  //
  // T-0575 [W1/деТЭЛ] BUG-017: resolve the target-result registry SLUG from the
  // instance's process_app_binding row (target.targetRegistrySlug — set when the
  // binding has an explicit override, migration 119), falling back to the
  // config-primitive default ONLY when the binding carries no override. This
  // replaces the unconditional SOGLASOVANIE_SLUG literal (ADR §2.3, AC-6): a
  // binding naming an ARBITRARY registry slug now resolves to THAT registry,
  // not only the ТЭЛ-named "soglasovanie" one.
  const resolvedSlug = target.targetRegistrySlug ?? resolveDefaultStepResultSlug();
  const approvals = await resolveApprovalsRegistry(
    client,
    tenantId,
    target.applicationId,
    resolvedSlug,
  );
  if (approvals === null) {
    // T-0575 BUG-017 (AC-7): the application is bound but has no registry with
    // the resolved slug seeded. A step that resolved an application IS expected
    // to write a step-result record — fail closed (FF-G3 semantics UNCHANGED),
    // but now with a STRUCTURED, typed error (code STEP_TARGET_UNRESOLVED, 422)
    // instead of a bare Error mapped to an undiagnosable 500 (the BUG-017
    // "500 without a log" symptom) — the approve handler (inbox.ts) lets this
    // propagate to the router's HttpError branch, which builds the
    // {error:{code,message}} envelope; a structured console.warn with
    // tenantId/processKey/applicationId/expectedSlug context is emitted by the
    // error constructor itself (not swallowed).
    throw new StepTargetUnresolvedError({
      tenantId,
      processKey: procKey,
      applicationId: target.applicationId,
      expectedSlug: resolvedSlug,
    });
  }

  const recordId = randomUUID();

  // cross_app_ref write-side: if a definition links the «Согласование» (source)
  // registry to the primary «Заявки» (target) registry, set the primary record's
  // UUID under the resolved ref_field key.
  //
  // T-0356 (E16): when the process was started by the on_create trigger, the
  // resolver carries the real originating «Заявки» record id as primaryRecordId.
  // Use it as the pointer value so the «Согласование» record points at the actual
  // purchase record, not the engine instance id. Fall back to instanceId for
  // processes started via the explicit launch affordance (process-start.ts), where
  // primaryRecordId is absent — the fallback preserves backward compatibility and
  // keeps the ref non-empty (upgradable once the 1:1 addressing lands).
  const recordData: Record<string, unknown> = { ...formData };
  const crossRef = await getCrossAppRef(
    client,
    tenantId,
    approvals.id,
    target.registryId,
  );
  if (crossRef !== null) {
    // T-0356: prefer the real record id; fall back to instanceId (T-0344 compat).
    recordData[crossRef.refField] = target.primaryRecordId ?? instanceId;
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
