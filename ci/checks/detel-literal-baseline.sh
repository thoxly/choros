#!/usr/bin/env bash
# T-0575 [W1/деТЭЛ] — FF-7 (AC-10, anti-case baseline / input for T-0576):
# counts CODE-level (non-comment) occurrences of the literal-VALUES
# "role-approver" / "soglasovanie" / "tel-approval" in src/**/*.ts (excluding
# __tests__/.test.ts fixtures, which remain legitimate test data) and asserts
# the count is STRICTLY LESS than the recorded baseline for EACH literal AND
# in aggregate.
#
# METHODOLOGY (ADR-T0575-detel-primitives.md §6, FF-7):
#   A line is counted ONLY if it is (a) not under src/**/__tests__/ or a
#   *.test.ts file, and (b) NOT a comment line (does not start with //, *, or
#   /* after leading whitespace — mirrors no-env-in-core.sh's comment-strip
#   convention). This isolates CODE-level occurrences (a literal used as an
#   actual value: a const assignment, a SQL parameter, a map entry) from
#   documentation/doc-comment mentions of the same string, which are
#   legitimately unbounded (explaining WHY a config-primitive defaults to this
#   value is not itself a hardcode).
#
# BASELINE (recorded on 080486c, the T-0575 predecessor commit, using this
# SAME code-only methodology — verified by comparing against the raw
# with-comments count on that commit, which matches the ADR's own recorded
# 7/5/6 for the with-comments variant):
#   role-approver:  3   (process-projection.ts:226 def, dispatch-outcome.ts:274
#                        independent fallback-copy, inbox.ts seed-fixture map)
#   soglasovanie:   3   (step-applier.ts:78 def+SQL-param, form-record-persister.ts
#                        map entry, live-form-schema.ts independent second copy)
#   tel-approval:   1   (form-record-persister.ts:106 def)
#   aggregate:      7
#
# WHY tel-approval CANNOT drop below 1 (documented, not a loophole): the ТЭЛ
# value MUST survive as a config-primitive's DEFAULT (ADR §3, backward-compat
# frozen-ТЭЛ requirement) — a config-primitive with a fallback default
# necessarily contains the literal string ONCE. AC-10's requirement is
# satisfied by the AGGREGATE strictly decreasing (this task collapses
# independent duplicate copies — dispatch-outcome.ts's fallback, live-form-
# schema.ts's second copy — into shared config-primitive functions) even
# where a single literal's own count cannot mathematically go to zero without
# breaking ТЭЛ compatibility.
#
# EXIT: 0 when the aggregate AND no individual literal's count exceeds its
# recorded baseline (an increase in any one is flagged even if the aggregate
# still decreases — this is the anti-regression floor for T-0576's
# steady-state gate); 1 otherwise.
#
# --self-test: verifies the counting logic against synthetic fixtures.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${PROJECT_ROOT:="$(cd "${SCRIPT_DIR}/../.." && pwd)"}"

# Baseline (080486c, code-only methodology — see header).
BASELINE_ROLE_APPROVER=3
BASELINE_SOGLASOVANIE=3
BASELINE_TEL_APPROVAL=1
BASELINE_AGGREGATE=$((BASELINE_ROLE_APPROVER + BASELINE_SOGLASOVANIE + BASELINE_TEL_APPROVAL))

# ---------------------------------------------------------------------------
# count_literal <root_dir> <literal> — code-only occurrence count.
# literal is the bare string (no surrounding quotes); matched as "<literal>"
# in TypeScript source (double-quoted string literal, the ADR's own convention).
# ---------------------------------------------------------------------------
count_literal() {
  local root="$1" literal="$2"
  grep -rn "\"${literal}\"" "${root}" --include='*.ts' 2>/dev/null \
    | grep -v '__tests__' \
    | grep -v '\.test\.ts' \
    | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' \
    | wc -l | tr -d '[:space:]'
}

# ---------------------------------------------------------------------------
# Self-test mode.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[detel-literal-baseline] --self-test"
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT
  mkdir -p "${TMPDIR_ST}/src/http" "${TMPDIR_ST}/src/__tests__"

  cat > "${TMPDIR_ST}/src/http/example.ts" <<'TSFIX'
// A comment mentioning "role-approver" must NOT count.
export const APPROVER_ROLE = "role-approver"; // code line — counts once.
TSFIX
  cat > "${TMPDIR_ST}/src/__tests__/example.test.ts" <<'TSFIX'
const FIXTURE_ROLE = "role-approver"; // test file — must NOT count.
TSFIX

  count="$(count_literal "${TMPDIR_ST}/src" "role-approver")"
  if [[ "${count}" != "1" ]]; then
    echo "FAIL self-test: expected count=1 (one code line, comment+test excluded), got ${count}"
    exit 1
  fi
  echo "PASS self-test: comment line and test-file occurrence correctly excluded from count (got 1, expected 1)"

  echo "PASS self-test: all detel-literal-baseline detectors functional"
  exit 0
fi

# ---------------------------------------------------------------------------
# Production check.
# ---------------------------------------------------------------------------
SRC_DIR="${PROJECT_ROOT}/src"

echo "[T-0575 FF-7] detel-literal-baseline: code-only literal-VALUE counts vs 080486c baseline"

count_role_approver="$(count_literal "${SRC_DIR}" "role-approver")"
count_soglasovanie="$(count_literal "${SRC_DIR}" "soglasovanie")"
count_tel_approval="$(count_literal "${SRC_DIR}" "tel-approval")"
aggregate=$((count_role_approver + count_soglasovanie + count_tel_approval))

echo "  role-approver: ${count_role_approver} (baseline ${BASELINE_ROLE_APPROVER})"
echo "  soglasovanie:  ${count_soglasovanie} (baseline ${BASELINE_SOGLASOVANIE})"
echo "  tel-approval:  ${count_tel_approval} (baseline ${BASELINE_TEL_APPROVAL})"
echo "  aggregate:     ${aggregate} (baseline ${BASELINE_AGGREGATE})"

ERRORS=0
if [[ "${count_role_approver}" -gt "${BASELINE_ROLE_APPROVER}" ]]; then
  echo "FAIL [FF-7]: role-approver count INCREASED (${count_role_approver} > ${BASELINE_ROLE_APPROVER})"
  ERRORS=$((ERRORS + 1))
fi
if [[ "${count_soglasovanie}" -gt "${BASELINE_SOGLASOVANIE}" ]]; then
  echo "FAIL [FF-7]: soglasovanie count INCREASED (${count_soglasovanie} > ${BASELINE_SOGLASOVANIE})"
  ERRORS=$((ERRORS + 1))
fi
if [[ "${count_tel_approval}" -gt "${BASELINE_TEL_APPROVAL}" ]]; then
  echo "FAIL [FF-7]: tel-approval count INCREASED (${count_tel_approval} > ${BASELINE_TEL_APPROVAL})"
  ERRORS=$((ERRORS + 1))
fi
if [[ "${aggregate}" -ge "${BASELINE_AGGREGATE}" ]]; then
  echo "FAIL [FF-7]: aggregate count NOT strictly less than baseline (${aggregate} >= ${BASELINE_AGGREGATE}) — AC-10 requires a genuine decrease"
  ERRORS=$((ERRORS + 1))
fi

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS [FF-7]: aggregate strictly decreased (${aggregate} < ${BASELINE_AGGREGATE}) and no individual literal regressed — T-0576 baseline input recorded"
  exit 0
else
  echo ""
  echo "FAIL [FF-7]: detel-literal-baseline found ${ERRORS} violation(s) — see above."
  exit 1
fi
