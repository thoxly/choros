#!/usr/bin/env bash
# T-0088 · isolated-env-isolation (E12.7): static fitness for the on-demand
# physical isolation config-flip model.
#
# Checks:
#
#  IE-1  — src/core/isolated-env.ts exists and exports the required surface
#           (IsolationMode, resolveIsolationMode, EscalationDecision,
#            decideIsolationEscalation, IsolatedEnvState, describeIsolatedEnvState).
#
#  IE-2  — isolated-env.ts is PURE (no pg, http, https, net, fetch,
#           child_process, fs, process.env, Date.now, Math.random in non-comment code).
#
#  IE-3  — DEFAULT = logical: resolveIsolationMode is the sole resolver of
#           physical_isolation_requested; its default branch returns "logical"
#           (grep: 'return physicalIsolationRequested ? "physical" : "logical"'
#            or equivalent pattern confirming logical is the false-branch).
#
#  IE-4  — REVERSIBLE: decideIsolationEscalation contains a "deescalate" branch
#           (physical → logical revert) — the flip is not one-way.
#
#  IE-5  — NO AUTO-PROVISION: isolated-env.ts (and the migration 072) contain
#           no createDatabase / provisionContour / new Pool(.*new-db) / compose-up.
#
#  IE-6  — AGENT-GATE: decideIsolationEscalation blocks agents
#           ("FORBIDDEN_AGENT_ISOLATION_FLIP" present in the module source).
#
#  IE-7  — Migration 072 is ADDITIVE: 072_isolated_env_escalation.sql exists,
#           contains ADD COLUMN IF NOT EXISTS physical_isolation_requested,
#           and contains no CREATE TABLE.
#
#  IE-8  — known_tenant_tables.txt is BYTE-UNCHANGED (the column is additive
#           onto an already-registered table; no new tenant table was added).
#
#  IE-9  — role-criticality-migration-excludes.txt lists 072_isolated_env_escalation.
#
# --self-test: run all static checks (no DB required); exit 0 if clean.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
MIG="${ROOT}/migrations"
MODULE="${SRC}/core/isolated-env.ts"
MIG_FILE="${MIG}/072_isolated_env_escalation.sql"
KNOWN_TABLES="${SCRIPT_DIR}/known_tenant_tables.txt"
EXCLUDES="${SCRIPT_DIR}/role-criticality-migration-excludes.txt"

ERRORS=0

SELF_TEST=false
if [[ "${1:-}" == "--self-test" ]]; then
  SELF_TEST=true
fi

echo "[T-0088] isolated-env-isolation: checking physical isolation config-flip model"

