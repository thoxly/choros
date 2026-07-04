/**
 * src/core/formula-eval.ts — T-0580 [D-064 §A8 / К4]
 *
 * Tree-walking INTERPRETER for a parsed+type-checked FormulaAst (ADR §2.5/§3).
 * PURE, deterministic, side-effect-free: no `eval`/`new Function`/`vm`, no
 * clock reads (no today()/now() — O-1/NF-6), no I/O. A single function of
 * (ast, scope) → number | string(ISO date) | null.
 *
 * SCOPE LOOKUP (NF-1 defense-in-depth): FIELD_REF resolution uses
 * `Object.prototype.hasOwnProperty.call(scope, key)` — NEVER a bare
 * `scope[key]` — so an identifier like `__proto__` or `constructor` (which
 * the grammar WOULD accept as an ordinary FIELD_REF token, since the lexer
 * has no notion of "reserved words") resolves through the OWN-PROPERTY check
 * and is treated as "no such field" (→ null) rather than silently walking the
 * prototype chain to `Object.prototype`/`Function` internals. This is the
 * second half of the injection defense (the FIRST half — the closed token
 * alphabet — is in formula-parser.ts; this is the belt to that suspenders).
 *
 * NULL / ERROR SEMANTICS (FR-8, "honest degrade" — same discipline as
 * derived-fields-dao.ts / rollup-contract.ts's computeEmbeddedRollup):
 *   - any null/undefined operand           → whole expression is null
 *     (NEVER coerced to 0 — a blank field must not silently become a zero)
 *   - division by zero (divisor === 0)     → null (never Infinity/NaN/throw)
 *   - a non-numeric value in a number slot → null (never NaN leaking out)
 *   - date arithmetic on a malformed ISO
 *     date string                          → null
 *   Propagation: any null anywhere in a subexpression makes the WHOLE
 *   expression null (a single blank operand poisons the top-level result,
 *   exactly like rollup's "no rows → null, not 0").
 *
 * DATE SEMANTICS (ADR §2.2, exactly two rules — no others exist in v1):
 *   date ± N(days, integer, floor-toward-zero) → date (ISO YYYY-MM-DD)
 *   date − date                                → number (whole days)
 *   Dates are UTC-midnight civil dates (no time-of-day, mirrors x-date's
 *   stored ISO-date-only convention, apps-schema.js:40) — day arithmetic is
 *   done via Date.UTC to avoid any local-timezone drift shifting the
 *   calendar day.
 *
 * DEPTH GUARD (NF-5 defense-in-depth): a recursive walk depth counter — NOT
 * reliance on the JS call stack overflowing "gracefully" — so a maliciously
 * deep AST (bypassing the authoring-time parse limit via direct DB/schema
 * corruption) degrades to null instead of a stack-overflow crash (AC-8).
 *
 * Pure — no I/O. Imports only from formula-parser.js (type + astDepth) and
 * formula-contract.js (FORMULA_MAX_DEPTH).
 */

import type { FormulaAst } from "./formula-parser.js";
import { FORMULA_MAX_DEPTH } from "./formula-contract.js";

/** ISO calendar date pattern (YYYY-MM-DD, no time component — x-date convention). */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A value inside the evaluator's tagged intermediate representation. */
type EvalValue =
  | { readonly tag: "number"; readonly value: number }
  | { readonly tag: "date"; readonly isoDate: string }
  | { readonly tag: "null" };

const NULL_VALUE: EvalValue = { tag: "null" };

/**
 * Evaluate a FormulaAst against a scope (record.data + already-computed
 * non-formula derived values, per ADR §2.4). Returns the final scalar:
 * a finite number, an ISO YYYY-MM-DD date string, or null (FR-8).
 *
 * @param ast    a FormulaAst (already parsed; NOT re-parsed here).
 * @param scope  field-name → raw stored value (record.data ∪ derived overlay).
 */
export function evalFormula(ast: FormulaAst, scope: Record<string, unknown>): number | string | null {
  const result = evalNode(ast, scope, 1);
  if (result.tag === "number") return result.value;
  if (result.tag === "date") return result.isoDate;
  return null;
}

function evalNode(ast: FormulaAst, scope: Record<string, unknown>, depth: number): EvalValue {
  // Defense-in-depth (NF-5/AC-8): a corrupt/oversized AST degrades to null
  // instead of trusting the JS call stack to fail safely.
  if (depth > FORMULA_MAX_DEPTH) return NULL_VALUE;

  switch (ast.kind) {
    case "num":
      return Number.isFinite(ast.value) ? { tag: "number", value: ast.value } : NULL_VALUE;

    case "ref":
      return resolveFieldRef(ast.field, scope);

    case "unary": {
      const operand = evalNode(ast.operand, scope, depth + 1);
      if (operand.tag !== "number") return NULL_VALUE; // null operand OR a date (type error at runtime → null)
      return { tag: "number", value: -operand.value };
    }

    case "binary":
      return evalBinary(ast.op, evalNode(ast.left, scope, depth + 1), evalNode(ast.right, scope, depth + 1));

    default: {
      const _exhaustive: never = ast;
      return _exhaustive;
    }
  }
}

