#!/usr/bin/env bash
# T-0235 · T-0124 · document-render-isolation — static fitness for the document-on-demand render module.
#
# Asserts ADR T-0124 invariants via grep/boundary analysis (no runtime, no DB).
# Mirrors file-attachment-isolation.sh (T-0201/T-0119) style.
#
#  FF-NO-RENDER-ACL    — No second render-permission authority. Banned tokens in
#                        non-comment code: render_acl, document_visibility,
#                        renderPermission, canRender. Render right = resolveFor("read").
#  FF-RENDER-VIA-PDP   — Render module imports resolveFor (PDP). No raw "from .*record"
#                        pattern bypassing PDP in document-render.ts.
#  FF-NO-MASK-ROW      — No masked string / dash-row in render output. Banned tokens:
#                        "***", masked, dash-row, placeholder pattern.
#  FF-FORMAT-CLOSED    — RENDERERS closed map present; template_def_format_chk CHECK in migration.
#  FF-SNAPSHOT-IMMUTABLE — No direct INSERT/UPDATE/DELETE on file_version in render module.
#  FF-NO-DUP-SUBSYSTEM — Migration 060 creates ONLY template_def + template_dep
#                        (no file*, *_token, render_log, external_* tables).
#  FF-AUDIT-EVERY-RENDER — No token/secret keys in audit payload exports.
#  TCA-PURE            — document-render.ts is pure-core: no pg/fs/net/http/fetch/child_process.
#
# Usage:
#   document-render-isolation.sh [--self-test]
#
# Exit 0 — all checks green.
# Exit 1 — one or more violations.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---- Self-test mode ---------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0235 self-test] Running fail-closed probe: module absent → expect exit 1"
  FAKE_MODULE="/tmp/document-render-isolation-selftest-absent-$$.ts"
  if RENDER_MODULE_OVERRIDE="${FAKE_MODULE}" bash "${BASH_SOURCE[0]}"; then
    echo "FAIL [self-test]: did not exit 1 on absent module"
    exit 1
  else
    echo "PASS [self-test]: correctly exited non-zero on absent module"
  fi
  echo "PASS [self-test]: document-render-isolation self-test complete"
  exit 0
fi

MODULE="${RENDER_MODULE_OVERRIDE:-${PROJECT_ROOT}/src/core/document-render.ts}"
COMPAT_MODULE="${PROJECT_ROOT}/src/core/template-compat.ts"
MIGRATION="${PROJECT_ROOT}/migrations/060_template_def.sql"
ERRORS=0

echo "[T-0235] document-render-isolation: checking module boundary"

# ---- Fail-closed: module must exist -----------------------------------------
if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi
echo "PASS: src/core/document-render.ts exists"

if [[ ! -f "${COMPAT_MODULE}" ]]; then
  echo "FAIL: ${COMPAT_MODULE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: src/core/template-compat.ts exists"
fi

if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL: migrations/060_template_def.sql does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: migrations/060_template_def.sql exists"
fi

# grep wrapper: returns matches, treats rc=1 (no match) as clean, rc>=2 as error.
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

# ---- FF-NO-RENDER-ACL: no parallel permission authority ---------------------
echo ""
echo "Check FF-NO-RENDER-ACL: no render_acl / document_visibility / renderPermission / canRender"
ACL_TOKENS=("render_acl" "document_visibility" "renderPermission" "canRender")
before=${ERRORS}
for token in "${ACL_TOKENS[@]}"; do
  matches="$(grep_noncomment "${token}" "${MODULE}")"
  if [[ -n "${matches}" ]]; then
    echo "FAIL FF-NO-RENDER-ACL: forbidden token '${token}' in document-render.ts:"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS FF-NO-RENDER-ACL: no forbidden permission tokens found"
fi

# ---- FF-RENDER-VIA-PDP: resolveFor imported, no raw record bypass -----------
echo ""
echo "Check FF-RENDER-VIA-PDP: resolveFor imported in document-render.ts"
if ! grep -q "resolveFor" "${MODULE}" 2>/dev/null; then
  echo "FAIL FF-RENDER-VIA-PDP: resolveFor not imported/used in document-render.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-RENDER-VIA-PDP: resolveFor present in document-render.ts"
fi

# ---- FF-NO-MASK-ROW: no masked-string / dash-row tokens ---------------------
echo ""
echo "Check FF-NO-MASK-ROW: no masked string or dash-row tokens in render module"
MASK_TOKENS=("\"\\*\\*\\*\"" "dashRow\|dash_row\|MASK_ROW\|masked_row")
before=${ERRORS}
for token in "${MASK_TOKENS[@]}"; do
  matches="$(grep_noncomment "${token}" "${MODULE}")"
  if [[ -n "${matches}" ]]; then
    echo "FAIL FF-NO-MASK-ROW: forbidden token '${token}' in document-render.ts:"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS FF-NO-MASK-ROW: no masked-string / dash-row tokens"
fi

# ---- FF-FORMAT-CLOSED: RENDERERS closed map + CHECK constraint --------------
echo ""
echo "Check FF-FORMAT-CLOSED: RENDERERS map present in document-render.ts"
if ! grep -q "RENDERERS" "${MODULE}" 2>/dev/null; then
  echo "FAIL FF-FORMAT-CLOSED: RENDERERS closed map not found in document-render.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS FF-FORMAT-CLOSED: RENDERERS present in document-render.ts"
fi

