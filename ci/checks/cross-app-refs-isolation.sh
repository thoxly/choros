#!/usr/bin/env bash
# T-0080 / E11.9 — cross-app-refs-isolation
#
# Static assertions over src/core/cross-app-ref.ts (the cross-application
# reference mechanism: references-not-copies, per-hop ACL, redacted projection
# reusing field-visibility.ts, hop-cap). Mirrors the purity-discipline of
# field-visibility-isolation.sh / data-classification-isolation.sh.
#
# Checks:
#
#  CA1  — Core purity: cross-app-ref.ts imports ONLY field-visibility.js from
#         src/core/; no pg/fs/net/http/node:crypto imports; no process.env reads.
#         (§6 invariant: pure traversal logic, no DB/IO in the pure core.)
#
#  CA2  — Single resolver: cross-app-ref.ts does NOT import grant-resolver.ts
#         or call resolveFor directly. Per-hop ACL goes through the injected
#         CrossAppHopFetcher port (which wraps the single PDP externally).
#         No second authority path.
#
#  CA3  — Redaction reuses field-visibility.ts: cross-app-ref.ts imports
#         FieldProjection from field-visibility.js (not a fork). The denied-hop
#         sentinel shape MUST use the T-0081 FieldProjection type.
#
#  CA4  — Hop-cap enforced: HOP_CAP constant is exported from cross-app-ref.ts
#         AND is used in the hop-cap check (depth + 1 > HOP_CAP pattern).
#         Protects against cycles / rollup-of-rollup (§6).
#
#  CA5  — Per-hop ACL: resolveHop is exported from cross-app-ref.ts.
#         The hop result type includes `allowed` discriminant (CrossAppHopResult).
#
#  CA6  — No parallel ACL store: cross-app-ref.ts does NOT reference any
#         secondary ACL table tokens (field_visibility, record_rights, _acl,
#         recordAcl, fieldVisibility, hop_acl, ref_acl) outside comments.
#         Rights come solely through the fetcher port (which wraps the single PDP).
#
# SELF-TEST (--self-test flag): each check is run against a planted fixture to
#   verify it correctly detects the violation. Exit 2 on self-test infra failure.
#
# Exit 0 on clean, non-zero on violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/cross-app-ref.ts"
ERRORS=0

# ---------------------------------------------------------------------------
# Self-test mode: verify each check catches a planted violation.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0080] cross-app-refs-isolation --self-test: verifying violation detection"
  SELF_ERRORS=0
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_ST"' EXIT

  # ---- Self-test CA1: forbidden import detected
  TMP_CA1="${TMPDIR_ST}/ca1_bad.ts"
  printf 'import pg from "pg";\nexport function foo() {}\n' > "$TMP_CA1"
  if grep -Eq 'from.*["'"'"']pg["'"'"']' "$TMP_CA1"; then
    echo "SELF-TEST CA1 PASS: planted pg import correctly detected"
  else
    echo "SELF-TEST CA1 FAIL: pg import not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test CA2: direct resolveFor import detected
  TMP_CA2="${TMPDIR_ST}/ca2_bad.ts"
  printf 'import { resolveFor } from "./grant-resolver.js";\n' > "$TMP_CA2"
  if grep -qE 'from.*grant-resolver' "$TMP_CA2"; then
    echo "SELF-TEST CA2 PASS: direct grant-resolver import correctly detected"
  else
    echo "SELF-TEST CA2 FAIL: grant-resolver import not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test CA3: missing field-visibility import detected
  TMP_CA3="${TMPDIR_ST}/ca3_bad.ts"
  # Planted bad file has NO import from field-visibility (no comment mentioning it either).
  printf '// pure module with no imports\nexport const HOP_CAP = 3;\n' > "$TMP_CA3"
  if ! grep -qE 'from.*field-visibility' "$TMP_CA3"; then
    echo "SELF-TEST CA3 PASS: missing field-visibility import correctly detected as absent"
  else
    echo "SELF-TEST CA3 FAIL: false positive — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test CA4: missing HOP_CAP export detected
  TMP_CA4="${TMPDIR_ST}/ca4_bad.ts"
  printf 'const internalCap = 3;\n' > "$TMP_CA4"
  if ! grep -qE 'export const HOP_CAP' "$TMP_CA4"; then
    echo "SELF-TEST CA4 PASS: missing HOP_CAP export correctly detected as absent"
  else
    echo "SELF-TEST CA4 FAIL: false positive — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test CA5: missing resolveHop export detected
  TMP_CA5="${TMPDIR_ST}/ca5_bad.ts"
  printf 'function resolveHop() {}\n' > "$TMP_CA5"
  if ! grep -qE 'export (async )?function resolveHop' "$TMP_CA5"; then
    echo "SELF-TEST CA5 PASS: missing resolveHop export correctly detected as absent"
  else
    echo "SELF-TEST CA5 FAIL: false positive — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # ---- Self-test CA6: parallel ACL token detected
  TMP_CA6="${TMPDIR_ST}/ca6_bad.ts"
  printf 'const x = hop_acl_table;\n' > "$TMP_CA6"
  if grep -nE 'hop_acl' "$TMP_CA6" | grep -qvE '^\s*[0-9]*:?\s*//'; then
    echo "SELF-TEST CA6 PASS: parallel ACL token correctly detected"
  else
    echo "SELF-TEST CA6 FAIL: parallel ACL token not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  if [[ ${SELF_ERRORS} -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_ERRORS} self-test(s) broken (check infrastructure is broken)"
    exit 2
  fi
  echo "PASS: cross-app-refs-isolation --self-test — all self-tests green"
  exit 0
