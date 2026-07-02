#!/usr/bin/env bash
# T-0572 (rights UI writes) · FF-T0572-3 — screen-rights.jsx source switch.
#
# THE CONTRACT (ADR §2.3, AC-3): screen-rights.jsx must fetch the live
# GET /api/rights/tenant-state endpoint and must NOT fetch the old demo-pack /
# RIGHTS_SEED endpoint GET /api/rights (a bare, non-tenant-state literal).
#
# Checks the CURRENT content of web/src/screens/rights/screen-rights.jsx (not
# diff-scoped — this is a state assertion about the shipped file, mirroring
# demo/no-db-fallback.sh's style: what the file says NOW, not what changed).
#
# Exit 0 clean, non-zero on any violation. --self-test exercises the detector
# against synthetic good/bad fixture files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TARGET="${PROJECT_ROOT}/web/src/screens/rights/screen-rights.jsx"

# check_file <path> — sets `errors` global (bash 3.2 compatible).
check_file() {
  local file="$1"
  errors=0
  if [[ ! -f "${file}" ]]; then
    echo "FAIL [FF-T0572-3]: file not found: ${file}"
    errors=$((errors + 1))
    return
  fi
  if ! grep -qF "/api/rights/tenant-state" "${file}"; then
    echo "FAIL [FF-T0572-3]: ${file} does not fetch /api/rights/tenant-state"
    errors=$((errors + 1))
  fi
  # Bad: a fetch('/api/rights') literal WITHOUT the /tenant-state suffix.
  if grep -E "fetch\(['\"]\/api\/rights['\"]" "${file}" >/dev/null 2>&1; then
    echo "FAIL [FF-T0572-3]: ${file} still fetches the old demo-pack /api/rights endpoint"
    errors=$((errors + 1))
  fi
}

self_test() {
  echo "[T-0572] rights-overview-source-switch --self-test: synthetic fixtures"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  cat > "${tmp}/good.jsx" <<'EOF'
async function load() {
  const res = await fetch('/api/rights/tenant-state', { headers: {} });
  return res.json();
}
EOF
  check_file "${tmp}/good.jsx"
  local good_errors=${errors}

  cat > "${tmp}/bad.jsx" <<'EOF'
async function load() {
  const res = await fetch('/api/rights', { headers: {} });
  return res.json();
}
EOF
  check_file "${tmp}/bad.jsx"
  local bad_errors=${errors}

  if [[ ${good_errors} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD fixture (${good_errors} violation(s))"
    return 1
  fi
  if [[ ${bad_errors} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD fixture"
    return 1
  fi
  echo "SELF-TEST PASS: good fixture clean, bad fixture flagged (${bad_errors} violation(s))"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0572] rights-overview-source-switch: FF-T0572-3 source-switch gate"
check_file "${TARGET}"
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: rights-overview-source-switch found ${errors} violation(s)"
  exit 1
fi
echo "PASS: rights-overview-source-switch — screen-rights.jsx reads the live tenant-state endpoint"
exit 0
