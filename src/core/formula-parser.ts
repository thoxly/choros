/**
 * src/core/formula-parser.ts — T-0580 [D-064 §A8 / К4]
 *
 * Safe scalar-formula PARSER (NF-1 P0): lexer over a CLOSED token alphabet +
 * recursive-descent (Pratt) parser → a FROZEN FormulaAst union. No `eval`, no
 * `new Function`, no `Function(...)`, no `vm`, no dynamic `import()`, no
 * template-literal-to-execution, no prototype/global access whatsoever.
 *
 * WHY THIS IS SAFE (ADR §2.1/§2.5): the lexer only recognizes FIVE token
 * families — NUMBER, IDENT (field reference), `+ - * /`, `( )`, and
 * whitespace. Any OTHER character (`;`, `$`, backtick, `{`, `}`, `[`, `]`,
 * `'`, `"`, `:`, `,`, `!`, a `.` inside/after an identifier, etc.) is a
 * LEXICAL ERROR — the string is rejected before a single AST node exists.
 * This is what closes AC-6 (injection strings like `process.exit(1)`,
 * `require('fs')`, `constructor.constructor(...)`, `a; b`, `${x}`,
 * `__proto__`, `a.b` are all syntactically invalid — `(`, `)`, `.`-in-ident,
 * `'`/quote characters, `;`, `$`, `{`/`}` are simply not in the alphabet, or
 * (for `__proto__`/`process`/`constructor` as bare identifiers) they parse as
 * ordinary FIELD_REF tokens that later resolve to "no such field" → null,
 * NEVER to a prototype-chain or global lookup — see formula-eval.ts's
 * hasOwnProperty-guarded scope lookup).
 *
 * GRAMMAR (ADR §2.1, EBNF):
 *   expr        := term (('+' | '-') term)*
 *   term        := factor (('*' | '/') factor)*
 *   factor      := '-' factor | primary
 *   primary     := NUMBER | FIELD_REF | '(' expr ')'
 *   NUMBER      := /-?[0-9]+(\.[0-9]+)?/        (leading '-' handled by unary factor)
 *   FIELD_REF   := /[A-Za-z_][A-Za-z0-9_]{0,63}/  (mirrors FIELD_KEY_RE, apps-schema.js)
 *
 * Priority: `* /` > `+ -`; left-associative; parentheses override. Unary minus.
 *
 * LIMITS (NF-5, defense-in-depth, enforced HERE at parse time — not relying on
 * authoring-only checks): source length ≤ FORMULA_MAX_LENGTH; REAL AST depth
 * (as measured by astDepth — the exact same walk formula-eval.ts's runtime
 * guard performs) ≤ FORMULA_MAX_DEPTH, checked ONCE on the completed tree
 * (see the post-parse `astDepth(ast) > FORMULA_MAX_DEPTH` check in
 * parseFormula below); FIELD_REF count ≤ FORMULA_MAX_REFS.
 *
 * WHY A SEPARATE RECURSION-FRAME GUARD EXISTS TOO (fix R-1, T-0580 REVIEW):
 * the recursive-descent call chain (expr→term→factor→primary, one extra
 * frame per grammar rule) is NOT the same quantity as AST depth — a single
 * level of *value* nesting costs ~4 GRAMMATICAL frames, but a left-deep chain
 * of N `+` operands costs ~4N grammatical frames while the resulting AST is
 * only N levels deep (recursion in parseExpr/parseTerm's `for(;;)` loops does
 * NOT nest the AST — it walks LEFT-associatively, building `left` iteratively
 * — only parsePrimary's `(`-branch and parseFactor's unary-minus branch
 * actually deepen the tree). Enforcing FORMULA_MAX_DEPTH directly against the
 * grammatical frame counter therefore measures the WRONG quantity: it both
 * (a) FALSELY REJECTS a shallow-AST formula with many parenthesized groups
 * (each paren pair costs 4 grammatical frames but only 1 AST level), and
 * (b) FALSELY ACCEPTS a long flat operand chain that parses fine
 * grammatically (frame count bounded by the length limit long before 32*4)
 * but produces a REAL AST deeper than FORMULA_MAX_DEPTH once every `+`
 * folds — which formula-eval.ts's depth guard then silently nulls at
 * runtime (AC-8/NF-5 violation: "accepted at authoring" must imply
 * "computed at runtime", never silently null-by-depth).
 * `recursionGuard` below is now PURELY an anti-stack-overflow backstop (a
 * generous multiple of FORMULA_MAX_DEPTH, not equal to it) — the actual
 * authoring-time depth CONTRACT is the single post-parse astDepth check.
 *
 * PURITY: no pg, no node:*, no process.env, no network, no eval/Function/vm.
 * Zero-dep (only imports from src/core/formula-contract.ts).
 */

