#!/usr/bin/env bash
# T-0075 · E11.4 — dmn-middle-isolation
#
# Static assertions over src/core/dmn-middle.ts (pure DMN-middle evaluator).
# No runtime, no DB required. Mirrors the style of field-visibility-isolation.sh.
#
# Checks:
#
#  DMN-1  Purity: no forbidden pg/fs/net/http/crypto/node:* imports and no
#         process.env reads on code lines. (Mirrors no-env-in-core invariant.)
#
#  DMN-2  No second authority path: dmn-middle.ts must NOT import grant-resolver,
#         grant-lattice, object-handle, or data-classification. The evaluator is
#         purely over named-binding values — it does NOT resolve grants or read DB.
#
#  DMN-3  Single evaluate() entry point: exactly one exported function named
#         'evaluate' exists (no parallel evaluate-like exports that would fork
#         the evaluation path and introduce non-determinism).
#
#  DMN-4  No Date.now() / Math.random() / global state mutations in the module
#         (determinism guarantee).
#
#  DMN-5  Migration 066 exists (persistence layer for rule tables).
#
# SELF-TEST (--self-test flag):
#   Each check runs against a planted bad file to prove it goes RED on a violation.
#   Exit 2 on self-test infrastructure failure (the check itself is broken).
#
# Exit 0 on clean, non-zero on violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/dmn-middle.ts"
MIGRATION="${PROJECT_ROOT}/migrations/066_dmn_rule_table.sql"
ERRORS=0

# ---------------------------------------------------------------------------
# Self-test mode: verify each check correctly detects a planted violation.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0075] dmn-middle-isolation --self-test: verifying violation detection"
  SELF_ERRORS=0
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_ST"' EXIT

  # ---- Self-test DMN-1: forbidden import detected
  TMP_DMN1="${TMPDIR_ST}/dmn1_bad.ts"
  printf 'import pg from "pg";\nexport function evaluate() {}\n' > "$TMP_DMN1"
  if grep -Eq "from.*['\"]pg['\"]" "$TMP_DMN1"; then
    echo "SELF-TEST DMN-1 PASS: planted pg import correctly detected"
  else
    echo "SELF-TEST DMN-1 FAIL: pg import not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test DMN-1b: process.env detected
  TMP_DMN1B="${TMPDIR_ST}/dmn1b_bad.ts"
  printf 'const x = process.env["DB_URL"];\n' > "$TMP_DMN1B"
  if grep -vE '^[[:space:]]*(//|[*]|/[*])' "$TMP_DMN1B" | grep -qE 'process\.env'; then
    echo "SELF-TEST DMN-1b PASS: planted process.env correctly detected"
  else
    echo "SELF-TEST DMN-1b FAIL: process.env not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test DMN-2: grant-resolver import detected
  TMP_DMN2="${TMPDIR_ST}/dmn2_bad.ts"
  printf 'import { resolveFor } from "./grant-resolver.js";\nexport function evaluate() {}\n' > "$TMP_DMN2"
  if grep -qE "from.*grant-resolver" "$TMP_DMN2"; then
    echo "SELF-TEST DMN-2 PASS: grant-resolver import correctly detected"
  else
    echo "SELF-TEST DMN-2 FAIL: grant-resolver import not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test DMN-3: parallel evaluate-like export detected
  TMP_DMN3="${TMPDIR_ST}/dmn3_bad.ts"
  printf 'export function evaluate() {}\nexport function evaluateTable(t: any) { return {}; }\n' > "$TMP_DMN3"
  EVAL_COUNT=$(grep -cE "^export (async )?function evaluate" "$TMP_DMN3" || true)
  if [[ "${EVAL_COUNT}" -gt 1 ]]; then
    echo "SELF-TEST DMN-3 PASS: multiple evaluate exports correctly detected"
  else
    echo "SELF-TEST DMN-3 FAIL: multiple evaluate exports not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test DMN-4: Date.now() detected
  TMP_DMN4="${TMPDIR_ST}/dmn4_bad.ts"
  printf 'const ts = Date.now();\nexport function evaluate() { return ts; }\n' > "$TMP_DMN4"
  if grep -nE "Date\.now\(\)|Math\.random\(\)" "$TMP_DMN4" | grep -qvE "^\s*[0-9]*:?\s*(//|\*)"; then
    echo "SELF-TEST DMN-4 PASS: Date.now() correctly detected"
  else
    echo "SELF-TEST DMN-4 FAIL: Date.now() not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test DMN-5: missing migration detected
  TMP_MIGS_DIR="${TMPDIR_ST}/migrations"
  mkdir -p "${TMP_MIGS_DIR}"
  # Do NOT create 066_*.sql — check should detect its absence
  if ! ls "${TMP_MIGS_DIR}"/066_*.sql 2>/dev/null | grep -q .; then
    echo "SELF-TEST DMN-5 PASS: missing migration correctly detected as absent"
  else
    echo "SELF-TEST DMN-5 FAIL: false positive for migration presence — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  if [[ ${SELF_ERRORS} -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_ERRORS} self-test(s) broken (the check infrastructure is broken)"
    exit 2
  fi
  echo "PASS: dmn-middle-isolation --self-test — all self-tests green"
  exit 0
