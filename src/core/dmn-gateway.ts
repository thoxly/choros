/**
 * src/core/dmn-gateway.ts — T-0340 [E15-S5]
 *
 * DMN gateway wiring: the load-bearing seam that connects the pure DMN
 * evaluator (dmn-middle.ts) to the gateway variable write path (T-0335's
 * completeTask+outbox A pre-compute path) and the gateway.evaluated audit
 * event (T-0339's gateway-journal.ts).
 *
 * This module implements F4 from the machinery-implementation-plan.md:
 *   A pre-compute path (default): DMN evaluate() → gateway variable value
 *   written via completeTask+outbox (Flowable stays external REST) + a
 *   MANDATORY late-compute (re-evaluate at the triage seam to avoid stale
 *   results from cached variables).
 *
 * DESIGN INVARIANTS (ADR §3 / D-062):
 *   - IO-free evaluate() stays in dmn-middle.ts (DMN-1..DMN-5 isolation).
 *   - THIS module is the IO layer: DB reads (loadPublishedRuleTables or
 *     loadRuleTablesByVersions) + audit event emission + outbox variable write.
 *   - In-flight rule-change semantics (§8): NEW process launches use the NEW
 *     rule (loadPublishedRuleTables). ALREADY-RUNNING instances use the OLD
 *     rule (loadRuleTablesByVersions with the pinned version from variables).
 *   - Late-compute at the triage seam: always re-evaluates even when a gateway
 *     variable was pre-computed at launch, to catch stale/invalid values.
 *   - gateway.evaluated is emitted via buildGatewayEvaluatedPayload (T-0339
 *     gateway-journal.ts) + appendAuditEvent (canonical writer T-0068).
 *   - No second PDP, no parallel authority path.
 *   - Does NOT touch process_app_binding (075) — it is display/витрина only.
 *
 * Usage (triage seam — the mandatory late-compute callsite):
 *   const result = await evaluateGatewayAtTriage(client, {
 *     tenantId, instanceId, processKey, gatewayId, actor, nowMs,
 *     existingVariables,  // from the current process instance
 *   });
 *   // result.gatewayVar → the evaluated routing outcome value
 *   // result.versions   → pin these in completeTask variables for new launches
 *
 * Usage (A pre-compute at completeTask — called from the approve/complete handler):
 *   const preResult = await preComputeGatewayVariable(client, {
 *     tenantId, instanceId, processKey, procDefId, actor, nowMs,
 *   });
 *   // preResult.gatewayVar  → write as variable via completeTask
 *   // preResult.versionVars → merge into the completeTask variables map
 *   //                         (pins the rule table version for in-flight safety)
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { evaluate, type NamedBindings, type DmnRuleTable } from "./dmn-middle.js";
import {
  loadPublishedRuleTables,
  loadRuleTablesByVersions,
  serializeVersionsAsVariables,
  deserializeVersionsFromVariables,
  type DmnRuleTableVersion,
} from "../db/dmn-rule-table-store.js";
import {
  buildGatewayEvaluatedPayload,
  GATEWAY_EVALUATED_TYPE,
} from "./gateway-journal.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// Constants — ТЭЛ is now ONE EXAMPLE of the generic mechanism, not engine wiring
// ---------------------------------------------------------------------------
//
// T-0524 (constructor-foundation): the triage gateway seam is GENERIC. The
// engine resolves the authored routing variable NAME from the DMN rule table's
// `set_routing_outcome.name` effect (authored per-process in the rule-table
// editor) and the branch VALUE from the rule conditions (field+operator+value).
// NO process name, variable name, gateway id, or topic is hard-coded in the
// engine path. The constants below remain ONLY as documentation of the seeded
// ТЭЛ example and for the legacy ТЭЛ tests — they are NOT consulted by
// evaluateGatewayAtTriage / preComputeGatewayVariable, which derive the
// variable name purely from the authored rule tables.

/**
 * @deprecated Engine wiring no longer reads this. The ТЭЛ process's routing
 * variable name ("approvalRequired") is just AUTHORED DATA in its rule table's
 * `set_routing_outcome.name` effect — the generic mechanism reads it from there.
 * Kept for the ТЭЛ example documentation / legacy tests only.
 */
export const TEL_GATEWAY_VAR = "approvalRequired" as const;

