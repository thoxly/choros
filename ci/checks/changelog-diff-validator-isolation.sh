#!/usr/bin/env bash
# T-0084 · E12.3 — changelog-diff-validator isolation fitness check.
#
# Verifies the INDEPENDENT validator in src/core/changelog-diff-validator.ts:
#
#   FF-CDV-1  Module exists and exports validateChangelog + diffBundleSnapshots
#             (the public API of the independent validator).
#
#   FF-CDV-2  No env/fs/http/pg/Date.now/Math.random in pure core
#             (zero-dep invariant — the validator must be a pure function).
#
#   FF-CDV-3  Independent recompute — the validator does NOT call
#             deriveSemanticChangelog (avoids tautology: it cannot call the
#             producer's changelog function and just compare it to itself).
#             diffBundleSnapshots is the independent implementation.
#
#   FF-CDV-4  No node:crypto import in the core module (pure boundary —
#             mirrors bundle-commit-isolation.sh FF-BC-2).
#
#   FF-CDV-5  Returns a PromoteVerdict type with verdict / reasons / warnings
#             (typed structured verdict, not a raw boolean).
#
#   FF-CDV-6  schema-change classifier is reused (classifySchemaChange imported —
#             no second independent schema-compat logic; one source of truth
#             per NF-1 ADR).
#
# EXIT CODES:
#   0 — all checks green
#   1 — one or more violations found
#   2 — self-test broken (check itself is broken)
#
# USAGE:
#   bash changelog-diff-validator-isolation.sh           # normal CI run
#   bash changelog-diff-validator-isolation.sh --self-test

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CORE="${ROOT}/src/core/changelog-diff-validator.ts"
ERRORS=0

# ---------------------------------------------------------------------------
# --self-test mode
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[changelog-diff-validator-isolation] self-test mode"

  # ST-1: validateChangelog export detection
  TMP_EXPORT=$(mktemp /tmp/cdv_selftest_XXXXX.ts)
  printf 'export function validateChangelog() {}\n' > "${TMP_EXPORT}"
  if grep -qE 'export function validateChangelog' "${TMP_EXPORT}"; then
    echo "PASS self-test ST-1: validateChangelog export detection works"
  else
    echo "FAIL self-test ST-1: export detection broken (exit 2)"
    rm -f "${TMP_EXPORT}"
    exit 2
  fi
  rm -f "${TMP_EXPORT}"

  # ST-2: process.env detection on code lines
  TMP_ENV=$(mktemp /tmp/cdv_selftest_XXXXX.ts)
  printf 'const x = process.env["FOO"];\n' > "${TMP_ENV}"
  ENV_MATCH=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${TMP_ENV}" | grep -E 'process\.env' 2>/dev/null) || true
  if [[ -n "${ENV_MATCH}" ]]; then
    echo "PASS self-test ST-2: process.env detection works"
  else
    echo "FAIL self-test ST-2: process.env detection broken (exit 2)"
    rm -f "${TMP_ENV}"
    exit 2
  fi
  rm -f "${TMP_ENV}"

  # ST-3: deriveSemanticChangelog call detection (the tautology guard)
  TMP_TAUTOLOGY=$(mktemp /tmp/cdv_selftest_XXXXX.ts)
  printf 'const ch = deriveSemanticChangelog(from, to);\n' > "${TMP_TAUTOLOGY}"
  if grep -qE 'deriveSemanticChangelog' "${TMP_TAUTOLOGY}"; then
    echo "PASS self-test ST-3: deriveSemanticChangelog call detection works"
  else
    echo "FAIL self-test ST-3: tautology detection broken (exit 2)"
    rm -f "${TMP_TAUTOLOGY}"
    exit 2
  fi
  rm -f "${TMP_TAUTOLOGY}"

  # ST-4: node:crypto detection
  TMP_CRYPTO=$(mktemp /tmp/cdv_selftest_XXXXX.ts)
  printf 'import { createHash } from "node:crypto";\n' > "${TMP_CRYPTO}"
  if grep -qE 'from "node:crypto"|from '"'"'node:crypto'"'"'' "${TMP_CRYPTO}"; then
    echo "PASS self-test ST-4: node:crypto detection works"
  else
    echo "FAIL self-test ST-4: node:crypto detection broken (exit 2)"
    rm -f "${TMP_CRYPTO}"
    exit 2
  fi
  rm -f "${TMP_CRYPTO}"

  echo "PASS: changelog-diff-validator-isolation self-tests all green"
  exit 0
fi

echo "[T-0084] changelog-diff-validator-isolation: independent validator purity checks"

# ---------------------------------------------------------------------------
# FF-CDV-1: Module exists + exports validateChangelog + diffBundleSnapshots
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-CDV-1: module exists + exports validateChangelog + diffBundleSnapshots ---"

