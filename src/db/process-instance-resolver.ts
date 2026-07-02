/**
 * src/db/process-instance-resolver.ts — T-0333 [E15-S1a]
 *
 * Resolver: process instance run → target record/registry.
 *
 * Contract:
 *   resolveInstanceTarget(pool, tenantId, instanceId) → InstanceTargetRef | InstanceTargetUnresolved
 *
 * Algorithm (3 RLS-gated reads inside a single tenant-scoped tx):
 *   1. Look up the process.started audit_event for the instance to get proc_key.
 *   2. Look up process_app_binding(tenant_id, process_key) to get application_id.
 *   3. Look up registry_def(tenant_id, application_id) to find the primary registry.
 *
 * When any step yields no row → return InstanceTargetUnresolved with an honest reason.
 * No throw on expected "not found" paths (downstream T-0335 branches on resolved vs unresolved).
 *
 * Tenant isolation:
 *   - All reads run inside withTenant() (SET LOCAL choros.tenant_id = '...' + FORCE RLS).
 *   - Every SELECT carries an explicit WHERE tenant_id = $N BYPASSRLS guard (T-0184 pattern).
 *   - No cross-tenant data is reachable.
 *
 * Why src/db/ (not src/core/):
 *   This module imports pg (DB I/O). It follows the same pattern as:
 *   deferred-inbox-store.ts, audit-grant-trail.ts, org.ts.
 *   Pure-logic helpers (type definitions) are kept here since there is no
 *   cross-cutting pure-core concern that would require separating them.
 *
 * NOT imported: http, fs, net, crypto, process.env, grant-resolver (no PDP bypass).
 *
 * This is the ADDRESSING PRIMITIVE for T-0335 (the S1 applier seam). T-0335 will
 * import resolveInstanceTarget and branch on the resolved.kind discriminant to either:
 *   A) append-to-registry (kind='resolved', creates a new record in targetRegistryId), or
 *   B) update-main-record (kind='resolved', updates an existing record via targetRegistryId).
 * Seam left for T-0335: call resolveInstanceTarget inside withTenantTx (the same tx as
 * createRecord/updateRecord so the resolution and the write are atomic).
 */

import pg from "pg";
import { PROCESS_STARTED_TYPE } from "../http/process-projection.js";

// ---------------------------------------------------------------------------
// UUID guard — mirrors deferred-inbox-store.ts
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// withTenant — tenant-scoped pg transaction (mirrors deferred-inbox-store.ts)
// ---------------------------------------------------------------------------

async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Result types — the public contract consumed by T-0335
// ---------------------------------------------------------------------------

/**
 * Resolved: the instance is mapped to a specific registry + application.
 * T-0335 uses applicationId + registryId to create/update the target record.
 * registrySlug is informational (display + logging); registryId is the FK.
 */
export interface InstanceTargetRef {
  readonly kind: "resolved";
  /** The Flowable process instance id that was resolved. */
  readonly instanceId: string;
  /** The process-definition key resolved from the process.started audit event. */
  readonly processKey: string;
  /** The application the process is bound to (process_app_binding). */
  readonly applicationId: string;
  /** The primary registry within that application (first by created_at ASC). */
  readonly registryId: string;
  /** The registry slug (display / logging; not a FK). */
  readonly registrySlug: string;
  /** The registry's display name (informational). */
  readonly registryDisplayName: string;
  /** Tenant id this resolution was scoped to. */
  readonly tenantId: string;
  /**
   * T-0356 (E16): the originating record id when the process was started by an
   * on_create trigger (create = start). Sourced from the process.started audit event
   * payload field `record_id` set by appendProcessStarted. When present the
   * step-applier uses it as the cross_app_ref pointer value (the real «Заявки» record
   * UUID) instead of the instanceId placeholder. Absent for processes started via the
   * explicit launch affordance (process-start.ts).
   */
  readonly primaryRecordId?: string;
  /**
   * T-0575 [W1/деТЭЛ] BUG-017: the configured target registry slug for this
   * (process_key, applicationId) binding's step-RESULT entity — sourced from
   * choros.process_app_binding.target_registry_slug (migration 119). `undefined`
   * when the binding row has NULL here (no explicit override) — the step-applier
   * resolves the default via resolveDefaultStepResultSlug() in that case, NOT a
   * second hardcoded literal. Present (non-empty string) only when the binding
   * row explicitly names a registry slug for the step result.
   */
  readonly targetRegistrySlug?: string;
}

/** Reason categories for unresolved outcomes (used by T-0335 to decide branching). */
export type UnresolvedReason =
  | "no_process_started_event"   // audit_event(process.started) not found for this instance
  | "no_app_binding"             // process_app_binding row absent for this process_key
  | "no_registry"                // application exists but has no registry_def rows
  | "invalid_input";             // tenantId / instanceId failed UUID validation

