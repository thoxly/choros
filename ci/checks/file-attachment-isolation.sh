#!/usr/bin/env bash
# T-0201
# T-0119 · file-attachment-isolation — static fitness for the file/attachment model.
#
# Static assertions (grep / boundary analysis — no runtime, no DB) over the new
# pure-core module src/core/file-attachment.ts + migration 058. Mirrors
# connector-isolation.sh / effect-resource-isolation.sh. Distinguishes grep rc=1
# (no match) from rc>=2 (error), and ignores comment lines so prose explaining a
# ban passes (lesson T-0143).
#
#  FF-NOACL — No second file-permission authority (one mechanism = record-RBAC via
#             T-0021 PDP). Banned tokens in non-comment code: file_acl,
#             attachment_rights, file_visibility, fileVisibility, fileAcl. The module
#             MUST call resolveHandle/resolveFor (delegation), not a private filter.
#  FF-NB    — Binary not in Postgres: migration 058 has no bytea/largeobject/lo_ and
#             no base64-text content column; object_key text IS present.
#  FF-KEY   — Tenant-prefix key is structural: exactly one `export function
#             buildObjectKey`; no S3-key concatenation bypass (every put/presignGet/
#             erase uses a key from buildObjectKey or read-back object_key).
#  FF-V     — Content immutability: the migration / DAO never UPDATE a file_version
#             content column (object_key/content_hash/size/mime); the ONLY post-insert
#             version mutation is content_erased_at (the retention tombstone).
#  FF-EGRESS-CLASS — data_class imports the closed DataClass (T-0033), not redeclared.
#  FF-PURE  — Pure-core: file-attachment.ts imports no pg/fs/net/http(s)/fetch/child_process.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/file-attachment.ts"
DAO="${PROJECT_ROOT}/src/core/postgres/pgFileStore.ts"
MIGRATION="${PROJECT_ROOT}/migrations/058_files_attachments.sql"
ERRORS=0

echo "[T-0201/T-0119] file-attachment-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi
if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL: ${MIGRATION} does not exist"
  exit 1
fi

# grep wrapper: returns matches, treats rc=1 (no match) as clean, rc>=2 as a hard error.
grep_noncomment() {
  local pattern="$1" file="$2" out rc
  set +e
  out="$(grep -nE "${pattern}" "${file}" | grep -vE ":[[:space:]]*(//|\*)")"
  rc=$?
  set -e
  if [[ ${rc} -ge 2 ]]; then
    echo "ERROR: grep failed (rc=${rc}) on pattern '${pattern}' in ${file}"
    exit 2
  fi
  printf '%s' "${out}"
}

# ---- FF-NOACL: no parallel file-ACL / visibility surface -------------------
PARALLEL_AUTHORITY_TOKENS=(
  "file_acl"
  "attachment_rights"
  "file_visibility"
  "fileVisibility"
  "fileAcl"
)
before=${ERRORS}
for token in "${PARALLEL_AUTHORITY_TOKENS[@]}"; do
  matches="$(grep_noncomment "${token}" "${MODULE}")"
  if [[ -n "${matches}" ]]; then
    echo "FAIL [FF-NOACL]: file-attachment.ts references parallel-authority token '${token}' in non-comment code:"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
  # The migration must not create a file-ACL column either (strip SQL '--' comments).
  mig_match="$(grep -nE "${token}" "${MIGRATION}" | grep -vE ':[[:space:]]*--' || true)"
  if [[ -n "${mig_match}" ]]; then
    echo "FAIL [FF-NOACL]: migration 058 references parallel-authority token '${token}':"
    echo "${mig_match}"
    ERRORS=$((ERRORS + 1))
  fi
done
# Delegation must be present: the module calls the T-0021 resolver, not a private filter.
if ! grep -qE "resolveHandle|resolveFor" "${MODULE}"; then
  echo "FAIL [FF-NOACL]: file-attachment.ts does not call resolveHandle/resolveFor (authz must delegate to T-0021 PDP)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-NOACL]: no parallel file-authority; authz delegates to T-0021 PDP"
fi

# ---- FF-NB: binary not in Postgres -----------------------------------------
# SQL comments are '--'; strip them so prose explaining the ban passes.
before=${ERRORS}
nb_match="$(grep -nE '\b(bytea|largeobject|lo_)\b' "${MIGRATION}" | grep -vE ':[[:space:]]*--' || true)"
if [[ -n "${nb_match}" ]]; then
  echo "FAIL [FF-NB]: migration 058 contains a binary/large-object column:"
  echo "${nb_match}"
  ERRORS=$((ERRORS + 1))
fi
# base64-ish content text column smell (a 'content'/'body'/'data' text column for the blob).
b64_match="$(grep -niE '(content|body|blob)[[:space:]]+text' "${MIGRATION}" | grep -vE ':[[:space:]]*(--)' || true)"
if [[ -n "${b64_match}" ]]; then
  echo "FAIL [FF-NB]: migration 058 has a text content/body/blob column (binary must live in S3):"
  echo "${b64_match}"
  ERRORS=$((ERRORS + 1))
fi
# object_key must be present (the S3 pointer replacing any in-DB binary).
if ! grep -qE 'object_key[[:space:]]+text' "${MIGRATION}"; then
  echo "FAIL [FF-NB]: migration 058 is missing 'object_key text' (the S3 pointer)"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-NB]: no in-Postgres binary; object_key is the S3 pointer"
