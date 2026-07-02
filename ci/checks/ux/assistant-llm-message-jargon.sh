#!/usr/bin/env bash
# T-0573 (ADR-T0573 §2.2 B3, F6/AC-7) · FF-UX-7 — the user-facing
# "LLM unavailable" message must not contain developer jargon.
#
# THE CONTRACT: src/core/assistant-messages.ts's ASSISTANT_LLM_UNAVAILABLE_MESSAGE
# (used verbatim for BOTH the dormant path and the adapter-failure path in
# src/http/assistant.ts) MUST:
#   (a) contain the /llm-connections path (where the user acts) — AC-6;
#   (b) NOT contain any of the dev-jargon denylist tokens (AC-7): a RAW,
#       unexplained LLM_NOT_CONFIGURED code-as-text, OpenAILlmPort,
#       "endpoint", "secretHandle", "stack".
#
# Exit 0 on clean, non-zero on any violation. --self-test exercises the
# detector against planted good/bad fixtures (mirrors ux-g5-jargon-denylist.sh
# discipline).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TARGET="${ROOT}/src/core/assistant-messages.ts"

DENYLIST=('LLM_NOT_CONFIGURED' 'OpenAILlmPort' 'endpoint' 'secretHandle' 'stack')

# Extract the value of the exported ASSISTANT_LLM_UNAVAILABLE_MESSAGE constant
# (everything inside the string literal assigned to it) from a given file.
extract_message() {
  local file="$1"
  awk '
    /ASSISTANT_LLM_UNAVAILABLE_MESSAGE[[:space:]]*=/ { capture=1 }
    capture { print }
    capture && /;[[:space:]]*$/ { exit }
  ' "${file}"
}

check_file() {
  local file="$1" errors=0
  if [[ ! -f "${file}" ]]; then
    echo "FAIL [FF-UX-7]: ${file} not found"
    return 1
  fi
  local msg
  msg="$(extract_message "${file}")"
  if [[ -z "${msg}" ]]; then
    echo "FAIL [FF-UX-7]: ASSISTANT_LLM_UNAVAILABLE_MESSAGE not found in ${file}"
    return 1
  fi

  if ! echo "${msg}" | grep -qF '/llm-connections'; then
    echo "FAIL [FF-UX-7/AC-6]: message does not contain '/llm-connections'"
    errors=$((errors + 1))
  fi

  for tok in "${DENYLIST[@]}"; do
    if echo "${msg}" | grep -qF "${tok}"; then
      echo "FAIL [FF-UX-7/AC-7]: message contains dev-jargon token '${tok}'"
      errors=$((errors + 1))
    fi
  done

  return ${errors}
}

self_test() {
  echo "[T-0573] assistant-llm-message-jargon --self-test"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  cat >"${tmp}/good.ts" <<'EOF'
export const ASSISTANT_LLM_UNAVAILABLE_MESSAGE =
  "Ассистент пока не может ответить — не подключён рабочий LLM-ключ. " +
  "Подключите или проверьте ключ на странице «Подключения LLM» (/llm-connections), затем повторите.";
EOF

  cat >"${tmp}/bad.ts" <<'EOF'
export const ASSISTANT_LLM_UNAVAILABLE_MESSAGE =
  "LLM_NOT_CONFIGURED: OpenAILlmPort failed, check endpoint and secretHandle. stack: at foo.ts:1";
EOF

  set +e
  check_file "${tmp}/good.ts" >/dev/null 2>&1
  local good_rc=$?
  check_file "${tmp}/bad.ts" >/dev/null 2>&1
  local bad_rc=$?
  set -e

  if [[ ${good_rc} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD fixture (rc=${good_rc})"
    return 1
  fi
  if [[ ${bad_rc} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD (jargon) fixture"
    return 1
  fi
  echo "SELF-TEST PASS: good fixture clean (rc=0), bad fixture flagged (rc=${bad_rc})"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0573] assistant-llm-message-jargon: FF-UX-7 dev-jargon denylist on the LLM-unavailable message"
set +e
check_file "${TARGET}"
errors=$?
set -e
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: assistant-llm-message-jargon found ${errors} violation(s)"
  exit 1
fi
echo "PASS: assistant-llm-message-jargon — message contains /llm-connections, no dev-jargon"
exit 0
