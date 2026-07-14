#!/usr/bin/env bash
# T-0283 · FF-4 — seed-idempotent: the canonical ТЭЛ bootstrap is deterministic +
# idempotent (repeat run = no-op) and uses ZERO paid LLM (ADR T-0278 §2.4 / NF3 /
# AC-10, FF-4).
#
# Static assertions (grep / boundary analysis — no runtime) over e2e/bootstrap-tel.ts
# and the seed source it relies on:
#   FF-4-1 — the bootstrap is idempotent BY CONSTRUCTION: it deploys the BPMN by
#            process-definition-key (Flowable versions by key → repeat is startable
#            no-op) and VERIFIES seeded actors read-only — it performs NO destructive
#            re-seed / DROP / DELETE / TRUNCATE and opens NO direct pg connection
#            (the migrations already seeded the tenant; bootstrap only checks).
#   FF-4-2 — ZERO paid LLM: the intake agent-slot stays DORMANT (agent_card llm_*
#            NULL in seed/demo/tel-scenario.ts) and the bootstrap configures /
#            calls NO llm endpoint. Reuses the dormancy boundary of
#            budget-dormancy.sh / agent-instruction-runtime-dormant.sh.
#
# SELF-TEST (`--self-test`): plants a TRUNCATE + a live llm_endpoint assignment and
# asserts the predicates fire (FF-SELFTEST).
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BOOTSTRAP="${PROJECT_ROOT}/e2e/bootstrap-tel.ts"
TEL_SCENARIO="${PROJECT_ROOT}/seed/demo/tel-scenario.ts"
ERRORS=0

grep_noncomment() {
  local pattern="$1" file="$2" out rc
  set +e
  out="$(grep -vE '^[[:space:]]*(//|\*|/\*|#)' "${file}" | grep -nE "${pattern}")"
  rc=$?
  set -e
  if [[ ${rc} -ge 2 ]]; then
    echo "ERROR: grep failed (rc=${rc}) on pattern '${pattern}' in ${file}"
    exit 2
  fi
  printf '%s' "${out}"
}

# ---------------------------------------------------------------------------
# --self-test
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/seed-idem-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT
  printf 'await client.query("TRUNCATE choros.employee");\nllm_endpoint = "https://api.openai.com/v1";\n' > "$TMP"
  if [[ -z "$(grep_noncomment 'TRUNCATE|DROP |DELETE FROM' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: destructive seed not detected — check is broken"; exit 2
  fi
  if [[ -z "$(grep_noncomment 'llm_endpoint[[:space:]]*[:=][[:space:]]*["'"'"']https?:' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: live llm_endpoint not detected — check is broken"; exit 2
  fi
  echo "SELF-TEST PASS: seed-idempotent predicates detect planted violations"
  exit 0
fi

echo "[T-0283 FF-4] seed-idempotent: bootstrap is idempotent + ZERO paid LLM"

if [[ ! -f "${BOOTSTRAP}" ]]; then
  echo "FAIL [FF-4]: bootstrap missing: ${BOOTSTRAP}"; exit 1
fi
if [[ ! -f "${TEL_SCENARIO}" ]]; then
  echo "FAIL [FF-4]: tel-scenario seed missing: ${TEL_SCENARIO}"; exit 1
fi

# ---- FF-4-1: idempotent by construction — no destructive re-seed, no direct pg --
before=${ERRORS}
destructive="$(grep_noncomment 'TRUNCATE|DROP[[:space:]]|DELETE[[:space:]]+FROM' "${BOOTSTRAP}")"
if [[ -n "${destructive}" ]]; then
  echo "FAIL [FF-4-1]: bootstrap performs a destructive operation (breaks idempotency):"
  echo "${destructive}"
  ERRORS=$((ERRORS + 1))
fi
direct_pg="$(grep_noncomment "from ['\"]pg['\"]|new[[:space:]]+Pool\(|require\(['\"]pg['\"]\)" "${BOOTSTRAP}")"
if [[ -n "${direct_pg}" ]]; then
  echo "FAIL [FF-4-1]: bootstrap opens a direct pg connection (must verify read-only via API, not re-seed):"
  echo "${direct_pg}"
  ERRORS=$((ERRORS + 1))
fi
# Positive: it must deploy the BPMN by key (the idempotent unit) — repeat is startable.
if ! grep -qE "telLinear|tel-linear" "${BOOTSTRAP}"; then
  echo "FAIL [FF-4-1]: bootstrap does not reference the canonical telLinear deployment"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-4-1]: bootstrap idempotent by construction (deploy-by-key + read-only verify)"
fi

# ---- FF-4-2: ZERO paid LLM — agent_card DORMANT, bootstrap configures no llm -----
before=${ERRORS}
# The seed agent_card must keep llm_* NULL (dormant). A live (string) llm_endpoint
# would be a paid-LLM wire. Reuse the same boundary as budget-dormancy.sh.
live_llm_seed="$(grep_noncomment 'llm_endpoint[[:space:]]*:[[:space:]]*["'"'"']https?:' "${TEL_SCENARIO}")"
if [[ -n "${live_llm_seed}" ]]; then
  echo "FAIL [FF-4-2]: tel-scenario seeds a LIVE llm_endpoint (paid LLM in CI — must stay DORMANT/NULL):"
  echo "${live_llm_seed}"
  ERRORS=$((ERRORS + 1))
fi
if ! grep -qE "llm_endpoint:[[:space:]]*null" "${TEL_SCENARIO}"; then
  echo "FAIL [FF-4-2]: tel-scenario agent_card is not provably DORMANT (llm_endpoint: null expected)"
  ERRORS=$((ERRORS + 1))
fi
# The bootstrap itself must not configure/call an llm endpoint.
boot_llm="$(grep_noncomment 'llm_endpoint[[:space:]]*[:=][[:space:]]*["'"'"']https?:|openai|anthropic\.com|api\.openai' "${BOOTSTRAP}")"
if [[ -n "${boot_llm}" ]]; then
  echo "FAIL [FF-4-2]: bootstrap configures/calls an LLM endpoint (paid LLM):"
  echo "${boot_llm}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-4-2]: ZERO paid LLM (agent_card DORMANT, bootstrap calls no llm)"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: seed-idempotent found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: seed-idempotent (FF-4) clean"
