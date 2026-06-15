#!/usr/bin/env bash
# T-0146 · FF-FCI1..FF-FCI12 — frozen-checks-immutable meta-gate
#
# Meta-gate: on a task branch, forbids modification or deletion of any
# ci/checks/*.sh file that does not belong to the current task.
# Ownership is declared via the second line of each *.sh file:
#   # T-XXXX · <description>
# If the T-ID in that header matches the TASK_ID of the current branch, the
# file is considered "own" and changes are permitted. Otherwise — FAIL.
#
# OWNERSHIP ANCHOR (R-1 fix, review 2026-06-11):
#   For ALL existing files (diff-filter C/M/R/T), the owner T-ID is read from
#   the BASE_REF (git show BASE_REF:path | sed -n '2p'), NOT from the on-disk
#   working copy.  This makes ownership tamper-proof: rewriting line 2 of a
#   foreign check to your own T-ID is still detected because the BASE_REF
#   version of that line is read.  DELETE is likewise already BASE_REF-anchored.
#
# RESIDUAL RISK — branch-name spoof (R-2, documented per ADR §10 amendment):
#   TASK_ID derives from the branch name, which is chosen by the agent itself.
#   A branch named task/T-0044-anything obtains TASK_ID=T-0044 and can amend
#   ci/checks/dual-control-isolation.sh if that file's BASE_REF header already
#   reads "# T-0044 ·".  There is no local anchor independent of the branch name
#   to close this path completely (that would require a control-plane claim check
#   which is out of scope here).  Mitigation: the reviewer sees the full header
#   diff and the PR branch name together; forging TASK_ID via branch name does
#   not change the file header, so it is visible in review.  Accepted by design.
#
#  FF-FCI1  — На task-ветке с TASK_ID ≠ владелец-чека (BASE_REF header):
#             правка/удаление ci/checks/*.sh → FAIL + exit 1.
#  FF-FCI2  — На task/T-0146-*: правка frozen-checks-immutable.sh → exit 0.
#  FF-FCI3  — На dev/main/non-task ветке или нет merge-base → exit 0.
#  FF-FCI4  — Новые файлы (diff-filter=A) не являются нарушением.
#  FF-FCI5  — Удаление чужого ci/checks/*.sh → FAIL; заголовок читается
#             из BASE_REF через git show.
#  FF-FCI6  — Поддиректории ci/checks/db/, kc/, flowable/ не захватываются
#             glob ci/checks/[^/]+\.sh.
#  FF-FCI7  — Вторая строка этого файла = ^# T-0146[[:space:]]·.
#  FF-FCI8  — Зарегистрирован в npm run fitness (package.json).
#  FF-FCI9  — Hostile-probe красный при exclusion-правке чужого чека.
#  FF-FCI10 — Hostile-probe зелёный для правки собственного чека.
#  FF-FCI11 — Чек без T-ID заголовка (legacy) считается чужим → FAIL.
#  FF-FCI12 — Канал founder-санкций (design T-0199): пара {task,file} в data-файле
#             ci/checks/data/frozen-sanctions.jsonl (append-only; НЕ ci/checks/*.sh
#             → не захватывается glob'ом, не самоохраняется) разрешает TASK_ID
#             править/удалять ЧУЖОЙ чек. Каждый bypass печатает SANCTION+AUDIT
#             строки (никогда не молча). Авторизация записи = founder_decide
#             (control-plane); злоупотребление видно в pre-merge diff — тот же
#             класс остаточного риска, что принятый R-2 (branch-name spoof).
#  FF-FCI13 — Канал auto-additive-санкций (design T-0232): второй класс строки
#             в frozen-sanctions.jsonl (sanctioned_by:"auto_additive") разрешает
#             TASK_ID внести АДДИТИВНЫЙ thaw чужого чека БЕЗ founder_decide —
#             ТОЛЬКО если делегат ci/checks/auto-sanction-additive.sh независимо
#             верифицирует A-1..A-4 аддитивности над BASE_REF + валидную
#             Враг-аттестацию. Founder-путь (FF-FCI12) поведенчески неизменён.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Allow PROJECT_ROOT override (used by hostile-probe tests to run against an
# isolated git repo without symlinking or copying the script).
PROJECT_ROOT="${PROJECT_ROOT:-"$(cd "${SCRIPT_DIR}/../.." && pwd)"}"

