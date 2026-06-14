#!/usr/bin/env bash
# T-0154 · FF-CORPUS1..FF-CORPUS4 — Enemy regression corpus append-only gate.
#
# Эпик E-VRG / T-0151 «Враг». spec: playbooks/enemy-redteam-backlog.md §6/§7
# (репо Demiurge): «Корпус-антитела — каждая подтверждённая атака навсегда в
# регрессии» + «каталог + корпус под append-only, изменения только founder-gated».
#
# The deterministic Enemy records every CONFIRMED attack as a permanent line in
# src/__tests__/enemy/corpus/corpus.jsonl. A confirmed attack must NEVER be
# deleted, reordered out of existence, or weakened — otherwise Demiurge (which
# writes both Choros AND the Enemy in the same loop) could silently file down its
# own regression net. This static gate enforces the append-only law against the
# merge base (BASE_REF), mirroring frozen-checks-immutable.sh (T-0146):
#
#   FF-CORPUS1 — Every NON-COMMENT corpus line present in the BASE_REF version of
#                corpus.jsonl MUST still be present, BYTE-IDENTICAL, in the HEAD
#                version. A removed or mutated existing line ⇒ FAIL.
#   FF-CORPUS2 — New lines may ONLY be appended (the preserved BASE_REF lines keep
#                their relative order as a prefix subsequence of HEAD's lines).
#   FF-CORPUS3 — On dev/main/non-task branches or when no merge-base is reachable,
#                the gate is a fail-open no-op (matches frozen-checks-immutable).
#   FF-CORPUS4 — `--self-test` proves the gate BITES: a synthetic deletion and a
#                synthetic mutation of an existing line are both rejected.
#
# Comment (`#`-prefixed) and blank lines are NOT corpus entries; they may be
# edited freely (the header prose is not a regression case).
#
# Exit 0 on clean / skip, non-zero on an append-only violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-"$(cd "${SCRIPT_DIR}/../../.." && pwd)"}"
CORPUS_REL="src/__tests__/enemy/corpus/corpus.jsonl"

# strip_comments <stream> — keep only real corpus entries (drop `#`/blank lines).
strip_entries() {
  grep -vE '^[[:space:]]*(#|$)' || true
}

# ----------------------------------------------------------------------------
# Core check: every BASE_REF entry survives byte-identically AND in order at HEAD.
# Args: $1 = base entries file, $2 = head entries file. Returns 0 clean, 1 viol.
# ----------------------------------------------------------------------------
verify_append_only() {
  local base_entries="$1" head_entries="$2" errs=0

  # FF-CORPUS1: each base entry must appear (exact match) somewhere in head.
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    if ! grep -qxF -- "${line}" "${head_entries}"; then
      echo "FAIL [FF-CORPUS1]: a recorded corpus attack was DELETED or MUTATED (not append-only):"
      echo "  missing@HEAD: ${line}"
      errs=$((errs + 1))
    fi
  done < "${base_entries}"

  # FF-CORPUS2: base entries must be a PREFIX SUBSEQUENCE of head entries — i.e.
  # the first N' head entries that match base entries do so IN ORDER, and nothing
  # was inserted before/between that reorders the recorded history. We verify the
  # base list equals the head list truncated to base length AFTER confirming all
  # present — the simplest sound rule for "append-only": head must start with the
  # exact base block.
  if [[ ${errs} -eq 0 ]]; then
    local base_n
    base_n="$(wc -l < "${base_entries}" | tr -d ' ')"
    if [[ "${base_n}" -gt 0 ]]; then
      if ! diff <(cat "${base_entries}") <(head -n "${base_n}" "${head_entries}") >/dev/null; then
        echo "FAIL [FF-CORPUS2]: recorded corpus entries were REORDERED — append-only requires"
        echo "       the existing block to remain a verbatim prefix; new cases append at the END."
        errs=$((errs + 1))
      fi
    fi
  fi

  return $(( errs > 0 ? 1 : 0 ))
}

