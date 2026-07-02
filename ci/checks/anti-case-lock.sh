#!/usr/bin/env bash
# T-0576 [W1/анти-кейс-CI] · anti-case-lock — единый CI-замок над картой примитивов
# §5 (D-064 п.2, закон границы; ADR-T0576-anticase-ci.md).
#
# THE CONTRACT (ADR §2/§3): три точечных анти-кейс гейта уже существуют — каждый
# покрывает СВОЙ периметр:
#   - read-pdp-anti-case.sh   (T-0570) — git-diff-scoped, src/,      7 литералов
#   - rights-ui-anti-case.sh  (T-0572) — git-diff-scoped, web/src/,  тот же список
#   - detel-literal-baseline.sh (T-0575) — repo-wide code-only baseline, но
#     ТОЛЬКО 3 литерала (role-approver/soglasovanie/tel-approval)
# Ни один не является repo-wide baseline-гейтом ПОЛНОГО денилиста карты примитивов
# §5. Этот скрипт — зонтик: (a) вызывает все три существующих чека КАК ЕСТЬ (их
# владение/логика не трогается — они принадлежат своим задачам), затем (b)
# добавляет СОБСТВЕННЫЙ repo-wide code-only скан полного денилиста (включая то,
# что три точечных чека не покрывают: telLinear, персоны e-larina/e-orlov как
# структурные фикстуры, TEL_GATEWAY_VAR/TEL_GATEWAY_ID значения), сравнивая
# каждый литерал и агрегат с записанным data-baseline (ci/checks/data/
# anti-case-baseline.json) по семантике «выедается, не растёт» (<=, НЕ строгое
# уменьшение — в отличие от T-0575 AC-10, эта задача строит гейт, не обязана
# сама выедать остаток).
#
# METHODOLOGY (mirrors detel-literal-baseline.sh, T-0575): a line counts ONLY if
# it is (a) not under a __tests__/ dir or a .test.ts/.test.jsx/.test.tsx file,
# and (b) NOT a comment line (first non-space char is not //, * or /* — same
# comment-strip convention as every isolation check in this repo, lesson
# T-0143). This isolates CODE-level occurrences (a literal used as an actual
# value: a const definition, a fixture key, a fallback default) from doc-
# comment/JSDoc mentions of the same string, which remain legitimately
# unbounded (explaining the ban, or documenting WHY a value defaults to this,
# is not itself a hardcode).
#
# BASELINE (recorded on this task's own HEAD, afa856b + this task's additions —
# see ci/checks/data/anti-case-baseline.json; full derivation in ADR §2/§6):
#   role-approver:2  soglasovanie:2  tel-approval:1  telLinear:8 (7 src + 1
#   web/src placeholder-text, NOT a hardcode value — see ADR §6 note)
#   e-larina:2  e-orlov:2  approvalRequired:1  gw-approval-threshold:1
#   aggregate:19
#
# SEMANTICS: FAIL if any INDIVIDUAL literal's count is STRICTLY GREATER than
# its recorded baseline, OR the aggregate is strictly greater than the
# recorded aggregate baseline. Equal-to-baseline is CLEAN (steady-state; this
# is the "erodes, does not grow" contract — distinct from detel-literal-
# baseline.sh's own AC-10 "strictly less" requirement, which was a one-time
# reduction proof for T-0575's specific diff).
#
# --self-test: plants a synthetic violation for a representative literal from
# each detection family (a bare grep-value literal AND a comment-immune
# literal) and asserts the detector fires; also asserts a comment-only /
# test-file occurrence does NOT false-positive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BASELINE_FILE="${PROJECT_ROOT}/ci/checks/data/anti-case-baseline.json"

# ---------------------------------------------------------------------------
# count_literal <root_dir> <literal> <exts...> — code-only occurrence count of
# a double-quoted string literal across the given file extensions, excluding
# __tests__/ dirs, .test.* files, and comment lines.
# ---------------------------------------------------------------------------
count_literal() {
  local root="$1" literal="$2"; shift 2
  local include_args=()
  for ext in "$@"; do include_args+=(--include="*.${ext}"); done
  grep -rn "\"${literal}\"" "${root}" "${include_args[@]}" 2>/dev/null \
    | grep -v '__tests__' \
    | grep -vE '\.test\.(ts|tsx|jsx|js)' \
    | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' \
    | wc -l | tr -d '[:space:]'
}

# count_src <literal> — src/**/*.ts occurrence count (the platform code plane).
count_src() { count_literal "${PROJECT_ROOT}/src" "$1" ts; }

# count_web <literal> — web/src/**/*.{jsx,tsx} occurrence count (the UI plane).
count_web() { count_literal "${PROJECT_ROOT}/web/src" "$1" jsx tsx; }

# read_baseline <key> — read an integer field from the baseline JSON without a
# JSON parser dependency (the file is a flat, single-level object of
# "key": integer pairs — a simple line-anchored grep is exact and zero-dep,
# same idiom as this repo's other baseline/allowlist readers).
read_baseline() {
  local key="$1"
  grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*[0-9]+" "${BASELINE_FILE}" \
    | grep -oE '[0-9]+$' | head -1
}

# ---------------------------------------------------------------------------
# Self-test mode.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[anti-case-lock] --self-test"
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT
  mkdir -p "${TMPDIR_ST}/src/http" "${TMPDIR_ST}/src/__tests__" "${TMPDIR_ST}/web/src/screens"

  # (1) code-level literal counts once; comment + test-file occurrences excluded.
  cat > "${TMPDIR_ST}/src/http/example.ts" <<'TSFIX'
// A comment mentioning "telLinear" must NOT count.
export const DEFAULT_PROC_KEY = "telLinear"; // code line — counts once.
TSFIX
  cat > "${TMPDIR_ST}/src/__tests__/example.test.ts" <<'TSFIX'
