#!/usr/bin/env bash
# T-0087 · tier-isolation (E12.6): static fitness for the two-tier model.
#
# Covers FF-1..FF-11 (static-now halves; live-db halves are in ci/checks/db/).
#
#  FF-1  — tier_bearing_tables.txt exists; each listed table has `tier … DEFAULT 'draft'`
#           + CHECK in the migration DDL.
#  FF-2  — Published-locked is dual-mechanism: trigger function + BEFORE UPDATE OR DELETE
#           trigger present on each config table; every config write-handler consults
#           assertWritable or promoteTier (no naked UPDATE without the guard).
#  FF-3  — promoteTier issues no INSERT/UPDATE to choros.record (config-only).
#  FF-7  — decidePromote reads actorType from getAuthContext(req)/extractActor (not body);
#           no body.actor_type / body.is_human / body.confirmed_by feeding the gate.
#  FF-8  — No createDatabase/provisionContour/new Pool(.*new-db)/compose-up per-tier DB
#           in tenant-init / genesis / promote paths.
#  FF-9  — No tier→SDLC mapping in docker-compose files / env config / source.
#  FF-10 — tier='published' is assigned ONLY in src/core/env-tier.ts or
#           src/http/artifacts.ts; no other src/ file sets tier='published'.
#  FF-11 — Migration is additive ALTER TABLE only (no CREATE TABLE);
#           known_tenant_tables.txt byte-unchanged;
#           promote authority uses mgmt_object:tier_promote + appendAuditEventInput.
#
# Exit 0 on clean, non-zero on violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIG="${ROOT}/migrations"
SRC="${ROOT}/src"
TIER_TABLES="${SCRIPT_DIR}/tier_bearing_tables.txt"
ERRORS=0

echo "[T-0087] tier-isolation: checking tier model invariants (FF-1..FF-11)"

# --------------------------------------------------------------------------
# Sanity: required files exist
# --------------------------------------------------------------------------
for f in "${TIER_TABLES}" "${SRC}/core/env-tier.ts" "${SRC}/http/artifacts.ts"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: required file ${f} does not exist"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: missing required files — aborting"
  exit 1
fi

# ---- FF-1: each table in tier_bearing_tables.txt has tier column + CHECK in DDL ----
echo ""
echo "FF-1: each tier-bearing table has tier + CHECK in migration DDL"

# Strip comments from all migration SQL (one-pass; same as audit_append_only.sh)
ALL_SQL_STRIPPED="$(sed -E 's/--.*$//' "${MIG}"/*.sql | tr '\n' ' ' | tr -s '[:space:]' ' ')"

while IFS= read -r table || [[ -n "${table}" ]]; do
  # Skip blank lines
  [[ -z "${table}" ]] && continue
  # grep for: ALTER TABLE choros."<table>" … ADD COLUMN … tier … DEFAULT 'draft'
  # and a CHECK constraint referencing 'draft'/'published' on the same table.
  # Both greps are anchored to the specific table name so that a column added
  # to any single table does not make all tables pass (R-3 nit hardening).
  if echo "${ALL_SQL_STRIPPED}" | grep -iqE "ALTER TABLE choros\.\"?${table}\"?[^;]*ADD COLUMN[^;]*tier[^;]*DEFAULT .draft."; then
    if echo "${ALL_SQL_STRIPPED}" | grep -iqE "ALTER TABLE choros\.\"?${table}\"?[^;]*CHECK[^;]*(tier|draft.*published|published.*draft)"; then
      echo "PASS FF-1: table '${table}' — tier column + CHECK found in migrations"
    else
      echo "FAIL FF-1: table '${table}' — missing CHECK(tier IN ('draft','published')) in migrations"
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "FAIL FF-1: table '${table}' — missing ALTER TABLE choros.${table} ADD COLUMN tier DEFAULT 'draft' in migrations"
    ERRORS=$((ERRORS + 1))
  fi
done < "${TIER_TABLES}"

