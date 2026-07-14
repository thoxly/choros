/**
 * T-0075 · E11.4 — DMN-middle: declarative conditional visibility/validation +
 * business rules without code.
 *
 * This module implements the MIDDLE layer of the two-floor authoring model
 * (docs/design/extensibility-and-authoring.md §4):
 *
 *   Floor-1 (JSON-Schema + UI-schema, button-based, zero-LLM)
 *     → Middle (DMN-style decision tables + expression-based visibility/validation)
 *       → Floor-2 (agent-authored React code)
 *
 * What this module does:
 *   Given a set of DmnRuleTable definitions and the current named-binding field
 *   values (the process submission payload), deterministically evaluate:
 *   - Which fields are visible / hidden (per-field override on top of Floor-1)
 *   - Which fields are required / optional (conditional requiredness)
 *   - Which fields have rule-triggered validation errors
 *   - Which routing outcomes fire (named string outcomes → e.g. BPMN gateway vars)
 *
 * Hard invariants (enforced by ci/checks/dmn-middle-isolation.sh):
 *
 *   DMN-1  Purity: no pg / fs / net / http / crypto / node:* imports; no process.env.
 *   DMN-2  No second PDP / no second authority path. This module does NOT resolve
 *          grants, does NOT read from DB, does NOT call resolveFor. It is a pure
 *          transformation OVER the named-binding values; its output is advisory
 *          (visibility/validation policy), not a capability decision.
 *   DMN-3  Deterministic: same (ruleTables, bindings) → same DmnEvalResult every
 *          time. No randomness, no Date.now(), no global state.
 *   DMN-4  Single evaluator: exactly one exported evaluate() function is the entry
 *          point; no parallel evaluate-like exports.
 *   DMN-5  No mutation of process state. The evaluator returns a result; the
 *          caller (HTTP layer / form-validator) applies it. The binding values
 *          are read-only inputs.
 *
 * Named-binding contract:
 *   field-key == variable-name (same contract as Floor-1 / form-schema.ts).
 *   Keys in NamedBindings map directly to field keys in DmnCondition.field and
 *   DmnEffect targets.
 *
 * Rule evaluation semantics (hit-policy: FIRST or COLLECT):
 *   FIRST  — rules are tested in order; the FIRST row whose condition set is
 *             fully satisfied fires its effects; subsequent rows are skipped.
 *   COLLECT — ALL rows whose condition sets are satisfied fire their effects
 *             (effects accumulate; later rows override earlier for same field).
 *
 * Expression operators (DmnOperator):
 *   eq  — equals          (string | number | boolean)
 *   neq — not-equals
 *   gt  — greater-than    (number)
 *   gte — greater-than-or-equal
 *   lt  — less-than
 *   lte — less-than-or-equal
 *   in  — value is in the allowed set (array of string | number)
 *   nin — value is NOT in the set
 *   present — field has a non-null, non-undefined, non-empty-string value
 *   absent  — field is null, undefined, or empty string
 *
 * Sources:
 *   docs/design/extensibility-and-authoring.md §4 (Middle layer)
 *   src/core/field-visibility.ts (T-0081 — single PDP, no parallel authority)
 *   src/core/form-validator.ts   (T-0102 — backend validation pattern)
 *   src/core/floor1-editor.ts    (T-0073 — purity discipline)
 *
 * NOT IMPORTED: pg, fs, net, http, crypto, node:*, process.env,
 *   grant-resolver, grant-lattice, object-handle, data-classification.
 *   (No second authority path, no DB access in pure evaluator.)
 */

// ---------------------------------------------------------------------------
// Types — rule table definition
// ---------------------------------------------------------------------------

/** Supported comparison operators in DMN conditions. */
export type DmnOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "present"
  | "absent";

/**
 * One condition cell: field[operator](value).
 * For `present` / `absent`, `value` is ignored.
 * For `in` / `nin`, `value` must be an array.
 */
export interface DmnCondition {
  readonly field: string;
  readonly operator: DmnOperator;
  readonly value?: unknown;
}

/** Effect types a rule row can produce. */
export type DmnEffectKind =
  | "set_visibility" // show or hide a field
  | "set_required" // override requiredness
  | "add_validation_error" // add a validation message
  | "set_routing_outcome"; // set a named routing variable

/**
 * One effect cell. The semantics per kind:
 *   set_visibility       — { field: string, visible: boolean }
 *   set_required         — { field: string, required: boolean }
 *   add_validation_error — { field: string, message: string }
 *   set_routing_outcome  — { name: string, value: string }
 */
export type DmnEffect =
  | { readonly kind: "set_visibility"; readonly field: string; readonly visible: boolean }
  | { readonly kind: "set_required"; readonly field: string; readonly required: boolean }
  | { readonly kind: "add_validation_error"; readonly field: string; readonly message: string }
  | { readonly kind: "set_routing_outcome"; readonly name: string; readonly value: string };

/**
 * Hit policy:
 *   FIRST   — stop at first matching row (exclusive, first-match wins).
 *   COLLECT — accumulate all matching rows (later rows override for same key).
 */
