#!/usr/bin/env bash
# T-0581 (view registry) · FF-VR-1 — no new READ-path to choros.record bypassing PDP.
#
# THE CONTRACT (ADR §1/§4, FR-7): the ONLY SELECT that reads rows out of
# choros.record on the list/detail path lives in src/http/records.ts
# (listRecordsPaginated / getRecordDetail). The view-registry additions
# (src/core/view-query.ts, src/core/view-config.ts, src/http/list-views.ts)
# must NOT contain a second `FROM choros.record` SELECT — filters/sort are
# translated to SQL FRAGMENTS that records.ts's EXISTING query consumes, never
# a parallel query module that could drift out of the READ-PDP (isRecordReadable)
# + field-visibility + sandbox-gate pipeline.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

VIEW_QUERY="${ROOT}/src/core/view-query.ts"
VIEW_CONFIG="${ROOT}/src/core/view-config.ts"
LIST_VIEWS="${ROOT}/src/http/list-views.ts"
RECORDS="${ROOT}/src/http/records.ts"

ERRORS=0

echo "[FF-VR-1] view-registry-no-pdp-bypass: checking T-0581 no-second-READ-path"

for f in "${VIEW_QUERY}" "${VIEW_CONFIG}" "${LIST_VIEWS}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: ${f} does not exist"
    ERRORS=$((ERRORS + 1))
    continue
  fi
  if grep -qiE 'FROM[[:space:]]+choros\.record\b' "${f}"; then
    echo "FAIL (FF-VR-1): ${f} contains a 'FROM choros.record' SELECT — a second READ path to records, bypassing records.ts's PDP pipeline"
    grep -niE 'FROM[[:space:]]+choros\.record\b' "${f}" || true
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS: $(basename "${f}") does not select FROM choros.record"
  fi
done

# Sanity: records.ts itself MUST still be the (single) place that selects FROM
# choros.record for the list/detail path — this positively confirms the single
# READ path exists at all (not merely that the new files avoid it).
if [[ -f "${RECORDS}" ]] && grep -qiE 'FROM choros\.record r' "${RECORDS}"; then
  echo "PASS: records.ts still carries the (single) FROM choros.record r SELECT"
else
  echo "FAIL (FF-VR-1): records.ts does not contain the expected 'FROM choros.record r' SELECT — cannot confirm single READ path"
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: view-registry-no-pdp-bypass found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: view-registry-no-pdp-bypass — no second READ-path to choros.record"
exit 0
