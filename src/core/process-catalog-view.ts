/**
 * src/core/process-catalog-view.ts — T-0270 (E13).
 *
 * Pure, framework-free, pg-free view logic for the REAL process catalog. Extracted
 * from src/http/process-catalog.ts so the load-bearing merge (modeler definitions ∪
 * engine-observed definitions) and the instance/definition serializers unit-test in
 * isolation (mirrors binding-compat.ts / agents-list serializeAgent).
 *
 * The central honesty invariant: a definition appears in the catalog ONLY if it has a
 * REAL source — a row in choros.process_definition (074, source 'modeler') OR a REAL
 * started instance observed via the audit-backed projection (source 'engine'). Nothing
 * is fabricated; an empty input yields an empty output (the graceful-empty state).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a projected instance. Kept as a local literal union so this
 * core view module stays self-contained (no src/http dependency — core never imports
 * up into the HTTP layer). It is structurally identical to
 * process-projection.ts's InstanceStatus.
 */
export type InstanceStatus = "running" | "waiting" | "done";

/**
 * The structural subset of an instance projection this view consumes. Mirrors the
 * fields of process-projection.ts's InstanceProjection WITHOUT importing it, so the
 * dependency arrow stays http → core (never the reverse).
 */
export interface ProjectionLike {
  readonly inst: string;
  readonly procKey: string;
  readonly role: string;
  readonly step: string;
  readonly status: InstanceStatus;
  readonly startedAt: number;
}

/** Subset of choros.process_definition (074) the catalog view consumes. */
export interface ProcessDefRow {
  process_key: string;
  name: string;
  version: number;
  status: string; // 'draft' | 'published'
  deployment_id: string | null;
  updated_at: string | number;
}

/** A real process definition surfaced on the catalog screen. */
export interface CatalogDefinition {
  /** Process-definition key (e.g. "telLinear", "purchase-approval"). */
  process_key: string;
  /** Human-readable name. */
  name: string;
  /**
   * Where this definition is REAL:
   *   'modeler' — a choros.process_definition row (074).
   *   'engine'  — derived from REAL running instances (e.g. Flowable-deployed telLinear
   *               which has no modeler row). Never a mock.
   */
  source: "modeler" | "engine";
  /** Lifecycle status: the modeler row's status, or 'deployed' for engine-only defs. */
  status: string;
  /** Latest modeler version, or null for engine-derived defs. */
  version: number | null;
  /** Count of REAL instances currently observed for this definition. */
  instance_count: number;
}

/** A real process instance surfaced on the catalog screen (from the projection). */
export interface CatalogInstance {
  inst: string;
  process_key: string;
  status: InstanceStatus;
  step: string;
  role: string;
  started_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Friendly fallback name for an engine-only definition key. */
export function fallbackDefinitionName(processKey: string): string {
  // The canonical linear ТЭЛ is the seeded engine example — name it honestly.
  if (processKey === "telLinear") return "Канонический линейный ТЭЛ";
  return processKey;
}

// ---------------------------------------------------------------------------
// Merge — the honesty core
// ---------------------------------------------------------------------------

/**
 * Build the REAL definition list from the two real sources, deduped by process_key.
 * A modeler row (source 'modeler') takes precedence for name/status/version; an
 * engine-observed key with NO modeler row is added as source 'engine'. instance_count
 * is the number of real projections for that key. PURE — no I/O, no fabrication.
 *
 * @param defRows     rows from choros.process_definition (074), tenant-scoped.
 * @param projections REAL instance projections (audit-backed), tenant-scoped.
 */
export function buildCatalogDefinitions(
  defRows: readonly ProcessDefRow[],
  projections: readonly ProjectionLike[],
): CatalogDefinition[] {
  // Count real instances per process key.
  const countByKey = new Map<string, number>();
  for (const p of projections) {
    countByKey.set(p.procKey, (countByKey.get(p.procKey) ?? 0) + 1);
  }

  const byKey = new Map<string, CatalogDefinition>();

  // 1. Modeler definitions (the authoritative store).
  for (const r of defRows) {
    if (byKey.has(r.process_key)) continue; // defRows pre-deduped to latest version
    byKey.set(r.process_key, {
      process_key: r.process_key,
      name: r.name,
      source: "modeler",
      status: r.status,
      version: r.version,
      instance_count: countByKey.get(r.process_key) ?? 0,
    });
  }

  // 2. Engine-observed keys with NO modeler row (e.g. Flowable-deployed telLinear).
  for (const [key, count] of countByKey) {
    if (byKey.has(key)) continue;
    byKey.set(key, {
      process_key: key,
      name: fallbackDefinitionName(key),
      source: "engine",
      status: "deployed",
      version: null,
      instance_count: count,
    });
  }

  // Stable, deterministic order: by process_key.
  return [...byKey.values()].sort((a, b) => a.process_key.localeCompare(b.process_key));
}

/** Serialize a projection to the catalog instance wire shape. PURE. */
export function serializeInstance(p: ProjectionLike): CatalogInstance {
  return {
    inst: p.inst,
    process_key: p.procKey,
    status: p.status,
    step: p.step,
    role: p.role,
    started_at: p.startedAt,
  };
}