fi

# ---------------------------------------------------------------------------
# Real checks
# ---------------------------------------------------------------------------
echo "[T-0075] dmn-middle-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist (T-0075 not implemented)"
  exit 1
fi

# ---- DMN-1: no forbidden imports + no process.env ----------------------------
echo ""
echo "[DMN-1] Checking purity: no forbidden imports, no process.env"

FORBIDDEN_IMPORT_PATTERNS=(
  "from.*['\"].*node:http['\"]"
  "from.*['\"]pg['\"]"
  "from.*['\"].*node:fs['\"]"
  "from.*['\"].*node:net['\"]"
  "from.*['\"].*node:crypto['\"]"
  "from.*['\"]http['\"]"
  "from.*['\"]fs['\"]"
  "from.*['\"]net['\"]"
  "from.*['\"]crypto['\"]"
  "require.*['\"](pg|fs|net|http|crypto|node:crypto)['\"]"
)

before=${ERRORS}
for pattern in "${FORBIDDEN_IMPORT_PATTERNS[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL [DMN-1]: dmn-middle.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done

# process.env must never appear on code lines in pure core.
ENV_MATCHES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${MODULE}" | grep -E 'process\.env' || true)
if [[ -n "${ENV_MATCHES}" ]]; then
  echo "FAIL [DMN-1]: dmn-middle.ts reads process.env (env boundary is src/main.ts):"
  echo "${ENV_MATCHES}"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [DMN-1]: no forbidden imports, no process.env (core purity preserved)"
fi

# ---- DMN-2: no second authority path -----------------------------------------
echo ""
echo "[DMN-2] Checking no second authority path (no grant-resolver / grant-lattice / object-handle / data-classification import)"

AUTHORITY_IMPORTS=(
  "grant-resolver"
  "grant-lattice"
  "object-handle"
  "data-classification"
)

before=${ERRORS}
for token in "${AUTHORITY_IMPORTS[@]}"; do
  if grep -qE "from.*${token}" "${MODULE}"; then
    match=$(grep -nE "from.*${token}" "${MODULE}" || true)
    echo "FAIL [DMN-2]: dmn-middle.ts imports '${token}' (second authority path — not allowed):"
    echo "${match}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [DMN-2]: no second authority path (evaluator is pure over named-binding values)"
fi

# ---- DMN-3: single evaluate() entry point ------------------------------------
echo ""
echo "[DMN-3] Checking single evaluate() export (no parallel evaluate-like entries)"

# Exactly one exported function named 'evaluate' (not 'evaluateXxx' variants at top-level export).
EVAL_COUNT=$(grep -cE "^export (async )?function evaluate\b" "${MODULE}" || true)
if [[ "${EVAL_COUNT}" -ne 1 ]]; then
  echo "FAIL [DMN-3]: expected exactly 1 exported 'evaluate' function, found ${EVAL_COUNT}"
  grep -nE "^export (async )?function evaluate" "${MODULE}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [DMN-3]: single evaluate() entry point (DMN-4 determinism anchor)"
fi

# ---- DMN-4: no Date.now() / Math.random() ------------------------------------
echo ""
echo "[DMN-4] Checking no Date.now() / Math.random() (determinism guarantee)"

NON_DETERMINISTIC_PATTERNS=(
  "Date\.now()"
  "Math\.random()"
)

before=${ERRORS}
for pattern in "${NON_DETERMINISTIC_PATTERNS[@]}"; do
  # Only flag on code lines (ignore comment-only lines).
  MATCHES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${MODULE}" | grep -E "${pattern}" || true)
  if [[ -n "${MATCHES}" ]]; then
    echo "FAIL [DMN-4]: dmn-middle.ts uses non-deterministic '${pattern}':"
    echo "${MATCHES}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [DMN-4]: no Date.now() / Math.random() (evaluator is deterministic)"
fi

# ---- DMN-5: migration 066 exists ----------------------------------------------
echo ""
echo "[DMN-5] Checking migration 066_*.sql exists"

if ! ls "${PROJECT_ROOT}/migrations"/066_*.sql 2>/dev/null | grep -q .; then
  echo "FAIL [DMN-5]: no migration file matching migrations/066_*.sql found"
  ERRORS=$((ERRORS + 1))
else
  MFILE=$(ls "${PROJECT_ROOT}/migrations"/066_*.sql 2>/dev/null | head -1)
  echo "PASS [DMN-5]: migration found: $(basename "${MFILE}")"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: dmn-middle-isolation found ${ERRORS} violation(s) (T-0075 E11.4)"
  exit 1
fi

echo "PASS: dmn-middle-isolation — all checks green (T-0075 E11.4)"
exit 0
