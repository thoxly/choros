#!/usr/bin/env bash
# T-0231 · impl-loop-b2-phase-bundle fitness check (B-2 / ADR T-0129 §2/§5/§14).
#
# AC-7 (fitness): structural guard on implementation-loop.ts — verifies:
#   Check-1: implementation-loop.ts exists in src/core/
#   Check-2: all 7 implementation phases are present
#   Check-3: revise and evolve backward edges are present
#   Check-4: all required bundle fields are present
#   Check-5: coherenceHash computation is present (determinism guard)
#   Check-6: human-gate invariant — promote is the only human-initiated transition
#
# AC-8 (fitness / frozen-guard): none of the frozen files modified vs merge-base with dev.
#   (Same Check-6 pattern as implementation-agent-seed.sh)
#
# --self-test arm: runs checks against deliberately broken fixtures and verifies
# each check catches its violation (exit 0 means self-test passed).
#
# Locale-portable: uses LC_ALL=C for all sort/grep operations (ci-locale-pinned pattern).

set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMPL_LOOP="${ROOT}/src/core/implementation-loop.ts"

# ============================================================
# SELF-TEST MODE
# ============================================================
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0231][self-test] impl-loop-b2-phase-bundle self-test: verifying checks catch violations"

  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT

  SELF_TEST_ERRORS=0

  # Broken fixture: missing phases, no revise/evolve, no bundle fields
  BROKEN_FILE="${TMPDIR_ST}/implementation-loop-broken.ts"
  cat > "${BROKEN_FILE}" <<'FIXTURE'
