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
import { evaluate, type NamedBindings } from "./dmn-middle.js";
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
// Constants
// ---------------------------------------------------------------------------

/**
 * The canonical gateway variable name used in the ТЭЛ process (telLinear).
 * The exclusiveGateway in tel-linear.bpmn reads this variable to pick the
 * branch (values: "standard" | "needs-approval").
 */
export const TEL_GATEWAY_VAR = "approvalRequired" as const;

/**
 * The canonical gateway id in tel-linear.bpmn (the exclusiveGateway element id).
 */
export const TEL_GATEWAY_ID = "gw-approval-threshold" as const;

/**
 * Threshold for the ТЭЛ approval gate (DMN seed migration 080):
 * purchases over 5,000,000 ₽ require additional approval.
 * This constant mirrors the seeded rule table — the canonical truth is the DB row.
 */
export const TEL_APPROVAL_THRESHOLD = 5_000_000 as const;

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
   * The freshly re-evaluated gateway variable value.
   * null when no rule tables are found.
   */
  readonly gatewayVar: string | null;
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
 * @param args.bindings       Current named bindings at triage time.
 * @param args.existingVariables Process variables map from the running instance.
 * @param args.procDefId      Optional process def id for scoped rule lookup (new-launch path).
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

  if (pinnedVersions.length > 0) {
    // ALREADY-RUNNING instance: use the OLD rule (pinned at launch).
    tables = await loadRuleTablesByVersions(client, args.tenantId, pinnedVersions);
    versions = pinnedVersions;
  } else {
    // NEW launch or legacy instance: use the NEW (current published) rule.
    const loaded = await loadPublishedRuleTables(client, args.tenantId, args.procDefId);
    tables = loaded.tables;
    versions = loaded.versions;
  }

  if (tables.length === 0) {
    // No rule tables found: emit gateway.evaluated with "no-rule-matched" verdict.
    await emitGatewayEvaluated(client as unknown as PgClientLike, {
      tenantId: args.tenantId,
      instanceId: args.instanceId,
      processKey: args.processKey,
      gatewayId: args.gatewayId,
      actor: args.actor,
      nowMs: args.nowMs,
      verdict: "no-rule-matched",
    });
    return { gatewayVar: null, isLateCompute: true, versions: [] };
  }

  const evalResult = evaluate(tables, args.bindings);
  const outcomeEntries = Object.entries(evalResult.routingOutcomes);
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

  return { gatewayVar, isLateCompute: true, versions };
}