/**
 * @deprecated Cosmetic only — the gateway element id used in the audit event for
 * the ТЭЛ example. The generic path derives the gateway id from the authored
 * process when available (see GATEWAY_ID_UNKNOWN fallback in the triage seam).
 * Kept for the ТЭЛ example documentation / legacy tests only.
 */
export const TEL_GATEWAY_ID = "gw-approval-threshold" as const;

/**
 * Threshold for the ТЭЛ approval gate (DMN seed migration 080):
 * purchases over 5,000,000 ₽ require additional approval.
 * This constant mirrors the seeded rule table — the canonical truth is the DB row.
 * It is AUTHORED DATA, not engine logic.
 */
export const TEL_APPROVAL_THRESHOLD = 5_000_000 as const;

/**
 * Generic fallback gateway id for the audit event when the authoring layer did
 * not (or could not) tell us which exclusiveGateway this triage seam feeds.
 * The routing itself does NOT depend on the gateway id — it depends on the
 * injected routing variable(s). The gateway id is purely an audit annotation.
 */
export const GATEWAY_ID_UNKNOWN = "gateway-unknown" as const;

// ---------------------------------------------------------------------------
// Shared audit writer
// ---------------------------------------------------------------------------

const writer = makePgAuditWriter();

// ---------------------------------------------------------------------------
// Internal: emit gateway.evaluated audit event
// ---------------------------------------------------------------------------

async function emitGatewayEvaluated(
  client: PgClientLike,
  args: {
    tenantId: string;
    instanceId: string;
    processKey: string;
    gatewayId: string;
    actor: string;
    nowMs: number;
    verdict: string;
  },
): Promise<void> {
  const payload = buildGatewayEvaluatedPayload({
    tenantId: args.tenantId,
    instanceId: args.instanceId,
    processKey: args.processKey,
    gatewayId: args.gatewayId,
    actor: args.actor,
    actorType: "service", // DMN pre-compute / triage = system/service actor
    ts: args.nowMs,
    verdict: args.verdict,
  });

  await writer.appendAuditEvent(client, {
    id: randomUUID(),
    type: GATEWAY_EVALUATED_TYPE,
    actor: args.actor,
    subject: payload.subject,
    scope: payload.scope,
    via: "dmn-gateway",
    proposed_by: null,
    confirmed_by: null,
    payload: payload.payload,
    occurred_at: args.nowMs,
  });
}

// ---------------------------------------------------------------------------
// PreComputeGatewayResult — returned by preComputeGatewayVariable
// ---------------------------------------------------------------------------

/**
 * The evaluated routing outcome — the Flowable variable NAME to set and its VALUE.
 * The name equals the routing-outcome name declared in the DMN rule table
 * (e.g. "approvalRequired") and equals the BPMN gateway's choros:routingVar
 * (publish-coherence guard, T-0436).  The caller merges { [name]: value }
 * into the startInstance variables map so the engine can route the gateway.
 */
export interface GatewayVarPair {
  readonly name: string;
  readonly value: string;
}

export interface PreComputeGatewayResult {
  /**
   * The evaluated gateway variable — name + value — or null when no rule
   * tables are found for the process.  The caller sets variables[name] = value
   * before calling startInstance so the exclusiveGateway can route correctly.
   *
   * BEFORE T-0439: gatewayVar was `string | null` (value only, name discarded).
   * AFTER  T-0439: gatewayVar is `GatewayVarPair | null` so the caller knows
   *                WHICH Flowable variable to set.
   */
  readonly gatewayVar: GatewayVarPair | null;
  /**
   * Serialized version variables to merge into the completeTask variables map.
   * These pin the rule table version so in-flight instances re-evaluate on the
   * SAME definition snapshot they were started with (§8 in-flight rule-change).
   */
  readonly versionVars: Record<string, string>;
  /**
   * The pinned version references (for callers that need the raw form).
   */
  readonly versions: DmnRuleTableVersion[];
}

// ---------------------------------------------------------------------------
// preComputeGatewayVariable — A pre-compute path (called at launch / completeTask)
// ---------------------------------------------------------------------------