import {
  FORMULA_MAX_LENGTH,
  FORMULA_MAX_DEPTH,
  FORMULA_MAX_REFS,
} from "./formula-contract.js";

// ---------------------------------------------------------------------------
// FormulaAst — the FROZEN union of node kinds (ADR §3). No other node shape
// is ever constructed; the evaluator (formula-eval.ts) exhaustively switches
// over exactly these four kinds.
// ---------------------------------------------------------------------------

export type FormulaAst =
  | { readonly kind: "num"; readonly value: number }
  | { readonly kind: "ref"; readonly field: string }
  | { readonly kind: "unary"; readonly op: "-"; readonly operand: FormulaAst }
  | {
      readonly kind: "binary";
      readonly op: "+" | "-" | "*" | "/";
      readonly left: FormulaAst;
      readonly right: FormulaAst;
    };

export type ParseFormulaError =
  | "empty_expression"
  | "too_long"
  | "lexical_error"
  | "unexpected_token"
  | "unexpected_end_of_input"
  | "unbalanced_parens"
  | "max_depth_exceeded"
  | "max_refs_exceeded";

export type ParseFormulaResult =
  | { ok: true; ast: FormulaAst }
  | { ok: false; error: ParseFormulaError; message: string };

// ---------------------------------------------------------------------------
// Lexer — closed token alphabet
// ---------------------------------------------------------------------------

type TokenKind = "num" | "ident" | "+" | "-" | "*" | "/" | "(" | ")";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

/** FIELD_REF pattern — mirrors FIELD_KEY_RE (web/src/screens/apps-schema.js). */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Tokenize a formula source string over the CLOSED alphabet:
 *   digits, `.`, `+ - * / ( )`, identifier chars `[A-Za-z0-9_]`, whitespace.
 * ANY other character is a lexical error — the caller rejects the whole
 * expression (this is the injection backstop: `;`, `$`, backtick, `{`, `}`,
 * `[`, `]`, quotes, `:`, `,`, `!` are simply outside this alphabet).
 */
function tokenize(src: string): { ok: true; tokens: Token[] } | { ok: false; message: string } {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;

    // Whitespace — skip.
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }

    // Single-character operators/parens.
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "(" || c === ")") {
      tokens.push({ kind: c as TokenKind, text: c });
      i++;
      continue;
    }

    // NUMBER — digits, optional single '.', digits.
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && src[j]! >= "0" && src[j]! <= "9") j++;
      if (j < n && src[j] === ".") {
        j++;
        const fracStart = j;
        while (j < n && src[j]! >= "0" && src[j]! <= "9") j++;
        if (j === fracStart) {
          // A trailing '.' with no fractional digits (e.g. "12.") is a lexical error —
          // NUMBER requires digits after the decimal point (grammar: NUMBER := /-?[0-9]+(\.[0-9]+)?/).
          return { ok: false, message: `malformed number literal at position ${i}: "${src.slice(i, j)}"` };
        }
      }
      tokens.push({ kind: "num", text: src.slice(i, j) });
      i = j;
      continue;
    }

    // IDENT (FIELD_REF) — letter/underscore, then word chars.
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_") {
      let j = i;
      while (
        j < n &&
        ((src[j]! >= "A" && src[j]! <= "Z") ||
          (src[j]! >= "a" && src[j]! <= "z") ||
          (src[j]! >= "0" && src[j]! <= "9") ||
          src[j] === "_")
      ) {
        j++;
      }
      const text = src.slice(i, j);
      // If the char immediately following the identifier run is itself a
      // "word-ish" character not accepted by the loop above (there is none —
      // the loop already consumes every word char), this branch is unreachable
      // for that case. But a `.` immediately after an identifier (e.g. `a.b`,
      // AC-6) is NOT part of the ident alphabet and is NOT a valid next token
      // either (it falls through to the "unknown character" branch below on
      // the NEXT iteration) — i.e. `a.b` lexes as IDENT("a") followed by a
      // lexical error at the `.`, which is exactly the desired rejection.
      tokens.push({ kind: "ident", text });
      i = j;
      continue;
    }

    // Any other character (`;`, `$`, `` ` ``, `{`, `}`, `[`, `]`, `'`, `"`,
    // `:`, `,`, `!`, a stray `.`, etc.) — LEXICAL ERROR. This is the closed-
    // alphabet backstop that makes injection strings unparseable.
    return { ok: false, message: `unexpected character "${c}" at position ${i}` };
  }

  return { ok: true, tokens };
}

