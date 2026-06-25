/**
 * src/core/process-gen-validator.ts — T-0464 [D8-G3]: validation for free-topology
 * process GENERATION (Track G, over the Track-R executable set).
 *
 * Spec: docs/specs/text-first-solution-builder.spec.md §3.4.
 *
 * WHY A SEPARATE MODULE (not added to bpmn-linter.ts)
 *   bpmn-linter.ts is the deploy-time fail-closed gate, shared by many callers and
 *   under concurrent edit by a sibling task (T-0459 adds a message rule there). To
 *   avoid a merge conflict, the GENERATION-specific checks live here and REUSE the
 *   existing linter by CALLING it — never by editing it.
 *
 * WHAT THIS ADDS OVER lintBpmn()
 *   The deploy linter validates binding/gateway/parallel/timer well-formedness. For
 *   the GENERATION loop we additionally need two things the bot can get wrong when it
 *   free-emits a graph from a text description:
 *
 *     1. DEAD-BRANCH / REACHABILITY GUARD — a flow node the start event cannot reach,
 *        or a non-end node with no outgoing flow (a dead end). A bot can emit an
 *        orphan task or a branch that goes nowhere; lintBpmn does not do whole-graph
 *        reachability (its parallel/timer checks are per-element arity only). This is
 *        the NEW gen-specific check the task calls for. It lives HERE, not in
 *        bpmn-linter.ts (conflict-avoidance with T-0459).
 *
 *     2. GROUNDING — gateway condition variables and lane→role slugs must reference
 *        REAL fields (from the app's registry_def record_schema) and REAL tenant roles.
 *        An ungroundable reference is NOT a hard lint failure: it is surfaced so the
 *        loop can CASCADE (create the missing app/field via the T-0463 primitive) or
 *        ASK the human. So grounding returns markers, distinct from lint violations.
 *
 * REUSE (no duplication)
 *   - lintBpmn()                     → src/core/bpmn-linter.ts  (parallel/timer/binding)
 *   - extractLaneRoleBindings()      → src/core/lane-role-mapper.ts (lane → role slugs)
 *   - tokenize()                     → src/core/bpmn-xml-parser.ts (graph walk)
 *
 * PURITY (CI: no-env-in-core)
 *   PURE: no pg, no http, no fetch, no process.env, no child_process. The caller
 *   injects the grounding context (real field keys + real role slugs). String in /
 *   structured result out.
 */

import { lintBpmn, type LintViolation } from "./bpmn-linter.js";
import { extractLaneRoleBindings, slugifyLaneRole } from "./lane-role-mapper.js";
import { tokenize } from "./bpmn-xml-parser.js";

// ---------------------------------------------------------------------------
// Grounding context — the REAL fields/roles the generated process must bind to.
// ---------------------------------------------------------------------------

/**
 * The world the generated process must be grounded against: the real field keys
 * available on the bound application(s) and the real role slugs in the tenant.
 * The HTTP layer supplies these from registry_def.record_schema + the tenant's roles.
 */
export interface GroundingContext {
  /**
   * Field keys that gateway conditions may legitimately reference (the record_schema
   * field keys of the bound application, including computed/rollup keys). Compared
   * case-sensitively against the EL root variable extracted from a condition.
   */
  readonly fieldKeys: readonly string[];
  /**
   * Role slugs that exist in the tenant (role.slug). A lane name slugifies to one of
   * these; a lane that grounds to no real role is surfaced (cascade/ask), not silently
   * dispatched to a non-existent pool.
   */
  readonly roleSlugs: readonly string[];
}

// ---------------------------------------------------------------------------
// Grounding markers — NOT lint violations. Surfaced for cascade/ask.
// ---------------------------------------------------------------------------

/** A gateway condition references a field that does not exist on the app. */
export interface UngroundedField {
  readonly kind: "missing_field";
  /** The EL root variable the condition referenced (e.g. "amount"). */
  readonly fieldKey: string;
  /** The gateway/flow element the condition sits on (best-effort id). */
  readonly elementId: string;
  /** Raw condition text, for the human / changelog. */
  readonly conditionText: string;
}