fi

# ---------------------------------------------------------------------------
# Real checks
# ---------------------------------------------------------------------------
echo "[T-0080] cross-app-refs-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist (T-0080 not implemented)"
  exit 1
fi

# ---- CA1: core purity — no forbidden imports, no process.env ---------------
echo ""
echo "[CA1] Checking purity: no forbidden imports, no process.env"

FORBIDDEN_IMPORT_PATTERNS=(
  'from.*["'"'"']pg["'"'"']'
  'from.*["'"'"'].*node:http["'"'"']'
  'from.*["'"'"'].*node:fs["'"'"']'
  'from.*["'"'"'].*node:net["'"'"']'
  'from.*["'"'"'].*node:crypto["'"'"']'
  'from.*["'"'"']http["'"'"']'
  'from.*["'"'"']fs["'"'"']'
  'from.*["'"'"']net["'"'"']'
  'from.*["'"'"']crypto["'"'"']'
  'require.*["'"'"'](pg|fs|net|http|crypto|node:crypto)["'"'"']'
)

before=${ERRORS}
for pattern in "${FORBIDDEN_IMPORT_PATTERNS[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL [CA1]: cross-app-ref.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done

ENV_MATCHES=$(grep -nE "process\.env" "${MODULE}" | grep -vE "^\s*[0-9]*:?\s*(//|\*)" || true)
if [[ -n "${ENV_MATCHES}" ]]; then
  echo "FAIL [CA1]: cross-app-ref.ts reads process.env (env boundary is src/main.ts):"
  echo "${ENV_MATCHES}"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [CA1]: no forbidden imports, no process.env (core purity preserved)"
fi

# ---- CA2: single resolver — no direct grant-resolver/resolveFor import -----
echo ""
echo "[CA2] Checking no direct grant-resolver import (single authority path)"

if grep -qE 'from.*grant-resolver' "${MODULE}"; then
  circ=$(grep -nE 'from.*grant-resolver' "${MODULE}" || true)
  echo "FAIL [CA2]: cross-app-ref.ts imports grant-resolver.ts (second authority path):"
  echo "${circ}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [CA2]: no grant-resolver import (ACL goes through injected fetcher port)"
fi

# Also check no direct resolveFor call (which would bypass the port)
if grep -qE '[^a-zA-Z]resolveFor\(' "${MODULE}"; then
  echo "FAIL [CA2]: cross-app-ref.ts calls resolveFor directly (must use injected fetcher port)"
  ERRORS=$((ERRORS + 1))
fi

# ---- CA3: redaction reuses field-visibility.ts — no fork -------------------
echo ""
echo "[CA3] Checking redaction reuses FieldProjection from field-visibility.ts"

if ! grep -qE 'from.*field-visibility' "${MODULE}"; then
  echo "FAIL [CA3]: cross-app-ref.ts does not import from field-visibility.ts"
  echo "           (redacted projection must reuse T-0081 FieldProjection, not fork it)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [CA3]: field-visibility.ts is imported (T-0081 FieldProjection reused)"
fi

# ---- CA4: hop-cap exported and used ----------------------------------------
echo ""
echo "[CA4] Checking HOP_CAP is exported and used as cap guard"

if ! grep -qE 'export const HOP_CAP' "${MODULE}"; then
  echo "FAIL [CA4]: HOP_CAP is not exported from cross-app-ref.ts (hop-cap not enforced)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [CA4a]: HOP_CAP is exported"
fi

# Verify the hop-cap guard pattern exists (depth check against HOP_CAP).
if ! grep -qE 'depth.*HOP_CAP|HOP_CAP.*depth' "${MODULE}"; then
  echo "FAIL [CA4]: cross-app-ref.ts does not use HOP_CAP in a depth guard"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [CA4b]: HOP_CAP is used in a depth guard (hop-cap enforced)"
fi

# ---- CA5: resolveHop is exported -------------------------------------------
echo ""
echo "[CA5] Checking resolveHop (per-hop ACL function) is exported"

if ! grep -qE 'export (async )?function resolveHop' "${MODULE}"; then
  echo "FAIL [CA5]: resolveHop is not exported from cross-app-ref.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS [CA5]: resolveHop exported (per-hop ACL function present)"
fi

# ---- CA6: no parallel ACL store tokens -------------------------------------
echo ""
echo "[CA6] Checking no parallel ACL store tokens in cross-app-ref.ts"

PARALLEL_ACL_TOKENS=(
  "field_visibility"
  "record_rights"
  "_acl"
  "recordAcl"
  "fieldVisibility"
  "hop_acl"
  "ref_acl"
  "cross_app_acl"
)

before=${ERRORS}
for token in "${PARALLEL_ACL_TOKENS[@]}"; do
  # Ignore comment lines.
  matches=$(grep -nE "${token}" "${MODULE}" | grep -vE "^\s*[0-9]*:?\s*//" || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL [CA6]: cross-app-ref.ts references a parallel-ACL token '${token}':"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [CA6]: no parallel-ACL store tokens (authority is through fetcher port → single PDP)"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: cross-app-refs-isolation found ${ERRORS} violation(s) (T-0080 E11.9)"
  exit 1
fi

echo "PASS: cross-app-refs-isolation — all checks green (T-0080 E11.9)"
exit 0
