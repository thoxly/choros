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
# QUOTE-AGNOSTIC MATCH (review R-4 harden, T-0596): the literal match is NOT
# anchored to double quotes only — it fires on the literal wrapped in double,
# single, OR backtick quotes ("x"/'x'/`x`). The original T-0576 matcher was
# double-quote-only (a valid methodology for src/, whose convention is double
# quotes — verified empirically), but web/src/'s convention is SINGLE quotes,
# and the double-quote-only matcher was blind to 5 real code-only occurrences
# there (role-approver in screen-inbox.jsx:835, approvalRequired x4 in
# gateway-condition-panel.jsx / screen-dmn-editor.jsx — all single-quoted).
# The baseline (ci/checks/data/anti-case-baseline.json) is recorded against
# THIS quote-agnostic matcher, not the narrower one T-0576 shipped with.
#
# SCOPE (review R-3, defense-in-depth): EVERY denylist literal is scanned over
# BOTH planes — src/**/*.ts AND web/src/**/*.{jsx,tsx} — not only the ones with
# a current web occurrence. Post-R-4-harden, web/src/ has REAL code-only hits
# beyond the telLinear FormBuilder placeholder (role-approver, approvalRequired
# — see QUOTE-AGNOSTIC MATCH note above); the recorded baseline reflects the
# FACTUAL current count on both planes (see data file) — a FUTURE web-side
# hardcode of any literal is caught by this repo-wide gate too, not only by
# the diff-scoped rights-ui-anti-case.sh.
#
# BASELINE (T-0596 [W2/замок-харден] recount — recorded against the
# QUOTE-AGNOSTIC matcher above, factually re-measured on this branch's own
# HEAD, not carried over textually from the T-0576 review estimate — see
# ci/checks/data/anti-case-baseline.json for the exact current numbers; full
# derivation in ADR-T0596-lock-harden.md §4/§5):
#   role-approver, soglasovanie, tel-approval, telLinear, e-larina, e-orlov,
#   approvalRequired, gw-approval-threshold, aggregate — see the data file,
#   which is the single source of truth (this comment intentionally does not
#   duplicate the numbers to avoid a second copy drifting out of sync with
#   the data file, review R-2 lesson from T-0576).
#
# SEMANTICS: FAIL if any INDIVIDUAL literal's count is STRICTLY GREATER than
# its recorded baseline, OR the aggregate is strictly greater than the
# recorded aggregate baseline. Equal-to-baseline is CLEAN (steady-state), and
# ZERO is the CELEBRATED terminal state (eroded-to-zero — printed explicitly
# as "0 OK (eroded)"). This is the "erodes, does not grow" contract — distinct
# from detel-literal-baseline.sh's own AC-10 "strictly less" requirement,
# which was a one-time reduction proof for T-0575's specific diff.
#
# ZERO-SAFETY (review R-1, blocker fix) + RC>=2 HARDEN (review R-5, T-0596):
# the outer (root-scanning) grep stage of count_literal()/read_baseline() now
# captures rc explicitly: rc=0/1 (match/no-match) are legitimate DATA — a
# zero count is the gate's SUCCESS end-state, not an error, and can NEVER
# trip this script's own `set -euo pipefail` into a silent mid-scan death.
# rc>=2 (a REAL grep error: missing/unreadable root, bad regex) is now
# FATAL — an explicit error message + exit, instead of the old blanket
# `|| true` which silently fail-opened a broken root into "0 OK (eroded)".
# Downstream filter stages (grep -v/-vE over already-captured text) keep the
# `|| true` idiom — rc>=2 is not a realistic failure mode for this script's
# own fixed patterns applied to text already in hand.
#
# --self-test: plants a synthetic violation for a representative literal from
# each detection family (a bare grep-value literal AND a comment-immune
# literal, in BOTH double and single quotes — R-4 harden) and asserts the
# detector fires; asserts a comment-only / test-file occurrence does NOT
# false-positive; asserts the eroded-to-zero scenario passes with an explicit
# "0 OK (eroded)" line (review R-1 regression); and asserts rc>=2 on a broken
# root is FATAL while rc=0/1 remain data (review R-5 regression).
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
# a quote-agnostic string literal (double, single, OR backtick — review R-4
# harden) across the given file extensions, excluding __tests__/ dirs,
# .test.* files, and comment lines.
#
# ZERO-SAFE (review R-1): the outer grep stage's rc is captured explicitly
# (not `|| true`-glossed) so a zero-match outcome (rc=1) is distinguished from
# a real grep error (rc>=2: missing/unreadable root, bad regex — review R-5
# harden). rc=0/1 are legitimate data (a zero count is the gate's best
# outcome); rc>=2 is now FATAL — a silent fail-open into "0 OK (eroded)" would
# mask a broken root, which R-5 flagged as the material risk of the old
# blanket `|| true`. Downstream filter stages operate on already-captured
# text (grep -v/-vE over a fixed string) where rc>=2 is not a realistic
# failure mode for this script's own fixed patterns, so they keep the R-1
# `|| true` zero-safety idiom unchanged.
# ---------------------------------------------------------------------------
count_literal() {
  local root="$1" literal="$2"; shift 2
  local include_args=() ext filtered raw rc
  for ext in "$@"; do include_args+=(--include="*.${ext}"); done
  raw="$(grep -rn "[\"'\`]${literal}[\"'\`]" "${root}" "${include_args[@]}" 2>&1)"; rc=$?
  if [[ ${rc} -ge 2 ]]; then
    echo "FAIL [anti-case-lock]: count_literal grep error (rc=${rc}) scanning '${root}' for '${literal}': ${raw}" >&2
    exit 2
  fi
  filtered="$( (printf '%s\n' "${raw}" || true) \
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
# the caller treats empty as a FAIL with an explicit message. rc>=2 on the
# outer grep stage (missing/unreadable BASELINE_FILE — review R-5 harden) is
# FATAL, distinct from rc=1 (key legitimately absent, still handled as an
# empty-string FAIL by the caller, not this function).
read_baseline() {
  local key="$1" val raw rc
  raw="$(grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*[0-9]+" "${BASELINE_FILE}" 2>&1)"; rc=$?
  if [[ ${rc} -ge 2 ]]; then
    echo "FAIL [anti-case-lock]: read_baseline grep error (rc=${rc}) reading '${BASELINE_FILE}' for key '${key}': ${raw}" >&2
    exit 2
  fi
  val="$( (printf '%s\n' "${raw}" || true) | (grep -oE '[0-9]+$' || true) | head -1 )"
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

  # (6) QUOTE-AGNOSTIC detection (review R-4 harden regression, T-0596): a
  #     literal wrapped in SINGLE quotes (the web/src/ convention) must be
  #     detected exactly like a double-quoted one — proves the matcher is no
  #     longer blind to the quote style that hid 5 real occurrences in
  #     screen-inbox.jsx / gateway-condition-panel.jsx / screen-dmn-editor.jsx.
  cat > "${TMPDIR_ST}/src/http/single-quote.ts" <<'TSFIX'
export const SINGLE_QUOTED_ROLE = 'role-approver'; // single-quoted code line.
TSFIX
  single_src_count="$(count_literal "${TMPDIR_ST}/src" "role-approver" ts)"
  if [[ "${single_src_count}" != "1" ]]; then
    echo "FAIL self-test: expected count=1 for single-quoted 'role-approver' in src, got ${single_src_count} (R-4 regression)"
    exit 1
  fi
  echo "PASS self-test: single-quoted literal detected in src (R-4 quote-agnostic)"

  cat > "${TMPDIR_ST}/web/src/screens/single-quote.jsx" <<'JSXFIX'
export const DEFAULT_ROUTING = 'approvalRequired'; // single-quoted code line.
JSXFIX
  single_web_count="$(count_literal "${TMPDIR_ST}/web/src" "approvalRequired" jsx tsx)"
  if [[ "${single_web_count}" != "1" ]]; then
    echo "FAIL self-test: expected count=1 for single-quoted 'approvalRequired' in web/src, got ${single_web_count} (R-4 regression)"
    exit 1
  fi
  echo "PASS self-test: single-quoted literal detected in web/src (R-4 quote-agnostic, both planes)"

  # (7) RC>=2 FATAL (review R-5 harden regression, T-0596): a genuine grep
  #     error must be a FATAL error (explicit message + exit), not a silent
  #     fail-open into "0 OK (eroded)". Note: a NONEXISTENT root directory is
  #     NOT a portable rc>=2 trigger here — with `--include` present, BSD
  #     grep (macOS /usr/bin/grep, this repo's dev-machine default) returns
  #     rc=1 (treated leniently as "no matching files"), while GNU grep
  #     returns rc=2 for the same input; using it as the fixture would make
  #     this assertion flaky across platforms. An UNREADABLE file (chmod 000)
  #     is portable: both BSD and GNU grep emit "Permission denied" at rc=2.
  #     Run count_literal in a subshell command-substitution so its `exit 2`
  #     terminates only the subshell, not the self-test harness itself.
  RC2_ROOT="${TMPDIR_ST}/rc2-root"
  mkdir -p "${RC2_ROOT}"
  printf 'x' > "${RC2_ROOT}/unreadable.ts"
  chmod 000 "${RC2_ROOT}/unreadable.ts"
  rc2_out=""
  rc2_rc=0
  rc2_out="$(count_literal "${RC2_ROOT}" "role-approver" ts 2>&1)" || rc2_rc=$?
  chmod 644 "${RC2_ROOT}/unreadable.ts"
  if [[ ${rc2_rc} -lt 2 ]]; then
    echo "FAIL self-test: expected rc>=2 (fatal) for an unreadable file, got rc=${rc2_rc}; output:"
    echo "${rc2_out}"
    exit 1
  fi
  if ! echo "${rc2_out}" | grep -qF "FAIL [anti-case-lock]: count_literal grep error"; then
    echo "FAIL self-test: expected explicit grep-error message for unreadable file, got:"
    echo "${rc2_out}"
    exit 1
  fi
  echo "PASS self-test: rc>=2 on a real grep error is FATAL with an explicit message (R-5)"

  # (7b) rc>=2 on read_baseline (missing BASELINE_FILE) is likewise FATAL.
  rc2b_out=""
  rc2b_rc=0
  rc2b_out="$(BASELINE_FILE="${TMPDIR_ST}/definitely-nonexistent-baseline.json"; read_baseline "role-approver" 2>&1)" || rc2b_rc=$?
  if [[ ${rc2b_rc} -lt 2 ]]; then
    echo "FAIL self-test: expected rc>=2 (fatal) for a missing baseline file, got rc=${rc2b_rc}; output:"
    echo "${rc2b_out}"
    exit 1
  fi
  echo "PASS self-test: rc>=2 on a missing baseline file is FATAL (R-5)"

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