/**
 * Pre-compute the gateway variable value at process launch (the A pre-compute
 * path per machinery plan §3 S5 / F4 decision). Evaluates all published DMN
 * rule tables for the process, determines the routing verdict, emits
 * `gateway.evaluated`, and returns the variable + version pins for the
 * completeTask variables map.
 *
 * Emit happens on the caller's open tenant-scoped tx. The caller is
 * responsible for including versionVars in the completeTask call.
 *
 * @param client     Caller's open tenant-scoped pg.PoolClient (RLS enforced).
 * @param args.tenantId     Tenant UUID.
 * @param args.instanceId   Process instance id.
 * @param args.processKey   BPMN process definition key (e.g. "telLinear").
 * @param args.procDefId    Process definition id for scoped rule lookup (optional).
 * @param args.actor        Actor triggering the launch (e.g. user slug).
 * @param args.nowMs        Server clock epoch-ms.
 * @param args.bindings     Named bindings / field values for DMN evaluation.
 * @param args.gatewayId    The BPMN gateway element id (for the audit event).
 */
export async function preComputeGatewayVariable(
  client: pg.PoolClient,
  args: {
    readonly tenantId: string;
    readonly instanceId: string;
    readonly processKey: string;
    readonly procDefId?: string;
    readonly actor: string;
    readonly nowMs: number;
    readonly bindings: NamedBindings;
    readonly gatewayId: string;
  },
): Promise<PreComputeGatewayResult> {
  const { tables, versions } = await loadPublishedRuleTables(
    client,
    args.tenantId,
    args.procDefId,
  );

  if (tables.length === 0) {
    return { gatewayVar: null, versionVars: {}, versions: [] };
  }

  const evalResult = evaluate(tables, args.bindings);
  const routingOutcomes = evalResult.routingOutcomes;

  // Pick the first routing outcome as the gateway variable name+value pair.
  // (The ТЭЛ seed has exactly one routing outcome: "approvalRequired".)
  // T-0439: capture BOTH name and value so the caller knows which Flowable
  // variable to set (name = choros:routingVar by publish-coherence invariant).
  const outcomeEntries = Object.entries(routingOutcomes);
  const gatewayVar: GatewayVarPair | null =
    outcomeEntries.length > 0
      ? { name: outcomeEntries[0][0], value: outcomeEntries[0][1] }
      : null;
  const verdict = gatewayVar !== null ? gatewayVar.value : "no-rule-matched";

  // Emit gateway.evaluated (canonical audit event — T-0339 gateway-journal.ts).
  await emitGatewayEvaluated(client as unknown as PgClientLike, {
    tenantId: args.tenantId,
    instanceId: args.instanceId,
    processKey: args.processKey,
    gatewayId: args.gatewayId,
    actor: args.actor,
    nowMs: args.nowMs,
    verdict,
  });

  const versionVars = serializeVersionsAsVariables(versions);
  return { gatewayVar, versionVars, versions };
}

// ---------------------------------------------------------------------------
// TriageGatewayResult — returned by evaluateGatewayAtTriage (late-compute)
// ---------------------------------------------------------------------------

export interface TriageGatewayResult {
  /**
   * The freshly re-evaluated gateway variable VALUE of the FIRST authored routing
   * outcome. null when no rule tables / no routing outcomes are found.
   *
   * BACKWARD-COMPAT: this is the bare value of `routingOutcomes`' first entry,
   * preserved so existing callers/tests that only need a single value keep working.
   * GENERIC callers should prefer `routingOutcomes` (name→value) so they inject
   * each variable under its AUTHORED name (T-0524) rather than assuming
   * "approvalRequired".
   */
  readonly gatewayVar: string | null;
  /**
   * T-0524: ALL authored routing outcomes from the process's rule tables, keyed
   * by the AUTHORED variable name (`set_routing_outcome.name`). This is the
   * generic injection map — the caller merges these into the completeTask
   * variables so Flowable's exclusiveGateway(s) route by the authored variable(s).
   *
   * Empty object ({}) when no rule tables matched / none are authored for the
   * process — the fail-closed default (no variable injected → the gateway's BPMN
   * `default` flow is taken, never a silent wrong route).
   */
  readonly routingOutcomes: Readonly<Record<string, string>>;
  /**
   * Whether this was a late-compute re-evaluation (always true for triage path).
   */
  readonly isLateCompute: true;
  /**
   * The pinned versions used for the evaluation (the old rule for in-flight instances).
   */
  readonly versions: DmnRuleTableVersion[];
}

