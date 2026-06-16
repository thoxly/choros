/**
 * src/core/inflight-migration.ts
 *
 * T-0086 · E12.5 — In-flight migration policy: DRAIN-by-default +
 * forward-only rollback guard + Camunda-mapping as on-demand escalation.
 *
 * PURE core: zero deps (no pg, fs, net, http, child_process, process.env,
 * Date.now, Math.random). All impure capabilities injected via ports.
 *
 * ADR source: docs/design/extensibility-and-authoring.md §7 / §9.6
 *
 * Design decisions (binding the ADR to code):
 *
 *   1. DRAIN-by-default (§7 "ЖЁСТКИЙ дефолт"): when a bundle/schema version
 *      changes, live process instances continue on their pinned version.
 *      The safe default = do nothing. Drain is NOT a migration; it is the
 *      absence of forced migration. This module makes it explicit and
 *      named — calling `drainInstance` records the intent, not a data move.
 *
 *   2. Rollback guard — forward-only (§7 "заблокирован"): a package/bundle
 *      rollback is BLOCKED when live instances exist on a version being
 *      rolled past. This module enforces it via `guardRollback`, which
 *      calls the injected `RollbackSafePort` (backed by T-0085's
 *      fn_check_rollback_safe DB function). Fail-CLOSED: if the port
 *      returns false OR throws, the rollback is rejected. Default-DENY.
 *
 *   3. Camunda-mapping = on-demand escalation (§7 "on-demand ЭСКАЛАЦИЯ
 *      внутри red-lines, не дефолт"): modelled as an explicit, red-line-
 *      gated CamundaMappingRequest that must clear `validateCamundaMapping`
 *      before it can be submitted. The validation enforces:
 *        - only wait-state activities may be remapped (no running tasks)
 *        - element type MUST NOT change (fromActivity.kind === toActivity.kind)
 *        - auto-map is only allowed for matching IDs
 *      The caller MUST obtain explicit human-gate approval before proceeding.
 *      This module provides the validation gate, NOT the execution path.
 *
 * Downstream contract (T-0085 binding):
 *   - `RollbackSafePort.isRollbackSafe` wraps `fn_check_rollback_safe`
 *     from migration 070. The port is injected; the core never imports pg.
 *   - Migration 071 creates `bundle_version_instance` to track live
 *     instance pins (drain state), and `inflight_mapping_request` to
 *     record red-line-gated Camunda mapping requests.
 *
 * Exports (frozen public surface, T-0086 §3.5):
 *   - InstanceDrainRecord         — drain record type
 *   - RollbackGuardResult         — result of guardRollback
 *   - CamundaMappingRequest       — escalation request shape
 *   - CamundaMappingValidation    — validation result
 *   - RollbackSafePort            — injected port interface
 *   - drainInstance               — mark an instance as pinned (drain default)
 *   - guardRollback               — fail-closed rollback enforcement
 *   - validateCamundaMapping      — validation gate for escalation requests
 */

// ---------------------------------------------------------------------------
// InstanceDrainRecord — the DRAIN-by-default state entry
// ---------------------------------------------------------------------------

/**
 * Records that a specific process instance is pinned to a bundle/schema
 * version and will DRAIN (complete) on that version.
 *
 * This is the explicit model of the DRAIN-by-default policy. When a new
 * bundle version is published, existing live instances are NOT migrated.
 * Each live instance continues on its pinned bundle version until it
 * completes naturally.
 *
 * Created by calling `drainInstance`. Stored in `bundle_version_instance`.
 */
export interface InstanceDrainRecord {
  /** Tenant ID (UUID string). */
  tenant_id: string;
  /** Process instance ID (from Flowable / process engine). */
  process_instance_id: string;
  /** Bundle ID the instance belongs to. */
  bundle_id: string;
  /**
   * The bundle content_hash the instance is pinned to.
   * This is the SPECIFIC version (commit hash) the instance was started on,
   * and the version it will complete on (drain semantics).
   */
  pinned_content_hash: string;
  /**
   * Epoch-ms when this drain record was created.
   * Injected by caller — never Date.now() in pure core.
   */
  pinned_at: number;
  /**
   * Current drain state:
   *   "draining" — instance is live, proceeding on pinned version
   *   "completed" — instance completed (no longer blocks rollback)
   */
  state: "draining" | "completed";
}