/** A lane name slugifies to a role that does not exist in the tenant. */
export interface UngroundedRole {
  readonly kind: "missing_role";
  /** The lane's display name (raw). */
  readonly laneName: string;
  /** The role slug it derived to (not found among tenant roles). */
  readonly roleSlug: string;
  /** A userTask id the lane assigns (best-effort, for the human). */
  readonly flowNodeId: string;
}

export type GroundingGap = UngroundedField | UngroundedRole;

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

/**
 * The full structured outcome of validating one generated BPMN draft.
 *
 *   - lintViolations:  hard failures from the deploy linter (parallel/timer/binding)
 *                      PLUS the dead-branch/reachability guard. The loop feeds these
 *                      back to the bot as text to FIX.
 *   - groundingGaps:   soft markers — a referenced field/role does not exist yet.
 *                      The loop CASCADES (create) or ASKS; it does not just re-prompt.
 *   - ok:              true ⟺ no lintViolations AND no groundingGaps.
 */
export interface GenValidationResult {
  readonly ok: boolean;
  readonly lintViolations: readonly LintViolation[];
  readonly groundingGaps: readonly GroundingGap[];
}

// ---------------------------------------------------------------------------
// EL root-variable extraction (mirrors bpmn-linter's EL_VAR_RE shape).
// ---------------------------------------------------------------------------

/**
 * Extract the ROOT variable names from an EL condition body.
 * "${amount > 100}"        → ["amount"]
 * "${amount > total.max}"  → ["amount", "total"]
 * Best-effort, same grammar bpmn-linter uses (T-0072). Non-EL literals → [].
 */
const EL_VAR_RE = /\$\{[^}]*?\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

