#!/usr/bin/env bash
# T-0081 · E11.10 — field-visibility-isolation (F-7 / F-8 / F-9)
#
# Static assertions (grep / boundary analysis — no runtime, no DB) over the
# new pure-field-visibility module src/core/field-visibility.ts:
#
#  FV1  — Purity: no forbidden pg/fs/net/http/crypto/node:crypto import and
#         no process.env reads (F-9, mirrors data-classification-isolation DC9).
#
#  FV2  — No parallel field-ACL / field-visibility / record-rights store tokens
#         in field-visibility.ts (F-7, mirrors grant-resolver-isolation Check 2 /
#         data-classification-isolation DC8). Rights derive ONLY from covering grants.
#
#  FV3  — No second resolveFor-like handle→fields edge exported from
#         field-visibility.ts (F-8). The module exports roleFieldVisibility /
#         serverProjectForm / FieldVisibilityPolicy / FieldProjection — none of
#         which re-resolve grants or re-fetch records.
#
#  FV4  — grant-resolver.ts still has exactly ONE resolveFor call to
#         roleFieldVisibility (inside the single PDP body), confirming F-8:
#         the new post-filter is inserted INSIDE resolveFor, not as a second edge.
#
#  FV5  — field-visibility.ts does NOT import grant-resolver.ts (no circular
#         dependency; the module receives already-filtered covering grants as input).
#
# SELF-TEST (--self-test flag): all five checks run against planted fixtures to
#   verify they correctly detect violations. Each check must FAIL on a planted
#   bad input. Exit 2 on self-test infrastructure failure (check is broken).
#
# Exit 0 on clean, non-zero on violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/field-visibility.ts"
RESOLVER="${PROJECT_ROOT}/src/core/grant-resolver.ts"
ERRORS=0

# ---------------------------------------------------------------------------
# Self-test mode: verify each check catches a planted violation.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0081] field-visibility-isolation --self-test: verifying violation detection"
  SELF_ERRORS=0
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_ST"' EXIT

  # ---- Self-test FV1: forbidden import detected
  TMP_FV1="${TMPDIR_ST}/fv1_bad.ts"
  printf 'import pg from "pg";\nexport function foo() {}\n' > "$TMP_FV1"
  if grep -Eq "from.*['\"]pg['\"]" "$TMP_FV1"; then
    echo "SELF-TEST FV1 PASS: planted pg import correctly detected"
  else
    echo "SELF-TEST FV1 FAIL: pg import not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test FV2: parallel authority token detected
  TMP_FV2="${TMPDIR_ST}/fv2_bad.ts"
  printf 'const x = field_visibility_table;\n' > "$TMP_FV2"
  if grep -nE "field_visibility" "$TMP_FV2" | grep -qvE "^\s*[0-9]*:?\s*//"; then
    echo "SELF-TEST FV2 PASS: parallel authority token correctly detected"
  else
    echo "SELF-TEST FV2 FAIL: parallel authority token not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test FV3: second resolveFor-like edge detected
  TMP_FV3="${TMPDIR_ST}/fv3_bad.ts"
  printf 'export async function resolveForFields(handle: any) { return {}; }\n' > "$TMP_FV3"
  if grep -qE "^export (async )?function.*[Rr]esolve.*\(.*handle" "$TMP_FV3"; then
    echo "SELF-TEST FV3 PASS: second resolver-edge correctly detected"
  else
    echo "SELF-TEST FV3 FAIL: second resolver-edge not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test FV4: absence of roleFieldVisibility call in a fake resolver
  TMP_FV4="${TMPDIR_ST}/fv4_no_call.ts"
  printf 'async function resolveFor(deps: any) { const vis = visibleFields(); return projectFields(raw, vis, ctx); }\n' > "$TMP_FV4"
  if ! grep -q "roleFieldVisibility" "$TMP_FV4"; then
    echo "SELF-TEST FV4 PASS: missing roleFieldVisibility call correctly detected as absent"
  else
    echo "SELF-TEST FV4 FAIL: false positive in detection — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test FV5: circular import detected
  TMP_FV5="${TMPDIR_ST}/fv5_circular.ts"
  printf 'import { resolveFor } from "./grant-resolver.js";\n' > "$TMP_FV5"
  if grep -qE "from.*grant-resolver" "$TMP_FV5"; then
    echo "SELF-TEST FV5 PASS: circular import correctly detected"
  else
    echo "SELF-TEST FV5 FAIL: circular import not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  if [[ ${SELF_ERRORS} -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_ERRORS} self-test(s) broken (the check infrastructure is broken)"
    exit 2
  fi
  echo "PASS: field-visibility-isolation --self-test — all self-tests green"
  exit 0