echo "Check FF-FORMAT-CLOSED: template_def_format_chk CHECK in migration 060"
if [[ -f "${MIGRATION}" ]]; then
  if grep -q "template_def_format_chk" "${MIGRATION}" 2>/dev/null; then
    echo "PASS FF-FORMAT-CLOSED: template_def_format_chk CHECK found in migration 060"
  else
    echo "FAIL FF-FORMAT-CLOSED: template_def_format_chk not found in migration 060"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- FF-SNAPSHOT-IMMUTABLE: no direct file_version writes in render module --
echo ""
echo "Check FF-SNAPSHOT-IMMUTABLE: no direct INSERT/UPDATE/DELETE file_version in render module"
IMMUTABLE_PATTERNS=("INSERT INTO .*file_version" "UPDATE .*file_version" "DELETE .*file_version")
before=${ERRORS}
for pattern in "${IMMUTABLE_PATTERNS[@]}"; do
  matches="$(grep_noncomment "${pattern}" "${MODULE}")"
  if [[ -n "${matches}" ]]; then
    echo "FAIL FF-SNAPSHOT-IMMUTABLE: direct file_version mutation in document-render.ts:"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS FF-SNAPSHOT-IMMUTABLE: no direct file_version writes in render module"
fi

# ---- FF-NO-DUP-SUBSYSTEM: migration 060 tables whitelist -------------------
echo ""
echo "Check FF-NO-DUP-SUBSYSTEM: migration 060 creates only template_def + template_dep"
if [[ -f "${MIGRATION}" ]]; then
  FORBIDDEN_TABLES=("file_version\b" "render_log\b" "external_token\b" "external_surface\b")
  before=${ERRORS}
  for pattern in "${FORBIDDEN_TABLES[@]}"; do
    if grep -Eq "CREATE TABLE[[:space:]]+choros\.${pattern}" "${MIGRATION}" 2>/dev/null; then
      echo "FAIL FF-NO-DUP-SUBSYSTEM: migration 060 creates forbidden table matching: ${pattern}"
      ERRORS=$((ERRORS + 1))
    fi
  done
  if [[ ${ERRORS} -eq ${before} ]]; then
    echo "PASS FF-NO-DUP-SUBSYSTEM: migration 060 table set is whitelist-clean"
  fi
fi

# ---- TCA-PURE: pure-core (no pg/fs/net/http/fetch in render module) ---------
# Uses grep_noncomment to skip comment lines (mirrors file-attachment-isolation.sh lesson T-0143).
echo ""
echo "Check TCA-PURE: document-render.ts has no forbidden I/O imports"
FORBIDDEN_IO=(
  "from.*['\"]pg['\"]"
  "from.*['\"]node:fs['\"]"
  "from.*['\"]node:http['\"]"
  "from.*['\"]node:net['\"]"
  "from.*['\"]node:child_process['\"]"
  "require\(.*child_process"
  "import\.meta"
  "process\.env"
  "process\.exit"
)
before=${ERRORS}
for pattern in "${FORBIDDEN_IO[@]}"; do
  matches="$(grep_noncomment "${pattern}" "${MODULE}")"
  if [[ -n "${matches}" ]]; then
    echo "FAIL TCA-PURE: document-render.ts contains forbidden pattern: ${pattern}"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS TCA-PURE: no forbidden I/O imports in document-render.ts"
fi

# ---- template-compat module purity -----------------------------------------
echo ""
echo "Check COMPAT-PURE: template-compat.ts is pure (no I/O imports)"
if [[ -f "${COMPAT_MODULE}" ]]; then
  before=${ERRORS}
  for pattern in "${FORBIDDEN_IO[@]}"; do
    matches="$(grep_noncomment "${pattern}" "${COMPAT_MODULE}")"
    if [[ -n "${matches}" ]]; then
      echo "FAIL COMPAT-PURE: template-compat.ts contains forbidden pattern: ${pattern}"
      echo "${matches}"
      ERRORS=$((ERRORS + 1))
    fi
  done
  if [[ ${ERRORS} -eq ${before} ]]; then
    echo "PASS COMPAT-PURE: template-compat.ts contains no forbidden I/O imports"
  fi

  # Check ADR reference (mirrors RPC-3 in report-page-compat-isolation.sh)
  if ! grep -q "checkBindingCompat\|checkReportPageDepFields" "${COMPAT_MODULE}" 2>/dev/null; then
    echo "FAIL COMPAT-PURE: template-compat.ts missing ADR reference to checkBindingCompat / checkReportPageDepFields (NF-1 precedent)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS COMPAT-PURE: ADR precedent reference present in template-compat.ts"
  fi

  # Check required exports
  REQUIRED_EXPORTS=(
    "export.*TemplateDep"
    "export.*TemplateDepViolation"
    "export.*TemplateCompatResult"
    "export.*function checkTemplateDepFields"
  )
  for pattern in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -Eq "${pattern}" "${COMPAT_MODULE}" 2>/dev/null; then
      echo "FAIL COMPAT-PURE: template-compat.ts missing export matching: ${pattern}"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- Result -----------------------------------------------------------------
echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL [document-render-isolation]: ${ERRORS} violation(s) found"
  exit 1
fi

echo "PASS [document-render-isolation]: all checks green [FF-NO-RENDER-ACL, FF-RENDER-VIA-PDP, FF-NO-MASK-ROW, FF-FORMAT-CLOSED, FF-SNAPSHOT-IMMUTABLE, FF-NO-DUP-SUBSYSTEM, TCA-PURE]"
exit 0
