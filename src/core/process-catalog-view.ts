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

/**
 * Friendly fallback name for a process-definition key that has no modeler
 * row (choros.process_definition) to name it.
 *
 * T-0616 [F-2, D-064 анти-кейс]: this used to special-case the literal key
 * "telLinear" → the case-literal display string "Канонический линейный ТЭЛ" —
 * a micro-case-hardcode (every unnamed/engine-only key that HAPPENED to equal
 * "telLinear" got a specific human-facing name baked into platform code,
 * instead of the generic "no name known → show the machine key" fallback this
 * function otherwise implements for every OTHER key). Removed: the fallback
 * is now uniformly the process_key itself for every key, no exceptions — the
 * honest "I don't know a display name" signal, not a ТЭЛ-flavoured guess.
 */
export function fallbackDefinitionName(processKey: string): string {
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

// ---------------------------------------------------------------------------
// T-0709 [E16/P1]: live-engine step/role overlay — the fix for the catalog ↔
// engine divergence.
//
// THE BUG (found live, родитель T-0349): the catalog's `step`/`role` per instance
// come from listInstanceProjections, which folds the process.started audit event —
// a SNAPSHOT recorded at start time (the resolved active user-task then, or the
// config-primitive fallback when the engine read was empty). That snapshot is NOT
// re-derived as the engine token advances (or when a skip-submit auto-complete
// moved the token AFTER the snapshot was written). So a telLinear instance whose
// token is really sitting on the initiator's «Подача заявки» (role-initiator) shows
// «Согласование» (role-approver) on the «Процессы» screen — the NEXT step's label
// leaking in as the CURRENT one. The instance-detail route (/api/processes/:inst)
// reads the LIVE engine (getHistoricActivityInstances) and shows the truth, so the
// two surfaces disagree.
//
// THE FIX (this pure helper + its http caller): overlay the LIVE engine's active
// user-task onto each non-done projection's step/role BEFORE serialization, from the
// SAME engine the instance-detail route reads. `step`/`role` then reflect the node
// the token is actually on. PURE + no case-literals: the live label/role are DATA
// supplied by the caller (read from Flowable), never hardcoded here. When the caller
// supplies no live entry for an instance (engine unreachable, no active user-task,
// or a done instance), the projection is returned UNCHANGED — honest degrade to the
// snapshot, never worse than today.
// ---------------------------------------------------------------------------

/**
 * The live active-node facts for ONE instance, as read from the engine's active
 * user-task set (Flowable getActiveUserTasks → candidateGroups[0]/name). Structural
 * subset supplied by the http layer; core never imports the engine client type.
 */
export interface LiveActiveNode {
  /** Human-readable name of the node the token is currently on (task.name). */
  readonly step: string;
  /** Role the current active user-task is addressed to (candidateGroups[0]). */
  readonly role: string;
  /**
   * Every currently-active user-task's step label (one per live token). For a linear
   * instance this is a 1-element list equal to [step]; for an AND-split it holds each
   * concurrent branch. Optional — callers that only resolve the primary node omit it.
   */
  readonly concurrentSteps?: readonly string[];
}

/**
 * Overlay live-engine active-node facts onto a batch of projections. For each
 * projection that is NOT done AND has a live entry in `liveByInst`, replace `step`
 * and `role` with the live node's values (the engine truth). A done projection, or
 * one with no live entry, is returned byte-unchanged (honest degrade to the audit
 * snapshot). PURE — no I/O, no fabrication, key-order preserved.
 *
 * The overlay is intentionally display-only: it corrects the CURRENT-step label the
 * catalog shows so it matches /api/processes/:inst; it does NOT rewrite the audit
 * track (the projection's other honest fields — status, startedAt — are untouched).
 *
 * @param projections the folded projections (from listInstanceProjections).
 * @param liveByInst  inst id → LiveActiveNode, for the instances whose live token the
 *                    caller could resolve. Absent keys ⇒ that projection is unchanged.
 */
export function overlayLiveSteps<P extends ProjectionLike>(
  projections: readonly P[],
  liveByInst: ReadonlyMap<string, LiveActiveNode>,
): P[] {
  return projections.map((p) => {
    if (p.status === "done") return p;
    const live = liveByInst.get(p.inst);
    if (live === undefined) return p;
    // Only overlay non-empty live values — an empty label/role from the engine must
    // never blank out the honest snapshot the projection already carries.
    const nextStep = live.step.trim() !== "" ? live.step : p.step;
    const nextRole = live.role.trim() !== "" ? live.role : p.role;
    if (nextStep === p.step && nextRole === p.role) return p;
    return { ...p, step: nextStep, role: nextRole };
  });
}

/**
 * Reduce a live active user-task set (Flowable getActiveUserTasks output) to the
 * single LiveActiveNode the catalog displays as the CURRENT step. PURE.
 *
 * Selection: the FIRST active user-task (by the engine's own order) is the primary
 * node; its `name` → step, `candidateGroups[0]` → role. All active tasks' names feed
 * `concurrentSteps` (deduped, order-preserved) so an AND-split surfaces every branch.
 * Returns null when there is no active user-task (the token is between nodes, on a
 * non-user activity, or the instance ended) — the caller then leaves the projection
 * on its snapshot.
 *
 * Case-literal free: every value is derived from the engine-supplied tasks; the
 * ONLY fallback (empty candidateGroups → role "") is a neutral empty string, not a
 * borrowed role name — overlayLiveSteps then keeps the snapshot role for that node.
 */
export function pickPrimaryLiveNode(
  tasks: readonly {
    readonly name: string;
    readonly candidateGroups: readonly string[];
  }[],
): LiveActiveNode | null {
  if (tasks.length === 0) return null;
  const primary = tasks[0]!;
  const concurrentSteps: string[] = [];
  for (const t of tasks) {
    const label = t.name.trim();
    if (label !== "" && !concurrentSteps.includes(label)) concurrentSteps.push(label);
  }
  return {
    step: primary.name,
    role: primary.candidateGroups.length > 0 ? primary.candidateGroups[0]! : "",
    ...(concurrentSteps.length > 0 ? { concurrentSteps } : {}),
  };
}
