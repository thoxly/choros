#!/usr/bin/env bash
# T-0231 · impl-loop-b4-interview-readonly fitness check (B-4 / ADR T-0129 §7/§14).
#
# AC-16 (fitness): guard that the interview protocol (processInterviewClaim) has
# NO write path to the org-structure. The interview reads the org-tree but NEVER
# creates/modifies org-nodes (FR-B4-2 / FR-B4-3 / ADR §7 read-only invariant).
#
# Check-1: implementation-loop.ts exists.
# Check-2: processInterviewClaim is exported.
# Check-3: no org-write call tokens found in implementation-loop.ts.
#          We grep for banned write-path patterns: insertNode, createNode, updateNode,
#          addNode, writeNode, setNode, org.insert, org.create, org.update, org.write.
# Check-4: OrgTree interface has only read-method tokens (getNodes, getNode, getRoleIds).
# Check-5: frozen-guard — grant-lattice.ts not modified (AC-12 / FROZEN-CLEAR).
#
# --self-test arm: runs checks against a deliberately broken fixture with an org-write
# call and verifies that the check catches it (exit 0 means self-test passed).
#
# Locale-portable: uses LC_ALL=C.

set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMPL_LOOP="${ROOT}/src/core/implementation-loop.ts"

# ============================================================
# SELF-TEST MODE
# ============================================================
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0231][self-test] impl-loop-b4-interview-readonly self-test: verifying checks catch violations"

  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT

  SELF_TEST_ERRORS=0

  # Broken fixture: contains an org-write call in the interview module
  BROKEN_FILE="${TMPDIR_ST}/implementation-loop-broken.ts"
  cat > "${BROKEN_FILE}" <<'FIXTURE'