// ---------------------------------------------------------------------------
// dropAmbiguousOutcomes — fail-closed filter for UNSCOPED multi-process loads
// ---------------------------------------------------------------------------

/**
 * Remove routing-outcome names that are AMBIGUOUS across the supplied tables.
 *
 * A name is ambiguous when it is authored (via `set_routing_outcome`) in MORE
 * THAN ONE distinct table. This only matters in the UNSCOPED triage path, where
 * the loaded NULL-scoped (process_def_id IS NULL) tables may belong to DIFFERENT
 * processes: evaluate() resolves a shared name last-write-wins, which could
 * inject another process's value (a silent WRONG route). Dropping the name makes
 * the caller inject nothing for it → the BPMN gateway's `default` flow is taken
 * (fail-closed). Names authored in at most one table are kept unchanged.
 *
 * Pure: derives ambiguity from the STATIC authored definitions (which tables
 * declare each name), independent of which rows fired, so the verdict is stable.
 */
export function dropAmbiguousOutcomes(
  outcomes: Readonly<Record<string, string>>,
  tables: readonly DmnRuleTable[],
): Readonly<Record<string, string>> {
  // Count, per routing-outcome name, how many DISTINCT tables author it.
  const authoringTables = new Map<string, Set<string>>();
  for (const table of tables) {
    for (const rule of table.rules) {
      for (const effect of rule.effects) {
        if (effect.kind === "set_routing_outcome") {
          let set = authoringTables.get(effect.name);
          if (set === undefined) {
            set = new Set<string>();
            authoringTables.set(effect.name, set);
          }
          set.add(table.id);
        }
      }
    }
  }

  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(outcomes)) {
    const tablesAuthoringName = authoringTables.get(name);
    // Ambiguous → authored by >1 distinct table → DROP (fail-closed).
    if (tablesAuthoringName !== undefined && tablesAuthoringName.size > 1) continue;
    filtered[name] = value;
  }
  return Object.freeze(filtered);
}

// ---------------------------------------------------------------------------
// evaluateGatewayAtTriage — MANDATORY late-compute at the triage seam
// ---------------------------------------------------------------------------

/**
 * MANDATORY late-compute: re-evaluate the DMN gateway at the triage seam to
 * avoid stale gateway variable values from the pre-compute path (e.g. when
 * the named bindings change between launch and triage).
 *
 * In-flight rule-change semantics (§8):
 *   - If `existingVariables` contains pinned version refs (`dmn_rtv_*` keys),
 *     this instance was launched with a specific rule set → load THAT pinned
 *     snapshot (the OLD rule).
 *   - If no pinned version refs exist, this is either a new launch or a legacy
 *     instance → load the current 'published' rule tables (the NEW rule).
 *
 * Always emits `gateway.evaluated` (even if the verdict is unchanged from the
 * pre-compute — the triage seam is the canonical source of the evaluated verdict
 * for running instances).
 *
 * @param client              Caller's open tenant-scoped pg.PoolClient.
 * @param args.tenantId       Tenant UUID.
 * @param args.instanceId     Process instance id.
 * @param args.processKey     BPMN process definition key.
 * @param args.gatewayId      The BPMN gateway element id.
 * @param args.actor          Actor at the triage seam (usually the intake agent slug).
 * @param args.nowMs          Server clock epoch-ms.
 * @param args.bindings       Current named bindings at triage time (record/app-data).
 * @param args.existingVariables Process variables map from the running instance.
 * @param args.procDefId      Optional process def id for scoped rule lookup (new-launch path).
 *
 * T-0524 (generic): the returned `routingOutcomes` is a name→value map derived
 * ENTIRELY from the authored rule tables (`set_routing_outcome.name` = the
 * authored variable name; the value comes from the matched field+operator+value
 * conditions). The caller injects each outcome under its authored name. This
 * works for ANY process+gateway authored in the rule-table editor; ТЭЛ
 * ("approvalRequired") is just one such authored configuration.
 *
 * T-0524 fail-closed (review fix): when the load is UNSCOPED (no procDefId, no
 * pinned version → all NULL-scoped tables of the tenant, possibly from different
 * processes), any routing name authored in >1 distinct table is AMBIGUOUS and is
 * DROPPED from `routingOutcomes` (→ BPMN default flow) rather than resolved
 * last-write-wins (which could inject another process's value = silent wrong
 * route). Scoped / pinned paths are never filtered.
 */
