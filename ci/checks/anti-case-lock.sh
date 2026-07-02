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
# SCOPE (review R-3, defense-in-depth): EVERY denylist literal is scanned over
# BOTH planes — src/**/*.ts AND web/src/**/*.{jsx,tsx} — not only the ones with
# a current web occurrence. Today only telLinear has a web/src hit (the
# FormBuilder placeholder); the other seven count 0 on the web plane, so the
# recorded baseline is unchanged by the widened scope — but a FUTURE web-side
# hardcode of any literal is now caught by this repo-wide gate too, not only
# by the diff-scoped rights-ui-anti-case.sh.
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
# recorded aggregate baseline. Equal-to-baseline is CLEAN (steady-state), and
# ZERO is the CELEBRATED terminal state (eroded-to-zero — printed explicitly
# as "0 OK (eroded)"). This is the "erodes, does not grow" contract — distinct
# from detel-literal-baseline.sh's own AC-10 "strictly less" requirement,
# which was a one-time reduction proof for T-0575's specific diff.
#
# ZERO-SAFETY (review R-1, blocker fix): every grep stage is wrapped in a
# rc-tolerant subshell `(grep ... || true)` so a zero-match outcome (grep
# rc=1) can NEVER trip this script's own `set -euo pipefail` into a silent
# mid-scan death. Zero matches is the gate's SUCCESS end-state, not an error;
# the --self-test covers this path explicitly (a literal with zero occurrences
# must produce count=0, a live script, and an "OK (eroded)" PASS line).
#
# --self-test: plants a synthetic violation for a representative literal from
# each detection family (a bare grep-value literal AND a comment-immune
# literal) and asserts the detector fires; asserts a comment-only / test-file
# occurrence does NOT false-positive; and asserts the eroded-to-zero scenario
# passes with an explicit "0 OK (eroded)" line (review R-1 regression).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Scan roots + baseline location. Globals so the self-test can re-point the
# denylist scan at a synthetic fixture tree (production values set here).
SRC_ROOT="${PROJECT_ROOT}/src"
WEB_ROOT="${PROJECT_ROOT}/web/src"
BASELINE_FILE="${PROJECT_ROOT}/ci/checks/data/anti-case-baseline.json"

# The full D-064 §5 denylist. Every entry is scanned on BOTH planes (src +
# web/src — review R-3). Format: baseline-key|literal (key == literal today,
# kept separate so a future non-identifier literal can carry a distinct key).
LITERALS=(
  "role-approver|role-approver"
  "soglasovanie|soglasovanie"
  "tel-approval|tel-approval"
  "telLinear|telLinear"
  "e-larina|e-larina"
  "e-orlov|e-orlov"
  "approvalRequired|approvalRequired"
  "gw-approval-threshold|gw-approval-threshold"
)

# ---------------------------------------------------------------------------
# count_literal <root_dir> <literal> <exts...> — code-only occurrence count of
# a double-quoted string literal across the given file extensions, excluding
# __tests__/ dirs, .test.* files, and comment lines.
#
# ZERO-SAFE (review R-1): each pipeline stage is a subshell `(grep ... || true)`
# so grep's rc=1-on-no-match never propagates through pipefail/set -e — a zero
# count is a legitimate (best) outcome, returned as the string "0".
# ---------------------------------------------------------------------------
count_literal() {
  local root="$1" literal="$2"; shift 2
  local include_args=() ext filtered
  for ext in "$@"; do include_args+=(--include="*.${ext}"); done
  filtered="$( (grep -rn "\"${literal}\"" "${root}" "${include_args[@]}" 2>/dev/null || true) \
    | (grep -v '__tests__' || true) \
    | (grep -vE '\.test\.(ts|tsx|jsx|js)' || true) \
    | (grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' || true) )"
  if [[ -z "${filtered}" ]]; then
    echo 0
  else
    printf '%s\n' "${filtered}" | wc -l | tr -d '[:space:]'
  fi
}

# count_src <literal> — src plane (*.ts). count_web <literal> — web plane
# (*.jsx, *.tsx). Both read the re-pointable globals.
count_src() { count_literal "${SRC_ROOT}" "$1" ts; }
count_web() { count_literal "${WEB_ROOT}" "$1" jsx tsx; }

# read_baseline <key> — read an integer field from the baseline JSON without a
# JSON parser dependency (the file is a flat, single-level object of
# "key": integer pairs — a simple line-anchored grep is exact and zero-dep,
# same idiom as this repo's other baseline/allowlist readers). ZERO-SAFE
# (review R-1): a missing key yields the empty string, never a set -e death —
# the caller treats empty as a FAIL with an explicit message.
read_baseline() {
  local key="$1" val
  val="$( (grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*[0-9]+" "${BASELINE_FILE}" 2>/dev/null || true) \
    | (grep -oE '[0-9]+$' || true) | head -1 )"
  printf '%s' "${val}"
}

