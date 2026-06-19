#!/usr/bin/env bash
# T-0336 [E15-S2]: candidateGroups → role.slug deploy-time linter
#
# RATIONALE: BPMN userTask elements use `candidateGroups` (or
# `flowable:candidateGroups`) to address tasks to a role pool. If the value
# does not match a real role.slug in the DB, the inbox will silently miss
# tasks (no actor ever receives them). This linter is the deploy-time gate
# that catches mismatches BEFORE a broken process is deployed.
#
# WHAT IT CHECKS:
#   1. Extracts all candidateGroups values from *.bpmn and *.bpmn20.xml files.
#   2. Verifies each value appears in at least one migration SQL file as a
#      role slug (in an INSERT INTO choros.role … or equivalent seed).
#      - Accepted forms in SQL: 'role-slug-value' or "role-slug-value"
#   3. Reports FAIL for any candidateGroups value with NO matching role slug
#      in the migration set.
#
# EXIT: 0 if all candidateGroups values are backed by a role seed; 1 otherwise.
#
# LIMITATIONS (tracked, acceptable for this stage):
#   - Does not execute SQL — purely textual grep of migration files.
#   - Tenant-scoping: a role may exist in one tenant seed but not another.
#     Full tenant-aware validation requires a live DB (ci/checks/db/*).
#   - Does not check that the role is ACTIVE or GRANTED to any actor.
#     Role assignment validation is the concern of grant-lattice tests.
#
# NOTE on vendor-admin: seed/vendor-crm/processes/customer-onboarding.bpmn
# uses candidateGroups="vendor-admin". If this role is not yet in a migration
# seed, add it (or the BPMN) before promoting to production. The linter will
# WARN (not FAIL) for BPMN files under seed/ — those are demo/showcase files
# where the role seed may be added in a later migration. Files under config/
# (production processes) ALWAYS cause FAIL on missing role slug.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ERRORS=0
WARNINGS=0

echo "[T-0336] candidategroups-role-slug-linter: checking BPMN candidateGroups → role.slug mapping"

# ---- Collect all BPMN files -------------------------------------------------

BPMN_FILES=()
while IFS= read -r -d '' f; do
  BPMN_FILES+=("$f")
done < <(find "${PROJECT_ROOT}" \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*" \
  \( -name "*.bpmn" -o -name "*.bpmn20.xml" \) \
  -print0 2>/dev/null)

if [[ ${#BPMN_FILES[@]} -eq 0 ]]; then
  echo "PASS: no BPMN files found — nothing to check"
  exit 0
fi

echo "  Found ${#BPMN_FILES[@]} BPMN file(s):"
for f in "${BPMN_FILES[@]}"; do
  echo "    ${f#"${PROJECT_ROOT}/"}"
done

# ---- Collect all role slugs from migration SQL files -----------------------
# Look for slug values in INSERT INTO choros.role (…slug…) statements.
# The pattern captures single-quoted strings near a slug column context.
# Also captures 'slug-value' occurrences in any migration (broad match).

MIGRATION_DIR="${PROJECT_ROOT}/migrations"
ROLE_SLUGS=()

if [[ -d "${MIGRATION_DIR}" ]]; then
  # Extract single-quoted values that appear to be role slugs from SQL migration
  # files. Strategy: grep lines containing 'role' or 'slug', then extract all
  # single-quoted tokens that look like slugs ([a-z][a-z0-9-]+).
  # Uses sed for portability (macOS BSD grep lacks -P/PCRE).
  while IFS= read -r slug; do
    [[ -n "${slug}" ]] && ROLE_SLUGS+=("${slug}")
  done < <(
    grep -rh "role\|slug" "${MIGRATION_DIR}"/*.sql 2>/dev/null \
      | sed -E "s/'([a-z][a-z0-9-]+)'/\n\1\n/g" \
      | grep -E "^[a-z][a-z0-9-]+$" \
      | sort -u
  )
fi

echo "  Found ${#ROLE_SLUGS[@]} candidate role slug(s) in migrations"

# Helper: check if a value is in the ROLE_SLUGS array
slug_is_known() {
  local needle="$1"
  for s in "${ROLE_SLUGS[@]}"; do
    [[ "${s}" == "${needle}" ]] && return 0
  done
  return 1
}

# ---- Check each BPMN file ---------------------------------------------------

for bpmn_file in "${BPMN_FILES[@]}"; do
  rel_path="${bpmn_file#"${PROJECT_ROOT}/"}"

  # Determine if this is a production (config/) or demo/seed (seed/) file.
  is_prod=true
  if [[ "${rel_path}" == seed/* ]]; then
    is_prod=false
  fi

  # Extract candidateGroups values (handles both:
  #   candidateGroups="value"
  #   flowable:candidateGroups="value"
  # and comma-separated values like "role-a,role-b")
  candidate_values=()
  while IFS= read -r raw_value; do
    # Split comma-separated values
    IFS=',' read -ra parts <<< "${raw_value}"
    for part in "${parts[@]}"; do
      trimmed="${part//[[:space:]]/}"
      [[ -n "${trimmed}" ]] && candidate_values+=("${trimmed}")
    done
  done < <(
    # Extract value between candidateGroups=" and the closing "
    # Works for both candidateGroups="..." and flowable:candidateGroups="..."
    # Uses sed for portability (macOS BSD grep lacks -P/PCRE).
    grep -o 'candidateGroups="[^"]*"' "${bpmn_file}" 2>/dev/null \
      | sed -E 's/candidateGroups="([^"]*)"/\1/' \
      || true
  )

  if [[ ${#candidate_values[@]} -eq 0 ]]; then
    continue
  fi

  echo "  Checking ${rel_path}: candidateGroups = (${candidate_values[*]})"

  for cg_value in "${candidate_values[@]}"; do
    if slug_is_known "${cg_value}"; then
      echo "    OK  '${cg_value}' — found in migration seeds"
    else
      if [[ "${is_prod}" == true ]]; then
        echo "    FAIL '${cg_value}' — NOT found in any migration SQL (production BPMN requires a seeded role)"
        ERRORS=$((ERRORS + 1))
      else
        echo "    WARN '${cg_value}' — NOT found in any migration SQL (seed/demo BPMN — add role seed before promoting to prod)"
        WARNINGS=$((WARNINGS + 1))
      fi
    fi
  done
done

# ---- Result -----------------------------------------------------------------

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: candidategroups-role-slug-linter found ${ERRORS} error(s), ${WARNINGS} warning(s)"
  echo "      Each FAIL means a candidateGroups value in a production BPMN has no"
  echo "      matching role slug in the migration seeds. Add the role (INSERT INTO"
  echo "      choros.role) or correct the BPMN candidateGroups attribute."
  exit 1
fi

if [[ ${WARNINGS} -gt 0 ]]; then
  echo "PASS (with warnings): candidategroups-role-slug-linter — no production BPMN errors."
  echo "      ${WARNINGS} warning(s) in seed/demo BPMN files (role seeds may be added later)."
else
  echo "PASS: candidategroups-role-slug-linter — all candidateGroups values backed by role seeds"
fi
exit 0