function extractConditionVars(conditionText: string): string[] {
  const vars: string[] = [];
  // Walk every `${...}` expression and pull each leading identifier of a sub-term.
  const exprRe = /\$\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = exprRe.exec(conditionText)) !== null) {
    const body = m[1];
    // Pull identifiers that begin a term (not method-call tails after a dot).
    // We split on operators/whitespace and take the root of each dotted path.
    const idRe = /([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
    let idMatch: RegExpExecArray | null;
    while ((idMatch = idRe.exec(body)) !== null) {
      const root = idMatch[1];
      // Skip EL keywords / literals that are not field references.
      if (EL_RESERVED.has(root.toLowerCase())) continue;
      if (!vars.includes(root)) vars.push(root);
    }
  }
  return vars;
}

/** EL/boolean keywords that are not field references. */
const EL_RESERVED = new Set([
  "true",
  "false",
  "null",
  "empty",
  "and",
  "or",
  "not",
  "div",
  "mod",
  "eq",
  "ne",
  "lt",
  "gt",
  "le",
  "ge",
]);

// Touch EL_VAR_RE so the documented grammar reference is not dead (used by the
// linter; kept here for symmetry and to assert the same root-extraction shape).
void EL_VAR_RE;

// ---------------------------------------------------------------------------
// Reachability / dead-branch guard (the NEW gen-specific check)
// ---------------------------------------------------------------------------

/** A flow node and the structural facts the reachability guard needs. */
interface FlowNode {
  readonly id: string;
  readonly kind: string; // localName, e.g. "task" | "userTask" | "endEvent" | ...
}

/**
 * Build the directed flow graph from the BPMN, then report:
 *   - UNREACHABLE: a flow node not reachable from any startEvent.
 *   - DEAD-END:    a non-end flow node with no outgoing sequenceFlow.
 * Both are emitted as malformed_xml-typed LintViolations so they flow back to the
 * bot through the SAME channel as the deploy linter's violations (one feedback path).
 *
 * Pure: tokenizer walk + BFS. No IO.
 */
function checkReachability(xml: string, violations: LintViolation[]): void {
  // Flow-node element local names we treat as graph nodes (the executable set).
  const FLOW_NODE_KINDS = new Set([
    "startEvent",
    "endEvent",
    "task",
    "userTask",
    "serviceTask",
    "sendTask",
    "receiveTask",
    "scriptTask",
    "manualTask",
    "businessRuleTask",
    "callActivity",
    "subProcess",
    "exclusiveGateway",
    "parallelGateway",
    "inclusiveGateway",
    "eventBasedGateway",
    "intermediateCatchEvent",
    "intermediateThrowEvent",
    "boundaryEvent",
  ]);
  // Nodes that legitimately have no outgoing flow (terminal).
  const TERMINAL_KINDS = new Set(["endEvent", "terminateEventDefinition"]);

  const nodes = new Map<string, FlowNode>();
  const startIds: string[] = [];
  const outgoing = new Map<string, string[]>(); // sourceId → [targetId...]
  const incoming = new Map<string, string[]>(); // targetId → [sourceId...]
  // boundaryEvent attachedToRef makes a boundary reachable via its host task.
  const boundaryAttach = new Map<string, string>(); // boundaryId → hostTaskId

  for (const token of tokenize(xml)) {
    if (token.kind === "parse-error") {
      // Malformed XML is the deploy linter's job to report (fail-closed there);
      // we just stop graph-building — lintBpmn already returned a malformed violation.
      return;
    }
    if (token.kind !== "open-tag" && token.kind !== "self-close-tag") continue;
    const { localName, attrs } = token;

    if (localName === "sequenceFlow") {
      const src = attrs.find((a) => a.name === "sourceRef")?.value ?? "";
      const tgt = attrs.find((a) => a.name === "targetRef")?.value ?? "";
      if (src && tgt) {
        (outgoing.get(src) ?? outgoing.set(src, []).get(src)!).push(tgt);
        (incoming.get(tgt) ?? incoming.set(tgt, []).get(tgt)!).push(src);
      }
      continue;
    }

    if (FLOW_NODE_KINDS.has(localName)) {
      const id = attrs.find((a) => a.name === "id")?.value ?? "";
      if (!id) continue; // id-less flow node — lintBpmn/Flowable reject; skip here.
      nodes.set(id, { id, kind: localName });
      if (localName === "startEvent") startIds.push(id);
      if (localName === "boundaryEvent") {
        const host = attrs.find((a) => a.name === "attachedToRef")?.value ?? "";
        if (host) boundaryAttach.set(id, host);
      }
    }
  }

  // No nodes at all → empty graph; nothing to check here (lintBpmn handles structure).
  if (nodes.size === 0) return;

  // BFS reachability from every startEvent. A boundaryEvent is reachable iff its host
  // is reachable (it is implicitly wired to its attached activity).
  const reachable = new Set<string>();
  const queue: string[] = [...startIds];
  for (const id of startIds) reachable.add(id);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of outgoing.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
    // Any boundary attached to `cur` becomes reachable, and its own outgoing too.
    for (const [bId, host] of boundaryAttach) {
      if (host === cur && !reachable.has(bId)) {
        reachable.add(bId);
        queue.push(bId);
      }
    }
  }

  // If there is no startEvent, every node is "unreachable" — report the missing start
  // once (a free-emitted process with no entry point is a classic bot mistake).
  if (startIds.length === 0) {
    violations.push({
      type: "malformed_xml",
      elementId: "",
      elementKind: "process",
      message:
        "dead-branch guard: the process has no <startEvent> — there is no entry point, " +
        "so no node is reachable. Add exactly one start event that leads into the flow.",
    });
    return;
  }

  for (const node of nodes.values()) {
    // UNREACHABLE: not start, not reached by BFS.
    if (!reachable.has(node.id)) {
      violations.push({
        type: "malformed_xml",
        elementId: node.id,
        elementKind: node.kind,
        message:
          `dead-branch guard: <${node.kind} id="${node.id}"> is unreachable from the ` +
          `start event (no path of sequence flows leads to it). Wire it into the flow ` +
          `or remove it.`,
      });
      continue;
    }
    // DEAD-END: a non-terminal node with no outgoing flow goes nowhere.
    const outs = outgoing.get(node.id) ?? [];
    const isTerminal = TERMINAL_KINDS.has(node.kind);
    // A boundaryEvent with no outgoing is a dead deadline — but the deploy timer
    // check already reports dangling timers; skip boundary here to avoid double-report.
    const isBoundary = node.kind === "boundaryEvent";
    if (!isTerminal && !isBoundary && outs.length === 0) {
      violations.push({
        type: "malformed_xml",
        elementId: node.id,
        elementKind: node.kind,
        message:
          `dead-branch guard: <${node.kind} id="${node.id}"> is a dead end — it has no ` +
          `outgoing sequence flow and is not an end event. Route it to the next step or ` +
          `to an <endEvent>.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Grounding: gateway conditions → real fields; lane roles → real roles.
// ---------------------------------------------------------------------------

/**
 * Walk every <conditionExpression> and collect the EL root variables it references,
 * paired with the owning sequenceFlow's sourceRef (the gateway id, best-effort).
 */
function collectConditionRefs(
  xml: string,
): Array<{ elementId: string; conditionText: string; vars: string[] }> {
  const refs: Array<{ elementId: string; conditionText: string; vars: string[] }> = [];
  let inCondition = false;
  let buffer = "";
  let ownerFlowSource = "";
  // Track the current sequenceFlow's sourceRef so a condition can attribute to a gateway.
  for (const token of tokenize(xml)) {
    if (token.kind === "parse-error") break;
    if (token.kind === "open-tag" || token.kind === "self-close-tag") {
      if (token.localName === "sequenceFlow") {
        ownerFlowSource = token.attrs.find((a) => a.name === "sourceRef")?.value ?? "";
      } else if (token.localName === "conditionExpression" && token.kind === "open-tag") {
        inCondition = true;
        buffer = "";
      }
      continue;
    }
    if (token.kind === "text") {
      if (inCondition) buffer += token.value;
      continue;
    }
    if (token.kind === "close-tag") {
      if (token.localName === "conditionExpression" && inCondition) {
        inCondition = false;
        const text = buffer.trim();
        if (text) {
          refs.push({
            elementId: ownerFlowSource,
            conditionText: text,
            vars: extractConditionVars(text),
          });
        }
        buffer = "";
      }
      continue;
    }
  }
  return refs;
}

/**
 * Ground the generated process against the real field keys and role slugs.
 * Returns the gaps: condition variables that match no field, lane roles that match
 * no tenant role. These are NOT lint failures — the loop cascades/asks on them.
 *
 * Pure. Reuses extractLaneRoleBindings (lane→role) so the slug derivation is the
 * SAME one the runtime executor-resolver consumes (no divergent slug rule).
 */
export function groundProcess(xml: string, ctx: GroundingContext): GroundingGap[] {
  const gaps: GroundingGap[] = [];
  const fieldSet = new Set(ctx.fieldKeys);
  const roleSet = new Set(ctx.roleSlugs);

  // 1. Gateway condition fields must exist on the app's record_schema.
  for (const ref of collectConditionRefs(xml)) {
    for (const v of ref.vars) {
      if (!fieldSet.has(v)) {
        gaps.push({
          kind: "missing_field",
          fieldKey: v,
          elementId: ref.elementId,
          conditionText: ref.conditionText,
        });
      }
    }
  }

  // 2. Lane roles must exist in the tenant. extractLaneRoleBindings gives us
  //    flowNodeId + laneName + derived roleSlug — we check the slug against real roles.
  const seenRoleGap = new Set<string>();
  for (const binding of extractLaneRoleBindings(xml)) {
    const slug = binding.roleSlug || slugifyLaneRole(binding.laneName);
    if (slug && !roleSet.has(slug) && !seenRoleGap.has(slug)) {
      seenRoleGap.add(slug);
      gaps.push({
        kind: "missing_role",
        laneName: binding.laneName,
        roleSlug: slug,
        flowNodeId: binding.flowNodeId,
      });
    }
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// The validator entry point
// ---------------------------------------------------------------------------

/**
 * Validate one generated BPMN draft for the generation loop.
 *
 * Runs, in order:
 *   1. lintBpmn()        — the EXISTING deploy linter (parallel coherence T-0456,
 *                          timer T-0458, binding; + the message rule T-0459 adds).
 *                          We CALL it; we never modify it.
 *   2. checkReachability — the NEW gen-specific dead-branch / reachability guard.
 *   3. groundProcess     — gateway-condition fields + lane roles vs the real world.
 *
 * @param xml  the generated BPMN draft.
 * @param ctx  optional grounding context. When omitted, grounding is skipped
 *             (lint + reachability still run). The loop always supplies it.
 */
export function validateGeneratedProcess(
  xml: string,
  ctx?: GroundingContext,
): GenValidationResult {
  const lintViolations: LintViolation[] = [];

  // 1. Existing deploy linter (REUSED — not modified).
  const lint = lintBpmn(xml);
  if (!lint.ok) lintViolations.push(...lint.violations);

  // 2. Dead-branch / reachability guard (NEW, gen-specific). Skip when the XML is
  //    already malformed (lintBpmn fail-closed on it) to avoid noise.
  const malformed = lintViolations.some((v) => v.type === "malformed_xml" && v.elementId === "");
  if (!malformed) checkReachability(xml, lintViolations);

  // 3. Grounding (soft markers — cascade/ask, not re-prompt). Only when a context
  //    is supplied and the XML parsed (no point grounding a malformed doc).
  const groundingGaps: GroundingGap[] =
    ctx && !malformed ? groundProcess(xml, ctx) : [];

  return {
    ok: lintViolations.length === 0 && groundingGaps.length === 0,
    lintViolations,
    groundingGaps,
  };
}

// ---------------------------------------------------------------------------
// Human-readable feedback text — fed BACK to the bot to fix the draft.
// ---------------------------------------------------------------------------

/**
 * Render lint violations as a compact, actionable error message to feed back to the
 * configurator bot so it can FIX the draft on the next generation attempt. Russian
 * framing (the configurator persona is Russian) with the precise English linter
 * messages preserved (they name elements/ids the bot must address).
 */
export function formatLintFeedback(violations: readonly LintViolation[]): string {
  if (violations.length === 0) return "";
  const lines = violations.map((v, i) => {
    const where = v.elementId ? ` [${v.elementKind} id="${v.elementId}"]` : ` [${v.elementKind}]`;
    return `${i + 1}.${where} ${v.message}`;
  });
  return (
    "Сгенерированный процесс не прошёл проверку. Исправь следующие ошибки и верни " +
    "ИСПРАВЛЕННЫЙ BPMN целиком:\n" +
    lines.join("\n")
  );
}

/**
 * Render grounding gaps as feedback. Missing fields/roles are NOT "fix the XML"
 * errors — they tell the bot to either cascade-create the missing field/app/role or
 * ask the human. The loop decides cascade-vs-ask; this text frames it for the bot.
 */
export function formatGroundingFeedback(gaps: readonly GroundingGap[]): string {
  if (gaps.length === 0) return "";
  const lines = gaps.map((g, i) => {
    if (g.kind === "missing_field") {
      return (
        `${i + 1}. Условие шлюза «${g.conditionText}» ссылается на поле ` +
        `«${g.fieldKey}», которого нет в приложении. Добавь это поле (edit_jsonschema) ` +
        `или свяжи приложение (relate_application), либо уточни у человека.`
      );
    }
    return (
      `${i + 1}. Дорожка «${g.laneName}» назначает роль «${g.roleSlug}», которой нет ` +
      `в организации. Создай роль или выбери существующую, либо уточни у человека.`
    );
  });
  return "Процесс ссылается на несуществующие поля/роли:\n" + lines.join("\n");
}
