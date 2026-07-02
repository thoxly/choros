#!/usr/bin/env bash
# T-0573 (ADR-T0573 §1 correction, §2.1) · FF-4 — migrations/118_assistant_tenant_zero_backfill.sql
# must not contain a literal tenant-shaped UUID anywhere in executable SQL.
#
# WHY A NEW CHECK. The spec (T-0573-assistant-unlock.spec.md AC-3) assumed
# ci/checks/demo/no-hardcoded-tenant.sh and ci/checks/seed/no-hardcoded-fixture-ids.sh
# already cover migrations/ — the ADR corrects this: the former greps ONLY
# src/db/org.ts (resolveActorTenant/resolveTenantBySlug function bodies), the
# latter greps ONLY test directories. Neither scans migrations/. This check
# closes that gap for THIS task's migration (mirrors
# ci/checks/read-pdp-no-hardcoded-tenant.sh, T-0570's equivalent gate for
# migration 117 — same detector shape, same self-test discipline).
#
# THE CONTRACT: migrations/118_assistant_tenant_zero_backfill.sql MUST be
# set-driven (iterates `FROM choros.tenant`) and MUST NOT contain a literal
# tenant-shaped UUID (8-4-4-4-12 hex) anywhere in executable SQL (comments
# stripped — prose may legitimately discuss/quote a UUID shape as an example).
#
# Exit 0 on clean, non-zero on any violation. --self-test exercises the
# detector against planted good/bad fixtures.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
MIGRATION="${PROJECT_ROOT}/migrations/118_assistant_tenant_zero_backfill.sql"

# A tenant-shaped UUID literal (8-4-4-4-12 hex), single-quoted in SQL.
UUID_LITERAL_RE="'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'"

# Strip SQL `--` line comments so prose that legitimately discusses/quotes a
# UUID shape as an example does not trip the detector.
strip_sql_comments() {
  sed -E 's/--.*$//'
}

check_migration() {
  local file="$1" errors=0

  if [[ ! -f "${file}" ]]; then
    echo "FAIL [FF-4]: migration file not found: ${file}"
    return 1
  fi

  local code_only
  code_only="$(strip_sql_comments <"${file}")"

  # (1) MUST iterate choros.tenant — set-driven, not a fixed subset.
  if ! echo "${code_only}" | grep -qiE 'from[[:space:]]+choros\.tenant([[:space:]]|$)'; then
    echo "FAIL [FF-4]: no 'FROM choros.tenant' found — migration does not iterate every tenant"
    errors=$((errors + 1))
  fi

  # (2) MUST NOT contain any literal tenant-shaped UUID anywhere in executable SQL.
  local hardcoded
  hardcoded="$( (echo "${code_only}" | grep -oE "${UUID_LITERAL_RE}") || true )"
  if [[ -n "${hardcoded}" ]]; then
    echo "FAIL [FF-4]: hardcoded tenant-shaped UUID literal found in migration 118:"
    echo "${hardcoded}"
    errors=$((errors + 1))
  fi

  return ${errors}
}

self_test() {
  echo "[T-0573] no-hardcoded-tenant-uuid --self-test: planting good/bad fixtures"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  # GOOD fixture: iterates choros.tenant, no hardcoded UUID (mirrors migration 118's shape).
  cat >"${tmp}/good.sql" <<'EOF'
-- comment mentioning 'a0000000-0000-0000-0000-000000000001' as a cautionary example
INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
SELECT t.id, gen_random_uuid(), 'role-configurator', 'Конфигуратор системы', t.created_at, t.created_at
FROM choros.tenant t
LEFT JOIN choros.role r ON r.tenant_id = t.id AND r.slug = 'role-configurator'
WHERE r.id IS NULL
ON CONFLICT DO NOTHING;
EOF

  # BAD fixture: hardcodes a single tenant UUID (migration 088 anti-pattern).
  cat >"${tmp}/bad.sql" <<'EOF'
INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
VALUES ('a0000000-0000-0000-0000-000000000001', gen_random_uuid(), 'role-configurator', 'Конфигуратор системы', 0, 0)
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

echo "[T-0573] no-hardcoded-tenant-uuid: FF-4 migration-118 tenant-iteration check"
set +e
check_migration "${MIGRATION}"
errors=$?
set -e
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: no-hardcoded-tenant-uuid found ${errors} violation(s)"
  exit 1
fi
echo "PASS: no-hardcoded-tenant-uuid — migration 118 iterates choros.tenant, no hardcoded tenant UUID"
exit 0