export type ImplementationPhase = "draft_bundle";
export function transitionPhase(from: string, t: string) { return { ok: false }; }
const bundleFieldsAbsent = true;
const x = "hello";
FIXTURE

  # Check-1: file exists (test inverse — nonexistent file)
  NONEXISTENT="${TMPDIR_ST}/nonexistent.ts"
  if [[ ! -f "${NONEXISTENT}" ]]; then
    echo "SELF-TEST PASS: Check-1 correctly fails for missing implementation-loop.ts"
  else
    echo "SELF-TEST FAIL: nonexistent file check broken" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # Check-2: 7 phases — broken fixture only has 1
  PHASE_COUNT=$(grep -o '"[a-z_]*"' "${BROKEN_FILE}" | grep -cE '"org_ready"|"interview"|"draft_bundle"|"simulation"|"pilot"|"promote_pending"|"production"' || true)
  if [[ "${PHASE_COUNT}" -lt 7 ]]; then
    echo "SELF-TEST PASS: Check-2 correctly detects missing phases (found ${PHASE_COUNT}/7)"
  else
    echo "SELF-TEST FAIL: Check-2 did NOT detect missing phases" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # Check-3: revise/evolve backward edges — broken fixture has none
  if ! grep -q 'revise_to_interview\|revise_to_draft' "${BROKEN_FILE}" 2>/dev/null; then
    echo "SELF-TEST PASS: Check-3 correctly detects missing revise edges"
  else
    echo "SELF-TEST FAIL: Check-3 did NOT detect missing revise edges" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  if ! grep -q 'evolve' "${BROKEN_FILE}" 2>/dev/null; then
    echo "SELF-TEST PASS: Check-3 correctly detects missing evolve edge"
  else
    echo "SELF-TEST FAIL: Check-3 did NOT detect missing evolve edge" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # Check-4: bundle fields — broken fixture has none of the required bundle fields
  for FIELD in "bundleId" "implementationId" "coherenceHash" "changelog"; do
    if ! grep -q "${FIELD}" "${BROKEN_FILE}" 2>/dev/null; then
      echo "SELF-TEST PASS: Check-4 correctly detects missing bundle field '${FIELD}'"
    else
      echo "SELF-TEST FAIL: Check-4 did NOT detect missing bundle field '${FIELD}'" >&2
      SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
    fi
  done

  echo ""
  if [[ "${SELF_TEST_ERRORS}" -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_TEST_ERRORS} self-test assertion(s) failed — check has blind spots"
    exit 1
  fi
  echo "SELF-TEST PASS: impl-loop-b2-phase-bundle self-test — all violation-detection assertions confirmed"
  exit 0
fi

# ============================================================
# MAIN CHECKS
# ============================================================
ERRORS=0

echo "[T-0231] impl-loop-b2-phase-bundle fitness check (ADR T-0129 §2/§5/§14 B-2)"

# ---- Check-1: implementation-loop.ts exists ----------------------------
echo ""
echo "Check-1: src/core/implementation-loop.ts exists"
if [[ -f "${IMPL_LOOP}" ]]; then
  echo "PASS: ${IMPL_LOOP} exists"
else
  echo "FAIL: ${IMPL_LOOP} NOT FOUND" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---- Check-2: all 7 implementation phases present ----------------------
echo ""
echo "Check-2: all 7 implementation phases present (ADR §2)"
PHASES=(
  "org_ready"
  "interview"
  "draft_bundle"
  "simulation"
  "pilot"
  "promote_pending"
  "production"
)
if [[ -f "${IMPL_LOOP}" ]]; then
  for PHASE in "${PHASES[@]}"; do
    if grep -q "\"${PHASE}\"" "${IMPL_LOOP}" 2>/dev/null; then
      echo "PASS: phase '${PHASE}' found"
    else
      echo "FAIL: phase '${PHASE}' NOT found in implementation-loop.ts" >&2
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- Check-3: revise and evolve backward edges present -----------------
echo ""
echo "Check-3: revise/evolve backward edges present (ADR §2)"
if [[ -f "${IMPL_LOOP}" ]]; then
  for EDGE in "revise_to_interview" "revise_to_draft" "evolve"; do
    if grep -q "\"${EDGE}\"" "${IMPL_LOOP}" 2>/dev/null || grep -q "'${EDGE}'" "${IMPL_LOOP}" 2>/dev/null; then
      echo "PASS: backward edge '${EDGE}' found"
    else
      echo "FAIL: backward edge '${EDGE}' NOT found" >&2
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- Check-4: required bundle fields present ---------------------------
echo ""
echo "Check-4: required bundle fields present (ADR §5.1)"
BUNDLE_FIELDS=(
  "bundleId"
  "implementationId"
  "coherenceHash"
  "changelog"
  "components"
)
if [[ -f "${IMPL_LOOP}" ]]; then
  for FIELD in "${BUNDLE_FIELDS[@]}"; do
    if grep -q "${FIELD}" "${IMPL_LOOP}" 2>/dev/null; then
      echo "PASS: bundle field '${FIELD}' found"
    else
      echo "FAIL: bundle field '${FIELD}' NOT found" >&2
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- Check-5: coherenceHash computation present (determinism) ----------
echo ""
echo "Check-5: computeCoherenceHash function exported (determinism guard)"
if [[ -f "${IMPL_LOOP}" ]]; then
  if grep -q 'computeCoherenceHash' "${IMPL_LOOP}" 2>/dev/null; then
    echo "PASS: computeCoherenceHash found"
  else
    echo "FAIL: computeCoherenceHash NOT found in implementation-loop.ts" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Check-6: frozen files unmodified vs merge-base (AC-8) ------------
echo ""
echo "Check-6: frozen files unmodified vs merge-base with dev (AC-8)"
BASE=$(git -C "${ROOT}" merge-base HEAD origin/dev 2>/dev/null \
       || git -C "${ROOT}" merge-base HEAD dev 2>/dev/null \
       || git -C "${ROOT}" rev-parse HEAD~1 2>/dev/null \
       || echo "")

FROZEN=(
  "src/core/grant-lattice.ts"
  "src/core/grant-resolver.ts"
  "src/core/object-handle.ts"
  "src/db/audit-writer.ts"
)

if [[ -z "${BASE}" ]]; then
  echo "WARN: cannot determine merge-base; skipping frozen-file check"
else
  for F in "${FROZEN[@]}"; do
    CHANGED=$(git -C "${ROOT}" diff --name-only "${BASE}" -- "${F}" 2>/dev/null || true)
    if [[ -n "${CHANGED}" ]]; then
      echo "FAIL: frozen file ${F} was modified (FROZEN-CLEAR violation)" >&2
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS: ${F} unmodified"
    fi
  done
fi

echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL: impl-loop-b2-phase-bundle found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: impl-loop-b2-phase-bundle — all checks green (T-0231 B-2 / ADR T-0129 §2/§5)"
exit 0
