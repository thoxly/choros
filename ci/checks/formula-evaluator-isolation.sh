#!/usr/bin/env bash
# T-0580 [D-064 §A8 / К4] · formula-evaluator-isolation
#
# Static assertions over the scalar-formula evaluator core (src/core/formula-*.ts):
# NF-1 (safe-evaluator / injection = P0) + NF-3 (core purity, zero-dep). Mirrors
# the purity-discipline of cross-app-refs-isolation.sh / no-env-in-core.sh /
# keyed-digest-core-purity.sh.
#
# FF-1 — Safety denylist (P0): none of src/core/formula-*.ts contain eval(,
#        new Function, Function(, require(, import(, a bare `vm` token,
#        process., globalThis, __proto__, child_process, constructor.constructor,
#        or a backtick template used AS AN EXECUTED EXPRESSION — i.e. a
#        template literal immediately invoked as a function (`` `...`(...) ``,
#        the "template-tag-as-code" / tagged-template-abuse shape) — NOT a
#        plain template literal used for an error message (`` `field ${x}` ``
#        interpolated into a string is ordinary, safe string-building; this
#        module's error messages legitimately use them). Comment-only mentions
#        (explaining the ban) are EXEMPT — same comment-strip convention as
#        no-env-in-core.sh (a line whose first non-space chars are //, *, or
#        /* is not scanned).
#
# FF-2 — Core purity / import boundary: formula-*.ts does NOT import `pg`,
#        any `node:*` builtin, and does not read `process.env`. Every relative
#        import resolves to another src/core/ sibling (never src/db/, src/http/,
#        web/) — mirrors cross-app-refs-isolation.sh's CA1 (no forbidden
#        imports) applied to the whole formula-* file set instead of one module.
#
# --self-test: plants a violation for EACH denylist token (one file per token,
#   so a single bad match doesn't mask detection of the others) and asserts the
#   detector fires; plants a comment-only mention and asserts it is NOT flagged;
#   plants a forbidden `pg` import and a cross-boundary `../db/` import and
#   asserts both are caught. Exit 2 if any self-test assertion fails (check
#   itself would be broken).
#
# Exit 0 on clean, 1 on a real violation, 2 on self-test/infra failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CORE_DIR="${PROJECT_ROOT}/src/core"

# The formula-* module family this check owns (T-0580 §3 object model).
FORMULA_FILES=(
  "formula-contract.ts"
  "formula-parser.ts"
  "formula-typecheck.ts"
  "formula-cycles.ts"
  "formula-eval.ts"
  "formula-schema-gate.ts"
)

# Denylist patterns (FF-1, ADR §2.1/§2.5/FF-1). Each is a grep -E pattern.
DENYLIST_PATTERNS=(
  'eval\('
  'new[[:space:]]+Function'
  '[^a-zA-Z_.]Function\('
  'require\('
  'import\('
  '\bvm\b'
  'process\.'
  'globalThis'
  '__proto__'
  'child_process'
  'constructor\.constructor'
  '`[^`]*`\('
)