export type DmnHitPolicy = "FIRST" | "COLLECT";

/** One row in a DMN decision table. */
export interface DmnRule {
  /**
   * All conditions must be satisfied for this row to fire.
   * An empty conditions array always fires (unconditional row).
   */
  readonly conditions: readonly DmnCondition[];
  /** Effects applied when this row fires. */
  readonly effects: readonly DmnEffect[];
  /** Optional human-readable annotation. */
  readonly annotation?: string;
}

/**
 * A named decision table.
 * Multiple tables are evaluated independently in the order supplied to evaluate().
 */
export interface DmnRuleTable {
  /** Stable identifier (matches the DB row id / rule_table_id). */
  readonly id: string;
  /** Human-readable name (for error messages and authoring UI). */
  readonly name: string;
  readonly hitPolicy: DmnHitPolicy;
  readonly rules: readonly DmnRule[];
}

// ---------------------------------------------------------------------------
// Types — named-binding input
// ---------------------------------------------------------------------------

/**
 * Current field values from the named-binding contract.
 * Keys are field-key == variable-name (same contract as form-schema.ts).
 * Values are the raw submitted/current values (string | number | boolean | null | undefined).
 */
export type NamedBindings = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Types — evaluation result
// ---------------------------------------------------------------------------

/**
 * Per-field visibility decision from DMN evaluation.
 * Only fields EXPLICITLY set by a rule are present; absent fields inherit
 * their Floor-1 visibility unchanged.
 */
export type DmnVisibilityMap = Readonly<Record<string, boolean>>;

/**
 * Per-field requiredness overrides from DMN evaluation.
 * Only fields EXPLICITLY set by a rule are present; absent fields inherit
 * their Floor-1 requiredness unchanged.
 */
export type DmnRequirednessMap = Readonly<Record<string, boolean>>;

/** One validation error produced by a rule. */
export interface DmnValidationError {
  readonly field: string;
  readonly message: string;
  /** Which rule table produced this error. */
  readonly tableId: string;
}

/** Named routing outcomes (variable-name → outcome value). */
export type DmnRoutingOutcomes = Readonly<Record<string, string>>;

/**
 * The complete result of evaluating all supplied rule tables against the
 * current named bindings.
 *
 * Contract:
 *  - visibilityOverrides: absent key → Floor-1 default holds; present key overrides.
 *  - requirednessOverrides: same semantics.
 *  - validationErrors: accumulated from all matching rules across all tables.
 *  - routingOutcomes: last-write-wins across all tables (COLLECT) or first-match
 *    (FIRST) per table; cross-table last-write-wins.
 *  - tablesEvaluated: count of tables processed (diagnostic).
 *  - rulesMatched: total count of rules that fired across all tables.
 */
export interface DmnEvalResult {
  readonly visibilityOverrides: DmnVisibilityMap;
  readonly requirednessOverrides: DmnRequirednessMap;
  readonly validationErrors: readonly DmnValidationError[];
  readonly routingOutcomes: DmnRoutingOutcomes;
  readonly tablesEvaluated: number;
  readonly rulesMatched: number;
}

// ---------------------------------------------------------------------------
// Internal helpers — condition evaluation (pure, no IO)
// ---------------------------------------------------------------------------

/** Test whether a single value is "absent" (null, undefined, empty string). */
function isAbsent(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim().length === 0);
}

/** Evaluate one DmnCondition against the current bindings. Returns true if satisfied. */
function evalCondition(cond: DmnCondition, bindings: NamedBindings): boolean {
  const raw = bindings[cond.field];

  switch (cond.operator) {
    case "present":
      return !isAbsent(raw);

    case "absent":
      return isAbsent(raw);

    case "eq":
      return raw === cond.value;

    case "neq":
      return raw !== cond.value;

    case "gt":
      if (typeof raw !== "number" || typeof cond.value !== "number") return false;
      return raw > cond.value;

    case "gte":
      if (typeof raw !== "number" || typeof cond.value !== "number") return false;
      return raw >= cond.value;

    case "lt":
      if (typeof raw !== "number" || typeof cond.value !== "number") return false;
      return raw < cond.value;

    case "lte":
      if (typeof raw !== "number" || typeof cond.value !== "number") return false;
      return raw <= cond.value;

    case "in": {
      if (!Array.isArray(cond.value)) return false;
      return (cond.value as unknown[]).includes(raw);
    }

    case "nin": {
      if (!Array.isArray(cond.value)) return true; // malformed → vacuously not in set
      return !(cond.value as unknown[]).includes(raw);
    }

    default: {
      // Exhaustiveness guard — unknown operator → condition fails (fail-closed).
      return false;
    }
  }
}

/** Test whether ALL conditions in a rule row are satisfied. */
function conditionsSatisfied(conditions: readonly DmnCondition[], bindings: NamedBindings): boolean {
  // Empty conditions array → unconditional row (always fires).
  if (conditions.length === 0) return true;
  return conditions.every((c) => evalCondition(c, bindings));
}

// ---------------------------------------------------------------------------
// Internal helpers — effect application (pure, accumulates into mutable locals)
// ---------------------------------------------------------------------------

