/**
 * src/runtime/customer-onboarding/issue-key-effect.ts — T-0249 (B-11)
 *
 * The "Выпустить активационный ключ" STEP as a durable record effect — the last
 * mile of the customer-onboarding chain (create record → start process → complete
 * the issue-key step → key issued + WRITTEN BACK to the record).
 *
 * WHAT THIS CLOSES (the T-0244 «Step 5c» gap, issue-key.ts):
 *   runIssueKey (T-0244) does the PDP check, calls the EntitlementPort (real
 *   Ed25519 signing via T0242EntitlementPort when live), transitions the status
 *   via an actor_event, and appends audit_event(customer.key_issued). But its
 *   Step 5c explicitly DEFERRED the record-data write:
 *     "real field write happens when record-CRUD-stack lands (B-11 boundary)".
 *   B-11 (records.ts generic CRUD) has since landed. This module performs that
 *   deferred write: on a successful runIssueKey it merges the process-actor-only
 *   fields (circuit_id, activation_key_issued_at) + status='active' into the
 *   record's `data`, inside the CALLER's already-open tenant tx (atomic with the
 *   key_issued audit event).
 *
 * WHY THE DIRECT UPDATE (not the generic PUT /api/records field-mask path):
 *   circuit_id / activation_key_issued_at are SYSTEM-ONLY fields
 *   (field-mask-guard.ts SYSTEM_ONLY_FIELDS): a vendor-admin's restricted write
 *   facet is DENIED writing them through the generic HTTP route (that is exactly
 *   what ci/checks/db/field-mask-guard.test.ts proves). This step IS the process
 *   actor — the sole legitimate writer of those fields — so it writes them
 *   directly as the SYSTEM actor, mirroring step-applier.ts's SYSTEM_ACTOR
 *   record write. The write is audited (record.update) on the same hash-chain.
 *
 * ANTI-CASE (D-064): this module is CASE code and lives in the sanctioned
 * customer-onboarding quarantine namespace (src/runtime/customer-onboarding/,
 * alongside issue-key.ts / entitlement-port.ts / field-mask-guard.ts — the
 * dogfood case's home since T-0244). It is registered against a generic
 * completion-effect primitive (src/core/completion-effect.ts) whose core carries
 * NO case literals; the (process, step) → effect binding is expressed in the
 * composition root (src/composition/), the case-quarantine boundary. No
 * customer/vendor literal is introduced into any GENERIC module — enforced by
 * ci/checks/customer-crm-anti-case.sh.
 *
 * PURE-ISH: no HTTP / fetch / SDK / env read here. The tenant tx client and the
 * fully-wired IssueKeyDeps (entitlement port, PDP resolver, audit + actor-event
 * writers, live flag) are INJECTED by the caller (composition / test). The record
 * coordinates are resolved by the caller from the completed process step.
 */

import { randomUUID } from "node:crypto";

import type { PgClientLike } from "../../db/audit-writer.js";
import { makePgAuditWriter } from "../../db/audit-writer.js";
import type { ResourceRef, ResolveSubject } from "../../core/object-handle.js";
import { makeHandle } from "../../core/object-handle.js";
import { runIssueKey, type IssueKeyDeps, type IssueKeyOutcome } from "./issue-key.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface ApplyIssueKeyStepArgs {
  /** Tenant UUID (must already match the open tx GUC). */
  readonly tenantId: string;
  /** The governing registry_def id of the record (composite handle addressing). */
  readonly registryId: string;
  /** The record whose key is being issued (the process's primary record). */
  readonly recordId: string;
  /** The actor completing the step (the human who approved the issue-key task). */
  readonly actor: string;
  /**
   * The circuit id to issue the key for. When omitted, falls back to the record's
   * current `data.circuit_id` if the caller already resolved it; when THAT is also
   * absent, falls back to the recordId (a stable, tenant-unique identifier). The
   * resolved value is what the EntitlementPort signs and what is written back.
   */
  readonly circuitId?: string;
  /** Server clock for the write (epoch ms). */
  readonly nowMs: number;
}