# ----------------------------------------------------------------------------
# --self-test (FF-CORPUS4): prove the gate catches a deletion and a mutation.
# ----------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0154] corpus-append-only --self-test: proving the gate bites"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT
  cat > "${tmp}/base" <<'EOF'
{"id":"A","family":"PDP-DENY"}
{"id":"B","family":"TENANT-ISO"}
{"id":"C","family":"GRANT-ESCALATION"}
EOF

  # Case 1: clean append — must PASS.
  cat > "${tmp}/head_ok" <<'EOF'
{"id":"A","family":"PDP-DENY"}
{"id":"B","family":"TENANT-ISO"}
{"id":"C","family":"GRANT-ESCALATION"}
{"id":"D","family":"DEV-AUTH-PROD"}
EOF
  if verify_append_only "${tmp}/base" "${tmp}/head_ok" >/dev/null 2>&1; then
    echo "PASS: clean append accepted"
  else
    echo "SELF-TEST FAIL: a legitimate append was rejected"; exit 1
  fi

  # Case 2: deletion — must FAIL.
  cat > "${tmp}/head_del" <<'EOF'
{"id":"A","family":"PDP-DENY"}
{"id":"C","family":"GRANT-ESCALATION"}
EOF
  if verify_append_only "${tmp}/base" "${tmp}/head_del" >/dev/null 2>&1; then
    echo "SELF-TEST FAIL: a DELETED corpus line was NOT caught"; exit 1
  else
    echo "PASS: deletion of a recorded attack is rejected"
  fi

  # Case 3: mutation (weakening) — must FAIL.
  cat > "${tmp}/head_mut" <<'EOF'
{"id":"A","family":"PDP-DENY"}
{"id":"B","family":"TENANT-ISO","WEAKENED":true}
{"id":"C","family":"GRANT-ESCALATION"}
EOF
  if verify_append_only "${tmp}/base" "${tmp}/head_mut" >/dev/null 2>&1; then
    echo "SELF-TEST FAIL: a MUTATED corpus line was NOT caught"; exit 1
  else
    echo "PASS: mutation/weakening of a recorded attack is rejected"
  fi

  # Case 4: reorder — must FAIL (existing block must stay a verbatim prefix).
  cat > "${tmp}/head_reorder" <<'EOF'
{"id":"B","family":"TENANT-ISO"}
{"id":"A","family":"PDP-DENY"}
{"id":"C","family":"GRANT-ESCALATION"}
EOF
  if verify_append_only "${tmp}/base" "${tmp}/head_reorder" >/dev/null 2>&1; then
    echo "SELF-TEST FAIL: a REORDER of recorded attacks was NOT caught"; exit 1
  else
    echo "PASS: reordering recorded attacks is rejected"
  fi

  echo "PASS: corpus-append-only --self-test green (gate bites on delete/mutate/reorder)"
  exit 0
fi

# ----------------------------------------------------------------------------
# Live mode: compare BASE_REF:corpus vs HEAD/working-tree corpus.
# ----------------------------------------------------------------------------
BRANCH="$(git -C "${PROJECT_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
TASK_ID="$(echo "${BRANCH}" | grep -oE '^task/(T-[0-9]+)' | sed 's|^task/||' || true)"
if [[ -z "${TASK_ID}" ]]; then
  echo "INFO [FF-CORPUS3]: not a task branch (branch='${BRANCH}'), skipping corpus-append-only"
  exit 0
fi

BASE_REF=""
for cand in "dev" "origin/dev"; do
  if git -C "${PROJECT_ROOT}" rev-parse --verify --quiet "${cand}^{commit}" >/dev/null 2>&1; then
    mb="$(git -C "${PROJECT_ROOT}" merge-base "${cand}" HEAD 2>/dev/null || true)"
    if [[ -n "${mb}" ]]; then BASE_REF="${mb}"; break; fi
  fi
done
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN [FF-CORPUS3]: no dev/origin/dev reachable, skipping corpus-append-only (fail-open)"
  exit 0
fi

# If the corpus did not exist at BASE_REF (this task INTRODUCES it), every line
# is a pure-add — nothing to protect yet. Clean by construction.
if ! git -C "${PROJECT_ROOT}" cat-file -e "${BASE_REF}:${CORPUS_REL}" 2>/dev/null; then
  echo "INFO [FF-CORPUS]: corpus.jsonl absent at BASE_REF (introduced by ${TASK_ID}) — append-only trivially holds"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
git -C "${PROJECT_ROOT}" show "${BASE_REF}:${CORPUS_REL}" | strip_entries > "${tmp}/base"
# Working-tree corpus (what would be committed), not just HEAD, so an uncommitted
# deletion is caught before the commit even lands.
strip_entries < "${PROJECT_ROOT}/${CORPUS_REL}" > "${tmp}/head"

echo "[T-0154] corpus-append-only: $(wc -l < "${tmp}/base" | tr -d ' ') recorded attack(s) at BASE_REF must survive at HEAD"
if verify_append_only "${tmp}/base" "${tmp}/head"; then
  echo "PASS: corpus-append-only — every recorded attack preserved (append-only holds)"
  exit 0
fi
echo "FAIL: corpus-append-only — the regression corpus was weakened (see above)"
exit 1
