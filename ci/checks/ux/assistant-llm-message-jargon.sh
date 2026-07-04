#!/usr/bin/env bash
# T-0573 (ADR-T0573 §2.2 B3, F6/AC-7) · FF-UX-7 — the user-facing
# "LLM unavailable" message must not contain developer jargon.
#
# THE ORIGINAL CONTRACT (T-0573): src/core/assistant-messages.ts's
# ASSISTANT_LLM_UNAVAILABLE_MESSAGE (used verbatim for BOTH the dormant path
# and the adapter-failure path in src/http/assistant.ts) MUST:
#   (a) contain the /llm-connections path (where the user acts) — AC-6;
#   (b) NOT contain any of the dev-jargon denylist tokens (AC-7): a RAW,
#       unexplained LLM_NOT_CONFIGURED code-as-text, OpenAILlmPort,
#       "endpoint", "secretHandle", "stack".
#
# T-0595 по UX_REVIEW T-0573 F-2 (SANCTIONED, additive update — the finding
# belongs to T-0573's own steward, this gate is REBUILT under its own
# recommendation, not weakened blindly):
#
#   UX_REVIEW T-0573 finding F-1 caught that /llm-connections lives in the
#   admin-only nav zone (nav-config.js, capability sentinel mgmt_object:*) —
#   a builder-non-admin who saw the bare path in F-1's prose could neither
#   click it (no deep-link existed) nor reach it via their own nav (admin
#   zone hidden). Finding F-2 explicitly recommended: "when a click-through
#   exists, remove the bare (/llm-connections) from the prose — the page
#   title + a clickable button carry both 'where' and 'how' without the
#   technical slash-path". T-0595 IS that click-through (respondLlmUnavailable
#   now resolves caller admin-status and emits a structured error.deepLinks
#   descriptor for admins).
#
#   The SINGLE constant is therefore split into TWO, each with ITS OWN
#   contract — checked below:
#
#   ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN (admin caller — CAN act):
#     (a) does NOT contain the bare /llm-connections path (F-2 — replaced by
#         a clickable deep-link button, checked structurally elsewhere, not
#         by a substring in the prose);
#     (b) DOES name the target page by its FACTUAL nav/h1 title
#         ("LLM-соединения" — nav-config.js:162; UX_REVIEW T-0595 F-1: the
#         name must match the real screen, not a paraphrase), so the
#         sentence still reads as human prose, not a bare pointer;
#     (c) NO dev-jargon denylist tokens (AC-7 unchanged).
#
#   ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN (non-admin caller — CANNOT
#   act; the admin path is a dead door for them):
#     (a) does NOT contain /llm-connections (never offer a path they cannot
#         reach through their own nav);
#     (b) DOES mention "администратор" — honestly redirects them to someone
#         who can act, instead of a dead pointer;
#     (c) NO dev-jargon denylist tokens (AC-7 unchanged).
#
# T-0587 (ADR-T0587 §2.1, FF-8/AC-9): a THIRD constant joins the checked set —
# ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE (the analyst's honest FR-3/FR-5
# zone-of-visibility refusal). Its contract is DIFFERENT from the two LLM-
# unavailable constants above (no admin/non-admin split, no /llm-connections
# deep-link) — it is checked for:
#   (a) the SAME dev-jargon DENYLIST (no reason a refusal message should ever
#       carry OpenAILlmPort/endpoint/secretHandle/stack/LLM_NOT_CONFIGURED);
#   (b) FR-5: must NOT claim "данных в системе нет" (a false SYSTEM-STATE
#       claim) — the message is about the ASKER's own zone of visibility,
#       phrased "в вашей зоне видимости";
#   (c) genericity (D-064): no case-specific business term (registry/record
#       name) baked into the constant.
#
# Exit 0 on clean, non-zero on any violation. --self-test exercises the
# detector against planted good/bad fixtures for ALL THREE constants (mirrors
# ux-g5-jargon-denylist.sh discipline).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TARGET="${ROOT}/src/core/assistant-messages.ts"