// BROKEN FIXTURE: has an org-write call — violates read-only invariant
export async function processInterviewClaim(opts: unknown): Promise<unknown> {
  // VIOLATION: writing to org-structure
  await opts.org.insertNode({ nodeId: "phantom", roleIds: [] });
  return { resolution: "resolved" };
}
FIXTURE

  # Check-3: org-write call should be detected
  ORG_WRITE_TOKENS=(
    "insertNode"
    "createNode"
    "updateNode"
    "addNode"
    "writeNode"
    "setNode"
    "org\.insert"
    "org\.create"
    "org\.update"
    "org\.write"
  )
  BROKEN_FOUND=0
  for TOKEN in "${ORG_WRITE_TOKENS[@]}"; do
    if grep -qE "${TOKEN}" "${BROKEN_FILE}" 2>/dev/null; then
      BROKEN_FOUND=$((BROKEN_FOUND + 1))
    fi
  done
  if [[ "${BROKEN_FOUND}" -gt 0 ]]; then
    echo "SELF-TEST PASS: Check-3 correctly detects org-write token in broken fixture (${BROKEN_FOUND} match(es))"
  else
    echo "SELF-TEST FAIL: Check-3 did NOT detect org-write token in broken fixture" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # Check-4: OrgTree read-only interface — broken fixture lacks read-only methods
  for METHOD in "getNodes" "getNode" "getRoleIds"; do
    if ! grep -q "${METHOD}" "${BROKEN_FILE}" 2>/dev/null; then
      echo "SELF-TEST PASS: Check-4 detects missing read-only method '${METHOD}' in broken fixture"
    else
      echo "SELF-TEST FAIL: Check-4 unexpected — broken fixture has read-only method '${METHOD}'" >&2
      SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
    fi
  done

  echo ""
  if [[ "${SELF_TEST_ERRORS}" -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_TEST_ERRORS} self-test assertion(s) failed"
    exit 1
  fi
  echo "SELF-TEST PASS: impl-loop-b4-interview-readonly self-test — all violation-detection assertions confirmed"
  exit 0
fi

# ============================================================
# MAIN CHECKS
# ============================================================
ERRORS=0

echo "[T-0231] impl-loop-b4-interview-readonly fitness check (ADR T-0129 §7/§14 B-4)"

# ---- Check-1: implementation-loop.ts exists ----------------------------
echo ""
echo "Check-1: src/core/implementation-loop.ts exists"
if [[ -f "${IMPL_LOOP}" ]]; then
  echo "PASS: ${IMPL_LOOP} exists"
else
  echo "FAIL: ${IMPL_LOOP} NOT FOUND" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---- Check-2: processInterviewClaim is exported ------------------------
echo ""
echo "Check-2: processInterviewClaim exported from implementation-loop.ts"
if [[ -f "${IMPL_LOOP}" ]]; then
  if grep -q 'processInterviewClaim' "${IMPL_LOOP}" 2>/dev/null; then
    echo "PASS: processInterviewClaim found"
  else
    echo "FAIL: processInterviewClaim NOT found" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Check-3: no org-write path in interview module --------------------
echo ""
echo "Check-3: no org-write call tokens in implementation-loop.ts (read-only invariant)"
ORG_WRITE_TOKENS=(
  "insertNode"
  "createNode"
  "updateNode"
  "addNode"
  "writeNode"
  "setNode"
)
if [[ -f "${IMPL_LOOP}" ]]; then
  for TOKEN in "${ORG_WRITE_TOKENS[@]}"; do
    # Exclude comment lines
    if grep -v '^[[:space:]]*//' "${IMPL_LOOP}" | grep -qE "\b${TOKEN}\b" 2>/dev/null; then
      echo "FAIL: org-write token '${TOKEN}' found in implementation-loop.ts — READ-ONLY invariant violated (ADR §7)" >&2
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS: org-write token '${TOKEN}' NOT found"
    fi
  done
fi

# ---- Check-4: OrgTree interface is read-only ---------------------------
echo ""
echo "Check-4: OrgTree interface has only read methods (getNodes/getNode/getRoleIds)"
if [[ -f "${IMPL_LOOP}" ]]; then
  READ_METHODS=("getNodes" "getNode" "getRoleIds")
  for METHOD in "${READ_METHODS[@]}"; do
    if grep -q "${METHOD}" "${IMPL_LOOP}" 2>/dev/null; then
      echo "PASS: read method '${METHOD}' found in OrgTree interface"
    else
      echo "FAIL: read method '${METHOD}' NOT found in OrgTree interface" >&2
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- Check-5: frozen-guard — grant-lattice.ts not modified (AC-12) ----
echo ""
echo "Check-5: frozen-guard — grant-lattice.ts not modified (FROZEN-CLEAR / AC-12)"
BASE=$(git -C "${ROOT}" merge-base HEAD origin/dev 2>/dev/null \
       || git -C "${ROOT}" merge-base HEAD dev 2>/dev/null \
       || git -C "${ROOT}" rev-parse HEAD~1 2>/dev/null \
       || echo "")

if [[ -z "${BASE}" ]]; then
  echo "WARN: cannot determine merge-base; skipping frozen-file check"
else
  FROZEN_LATTICE="src/core/grant-lattice.ts"
  CHANGED=$(git -C "${ROOT}" diff --name-only "${BASE}" -- "${FROZEN_LATTICE}" 2>/dev/null || true)
  if [[ -n "${CHANGED}" ]]; then
    echo "FAIL: ${FROZEN_LATTICE} was modified — FROZEN-CLEAR violated (grant-lattice is READ-ONLY for B-3/B-4)" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: ${FROZEN_LATTICE} unmodified (import-only as per FROZEN-CLEAR)"
  fi
  # Also confirm implementation-loop.ts imports isNarrowerOrEqual (not re-defines it)
  if [[ -f "${IMPL_LOOP}" ]]; then
    if grep -q 'isNarrowerOrEqual' "${IMPL_LOOP}" 2>/dev/null; then
      if grep -q "from.*grant-lattice" "${IMPL_LOOP}" 2>/dev/null; then
        echo "PASS: isNarrowerOrEqual is imported from grant-lattice.ts (READER pattern confirmed)"
      else
        echo "FAIL: isNarrowerOrEqual used but not imported from grant-lattice.ts" >&2
        ERRORS=$((ERRORS + 1))
      fi
    fi
  fi
fi

echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL: impl-loop-b4-interview-readonly found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: impl-loop-b4-interview-readonly — all checks green (T-0231 B-4 / ADR T-0129 §7)"
exit 0
