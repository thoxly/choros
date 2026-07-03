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
  /**
   * T-0606 (migration 122): the registry_def.id this on_create binding is
   * SCOPED to. NOT the same concern as target_registry_slug (migration 119,
   * step-applier.ts's step-RESULT WRITE target) — this column governs which
   * registry's record.create EVENT is allowed to fire this binding's process
   * start in the first place (inbound trigger-scope), a distinct concern
   * from where an already-started process's step result later lands
   * (outbound write-target). NULL (the default for every row that existed
   * before migration 122) means the binding fires on create in the
   * application's PRIMARY registry — defined identically to the "primary
   * registry" notion process-instance-resolver.ts's Step 3 already uses
   * (first non-system registry by created_at ASC) — and NOT on any other
   * registry_def under the same application_id (in particular never on an
   * engine_managed registry, which by construction cannot be a legitimate
   * trigger source). Non-NULL pins the binding to that EXACT registry_def
   * id, ignoring the primary-registry fallback entirely. See
   * ADR-T0606-approval-registry-guard.md §2 for the full NULL-semantics
   * investigation and its verification against the ТЭЛ seed data.
   */
  trigger_registry_id: string | null;
}

// ---------------------------------------------------------------------------
// getOnCreateBinding
// ---------------------------------------------------------------------------

/**
 * Look up an on_create trigger binding for the given application (by
 * `application_id`) AND registry (by `registryId`) inside an already-open
 * tenant-scoped client.
 *
 * T-0606 [approval-registry-guard]: prior to this task, the lookup matched
 * ONLY on `application_id` — ANY registry_def belonging to the same
 * application (e.g. an engine-managed "Согласование" approvals-projection
 * registry seeded alongside the application's primary "Заявки" registry)
 * fired the SAME on_create binding as the primary registry itself, causing a
 * phantom process start whenever a record was created in the projection
 * registry. The lookup is now SCOPED to the specific registry the caller is
 * writing into, via `trigger_registry_id` (migration 122):
 *   - binding.trigger_registry_id IS NULL → the binding fires when
 *     `registryId` is the application's PRIMARY registry — the first
 *     non-system (`is_system = false`) registry_def under `applicationId` by
 *     `created_at ASC` (id ASC as a deterministic tiebreak for rows sharing
 *     the same created_at, e.g. seed rows inserted in the same migration
 *     with created_at=0). This mirrors, byte-for-byte, the "primary
 *     registry" resolution process-instance-resolver.ts's Step 3 already
 *     uses for the OUTBOUND (step-result) direction — see that module's
 *     `is_system = false ORDER BY created_at ASC LIMIT 1` query. Reusing the
 *     SAME definition for the INBOUND (trigger-scope) direction means a
 *     registry that is not eligible to be the step-result target (e.g.
 *     because it is_system=true) is likewise never an eligible NULL-fallback
 *     trigger source — an engine_managed registry (migration 122, Part B)
 *     is is_system=true in every case seeded so far and therefore can never
 *     satisfy this NULL fallback either.
 *   - binding.trigger_registry_id IS NOT NULL → the binding fires ONLY when
 *     `registryId` equals that exact registry_def id; no other registry
 *     (primary or not) triggers it.
 *
 * Returns the first on_create binding row matching the resolved scope, or
 * null if no such binding exists. "First" is ordered by created_at ASC,
 * process_key ASC (stable, deterministic for the common single-binding
 * case).
 *
 * @param client  Open pg PoolClient with choros.tenant_id SET LOCAL (FORCE RLS).
 * @param tenantId  The caller's tenant UUID (used for explicit WHERE guard;
 *                  belt-and-suspenders alongside RLS).
 * @param applicationId  The application whose record was just created.
 * @param registryId  The registry_def.id of the registry the record was just
 *                     created in (the caller already holds this row — see
 *                     records.ts's createRecord, which resolves `reg` before
 *                     calling this function).
 */
export async function getOnCreateBinding(
  client: PoolClient,
  tenantId: string,
  applicationId: string,
  registryId: string,
): Promise<OnCreateBindingRow | null> {
  const { rows } = await client.query<{
    id: string;
    process_key: string;
    trigger_type: string;
    start_form_key: string | null;
    field_mapping: Record<string, string> | null;
    submit_task_key: string | null;
    trigger_registry_id: string | null;
  }>(
    `SELECT pab.id, pab.process_key, pab.trigger_type, pab.start_form_key,
            pab.field_mapping, pab.submit_task_key, pab.trigger_registry_id
       FROM choros.process_app_binding pab
      WHERE pab.tenant_id = $1
        AND pab.application_id = $2
        AND pab.trigger_type = 'on_create'
        AND (
          pab.trigger_registry_id = $3
          OR (
            pab.trigger_registry_id IS NULL
            AND $3 = (
              SELECT rd.id
                FROM choros.registry_def rd
               WHERE rd.tenant_id = $1
                 AND rd.application_id = $2
                 AND rd.is_system = false
               ORDER BY rd.created_at ASC, rd.id ASC
               LIMIT 1
            )
          )
        )
      ORDER BY pab.created_at ASC, pab.process_key ASC
      LIMIT 1`,
    [tenantId, applicationId, registryId],
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
    // T-0606: pass through verbatim — null means "primary registry" (already
    // resolved by the SQL's own WHERE clause above), never coerced.
    trigger_registry_id: row.trigger_registry_id,
  };
}