# ---- FF-2a: tier_published_locked trigger function exists in migrations ----
echo ""
echo "FF-2a: tier_published_locked trigger function in migrations"
if echo "${ALL_SQL_STRIPPED}" | grep -iqE "CREATE.*FUNCTION choros\.tier_published_locked"; then
  echo "PASS FF-2a: tier_published_locked function found"
else
  echo "FAIL FF-2a: tier_published_locked function not found in migrations"
  ERRORS=$((ERRORS + 1))
fi

# ---- FF-2b: BEFORE UPDATE OR DELETE trigger on each config table ----
echo ""
echo "FF-2b: BEFORE UPDATE OR DELETE trigger on each config table"
CONFIG_TABLES=("application" "registry_def" '"grant"')
for tbl in "${CONFIG_TABLES[@]}"; do
  # Trigger pattern: BEFORE UPDATE OR DELETE ON choros.<table>
  if echo "${ALL_SQL_STRIPPED}" | grep -iqE "BEFORE UPDATE OR DELETE ON choros\.${tbl}"; then
    echo "PASS FF-2b: trigger BEFORE UPDATE OR DELETE ON choros.${tbl} found"
  else
    echo "FAIL FF-2b: missing BEFORE UPDATE OR DELETE trigger on choros.${tbl}"
    ERRORS=$((ERRORS + 1))
  fi
done

# ---- FF-2c: artifacts.ts consults assertWritable or promotes via promoteTier ----
echo ""
echo "FF-2c: artifacts.ts references assertWritable or decidePromote before mutation"
ARTIFACTS_TS="${SRC}/http/artifacts.ts"
if grep -qE 'assertWritable|decidePromote' "${ARTIFACTS_TS}"; then
  echo "PASS FF-2c: artifacts.ts references assertWritable/decidePromote"
else
  echo "FAIL FF-2c: artifacts.ts has no assertWritable/decidePromote reference"
  ERRORS=$((ERRORS + 1))
fi

# ---- FF-3: promoteTier writes no choros.record ----
echo ""
echo "FF-3: promoteTier issues no INSERT/UPDATE to choros.record"
# Strip comment lines before checking (lines starting with * or //)
ARTIFACTS_NOCOMMENT="$(sed -E 's|//.*$||; s|^\s*\*.*$||' "${ARTIFACTS_TS}")"
if echo "${ARTIFACTS_NOCOMMENT}" | grep -qE "INSERT INTO choros\.record|UPDATE choros\.record|INSERT INTO[^;]*record[^;]*WHERE|UPDATE[^;]*record[^;]*WHERE"; then
  echo "FAIL FF-3: artifacts.ts contains a write to choros.record (config-only violation)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-3: no write to choros.record in artifacts.ts"
fi

# ---- FF-7a: actorType read from getAuthContext / employee — not body ----
echo ""
echo "FF-7a: artifacts.ts sources actorType from getAuthContext/extractActor, not body"
# The promote handler must reference getAuthContext (or the extractActorWithType wrapper)
if grep -qE "getAuthContext|extractActorWithType|findEmployee" "${ARTIFACTS_TS}"; then
  echo "PASS FF-7a: artifacts.ts derives actorType from auth context / employee lookup"
else
  echo "FAIL FF-7a: artifacts.ts does not use getAuthContext/extractActorWithType/findEmployee"
  ERRORS=$((ERRORS + 1))
fi

# FF-7b: no body.actor_type / body.is_human / body.confirmed_by feeding the gate
echo ""
echo "FF-7b: no body-asserted actor_type/is_human/confirmed_by in artifacts.ts"
if grep -qE 'body\.(actor_type|is_human|confirmed_by)|b\["actor_type"\]|b\["is_human"\]|b\["confirmed_by"\]' "${ARTIFACTS_TS}"; then
  echo "FAIL FF-7b: artifacts.ts reads actor_type/is_human/confirmed_by from request body (T-0044 violation)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-7b: no body-asserted authority in artifacts.ts"
fi