# ---------------------------------------------------------------------------
# run_denylist_scan — Phase 2 body: full-denylist counts vs baseline.
# Reads globals: LITERALS, SRC_ROOT, WEB_ROOT, BASELINE_FILE.
# Prints per-literal verdict lines (including the explicit "OK (eroded)" form
# for a zero count) + the aggregate line. Returns 0 on clean, 1 on violation —
# return-code based (not a mutated global) so the self-test can exercise it in
# a command-substitution subshell against a fixture tree.
# ---------------------------------------------------------------------------
run_denylist_scan() {
  local entry key literal count baseline aggregate=0 scan_errors=0
  for entry in "${LITERALS[@]}"; do
    IFS='|' read -r key literal <<< "${entry}"
    count="$(( $(count_src "${literal}") + $(count_web "${literal}") ))"
    baseline="$(read_baseline "${key}")"
    if [[ -z "${baseline}" ]]; then
      echo "FAIL [anti-case-lock]: no baseline recorded for key '${key}' in ${BASELINE_FILE}"
      scan_errors=$((scan_errors + 1))
      continue
    fi
    aggregate=$((aggregate + count))
    if [[ "${count}" -gt "${baseline}" ]]; then
      echo "FAIL [anti-case-lock]: '${literal}' count INCREASED (${count} > baseline ${baseline})"
      scan_errors=$((scan_errors + 1))
    elif [[ "${count}" -eq 0 ]]; then
      echo "  ${literal}: 0 (baseline ${baseline}) OK (eroded)"
    else
      echo "  ${literal}: ${count} (baseline ${baseline}) OK"
    fi
  done

  local agg_baseline
  agg_baseline="$(read_baseline "aggregate")"
  echo "  aggregate: ${aggregate} (baseline ${agg_baseline:-<missing>})"
  if [[ -z "${agg_baseline}" ]]; then
    echo "FAIL [anti-case-lock]: no aggregate baseline recorded"
    scan_errors=$((scan_errors + 1))
  elif [[ "${aggregate}" -gt "${agg_baseline}" ]]; then
    echo "FAIL [anti-case-lock]: aggregate count INCREASED (${aggregate} > baseline ${agg_baseline})"
    scan_errors=$((scan_errors + 1))
  fi

  if [[ ${scan_errors} -eq 0 ]]; then
    echo "PASS Phase 2: full denylist within baseline (erodes-or-steady, never grows)"
    return 0
  fi
  echo "FAIL Phase 2: ${scan_errors} violation(s)"
  return 1
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

  # (4) ZERO-COUNT / eroded-to-zero (review R-1 regression, blocker class):
  #     a literal with ZERO occurrences in the tree must yield count=0 WITHOUT
  #     the grep pipeline's rc=1 killing the script via set -e/pipefail.
  zero_count="$(count_literal "${TMPDIR_ST}/src" "gw-approval-threshold" ts)"
  if [[ "${zero_count}" != "0" ]]; then
    echo "FAIL self-test: expected count=0 for absent gw-approval-threshold, got '${zero_count}'"
    exit 1
  fi
  echo "PASS self-test: zero-occurrence literal returns 0 without killing the script (R-1)"

  # (5) FULL Phase-2 scan on an eroded-to-zero fixture tree: every literal 0,
  #     baseline all 1 — the gate must PASS and print explicit "OK (eroded)"
  #     lines (this is the CELEBRATED end-state of the erode contract, the
  #     exact scenario the reviewer reproduced as a silent crash pre-fix).
  ZR="${TMPDIR_ST}/zero-root"
  mkdir -p "${ZR}/src" "${ZR}/web/src"
  cat > "${ZR}/baseline.json" <<'JSON'
{
  "role-approver": 1,
  "soglasovanie": 1,
  "tel-approval": 1,
  "telLinear": 1,
  "e-larina": 1,
  "e-orlov": 1,
  "approvalRequired": 1,
  "gw-approval-threshold": 1,
  "aggregate": 8
}
JSON
  zero_rc=0
  zero_out="$( SRC_ROOT="${ZR}/src"; WEB_ROOT="${ZR}/web/src"; BASELINE_FILE="${ZR}/baseline.json"; run_denylist_scan )" || zero_rc=$?
  if [[ ${zero_rc} -ne 0 ]]; then
    echo "FAIL self-test: eroded-to-zero scan must PASS (rc=0), got rc=${zero_rc}; output:"
    echo "${zero_out}"
    exit 1
  fi
  if ! echo "${zero_out}" | grep -qF "gw-approval-threshold: 0 (baseline 1) OK (eroded)"; then
    echo "FAIL self-test: eroded-to-zero scan did not print the explicit 'OK (eroded)' line; output:"
    echo "${zero_out}"
    exit 1
  fi
  echo "PASS self-test: eroded-to-zero fixture scans clean with explicit 'OK (eroded)' lines (R-1)"

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
echo "Phase 2: full D-064 §5 denylist, repo-wide code-only counts vs baseline (src + web/src)"
if ! run_denylist_scan; then
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: anti-case-lock found ${ERRORS} violation(s) across both phases"
  exit 1
fi
echo "PASS: anti-case-lock — delegates clean + full D-064 §5 denylist within baseline"
exit 0