// ---------------------------------------------------------------------------
// applyIssueKeyStep
// ---------------------------------------------------------------------------

/**
 * Execute the issue-key step against a record inside the caller's open
 * tenant-scoped tx. Delegates the authority + issuance + status transition +
 * key_issued audit to runIssueKey (unchanged), then performs the B-11 record
 * write-back on success.
 *
 * Returns runIssueKey's outcome verbatim. On `{ ok: false }` NOTHING is written
 * back (the step stays open — a dormant/denied/failed issuance leaves the record
 * untouched, exactly as before). On `{ ok: true }` the record's `data` gains
 * circuit_id + activation_key_issued_at + status='active', audited as record.update.
 */
export async function applyIssueKeyStep(
  client: PgClientLike,
  deps: IssueKeyDeps,
  args: ApplyIssueKeyStepArgs,
): Promise<IssueKeyOutcome> {
  const { tenantId, registryId, recordId, actor, nowMs } = args;

  // Resolve the circuit id: explicit arg → existing record field → recordId.
  const circuitId = await resolveCircuitId(client, args);

  const ref: ResourceRef = {
    kind: "record",
    tenantId,
    registryId,
    recordId,
  };
  const recordHandle = makeHandle(ref, tenantId);
  const subject: ResolveSubject = { tenantId, subjectId: actor };

  const outcome = await runIssueKey(client, deps, {
    tenantId,
    recordHandle,
    subject,
    circuitId,
    nowMs,
  });

  if (!outcome.ok) {
    // Step stays open — no write-back on a failed/denied/dormant issuance.
    return outcome;
  }

  // -------------------------------------------------------------------------
  // B-11 write-back (the deferred issue-key.ts Step 5c): merge the process-only
  // fields + active status into the record's data as the SYSTEM/process actor.
  // `data || $jsonb` is a shallow JSONB merge — only the three keys change; all
  // other record fields are preserved. Tenant-scoped under the caller's RLS tx.
  // -------------------------------------------------------------------------
  const writeBack = {
    circuit_id: outcome.circuit_id,
    activation_key_issued_at: outcome.issued_at,
    status: "active",
  };

  await client.query(
    `UPDATE choros.record
        SET data = data || $3::jsonb, updated_at = $4
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, recordId, JSON.stringify(writeBack), nowMs],
  );

  // Audit the system field-write on the same hash-chain (mirrors records.ts /
  // step-applier.ts record writes). The actor is the process (system) — the
  // human approver is already captured as the key_issued event's actor.
  const auditWriter = makePgAuditWriter();
  await auditWriter.appendAuditEvent(client, {
    id: randomUUID(),
    type: "record.update",
    actor: "system",
    subject: recordId,
    scope: {
      resource: "record",
      op: "update",
      registry_def_id: registryId,
      via: "customer-onboarding/issue-key-effect",
    },
    via: "customer-onboarding/issue-key-effect",
    proposed_by: null,
    confirmed_by: "system",
    payload: {
      record_id: recordId,
      registry_def_id: registryId,
      written_fields: Object.keys(writeBack),
      circuit_id: outcome.circuit_id,
      completed_by: actor,
    },
    occurred_at: nowMs,
  });

  return outcome;
}

// ---------------------------------------------------------------------------
// resolveCircuitId — arg → existing record field → recordId (fail-safe)
// ---------------------------------------------------------------------------

async function resolveCircuitId(
  client: PgClientLike,
  args: ApplyIssueKeyStepArgs,
): Promise<string> {
  if (typeof args.circuitId === "string" && args.circuitId.trim() !== "") {
    return args.circuitId;
  }
  const res = await client.query(
    `SELECT data->>'circuit_id' AS circuit_id
       FROM choros.record
      WHERE tenant_id = $1 AND id = $2`,
    [args.tenantId, args.recordId],
  );
  const row = res.rows[0] as { circuit_id?: string | null } | undefined;
  const existing = row?.circuit_id;
  if (typeof existing === "string" && existing.trim() !== "") {
    return existing;
  }
  // Deterministic, tenant-unique fallback: the record's own id.
  return args.recordId;
}