/**
 * Resolve a FIELD_REF against the scope object via an OWN-PROPERTY check
 * (NEVER a bare `scope[key]`) so `__proto__`/`constructor`/`toString` etc. as
 * a field name can never walk the prototype chain — they simply resolve as
 * "field absent" → null, same as any other missing field (NF-1 defense-in-
 * depth; the grammar's closed alphabet is the primary defense).
 */
function resolveFieldRef(field: string, scope: Record<string, unknown>): EvalValue {
  if (scope === null || typeof scope !== "object") return NULL_VALUE;
  if (!Object.prototype.hasOwnProperty.call(scope, field)) return NULL_VALUE;
  const raw = (scope as Record<string, unknown>)[field];
  return coerceScalar(raw);
}

/** Coerce a raw stored scope value into a tagged EvalValue, or null if unusable. */
function coerceScalar(raw: unknown): EvalValue {
  if (raw === null || raw === undefined) return NULL_VALUE;

  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { tag: "number", value: raw } : NULL_VALUE;
  }

  if (typeof raw === "string") {
    // An ISO date string (x-date convention) takes priority over a numeric-
    // looking string — a date field's stored value is always this shape.
    if (ISO_DATE_RE.test(raw)) {
      const utcMs = isoDateToUtcMs(raw);
      return utcMs === null ? NULL_VALUE : { tag: "date", isoDate: raw };
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return NULL_VALUE;
    const n = Number(trimmed);
    return Number.isFinite(n) ? { tag: "number", value: n } : NULL_VALUE;
  }

  // boolean/object/array/etc. — not a usable scalar operand (FR-8 "non-numeric
  // operand in a numeric position → null").
  return NULL_VALUE;
}

function evalBinary(op: "+" | "-" | "*" | "/", left: EvalValue, right: EvalValue): EvalValue {
  if (left.tag === "null" || right.tag === "null") return NULL_VALUE;

  // number ⊕ number
  if (left.tag === "number" && right.tag === "number") {
    switch (op) {
      case "+":
        return numOrNull(left.value + right.value);
      case "-":
        return numOrNull(left.value - right.value);
      case "*":
        return numOrNull(left.value * right.value);
      case "/":
        // Division by zero → null (FR-8: never Infinity/NaN/throw).
        if (right.value === 0) return NULL_VALUE;
        return numOrNull(left.value / right.value);
    }
  }

  // date ± number(days) → date
  if (left.tag === "date" && right.tag === "number" && (op === "+" || op === "-")) {
    const days = Math.trunc(right.value); // floor-toward-zero, integer days (FR-4)
    const utcMs = isoDateToUtcMs(left.isoDate);
    if (utcMs === null) return NULL_VALUE;
    const deltaMs = days * 86_400_000 * (op === "-" ? -1 : 1);
    const resultIso = utcMsToIsoDate(utcMs + deltaMs);
    return resultIso === null ? NULL_VALUE : { tag: "date", isoDate: resultIso };
  }

  // date − date → number(days)
  if (left.tag === "date" && right.tag === "date" && op === "-") {
    const leftMs = isoDateToUtcMs(left.isoDate);
    const rightMs = isoDateToUtcMs(right.isoDate);
    if (leftMs === null || rightMs === null) return NULL_VALUE;
    const diffDays = Math.round((leftMs - rightMs) / 86_400_000);
    return numOrNull(diffDays);
  }

  // Any other date combination (date+date, date*number, date/number, number-date,
  // number*date, etc.) is a TYPE ERROR at authoring time (formula-typecheck.ts) —
  // if one somehow reaches runtime anyway (corrupt/legacy schema bypassing the
  // authoring gate), degrade honestly to null rather than producing nonsense.
  return NULL_VALUE;
}

function numOrNull(n: number): EvalValue {
  return Number.isFinite(n) ? { tag: "number", value: n } : NULL_VALUE;
}

/** Parse an ISO YYYY-MM-DD date string to UTC-midnight epoch ms, or null if invalid. */
function isoDateToUtcMs(iso: string): number | null {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  // Reject "overflowed" dates (e.g. 2026-02-30 → JS normalizes to March 2) —
  // an honest formula must not silently roll a bad calendar date forward.
  const rebuilt = new Date(ms);
  if (
    rebuilt.getUTCFullYear() !== year ||
    rebuilt.getUTCMonth() !== month - 1 ||
    rebuilt.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

/** Format a UTC-midnight epoch ms value back to an ISO YYYY-MM-DD date string. */
function utcMsToIsoDate(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < 0 || year > 9999) return null; // guard against pathological far-future/past inputs
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${month}-${day}`;
}
