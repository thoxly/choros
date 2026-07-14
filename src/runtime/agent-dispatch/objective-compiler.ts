/**
 * src/runtime/agent-dispatch/objective-compiler.ts — T-0379 [D4] F1 objective compiler.
 *
 * PURE: no pg / node:http / https / net / fetch / child_process / process.env.
 * IO-free — the compiler is a deterministic transformation (structured step def
 * + published instruction text → compiled neutral objective).
 *
 * Design contract (spec §6 "objective шага" + ADR T-0378 §10 Q2/Q3):
 *   Input  → BpmnStepDef (structured fields describing what the step is) +
 *             publishedInstruction (NL text from the instruction store, arrives
 *             pre-read via the InstructionSource DI port in agent-step-context.ts).
 *   Output → CompiledObjective: { prompt: string; answerForm: string }.
 *
 * The compiled `prompt` is the single string the motor passes as `document` to
 * the LLM port (via buildNeutralLlmRequest in run-agent-step.ts).  It is:
 *   1. Domain-neutral — no legal-precheck-specific terms leak in.
 *   2. Deterministic — same inputs → same output (testable pure function).
 *   3. Additive — if the configurator published an NL contextHint, it is appended
 *      as an "Additional context" section AFTER the structured fields.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  BpmnStepDef (from job.variables — set by the bridge at enqueue time)   │
 * │   stepName     string | null   — human label of the BPMN task element   │
 * │   topic        string          — Flowable topic (always present)         │
 * │   procKey      string          — process definition key                  │
 * │   inputFields  string[]        — declared input field names              │
 * │   outputFields string[]        — declared output field names             │
 * │   contextHint  string | null   — optional NL hint from the configurator  │
 * │   fieldValues  Record<…>       — snapshot of the form data               │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The compiled prompt shape (the produced string) is a structured Markdown-like
 * prose block readable by the LLM:
 *
 *   Step: <stepName|topic>
 *   Process: <procKey>
 *   Inputs: <inputFields list with values where available>
 *   Outputs expected: <outputFields list>
 *   [Additional context: <contextHint>]
 *
 * Missing / empty sections are omitted gracefully so the prompt is always
 * non-empty when there is at least one field or a step name.  A completely
 * empty input (no name, no fields) produces the sentinel "No structured step
 * definition available" so the motor can still call the LLM and let it decide.
 *
 * The answerForm is taken from the published instruction (default
 * "agent_step_v1" when absent) — it is threaded through unchanged so the
 * motor can stamp the answer-form code on the audit event.
 *
 * FROZEN-GATE NOTE (FF-LP-4 / FF-COMP-6):
 *   The instruction text arrives as a plain string parameter (already resolved
 *   by the InstructionSource DI port outside this module).  This module does NOT
 *   import from the instruction store or use the instruction DAO directly.
 *   No frozen-check allowlist edit is required.
 */

// ---------------------------------------------------------------------------
// BpmnStepDef — the structured step shape extracted from job.variables.
// ---------------------------------------------------------------------------

/**
 * Structured definition of a BPMN agent-step, extracted from job.variables at
 * context-assembly time.  All fields are optional-safe; missing fields degrade
 * gracefully.  The assembler (agent-step-context.ts) calls readStepDef() to
 * extract this from the raw variables map.
 *
 * Fields sourced from job.variables at enqueue:
 *   stepName      — the BPMN serviceTask/@name ("Триаж"); bridged via job.variables.stepName
 *   topic         — the Flowable topic (e.g. "tel-intake"); always present as job.topic
 *   procKey       — the process definition key ("telLinear")
 *   inputFields   — declared input field keys (e.g. ["subject","amount","justification"])
 *   outputFields  — declared output field keys (e.g. ["decision","confidence"])
 *   contextHint   — optional NL hint the configurator published on the binding
 *   fieldValues   — the form-data snapshot (job.variables.fields)
 */
