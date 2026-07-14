#!/usr/bin/env bash
# T-0249 [B-11 / анти-кейс] · customer-crm-anti-case — the "клиенты-подписки" case
# is CONTENT on the platform, never platform CODE (D-064 п.2, карта примитивов §5).
#
# THE CONTRACT (three phases):
#   Phase 1 — GENERIC-PLANE CLEAN: no customer/vendor case literal appears (as
#     CODE, not a doc-comment) in any GENERIC src/ module. The dogfood case is
#     quarantined to a fixed set of namespaces (runtime/customer-onboarding,
#     core/customer-subscription, adapters, composition, cli, vendor — the case's
#     home since T-0244). EVERY other src/ file — records.ts, inbox.ts,
#     list-views.ts, grant-resolver.ts, step-applier.ts, core/completion-effect.ts
#     (the NEW generic primitive), … — must carry ZERO case literal. This is the
#     celebrated clean state (count == 0), enforced as an EQUALITY, not a baseline
#     that may grow: T-0249 introduces the completion-effect primitive WITHOUT
#     leaking a single case string into it.
#
#   Phase 2 — CASE CONTENT IN SEED: the case identifiers MUST exist in seed/
#     migrations (proving Phase 1 passes because the case lives in DATA, not
#     because it was deleted): 'customer-onboarding' in migrations/ (the on_create
#     process_app_binding, migration 134) and 'customer-subscription' in
#     migrations/ + seed/vendor-crm/ (the registry, migration 073).
#
#   Phase 3 — GENERIC PRIMITIVE CASE-FREE: src/core/completion-effect.ts (the seam
#     the case plugs into) is called out explicitly — it keys off OPAQUE
#     (procKey, activity) strings and names no process/step/role/registry.
#
# METHODOLOGY (mirrors detel-literal-baseline.sh / anti-case-lock.sh, lesson
# T-0143): a line counts ONLY if it is (a) not under __tests__/ or a .test.* file,
# and (b) NOT a comment line (first non-space char is not //, * or /*). Match is
# quote-agnostic (double, single, backtick) — a case string used as an actual
# VALUE, never a doc-comment mention (explaining the ban is legitimately unbounded).
#
# --self-test: plants a case literal as CODE in a GENERIC-fixture file (detector
# fires), the SAME literal in a QUARANTINE-fixture file (allowed, no fire), and a
# comment-only mention in a generic file (no false positive).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC_ROOT="${PROJECT_ROOT}/src"

# The case identifiers (D-064 §5, customer-subscription dogfood zone).
CASE_LITERALS=(
  "customer-subscription"
  "customer-onboarding"
  "vendor-crm"
  "vendor-admin"
  "vendor-readonly"
)

# Sanctioned quarantine namespaces (the case's home since T-0244) — a case literal
# is EXPECTED here and NOT counted against the generic plane. Anchored on the path
# segment after src/ so it matches exactly these directories/prefixes.
QUARANTINE_RE='/(runtime/customer-onboarding|core/customer-subscription|adapters|composition|cli|vendor)/'

# ---------------------------------------------------------------------------
# count_generic_code <root> <literal> — code-only (comment/test-excluded),
# quote-agnostic count of a literal in GENERIC src (quarantine excluded).
# ZERO-SAFE: rc=1 (no match) is data (count 0); rc>=2 (real grep error) is FATAL.
# ---------------------------------------------------------------------------
count_generic_code() {
  local root="$1" literal="$2" raw rc filtered
  raw="$(grep -rn "[\"'\`]${literal}[\"'\`]" "${root}" --include="*.ts" 2>&1)"; rc=$?
  if [[ ${rc} -ge 2 ]]; then
    echo "FAIL [customer-crm-anti-case]: grep error (rc=${rc}) scanning '${root}' for '${literal}': ${raw}" >&2
    exit 2
  fi
  filtered="$( (printf '%s\n' "${raw}" || true) \
    | (grep -v '__tests__' || true) \
    | (grep -vE '\.test\.(ts|tsx|jsx|js)' || true) \
    | (grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' || true) \
    | (grep -vE "${QUARANTINE_RE}" || true) )"
  if [[ -z "${filtered}" ]]; then echo 0; else printf '%s\n' "${filtered}" | wc -l | tr -d '[:space:]'; fi
}

# count_in_file <file> <literal> — code-only, quote-agnostic count in ONE file.
count_in_file() {
  local file="$1" literal="$2" raw rc filtered
  [[ -f "${file}" ]] || { echo 0; return; }
  raw="$(grep -n "[\"'\`]${literal}[\"'\`]" "${file}" 2>&1)"; rc=$?
  if [[ ${rc} -ge 2 ]]; then
    echo "FAIL [customer-crm-anti-case]: grep error (rc=${rc}) reading '${file}': ${raw}" >&2
    exit 2
  fi
  # NB: single-file `grep -n` output is `line:content` (no filename prefix), so
  # the comment-strip anchor is ^line: — unlike the -rn variant in count_generic_code.
  filtered="$( (printf '%s\n' "${raw}" || true) | (grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' || true) )"
  if [[ -z "${filtered}" ]]; then echo 0; else printf '%s\n' "${filtered}" | wc -l | tr -d '[:space:]'; fi
}