// ---------------------------------------------------------------------------
// RollbackGuardResult — result of guardRollback (fail-CLOSED semantics)
// ---------------------------------------------------------------------------

/**
 * Result of the forward-only rollback guard check.
 *
 * `allowed = false` means the rollback is BLOCKED (fail-CLOSED).
 * This is the default-DENY posture: if anything goes wrong, rollback is blocked.
 */
export interface RollbackGuardResult {
  /**
   * Whether the rollback is allowed.
   * false = BLOCKED (default when live instances exist on the target version).
   * true = allowed (no live instances pinned to versions being rolled past).
   */
  allowed: boolean;
  /**
   * Human-readable reason for the block or allowance.
   * Always set for blocked rollbacks (required for actionable error messages).
   */
  reason: string;
  /**
   * Count of live instances that block the rollback.
   * 0 if allowed. >0 if blocked due to live instances.
   */
  live_instance_count: number;
}

// ---------------------------------------------------------------------------
// CamundaMappingRequest — on-demand escalation (NOT the default)
// ---------------------------------------------------------------------------

/**
 * An activity element in the Camunda-style mapping request.
 * fromActivity must be a wait-state activity in the CURRENT (live) version.
 * toActivity must be the corresponding wait-state activity in the NEW version.
 */
export interface MappingActivityElement {
  /** Activity ID in the BPMN process definition. */
  activity_id: string;
  /**
   * Activity kind: "userTask" | "receiveTask" | "intermediateCatchEvent" |
   * "callActivity". Only wait-state kinds are eligible for mapping.
   */
  kind: "userTask" | "receiveTask" | "intermediateCatchEvent" | "callActivity";
}

/**
 * A Camunda-style in-flight instance migration mapping request.
 *
 * This is the ON-DEMAND ESCALATION path (NOT the default).
 * ADR §7: "on-demand ЭСКАЛАЦИЯ внутри red-lines, не дефолт"
 *
 * Must be validated via `validateCamundaMapping` before submission.
 * Requires explicit human-gate approval (caller responsibility).
 *
 * Constraints (enforced by validateCamundaMapping):
 *   - Only wait-state activities may be mapped.
 *   - fromActivity.kind MUST equal toActivity.kind (no type change).
 *   - auto_map_matching_ids: if true, auto-maps activities with identical IDs.
 *
 * The escalation path is rare by design — the DEFAULT for new instances
 * is to start on the new version; the DEFAULT for live instances is to DRAIN.
 */
export interface CamundaMappingRequest {
  /** Tenant ID. */
  tenant_id: string;
  /** Process instance ID to be migrated. */
  process_instance_id: string;
  /** The bundle content_hash the instance is currently on (source version). */
  from_content_hash: string;
  /** The bundle content_hash to migrate the instance to (target version). */
  to_content_hash: string;
  /** The activity the instance is currently waiting at (must be wait-state). */
  from_activity: MappingActivityElement;
  /** The activity to migrate the instance to (must be wait-state, same kind). */
  to_activity: MappingActivityElement;
  /**
   * If true, activities with identical IDs are auto-mapped.
   * ADR §7: "auto-map только совпадающих ID".
   */
  auto_map_matching_ids: boolean;
  /**
   * The actor requesting the mapping escalation (human or system with appropriate gate).
   * Required — the escalation path must be auditable.
   */
  requested_by: string;
  /**
   * Epoch-ms when the request was created.
   * Injected by caller.
   */
  requested_at: number;
}

// ---------------------------------------------------------------------------
// CamundaMappingValidation — validation result for escalation gate
// ---------------------------------------------------------------------------

/**
 * Result of `validateCamundaMapping`.
 *
 * `valid = false` blocks submission of the mapping request.
 * Caller MUST NOT proceed unless `valid = true` AND human-gate approval obtained.
 */
export interface CamundaMappingValidation {
  /** Whether the mapping request is structurally valid. */
  valid: boolean;
  /** Validation error messages (empty when valid). */
  errors: string[];
  /**
   * Whether human-gate approval is required before execution.
   * Always true for Camunda mapping requests — this is the on-demand
   * escalation path, NEVER automatic.
   */
  requires_human_gate: boolean;
}

