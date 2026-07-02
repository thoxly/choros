#!/usr/bin/env bash
# T-0570 (D3, READ-PDP) · FF-RP-6 — backfill migration 115 must iterate
# choros.tenant, NEVER hardcode a single tenant UUID (anti-pattern of
# migrations/088_configurator_authoring_draft_grant_seed.sql, which seeds ONLY
# the dev-silo tenant via a fixed literal UUID and silently fails to backfill
# any real self-registered tenant).
#
# THE CONTRACT (ADR §2.2 / FF-RP-6):
#   migrations/115_default_read_grant_backfill.sql MUST contain
#   `FROM choros.tenant` (an iteration source) in each of its INSERT ... SELECT
#   statements, and MUST NOT contain a literal tenant-shaped UUID
#   (8-4-4-4-12 hex) anywhere in a VALUES/tenant_id position.
#
# Distinguishes grep rc=1 (no match) from rc>=2 (error), mirrors the
# grep_noncomment discipline used by card-action-broad-scope.sh / other FF
# checks in this repo (T-0143 lesson: prose explaining a ban must not itself
# trip the detector — this migration's comments legitimately quote the banned
# UUID as an example of what NOT to do, so the detector below scans SQL
# statement lines only, skipping `--` comment lines).
#
# Exit 0 on clean, non-zero on any violation. --self-test exercises the
# detector against planted good/bad fixtures (FF-RP-6 self-test discipline).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIGRATION="${PROJECT_ROOT}/migrations/115_default_read_grant_backfill.sql"

# A tenant-shaped UUID literal (8-4-4-4-12 hex), quoted in SQL (single-quoted).
UUID_LITERAL_RE="'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'"

# Strip SQL `--` line comments (everything from the first `--` to end of line)
# so prose that legitimately quotes migration 088's banned UUID as a
# cautionary example does not trip the detector (mirrors card-action-broad-
# scope.sh's grep_noncomment discipline, adapted to SQL comment syntax).
strip_sql_comments() {
  sed -E 's/--.*$//'
}

check_migration() {
  local file="$1" errors=0

  if [[ ! -f "${file}" ]]; then
    echo "FAIL [FF-RP-6]: migration file not found: ${file}"
    return 1
  fi

  local code_only
  code_only="$(strip_sql_comments <"${file}")"

  # (1) MUST iterate choros.tenant — every INSERT ... SELECT must draw its rows
  #     from `FROM choros.tenant` (case-insensitive, alias-tolerant).
  if ! echo "${code_only}" | grep -qiE 'from[[:space:]]+choros\.tenant([[:space:]]|$)'; then
    echo "FAIL [FF-RP-6]: no 'FROM choros.tenant' found — migration does not iterate every tenant"
    errors=$((errors + 1))
  fi

  # (2) MUST NOT contain a literal tenant-shaped UUID anywhere in executable SQL
  #     (comments stripped above) EXCEPT the RESOURCE_ROOT_NODE_ID platform
  #     sentinel itself, which is an intentional, tenant-agnostic constant (not
  #     a specific tenant's id) — allow-list exactly that one literal.
  local resource_root_sentinel="00000000-0000-0000-0000-0000000000r0"
  local hardcoded
  hardcoded="$( (echo "${code_only}" | grep -oE "${UUID_LITERAL_RE}" | tr -d "'" | grep -v "^${resource_root_sentinel}\$") || true )"
  if [[ -n "${hardcoded}" ]]; then
    echo "FAIL [FF-RP-6]: hardcoded tenant-shaped UUID literal found in migration 115 (anti-pattern of migration 088):"
    echo "${hardcoded}"
    errors=$((errors + 1))
  fi

  return ${errors}
}

self_test() {
  echo "[T-0570] read-pdp-no-hardcoded-tenant --self-test: planting good/bad fixtures"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  # GOOD fixture: iterates choros.tenant, no hardcoded UUID (mirrors the real
  # migration's shape).
  cat >"${tmp}/good.sql" <<'EOF'
-- comment mentioning 'a0000000-0000-0000-0000-000000000001' as a cautionary example
INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
SELECT t.id, gen_random_uuid(), 'role-reader', 'Reader', t.created_at, t.created_at
FROM choros.tenant t
ON CONFLICT (tenant_id, slug) DO NOTHING;
EOF

  # BAD fixture: hardcodes a single tenant UUID (migration 088 anti-pattern).
  cat >"${tmp}/bad.sql" <<'EOF'
INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
VALUES ('a0000000-0000-0000-0000-000000000001', gen_random_uuid(), 'role-reader', 'Reader', 0, 0)
ON CONFLICT DO NOTHING;
EOF

  set +e
  check_migration "${tmp}/good.sql" >/dev/null 2>&1
  local good_rc=$?
  check_migration "${tmp}/bad.sql" >/dev/null 2>&1
  local bad_rc=$?
  set -e

  if [[ ${good_rc} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD fixture (rc=${good_rc})"
    return 1
  fi
  if [[ ${bad_rc} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD (hardcoded-tenant) fixture"
    return 1
  fi
  echo "SELF-TEST PASS: good fixture clean (rc=0), bad fixture flagged (rc=${bad_rc})"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0570] read-pdp-no-hardcoded-tenant: FF-RP-6 migration-115 tenant-iteration check"
set +e
check_migration "${MIGRATION}"
errors=$?
set -e
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: read-pdp-no-hardcoded-tenant found ${errors} violation(s)"
  exit 1
fi
echo "PASS: read-pdp-no-hardcoded-tenant — migration 115 iterates choros.tenant, no hardcoded tenant UUID"
exit 0
