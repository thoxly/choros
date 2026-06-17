#!/usr/bin/env bash
# T-0246 · FF-10 — field-mask hook-point: records.ts must call checkWriteMask (AC-10)
#
# Static check for the B-11 wire-up hook-point:
#   - IF src/http/records.ts EXISTS → checkWriteMask MUST be called in it.
#   - IF src/http/records.ts does NOT EXIST → PASS with documented gap (B-11 deferred).
#
# Rationale: prevents B-11 (record-CRUD REST) from landing without wiring
# the field-mask guard — the gate bites BEFORE the first PR that creates records.ts.
#
# SELF-TEST (--self-test):
#   1. Create a temp records.ts WITHOUT checkWriteMask call → must FAIL (exit 1).
#   2. Create a temp records.ts WITH checkWriteMask call → must PASS (exit 0).
#   3. Remove temp files. Exit 2 if either demonstration fails.
#
# EXIT CODES: 0 pass · 1 violation · 2 self-test broken
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RECORDS_FILE="${ROOT}/src/http/records.ts"
HOOKPOINT_PATTERN='checkWriteMask('

echo "[T-0246 FF-10] field-mask-hookpoint: records.ts hook-point check"

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0246 FF-10] field-mask-hookpoint --self-test"

  HTTP_DIR="${ROOT}/src/http"
  mkdir -p "${HTTP_DIR}"
  TMP_RECORDS="${HTTP_DIR}/_t0246_hookpoint_probe.tmp.ts"
  trap 'rm -f "${TMP_RECORDS}"' EXIT

  # Self-test 1: records.ts WITHOUT checkWriteMask → must be detected as missing.
  printf '// PUT /api/records/:id\nexport function handleRecordUpdate() { return 200; }\n' > "${TMP_RECORDS}"
  if grep -qF "${HOOKPOINT_PATTERN}" "${TMP_RECORDS}"; then
    echo "SELF-TEST 1 FAIL: planted file WITHOUT checkWriteMask was falsely detected as passing — check is broken (exit 2)" >&2
    exit 2
  fi
  echo "[T-0246 FF-10] self-test 1 PASS: file without checkWriteMask is correctly detected as missing"

  # Self-test 2: records.ts WITH checkWriteMask → must PASS.
  printf '// PUT /api/records/:id\ncheckWriteMask(grantWriteFacet, requestedFields);\n' > "${TMP_RECORDS}"
  if ! grep -qF "${HOOKPOINT_PATTERN}" "${TMP_RECORDS}"; then
    echo "SELF-TEST 2 FAIL: planted file WITH checkWriteMask was not detected — check is broken (exit 2)" >&2
    exit 2
  fi
  echo "[T-0246 FF-10] self-test 2 PASS: file with checkWriteMask is correctly accepted"

  rm -f "${TMP_RECORDS}"
  trap - EXIT
  echo "[T-0246 FF-10] field-mask-hookpoint --self-test: all self-tests passed (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# MAIN CHECK
# ---------------------------------------------------------------------------
if [[ ! -f "${RECORDS_FILE}" ]]; then
  echo "PASS [FF-10]: src/http/records.ts does not exist — B-11 (record-CRUD REST) not yet landed."
  echo "  GAP (documented): when records.ts is created, checkWriteMask MUST be called in the"
  echo "  PUT handler before any field write. This check will enforce that automatically."
  exit 0
fi

echo "[FF-10] src/http/records.ts found — verifying checkWriteMask hook-point ..."

if grep -qF "${HOOKPOINT_PATTERN}" "${RECORDS_FILE}"; then
  echo "PASS [FF-10]: checkWriteMask is called in src/http/records.ts — field-mask hook-point wired."
  exit 0
else
  echo "FAIL [FF-10]: src/http/records.ts exists but does NOT call checkWriteMask." >&2
  echo "  REQUIRED: PUT /api/records/:id must call checkWriteMask(grantWriteFacet, requestedFields)" >&2
  echo "  before any field write (ADR T-0246 §2.3 / AC-10 / B-11 contract)." >&2
  exit 1
fi
