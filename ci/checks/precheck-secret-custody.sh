#!/usr/bin/env bash
# FF-LP-8 (T-0233 AC-13/NF-3) — RL-3 secret custody on LLM path.
#
# Rules:
#   (a) src/core/llm-port.ts does NOT import SecretResolverPort or process.env
#       (the core type doesn't touch the secret — only the adapter does).
#   (b) The production adapter (src/adapters/openai-llm-port.ts) uses validateSecretHandleShape
#       and SecretResolverPort, not a raw key.
#   (c) No raw llm_secret_handle value is logged/audited/responded on the runtime path:
#       grep for patterns that would put the secret in console/audit/response.
#
# Exit 0 on all pass; non-zero on violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${ROOT}/src"
ERRORS=0

if [[ "${1:-}" == "--self-test" ]]; then
  PLANTED='console.log("key:", apiKey, llm_secret_handle);'
  if printf '%s\n' "${PLANTED}" | grep -qE 'console\.(log|error|warn|info).*llm_secret_handle'; then
    echo "PASS self-test: secret-in-log pattern is detectable"
    exit 0
  fi
  echo "FAIL self-test: secret-in-log detector broken"
  exit 1
fi

echo "[FF-LP-8] precheck-secret-custody: RL-3 LLM secret custody (AC-13/NF-3)"

# (a) Core LlmPort type must NOT import or USE secret-related items on code lines.
#     Comment-only mentions (lines starting with * / // /*) are permitted (same pattern as no-env-in-core.sh).
LLM_PORT="${SRC}/core/llm-port.ts"
if [[ -f "${LLM_PORT}" ]]; then
  # Strip comment-only lines; check remaining code lines for env/secret.
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${LLM_PORT}" 2>/dev/null || true)
  ENV_HITS=$(printf '%s\n' "${CODE_LINES}" | grep -nE 'process\.env|SecretResolverPort|resolveSecret' || true)
  if [[ -n "${ENV_HITS}" ]]; then
    echo "FAIL FF-LP-8(a): llm-port.ts uses env/secret on code line (must be pure):"
    echo "${ENV_HITS}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-8(a): llm-port.ts is pure (no env/secret access on code lines)"
  fi
fi

# (b) Adapter uses validateSecretHandleShape and SecretResolverPort.
ADAPTER="${SRC}/adapters/openai-llm-port.ts"
if [[ -f "${ADAPTER}" ]]; then
  if ! grep -q "validateSecretHandleShape\|SecretResolverPort" "${ADAPTER}"; then
    echo "FAIL FF-LP-8(b): openai-llm-port.ts does not use validateSecretHandleShape or SecretResolverPort (RL-3)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-LP-8(b): adapter uses RL-3 secret custody (validateSecretHandleShape/SecretResolverPort)"
  fi
fi

# (c) No raw secret leaked to console/audit/response on the runtime path.
RUNTIME_PATHS_CHECK=(
  "${SRC}/runtime/legal-precheck"
  "${SRC}/core/agent-precheck-motor.ts"
  "${SRC}/core/llm-port.ts"
)
SECRET_LEAK_RE='console\.(log|error|warn|info).*llm_secret_handle|appendAuditEvent.*llm_secret_handle|res\.json.*llm_secret_handle'
for P in "${RUNTIME_PATHS_CHECK[@]}"; do
  [[ -e "${P}" ]] || continue
  if [[ -d "${P}" ]]; then
    LEAKS=$(grep -rnE "${SECRET_LEAK_RE}" "${P}" --include="*.ts" 2>/dev/null \
      | grep -vE '__tests__|\.test\.ts' || true)
  else
    LEAKS=$(grep -nE "${SECRET_LEAK_RE}" "${P}" 2>/dev/null || true)
  fi
  if [[ -n "${LEAKS}" ]]; then
    echo "FAIL FF-LP-8(c): raw llm_secret_handle leaked in ${P}:"
    echo "${LEAKS}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ ${ERRORS} -eq 0 ]]; then
  echo "PASS FF-LP-8(c): no raw secret in console/audit/response on runtime path"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: precheck-secret-custody found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: precheck-secret-custody — FF-LP-8 / AC-13/NF-3 green"
exit 0