# ---- Founder-sanction channel (FF-FCI12, design T-0199) ----------------------
# Append-only allowlist of {task,file} pairs the FOUNDER has sanctioned to let a
# task modify a FOREIGN frozen check.  Path is PROJECT_ROOT-relative (NOT
# SCRIPT_DIR) so the hostile-probe harness can supply an isolated allowlist via
# PROJECT_ROOT.  Entries are compact JSON, one per line, e.g.:
#   {"task":"T-0085","file":"ci/checks/role-criticality-isolation.sh",...}
# Comment lines (^#) and blanks are ignored by the grep-based matcher.
#
# FF-FCI13 (T-0232) — auto_additive class: a second sanctioned_by value
# "auto_additive" lets a task bypass the frozen-check gate for provably ADDITIVE
# thaws (A-1..A-4 verified independently by auto-sanction-additive.sh) that
# carry a valid Враг-attestation. The founder path (FF-FCI12) is byte-equivalent.
# Bootstrap: this very edit to frozen-checks-immutable.sh requires a one-time
# founder-class sanction (see blocked_reason in T-0232.pr-handoff.json).
SANCTIONS_FILE="${PROJECT_ROOT}/ci/checks/data/frozen-sanctions.jsonl"

# is_sanctioned <file> — true iff a single JSONL record carries BOTH the current
# TASK_ID and this file path (compact "key":"value" tokens, no interior spaces).
# Both tokens must be on the SAME line (piped grep), so a sanction for file A
# cannot leak to file B, nor a sanction for task X to task Y.
is_sanctioned() {
  local f="$1"
  [[ -f "${SANCTIONS_FILE}" ]] || return 1
  grep -F "\"task\":\"${TASK_ID}\"" "${SANCTIONS_FILE}" 2>/dev/null \
    | grep -qF "\"file\":\"${f}\""
}

# sanction_class <file> — return "auto_additive" or "founder" for the sanction line.
# Reads the sanctioned_by field from the matching line. Defaults to "founder" if
# field absent (backward-compatible with pre-T-0232 lines).
sanction_class() {
  local f="$1"
  local matching_line
  matching_line="$(grep -F "\"task\":\"${TASK_ID}\"" "${SANCTIONS_FILE}" 2>/dev/null \
    | grep -F "\"file\":\"${f}\"" | head -1 || true)"
  if echo "${matching_line}" | grep -qF '"sanctioned_by":"auto_additive"'; then
    echo "auto_additive"
  else
    echo "founder"
  fi
}

# sanction_line <file> — return the full matching sanction JSON line (for passing
# to the auto_additive delegate verifier).
sanction_line() {
  local f="$1"
  grep -F "\"task\":\"${TASK_ID}\"" "${SANCTIONS_FILE}" 2>/dev/null \
    | grep -F "\"file\":\"${f}\"" | head -1 || true
}

