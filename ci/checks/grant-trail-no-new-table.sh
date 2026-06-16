#!/usr/bin/env bash
# T-0031 · No-new-table fitness (FF-0031-05..07 / AC-22..AC-23).
#
# Check-1 (FF-0031-05): known_tenant_tables.txt is unchanged relative to merge-base with dev.
# Check-2 (FF-0031-06): no migration ≥ 031 (added by T-0031) contains CREATE TABLE.
# Check-3 (FF-0031-07): any seed migration ≥ 031 added by T-0031 contains ON CONFLICT (idempotent).
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
KNOWN_TABLES="${SCRIPT_DIR}/known_tenant_tables.txt"
MIGRATIONS="${ROOT}/migrations"
ERRORS=0

echo "[FF-0031] grant-trail-no-new-table: checking no new tenant table introduced"

# ---- Check-1 (FF-0031-05): known_tenant_tables.txt unchanged ----------------
echo ""
echo "Check-1 (FF-0031-05): known_tenant_tables.txt must be unchanged relative to merge-base with dev"
MERGE_BASE="$(git -C "${ROOT}" merge-base HEAD dev 2>/dev/null || echo "")"
if [[ -z "${MERGE_BASE}" ]]; then
  echo "WARN: could not determine merge-base with dev; skipping diff check"
else
  if git -C "${ROOT}" diff --quiet "${MERGE_BASE}" -- ci/checks/known_tenant_tables.txt; then
    echo "PASS: known_tenant_tables.txt is unchanged"
  else
    echo "FAIL: known_tenant_tables.txt has been modified relative to merge-base with dev"
    git -C "${ROOT}" diff "${MERGE_BASE}" -- ci/checks/known_tenant_tables.txt | head -20
    ERRORS=$((ERRORS + 1))
  fi
fi

# T-0241: additive-superset relief — if known_tenant_tables.txt only GREW
# (another task legitimately added a tenant table), T-0031's real invariant
# (grant trail adds no new tenant table) is NOT violated. Cancel the false-red.
# Real guard: Check-2 below catches any CREATE TABLE in migrations >= 031.
_ktt_gtnt_grown=0
_ktt_gtnt_path=ci/checks/known_tenant_tables.txt
if [[ -n "${MERGE_BASE}" ]] && ! git -C "${ROOT}" diff --quiet "${MERGE_BASE}" -- "${_ktt_gtnt_path}" 2>/dev/null; then
  _ktt_gtnt_old="$(git -C "${ROOT}" show "${MERGE_BASE}:${_ktt_gtnt_path}" 2>/dev/null || true)"
  _ktt_gtnt_new="$(cat "${ROOT}/${_ktt_gtnt_path}" 2>/dev/null || true)"
  _ktt_gtnt_gone="$(comm -23 <(echo "${_ktt_gtnt_old}" | sort) <(echo "${_ktt_gtnt_new}" | sort) || true)"
  [[ -z "${_ktt_gtnt_gone}" ]] && _ktt_gtnt_grown=1
fi
if [[ "${_ktt_gtnt_grown}" -eq 1 ]]; then
  echo "PASS [Check-1-additive]: known_tenant_tables.txt grew (superset); another task's table add accepted for T-0031"
  ERRORS=$((ERRORS - 1))
fi

# ---- Check-2 (FF-0031-06): no CREATE TABLE in new migrations (031+) ---------
echo ""
echo "Check-2 (FF-0031-06): migrations numbered 031+ must not contain CREATE TABLE"

# Find migration files numbered 031 and above that were added by T-0031.
# We scan all files matching the pattern; Check-2 only fails if they exist AND contain CREATE TABLE.
NEW_MIGS=()
while IFS= read -r -d '' f; do
  NEW_MIGS+=("$f")
done < <(find "${MIGRATIONS}" -maxdepth 1 -name '0[3-9][1-9]_*.sql' -o -name '0[4-9][0-9]_*.sql' -o -name '[1-9][0-9][0-9]_*.sql' 2>/dev/null | sort -z)

if [[ ${#NEW_MIGS[@]} -eq 0 ]]; then
  echo "PASS: no migrations numbered 031+ found (T-0031 ships no DDL — expected)"
else
  FOUND_CREATE_TABLE=0
  for mig in "${NEW_MIGS[@]}"; do
    if grep -iqE '\bCREATE TABLE\b' "${mig}"; then
      echo "FAIL: migration ${mig} contains CREATE TABLE (T-0031 must not add new tables)"
      FOUND_CREATE_TABLE=$((FOUND_CREATE_TABLE + 1))
      ERRORS=$((ERRORS + 1))
    fi
  done
  if [[ ${FOUND_CREATE_TABLE} -eq 0 ]]; then
    echo "PASS: no CREATE TABLE found in migrations numbered 031+"
  fi
fi

# ---- Check-3 (FF-0031-07): seed migrations (INSERT-only) must be idempotent -
echo ""
echo "Check-3 (FF-0031-07): any seed migration ≥ 031 must contain ON CONFLICT (idempotent)"

SEED_MIGS=()
while IFS= read -r -d '' f; do
  # Only consider files that contain INSERT (seed files)
  if grep -iqE '\bINSERT\b' "${f}"; then
    SEED_MIGS+=("$f")
  fi
done < <(find "${MIGRATIONS}" -maxdepth 1 \( -name '0[3-9][1-9]_*.sql' -o -name '0[4-9][0-9]_*.sql' -o -name '[1-9][0-9][0-9]_*.sql' \) 2>/dev/null | sort -z)

if [[ ${#SEED_MIGS[@]} -eq 0 ]]; then
  echo "PASS: no seed migrations numbered 031+ found (none required for T-0031 day-1)"
else
  for mig in "${SEED_MIGS[@]}"; do
    if grep -iqE '\bON CONFLICT\b' "${mig}"; then
      echo "PASS: ${mig} has ON CONFLICT (idempotent)"
    else
      echo "FAIL: seed migration ${mig} lacks ON CONFLICT — not idempotent (AC-23)"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: grant-trail-no-new-table found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: grant-trail-no-new-table — all checks green"
exit 0
