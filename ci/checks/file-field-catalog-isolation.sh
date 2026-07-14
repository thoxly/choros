#!/usr/bin/env bash
# T-0579 · file-field-catalog-isolation — static fitness for the «Файл» field
# type's catalog dispatch + upload-route discipline.
#
# Static assertions (grep / boundary analysis — no runtime, no DB) over the
# T-0579 file-field wiring: web/src/screens/apps-schema.js,
# web/src/forms/field-contract.js, web/src/forms/field-renderer.jsx,
# src/core/binding-contract-catalog.ts. Mirrors card-action-isolation.sh /
# file-attachment-isolation.sh. Distinguishes grep rc=1 (no match) from rc>=2
# (error), and ignores comment lines so prose explaining a ban passes
# (lesson T-0143).
#
#  FF-CATALOG          — Единый каталог, не размножение (NF-1, AC-4): the file
#                        contract kind is declared EXACTLY ONCE in each catalog
#                        (client field-contract.js, server
#                        binding-contract-catalog.ts); contractKindForFieldType
#                        maps 'file'→'file'; NO second/parallel file-dispatch
#                        dictionary exists outside the catalog (no bespoke
#                        `inputKind === 'file'` switch driving a DIFFERENT
#                        component than FieldControl/resolveFieldContract).
#  FF-UPLOAD-ROUTE-ONLY — Loading ТОЛЬКО через POST /api/records/:recordId/files
#                        (FR-7, NF-2): the FileField component (and the file
#                        cell/card components consuming file metadata) contain
#                        NO direct S3/bucket/presign/PutObject/aws-sdk client
#                        construction; upload/list/download references only the
#                        existing /api/records/.../files and
#                        /api/files/.../download routes.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APPS_SCHEMA="${PROJECT_ROOT}/web/src/screens/apps-schema.js"
FIELD_CONTRACT="${PROJECT_ROOT}/web/src/forms/field-contract.js"
FIELD_RENDERER="${PROJECT_ROOT}/web/src/forms/field-renderer.jsx"
RECORDS_FORM="${PROJECT_ROOT}/web/src/screens/records-form.js"
SCREEN_RECORDS="${PROJECT_ROOT}/web/src/screens/screen-app-records.jsx"
SCREEN_DETAIL="${PROJECT_ROOT}/web/src/screens/screen-record-detail.jsx"
SERVER_CATALOG="${PROJECT_ROOT}/src/core/binding-contract-catalog.ts"
ERRORS=0

echo "[T-0579] file-field-catalog-isolation: checking catalog dispatch + upload-route discipline"

for f in "${APPS_SCHEMA}" "${FIELD_CONTRACT}" "${FIELD_RENDERER}" "${RECORDS_FORM}" "${SCREEN_RECORDS}" "${SCREEN_DETAIL}" "${SERVER_CATALOG}"; do
  if [[ ! -f "${f}" ]]; then
    echo "FAIL: ${f} does not exist"
    exit 1
  fi
done

# grep wrapper: returns matches, treats rc=1 (no match) as clean, rc>=2 as a hard error.
grep_noncomment() {
  local pattern="$1" file="$2" out rc
  set +e
  out="$(grep -nE "${pattern}" "${file}" | grep -vE '^[0-9]+:[[:space:]]*(//|\*)')"
  rc=$?
  set -e
  if [[ ${rc} -ge 2 ]]; then
    echo "ERROR: grep failed (rc=${rc}) on pattern '${pattern}' in ${file}"
    exit 2
  fi
  printf '%s' "${out}"
}

# ---- FF-CATALOG: single catalog, file declared once each side --------------
before=${ERRORS}

# Client catalog: exactly one `file:` descriptor entry in field-contract.js's
# BINDING_CONTRACT_CATALOG.
client_file_entries="$(grep -cE '^\s*file:\s*\{' "${FIELD_CONTRACT}" || true)"
if [[ "${client_file_entries}" != "1" ]]; then
  echo "FAIL [FF-CATALOG]: expected exactly one 'file:' catalog entry in field-contract.js, found ${client_file_entries}"
  ERRORS=$((ERRORS + 1))
fi

# Server catalog: exactly one `file:` descriptor entry in binding-contract-catalog.ts.
server_file_entries="$(grep -cE '^\s*file:\s*\{' "${SERVER_CATALOG}" || true)"
if [[ "${server_file_entries}" != "1" ]]; then
  echo "FAIL [FF-CATALOG]: expected exactly one 'file:' catalog entry in binding-contract-catalog.ts, found ${server_file_entries}"
  ERRORS=$((ERRORS + 1))
fi

# contractKindForFieldType must map 'file' → 'file' (exactly one case branch).
file_case_count="$(grep -cE "case 'file':" "${FIELD_CONTRACT}" || true)"
if [[ "${file_case_count}" != "1" ]]; then
  echo "FAIL [FF-CATALOG]: expected exactly one \"case 'file':\" branch in contractKindForFieldType, found ${file_case_count}"
  ERRORS=$((ERRORS + 1))