// ---------------------------------------------------------------------------
// Parser — recursive-descent (Pratt-shaped) over the token stream.
// ---------------------------------------------------------------------------

class ParseState {
  private pos = 0;
  refCount = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }
}

/** Thrown internally to unwind the recursive descent on a structural error. */
class FormulaSyntaxError extends Error {
  constructor(
    readonly code: ParseFormulaError,
    message: string,
  ) {
    super(message);
  }
}

function parseExpr(state: ParseState, depth: number): FormulaAst {
  assertDepth(depth);
  let left = parseTerm(state, depth + 1);
  for (;;) {
    const tok = state.peek();
    if (tok && (tok.kind === "+" || tok.kind === "-")) {
      state.next();
      const right = parseTerm(state, depth + 1);
      left = { kind: "binary", op: tok.kind, left, right };
    } else {
      break;
    }
  }
  return left;
}

function parseTerm(state: ParseState, depth: number): FormulaAst {
  assertDepth(depth);
  let left = parseFactor(state, depth + 1);
  for (;;) {
    const tok = state.peek();
    if (tok && (tok.kind === "*" || tok.kind === "/")) {
      state.next();
      const right = parseFactor(state, depth + 1);
      left = { kind: "binary", op: tok.kind, left, right };
    } else {
      break;
    }
  }
  return left;
}

function parseFactor(state: ParseState, depth: number): FormulaAst {
  assertDepth(depth);
  const tok = state.peek();
  if (tok && tok.kind === "-") {
    state.next();
    const operand = parseFactor(state, depth + 1);
    return { kind: "unary", op: "-", operand };
  }
  return parsePrimary(state, depth + 1);
}

function parsePrimary(state: ParseState, depth: number): FormulaAst {
  assertDepth(depth);
  const tok = state.next();
  if (!tok) {
    throw new FormulaSyntaxError("unexpected_end_of_input", "unexpected end of formula");
  }
  if (tok.kind === "num") {
    const value = Number(tok.text);
    if (!Number.isFinite(value)) {
      throw new FormulaSyntaxError("unexpected_token", `malformed number literal "${tok.text}"`);
    }
    return { kind: "num", value };
  }
  if (tok.kind === "ident") {
    if (!IDENT_RE.test(tok.text)) {
      // Defensive — the lexer already only emits identifiers matching this
      // shape, but keep the invariant explicit and checked.
      throw new FormulaSyntaxError("lexical_error", `invalid field reference "${tok.text}"`);
    }
    state.refCount++;
    if (state.refCount > FORMULA_MAX_REFS) {
      throw new FormulaSyntaxError(
        "max_refs_exceeded",
        `formula references more than ${FORMULA_MAX_REFS} fields`,
      );
    }
    return { kind: "ref", field: tok.text };
  }
  if (tok.kind === "(") {
    const inner = parseExpr(state, depth + 1);
    const closeTok = state.next();
    if (!closeTok || closeTok.kind !== ")") {
      throw new FormulaSyntaxError("unbalanced_parens", "missing closing parenthesis");
    }
    return inner;
  }
  throw new FormulaSyntaxError("unexpected_token", `unexpected token "${tok.text}"`);
}

/**
 * Anti-stack-overflow backstop ONLY (fix R-1, T-0580 REVIEW) — this is NOT the
 * authoring-time depth contract (that is the post-parse `astDepth(ast) >
 * FORMULA_MAX_DEPTH` check in parseFormula, which measures the SAME quantity
 * formula-eval.ts's runtime guard measures). This counter tracks grammatical
 * recursive-descent FRAMES (expr→term→factor→primary), a strictly larger and
 * differently-shaped quantity than real AST depth (see the module-header note
 * above) — it exists only so a pathological input (e.g. thousands of `(`)
 * cannot exhaust the JS call stack before the length/astDepth checks get a
 * chance to reject it cleanly. Deliberately a large multiple of
 * FORMULA_MAX_DEPTH so it never fires before the real depth contract does.
 */
