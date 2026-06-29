/**
 * src/db/live-form-schema.ts — T-0520 (D7-5 wiring)
 *
 * Authoritative resolver for the live `registry_def.record_schema` field-key set
 * of a form's target registry, keyed by (tenantId, processKey, formKey).
 *
 * WHY THIS EXISTS (adversarial-review BLOCKING #1):
 *   The floor-boundary content gate (classifyFloorBoundary, T-0519) checks R-4
 *   (named-binding integrity): every fieldKey referenced by the authored document
 *   must be ⊆ the live record_schema. If the LiveSchemaView.fieldKeys were sourced
 *   from `body.fields[]` — the SAME untrusted request that carries `doc` — R-4 is
 *   toothless: an attacker controlling both just lists the dangling key in
 *   `fields[]` and R-4 passes falsely. spec §3 R-4 (lines 92-103) + §4.1 (lines
 *   164-166) require `schema` to be a projection of the LIVE registry_def.record_schema
 *   from the database. This module loads exactly that.
 *
 * RESOLUTION PATH (mirrors step-applier.ts loadFormBindingForValidation §385-418):
 *   processKey → process_app_binding.application_id → registry_def (slug='soglasovanie')
 *   → record_schema.properties → key set.
 *
 * The core classifier (floor-boundary.ts) stays pure: it still receives a ready
 * LiveSchemaView projection. This module is the DB-side adapter that builds it.
 *
 * FAIL-CLOSED (spec §4.1 lines 180-181, task constraint):
 *   When the live schema cannot be resolved (no process_app_binding, no registry_def,
 *   or a DB error), this returns `null` — the caller MUST treat a null key-set as
 *   "KEY_SET unvalidatable → Floor-2 / 409", NEVER pass-through. A DB error therefore
 *   propagates (the caller's withTenantTx ROLLBACK is the safety net) rather than
 *   silently degrading to an empty set that would let any document through.
 *
 *   Distinction (mirrors step-applier F1 fail-closed posture):
 *     - resolved registry with properties  → Set<fieldKey> (may be empty if schema
 *       genuinely has zero properties — that is an authoritative empty set).
 *     - NO registry_def / NO app binding    → null (unvalidatable → caller fails closed).
 *     - DB error                            → re-thrown (transient fault → reject).
 */

import type pg from "pg";

/** Well-known slug of the approvals («Согласование») registry (migration seed). */
const SOGLASOVANIE_SLUG = "soglasovanie" as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Resolve the live field-key set of the registry backing a process's form.
 *
 * Runs on the caller's open tenant-tx client (RLS-scoped). The explicit
 * `WHERE tenant_id = $1` double-predicate mirrors the BYPASSRLS-safe pattern in
 * step-applier.ts / process-instance-resolver.ts.
 *
 * @param client    open pg client inside a tenant transaction.
 * @param tenantId  the resolved tenant UUID.
 * @param processKey the process the form belongs to.
 * @returns Set<fieldKey> from the live record_schema, OR null when the live schema
 *          is unresolvable (no app binding / no registry) — caller fails closed.
 * @throws  re-throws DB errors (fail-closed: a transient fault must reject, not pass).
 */
export async function resolveLiveSchemaFieldKeys(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
): Promise<Set<string> | null> {
  if (!isUuid(tenantId)) {
    // Cannot scope a query without a valid tenant → unvalidatable → fail-closed.
    return null;
  }

  // Step 1: processKey → application_id (process_app_binding).
  // NOT wrapped in try/catch — a DB error here must propagate (fail-closed).
  const appRes = await client.query<{ application_id: string }>(
    `SELECT application_id
       FROM choros.process_app_binding
      WHERE tenant_id = $1
        AND process_key = $2
      LIMIT 1`,
    [tenantId, processKey],
  );
  const appRow = appRes.rows[0];
  if (!appRow || !isUuid(appRow.application_id)) {
    // No application binding for this process → cannot resolve a live schema.
    // Unvalidatable → null (caller fails closed → Floor-2 / 409).
    return null;
  }

  // Step 2: application_id → registry_def (soglasovanie) → record_schema.
  const schemaRes = await client.query<{ record_schema: unknown }>(
    `SELECT record_schema
       FROM choros.registry_def
      WHERE tenant_id = $1
        AND application_id = $2
        AND slug = $3
      LIMIT 1`,
    [tenantId, appRow.application_id, SOGLASOVANIE_SLUG],
  );
  const schemaRow = schemaRes.rows[0];
  if (!schemaRow) {
    // No registry_def for the app → no authoritative schema → unvalidatable → null.
    return null;
  }

  const recordSchema = schemaRow.record_schema as { properties?: Record<string, unknown> } | null;
  const properties =
    recordSchema && typeof recordSchema === "object" && recordSchema.properties &&
    typeof recordSchema.properties === "object"
      ? recordSchema.properties
      : null;
  if (!properties) {
    // The registry exists but has no properties object → treat as authoritative
    // EMPTY key-set (any non-empty KEY_SET in the doc is therefore a dangling
    // binding → Floor-2). This is intentionally NOT null: the registry resolved.
    return new Set<string>();
  }

  return new Set<string>(Object.keys(properties));
}