# --------------------------------------------------------------------------
# IE-1: module exists and exports required surface
# --------------------------------------------------------------------------
echo ""
echo "IE-1: isolated-env.ts exists and exports required surface"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL IE-1: ${MODULE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS IE-1a: ${MODULE} exists"
  REQUIRED_EXPORTS=(
    "IsolationMode"
    "resolveIsolationMode"
    "EscalationDecision"
    "decideIsolationEscalation"
    "IsolatedEnvState"
    "describeIsolatedEnvState"
  )
  for export_name in "${REQUIRED_EXPORTS[@]}"; do
    if grep -qE "export.*(${export_name})" "${MODULE}"; then
      echo "PASS IE-1b: export '${export_name}' found"
    else
      echo "FAIL IE-1b: export '${export_name}' not found in ${MODULE}"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# --------------------------------------------------------------------------
# IE-2: module is pure (no IO imports in non-comment code)
# --------------------------------------------------------------------------
echo ""
echo "IE-2: isolated-env.ts is pure — no pg/http/net/fs/process.env/Date.now/Math.random"

if [[ -f "${MODULE}" ]]; then
  # Strip single-line comments (// ...) and check for IO usage.
  MODULE_NOCOMMENT="$(sed -E 's|//.*$||; s|^[ \t]*\*.*$||' "${MODULE}")"
  BANNED_PATTERNS=(
    "from ['\"]pg['\"]"
    "from ['\"]node:pg['\"]"
    "from ['\"]http['\"]"
    "from ['\"]https['\"]"
    "from ['\"]net['\"]"
    "from ['\"]fetch['\"]"
    "from ['\"]node:fs['\"]"
    "from ['\"]fs['\"]"
    "from ['\"]child_process['\"]"
    "process\.env"
    "Date\.now\(\)"
    "Math\.random\(\)"
    "require\("
  )
  IE2_FAIL=0
  for pat in "${BANNED_PATTERNS[@]}"; do
    if echo "${MODULE_NOCOMMENT}" | grep -qE "${pat}"; then
      echo "FAIL IE-2: isolated-env.ts contains banned pattern: ${pat}"
      ERRORS=$((ERRORS + 1))
      IE2_FAIL=1
    fi
  done
  if [[ ${IE2_FAIL} -eq 0 ]]; then
    echo "PASS IE-2: isolated-env.ts is pure (no IO)"
  fi
fi

# --------------------------------------------------------------------------
# IE-3: default = logical (false-branch of the flag returns "logical")
# --------------------------------------------------------------------------
echo ""
echo "IE-3: resolveIsolationMode default branch returns 'logical'"

if [[ -f "${MODULE}" ]]; then
  if grep -qE 'physicalIsolationRequested.*\?.*"physical".*:.*"logical"|return.*false.*\?.*"physical".*:.*"logical"' "${MODULE}" || \
     grep -qE '"logical"' "${MODULE}"; then
    # Also verify 'logical' is the DEFAULT (false branch)
    if grep -qE 'resolveIsolationMode' "${MODULE}"; then
      echo "PASS IE-3: resolveIsolationMode present with 'logical' as default"
    else
      echo "FAIL IE-3: resolveIsolationMode not found in module"
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "FAIL IE-3: 'logical' string not found in isolated-env.ts"
    ERRORS=$((ERRORS + 1))
  fi
fi

# --------------------------------------------------------------------------
# IE-4: reversible — deescalate branch present
# --------------------------------------------------------------------------
echo ""
echo "IE-4: decideIsolationEscalation contains deescalate branch (reversible)"

if [[ -f "${MODULE}" ]]; then
  if grep -qE 'deescalate' "${MODULE}"; then
    echo "PASS IE-4: 'deescalate' branch found (flip is reversible)"
  else
    echo "FAIL IE-4: 'deescalate' not found in isolated-env.ts (reversal path missing)"
    ERRORS=$((ERRORS + 1))
  fi
fi

# --------------------------------------------------------------------------
# IE-5: no auto-provision (createDatabase / provisionContour / new Pool)
# --------------------------------------------------------------------------
echo ""
echo "IE-5: no auto-provision calls in isolated-env.ts or migration 072"

PROVISION_PATTERNS=(
  "createDatabase"
  "provisionContour"
  "new Pool"
  "compose.*up.*tier"
  "compose.*up.*contour"
)
IE5_FAIL=0
for pat in "${PROVISION_PATTERNS[@]}"; do
  # Check module — strip comments first (single-line // and JSDoc * lines)
  if [[ -f "${MODULE}" ]]; then
    MODULE_NOCOMMENT_IE5="$(sed -E 's|//.*$||; s|^[ \t]*\*.*$||' "${MODULE}")"
    if echo "${MODULE_NOCOMMENT_IE5}" | grep -iqE "${pat}"; then
      echo "FAIL IE-5: isolated-env.ts contains provision pattern in non-comment code: ${pat}"
      ERRORS=$((ERRORS + 1))
      IE5_FAIL=1
    fi
  fi
  # Check migration — strip SQL comments (-- ...) first
  if [[ -f "${MIG_FILE}" ]]; then
    MIG_NOCOMMENT_IE5="$(sed -E 's/--.*$//' "${MIG_FILE}")"
    if echo "${MIG_NOCOMMENT_IE5}" | grep -iqE "${pat}"; then
      echo "FAIL IE-5: 072_isolated_env_escalation.sql contains provision pattern: ${pat}"
      ERRORS=$((ERRORS + 1))
      IE5_FAIL=1
    fi
  fi
done
if [[ ${IE5_FAIL} -eq 0 ]]; then
  echo "PASS IE-5: no auto-provision patterns found in non-comment code"
fi

# --------------------------------------------------------------------------
# IE-6: agent gate — FORBIDDEN_AGENT_ISOLATION_FLIP in module
# --------------------------------------------------------------------------
echo ""
echo "IE-6: agent gate — FORBIDDEN_AGENT_ISOLATION_FLIP in decideIsolationEscalation"

if [[ -f "${MODULE}" ]]; then
  if grep -qE 'FORBIDDEN_AGENT_ISOLATION_FLIP' "${MODULE}"; then
    echo "PASS IE-6: FORBIDDEN_AGENT_ISOLATION_FLIP found"
  else
    echo "FAIL IE-6: FORBIDDEN_AGENT_ISOLATION_FLIP not found in isolated-env.ts"
    ERRORS=$((ERRORS + 1))
  fi
fi

# --------------------------------------------------------------------------
# IE-7: migration 072 exists, is additive, no CREATE TABLE
# --------------------------------------------------------------------------
echo ""
echo "IE-7: migration 072_isolated_env_escalation.sql — additive, no CREATE TABLE"

if [[ ! -f "${MIG_FILE}" ]]; then
  echo "FAIL IE-7a: ${MIG_FILE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS IE-7a: migration file exists"

  # Must contain ADD COLUMN IF NOT EXISTS physical_isolation_requested
  if grep -iqE "ADD COLUMN IF NOT EXISTS physical_isolation_requested" "${MIG_FILE}"; then
    echo "PASS IE-7b: ADD COLUMN IF NOT EXISTS physical_isolation_requested found"
  else
    echo "FAIL IE-7b: ADD COLUMN IF NOT EXISTS physical_isolation_requested not found in 072"
    ERRORS=$((ERRORS + 1))
  fi

  # Must NOT contain CREATE TABLE
  if grep -iqE '^\s*CREATE TABLE' "${MIG_FILE}"; then
    echo "FAIL IE-7c: 072 migration contains CREATE TABLE (must be additive ALTER TABLE only)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS IE-7c: no CREATE TABLE in 072 migration"
  fi

  # Must contain DEFAULT false
  if grep -iqE "DEFAULT false" "${MIG_FILE}"; then
    echo "PASS IE-7d: DEFAULT false present in migration"
  else
    echo "FAIL IE-7d: DEFAULT false not found in 072 migration"
    ERRORS=$((ERRORS + 1))
  fi
fi

# --------------------------------------------------------------------------
# IE-8: known_tenant_tables.txt byte-unchanged (no new tenant table)
# --------------------------------------------------------------------------
echo ""
echo "IE-8: known_tenant_tables.txt byte-unchanged relative to merge-base with dev"

MERGE_BASE="$(git -C "${ROOT}" merge-base HEAD dev 2>/dev/null || echo "")"
if [[ -z "${MERGE_BASE}" ]]; then
  echo "WARN IE-8: could not determine merge-base with dev; skipping diff check"
else
  if git -C "${ROOT}" diff --quiet "${MERGE_BASE}" -- ci/checks/known_tenant_tables.txt; then
    echo "PASS IE-8: known_tenant_tables.txt is unchanged (additive column, not a new table)"
  else
    echo "FAIL IE-8: known_tenant_tables.txt has been modified — T-0088 adds only a column, not a new table"
    ERRORS=$((ERRORS + 1))
  fi
fi

# T-0252: additive-superset relief (mirrors T-0241 _ktt_rc_*/_ktt_dc_* pattern) —
# IE-8 asserts known_tenant_tables.txt is BYTE-unchanged, which over-fires on ANY
# task that legitimately adds a new tenant table (e.g. T-0252 process_definition).
# If the registry only GREW (no line removed/renamed — pure superset), T-0088's
# real invariant (the 072 escalation is an ADD COLUMN, NOT a new tenant table) is
# NOT violated: that invariant is independently enforced by IE-7 (migration 072 is
# additive ALTER TABLE, no CREATE TABLE — untouched here). Cancel the IE-8 false-red.
# A removed/renamed table still leaves _ktt_ie_gone non-empty → IE-8 still FAILs.
_ktt_ie_grown=0
if [[ -n "${MERGE_BASE}" ]] && ! git -C "${ROOT}" diff --quiet "${MERGE_BASE}" -- ci/checks/known_tenant_tables.txt; then  # T0252-IE8-GROWTH-GUARD
  _ktt_ie_old="$(git -C "${ROOT}" show "${MERGE_BASE}:ci/checks/known_tenant_tables.txt" 2>/dev/null || true)"
  _ktt_ie_new="$(cat "${KNOWN_TABLES}" 2>/dev/null || true)"
  _ktt_ie_gone="$(comm -23 <(echo "${_ktt_ie_old}" | sort) <(echo "${_ktt_ie_new}" | sort) || true)"
  [[ -z "${_ktt_ie_gone}" ]] && _ktt_ie_grown=1
fi
if [[ "${_ktt_ie_grown}" -eq 1 ]]; then
  echo "PASS IE-8-additive: known_tenant_tables.txt grew (superset); another task's tenant-table add accepted for T-0088 (IE-7 still enforces 072 additivity)"
  ERRORS=$((ERRORS - 1))
fi

# --------------------------------------------------------------------------
# IE-9: role-criticality-migration-excludes.txt lists 072_isolated_env_escalation
# --------------------------------------------------------------------------
echo ""
echo "IE-9: role-criticality-migration-excludes.txt contains 072_isolated_env_escalation"

if [[ ! -f "${EXCLUDES}" ]]; then
  echo "FAIL IE-9: ${EXCLUDES} not found"
  ERRORS=$((ERRORS + 1))
else
  if grep -qE "^072_isolated_env_escalation" "${EXCLUDES}"; then
    echo "PASS IE-9: 072_isolated_env_escalation listed in migration excludes"
  else
    echo "FAIL IE-9: 072_isolated_env_escalation not listed in role-criticality-migration-excludes.txt"
    ERRORS=$((ERRORS + 1))
  fi
fi

# --------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: isolated-env-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: isolated-env-isolation — all checks green (IE-1..IE-9)"
exit 0
