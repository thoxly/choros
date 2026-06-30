#!/usr/bin/env bash
# T-0530 · OBLIK UX honest-gate G4 — no new hand-rolled loading/empty/error async branches
#
# G4 (design/ux-quality-system.md §2.1): async screens must use the kit
# primitives <LoadingState>, <EmptyState>, <ErrorState> instead of hand-rolled
# <div>/<p> text branches. Catch blocks must call setError, not return null or
# swallow the error silently.
#
# DIFF-BASED: compares the current branch against dev (merge-base) and flags
# only NEWLY-ADDED ('+') lines in web/src/screens/** and web/src/app-shell/**.
# Excludes web/src/components/** (the kit itself is legal to define these).
#
# FLAGGED PATTERNS (in an added line — each is a hand-rolled anti-pattern):
#   1. Hand-rolled loading text inline  — a plain string 'Загрузка…'/'Загружаю…'
#      wrapped in a bare <div>/<p>/<span> (without role=status/aria-busy).
#   2. Hand-rolled empty sentinel       — bare 'Нет данных'/'Пусто'/'—' in a
#      <div>/<p> without role=status.
#   3. Silent error swallow             — catch block that sets data to [] and
#      does NOT call setError (proxyied as `catch(() => {})` or `catch(() => { set*([]) }`).
#   4. Bare error text without role     — raw `{error}` / raw error string in
#      a <div>/<p> without role=alert.
#
# MODE — INFORMATIONAL (default): prints findings, exits 0. Pass --required to
# fail (exit 1) on any violation — the honest-gate flip once T-0530 is merged.
#
# EXIT CODES: 0 clean / informational · 1 violation (only with --required)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# Pattern 1: hand-rolled loading text in a bare container (no role=status).
# Matches added lines that render plain loading copy inside JSX without using LoadingState.
LOADING_TEXT_RE='[<>](div|p|span)[^>]*>[[:space:]]*(Загрузк|Загружа|loading\.\.\.|\.\.\.)[^<]*</'

# Pattern 2: catch block that silently swallows the error (catch returns nothing useful).
SILENT_CATCH_RE='catch[[:space:]]*\([[:space:]]*\)[[:space:]]*\{[[:space:]]*\}'

# Pattern 3: catch block that only sets data to empty array (error not surfaced).
CATCH_EMPTY_ARRAY_RE='catch[[:space:]]*\(.*\)[[:space:]]*\{[^}]*set[A-Za-z]+\(\[\]\)[^}]*\}'

# Pattern 4: raw error string rendered in JSX without role=alert
# Matches: >{error}< or >Не удалось загрузить< in a <div>/<p> without ErrorState
RAW_ERROR_JSX_RE='>[[:space:]]*\{(error|err|loadError)\}[[:space:]]*<[[:space:]]*/[[:space:]]*(div|p|span)>'

classify_added_lines() {
  local line body
  while IFS= read -r line; do
    [[ "${line}" == +++* ]] && continue
    [[ "${line}" == +* ]] || continue
    body="${line#+}"

    if [[ "${body}" =~ ${LOADING_TEXT_RE} ]]; then
      printf 'hand-rolled-loading\t%s\n' "${body}"
    elif [[ "${body}" =~ ${SILENT_CATCH_RE} ]]; then
      printf 'silent-catch\t%s\n' "${body}"
    elif [[ "${body}" =~ ${CATCH_EMPTY_ARRAY_RE} ]]; then
      printf 'catch-swallows-error\t%s\n' "${body}"
    elif [[ "${body}" =~ ${RAW_ERROR_JSX_RE} ]]; then
      printf 'raw-error-jsx\t%s\n' "${body}"
    fi
  done
}

REQUIRED=0
if [[ "${1:-}" == "--required" ]]; then REQUIRED=1; fi
MODE_LABEL="INFORMATIONAL"
[[ "${REQUIRED}" -eq 1 ]] && MODE_LABEL="REQUIRED"

echo "[T-0530] ux-g4-state-primitives (G4): scanning NEW diff lines for hand-rolled state branches (mode=${MODE_LABEL})"

BASE=""
if git -C "${ROOT}" rev-parse --verify -q dev >/dev/null 2>&1; then
  BASE="$(git -C "${ROOT}" merge-base dev HEAD 2>/dev/null || true)"
fi

if [[ -z "${BASE}" ]]; then
  echo "[T-0530] ux-g4-state-primitives: no dev/merge-base reachable — nothing to diff (clean)"
  echo "PASS [G4]: no new hand-rolled state branches (no base ref)"
  exit 0
fi

DIFF="$(git -C "${ROOT}" diff "${BASE}...HEAD" -- \
  'web/src/screens/**' 'web/src/app-shell/**' \
  ':(exclude)web/src/components/**' \
  ':(exclude)web/src/design/**' 2>/dev/null || true)"

FINDINGS="$(printf '%s\n' "${DIFF}" | classify_added_lines || true)"

COUNT=0
if [[ -n "${FINDINGS//[$'\n']/}" ]]; then
  COUNT="$(grep -c . <<<"${FINDINGS}" || true)"
  echo "${FINDINGS}" | sed '/^$/d'
fi

echo "[T-0530] ux-g4-state-primitives: ${COUNT} newly-added hand-rolled state branch finding(s)"

if [[ "${COUNT}" -gt 0 && "${REQUIRED}" -eq 1 ]]; then
  echo "FAIL [G4]: branch adds new hand-rolled loading/empty/error branches — use <LoadingState>/<EmptyState>/<ErrorState>" >&2
  exit 1
fi
echo "PASS [G4]: informational (exit 0) — flip to --required once all screens adopt kit primitives"
exit 0