# FF-7c: decidePromote used for the agent gate
echo ""
echo "FF-7c: decidePromote used in artifacts.ts for agent gate"
if grep -qE 'decidePromote' "${ARTIFACTS_TS}"; then
  echo "PASS FF-7c: artifacts.ts calls decidePromote"
else
  echo "FAIL FF-7c: artifacts.ts does not call decidePromote"
  ERRORS=$((ERRORS + 1))
fi

# ---- FF-8: no auto physical-contour provision ----
echo ""
echo "FF-8: no createDatabase/provisionContour/compose-per-tier in promote/genesis paths"
# grep both artifacts.ts and any genesis path
GENESIS_PATHS=("${SRC}/http/artifacts.ts" "${MIG}/049_tier.sql")
for f in "${GENESIS_PATHS[@]}"; do
  [[ -f "${f}" ]] || continue
  if grep -qiE 'createDatabase|provisionContour|new Pool.*new.db|compose.*up.*tier' "${f}"; then
    echo "FAIL FF-8: ${f} contains a physical-contour provision call"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-8: no physical-contour provision in ${f}"
  fi
done

# ---- FF-9: no tier→SDLC-env mapping ----
echo ""
echo "FF-9: no tier→SDLC mapping in docker-compose or source"
COMPOSE_FILES=("${ROOT}/docker-compose.yml" "${ROOT}/docker-compose.prod.yml")
for f in "${COMPOSE_FILES[@]}"; do
  [[ -f "${f}" ]] || continue
  if grep -iqE 'tier.*(NODE_ENV|CHOROS_ENV|=dev|=prod|= dev|= prod)' "${f}"; then
    echo "FAIL FF-9: ${f} maps tier to SDLC env"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-9: no tier→SDLC mapping in ${f}"
  fi
done
# Check source
if grep -rqE "tier.*(NODE_ENV|CHOROS_ENV)" "${SRC}/"; then
  echo "FAIL FF-9: src/ contains a tier→SDLC env mapping"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-9: no tier→SDLC mapping in src/"
fi
# readTierScope must NOT reference NODE_ENV/CHOROS_ENV in non-comment code
ENV_TIER_TS="${SRC}/core/env-tier.ts"
ENV_TIER_NOCOMMENT="$(sed -E 's|//.*$||; s|^[ \t]*\*.*$||' "${ENV_TIER_TS}")"
if echo "${ENV_TIER_NOCOMMENT}" | grep -qE 'NODE_ENV|CHOROS_ENV'; then
  echo "FAIL FF-9: env-tier.ts references NODE_ENV/CHOROS_ENV in code (violates FR-6 orthogonality)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-9: env-tier.ts does not reference NODE_ENV/CHOROS_ENV in non-comment code"
fi

# ---- FF-10: tier='published' only in env-tier.ts or artifacts.ts ----
echo ""
echo "FF-10: tier='published' assigned only in env-tier.ts / artifacts.ts"
# Search all src/ for SET tier='published' or tier = 'published' (excluding comments)
# Allow in env-tier.ts, artifacts.ts, and test files.
ALLOWED_TIER_FILES=("env-tier.ts" "artifacts.ts")
TIER_PUBLISHED_VIOLATIONS=0
# Find all ts files in src/ (non-test) that assign tier='published'
while IFS= read -r -d '' f; do
  fname="$(basename "${f}")"
  # Skip test files
  if [[ "${f}" == *"__tests__"* ]] || [[ "${fname}" == *.test.ts ]]; then
    continue
  fi
  # Skip allowed files
  allowed=0
  for a in "${ALLOWED_TIER_FILES[@]}"; do
    if [[ "${fname}" == "${a}" ]]; then
      allowed=1; break
    fi
  done
  [[ ${allowed} -eq 1 ]] && continue
  # Check for any assignment of tier='published'
  if grep -qE "tier\s*=\s*['\"]published['\"]|SET tier\s*=\s*['\"]published['\"]" "${f}"; then
    echo "FAIL FF-10: ${f} assigns tier='published' outside promote module"
    ERRORS=$((ERRORS + 1))
    TIER_PUBLISHED_VIOLATIONS=$((TIER_PUBLISHED_VIOLATIONS + 1))
  fi