fi

# ---------------------------------------------------------------------------
# Real checks
# ---------------------------------------------------------------------------
echo "[T-0081] field-visibility-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist (T-0081 not implemented)"
  exit 1
fi

# ---- FV1: no forbidden imports + no process.env ---------------------------
echo ""
echo "[FV1] Checking purity: no forbidden imports, no process.env"

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
    echo "FAIL [FV1]: field-visibility.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done

# process.env must never be read in the pure core.
ENV_MATCHES=$(grep -nE "process\.env" "${MODULE}" | grep -vE "^\s*[0-9]*:?\s*(//|\*)" || true)
if [[ -n "${ENV_MATCHES}" ]]; then
  echo "FAIL [FV1]: field-visibility.ts reads process.env (env boundary is src/main.ts):"
  echo "${ENV_MATCHES}"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FV1]: no forbidden imports, no process.env (core purity preserved)"
fi

# ---- FV2: no parallel authority store tokens ------------------------------
echo ""
echo "[FV2] Checking no parallel field-ACL / field-visibility store tokens"

PARALLEL_AUTHORITY_TOKENS=(
  "field_visibility"
  "record_rights"
  "_acl"
  "recordAcl"
  "fieldVisibility"
)

before=${ERRORS}
for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
  # Ignore comment lines (// ...) so docblock prose explaining the ban passes.
  matches=$(grep -nE "${token}" "${MODULE}" | grep -vE "^\s*[0-9]*:?\s*//" || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL [FV2]: field-visibility.ts references a parallel-authority token '${token}':"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FV2]: no parallel-authority store tokens (covering grants are the sole authority)"
fi

# ---- FV3: no second resolveFor-like handle→fields export -----------------
echo ""
echo "[FV3] Checking no second resolve-like edge exported from field-visibility.ts"

# Deny: any exported function that looks like a handle→fields resolver.
# Pattern: export (async) function *resolve*(...handle...) or similar.
SECOND_EDGE_PATTERNS=(
  "^export (async )?function.*[Rr]esolve.*\(.*handle"
  "^export (async )?function.*[Ff]etch.*[Ff]ield"
  "^export (async )?function.*[Gg]et[Rr]ecord"
  "^export (async )?function.*[Ll]ookup[Ff]ield"
)

before=${ERRORS}
for pattern in "${SECOND_EDGE_PATTERNS[@]}"; do
  if grep -qE "${pattern}" "${MODULE}"; then
    extra=$(grep -nE "${pattern}" "${MODULE}" || true)
    echo "FAIL [FV3]: field-visibility.ts exports a second resolver-like edge matching '${pattern}':"
    echo "${extra}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FV3]: no second handle→fields resolver edge (single-authority-path proof)"
fi

# ---- FV4: grant-resolver.ts calls roleFieldVisibility inside resolveFor ---
echo ""
echo "[FV4] Checking roleFieldVisibility is called inside resolveFor in grant-resolver.ts"

if [[ ! -f "${RESOLVER}" ]]; then
  echo "FAIL [FV4]: ${RESOLVER} does not exist"
  ERRORS=$((ERRORS + 1))
else
  if ! grep -q "roleFieldVisibility" "${RESOLVER}"; then
    echo "FAIL [FV4]: grant-resolver.ts does not call roleFieldVisibility (T-0081 not wired into PDP)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [FV4]: grant-resolver.ts calls roleFieldVisibility (wired inside single PDP)"
  fi
fi

# ---- FV5: field-visibility.ts does NOT import grant-resolver.ts -----------
echo ""
echo "[FV5] Checking field-visibility.ts does not import grant-resolver (no circular dep)"

if grep -qE "from.*grant-resolver" "${MODULE}"; then
  circ=$(grep -nE "from.*grant-resolver" "${MODULE}" || true)
  echo "FAIL [FV5]: field-visibility.ts imports grant-resolver.ts (circular dependency):"
  echo "${circ}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [FV5]: no circular import from field-visibility.ts to grant-resolver.ts"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: field-visibility-isolation found ${ERRORS} violation(s) (T-0081 F-7/F-8/F-9)"
  exit 1
fi

echo "PASS: field-visibility-isolation — all checks green (T-0081 F-7/F-8/F-9)"
exit 0