# ---------------------------------------------------------------------------
# strip_comments <file> — emit only CODE lines (first non-space chars not
# //, *, or /*) — same convention as no-env-in-core.sh / keyed-digest-core-
# purity.sh. Grep exit 1 (no code lines / all blank) is not an error here.
# ---------------------------------------------------------------------------
strip_comments() {
  grep -vE '^[[:space:]]*(//|[*]|/[*])' "$1" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Self-test mode.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0580] formula-evaluator-isolation --self-test"
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT
  SELF_ERRORS=0

  # ---- FF-1: each denylist token, planted on a CODE line, must be detected.
  declare -a PLANT_SAMPLES=(
    'const x = eval("1+1");'
    'const f = new Function("return 1");'
    'const g = Function("return 1");'
    'const m = require("fs");'
    'const p = import("node:fs");'
    'const v = vm.createContext({});'
    'const e = process.env.SECRET;'
    'const gt = globalThis.Buffer;'
    'const proto = obj.__proto__;'
    'const cp = child_process.exec("ls");'
    'const hack = ({}).constructor.constructor("return 1")();'
    'const tpl = `return ${name}`();'
  )
  idx=0
  for sample in "${PLANT_SAMPLES[@]}"; do
    idx=$((idx + 1))
    plant="${TMPDIR_ST}/plant_${idx}.ts"
    printf '%s\n' "${sample}" > "${plant}"
    fired=0
    code_lines="$(strip_comments "${plant}")"
    for pattern in "${DENYLIST_PATTERNS[@]}"; do
      if printf '%s\n' "${code_lines}" | grep -Eq "${pattern}"; then
        fired=1
        break
      fi
    done
    if [[ ${fired} -ne 1 ]]; then
      echo "SELF-TEST FAIL: planted sample #${idx} ('${sample}') was NOT detected by any denylist pattern"
      SELF_ERRORS=$((SELF_ERRORS + 1))
    fi
  done
  if [[ ${SELF_ERRORS} -eq 0 ]]; then
    echo "PASS self-test: all ${#PLANT_SAMPLES[@]} denylist tokens correctly detected on code lines"
  fi

  # ---- FF-1 negative: an ORDINARY template literal used for a message string
  # (interpolation, no invocation) must NOT fire — this is normal, safe code
  # (every formula-*.ts file legitimately builds error messages this way).
  msg_plant="${TMPDIR_ST}/msg_ok.ts"
  printf 'const message = `formula references unknown field "${field}"`;\n' > "${msg_plant}"
  msg_code_lines="$(strip_comments "${msg_plant}")"
  msg_fired=0
  for pattern in "${DENYLIST_PATTERNS[@]}"; do
    if printf '%s\n' "${msg_code_lines}" | grep -Eq "${pattern}"; then
      msg_fired=1
      break
    fi
  done
  if [[ ${msg_fired} -ne 0 ]]; then
    echo "SELF-TEST FAIL: an ordinary error-message template literal was incorrectly flagged (false positive)"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  else
    echo "PASS self-test: ordinary error-message template literals correctly NOT flagged"
  fi

  # ---- FF-1 negative: a comment-only mention must NOT fire.
  comment_plant="${TMPDIR_ST}/comment_ok.ts"
  printf '// never calls eval( here, and never new Function either\n// process.env is not read in this module\n' > "${comment_plant}"
  comment_code_lines="$(strip_comments "${comment_plant}")"
  comment_fired=0
  for pattern in "${DENYLIST_PATTERNS[@]}"; do
    if printf '%s\n' "${comment_code_lines}" | grep -Eq "${pattern}"; then
      comment_fired=1
      break
    fi
  done
  if [[ ${comment_fired} -ne 0 ]]; then
    echo "SELF-TEST FAIL: comment-only mention incorrectly flagged (false positive)"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  else
    echo "PASS self-test: comment-only denylist mentions correctly ignored"
  fi

  # ---- FF-2: forbidden `pg` import detected.
  pg_plant="${TMPDIR_ST}/pg_bad.ts"
  printf 'import pg from "pg";\nexport function foo() {}\n' > "${pg_plant}"
  if grep -Eq 'from[[:space:]]+"pg"|from[[:space:]]+'"'"'pg'"'"'' "${pg_plant}"; then
    echo "PASS self-test: planted pg import correctly detected"
  else
    echo "SELF-TEST FAIL: planted pg import NOT detected — FF-2 import scan is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- FF-2: forbidden node:* import detected.
  node_plant="${TMPDIR_ST}/node_bad.ts"
  printf 'import { readFileSync } from "node:fs";\n' > "${node_plant}"
  if grep -Eq 'from[[:space:]]+"node:' "${node_plant}"; then
    echo "PASS self-test: planted node:* import correctly detected"
  else
    echo "SELF-TEST FAIL: planted node:fs import NOT detected — FF-2 import scan is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- FF-2: cross-boundary import (../db/, ../http/) detected.
  cross_plant="${TMPDIR_ST}/cross_bad.ts"
  printf 'import { computeAllDerivedFields } from "../db/derived-fields-dao.js";\n' > "${cross_plant}"
  if grep -Eq 'from[[:space:]]+"\.\./db/|from[[:space:]]+"\.\./http/' "${cross_plant}"; then
    echo "PASS self-test: planted cross-boundary import (../db/) correctly detected"
  else
    echo "SELF-TEST FAIL: planted ../db/ import NOT detected — FF-2 boundary scan is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  if [[ ${SELF_ERRORS} -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_ERRORS} self-test assertion(s) broken (check infrastructure is broken)"
    exit 2
  fi
  echo "PASS: formula-evaluator-isolation --self-test — all self-tests green"
  exit 0
