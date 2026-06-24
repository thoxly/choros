/**
 * src/core/dmn-rule-table-validate.ts — T-0433
 *
 * PURE validator for DMN rule table authoring input.
 * No IO, no DB, no pg, no process.env — purity discipline identical to
 * dmn-middle.ts and binding-compat.ts.
 *
 * Purpose: validate user-supplied DMN rule table definitions BEFORE they are
 * persisted to choros.dmn_rule_table (via upsertRuleTableDraft). Returns named
 * violations so the HTTP layer can return a structured 400 body.
 *
 * First-increment constraints (FIRST hit-policy only):
 *   - hitPolicy must be 'FIRST' (COLLECT support is a future increment)
 *   - Each condition operator must be in the DmnOperator union
 *   - Each rule must have at least one set_routing_outcome effect
 *   - All set_routing_outcome effects across the table must share a single
 *     outcome name (consistent routing variable — prevents branching ambiguity)
 *   - name must be a non-empty string
 *   - rules array must be non-empty
 *
 * Mirrors the style of validateBindingFields (binding-compat.ts) and returns
 * { ok: true, value } | { ok: false, violations: DmnRuleTableViolation[] }.
 *
 * NOT IMPORTED: pg, fs, net, http, crypto, node:*, process.env.
 */

import type { DmnRuleTable, DmnOperator } from "./dmn-middle.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Named violation keys returned by validateDmnRuleTable. */
export type DmnRuleTableViolationCode =
  | "NAME_EMPTY"
  | "HIT_POLICY_UNSUPPORTED"
  | "RULES_EMPTY"
  | "UNKNOWN_OPERATOR"
  | "MISSING_ROUTING_OUTCOME"
  | "INCONSISTENT_ROUTING_NAME";

export interface DmnRuleTableViolation {
  /** Stable code for programmatic handling. */
  readonly code: DmnRuleTableViolationCode;
  /** Human-readable explanation. */
  readonly message: string;
  /** Optional: 0-based rule index that triggered this violation. */
  readonly ruleIndex?: number;
}

export type DmnRuleTableValidationResult =
  | { readonly ok: true; readonly value: DmnRuleTable }
  | { readonly ok: false; readonly violations: DmnRuleTableViolation[] };

// ---------------------------------------------------------------------------
// Valid operator set — kept in sync with DmnOperator union from dmn-middle.ts.
// ---------------------------------------------------------------------------

const VALID_OPERATORS: ReadonlySet<string> = new Set<DmnOperator>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "present",
  "absent",
]);

// ---------------------------------------------------------------------------
// validateDmnRuleTable — main exported pure function
// ---------------------------------------------------------------------------

/**
 * Validates a DMN rule table authoring input.
 *
 * @param input Any input from the HTTP body (untrusted).
 * @returns { ok: true, value } if valid (value is the typed DmnRuleTable),
 *          { ok: false, violations } with one or more named violations otherwise.
 *
 * Pure: no IO, no DB, no side-effects.
 */