fi

# ---- FF-KEY: single tenant-prefixed key constructor ------------------------
before=${ERRORS}
key_ctor_count="$(grep -cE '^export function buildObjectKey' "${MODULE}" || true)"
if [[ "${key_ctor_count}" != "1" ]]; then
  echo "FAIL [FF-KEY]: expected exactly one 'export function buildObjectKey', found ${key_ctor_count}"
  ERRORS=$((ERRORS + 1))
fi
# The key must lead with the tenant segment (structural tenant prefix).
if ! grep -qE 'return .\$\{tenantId\}/' "${MODULE}"; then
  echo "FAIL [FF-KEY]: buildObjectKey does not lead with the \${tenantId} segment"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-KEY]: single tenant-prefixed key constructor (buildObjectKey)"
fi

# ---- FF-V: content immutability (no version-content UPDATE) -----------------
# Scan the DAO: the only legitimate UPDATEs are choros.file (pointer) and the
# content_erased_at tombstone. An UPDATE of a file_version content column
# (object_key/content_hash/size_bytes/mime_type) is forbidden.
before=${ERRORS}
if [[ -f "${DAO}" ]]; then
  set +e
  # UPDATE ... file_version ... SET ... <content col> — fail if a content column is set.
  bad_update="$(grep -nE 'UPDATE choros.file_version' "${DAO}" | grep -iE 'object_key|content_hash|size_bytes|mime_type')"
  set -e
  if [[ -n "${bad_update}" ]]; then
    echo "FAIL [FF-V]: pgFileStore UPDATEs a file_version content column (immutability violated):"
    echo "${bad_update}"
    ERRORS=$((ERRORS + 1))
  fi
fi
# The core write-path mints a fresh versionId per version (immutable add).
if ! grep -qE 'randomUUID\(\)' "${MODULE}"; then
  echo "FAIL [FF-V]: file-attachment.ts addVersion must mint a fresh versionId (randomUUID) per version"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-V]: content immutable per version (fresh key per version; no content UPDATE)"
fi

# ---- FF-EGRESS-CLASS: DataClass imported, not redeclared -------------------
before=${ERRORS}
if ! grep -qE "from ['\"].*data-classification" "${MODULE}"; then
  echo "FAIL [FF-EGRESS-CLASS]: file-attachment.ts does not import DataClass from data-classification"
  ERRORS=$((ERRORS + 1))
fi
redeclared_dc="$(grep -nE '^(export )?type DataClass[[:space:]]*=' "${MODULE}" || true)"
if [[ -n "${redeclared_dc}" ]]; then
  echo "FAIL [FF-EGRESS-CLASS]: file-attachment.ts redeclares DataClass (must import the closed axis):"
  echo "${redeclared_dc}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-EGRESS-CLASS]: DataClass imported (T-0033), not redeclared"
fi

# ---- FF-PURE: pure-core (no pg/fs/net/http/fetch/child_process) ------------
FORBIDDEN_IMPORTS=(
  "from.*['\"]pg['\"]"
  "from.*['\"].*node:fs['\"]"
  "from.*['\"]fs['\"]"
  "from.*['\"].*node:net['\"]"
  "from.*['\"]net['\"]"
  "from.*['\"].*node:http['\"]"
  "from.*['\"]http['\"]"
  "from.*['\"].*node:https['\"]"
  "from.*['\"]https['\"]"
  "from.*['\"].*node:child_process['\"]"
  "require.*['\"](pg|fs|net|http|https|child_process)['\"]"
)
before=${ERRORS}
for pattern in "${FORBIDDEN_IMPORTS[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL [FF-PURE]: file-attachment.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done
fetch_calls="$(grep_noncomment "fetch\(" "${MODULE}")"
if [[ -n "${fetch_calls}" ]]; then
  echo "FAIL [FF-PURE]: file-attachment.ts contains a fetch( call (no live external call allowed):"
  echo "${fetch_calls}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-PURE]: pure-core (no pg/fs/net/http/fetch; S3 behind injected ObjectStore port)"
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: file-attachment-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: file-attachment-isolation — all checks green (FF-NOACL/NB/KEY/V/EGRESS-CLASS/PURE)"
exit 0