fi

# FieldControl must dispatch file via the catalog-derived `presentation` (the
# SAME resolveFieldContract() call every other structural contract uses) — not
# a second dispatch surface reading field.type/inputKind directly for 'file'.
if ! grep -qE "presentation === 'file'" "${FIELD_RENDERER}"; then
  echo "FAIL [FF-CATALOG]: field-renderer.jsx does not dispatch on presentation === 'file' (catalog-driven)"
  ERRORS=$((ERRORS + 1))
fi

# No SECOND file-dispatch dictionary: a bespoke branch keyed on
# `contractKind === 'file'` that RETURNS/RENDERS a DIFFERENT top-level
# component than FieldControl would be a parallel rendering mechanism (spec
# §2, NF-1) — the same shape relation/collection/rollup use for THEIR OWN
# dedicated components (`if (contractKind === 'relation') return <RelationPicker.../>`).
# file has NO such branch: it flows through the generic FieldControl
# fallthrough (form) and the FILE_CELL_ASYNC sentinel (list/card, mirroring
# RELATION_CELL_ASYNC's async-cell resolution — not a second renderer).
# screen-app-records.jsx DOES reference `contractKind === 'file'` once, but
# only to thread `recordId` onto the field descriptor BEFORE calling
# `<FieldControl>` — both branches of that ternary still render the SAME
# component. The forbidden shape is specifically `contractKind === 'file'`
# immediately followed by a `return (\n  <SomeOtherComponent` — i.e. an early
# return with a JSX element that is NOT FieldControl.
render_dispatch_files=(
  "${SCREEN_RECORDS}"
  "${SCREEN_DETAIL}"
)
for rf in "${render_dispatch_files[@]}"; do
  # Look for "contractKind === 'file'" followed within a few lines by
  # "return (" and a JSX tag that is NOT <FieldControl — that shape is the
  # forbidden parallel-dispatch pattern (mirrors how relation/collection/
  # rollup ARE allowed to do this for their OWN dedicated components).
  bad_branch="$(awk '
    /contractKind === .file./ { flag=NR; next }
    flag && NR - flag <= 4 && /return[[:space:]]*\(/ { pending=NR; next }
    pending && NR - pending <= 2 && /<[A-Za-z]/ && !/<FieldControl/ { print FILENAME ":" NR ": " $0; pending=0; flag=0 }
    NR - flag > 6 { flag=0 }
  ' "${rf}")"
  if [[ -n "${bad_branch}" ]]; then
    echo "FAIL [FF-CATALOG]: $(basename "${rf}") has a 'contractKind === file' branch rendering a component OTHER than FieldControl (parallel dispatch):"
    echo "${bad_branch}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-CATALOG]: file contract declared once per catalog; dispatch is catalog-driven (resolveFieldContract → FieldControl), no parallel renderer"
fi

# ---- FF-UPLOAD-ROUTE-ONLY: no client S3/bucket/presign construction --------
before=${ERRORS}
FORBIDDEN_CLIENT_TOKENS=(
  "s3://"
  "\\bbucket\\b"
  "presign"
  "PutObject"
  "aws-sdk"
)
CLIENT_FILES=(
  "${FIELD_RENDERER}"
  "${SCREEN_RECORDS}"
  "${SCREEN_DETAIL}"
  "${RECORDS_FORM}"
  "${APPS_SCHEMA}"
)
for f in "${CLIENT_FILES[@]}"; do
  for token in "${FORBIDDEN_CLIENT_TOKENS[@]}"; do
    matches="$(grep_noncomment "${token}" "${f}")"
    if [[ -n "${matches}" ]]; then
      echo "FAIL [FF-UPLOAD-ROUTE-ONLY]: $(basename "${f}") contains forbidden client-side storage token '${token}':"
      echo "${matches}"
      ERRORS=$((ERRORS + 1))
    fi
  done
done

# FileField must upload via POST /api/records/:recordId/files (the existing route).
if ! grep -qE "/api/records/\\\$\{encodeURIComponent\(recordId\)\}/files" "${FIELD_RENDERER}"; then
  echo "FAIL [FF-UPLOAD-ROUTE-ONLY]: field-renderer.jsx (FileField) does not POST to /api/records/:recordId/files"
  ERRORS=$((ERRORS + 1))
fi
# Download must go through GET /api/files/:versionId/download (the existing route).
if ! grep -qE "/api/files/\\\$\{encodeURIComponent\(value\)\}/download" "${FIELD_RENDERER}"; then
  echo "FAIL [FF-UPLOAD-ROUTE-ONLY]: field-renderer.jsx (FileField) does not link to /api/files/:versionId/download"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-UPLOAD-ROUTE-ONLY]: no client-side S3/bucket/presign construction; upload/download go through the existing file routes"
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: file-field-catalog-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: file-field-catalog-isolation — all checks green (FF-CATALOG/FF-UPLOAD-ROUTE-ONLY)"
exit 0