export interface BpmnStepDef {
  /** Human label of the BPMN task element (serviceTask/@name). Null when absent. */
  readonly stepName: string | null;
  /** Flowable topic that identifies this step type. Always present. */
  readonly topic: string;
  /** Process definition key. Always present (read from job.variables.procKey). */
  readonly procKey: string;
  /** Declared input field keys for this step (from job.variables or binding meta). */
  readonly inputFields: readonly string[];
  /** Declared output field keys the step is expected to produce. */
  readonly outputFields: readonly string[];
  /** Optional NL context hint from the configurator (job.variables.contextHint). */
  readonly contextHint: string | null;
  /** Snapshot of actual field values submitted with the form. */
  readonly fieldValues: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CompiledObjective — the output of the F1 compiler.
// ---------------------------------------------------------------------------

/**
 * The output of compileObjective: the compiled prompt string + the answer-form
 * code.  This is what the motor receives as objective.prompt + objective.answerForm.
 *
 * prompt     — neutral NL description of the step; non-empty iff
 *              the input has at least one named element.
 * answerForm — the form code to stamp on the answer (from the published
 *              instruction; "agent_step_v1" default).
 */
export interface CompiledObjective {
  /** Compiled neutral prompt string for the motor. Never null. */
  readonly prompt: string;
  /** Answer-form code. Default "agent_step_v1". */
  readonly answerForm: string;
}

// ---------------------------------------------------------------------------
// readStepDef — extract a BpmnStepDef from raw job.variables.
// ---------------------------------------------------------------------------

/**
 * Extract the BpmnStepDef from raw job variables.  All reads are defensive
 * (unknown map → typed fields) so a malformed or absent key degrades to the
 * safe default rather than crashing.
 *
 * Convention (bridge encodes these into job.variables at enqueue time):
 *   job.variables.stepName       — string | absent
 *   job.variables.topic          — string | absent (fallback = job.topic param)
 *   job.variables.procKey        — string | absent
 *   job.variables.step_inputs    — string[] | absent   (declared input field keys)
 *   job.variables.step_outputs   — string[] | absent   (declared output field keys)
 *   job.variables.contextHint    — string | absent     (NL hint from configurator)
 *   job.variables.fields         — Record<string,unknown> | absent (form snapshot)
 *
 * @param vars    raw job.variables object
 * @param topic   fallback topic from the job row (always known)
 * @param procKey fallback process key (pre-extracted by readJobVars)
 */
export function readStepDef(
  vars: Record<string, unknown>,
  topic: string,
  procKey: string,
): BpmnStepDef {
  const str = (k: string): string | null => {
    const v = vars[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  const strArr = (k: string): readonly string[] => {
    const v = vars[k];
    if (!Array.isArray(v)) return [];
    return v.filter((item): item is string => typeof item === "string");
  };

  const fields: Record<string, unknown> =
    typeof vars["fields"] === "object" && vars["fields"] !== null
      ? (vars["fields"] as Record<string, unknown>)
      : {};

  return {
    stepName: str("stepName") ?? str("step_name"),
    topic: str("topic") ?? topic,
    procKey: str("procKey") ?? str("proc_key") ?? procKey,
    inputFields: strArr("step_inputs"),
    outputFields: strArr("step_outputs"),
    contextHint: str("contextHint") ?? str("context_hint"),
    fieldValues: fields,
  };
}

// ---------------------------------------------------------------------------
// compileObjective — the F1 compiler (pure, deterministic).
// ---------------------------------------------------------------------------

/** Maximum number of field value characters to include in the prompt. */
const MAX_FIELD_VALUE_CHARS = 200;

/**
 * Render one field entry as "key: value" where value is truncated if long.
 * Pure — safe for the LLM (no secret values, these are user-submitted fields
 * already visible to the process instance).
 */
function renderField(key: string, value: unknown): string {
  const raw = value == null ? "" : String(value);
  const display = raw.length > MAX_FIELD_VALUE_CHARS
    ? raw.slice(0, MAX_FIELD_VALUE_CHARS) + "…"
    : raw;
  return display.length > 0 ? `  ${key}: ${display}` : `  ${key}`;
}

/**
 * Compile a neutral agent-step objective from a structured BPMN step definition
 * and the published competence instruction text.
 *
 * Contract (spec §6 / ADR T-0378 §10 Q2):
 *   - Input:  BpmnStepDef (step name, inputs, outputs, contextHint, fieldValues)
 *             + publishedInstruction (instructionText + answerForm from the DI port)
 *   - Output: CompiledObjective { prompt: string; answerForm: string }
 *
 * The produced `prompt` is threaded into `objective.prompt` on AgentStepContext,
 * which run-agent-step.ts includes in the neutral LlmRequest document block.
 *
 * When `publishedInstruction` is null (absent instruction → no LLM call anyway,
 * gate in run-agent-step.ts), the compiler still returns a non-null prompt from
 * the structural fields alone — this is useful for logging and future probe modes.
 *
 * @param def       structured BPMN step definition (from readStepDef)
 * @param published published instruction result from InstructionSource.readPublished;
 *                  null when the instruction is absent.
 */
export function compileObjective(
  def: BpmnStepDef,
  published: { readonly instructionText: string; readonly answerForm: string | null } | null,
): CompiledObjective {
  const parts: string[] = [];

  // --- Step identity ---
  const stepLabel = def.stepName ?? def.topic;
  parts.push(`Step: ${stepLabel}`);
  parts.push(`Process: ${def.procKey}`);
  parts.push(`Topic: ${def.topic}`);

  // --- Inputs: declared field keys + snapshot values where available ---
  if (def.inputFields.length > 0) {
    parts.push("Inputs:");
    for (const key of def.inputFields) {
      const value = def.fieldValues[key];
      parts.push(renderField(key, value ?? "(not provided)"));
    }
  } else if (Object.keys(def.fieldValues).length > 0) {
    // No declared inputs but there are submitted field values — include them
    // so the LLM has the data context even without a formal schema.
    parts.push("Field values:");
    for (const [key, value] of Object.entries(def.fieldValues)) {
      parts.push(renderField(key, value));
    }
  }

  // --- Outputs: declared output field keys (what the step should produce) ---
  if (def.outputFields.length > 0) {
    parts.push("Outputs expected:");
    for (const key of def.outputFields) {
      parts.push(`  ${key}`);
    }
  }

  // --- Configurator NL context hint (optional) ---
  if (def.contextHint !== null && def.contextHint.length > 0) {
    parts.push(`Additional context: ${def.contextHint}`);
  }

  // --- Published instruction text (the agent's NL competence description) ---
  // Only included in the prompt when present; the motor gate (hasInstruction)
  // already prevents LLM calls when absent, but including it here makes the
  // document self-contained for logging.
  if (published !== null && published.instructionText.length > 0) {
    parts.push(`Instruction: ${published.instructionText}`);
  }

  // Sentinel for completely empty inputs (degenerate case; motor still gates correctly).
  const prompt =
    parts.length > 0
      ? parts.join("\n")
      : "No structured step definition available";

  const answerForm = published?.answerForm ?? "agent_step_v1";

  return { prompt, answerForm };
}
