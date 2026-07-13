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
 *   processKey (+ optional applicationId, T-0711) → process_app_binding.application_id
 *   → registry_def (slug='soglasovanie' or the binding's target_registry_slug)
 *   → record_schema.properties → key set.
 *
 * The core classifier (floor-boundary.ts) stays pure: it still receives a ready
 * LiveSchemaView projection. This module is the DB-side adapter that builds it.
 *
 * MULTI-BINDING DISAMBIGUATION (T-0711, review T-0706 finding #37 — P2):
 *   `process_app_binding` carries `UNIQUE (tenant_id, process_key, application_id)`
 *   (migration 075), not `UNIQUE (tenant_id, process_key)` — one process CAN be
 *   bound to several applications. Every resolver below now accepts an optional
 *   `applicationId` to PIN which binding row to resolve; when the caller doesn't
 *   pass one (or the id doesn't match any row), the query falls back to a
 *   DETERMINISTIC choice (oldest binding by created_at, id tiebreak) rather than
 *   an ORDER-BY-less `LIMIT 1` at the mercy of the planner. See
 *   resolveLiveRecordSchema's doc comment for the full rationale.
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
 *
 * AMBIGUITY PRE-FLIGHT (T-0725, non-blocking finding N-1 of T-0711's review):
 *   `listProcessAppBindingCandidates` (bottom of this file) is a SEPARATE,
 *   caller-opt-in listing used by the document-ops agent seam to detect "2+
 *   bindings, no pin" BEFORE calling classifyLayoutSave, and answer with an
 *   honest "which application?" error instead of resolving the fallback
 *   silently against a schema the caller never chose. It does NOT change the
 *   fallback itself — floor1-editor/FormBuilder (no picker, T-0711 ADR §2)
 *   keep the deterministic oldest-binding resolution unchanged.
 */

import type pg from "pg";
// T-0575 [W1/деТЭЛ] BUG-017 (§2.5 dedup): this module carried its OWN second
// copy of the "soglasovanie" literal — schlopped into the single config-primitive
// source (resolveDefaultStepResultSlug) shared with step-applier.ts's
// applyStepResult, so the value lives in exactly one place.
import { resolveDefaultStepResultSlug } from "./step-applier.js";

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
 * @param applicationId T-0711 (optional): pin resolution to this exact
 *        (processKey, applicationId) binding when a process is bound to 2+
 *        applications — see resolveLiveRecordSchema's doc for why. Omitted →
 *        deterministic fallback (oldest binding), not planner-order.
 * @returns Set<fieldKey> from the live record_schema, OR null when the live schema
 *          is unresolvable (no app binding / no registry) — caller fails closed.
 * @throws  re-throws DB errors (fail-closed: a transient fault must reject, not pass).
 */
export async function resolveLiveSchemaFieldKeys(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
  applicationId?: string | null,
): Promise<Set<string> | null> {
  const recordSchema = await resolveLiveRecordSchema(client, tenantId, processKey, applicationId);
  if (recordSchema === null) {
    return null;
  }

  const properties =
    typeof recordSchema === "object" &&
    (recordSchema as { properties?: unknown }).properties &&
    typeof (recordSchema as { properties?: unknown }).properties === "object"
      ? (recordSchema as { properties: Record<string, unknown> }).properties
      : null;
  if (!properties) {
    // The registry exists but has no properties object → treat as authoritative
    // EMPTY key-set (any non-empty KEY_SET in the doc is therefore a dangling
    // binding → Floor-2). This is intentionally NOT null: the registry resolved.
    return new Set<string>();
  }

  return new Set<string>(Object.keys(properties));
}

/**
 * T-0680: resolve the SUB-schema key sets of every collection field in the live
 * record_schema — a map { <collectionFieldKey>: [subKey, …] }.
 *
 * WHY THIS EXISTS: R-4 channel 2 (table.columns[].subKey) does NOT live among the
 * top-level `properties` keys — a collection is `{type:"array", items:{type:"object",
 * properties:{<subKey>:…}}}`, so its column subKeys are a NESTED level. The floor
 * classifier used to fold subKeys into the same flat top-level keySet and check
 * them against `resolveLiveSchemaFieldKeys` (top-level only) → EVERY collection
 * column looked like a dangling binding, so ANY form carrying a table failed
 * classifyFloorBoundary with 409 WRONG_FLOOR (LIVE-defect T-0678: the «Позиции»
 * table of a CRM «Сделка» had to be deleted for the save to pass). Feeding this
 * map into LiveSchemaView.subKeysByCollection lets R-4 verify a column subKey
 * against its OWNING collection's sub-schema — covered when present, genuinely
 * dangling when absent — instead of against the top-level namespace.
 *
 * Same resolution path + fail-closed contract as resolveLiveSchemaFieldKeys (it
 * reuses resolveLiveRecordSchema). Returns null when the live schema is
 * unresolvable (caller fails closed); an empty map when the schema has zero
 * collection fields (authoritative — no sub-schemas to check).
 *
 * @param applicationId T-0711 (optional): same pin as resolveLiveSchemaFieldKeys
 *        — MUST be the same value passed to the sibling call for a given save
 *        (classifyLayoutSave threads one applicationId to both) so the field
 *        key-set and the collection sub-key-sets are resolved against the
 *        SAME binding row, never two different ones.
 * @returns { [collectionKey]: string[] } | null (unresolvable → caller fails closed).
 * @throws  re-throws DB errors (fail-closed), same as resolveLiveSchemaFieldKeys.
 */
export async function resolveLiveCollectionSubKeys(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
  applicationId?: string | null,
): Promise<Record<string, string[]> | null> {
  const recordSchema = await resolveLiveRecordSchema(client, tenantId, processKey, applicationId);
  if (recordSchema === null) {
    return null;
  }

  const properties =
    typeof recordSchema === "object" &&
    (recordSchema as { properties?: unknown }).properties &&
    typeof (recordSchema as { properties?: unknown }).properties === "object"
      ? (recordSchema as { properties: Record<string, unknown> }).properties
      : null;
  if (!properties) {
    // Registry resolved but no properties → no collections → authoritative empty map.
    return {};
  }

  const out: Record<string, string[]> = {};
  for (const [key, rawDef] of Object.entries(properties)) {
    if (rawDef == null || typeof rawDef !== "object" || Array.isArray(rawDef)) continue;
    const def = rawDef as { type?: unknown; items?: unknown };
    if (def.type !== "array") continue;
    const items = def.items;
    if (items == null || typeof items !== "object" || Array.isArray(items)) continue;
    const itemsObj = items as { type?: unknown; properties?: unknown };
    // A collection field is items:{type:"object", properties:{…}} — a multi-select
    // (items:{type:"string"|enum}) has NO sub-properties and is NOT a collection.
    if (itemsObj.type !== "object") continue;
    const itemProps =
      itemsObj.properties && typeof itemsObj.properties === "object" && !Array.isArray(itemsObj.properties)
        ? (itemsObj.properties as Record<string, unknown>)
        : null;
    // Record the collection even with zero sub-properties (empty array) so R-4 sees
    // an AUTHORITATIVE (present-but-empty) sub-schema, not an "unknown" one.
    out[key] = itemProps ? Object.keys(itemProps) : [];
  }
  return out;
}

/**
 * T-0665-e2e (F5/fields-from-layout fix): resolve the FULL live
 * `registry_def.record_schema` object (not merely its key set) for a
 * process's bound form. Extracted from resolveLiveSchemaFieldKeys's body
 * (same resolution path, same fail-closed semantics — see module doc) so a
 * second caller (persistLayoutDerivedFields in src/http/binding.ts) can
 * derive TYPED BindingField entries (key/type/required/options/...) via
 * form-schema-derive.ts's deriveFieldDefsFromSchema, without duplicating the
 * process_app_binding → registry_def SQL walk. resolveLiveSchemaFieldKeys
 * itself is UNCHANGED in signature/behavior — this is an additive sibling.
 *
 * T-0711 (P2 fix, review T-0706 finding #37): `process_app_binding` carries
 * `UNIQUE (tenant_id, process_key, application_id)` — ONE process CAN be
 * bound to SEVERAL applications (migration 075; the FormDesigner "Приложение"
 * picker, T-0669, lets an author pick any of them for the SAME process_key).
 * Before this fix, step 1 below resolved by `process_key` ALONE with no
 * `ORDER BY`, so a process bound to 2+ apps let Postgres return WHICHEVER row
 * its planner picked — independent of, and possibly disagreeing with, the
 * application the caller actually selected. `applicationId` (optional 4th
 * param) closes that: when the caller knows which binding it means (the
 * gate's HTTP callers now thread the FormDesigner-selected app through), the
 * resolution is PINNED to that exact (process_key, application_id) row —
 * never a different one. When omitted (legacy/agent callers with no app
 * selection UI, e.g. floor1-editor.ts, or a process with exactly one
 * binding — the overwhelming common case), the query is unchanged in EFFECT
 * for a single-binding process, and for the rare multi-binding-without-a-hint
 * case it now resolves DETERMINISTICALLY (oldest binding by `created_at`,
 * `id` tiebreak — see ORDER BY below) instead of an unspecified planner
 * choice. Both branches share ONE SQL statement (`$3::uuid IS NULL OR
 * application_id = $3`) rather than two — no risk of the two diverging.
 *
 * @param applicationId optional — pin resolution to this exact
 *        (tenant_id, process_key, application_id) binding row. When omitted
 *        (or the row for the given id doesn't exist), falls back to the
 *        oldest binding for `processKey` (deterministic, not planner-order).
 * @returns the parsed record_schema object, OR null when unresolvable (no
 *          process_app_binding / no registry_def) — same fail-closed
 *          contract as resolveLiveSchemaFieldKeys.
 * @throws  re-throws DB errors (fail-closed), same as resolveLiveSchemaFieldKeys.
 */
export async function resolveLiveRecordSchema(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
  applicationId?: string | null,
): Promise<unknown | null> {
  if (!isUuid(tenantId)) {
    // Cannot scope a query without a valid tenant → unvalidatable → fail-closed.
    return null;
  }
  if (applicationId != null && !isUuid(applicationId)) {
    // A malformed applicationId hint is worse than none — silently ignoring it
    // would resurrect the exact ambiguity this param exists to close. Fail
    // closed rather than guess (mirrors the tenantId UUID-shape check above).
    return null;
  }

  // Step 1: processKey (+ optional applicationId pin) → application_id +
  // target_registry_slug (process_app_binding). ONE statement covers both the
  // pinned and unpinned case: `$3::uuid IS NULL OR application_id = $3` is a
  // no-op filter when applicationId is absent, an exact-row filter when
  // present. ORDER BY makes the unpinned fallback deterministic (oldest
  // binding wins, ties broken by id) instead of depending on the planner's
  // unspecified row order for a `LIMIT 1` with no ORDER BY (T-0711).
  // NOT wrapped in try/catch — a DB error here must propagate (fail-closed).
  const appRes = await client.query<{ application_id: string; target_registry_slug: string | null }>(
    `SELECT application_id, target_registry_slug
       FROM choros.process_app_binding
      WHERE tenant_id = $1
        AND process_key = $2
        AND ($3::uuid IS NULL OR application_id = $3)
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [tenantId, processKey, applicationId ?? null],
  );
  const appRow = appRes.rows[0];
  if (!appRow || !isUuid(appRow.application_id)) {
    // No application binding for this process → cannot resolve a live schema.
    // Unvalidatable → null (caller fails closed → Floor-2 / 409).
    return null;
  }

  // T-0575 BUG-017: resolve the SAME per-binding slug applyStepResult uses
  // (explicit target_registry_slug override, else the config-primitive default)
  // — not the hardcoded ТЭЛ constant unconditionally.
  const schemaSlug =
    appRow.target_registry_slug && appRow.target_registry_slug.trim() !== ""
      ? appRow.target_registry_slug
      : resolveDefaultStepResultSlug();

  // Step 2: application_id → registry_def (resolved slug) → record_schema.
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
  if (!schemaRow) {
    // No registry_def for the app → no authoritative schema → unvalidatable → null.
    return null;
  }

  return schemaRow.record_schema ?? null;
}

// ---------------------------------------------------------------------------
// T-0725 (N-1, review T-0711 §6 / non-blocking finding N-1): list every
// application a process is bound to — used by an UNPINNED-caller ambiguity
// PRE-FLIGHT check, NOT by resolveLiveRecordSchema's own resolution (that
// fallback stays exactly as T-0711 designed/documented it: floor1-editor's
// `/edits` route and FormBuilder have no application picker at all and MUST
// keep the deterministic oldest-binding fallback, per T-0711 ADR §2's
// rejected-alternative rationale — changing the shared resolver would be an
// unrelated regression for those channels).
//
// The document-ops agent seam (forms-document-ops.ts) is different: an agent
// driver CAN send applicationId (T-0711 already threads it through), so for
// THAT ONE caller, a genuinely ambiguous process (2+ bindings, no pin) is a
// solvable problem, not a structural limitation — "ask, don't guess" applies
// (same posture as relation-cascade.ts's ambiguous-name ASK and
// assistant-configurator.ts's edit_jsonschema "ambiguous → ASK" comment).
// ---------------------------------------------------------------------------

/** One candidate application a process is bound to (oldest-first — same
 *  ORDER BY as resolveLiveRecordSchema's fallback, so "first candidate" and
 *  "what the silent fallback would have picked" are visibly the same row). */
export interface ProcessAppBindingCandidate {
  readonly applicationId: string;
  readonly applicationSlug: string | null;
  readonly applicationDisplayName: string | null;
  /**
   * T-0743: the bound application's `tier` ('draft' | 'published'). Additive
   * field — existing consumers (the T-0725 ambiguity-message builder) ignore
   * it. Populated for the configurator's `apply_form_document_op` tool, which
   * has NO `form_binding.tier` to gate on (that table carries no draft/
   * published split, migration 045/105) and instead enforces its DRAFT-ONLY
   * invariant via the bound APPLICATION's tier (docs/tasks/T-0743.spec.md
   * §4.4). `null` when the joined `application` row is missing (orphaned
   * binding, LEFT JOIN) — callers must treat `null` as "cannot verify", not
   * as `'draft'`.
   */
  readonly applicationTier: "draft" | "published" | null;
}

/**
 * List every `process_app_binding` row for (tenantId, processKey), joined to
 * `choros.application` for a human-readable slug/display_name (so a caller
 * can build an honest "which one?" message instead of a bare UUID list).
 *
 * Pure listing — no fail-closed null contract like resolveLiveRecordSchema:
 * an empty array is a legitimate answer ("no bindings yet" / "one binding" —
 * the caller decides what to do with the count, this just reports it).
 *
 * @returns candidates ordered exactly like resolveLiveRecordSchema's own
 *          fallback (`created_at ASC, id ASC`) — empty when the process has
 *          no binding at all (not this function's concern to fail-closed on).
 */
export async function listProcessAppBindingCandidates(
  client: pg.PoolClient,
  tenantId: string,
  processKey: string,
): Promise<ProcessAppBindingCandidate[]> {
  if (!isUuid(tenantId)) {
    return [];
  }
  const { rows } = await client.query<{
    application_id: string;
    slug: string | null;
    display_name: string | null;
    tier: string | null;
  }>(
    `SELECT pab.application_id AS application_id, a.slug AS slug, a.display_name AS display_name, a.tier AS tier
       FROM choros.process_app_binding pab
       LEFT JOIN choros.application a
              ON a.tenant_id = pab.tenant_id AND a.id = pab.application_id
      WHERE pab.tenant_id = $1
        AND pab.process_key = $2
      ORDER BY pab.created_at ASC, pab.id ASC`,
    [tenantId, processKey],
  );
  return rows.map((r) => ({
    applicationId: r.application_id,
    applicationSlug: r.slug,
    applicationDisplayName: r.display_name,
    applicationTier: r.tier === "draft" || r.tier === "published" ? r.tier : null,
  }));
}