// ---------------------------------------------------------------------------
// RollbackSafePort — injected port (binds T-0085 fn_check_rollback_safe)
// ---------------------------------------------------------------------------

/**
 * The injected port that binds T-0085's `fn_check_rollback_safe` DB function.
 *
 * The pure core calls this port. The adapter (in the db tier) wraps the
 * actual Postgres function. This is the downstream contract binding described
 * in the task spec: "T-0086 is the frozen downstream contract that binds
 * the rollback-safety enforcement."
 *
 * The port also supplies live instance count so the guard can produce an
 * actionable error message.
 *
 * Fail-closed contract: if the port implementation throws, `guardRollback`
 * treats it as "not safe" (blocked). The core enforces this — the adapter
 * does NOT need to catch its own errors.
 */
export interface RollbackSafePort {
  /**
   * Returns true iff rollback to `target_version` is safe for this registry:
   * no records exist with schema_version > target_version.
   *
   * Wraps: `fn_check_rollback_safe(p_tenant_id, p_registry_id, p_target_version)`
   * from migration 070.
   *
   * @param tenant_id     UUID of the tenant.
   * @param registry_id   UUID of the registry_def.
   * @param target_version The target schema version for rollback.
   */
  isRollbackSafe(
    tenant_id: string,
    registry_id: string,
    target_version: number,
  ): Promise<boolean>;