export function validateDmnRuleTable(
  input: unknown,
): DmnRuleTableValidationResult {
  const violations: DmnRuleTableViolation[] = [];

  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    violations.push({
      code: "NAME_EMPTY",
      message: "input must be a plain object",
    });
    return { ok: false, violations };
  }

  const obj = input as Record<string, unknown>;

  // ---- name ----------------------------------------------------------------
  const name = obj["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    violations.push({
      code: "NAME_EMPTY",
      message: "name must be a non-empty string",
    });
  }

  // ---- hitPolicy -----------------------------------------------------------
  const hitPolicy = obj["hitPolicy"];
  if (hitPolicy !== "FIRST") {
    violations.push({
      code: "HIT_POLICY_UNSUPPORTED",
      message: `hitPolicy must be 'FIRST' (got: ${JSON.stringify(hitPolicy)}); COLLECT is not supported in this increment`,
    });
  }

  // ---- rules ---------------------------------------------------------------
  const rules = obj["rules"];
  if (!Array.isArray(rules) || rules.length === 0) {
    violations.push({
      code: "RULES_EMPTY",
      message: "rules must be a non-empty array",
    });
    // Cannot validate individual rules without the array — return early.
    if (violations.length > 0) {
      return { ok: false, violations };
    }
  }

  // ---- Per-rule validation -------------------------------------------------
  // Track all routing-outcome names to enforce single-name consistency.
  const routingNames = new Set<string>();

  if (Array.isArray(rules)) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
        violations.push({
          code: "RULES_EMPTY",
          message: `rules[${i}] must be a plain object`,
          ruleIndex: i,
        });
        continue;
      }
      const ruleObj = rule as Record<string, unknown>;

      // Validate conditions[].operator
      const conditions = ruleObj["conditions"];
      if (Array.isArray(conditions)) {
        for (let j = 0; j < conditions.length; j++) {
          const cond = conditions[j];
          if (cond === null || typeof cond !== "object" || Array.isArray(cond)) {
            continue; // structural error; not an operator error
          }
          const condObj = cond as Record<string, unknown>;
          const op = condObj["operator"];
          if (typeof op === "string" && !VALID_OPERATORS.has(op)) {
            violations.push({
              code: "UNKNOWN_OPERATOR",
              message: `rules[${i}].conditions[${j}].operator '${op}' is not a valid DmnOperator. Valid operators: ${[...VALID_OPERATORS].join(", ")}`,
              ruleIndex: i,
            });
          }
        }
      }

      // Validate effects: at least one set_routing_outcome per rule
      const effects = ruleObj["effects"];
      if (!Array.isArray(effects)) {
        violations.push({
          code: "MISSING_ROUTING_OUTCOME",
          message: `rules[${i}].effects must be a non-empty array containing at least one set_routing_outcome effect`,
          ruleIndex: i,
        });
        continue;
      }

      const routingEffects = effects.filter(
        (e) =>
          e !== null &&
          typeof e === "object" &&
          !Array.isArray(e) &&
          (e as Record<string, unknown>)["kind"] === "set_routing_outcome",
      );

      if (routingEffects.length === 0) {
        violations.push({
          code: "MISSING_ROUTING_OUTCOME",
          message: `rules[${i}] has no set_routing_outcome effect; every rule must route to an outcome`,
          ruleIndex: i,
        });
      }

      // Collect routing outcome names
      for (const eff of routingEffects) {
        const effObj = eff as Record<string, unknown>;
        const outcomeName = effObj["name"];
        if (typeof outcomeName === "string" && outcomeName.length > 0) {
          routingNames.add(outcomeName);
        }
      }
    }
  }

  // ---- Routing-outcome name consistency ------------------------------------
  // All rules in this table must use the same routing-outcome name.
  if (routingNames.size > 1) {
    violations.push({
      code: "INCONSISTENT_ROUTING_NAME",
      message: `all set_routing_outcome effects in the table must share a single name; found multiple: ${[...routingNames].join(", ")}`,
    });
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }

  // ---- Build typed value ---------------------------------------------------
  // We trust the structural shape is valid (validated above) and cast.
  const value: DmnRuleTable = {
    id: typeof obj["id"] === "string" ? obj["id"] : "",
    name: (name as string).trim(),
    hitPolicy: "FIRST",
    rules: (rules as unknown[]).map((r) => {
      const ruleObj = r as Record<string, unknown>;
      return {
        conditions: Array.isArray(ruleObj["conditions"])
          ? (ruleObj["conditions"] as unknown[]).map((c) => {
              const co = c as Record<string, unknown>;
              return {
                field: co["field"] as string,
                operator: co["operator"] as DmnOperator,
                ...(co["value"] !== undefined ? { value: co["value"] } : {}),
              };
            })
          : [],
        effects: Array.isArray(ruleObj["effects"])
          ? (ruleObj["effects"] as unknown[]).map((e) => e as DmnRuleTable["rules"][number]["effects"][number])
          : [],
        ...(typeof ruleObj["annotation"] === "string"
          ? { annotation: ruleObj["annotation"] }
          : {}),
      };
    }),
  };

  return { ok: true, value };
}
