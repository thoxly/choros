/**
 * src/db/binding-trigger-dao.ts — T-0351 E16.
 *
 * Read-side DAO for the runtime trigger config on choros.process_app_binding
 * (migration 082). Used by records.ts to look up an on_create binding inside
 * an open tenant transaction when POST /api/records fires.
 *
 * DOCTRINE (process-data-ownership-and-metrics.md, S1 seam / RECORD_IN_PAYLOAD):
 *   The binding row carries `field_mapping` — a JSON object mapping engine variable
 *   names to record field paths. The application layer (records.ts) applies this
 *   projection to produce a SCALAR-only variable set before calling the engine.
 *   This DAO does not enforce the scalar guard — it only reads the config.
 *
 * Tenant-scoping: every function receives an ALREADY OPEN tenant client
 * (inside withTenantTx + SET LOCAL choros.tenant_id + FORCE RLS). The caller
 * is responsible for the tenant transaction; this DAO never opens its own tx.
 *
 * Zero deps outside node:crypto and pg — no HTTP, no env reads.
 */

import type { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Trigger-type values (mirrors the CHECK constraint in migration 082)
// ---------------------------------------------------------------------------

export type TriggerType = "on_create" | "record_action" | "launcher" | "auto";

// ---------------------------------------------------------------------------
// Row shape returned by getOnCreateBinding
// ---------------------------------------------------------------------------

export interface OnCreateBindingRow {
  /** Binding UUID. */
  id: string;
  /** Process key to start when a record is created in the bound application. */
  process_key: string;
  /** Trigger type (should always be 'on_create' for rows returned here). */
  trigger_type: TriggerType;
  /**
   * Optional form key to use as the start form (S4). Null = no form pinned;
   * the record's registry_def record_schema is the source of truth.
   */
  start_form_key: string | null;
  /**
   * Scalar projection mapping: engineVarName → record field path (string key
   * into the record's `data` object). Only scalar values projected are sent to
   * the engine. Object { [varName]: fieldPath }.
   */
  field_mapping: Record<string, string>;
  /**
   * T-0604 (migration 121): the BPMN taskDefinitionKey legitimately
   * auto-completable on the on_create «skip-submit» path (T-0368). NULL
   * (the default for every row that existed before migration 121, and for
   * any binding that never sets it explicitly) means auto-complete is NOT
   * engaged for this binding — the first active user-task of a freshly
   * started instance is left waiting for a human. This is the SAFE default:
   * unlike target_registry_slug (migration 119), where NULL falls back to a
   * named config-primitive default (safe — it only addresses WHERE an
   * ALREADY-DECIDED step's result is written), a guessed literal default here
   * would decide WHETHER TO SKIP A HUMAN on an irreversible engine action —
   * so there is no fallback constant, only NULL="do nothing" or an explicit,
   * data-configured key. See ADR-T0604-skip-submit-defkey.md §1.1.
   */
  submit_task_key: string | null;
}

// ---------------------------------------------------------------------------
// getOnCreateBinding
// ---------------------------------------------------------------------------

/**
 * Look up an on_create trigger binding for the given application (by
 * `application_id`) inside an already-open tenant-scoped client.
 *
 * Returns the first on_create binding row for the application, or null if no
 * such binding exists. "First" is ordered by created_at ASC, process_key ASC
 * (stable, deterministic for the common single-binding case).
 *
 * REGISTRY-DEF LEVEL: the binding is on the APPLICATION, not the individual
 * registry_def. This matches the 075 schema (process_app_binding.application_id).
 * A future on_create-per-registry-def binding would require a schema change.
 *
 * @param client  Open pg PoolClient with choros.tenant_id SET LOCAL (FORCE RLS).
 * @param tenantId  The caller's tenant UUID (used for explicit WHERE guard;
 *                  belt-and-suspenders alongside RLS).
 * @param applicationId  The application whose record was just created.
 */
export async function getOnCreateBinding(
  client: PoolClient,
  tenantId: string,
  applicationId: string,
): Promise<OnCreateBindingRow | null> {
  const { rows } = await client.query<{
    id: string;
    process_key: string;
    trigger_type: string;
    start_form_key: string | null;
    field_mapping: Record<string, string> | null;
    submit_task_key: string | null;
  }>(
    `SELECT id, process_key, trigger_type, start_form_key, field_mapping, submit_task_key
       FROM choros.process_app_binding
      WHERE tenant_id = $1
        AND application_id = $2
        AND trigger_type = 'on_create'
      ORDER BY created_at ASC, process_key ASC
      LIMIT 1`,
    [tenantId, applicationId],
  );

  if (rows.length === 0) return null;

  const row = rows[0]!;
  return {
    id: row.id,
    process_key: row.process_key,
    trigger_type: row.trigger_type as TriggerType,
    start_form_key: row.start_form_key,
    // field_mapping comes from a jsonb column; PG driver parses it to an object.
    // Coerce null (pre-082 rows with no field_mapping) to empty object.
    field_mapping:
      row.field_mapping !== null && typeof row.field_mapping === "object"
        ? (row.field_mapping as Record<string, string>)
        : {},
    // T-0604: pass through verbatim — null is the meaningful safe-default
    // value (not coerced to a fallback string), see OnCreateBindingRow doc.
    submit_task_key: row.submit_task_key,
  };
}