run_phase1() {
  local root="$1" errors=0 lit cnt
  echo "Phase 1: generic-plane case-literal code count (quarantine excluded) — must be 0"
  for lit in "${CASE_LITERALS[@]}"; do
    cnt="$(count_generic_code "${root}" "${lit}")"
    if [[ "${cnt}" -ne 0 ]]; then
      echo "FAIL [customer-crm-anti-case]: '${lit}' appears as CODE in a GENERIC src module (${cnt} occurrence(s)) — move the case content to seed/migrations or the sanctioned quarantine namespace"
      printf '%s\n' "$(grep -rn "[\"'\`]${lit}[\"'\`]" "${root}" --include="*.ts" | grep -v '__tests__' | grep -vE '\.test\.(ts|tsx|jsx|js)' | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' | grep -vE "${QUARANTINE_RE}")"
      errors=$((errors + 1))
    else
      echo "  ${lit}: 0 (generic plane clean)"
    fi
  done
  return ${errors}
}

# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[customer-crm-anti-case] --self-test"
  TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
  mkdir -p "${TMP}/src/http" "${TMP}/src/runtime/customer-onboarding" "${TMP}/src/__tests__"

  # (1) case literal as CODE in a GENERIC file → MUST be detected.
  cat > "${TMP}/src/http/leaky.ts" <<'TS'
export const REG = "customer-subscription";
TS
  c="$(count_generic_code "${TMP}/src" "customer-subscription")"
  [[ "${c}" == "1" ]] || { echo "FAIL self-test: generic code leak not detected (got ${c})"; exit 1; }
  echo "PASS self-test: generic-plane code leak detected"

  # (2) SAME literal in a QUARANTINE file → allowed (NOT counted).
  cat > "${TMP}/src/runtime/customer-onboarding/ok.ts" <<'TS'
export const REG2 = "customer-subscription";
TS
  c2="$(count_generic_code "${TMP}/src" "customer-subscription")"
  [[ "${c2}" == "1" ]] || { echo "FAIL self-test: quarantine occurrence wrongly counted (got ${c2}, expected 1)"; exit 1; }
  echo "PASS self-test: quarantine namespace occurrence excluded"

  # (3) comment-only mention in a generic file → NO false positive.
  cat > "${TMP}/src/http/commented.ts" <<'TS'
// mentions customer-subscription and "customer-onboarding" in prose only
export const X = 1;
TS
  c3="$(count_generic_code "${TMP}/src" "customer-onboarding")"
  [[ "${c3}" == "0" ]] || { echo "FAIL self-test: comment mention false-positived (got ${c3})"; exit 1; }
  echo "PASS self-test: comment-only mention excluded"

  # (4) test-file occurrence → excluded.
  cat > "${TMP}/src/__tests__/x.test.ts" <<'TS'
const T = "vendor-admin";
TS
  c4="$(count_generic_code "${TMP}/src" "vendor-admin")"
  [[ "${c4}" == "0" ]] || { echo "FAIL self-test: test-file occurrence counted (got ${c4})"; exit 1; }
  echo "PASS self-test: test-file occurrence excluded"

  echo "PASS self-test: all customer-crm-anti-case detectors functional"
  exit 0
fi

# ---------------------------------------------------------------------------
# Production check
# ---------------------------------------------------------------------------
echo "[T-0249] customer-crm-anti-case: клиенты-подписки = case content, not platform code"
ERRORS=0

if ! run_phase1 "${SRC_ROOT}"; then
  ERRORS=$((ERRORS + 1))
fi

echo ""
echo "Phase 2: case content lives in seed/migrations (proves Phase 1 by relocation, not deletion)"
if ! grep -rql "customer-onboarding" "${PROJECT_ROOT}/migrations"; then
  echo "FAIL [customer-crm-anti-case]: 'customer-onboarding' not found in migrations/ (the on_create binding must be seeded)"
  ERRORS=$((ERRORS + 1))
else
  echo "  customer-onboarding: present in migrations/ (on_create binding) OK"
fi
if ! grep -rql "customer-subscription" "${PROJECT_ROOT}/migrations" || [[ ! -d "${PROJECT_ROOT}/seed/vendor-crm" ]]; then
  echo "FAIL [customer-crm-anti-case]: 'customer-subscription' registry not seeded (migrations/ + seed/vendor-crm/)"
  ERRORS=$((ERRORS + 1))
else
  echo "  customer-subscription: present in migrations/ + seed/vendor-crm/ (registry) OK"
fi

echo ""
echo "Phase 3: generic completion-effect primitive is case-free"
CE="${SRC_ROOT}/core/completion-effect.ts"
if [[ ! -f "${CE}" ]]; then
  echo "FAIL [customer-crm-anti-case]: src/core/completion-effect.ts (the generic seam) not found"
  ERRORS=$((ERRORS + 1))
else
  ce_errors=0
  for lit in "${CASE_LITERALS[@]}"; do
    n="$(count_in_file "${CE}" "${lit}")"
    if [[ "${n}" -ne 0 ]]; then
      echo "FAIL [customer-crm-anti-case]: '${lit}' appears as CODE in the GENERIC primitive completion-effect.ts (${n})"
      ce_errors=$((ce_errors + 1))
    fi
  done
  if [[ ${ce_errors} -eq 0 ]]; then
    echo "  completion-effect.ts: case-free (keys off opaque strings) OK"
  else
    ERRORS=$((ERRORS + ce_errors))
  fi
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: customer-crm-anti-case found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: customer-crm-anti-case — generic plane clean, case content in seed, primitive case-free"
exit 0
