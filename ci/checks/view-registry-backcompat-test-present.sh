#!/usr/bin/env bash
# T-0581 (view registry) · FF-VR-6 — static presence check for the NF-2/AC-9
# backward-compatibility test (byte-identical GET /api/records when no view
# params are passed). Mirrors cross-tenant-fitness.sh's style: this is a
# STATIC guard that the regression test exists and asserts the right thing —
# the actual pass/fail proof runs via `npm test` (vitest), which `npm run
# build` earlier in the fitness chain does not exercise.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

BACKCOMPAT_TEST="${ROOT}/src/__tests__/records-view-application.test.ts"

ERRORS=0

echo "[FF-VR-6] view-registry-backcompat-test-present: checking T-0581 AC-9/NF-2 regression coverage"

if [[ ! -f "${BACKCOMPAT_TEST}" ]]; then
  echo "FAIL (FF-VR-6): ${BACKCOMPAT_TEST} does not exist"
  exit 1
fi

if grep -qE "AC-9/FF-VR-6" "${BACKCOMPAT_TEST}" && grep -qE "byte-identical default path" "${BACKCOMPAT_TEST}"; then
  echo "PASS (FF-VR-6a): backcompat describe block present"
else
  echo "FAIL (FF-VR-6a): expected AC-9/FF-VR-6 backcompat describe block not found in ${BACKCOMPAT_TEST}"
  ERRORS=$((ERRORS + 1))
fi

if grep -qE "ORDER BY r\.created_at DESC, r\.id ASC" "${BACKCOMPAT_TEST}"; then
  echo "PASS (FF-VR-6b): test asserts the exact pre-T-0581 default ORDER BY is unchanged"
else
  echo "FAIL (FF-VR-6b): test does not assert the default ORDER BY fragment"
  ERRORS=$((ERRORS + 1))
fi

if grep -qE "FROM choros\\\\\.list_view" "${BACKCOMPAT_TEST}" || grep -qE "queries\.some.*list_view" "${BACKCOMPAT_TEST}"; then
  echo "PASS (FF-VR-6c): test asserts NO list_view query runs on the default (no-params) path"
else
  echo "FAIL (FF-VR-6c): test does not assert absence of a list_view lookup on the default path"
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: view-registry-backcompat-test-present found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: view-registry-backcompat-test-present — AC-9/NF-2 regression test present and assertive"
exit 0