export async function evaluateGatewayAtTriage(
  client: pg.PoolClient,
  args: {
    readonly tenantId: string;
    readonly instanceId: string;
    readonly processKey: string;
    readonly gatewayId: string;
    readonly actor: string;
    readonly nowMs: number;
    readonly bindings: NamedBindings;
    readonly existingVariables: Record<string, unknown>;
    readonly procDefId?: string;
  },
): Promise<TriageGatewayResult> {
  // In-flight rule-change: check for pinned version refs in process variables.
  const pinnedVersions = deserializeVersionsFromVariables(args.existingVariables);

  let tables;
  let versions: DmnRuleTableVersion[];
  // `unscoped` = the request could NOT pin the rule set to one process: neither a
  // pinned in-flight version set NOR an explicit procDefId. In that mode the
  // published-table load returns ALL process-agnostic (process_def_id IS NULL)
  // tables of the tenant — possibly from DIFFERENT authored processes — so a
  // routing-outcome NAME authored in two different tables is AMBIGUOUS and must
  // NOT be injected (fail-closed), instead of evaluate()'s last-write-wins.
  let unscoped = false;

  if (pinnedVersions.length > 0) {
    // ALREADY-RUNNING instance: use the OLD rule (pinned at launch). Scoped by
    // the pinned version ids → no cross-process contamination.
    tables = await loadRuleTablesByVersions(client, args.tenantId, pinnedVersions);
    versions = pinnedVersions;
  } else {
    // NEW launch or legacy instance: use the NEW (current published) rule.
    const loaded = await loadPublishedRuleTables(client, args.tenantId, args.procDefId);
    tables = loaded.tables;
    versions = loaded.versions;
    // Only the procDefId-less load is unscoped (NULL-scoped tables of the tenant).
    unscoped =
      !(typeof args.procDefId === "string" && args.procDefId.trim().length > 0);
  }

  if (tables.length === 0) {
    // No rule tables found: emit gateway.evaluated with "no-rule-matched" verdict.
    // Fail-closed default: no routing outcomes → caller injects nothing → the
    // BPMN gateway's `default` flow is taken (never a silent wrong route).
    await emitGatewayEvaluated(client as unknown as PgClientLike, {
      tenantId: args.tenantId,
      instanceId: args.instanceId,
      processKey: args.processKey,
      gatewayId: args.gatewayId,
      actor: args.actor,
      nowMs: args.nowMs,
      verdict: "no-rule-matched",
    });
    return { gatewayVar: null, routingOutcomes: {}, isLateCompute: true, versions: [] };
  }

  const evalResult = evaluate(tables, args.bindings);
  // T-0524: GENERIC — surface ALL authored routing outcomes keyed by their
  // AUTHORED variable name (set_routing_outcome.name). No hard-coded name.
  //
  // T-0524 review fix (BLOCKING — fail-closed, not fail-wrong): in UNSCOPED mode
  // the loaded NULL-scoped tables may belong to DIFFERENT processes. A routing
  // name authored in >1 distinct table is AMBIGUOUS — evaluate() would resolve it
  // last-write-wins, which can inject a value from another process's table and
  // cause a SILENT WRONG ROUTE. Drop ambiguous names so the caller injects
  // nothing for them → the BPMN gateway's `default` flow is taken (fail-closed).
  // Scoped (procDefId) and pinned (in-flight version) paths are NEVER filtered.
  const routingOutcomes = unscoped
    ? dropAmbiguousOutcomes(evalResult.routingOutcomes, tables)
    : evalResult.routingOutcomes;
  const outcomeEntries = Object.entries(routingOutcomes);
  // Backward-compat single value: bare value of the FIRST outcome.
  const gatewayVar = outcomeEntries.length > 0 ? outcomeEntries[0][1] : null;
  const verdict = gatewayVar ?? "no-rule-matched";

  // Always emit gateway.evaluated at the triage seam (canonical late-compute source).
  await emitGatewayEvaluated(client as unknown as PgClientLike, {
    tenantId: args.tenantId,
    instanceId: args.instanceId,
    processKey: args.processKey,
    gatewayId: args.gatewayId,
    actor: args.actor,
    nowMs: args.nowMs,
    verdict,
  });

  return { gatewayVar, routingOutcomes, isLateCompute: true, versions };
}
