#!/usr/bin/env bash
# T-0582 (kanban view) · FF-K-3 — the ONLY write path a card move ever calls is
# the EXISTING PUT /api/records/:id (record-write parity T-0620). No new
# write endpoint (no /api/kanban/*, no /api/records/:id/field) is introduced.
#
# Exit 0 on clean, non-zero on any violation. --self-test exercises the
# detector against synthetic good/bad fixtures.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"


# require_put_ref=1 -> the file MUST itself contain the PUT /api/records/:id
# call (screen-app-records.jsx, which owns the actual fetch). require_put_ref=0
# -> the file only needs to be FREE of a second write path (kanban-board.jsx,
# which delegates the actual fetch to its injected onMoveRecord prop and is
# expected to contain NO fetch call at all — see kanban-board.jsx.test.js
# "kanban-board.jsx itself performs no fetch").
check_file() {
  local file="$1"
  local require_put_ref="$2"
  local errors=0
  if [[ ! -f "${file}" ]]; then
    echo "SKIP: ${file} does not exist"
    echo "0"
    return 0
  fi
  if [[ "${require_put_ref}" == "1" ]]; then
    if ! grep -qE "'PUT'" "${file}" || ! grep -qE '/api/records/\$\{encodeURIComponent\(' "${file}"; then
      echo "FAIL (FF-K-3a): ${file} does not PUT /api/records/:id"
      errors=$((errors + 1))
    fi
  fi
  # (b) must NOT reference a new kanban-specific write endpoint.
  if grep -qE '/api/kanban' "${file}"; then
    echo "FAIL (FF-K-3b): ${file} references a new /api/kanban/* endpoint"
    errors=$((errors + 1))
  fi
  # (c) must NOT reference a per-field write endpoint.
  if grep -qE '/api/records/[^"'"'"'\`]*\/field' "${file}"; then
    echo "FAIL (FF-K-3c): ${file} references a per-field write endpoint (/api/records/:id/field)"
    errors=$((errors + 1))
  fi
  echo "${errors}"
  return 0
}

check_no_second_server_route() {
  local errors=0
  if [[ -d "${ROOT}/src/http" ]]; then
    if grep -rlE 'router\.register\([^)]*["'"'"']\/api\/kanban' "${ROOT}/src/http" >/dev/null 2>&1; then
      echo "FAIL (FF-K-3d): src/http contains a router.register for /api/kanban/*"
      errors=$((errors + 1))
    fi
    if grep -rlE 'router\.register\(\s*"(PATCH|PUT|POST)"\s*,\s*"\/api\/records\/:id\/field"' "${ROOT}/src/http" >/dev/null 2>&1; then
      echo "FAIL (FF-K-3e): src/http registers a per-field record write route"
      errors=$((errors + 1))
    fi
  fi
  echo "${errors}"
  return 0
}

self_test() {
  echo "[T-0582] kanban-write-via-record-put --self-test"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  cat > "${tmp}/good.jsx" <<'EOF'
async function move(recordId, data) {
  const res = await fetch(`/api/records/${encodeURIComponent(recordId)}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
  return res;
}
EOF
  local good_errors
  good_errors="$(check_file "${tmp}/good.jsx" 1 | tail -1)"

  cat > "${tmp}/bad.jsx" <<'EOF'
async function move(recordId, value) {
  const res = await fetch(`/api/kanban/move`, {
    method: 'POST',
    body: JSON.stringify({ recordId, value }),
  });
  return res;
}
EOF
  local bad_errors
  bad_errors="$(check_file "${tmp}/bad.jsx" 1 | tail -1)"

  if [[ "${good_errors}" -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD file (${good_errors} violation(s))"
    return 1
  fi
  if [[ "${bad_errors}" -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD file"
    return 1
  fi
  echo "SELF-TEST PASS: good file clean, bad file flagged (${bad_errors} finding(s))"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0582] kanban-write-via-record-put: FF-K-3 (single record-write path)"

TOTAL_ERRORS=0
BOARD_FILE="${ROOT}/web/src/screens/kanban-board.jsx"
SCREEN_FILE="${ROOT}/web/src/screens/screen-app-records.jsx"

BOARD_ERRORS="$(check_file "${BOARD_FILE}" 0 | tail -1)"
TOTAL_ERRORS=$((TOTAL_ERRORS + BOARD_ERRORS))
SCREEN_ERRORS="$(check_file "${SCREEN_FILE}" 1 | tail -1)"
TOTAL_ERRORS=$((TOTAL_ERRORS + SCREEN_ERRORS))
ROUTE_ERRORS="$(check_no_second_server_route | tail -1)"
TOTAL_ERRORS=$((TOTAL_ERRORS + ROUTE_ERRORS))

if [[ ${TOTAL_ERRORS} -gt 0 ]]; then
  echo "FAIL: kanban-write-via-record-put found ${TOTAL_ERRORS} violation(s)"
  exit 1
fi
echo "PASS: kanban-write-via-record-put — kanban move uses only PUT /api/records/:id"
exit 0