  /**
   * Returns the count of live process instances pinned to versions
   * being rolled past (i.e., pinned_version > target_version).
   * Used to produce an actionable blocked-rollback message.
   *
   * @param tenant_id      UUID of the tenant.
   * @param bundle_id      Bundle ID to check.
   * @param target_version The target bundle version for rollback.
   */
  countLiveInstancesAboveVersion(
    tenant_id: string,
    bundle_id: string,
    target_version: number,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// WAIT_STATE_KINDS — the allowed activity kinds for Camunda mapping
// ---------------------------------------------------------------------------

/** Activity kinds eligible for Camunda in-flight mapping (wait-state only). */
const WAIT_STATE_KINDS = new Set<MappingActivityElement["kind"]>([
  "userTask",
  "receiveTask",
  "intermediateCatchEvent",
  "callActivity",
]);

// ---------------------------------------------------------------------------
// drainInstance — create a DRAIN-by-default record (pure, no IO)
// ---------------------------------------------------------------------------

/**
 * Create an `InstanceDrainRecord` marking an instance as pinned to its
 * current bundle version (the DRAIN-by-default policy).
 *
 * Pure: does not perform IO. The caller persists the returned record.
 * This function is the explicit model of §7 "DRAIN-by-default — ЖЁСТКИЙ дефолт":
 * live instances continue on their pinned version; no forced migration.
 *
 * @param tenant_id           Tenant UUID.
 * @param process_instance_id Process engine instance ID.
 * @param bundle_id           Bundle this instance belongs to.
 * @param pinned_content_hash The content_hash (version) this instance is pinned to.
 * @param pinned_at           Epoch-ms timestamp (injected by caller).
 * @returns InstanceDrainRecord ready to be persisted.
 */
export function drainInstance(
  tenant_id: string,
  process_instance_id: string,
  bundle_id: string,
  pinned_content_hash: string,
  pinned_at: number,
): InstanceDrainRecord {
  if (!tenant_id || typeof tenant_id !== "string") {
    throw new Error("drainInstance: tenant_id must be a non-empty string");
  }
  if (!process_instance_id || typeof process_instance_id !== "string") {
    throw new Error("drainInstance: process_instance_id must be a non-empty string");
  }
  if (!bundle_id || typeof bundle_id !== "string") {
    throw new Error("drainInstance: bundle_id must be a non-empty string");
  }
  if (!pinned_content_hash || typeof pinned_content_hash !== "string") {
    throw new Error("drainInstance: pinned_content_hash must be a non-empty string");
  }
  if (!Number.isInteger(pinned_at) || !Number.isSafeInteger(pinned_at) || pinned_at < 0) {
    throw new Error("drainInstance: pinned_at must be a non-negative safe integer (epoch-ms)");
  }
  return {
    tenant_id,
    process_instance_id,
    bundle_id,
    pinned_content_hash,
    pinned_at,
    state: "draining",
  };
}

// ---------------------------------------------------------------------------
// guardRollback — fail-CLOSED forward-only rollback enforcement
// ---------------------------------------------------------------------------

/**
 * Guard a package/bundle rollback operation — FAIL-CLOSED.
 *
 * ADR §7: "package-rollback ЗАБЛОКИРОВАН, пока живы старые инстансы
 * на старой версии; rollback forward-only / компенсирующий."
 *
 * This function is the enforcement seam that binds T-0085's
 * `fn_check_rollback_safe`. It calls the injected `RollbackSafePort`:
 *   - `isRollbackSafe` wraps the DB function `fn_check_rollback_safe`
 *   - `countLiveInstancesAboveVersion` provides actionable diagnostics
 *
 * Fail-closed: if the port throws OR returns false, the rollback is BLOCKED.
 * Default-DENY: any uncertainty → blocked.
 *
 * @param tenant_id      Tenant UUID.
 * @param registry_id    Registry UUID (for schema version check via T-0085).
 * @param bundle_id      Bundle ID (for live instance drain check).
 * @param target_version The schema version being rolled back to.
 * @param port           Injected RollbackSafePort (wraps DB fn_check_rollback_safe).
 * @returns RollbackGuardResult — allowed=false means BLOCKED.
 */
export async function guardRollback(
  tenant_id: string,
  registry_id: string,
  bundle_id: string,
  target_version: number,
  port: RollbackSafePort,
): Promise<RollbackGuardResult> {
  // Validate inputs (fail-closed on invalid input)
  if (!tenant_id || typeof tenant_id !== "string") {
    return {
      allowed: false,
      reason: "guardRollback: tenant_id must be a non-empty string",
      live_instance_count: 0,
    };
  }
  if (!registry_id || typeof registry_id !== "string") {
    return {
      allowed: false,
      reason: "guardRollback: registry_id must be a non-empty string",
      live_instance_count: 0,
    };
  }
  if (!bundle_id || typeof bundle_id !== "string") {
    return {
      allowed: false,
      reason: "guardRollback: bundle_id must be a non-empty string",
      live_instance_count: 0,
    };
  }
  if (!Number.isInteger(target_version) || target_version < 0) {
    return {
      allowed: false,
      reason: `guardRollback: target_version must be a non-negative integer, got ${target_version}`,
      live_instance_count: 0,
    };
  }

  // --- Schema-version check (binds T-0085 fn_check_rollback_safe) ---
  let schemaRollbackSafe: boolean;
  try {
    schemaRollbackSafe = await port.isRollbackSafe(tenant_id, registry_id, target_version);
  } catch (err: unknown) {
    // Fail-closed: port error → rollback blocked
    const msg = err instanceof Error ? err.message : String(err);
    return {
      allowed: false,
      reason: `guardRollback: schema safety check failed (port error): ${msg}`,
      live_instance_count: 0,
    };
  }

  if (!schemaRollbackSafe) {
    // Live records exist with schema_version > target_version — blocked
    let liveCount = 0;
    try {
      liveCount = await port.countLiveInstancesAboveVersion(tenant_id, bundle_id, target_version);
    } catch {
      // Diagnostic failure: still blocked, count unknown
      liveCount = -1;
    }
    return {
      allowed: false,
      reason:
        `Rollback to schema version ${target_version} is BLOCKED: live records exist on` +
        ` newer schema versions (forward-only policy per ADR §7). Drain live instances first.`,
      live_instance_count: liveCount < 0 ? 0 : liveCount,
    };
  }

  // --- Live instance check (bundle-level drain check) ---
  let liveCount: number;
  try {
    liveCount = await port.countLiveInstancesAboveVersion(tenant_id, bundle_id, target_version);
  } catch (err: unknown) {
    // Fail-closed: if we cannot verify, block
    const msg = err instanceof Error ? err.message : String(err);
    return {
      allowed: false,
      reason: `guardRollback: live instance count check failed (port error): ${msg}`,
      live_instance_count: 0,
    };
  }

  if (liveCount > 0) {
    return {
      allowed: false,
      reason:
        `Rollback is BLOCKED: ${liveCount} live process instance(s) are draining on versions` +
        ` above ${target_version} (forward-only policy per ADR §7).` +
        ` Wait for instances to complete (drain) before rolling back.`,
      live_instance_count: liveCount,
    };
  }

  return {
    allowed: true,
    reason: "No live instances block this rollback; schema version is safe.",
    live_instance_count: 0,
  };
}

// ---------------------------------------------------------------------------
// validateCamundaMapping — gate for on-demand escalation requests
// ---------------------------------------------------------------------------

/**
 * Validate a Camunda-style in-flight mapping request.
 *
 * This is the validation gate for the ON-DEMAND ESCALATION path.
 * ADR §7: "Camunda-grade mapping — on-demand ЭСКАЛАЦИЯ внутри red-lines,
 * не дефолт: транзакционно, wait-state-only, без смены типа элемента,
 * auto-map только совпадающих ID."
 *
 * Enforced invariants:
 *   1. fromActivity.kind must be a wait-state kind (can be remapped).
 *   2. toActivity.kind must equal fromActivity.kind (no type change).
 *   3. requested_by must be non-empty (audit trail required).
 *   4. from_content_hash != to_content_hash (must be a real version change).
 *   5. requires_human_gate is always true (escalation = human-gated).
 *
 * NOTE: This function ONLY validates the request shape. The caller is
 * responsible for obtaining human-gate approval before executing the mapping.
 * Execution is NOT part of this module — this increment provides the
 * validation gate and the structured escalation type.
 *
 * Pure: no IO. Called before submitting a mapping request.
 *
 * @param request The CamundaMappingRequest to validate.
 * @returns CamundaMappingValidation — valid=false blocks submission.
 */
export function validateCamundaMapping(
  request: CamundaMappingRequest,
): CamundaMappingValidation {
  const errors: string[] = [];

  // 1. fromActivity.kind must be a wait-state kind
  if (!WAIT_STATE_KINDS.has(request.from_activity.kind)) {
    errors.push(
      `fromActivity.kind "${request.from_activity.kind}" is not a wait-state activity.` +
      ` Only wait-state activities may be remapped (ADR §7: "wait-state-only").` +
      ` Allowed kinds: ${[...WAIT_STATE_KINDS].join(", ")}.`,
    );
  }

  // 2. toActivity.kind must equal fromActivity.kind (no type change)
  if (request.from_activity.kind !== request.to_activity.kind) {
    errors.push(
      `Activity type change is not allowed.` +
      ` fromActivity.kind="${request.from_activity.kind}"` +
      ` must equal toActivity.kind="${request.to_activity.kind}"` +
      ` (ADR §7: "без смены типа элемента").`,
    );
  }

  // 3. requested_by must be non-empty
  if (!request.requested_by || typeof request.requested_by !== "string" || !request.requested_by.trim()) {
    errors.push(
      "requested_by must be a non-empty string (audit trail required for escalation path).",
    );
  }

  // 4. from_content_hash != to_content_hash
  if (
    !request.from_content_hash ||
    !request.to_content_hash ||
    request.from_content_hash === request.to_content_hash
  ) {
    errors.push(
      "from_content_hash and to_content_hash must differ (must represent a real version change).",
    );
  }

  // 5. activity IDs must be non-empty
  if (!request.from_activity.activity_id || !request.to_activity.activity_id) {
    errors.push("fromActivity.activity_id and toActivity.activity_id must be non-empty strings.");
  }

  // 6. tenant_id must be non-empty
  if (!request.tenant_id || typeof request.tenant_id !== "string") {
    errors.push("tenant_id must be a non-empty string.");
  }

  // 7. process_instance_id must be non-empty
  if (!request.process_instance_id || typeof request.process_instance_id !== "string") {
    errors.push("process_instance_id must be a non-empty string.");
  }

  return {
    valid: errors.length === 0,
    errors,
    // Always true: Camunda mapping = human-gated escalation, NEVER automatic.
    requires_human_gate: true,
  };
}