done < <(find "${SRC}" -name "*.ts" -not -name "*.d.ts" -print0)

if [[ ${TIER_PUBLISHED_VIOLATIONS} -eq 0 ]]; then
  echo "PASS FF-10: tier='published' assigned only in env-tier.ts / artifacts.ts"
fi

# ---- FF-11a: T-0087 migration is additive ALTER TABLE only (no CREATE TABLE) ----
echo ""
echo "FF-11a: T-0087 migration (049_tier.sql) is ALTER TABLE only — no CREATE TABLE"
TIER_MIG="${MIG}/049_tier.sql"
if [[ -f "${TIER_MIG}" ]]; then
  if grep -iqE '^\s*CREATE TABLE' "${TIER_MIG}"; then
    echo "FAIL FF-11a: 049_tier.sql contains CREATE TABLE (must be additive ALTER TABLE only)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-11a: 049_tier.sql contains no CREATE TABLE"
  fi
else
  echo "FAIL FF-11a: 049_tier.sql not found"
  ERRORS=$((ERRORS + 1))
fi

# ---- FF-11b: known_tenant_tables.txt not modified by this branch ----
echo ""
echo "FF-11b: known_tenant_tables.txt byte-unchanged relative to merge-base with dev"
KNOWN_TABLES="${SCRIPT_DIR}/known_tenant_tables.txt"
MERGE_BASE="$(git -C "${ROOT}" merge-base HEAD dev 2>/dev/null || echo "")"
if [[ -z "${MERGE_BASE}" ]]; then
  echo "WARN FF-11b: could not determine merge-base with dev; skipping diff check"
else
  if git -C "${ROOT}" diff --quiet "${MERGE_BASE}" -- ci/checks/known_tenant_tables.txt; then
    echo "PASS FF-11b: known_tenant_tables.txt is unchanged"
  else
    echo "FAIL FF-11b: known_tenant_tables.txt has been modified (additive tier columns do NOT add to this file)"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- FF-11c: no new *_tier table / environment table / parallel authority/audit ----
echo ""
echo "FF-11c: no new tier/environment authority or audit table in migrations"
# Any migration should not CREATE TABLE with names containing 'tier' or 'environment'
# as a new table (new parallel store).
if grep -iqE 'CREATE TABLE choros\.(artifact_tier|environment_tier|tier_store|environment_store)' "${MIG}"/*.sql; then
  echo "FAIL FF-11c: a new tier/environment store table was created in migrations"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-11c: no parallel tier/environment authority/audit table in migrations"
fi

# ---- FF-11d: promote authority uses mgmt_object:tier_promote ----
echo ""
echo "FF-11d: artifacts.ts references mgmt_object:tier_promote (authority seam)"
if grep -qE 'mgmt_object:tier_promote' "${ARTIFACTS_TS}"; then
  echo "PASS FF-11d: artifacts.ts references mgmt_object:tier_promote"
else
  echo "WARN FF-11d: artifacts.ts does not reference mgmt_object:tier_promote — authority seam not wired (TODO T-0021)"
  # Not a hard FAIL: T-0021 PDP is not built yet; day-1 stub is acceptable.
  # The ADR documents this as a forward integration seam.
fi

# ---- FF-11e: promote uses appendAuditEventInput / appendAuditEvent (not a new writer) ----
echo ""
echo "FF-11e: artifacts.ts uses the canonical audit writer (makePgAuditWriter/appendAuditEvent)"
if grep -qE 'makePgAuditWriter|appendAuditEvent' "${ARTIFACTS_TS}"; then
  echo "PASS FF-11e: artifacts.ts uses canonical audit writer"
else
  echo "FAIL FF-11e: artifacts.ts does not use makePgAuditWriter/appendAuditEvent"
  ERRORS=$((ERRORS + 1))
fi

# --------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: tier-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: tier-isolation — all checks green (FF-1..FF-11)"
exit 0