DENYLIST=('LLM_NOT_CONFIGURED' 'OpenAILlmPort' 'endpoint' 'secretHandle' 'stack')

# Extract the value of a given exported constant (everything inside the
# string literal assigned to it) from a given file.
extract_message() {
  local file="$1" const_name="$2"
  awk -v name="${const_name}" '
    $0 ~ name"[[:space:]]*=" { capture=1 }
    capture { print }
    capture && /;[[:space:]]*$/ { exit }
  ' "${file}"
}

# NOTE ON ERRCOUNT STYLE: this file runs under `set -e`. Functions below
# accumulate an error COUNT and return it via a variable (not `return N`,
# which — combined with `set -e` — aborts the caller the instant a nested
# function call's exit status is used in arithmetic without an explicit
# `if`/`||`/`&&` guard). `count_denylist_violations` etc. therefore print to
# stdout the number of violations found; callers capture it with `$(...)`
# (command substitution does not trigger errexit on a non-zero exit).

count_denylist_violations() {
  local msg="$1" label="$2" errors=0
  for tok in "${DENYLIST[@]}"; do
    if echo "${msg}" | grep -qF "${tok}"; then
      echo "FAIL [FF-UX-7/AC-7]: ${label} contains dev-jargon token '${tok}'" >&2
      errors=$((errors + 1))
    fi
  done
  echo "${errors}"
}

count_admin_message_violations() {
  local file="$1" errors=0
  local msg
  msg="$(extract_message "${file}" 'ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN')"
  if [[ -z "${msg}" ]]; then
    echo "FAIL [FF-UX-7]: ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN not found in ${file}" >&2
    echo 1
    return
  fi

  # T-0595/F-2: bare path must be GONE from admin prose (deep-link button
  # replaces it structurally — see ADR-T0595 §1.2).
  if echo "${msg}" | grep -qF '/llm-connections'; then
    echo "FAIL [T-0595/F-2]: ADMIN message still contains the bare '/llm-connections' path — replace with a deep-link, not prose" >&2
    errors=$((errors + 1))
  fi
  # UX_REVIEW T-0595 F-1: the page must be named by its FACTUAL nav/h1 title.
  if ! echo "${msg}" | grep -qF 'LLM-соединения'; then
    echo "FAIL [T-0595/F-1]: ADMIN message does not name the target page by its factual title ('LLM-соединения')" >&2
    errors=$((errors + 1))
  fi

  local denylist_errors
  denylist_errors="$(count_denylist_violations "${msg}" "ADMIN message")"
  errors=$((errors + denylist_errors))

  echo "${errors}"
}

count_non_admin_message_violations() {
  local file="$1" errors=0
  local msg
  msg="$(extract_message "${file}" 'ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN')"
  if [[ -z "${msg}" ]]; then
    echo "FAIL [FF-UX-7]: ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN not found in ${file}" >&2
    echo 1
    return
  fi

  # T-0595/AC-3: never offer a path the non-admin caller cannot reach via
  # their own nav (admin zone is hidden from them) — no dead door.
  if echo "${msg}" | grep -qF '/llm-connections'; then
    echo "FAIL [T-0595/AC-3]: NON_ADMIN message contains '/llm-connections' — that path is a dead door for a non-admin caller" >&2
    errors=$((errors + 1))
  fi
  if ! echo "${msg}" | grep -qiF 'администратор'; then
    echo "FAIL [T-0595/AC-3]: NON_ADMIN message does not honestly redirect to 'администратор'" >&2
    errors=$((errors + 1))
  fi

  local denylist_errors
  denylist_errors="$(count_denylist_violations "${msg}" "NON_ADMIN message")"
  errors=$((errors + denylist_errors))

  echo "${errors}"
}

