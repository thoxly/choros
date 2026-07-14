#!/usr/bin/env bash
# T-0028 · FF-G3 / Layer C: flowable-bridge-contract (deferred probe)
#
# This is the sealed contract that T-0058/T-0064/T-0067 (Flowable external-task
# bridge) MUST satisfy when they land. The probe:
#
#   - Exits 0 IMMEDIATELY when no bridge path exists (bridge not yet built).
#     This is the expected state when T-0028 is built (T-0058+ not started yet).
#
#   - When the bridge path IS present (src/bridge/ directory or src/core/flowable*.ts
#     files exist), ACTIVATES and asserts:
#       1. Every bridge result-return file calls assertVariableValue before storing
#          any process-variable value.
#       2. Every bridge result-return file routes record mutations through resolveFor.
#
# Violation of these invariants at T-0058+ build time is a defect traceable to
# T-0028's AC-8 (FR-6: bridge contract sealed here).
#
# Exit 0 when bridge absent (normal now) or when bridge is present and compliant.
# Exit 1 when bridge is present but violates the contract.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${PROJECT_ROOT}/src"
ERRORS=0

echo "[T-0028/FF-G3] flowable-bridge-contract: checking bridge path existence ..."

# ---------------------------------------------------------------------------
# Detect bridge path
# ---------------------------------------------------------------------------

BRIDGE_DIR="${SRC}/bridge"
FLOWABLE_GLOB=$(find "${SRC}/core" -maxdepth 1 -name "flowable*.ts" 2>/dev/null || true)

BRIDGE_PRESENT=false
if [[ -d "${BRIDGE_DIR}" ]]; then
  BRIDGE_PRESENT=true
  echo "[FF-G3] Bridge directory detected: ${BRIDGE_DIR}"
fi
if [[ -n "${FLOWABLE_GLOB}" ]]; then
  BRIDGE_PRESENT=true
  echo "[FF-G3] Flowable core files detected: ${FLOWABLE_GLOB}"
fi

if [[ "${BRIDGE_PRESENT}" == "false" ]]; then
  echo "PASS [FF-G3]: no bridge path found — deferred probe exits 0 (bridge not yet built)"
  echo "NOTE: When src/bridge/ or src/core/flowable*.ts exist (T-0058+), this probe"
  echo "      activates and asserts assertVariableValue + resolveFor at every bridge seam."
  exit 0
fi

# ---------------------------------------------------------------------------
# Bridge IS present — assert the T-0028 contract
# ---------------------------------------------------------------------------

echo "[FF-G3] Bridge path found — asserting T-0028 contract invariants ..."

# Collect bridge source files (result-return paths)
BRIDGE_FILES=$(find "${BRIDGE_DIR}" -name "*.ts" 2>/dev/null || true)
if [[ -n "${FLOWABLE_GLOB}" ]]; then
  BRIDGE_FILES="${BRIDGE_FILES}"$'\n'"${FLOWABLE_GLOB}"
fi

if [[ -z "${BRIDGE_FILES}" ]]; then
  echo "PASS [FF-G3]: bridge path found but no *.ts files — nothing to assert yet"
  exit 0
fi

# Assertion 1: every bridge result-return file calls assertVariableValue
echo "[FF-G3-1] Checking: all bridge files call assertVariableValue ..."
while IFS= read -r file; do
  [[ -z "${file}" ]] && continue
  if ! grep -q "assertVariableValue" "${file}"; then
    echo "FAIL [FF-G3-1]: bridge file does NOT call assertVariableValue: ${file}"
    echo "  -> T-0028 AC-8 contract: every bridge result-return path MUST validate"
    echo "     payloads with assertVariableValue before storing them."
    ERRORS=$((ERRORS + 1))
  fi
done <<< "${BRIDGE_FILES}"

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS [FF-G3-1]: all bridge files call assertVariableValue"
fi

# Assertion 2: every bridge result-return file routes mutations through resolveFor
echo "[FF-G3-2] Checking: all bridge files reference resolveFor for record mutations ..."
while IFS= read -r file; do
  [[ -z "${file}" ]] && continue
  if ! grep -q "resolveFor" "${file}"; then
    echo "FAIL [FF-G3-2]: bridge file does NOT reference resolveFor: ${file}"
    echo "  -> T-0028 AC-8 contract: every record mutation MUST route through"
    echo "     resolveFor(deps, handle, subject, op) with the correct write op."
    ERRORS=$((ERRORS + 1))
  fi
done <<< "${BRIDGE_FILES}"

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS [FF-G3-2]: all bridge files reference resolveFor"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

if [[ ${ERRORS} -gt 0 ]]; then
  echo ""
  echo "FAIL [FF-G3]: flowable-bridge-contract found ${ERRORS} violation(s)"
  echo "  -> These are T-0028 AC-8 contract violations. The bridge (T-0058+) MUST"
  echo "     validate all result payloads with assertVariableValue and route record"
  echo "     mutations through resolveFor. See docs/design/T-0028-engine-mutation-guard.adr.md §8."
  exit 1
fi

echo ""
echo "PASS [FF-G3]: flowable-bridge-contract — bridge present and compliant"
exit 0
