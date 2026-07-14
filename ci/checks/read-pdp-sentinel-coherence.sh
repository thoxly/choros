#!/usr/bin/env bash
# T-0570 (D3, READ-PDP) · FF-RP-15 — sentinel-literal coherence (ADR §10.3 p.4 / §4.1).
#
# RESOURCE_ROOT_NODE_ID is ONE literal living in THREE places (db-tests do not
# import from src/ by house pattern, so single-source is enforced by grep, not
# by import):
#   1. src/core/read-visibility.ts            (the exported constant — source of truth)
#   2. migrations/117_default_read_grant_backfill.sql (the seeded grant's scope)
#   3. ci/checks/db/bundle-coherence.test.ts  (the FF-13 sanctioned carve-out, T-0570 ADR §10)
# Drift in ANY of the three ⇒ red. --self-test plants good/bad fixtures.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

check_coherence() {
  local src="$1" mig="$2" carve="$3" errors=0 sentinel f
  sentinel="$(grep -oE 'RESOURCE_ROOT_NODE_ID = "[^"]+"' "${src}" 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)"/\1/')"
  if [[ -z "${sentinel}" ]]; then
    echo "FAIL [FF-RP-15]: cannot extract RESOURCE_ROOT_NODE_ID from ${src}"
    return 1
  fi
  for f in "${mig}" "${carve}"; do
    if ! grep -qF "${sentinel}" "${f}" 2>/dev/null; then
      echo "FAIL [FF-RP-15]: sentinel literal '${sentinel}' (from ${src}) not found in ${f} — drift"
      errors=$((errors + 1))
    fi
  done
  return ${errors}
}

self_test() {
  echo "[T-0570] read-pdp-sentinel-coherence --self-test: planting good/bad fixtures"
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' RETURN
  echo 'export const RESOURCE_ROOT_NODE_ID = "00000000-0000-0000-0000-0000000000r0";' > "${tmp}/src.ts"
  echo "scope nodeId '00000000-0000-0000-0000-0000000000r0'" > "${tmp}/good-mig.sql"
  echo "carve-out nodeId = '00000000-0000-0000-0000-0000000000r0'" > "${tmp}/good-carve.ts"
  echo "scope nodeId '00000000-0000-0000-0000-0000000000r1'" > "${tmp}/bad-mig.sql"
  local good_rc=0 bad_rc=0
  check_coherence "${tmp}/src.ts" "${tmp}/good-mig.sql" "${tmp}/good-carve.ts" >/dev/null || good_rc=$?
  check_coherence "${tmp}/src.ts" "${tmp}/bad-mig.sql" "${tmp}/good-carve.ts" >/dev/null || bad_rc=$?
  if [[ ${good_rc} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD (coherent) fixtures (rc=${good_rc})"; return 1
  fi
  if [[ ${bad_rc} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD (drifted-literal) fixture"; return 1
  fi
  echo "SELF-TEST PASS: coherent fixtures clean (rc=0), drifted fixture flagged (rc=${bad_rc})"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0570] read-pdp-sentinel-coherence: FF-RP-15 sentinel literal identical in 3 files"
errors=0
check_coherence \
  "${PROJECT_ROOT}/src/core/read-visibility.ts" \
  "${PROJECT_ROOT}/migrations/117_default_read_grant_backfill.sql" \
  "${PROJECT_ROOT}/ci/checks/db/bundle-coherence.test.ts" || errors=$?
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: read-pdp-sentinel-coherence found ${errors} drift(s)"
  exit 1
fi
echo "PASS: read-pdp-sentinel-coherence — RESOURCE_ROOT_NODE_ID literal coherent across read-visibility.ts / migration 117 / FF-13 carve-out"
exit 0