const FIXTURE_PROC = "telLinear"; // test file — must NOT count.
TSFIX
  count="$(count_literal "${TMPDIR_ST}/src" "telLinear" ts)"
  if [[ "${count}" != "1" ]]; then
    echo "FAIL self-test: expected count=1 for telLinear (comment+test excluded), got ${count}"
    exit 1
  fi
  echo "PASS self-test: telLinear comment/test-file exclusion correct (got 1, expected 1)"

  # (2) a second literal family (persona) planted in web/src must also be
  #     detected by the same code-only methodology.
  cat > "${TMPDIR_ST}/web/src/screens/example.jsx" <<'JSXFIX'
export const SEED_PERSON = "e-larina"; // code line — counts once.
JSXFIX
  web_count="$(count_literal "${TMPDIR_ST}/web/src" "e-larina" jsx tsx)"
  if [[ "${web_count}" != "1" ]]; then
    echo "FAIL self-test: expected count=1 for e-larina in web/src, got ${web_count}"
    exit 1
  fi
  echo "PASS self-test: e-larina web/src code-only detection correct (got 1, expected 1)"

  # (3) TEL_GATEWAY value literal (approvalRequired) — same family, proves the
  #     detector is not hand-tuned to only the three T-0575 literals.
  cat > "${TMPDIR_ST}/src/http/gateway.ts" <<'TSFIX'
export const ROUTING_VAR = "approvalRequired";
TSFIX
  gw_count="$(count_literal "${TMPDIR_ST}/src" "approvalRequired" ts)"
  if [[ "${gw_count}" != "1" ]]; then
    echo "FAIL self-test: expected count=1 for approvalRequired, got ${gw_count}"
    exit 1
  fi
  echo "PASS self-test: approvalRequired (TEL_GATEWAY_VAR family) detection correct"

  echo "PASS self-test: all anti-case-lock detectors functional across literal families"
  exit 0
fi

# ---------------------------------------------------------------------------
# Production check.
# ---------------------------------------------------------------------------
echo "[T-0576] anti-case-lock: D-064 §5 full denylist vs recorded baseline"

if [[ ! -f "${BASELINE_FILE}" ]]; then
  echo "FAIL: baseline file not found: ${BASELINE_FILE}"
  exit 1
fi

# ---- Phase 1: delegate to the existing point gates (owned by their tasks) ----
echo ""
echo "Phase 1: existing point anti-case gates (owned by T-0570/T-0572/T-0575)"
ERRORS=0
for check in "read-pdp-anti-case.sh" "rights-ui-anti-case.sh" "detel-literal-baseline.sh"; do
  echo "  -> ${check}"
  if ! bash "${SCRIPT_DIR}/${check}"; then
    echo "FAIL [anti-case-lock]: delegate ${check} failed"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS Phase 1: all delegate point-gates clean"
else
  echo "FAIL Phase 1: ${ERRORS} delegate gate(s) failed"
fi

# ---- Phase 2: full-denylist repo-wide code-only scan vs baseline -----------
echo ""
echo "Phase 2: full D-064 §5 denylist, repo-wide code-only counts vs baseline"

# Each entry: baseline-key | literal | scanner-fn
LITERALS=(
  "role-approver|role-approver|src"
  "soglasovanie|soglasovanie|src"
  "tel-approval|tel-approval|src"
  "telLinear|telLinear|both"
  "e-larina|e-larina|src"
  "e-orlov|e-orlov|src"
  "approvalRequired|approvalRequired|src"
  "gw-approval-threshold|gw-approval-threshold|src"
)

aggregate=0
phase2_errors=0
for entry in "${LITERALS[@]}"; do
  IFS='|' read -r key literal scope <<< "${entry}"
  case "${scope}" in
    src)  count="$(count_src "${literal}")" ;;
    both) count="$(( $(count_src "${literal}") + $(count_web "${literal}") ))" ;;
    *)    echo "ERROR: unknown scope '${scope}'"; exit 2 ;;
  esac
  baseline="$(read_baseline "${key}")"
  if [[ -z "${baseline}" ]]; then
    echo "FAIL [anti-case-lock]: no baseline recorded for key '${key}' in ${BASELINE_FILE}"
    phase2_errors=$((phase2_errors + 1))
    continue
  fi
  aggregate=$((aggregate + count))
  if [[ "${count}" -gt "${baseline}" ]]; then
    echo "FAIL [anti-case-lock]: '${literal}' count INCREASED (${count} > baseline ${baseline})"
    phase2_errors=$((phase2_errors + 1))
  else
    echo "  ${literal}: ${count} (baseline ${baseline}) OK"
  fi
done

agg_baseline="$(read_baseline "aggregate")"
echo "  aggregate: ${aggregate} (baseline ${agg_baseline})"
if [[ -z "${agg_baseline}" ]]; then
  echo "FAIL [anti-case-lock]: no aggregate baseline recorded"
  phase2_errors=$((phase2_errors + 1))
elif [[ "${aggregate}" -gt "${agg_baseline}" ]]; then
  echo "FAIL [anti-case-lock]: aggregate count INCREASED (${aggregate} > baseline ${agg_baseline})"
  phase2_errors=$((phase2_errors + 1))
fi

if [[ ${phase2_errors} -eq 0 ]]; then
  echo "PASS Phase 2: full denylist within baseline (erodes-or-steady, never grows)"
else
  echo "FAIL Phase 2: ${phase2_errors} violation(s)"
  ERRORS=$((ERRORS + phase2_errors))
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: anti-case-lock found ${ERRORS} violation(s) across both phases"
  exit 1
fi
echo "PASS: anti-case-lock — delegates clean + full D-064 §5 denylist within baseline"
exit 0
