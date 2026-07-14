/**
 * src/core/outcome-branch-resolver.ts — T-0353 [E16]
 *
 * Pure: resolveOutcomeBranch(def, taskId, outcomeName) → {kind, target}
 *
 * DESIGN INVARIANTS:
 *   1. IO-FREE. No DB reads, no network calls, no side effects. All data is
 *      passed in via the ProcessOutcomeDef argument. This makes the resolver
 *      fully unit-testable and safe to call in any context.
 *   2. HUMAN vs DATA distinction (CRITICAL — never conflate):
 *      - This resolver handles HUMAN-chosen branches ("outcome buttons").
 *        The human clicks "Согласовать" → we find the SequenceFlow tagged
 *        choros:outcomeName="Согласовать" and return its routing target.
 *      - DMN gateway (dmn-gateway.ts) handles DATA-chosen branches.
 *        Data conditions (sum > 5M) → Flowable evaluates the DMN → route.
 *      They are orthogonal; the process designer MUST NOT use both on the same
 *      UserTask exit. This file's contract enforces that separation by operating
 *      ONLY on outcome-named flows (choros:outcomeName is present), never
 *      on DMN condition expressions.
 *   3. DOCTRINE (choros-data-ownership-doctrine): the outcome decision + comment
 *      is a STEP RESULT = ENTITY. It goes into applyStepResult's record formData
 *      (the «Согласование» registry row), NOT into a process variable
 *      (RECORD_IN_PAYLOAD guard). This module does not write variables; it only
 *      returns routing info.
 *
 * Usage (inbox.ts approve handler):
 *   const def = loadProcessOutcomeDef(processXml, taskId); // parse XML
 *   const route = resolveOutcomeBranch(def, taskId, outcomeName);
 *   if (route.kind === 'next') { ... advance to next step ... }
 *   if (route.kind === 'subprocess-sync') { ... launch subprocess ... }
 *   // also pass outcomeName into applyStepResult formData:
 *   await applyStepResult(client, { ..., formData: { decision: outcomeName, ... } });
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The routing target kinds for an outcome.
 *
 *   next              → advance to the next step (the connected SequenceFlow target)
 *   end               → terminate the process instance (no outgoing flow → end event)
 *   back              → route backward (loop-back, e.g. «На доработку» → revision step)
 *   subprocess-sync   → launch a sub-process synchronously; wait for it to complete
 *   process-async     → trigger an independent process asynchronously (fire-and-forget)
 */
export type OutcomeTargetKind =
  | 'next'
  | 'end'
  | 'back'
  | 'subprocess-sync'
  | 'process-async';

/**
 * One named outcome as stored in the choros:outcomeButtonsJson blob on a UserTask.
 * This is the per-outcome config painted in the properties panel (styling + routing).
 * NOT serialised in the XML flow conditions — that is choros:outcomeName on the flow.
 */
export interface OutcomeButtonDef {
  /** The semantic outcome name (mirrors choros:outcomeName on the outgoing SequenceFlow). */
  readonly name: string;
  /** Optional display label override (defaults to name). */
  readonly label?: string;
  /** Accent color key for the button UI. */
  readonly color?: 'primary' | 'success' | 'danger' | 'warning' | 'neutral';
  /** Whether the user must enter a comment before submitting this outcome. */
  readonly requiresComment?: boolean;
  /** Whether to show a confirmation dialog before submitting. */
  readonly confirm?: boolean;
  /** Routing target kind (mirrors the preset default; can be overridden per outcome). */
  readonly targetKind: OutcomeTargetKind;
  /**
   * Optional target id for subprocess-sync / process-async / back routes:
   *   subprocess-sync  → the sub-process element id on the canvas
   *   process-async    → the process key to trigger
   *   back             → the element id to route back to (gateway or task)
   *   next / end       → unused (determined by the flow graph)
   */
  readonly target?: string;
}

/**
 * Minimal representation of an outgoing SequenceFlow from a UserTask,
 * as parsed from the BPMN XML (or synthesised from a live moddle businessObject).
 */
export interface OutcomeFlowDef {
  /** The bpmn:SequenceFlow element id. */
  readonly flowId: string;
  /**
   * The choros:outcomeName on this flow (the named branch).
   * null = this flow has no outcome name (unconditional / default flow).
   */
  readonly outcomeName: string | null;
  /** The target element id (the bpmn:FlowNode this flow leads to). */
  readonly targetRef: string;
}

/**
 * Process-level outcome definition for one UserTask.
 * Constructed from:
 *   - choros:outcomePreset     (the preset id)
 *   - choros:outcomeButtonsJson (per-outcome styling + routing config)
 *   - The outgoing SequenceFlows of this task (outcomeName → targetRef)
 */
export interface ProcessOutcomeDef {
  /** The BPMN UserTask element id. */
  readonly taskId: string;
  /** The active preset id (e.g. "decision-rework"). May be undefined for legacy tasks. */
  readonly presetId?: string;
  /** Per-outcome button config (from choros:outcomeButtonsJson, parsed). */
  readonly buttons: readonly OutcomeButtonDef[];
  /** Outgoing SequenceFlows with their choros:outcomeName labels. */
  readonly flows: readonly OutcomeFlowDef[];
}

/**
 * Result returned by resolveOutcomeBranch.
 */
