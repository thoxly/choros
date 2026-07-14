#!/usr/bin/env bash
# T-0082 · E12.1 · Bundle Coherence CI Guard
#
# Verifies that every member of the bundle remains coherent:
#   - choros_table members: table exists in known_tenant_tables.txt AND
#     migration DDL contains the key invariant (whitespace-tolerant grep).
#   - external members: logged as [bundle-deferred], NOT an error (AC-6).
#   - bpmn-process member: delegated to bpmn-linter-isolation.sh (AC-5).
#
# Usage:
#   bundle-coherence.sh [MEMBERS_FILE]
#   MEMBERS_FILE  optional; default = $SCRIPT_DIR/bundle_members.txt
#
# Exit 0 — all choros_table members coherent, bpmn-linter passed, registry valid.
# Exit 1 — missing registry | bad format | missing table/DDL | bpmn-linter failed.
#
# AC-11: no T-0087 semantics here (T-0082 zone only).
# NF-4:  fail-closed on missing or malformed registry.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

MEMBERS_FILE="${1:-${SCRIPT_DIR}/bundle_members.txt}"
KNOWN_TABLES="${SCRIPT_DIR}/known_tenant_tables.txt"

ERRORS=0

# ---- Fail-closed: registry must exist (NF-4) --------------------------------
if [[ ! -f "${MEMBERS_FILE}" ]]; then
  echo "FAIL [bundle-coherence]: registry missing: ${MEMBERS_FILE}"
  exit 1
fi

if [[ ! -f "${KNOWN_TABLES}" ]]; then
  echo "FAIL [bundle-coherence]: known_tenant_tables.txt missing: ${KNOWN_TABLES}"
  exit 1
fi

# ---- Parse and validate registry -------------------------------------------
MEMBER_COUNT=0

while IFS= read -r raw_line; do
  # Strip trailing carriage return (Windows line endings)
  line="${raw_line%$'\r'}"
  # Skip comment lines and blank lines
  [[ "${line}" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue

  # Split on | — must be exactly 5 fields
  IFS='|' read -r name kind source table_or_path key_column <<< "${line}"

  # Validate field count: all 5 must be set (empty string → malformed)
  if [[ -z "${name}" || -z "${kind}" || -z "${source}" || -z "${table_or_path}" || -z "${key_column}" ]]; then
    echo "FAIL [bundle-coherence]: malformed registry line (expected 5 |-separated fields): ${line}"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  MEMBER_COUNT=$((MEMBER_COUNT + 1))

  case "${kind}" in
    choros_table)
      # (b) table must be in known_tenant_tables.txt
      if ! grep -qx "${table_or_path}" "${KNOWN_TABLES}"; then
        echo "FAIL [bundle-coherence]: member '${name}': table '${table_or_path}' not found in known_tenant_tables.txt"
        ERRORS=$((ERRORS + 1))
        continue
      fi

      # (c) DDL invariant in migration file (whitespace-tolerant: [[:space:]]+)
      MIGRATION_FILE="${PROJECT_ROOT}/${source}"
      if [[ ! -f "${MIGRATION_FILE}" ]]; then
        echo "FAIL [bundle-coherence]: member '${name}': migration file not found: ${MIGRATION_FILE}"
        ERRORS=$((ERRORS + 1))
        continue
      fi

      case "${name}" in
        object-schema)
          # AC-3: record_schema  jsonb NOT NULL (double-space in migration 004)
          if ! grep -Eq 'record_schema[[:space:]]+jsonb[[:space:]]+NOT[[:space:]]+NULL' "${MIGRATION_FILE}"; then
            echo "FAIL [bundle-coherence]: member '${name}': DDL invariant not found: record_schema ... jsonb ... NOT NULL in ${source}"
            ERRORS=$((ERRORS + 1))
          else
            echo "PASS [bundle-coherence]: member '${name}': table '${table_or_path}' in registry + DDL invariant verified"
          fi
          ;;
        grants)
          # AC-4: CREATE TABLE choros."grant" AND resource_type  text NOT NULL (double-space in 008)
          if ! grep -Eq 'CREATE TABLE[[:space:]]+choros\."grant"' "${MIGRATION_FILE}"; then
            echo "FAIL [bundle-coherence]: member '${name}': DDL invariant not found: CREATE TABLE choros.\"grant\" in ${source}"
            ERRORS=$((ERRORS + 1))
          elif ! grep -Eq 'resource_type[[:space:]]+text[[:space:]]+NOT[[:space:]]+NULL' "${MIGRATION_FILE}"; then
            echo "FAIL [bundle-coherence]: member '${name}': DDL invariant not found: resource_type ... text ... NOT NULL in ${source}"
            ERRORS=$((ERRORS + 1))
          else
            echo "PASS [bundle-coherence]: member '${name}': table '${table_or_path}' in registry + DDL invariant verified"
          fi
          ;;
        *)
          # Unknown choros_table member — still verify table exists (already done above)
          echo "PASS [bundle-coherence]: member '${name}': table '${table_or_path}' in registry (no named DDL invariant)"
          ;;
      esac
      ;;

    external)
      # AC-6: external members are not errors — log deferral and continue
      echo "[bundle-deferred] ${name}: see docs/design/T-0082-bundle-deferral-contract.md"
      ;;

    *)
      echo "FAIL [bundle-coherence]: member '${name}': unknown kind '${kind}' (expected choros_table or external)"
      ERRORS=$((ERRORS + 1))
      ;;
  esac
done < "${MEMBERS_FILE}"

# ---- Fail-closed: registry must have at least 5 members (FF-1 / AC-1) ------
if [[ "${MEMBER_COUNT}" -lt 5 ]]; then
  echo "FAIL [bundle-coherence]: registry has only ${MEMBER_COUNT} member(s); expected ≥5"
  ERRORS=$((ERRORS + 1))
fi

# ---- Fail-closed: object-schema member must be present (AC-9) ---------------
if ! grep -Ev '^[[:space:]]*#|^[[:space:]]*$' "${MEMBERS_FILE}" | grep -q '^object-schema|'; then
  echo "FAIL [bundle-coherence]: required member 'object-schema' not found in registry"
  ERRORS=$((ERRORS + 1))
fi

# ---- Delegate BPMN member to T-0027 bpmn-linter-isolation.sh (AC-5) --------
BPMN_LINTER="${SCRIPT_DIR}/bpmn-linter-isolation.sh"
if [[ -f "${BPMN_LINTER}" ]]; then
  if ! bash "${BPMN_LINTER}"; then
    echo "FAIL [bundle-coherence]: bpmn-linter-isolation.sh returned non-zero"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "FAIL [bundle-coherence]: bpmn-linter-isolation.sh not found at: ${BPMN_LINTER}"
  ERRORS=$((ERRORS + 1))
fi

# ---- Result -----------------------------------------------------------------
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL [bundle-coherence]: ${ERRORS} violation(s) found"
  exit 1
fi

echo "PASS [bundle-coherence]: all members coherent"
exit 0