/** Unresolved: the addressing could not be completed. T-0335 skips the write. */
export interface InstanceTargetUnresolved {
  readonly kind: "unresolved";
  readonly reason: UnresolvedReason;
  /** Human-readable detail (not exposed to clients; for logging/debug). */
  readonly detail: string;
}

/** Discriminated union returned by resolveInstanceTarget. */
export type InstanceTargetResult = InstanceTargetRef | InstanceTargetUnresolved;

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface AuditStartedRow {
  payload: Record<string, unknown>;
}

interface AppBindingRow {
  application_id: string;
  /** T-0575 BUG-017: NULL when the binding has no explicit target-registry override. */
  target_registry_slug: string | null;
}

interface RegistryDefRow {
  id: string;
  slug: string;
  display_name: string;
}

// ---------------------------------------------------------------------------
// Core resolver — pure DB reads inside a tenant-scoped transaction
// ---------------------------------------------------------------------------

/**
 * Resolve the target registry/application for a running process instance.
 *
 * @param pool       pg Pool (choros_app role — NOBYPASSRLS, uses FORCE RLS).
 * @param tenantId   The tenant UUID to scope all reads to.
 * @param instanceId The Flowable process instance id (stored in audit_event payload.inst).
 *
 * @returns InstanceTargetRef if fully resolved; InstanceTargetUnresolved otherwise.
 *
 * NEVER throws on "not found" paths. Throws only on genuine infrastructure errors
 * (pg connection failure, malformed SQL — i.e., errors that should bubble).
 *
 * Seam for T-0335:
 *   const target = await resolveInstanceTarget(pool, tenantId, instanceId);
 *   if (target.kind === 'unresolved') { // skip or log }
 *   else { // createRecord / updateRecord into target.registryId }
 */
export async function resolveInstanceTarget(
  pool: pg.Pool,
  tenantId: string,
  instanceId: string,
): Promise<InstanceTargetResult> {
  // Input validation (before opening a DB connection)
  if (!isUuid(tenantId)) {
    return {
      kind: "unresolved",
      reason: "invalid_input",
      detail: `tenantId is not a valid UUID: ${JSON.stringify(tenantId)}`,
    };
  }
  if (!instanceId || instanceId.trim().length === 0) {
    return {
      kind: "unresolved",
      reason: "invalid_input",
      detail: `instanceId must be a non-empty string`,
    };
  }

  return withTenant(pool, tenantId, (client) =>
    resolveInstanceTargetReads(client, tenantId, instanceId),
  );
}

/**
 * T-0335 [E15-S1b] — ON-CLIENT overload of resolveInstanceTarget.
 *
 * Runs the SAME 3 RLS-gated reads on a caller-supplied client that is ALREADY
 * inside an open tenant-scoped tx (the inbox approve tx: BEGIN + SET LOCAL
 * choros.tenant_id + FORCE RLS). This lets the applier's resolution share the
 * approve transaction so the resolve-read and the record-write are atomic — a
 * caller ROLLBACK undoes both, exactly like createRecord/appendProcessStarted
 * run on the caller's open client.
 *
 * The caller MUST have already validated tenantId (UUID) and set the GUC; this
 * overload does NOT open/commit a tx of its own. Invalid input still degrades to
 * an `unresolved` result (no throw) so the applier branches honestly.
 *
 * NEVER throws on "not found" paths — same contract as resolveInstanceTarget.
 */
export async function resolveInstanceTargetOnClient(
  client: pg.PoolClient,
  tenantId: string,
  instanceId: string,
): Promise<InstanceTargetResult> {
  if (!isUuid(tenantId)) {
    return {
      kind: "unresolved",
      reason: "invalid_input",
      detail: `tenantId is not a valid UUID: ${JSON.stringify(tenantId)}`,
    };
  }
  if (!instanceId || instanceId.trim().length === 0) {
    return {
      kind: "unresolved",
      reason: "invalid_input",
      detail: `instanceId must be a non-empty string`,
    };
  }
  return resolveInstanceTargetReads(client, tenantId, instanceId);
}

/**
 * The shared 3-read body, run against an already-tenant-scoped client (whether
 * opened by withTenant above, or supplied by the caller's approve tx). Extracted
 * so resolveInstanceTarget (own-tx) and resolveInstanceTargetOnClient (caller-tx)
 * issue byte-identical SQL with one source of truth.
 */