count_no_visible_data_message_violations() {
  local file="$1" errors=0
  local msg
  msg="$(extract_message "${file}" 'ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE')"
  if [[ -z "${msg}" ]]; then
    echo "FAIL [FF-8/T-0587]: ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE not found in ${file}" >&2
    echo 1
    return
  fi

  # FR-5 (T-0587): must NOT claim system-wide absence as fact — only the
  # asker's own zone of visibility. Checked as the CAPITALISED/asserted form
  # (mirrors the existing "Записей нет" vs "записей нет" convention in
  # src/core/assistant-analyst.ts — the instruction text may legitimately
  # MENTION the banned phrase inside a negative directive to the LLM without
  # itself being a violation of the constant's own contract).
  if echo "${msg}" | grep -qF 'Данных в системе нет'; then
    echo "FAIL [FR-5/T-0587]: ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE asserts system-wide absence as fact ('Данных в системе нет') — must be framed as the asker's OWN zone of visibility" >&2
    errors=$((errors + 1))
  fi
  # FR-5 positive check: the message DOES frame this as the asker's own zone
  # of visibility.
  if ! echo "${msg}" | grep -qF 'зоне видимости'; then
    echo "FAIL [FR-5/T-0587]: ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE does not frame the refusal as the asker's OWN zone of visibility ('зоне видимости')" >&2
    errors=$((errors + 1))
  fi

  local denylist_errors
  denylist_errors="$(count_denylist_violations "${msg}" "ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE")"
  errors=$((errors + denylist_errors))

  echo "${errors}"
}

check_file() {
  local file="$1" errors=0
  if [[ ! -f "${file}" ]]; then
    echo "FAIL [FF-UX-7]: ${file} not found" >&2
    return 1
  fi

  local admin_errors non_admin_errors no_visible_data_errors
  admin_errors="$(count_admin_message_violations "${file}")"
  non_admin_errors="$(count_non_admin_message_violations "${file}")"
  no_visible_data_errors="$(count_no_visible_data_message_violations "${file}")"
  errors=$((admin_errors + non_admin_errors + no_visible_data_errors))

  return ${errors}
}

self_test() {
  echo "[T-0573/T-0595] assistant-llm-message-jargon --self-test"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  cat >"${tmp}/good.ts" <<'EOF'
export const ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN =
  "Ассистент пока не может ответить — не подключён рабочий LLM-ключ. " +
  "Подключите или проверьте ключ на странице «LLM-соединения», затем повторите.";

export const ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN =
  "Ассистент пока не может ответить — не подключён рабочий LLM-ключ. " +
  "Обратитесь к администратору вашей организации, чтобы подключить ключ — " +
  "когда ключ подключат, ассистент начнёт отвечать.";

export const ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE =
  "В вашей зоне видимости данных по этому вопросу нет. " +
  "Если данные должны быть вам доступны — обратитесь к администратору вашей " +
  "организации, чтобы он выдал доступ.";
EOF

  cat >"${tmp}/bad.ts" <<'EOF'
export const ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN =
  "LLM_NOT_CONFIGURED: OpenAILlmPort failed, check endpoint and secretHandle (/llm-connections). stack: at foo.ts:1";

export const ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN =
  "LLM_NOT_CONFIGURED: go to /llm-connections yourself. OpenAILlmPort endpoint secretHandle stack";

export const ASSISTANT_ANALYST_NO_VISIBLE_DATA_MESSAGE =
  "Данных в системе нет. LLM_NOT_CONFIGURED OpenAILlmPort endpoint secretHandle stack";
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
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD (jargon + dead-path + no-admin-redirect) fixture"
    return 1
  fi
  echo "SELF-TEST PASS: good fixture clean (rc=0), bad fixture flagged (rc=${bad_rc})"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0573/T-0595/T-0587] assistant-llm-message-jargon: FF-UX-7 dev-jargon denylist + T-0595 admin/non-admin split + T-0587 FR-5 zone-of-visibility contract"
set +e
check_file "${TARGET}"
errors=$?
set -e
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: assistant-llm-message-jargon found ${errors} violation(s)"
  exit 1
fi
echo "PASS: assistant-llm-message-jargon — ADMIN/NON_ADMIN/NO_VISIBLE_DATA messages all clean, no dev-jargon, no dead doors, no false system-state claims"
exit 0