fi

# ---------------------------------------------------------------------------
# Production check.
# ---------------------------------------------------------------------------
echo "[T-0580] formula-evaluator-isolation: checking src/core/formula-*.ts"

ERRORS=0
FOUND_ANY=0

for fname in "${FORMULA_FILES[@]}"; do
  target="${CORE_DIR}/${fname}"
  if [[ ! -f "${target}" ]]; then
    continue
  fi
  FOUND_ANY=1

  # ---- FF-1: denylist scan on code lines only ----
  code_lines="$(strip_comments "${target}")"
  for pattern in "${DENYLIST_PATTERNS[@]}"; do
    matches="$(printf '%s\n' "${code_lines}" | grep -nE "${pattern}" || true)"
    if [[ -n "${matches}" ]]; then
      echo "FAIL [FF-1]: ${fname} contains a denylisted pattern (${pattern}):"
      echo "${matches}"
      ERRORS=$((ERRORS + 1))
    fi
  done

  # ---- FF-2: forbidden imports (pg, node:*) ----
  forbidden_import_matches="$(grep -nE 'from[[:space:]]+"(pg|node:[a-z/]+)"|from[[:space:]]+'"'"'(pg|node:[a-z/]+)'"'"'' "${target}" 2>/dev/null || true)"
  if [[ -n "${forbidden_import_matches}" ]]; then
    echo "FAIL [FF-2]: ${fname} imports a forbidden module (pg/node:*):"
    echo "${forbidden_import_matches}"
    ERRORS=$((ERRORS + 1))
  fi

  # ---- FF-2: process.env read (redundant with FF-1's process. pattern, but
  # this specific message is clearer for the env-boundary violation class) ----
  env_matches="$(printf '%s\n' "${code_lines}" | grep -nE 'process\.env' || true)"
  if [[ -n "${env_matches}" ]]; then
    echo "FAIL [FF-2]: ${fname} reads process.env (core purity violation):"
    echo "${env_matches}"
    ERRORS=$((ERRORS + 1))
  fi

  # ---- FF-2: every relative import resolves within src/core/ (no ../db/,
  # ../http/, ../../web/, etc.) ---- grep -E has no portable negative
  # lookahead across BSD/GNU, so this is a two-step filter instead: find all
  # relative parent-imports, then drop the ones that stay under ../core/.
  relative_parent_imports="$(grep -nE 'from[[:space:]]+"\.\./|from[[:space:]]+'"'"'\.\./' "${target}" 2>/dev/null || true)"
  if [[ -n "${relative_parent_imports}" ]]; then
    non_core_imports="$(printf '%s\n' "${relative_parent_imports}" | grep -vE '\.\./core/' || true)"
    if [[ -n "${non_core_imports}" ]]; then
      echo "FAIL [FF-2]: ${fname} imports from outside src/core/ (cross-boundary):"
      echo "${non_core_imports}"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done

if [[ ${FOUND_ANY} -eq 0 ]]; then
  echo "FAIL: none of the expected src/core/formula-*.ts files exist (T-0580 not implemented)"
  exit 1
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: formula-evaluator-isolation found ${ERRORS} violation(s) (T-0580 NF-1/NF-3)"
  exit 1
fi

echo "PASS: formula-evaluator-isolation — no eval/Function/vm/env/cross-boundary violations (T-0580)"
exit 0