async function resolveInstanceTargetReads(
  client: pg.PoolClient,
  tenantId: string,
  instanceId: string,
): Promise<InstanceTargetResult> {
  {
    // Step 1: resolve proc_key from the process.started audit event.
    //
    // The process.started event payload carries { inst, proc_key, ... }
    // (appendProcessStarted in process-projection.ts). We match on payload->>'inst'
    // which is the Flowable instance id (the engine truth).
    //
    // BYPASSRLS guard: explicit WHERE tenant_id = $2 inside an already-GUC-scoped tx.
    // This double-predicate is the T-0184 pattern used by audit-grant-trail.ts.
    const startedRes = await client.query<AuditStartedRow>(
      `SELECT payload
         FROM choros.audit_event
        WHERE type = $1
          AND tenant_id = $2
          AND payload->>'inst' = $3
        LIMIT 1`,
      [PROCESS_STARTED_TYPE, tenantId, instanceId],
    );

    if (startedRes.rows.length === 0) {
      return {
        kind: "unresolved",
        reason: "no_process_started_event",
        detail: `No process.started audit event found for instance ${instanceId} in tenant ${tenantId}`,
      };
    }

    const payload = startedRes.rows[0]?.payload ?? {};
    const processKey = typeof payload["proc_key"] === "string" ? payload["proc_key"] : "";
    if (!processKey) {
      return {
        kind: "unresolved",
        reason: "no_process_started_event",
        detail: `process.started event for instance ${instanceId} missing proc_key in payload`,
      };
    }
    // T-0356 (E16): extract the originating record id set by the on_create trigger path.
    // Present only when appendProcessStarted received a recordId (create=start).
    const primaryRecordId =
      typeof payload["record_id"] === "string" ? payload["record_id"] : undefined;

    // Step 2: resolve application_id from process_app_binding.
    //
    // A process may be bound to multiple applications (e.g. A and B), but the primary
    // binding is the one created first. We take the oldest by created_at (deterministic).
    // T-0335 can pass an explicit applicationId hint to select a specific binding when
    // ambiguity matters — for now the resolver returns the primary one.
    const bindingRes = await client.query<AppBindingRow>(
      `SELECT application_id, target_registry_slug
         FROM choros.process_app_binding
        WHERE tenant_id = $1
          AND process_key = $2
        ORDER BY created_at ASC
        LIMIT 1`,
      [tenantId, processKey],
    );

    if (bindingRes.rows.length === 0) {
      return {
        kind: "unresolved",
        reason: "no_app_binding",
        detail: `No process_app_binding found for process_key ${JSON.stringify(processKey)} in tenant ${tenantId}`,
      };
    }

    // T-0575 BUG-017: carry the per-binding target-registry override through (if set).
    const targetRegistrySlugRaw = bindingRes.rows[0]?.target_registry_slug ?? null;
    const targetRegistrySlug =
      typeof targetRegistrySlugRaw === "string" && targetRegistrySlugRaw.trim() !== ""
        ? targetRegistrySlugRaw
        : undefined;

    const applicationId = bindingRes.rows[0]?.application_id ?? "";
    if (!applicationId || !isUuid(applicationId)) {
      return {
        kind: "unresolved",
        reason: "no_app_binding",
        detail: `process_app_binding returned invalid application_id for process_key ${JSON.stringify(processKey)}`,
      };
    }

    // Step 3: resolve the primary registry_def for this application.
    //
    // An application may have multiple registries (e.g. Заявки + Согласования).
    // We return the first non-system registry by created_at (the one the constructor
    // user created first). System registries (is_system=true) are infrastructure —
    // the applier should write to user-defined registries.
    // T-0335 can refine this by inspecting form_binding to find the specific registry
    // linked to the process step's form_key; for now the resolver returns the primary.
    const registryRes = await client.query<RegistryDefRow>(
      `SELECT id, slug, display_name
         FROM choros.registry_def
        WHERE tenant_id = $1
          AND application_id = $2
          AND is_system = false
        ORDER BY created_at ASC
        LIMIT 1`,
      [tenantId, applicationId],
    );

    if (registryRes.rows.length === 0) {
      return {
        kind: "unresolved",
        reason: "no_registry",
        detail: `No registry_def found for application ${applicationId} (process ${JSON.stringify(processKey)}) in tenant ${tenantId}`,
      };
    }

    const reg = registryRes.rows[0];
    if (!reg || !isUuid(reg.id)) {
      return {
        kind: "unresolved",
        reason: "no_registry",
        detail: `registry_def returned invalid id for application ${applicationId}`,
      };
    }

    return {
      kind: "resolved",
      instanceId,
      processKey,
      applicationId,
      registryId: reg.id,
      registrySlug: reg.slug,
      registryDisplayName: reg.display_name,
      tenantId,
      // T-0356 (E16): carry through if present (from on_create trigger path).
      ...(primaryRecordId !== undefined ? { primaryRecordId } : {}),
      // T-0575 BUG-017: carry through if the binding has an explicit override.
      ...(targetRegistrySlug !== undefined ? { targetRegistrySlug } : {}),
    };
  }
}