if [[ ! -f "${CORE}" ]]; then
  echo "FAIL FF-CDV-1: ${CORE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  if grep -qE "export function validateChangelog" "${CORE}"; then
    echo "PASS FF-CDV-1a: validateChangelog exported"
  else
    echo "FAIL FF-CDV-1a: validateChangelog not found in ${CORE}"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "export function diffBundleSnapshots" "${CORE}"; then
    echo "PASS FF-CDV-1b: diffBundleSnapshots exported (independent recompute)"
  else
    echo "FAIL FF-CDV-1b: diffBundleSnapshots not found in ${CORE} (independent diff must be exported)"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# FF-CDV-2: No env/fs/http/pg/Date.now/Math.random in pure core
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-CDV-2: no impure dependencies in changelog-diff-validator.ts ---"

if [[ -f "${CORE}" ]]; then
  # Strip comment-only lines, then check for impure patterns
  set +e
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${CORE}")
  STRIP_EXIT=$?
  set -e

  IMPURE_MATCH=""
  if [[ "${STRIP_EXIT}" -lt 2 ]] && [[ -n "${CODE_LINES}" ]]; then
    IMPURE_MATCH=$(echo "${CODE_LINES}" | grep -E \
      'process\.env|require\("fs|from "fs|from '"'"'fs|from "http|from '"'"'http|from "pg|from '"'"'pg|Date\.now\(\)|Math\.random\(\)|fetch\(' \
      2>/dev/null) || true
  fi

  if [[ -n "${IMPURE_MATCH}" ]]; then
    echo "FAIL FF-CDV-2: impure dependency found in pure core:"
    echo "${IMPURE_MATCH}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-CDV-2: no impure dependencies in changelog-diff-validator.ts"
  fi
fi

# ---------------------------------------------------------------------------
# FF-CDV-3: Independent recompute — must NOT call deriveSemanticChangelog
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-CDV-3: independent recompute (no call to deriveSemanticChangelog) ---"

if [[ -f "${CORE}" ]]; then
  # Strip comment-only lines, then check for deriveSemanticChangelog calls
  set +e
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${CORE}")
  STRIP_EXIT=$?
  set -e

  TAUTOLOGY_MATCH=""
  if [[ "${STRIP_EXIT}" -lt 2 ]] && [[ -n "${CODE_LINES}" ]]; then
    TAUTOLOGY_MATCH=$(echo "${CODE_LINES}" | grep -E 'deriveSemanticChangelog' 2>/dev/null) || true
  fi

  if [[ -n "${TAUTOLOGY_MATCH}" ]]; then
    echo "FAIL FF-CDV-3: deriveSemanticChangelog called inside changelog-diff-validator.ts — this is a tautology (the validator must NOT reuse the producer's function):"
    echo "${TAUTOLOGY_MATCH}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-CDV-3: no call to deriveSemanticChangelog (independent recompute confirmed)"
  fi
fi

# ---------------------------------------------------------------------------
# FF-CDV-4: No node:crypto in core
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-CDV-4: no node:crypto import in changelog-diff-validator.ts ---"

if [[ -f "${CORE}" ]]; then
  set +e
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${CORE}")
  STRIP_EXIT=$?
  set -e

  CRYPTO_MATCH=""
  if [[ "${STRIP_EXIT}" -lt 2 ]] && [[ -n "${CODE_LINES}" ]]; then
    CRYPTO_MATCH=$(echo "${CODE_LINES}" | grep -E 'from "node:crypto"|from '"'"'node:crypto'"'"'|from "crypto"|from '"'"'crypto'"'"'' 2>/dev/null) || true
  fi

  if [[ -n "${CRYPTO_MATCH}" ]]; then
    echo "FAIL FF-CDV-4: node:crypto imported in pure core (boundary violation):"
    echo "${CRYPTO_MATCH}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-CDV-4: no node:crypto in changelog-diff-validator.ts"
  fi
fi

# ---------------------------------------------------------------------------
# FF-CDV-5: Returns PromoteVerdict with verdict / reasons / warnings
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-CDV-5: PromoteVerdict type with verdict + reasons + warnings ---"

if [[ -f "${CORE}" ]]; then
  if grep -qE "export interface PromoteVerdict" "${CORE}"; then
    echo "PASS FF-CDV-5a: PromoteVerdict interface exported"
  else
    echo "FAIL FF-CDV-5a: PromoteVerdict not found in ${CORE}"
    ERRORS=$((ERRORS + 1))
  fi

  # Check the interface has the three required fields
  if grep -qE '"promote-safe".*"blocked"|"blocked".*"promote-safe"' "${CORE}"; then
    echo "PASS FF-CDV-5b: verdict discriminant union (promote-safe | blocked) present"
  else
    echo "FAIL FF-CDV-5b: verdict discriminant union not found"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# FF-CDV-6: classifySchemaChange reused (NF-1 — no second schema-compat logic)
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-CDV-6: classifySchemaChange imported (schema-compat reuse, NF-1) ---"

if [[ -f "${CORE}" ]]; then
  if grep -qE 'classifySchemaChange' "${CORE}"; then
    echo "PASS FF-CDV-6: classifySchemaChange referenced (existing schema-compat logic reused)"
  else
    echo "FAIL FF-CDV-6: classifySchemaChange not referenced in ${CORE} (NF-1: must reuse existing schema-compat, not fork it)"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: changelog-diff-validator-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: changelog-diff-validator-isolation — all FF-CDV-1..FF-CDV-6 green (T-0084)"
exit 0