export interface OutcomeBranchResult {
  /** The routing kind (next / end / back / subprocess-sync / process-async). */
  readonly kind: OutcomeTargetKind;
  /**
   * The resolved routing target — semantics depend on kind:
   *   next            → the targetRef of the matched SequenceFlow (next step / end event id)
   *   end             → the targetRef of the matched SequenceFlow (end event id)
   *   back            → the targetRef of the matched SequenceFlow (revision step id)
   *   subprocess-sync → the sub-process element id (from OutcomeButtonDef.target or flow targetRef)
   *   process-async   → the process key (from OutcomeButtonDef.target)
   * null when the route could not be fully resolved (unmatched flow, missing target).
   */
  readonly target: string | null;
  /**
   * The matched OutcomeButtonDef (if found via the buttons config).
   * null for legacy tasks that have no buttons config.
   */
  readonly button: OutcomeButtonDef | null;
  /**
   * The matched OutcomeFlowDef (if found by outcomeName on a SequenceFlow).
   * null when no flow carries this outcomeName (caller must decide how to handle).
   */
  readonly flow: OutcomeFlowDef | null;
}

// ---------------------------------------------------------------------------
// Core resolver (pure, IO-free)
// ---------------------------------------------------------------------------

/**
 * Resolve the branch for a human-chosen outcome.
 *
 * Algorithm:
 *   1. Find the OutcomeButtonDef with name === outcomeName (panel config).
 *      — Determines the routing KIND and any explicit target override.
 *   2. Find the OutcomeFlowDef with outcomeName === outcomeName (BPMN flows).
 *      — Determines the structural flow to follow (targetRef).
 *   3. Merge: button.targetKind + flow.targetRef → {kind, target}.
 *      — button.target overrides flow.targetRef for subprocess/async/back routes.
 *
 * When no button config exists (legacy task, no panel setup):
 *   Falls back to flow-only resolution with kind='next'.
 *
 * When no matching flow exists:
 *   Returns { kind: from button or 'next', target: null, ... }.
 *   The caller must handle target === null (e.g. log warning, do nothing, or 500).
 *
 * @param def         - The ProcessOutcomeDef for the task (from the BPMN definition).
 * @param taskId      - The UserTask element id (for error context; must match def.taskId).
 * @param outcomeName - The semantic outcome the user chose (e.g. "Согласовать").
 * @returns OutcomeBranchResult
 */
export function resolveOutcomeBranch(
  def: ProcessOutcomeDef,
  taskId: string,
  outcomeName: string,
): OutcomeBranchResult {
  // Defensive: if caller passes a mismatched taskId, still resolve but with the def we have.
  // (Could throw, but fail-open here since the important guard is the DB tx in the caller.)

  // 1. Match the button config for this outcome name.
  const button = def.buttons.find((b) => b.name === outcomeName) ?? null;

  // 2. Match the SequenceFlow tagged with this outcomeName.
  const flow = def.flows.find((f) => f.outcomeName === outcomeName) ?? null;

  // 3. Determine kind from button (fall back to 'next').
  const kind: OutcomeTargetKind = button?.targetKind ?? 'next';

  // 4. Determine target:
  //    - For subprocess-sync / process-async: prefer button.target (process key / sub-process id).
  //    - For next / end / back: use flow.targetRef (the structural BPMN target).
  //    - button.target can also override for back routes (explicit backstep id).
  let target: string | null = null;

  if (kind === 'subprocess-sync' || kind === 'process-async') {
    target = button?.target ?? flow?.targetRef ?? null;
  } else if (kind === 'back' && button?.target) {
    // Explicit back-target overrides the flow's structural targetRef.
    target = button.target;
  } else {
    // next / end / back-without-explicit-target: use the structural flow.
    target = flow?.targetRef ?? null;
  }

  return { kind, target, button, flow };
}

// ---------------------------------------------------------------------------
// Helper: parse choros:outcomeButtonsJson from a UserTask businessObject
// ---------------------------------------------------------------------------

/**
 * Parse the choros:outcomeButtonsJson attribute from a UserTask businessObject
 * (or raw attribute map). Returns an empty array on parse error or absence.
 *
 * Safe: never throws. Logs to console.warn on parse error.
 *
 * Usage (server-side, from the BPMN XML attribute value string):
 *   const buttons = parseOutcomeButtons(bo.outcomeButtonsJson);
 *
 * @param jsonStr - The raw JSON string value, or null/undefined.
 * @returns OutcomeButtonDef[]
 */
export function parseOutcomeButtons(jsonStr: string | null | undefined): OutcomeButtonDef[] {
  if (!jsonStr || typeof jsonStr !== 'string') return [];
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    // Filter to valid entries (must have name + targetKind).
    return parsed.filter(
      (item): item is OutcomeButtonDef =>
        item !== null &&
        typeof item === 'object' &&
        typeof item['name'] === 'string' &&
        typeof item['targetKind'] === 'string',
    );
  } catch {
    console.warn('[outcome-branch-resolver] Failed to parse outcomeButtonsJson:', jsonStr);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helper: build a ProcessOutcomeDef from minimal BPMN context
// (convenience for callers that already have the moddle data extracted)
// ---------------------------------------------------------------------------

/**
 * Build a ProcessOutcomeDef from extracted BPMN data.
 * No IO; pure data assembly.
 *
 * @param taskId          - The UserTask element id.
 * @param presetId        - The choros:outcomePreset attribute value (may be undefined).
 * @param buttonsJsonStr  - The choros:outcomeButtonsJson attribute value (raw JSON string).
 * @param outgoingFlows   - The outgoing SequenceFlows with their outcomeName + targetRef.
 * @returns ProcessOutcomeDef
 */
export function buildProcessOutcomeDef(
  taskId: string,
  presetId: string | undefined,
  buttonsJsonStr: string | null | undefined,
  outgoingFlows: readonly { flowId: string; outcomeName: string | null; targetRef: string }[],
): ProcessOutcomeDef {
  return {
    taskId,
    presetId,
    buttons: parseOutcomeButtons(buttonsJsonStr),
    flows: outgoingFlows,
  };
}