function applyEffect(
  effect: DmnEffect,
  tableId: string,
  visMap: Record<string, boolean>,
  reqMap: Record<string, boolean>,
  valErrors: DmnValidationError[],
  routingMap: Record<string, string>,
): void {
  switch (effect.kind) {
    case "set_visibility":
      visMap[effect.field] = effect.visible;
      break;
    case "set_required":
      reqMap[effect.field] = effect.required;
      break;
    case "add_validation_error":
      valErrors.push({ field: effect.field, message: effect.message, tableId });
      break;
    case "set_routing_outcome":
      routingMap[effect.name] = effect.value;
      break;
    default: {
      // Unknown effect kind: ignore (fail-open for effects — do not crash evaluator).
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluator — one table
// ---------------------------------------------------------------------------

/**
 * Evaluate one DmnRuleTable against bindings.
 * Mutates the four accumulator structures (local to evaluate()).
 * Returns the number of rules that fired.
 */
function evalTable(
  table: DmnRuleTable,
  bindings: NamedBindings,
  visMap: Record<string, boolean>,
  reqMap: Record<string, boolean>,
  valErrors: DmnValidationError[],
  routingMap: Record<string, string>,
): number {
  let matched = 0;

  for (const rule of table.rules) {
    if (!conditionsSatisfied(rule.conditions, bindings)) continue;

    // Rule fires: apply all effects.
    for (const effect of rule.effects) {
      applyEffect(effect, table.id, visMap, reqMap, valErrors, routingMap);
    }
    matched += 1;

    // FIRST hit-policy: stop after first matching row.
    if (table.hitPolicy === "FIRST") break;
    // COLLECT: continue to next row.
  }

  return matched;
}

// ---------------------------------------------------------------------------
// Public API — THE single evaluate entry point (DMN-4)
// ---------------------------------------------------------------------------

/**
 * Evaluate all supplied DMN rule tables against the current named bindings.
 *
 * Pure, deterministic, zero-LLM, zero-IO:
 *   - Same (ruleTables, bindings) always yields the same DmnEvalResult.
 *   - No DB access, no process.env, no network, no filesystem.
 *   - Does NOT resolve grants; does NOT fork the PDP.
 *   - Does NOT mutate process state (returns a result; the caller applies it).
 *
 * @param ruleTables  Ordered list of DmnRuleTable definitions.
 * @param bindings    Current named-binding field values (read-only).
 * @returns           DmnEvalResult with per-field overrides and routing outcomes.
 */
export function evaluate(ruleTables: readonly DmnRuleTable[], bindings: NamedBindings): DmnEvalResult {
  const visMap: Record<string, boolean> = {};
  const reqMap: Record<string, boolean> = {};
  const valErrors: DmnValidationError[] = [];
  const routingMap: Record<string, string> = {};

  let totalMatched = 0;

  for (const table of ruleTables) {
    const matched = evalTable(table, bindings, visMap, reqMap, valErrors, routingMap);
    totalMatched += matched;
  }

  return {
    visibilityOverrides: Object.freeze({ ...visMap }),
    requirednessOverrides: Object.freeze({ ...reqMap }),
    validationErrors: Object.freeze([...valErrors]),
    routingOutcomes: Object.freeze({ ...routingMap }),
    tablesEvaluated: ruleTables.length,
    rulesMatched: totalMatched,
  };
}

// ---------------------------------------------------------------------------
// Merge helper — compose DMN result with Floor-1 base visibility/requiredness
// ---------------------------------------------------------------------------

/**
 * Merge DmnEvalResult visibility overrides with the Floor-1 base visibility set.
 *
 * Floor-1 is the source of truth; DMN overrides are layered on top.
 * DMN can only CHANGE visibility for fields that are already defined in the
 * Floor-1 schema — it does not introduce new fields.
 *
 * @param floor1Visible  Set of field keys visible under Floor-1 rules.
 * @param dmnResult      Result from evaluate().
 * @returns              Effective visible set after DMN overrides are applied.
 */
export function mergeVisibility(
  floor1Visible: ReadonlySet<string>,
  dmnResult: Pick<DmnEvalResult, "visibilityOverrides">,
): Set<string> {
  const effective = new Set<string>(floor1Visible);

  for (const [field, visible] of Object.entries(dmnResult.visibilityOverrides)) {
    if (visible) {
      effective.add(field);
    } else {
      effective.delete(field);
    }
  }

  return effective;
}

/**
 * Merge DmnEvalResult requiredness overrides with the Floor-1 base requiredness.
 *
 * @param floor1Required  Set of field keys required under Floor-1 rules.
 * @param dmnResult       Result from evaluate().
 * @returns               Effective required set after DMN overrides are applied.
 */
export function mergeRequiredness(
  floor1Required: ReadonlySet<string>,
  dmnResult: Pick<DmnEvalResult, "requirednessOverrides">,
): Set<string> {
  const effective = new Set<string>(floor1Required);

  for (const [field, required] of Object.entries(dmnResult.requirednessOverrides)) {
    if (required) {
      effective.add(field);
    } else {
      effective.delete(field);
    }
  }

  return effective;
}