# ---- Step 1: Extract TASK_ID from branch name --------------------------------
BRANCH="$(git -C "${PROJECT_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
TASK_ID="$(echo "${BRANCH}" | grep -oE '^task/(T-[0-9]+)' | sed 's|^task/||' || true)"

if [[ -z "${TASK_ID}" ]]; then
  echo "INFO [FF-FCI3]: not a task branch (branch='${BRANCH}'), skipping frozen-checks-immutable"
  exit 0
fi

echo "[T-0146] frozen-checks-immutable: checking ci/checks/*.sh on branch '${BRANCH}' (TASK_ID=${TASK_ID})"

# ---- Step 2: Resolve BASE_REF (merge-base with dev/origin/dev) ---------------
BASE_REF=""
for cand in "dev" "origin/dev"; do
  if git -C "${PROJECT_ROOT}" rev-parse --verify --quiet "${cand}^{commit}" >/dev/null 2>&1; then
    mb="$(git -C "${PROJECT_ROOT}" merge-base "${cand}" HEAD 2>/dev/null || true)"
    if [[ -n "${mb}" ]]; then BASE_REF="${mb}"; break; fi
  fi
done

if [[ -z "${BASE_REF}" ]]; then
  echo "WARN [FF-FCI3]: frozen-checks-immutable: no dev/origin/dev reachable, skipping (fail-open)"
  exit 0
fi

# ---- Step 3: Collect changed/deleted ci/checks/*.sh (excluding pure-ADD) ----
# diff-filter=CDMRT: Copy, Delete, Modify, Rename-source, Type-change.
# Excludes A (Add-only) — new files are permitted (FR-6.1 / FF-FCI4).
changed_sh() {
  {
    git -C "${PROJECT_ROOT}" diff --name-only --diff-filter=CDMRT "${BASE_REF}" HEAD 2>/dev/null || true
    git -C "${PROJECT_ROOT}" diff --name-only --diff-filter=CDMRT HEAD        2>/dev/null || true
    git -C "${PROJECT_ROOT}" diff --name-only --diff-filter=CDMRT --cached    2>/dev/null || true
  } | sort -u | grep -E '^ci/checks/[^/]+\.sh$' || true
}

# ---- Step 4: Classify each changed *.sh file --------------------------------
# R-1 fix: ownership anchor is the BASE_REF version of the file, NOT the
# on-disk working copy.  This prevents an attacker from rewriting line 2 of a
# foreign check to their own T-ID and having the gate accept it as "own".
#
# Anchor resolution order (first that returns a non-empty header wins):
#   1. git show BASE_REF:path  — pre-branch, cannot be forged by current branch
#   2. git show HEAD:path      — first committed version on this branch (fallback
#      for files that were ADDED by this branch and then modified in the working
#      tree; HEAD:path still exists, BASE_REF:path does not)
#
# If both BASE_REF and HEAD lack the file (pathological, should not occur for
# CDMRT filter) header_tid will be empty → treated as foreign → FAIL (safe).
ERRORS=0
while IFS= read -r f; do
  [[ -z "${f}" ]] && continue

  # Try BASE_REF first (the immutable pre-branch anchor).
  header_line="$(git -C "${PROJECT_ROOT}" show "${BASE_REF}:${f}" 2>/dev/null \
    | sed -n '2p' || true)"

  # Fallback: if file was added by THIS branch (not in BASE_REF) and then
  # modified in working tree, read from HEAD (the committed branch version).
  if [[ -z "${header_line}" ]]; then
    header_line="$(git -C "${PROJECT_ROOT}" show "HEAD:${f}" 2>/dev/null \
      | sed -n '2p' || true)"
  fi

  # Extract T-ID from pattern: # T-XXXX[space]...
  header_tid="$(echo "${header_line}" \
    | grep -oE '^# T-[0-9]+[[:space:]]' \
    | grep -oE 'T-[0-9]+' || true)"

  if [[ "${header_tid}" == "${TASK_ID}" ]]; then
    echo "PASS [FF-FCI1]: ${f} is own check for ${TASK_ID} (BASE_REF/HEAD header), modification allowed"
  elif is_sanctioned "${f}"; then
    klass="$(sanction_class "${f}")"
    if [[ "${klass}" == "auto_additive" ]]; then
      # FF-FCI13 (T-0232): auto_additive class — delegate to auto-sanction-additive.sh
      # which INDEPENDENTLY verifies A-1..A-4 aditivity over BASE_REF + Враг-attestation.
      # The gate does NOT trust the sanctioned_by marker alone (D-007: no self-assessment).
      san_json="$(sanction_line "${f}")"
      if "${SCRIPT_DIR}/auto-sanction-additive.sh" --verify "${TASK_ID}" "${f}" "${BASE_REF}" "${san_json}"; then
        echo "SANCTION [FF-FCI13]: ${f} — ${TASK_ID} carries an AUTO-ADDITIVE frozen-sanction (A-1..A-4 PASS + Враг-аттестация) — modification ALLOWED"
        echo "AUDIT [FF-FCI13]: auto-additive frozen-sanction GRANTED — task=${TASK_ID} file=${f} owner=${header_tid:-<no-T-ID>} class=auto_additive branch=${BRANCH}"
      else
        echo "FAIL [FF-FCI13]: ${f} — auto_additive sanction REJECTED (not additive OR Враг-attestation invalid); founder-class sanction required (D-060 boundary)"
        ERRORS=$((ERRORS + 1))
      fi
    else
      # FF-FCI12: founder class — existing behaviour, byte-equivalent (FR-6)
      echo "SANCTION [FF-FCI12]: ${f} belongs to '${header_tid:-<no-T-ID>}' but ${TASK_ID} carries a FOUNDER frozen-sanction (ci/checks/data/frozen-sanctions.jsonl) — modification ALLOWED"
      echo "AUDIT [FF-FCI12]: frozen-sanction GRANTED — task=${TASK_ID} file=${f} owner=${header_tid:-<no-T-ID>} class=founder branch=${BRANCH}"
    fi
  else
    echo "FAIL [FF-FCI1]: ${f} belongs to task '${header_tid:-<no-T-ID>}' (BASE_REF/HEAD header), not ${TASK_ID}; modification/deletion forbidden on this branch"
    ERRORS=$((ERRORS + 1))
  fi
done < <(changed_sh)

# ---- Result ------------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: frozen-checks-immutable found ${ERRORS} violation(s) on branch '${BRANCH}'"
  exit 1
fi
echo "PASS: frozen-checks-immutable — all ci/checks/*.sh changes are owned by ${TASK_ID}"
exit 0
