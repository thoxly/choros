#!/usr/bin/env bash
# T-0146 · FF-FCI1..FF-FCI11 — frozen-checks-immutable meta-gate
#
# Meta-gate: on a task branch, forbids modification or deletion of any
# ci/checks/*.sh file that does not belong to the current task.
# Ownership is declared via the second line of each *.sh file:
#   # T-XXXX · <description>
# If the T-ID in that header matches the TASK_ID of the current branch, the
# file is considered "own" and changes are permitted. Otherwise — FAIL.
#
#  FF-FCI1  — На task-ветке с TASK_ID ≠ владелец-чека: правка/удаление
#             ci/checks/*.sh → FAIL + exit 1.
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
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Allow PROJECT_ROOT override (used by hostile-probe tests to run against an
# isolated git repo without symlinking or copying the script).
PROJECT_ROOT="${PROJECT_ROOT:-"$(cd "${SCRIPT_DIR}/../.." && pwd)"}"

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
ERRORS=0
while IFS= read -r f; do
  [[ -z "${f}" ]] && continue

  full_path="${PROJECT_ROOT}/${f}"

  # Read second line from disk (file exists) or from BASE_REF (file deleted)
  if [[ -f "${full_path}" ]]; then
    header_line="$(sed -n '2p' "${full_path}" 2>/dev/null || true)"
  else
    # File deleted — read its header from the BASE_REF version in git
    header_line="$(git -C "${PROJECT_ROOT}" show "${BASE_REF}:${f}" 2>/dev/null \
      | sed -n '2p' || true)"
  fi

  # Extract T-ID from pattern: # T-XXXX[space]...
  header_tid="$(echo "${header_line}" \
    | grep -oE '^# T-[0-9]+[[:space:]]' \
    | grep -oE 'T-[0-9]+' || true)"

  if [[ "${header_tid}" == "${TASK_ID}" ]]; then
    echo "PASS [FF-FCI1]: ${f} is own check for ${TASK_ID}, modification allowed"
  else
    echo "FAIL [FF-FCI1]: ${f} belongs to task '${header_tid:-<no-T-ID>}', not ${TASK_ID}; modification/deletion forbidden on this branch"
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