const RECURSION_FRAME_GUARD = FORMULA_MAX_DEPTH * 8;

function assertDepth(depth: number): void {
  if (depth > RECURSION_FRAME_GUARD) {
    throw new FormulaSyntaxError(
      "max_depth_exceeded",
      `formula is too deeply nested to parse safely`,
    );
  }
}

// ---------------------------------------------------------------------------
// parseFormula — the public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a formula source string into a frozen FormulaAst, or a typed error.
 *
 * Pure — no I/O. Enforces NF-5 limits (length/depth/refs) at parse time as
 * defense-in-depth (the authoring-time gate ALSO enforces these before a
 * schema save is accepted — see formula-typecheck.ts / registry-defs.ts).
 *
 * @param src  the raw formula expression string (e.g. "summa * (1 + nds_rate)").
 */
export function parseFormula(src: string): ParseFormulaResult {
  if (typeof src !== "string" || src.trim().length === 0) {
    return { ok: false, error: "empty_expression", message: "formula expression must be non-empty" };
  }
  if (src.length > FORMULA_MAX_LENGTH) {
    return {
      ok: false,
      error: "too_long",
      message: `formula expression must be at most ${FORMULA_MAX_LENGTH} characters`,
    };
  }

  const lexed = tokenize(src);
  if (!lexed.ok) {
    return { ok: false, error: "lexical_error", message: lexed.message };
  }
  if (lexed.tokens.length === 0) {
    return { ok: false, error: "empty_expression", message: "formula expression must be non-empty" };
  }

  const state = new ParseState(lexed.tokens);
  try {
    const ast = parseExpr(state, 1);
    if (!state.atEnd()) {
      const trailing = state.peek();
      return {
        ok: false,
        error: "unexpected_token",
        message: `unexpected trailing token "${trailing?.text ?? ""}"`,
      };
    }
    // THE authoring-time depth contract (fix R-1, T-0580 REVIEW): measure the
    // REAL AST depth — the exact same quantity formula-eval.ts's runtime
    // depth guard measures (recursion only through unary.operand /
    // binary.left / binary.right) — and reject it here, at authoring time,
    // if it exceeds FORMULA_MAX_DEPTH. This is the ONLY place depth is
    // enforced as a hard authoring contract; the grammatical
    // RECURSION_FRAME_GUARD above is a differently-shaped anti-DoS backstop,
    // not this contract. Invariant this restores: a formula ACCEPTED here is
    // guaranteed to never be null-by-depth at runtime (evalNode's guard can
    // only ever see this same astDepth(ast), which is now ≤ FORMULA_MAX_DEPTH
    // by construction).
    if (astDepth(ast) > FORMULA_MAX_DEPTH) {
      return {
        ok: false,
        error: "max_depth_exceeded",
        message: `formula AST depth exceeds ${FORMULA_MAX_DEPTH}`,
      };
    }
    return { ok: true, ast };
  } catch (err: unknown) {
    if (err instanceof FormulaSyntaxError) {
      return { ok: false, error: err.code, message: err.message };
    }
    // Defensive — should be unreachable (every throw site above uses
    // FormulaSyntaxError), but never let an unexpected exception escape as an
    // uncaught error from a pure parse function.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "unexpected_token", message };
  }
}

/** AST-depth counter — used by formula-eval.ts's defense-in-depth walk guard. */
export function astDepth(ast: FormulaAst): number {
  switch (ast.kind) {
    case "num":
    case "ref":
      return 1;
    case "unary":
      return 1 + astDepth(ast.operand);
    case "binary":
      return 1 + Math.max(astDepth(ast.left), astDepth(ast.right));
    default: {
      // Exhaustiveness guard — FormulaAst is a closed union; this branch is
      // unreachable for well-formed ASTs (defense-in-depth only).
      const _exhaustive: never = ast;
      return 0 * (_exhaustive as unknown as number);
    }
  }
}

/** Collect every distinct field name referenced anywhere in the AST. */
export function collectFieldRefs(ast: FormulaAst): string[] {
  const out = new Set<string>();
  const walk = (node: FormulaAst): void => {
    switch (node.kind) {
      case "num":
        return;
      case "ref":
        out.add(node.field);
        return;
      case "unary":
        walk(node.operand);
        return;
      case "binary":
        walk(node.left);
        walk(node.right);
        return;
      default: {
        const _exhaustive: never = node;
        void _exhaustive;
      }
    }
  };
  walk(ast);
  return [...out];
}
