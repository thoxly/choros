#!/usr/bin/env bash
# T-0581 (view registry) · FF-VR-4 — 'type' is an OPEN discriminator (AC-11).
#
# THE CONTRACT (ADR §3.2/§3.4): choros.list_view.type is text NOT NULL DEFAULT
# 'list' with NO CHECK constraint restricting its values — T-0582 must be able
# to insert type='kanban' without a DDL migration. validateViewConfig (the
# semantic gate) is a DISPATCHER by `type` (a switch/map), not a single
# hardcoded 'list'-only branch with no extension point.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

MIGRATION="$(ls "${ROOT}"/migrations/*_list_view_registry.sql 2>/dev/null | head -1 || true)"
VIEW_CONFIG="${ROOT}/src/core/view-config.ts"

ERRORS=0

echo "[FF-VR-4] view-registry-type-open: checking T-0581 AC-11 (open type + dispatcher)"

if [[ -z "${MIGRATION}" || ! -f "${MIGRATION}" ]]; then
  echo "FAIL (FF-VR-4): no migrations/*_list_view_registry.sql file found"
  exit 1
fi

# ---- DDL must NOT constrain `type` to an enum of values ---------------------
# Look for a CHECK constraint mentioning `type` and `IN (` in the same
# statement — the DDL-level enum-lock this ADR explicitly rejects.
if grep -niE "CHECK\s*\(\s*type\s+IN\s*\(" "${MIGRATION}"; then
  echo "FAIL (FF-VR-4a): a CHECK (type IN (...)) constraint was found in ${MIGRATION} — type must stay open (no DDL migration needed for kanban)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-VR-4a): no CHECK (type IN (...)) constraint in the migration"
fi

if grep -qE "type\s+text\s+NOT NULL DEFAULT 'list'" "${MIGRATION}"; then
  echo "PASS (FF-VR-4b): type column is a plain 'text NOT NULL DEFAULT ...' (no enum type)"
else
  echo "FAIL (FF-VR-4b): expected 'type text NOT NULL DEFAULT ''list''' column definition not found"
  ERRORS=$((ERRORS + 1))
fi

# ---- TS validator must be a dispatcher (switch/map by type), not a single
# unconditional 'list' branch --------------------------------------------
if [[ ! -f "${VIEW_CONFIG}" ]]; then
  echo "FAIL (FF-VR-4c): ${VIEW_CONFIG} does not exist"
  ERRORS=$((ERRORS + 1))
else
  if grep -qE "export function validateViewConfig" "${VIEW_CONFIG}" && grep -qE "switch\s*\(\s*type\s*\)" "${VIEW_CONFIG}"; then
    echo "PASS (FF-VR-4c): validateViewConfig dispatches on 'type' via a switch statement"
  else
    echo "FAIL (FF-VR-4c): validateViewConfig does not appear to switch/dispatch on 'type'"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE 'case "list"' "${VIEW_CONFIG}"; then
    echo "PASS (FF-VR-4d): a 'list' case branch exists in the dispatcher"
  else
    echo "FAIL (FF-VR-4d): no 'list' case branch found in validateViewConfig"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "default:" "${VIEW_CONFIG}"; then
    echo "PASS (FF-VR-4e): the dispatcher has a default branch (unknown type rejected, not silently accepted)"
  else
    echo "FAIL (FF-VR-4e): no default branch in the type dispatcher"
    ERRORS=$((ERRORS + 1))
  fi
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: view-registry-type-open found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: view-registry-type-open — type is DDL-open, validator is a type-dispatcher"
exit 0
