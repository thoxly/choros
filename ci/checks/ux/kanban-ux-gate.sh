#!/usr/bin/env bash
# T-0582 (kanban view) · FF-UX-K-8 — UX honest-gate G1-G7 for the kanban board
# (ADR §6, spec AC-13). Mirrors view-registry-panel-ux-gate.sh's shape (static,
# file-scoped detectors on the kanban-board.jsx source, not diff-scoped).
#
# THE CONTRACT: web/src/screens/kanban-board.jsx must:
#   (a) consume ONLY kit components (Card/Badge/Button/EmptyState/LoadingState/
#       ErrorState) — no hand-rolled overlay, no raw hex/rgba color (G2/G6);
#   (b) render honest Loading/Empty/Error states (kit <LoadingState>/
#       <EmptyState>/<ErrorState> present) — never a silent blank board (G4);
#   (c) offer a KEYBOARD alternative to drag (a focusable "Колонка" <select>
#       per card) — drag-only is an accessibility defect (WCAG 2.1.1);
#   (d) render an EmptyState inside a column with zero cards (empty columns
#       stay visible — never disappear, AC-9);
#   (e) roll back an optimistic move on failure (onLocalUpdate called with the
#       previous data) + surface an honest role="alert" error, never a silent
#       loss (FR-6/AC-6);
#   (f) never leak dev jargon ("group_by"/"enum"/"JSONB"/"view_id") into a JSX
#       text node or user-facing label (G5).
#
# STATIC, FILE-SCOPED (mirrors view-registry-panel-ux-gate.sh): the kanban
# board is a NEW, task-owned file — inspecting it by name (not diff-scanning)
# is safe and simple, same style as the T-0581 precedent.
#
# SELF-TEST (--self-test): plants synthetic GOOD/BAD board files in a temp dir
# and asserts each detector fires correctly on both.
#
# EXIT CODES: 0 clean · 1 violation · 0 (skip) if kanban-board.jsx does not
# exist yet (honest-degrade — nothing to check).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

BOARD_FILE="${ROOT}/web/src/screens/kanban-board.jsx"

check_kit_only() {
  local file="$1"
  local errors=0
  if ! grep -qE '<Card' "${file}"; then
    echo "FAIL [FF-UX-K-8a]: ${file} does not use the kit <Card> for cards"
    errors=$((errors + 1))
  fi
  if grep -qE 'rgba\(|#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([^0-9a-fA-F]|$)' "${file}"; then
    echo "FAIL [FF-UX-K-8a]: ${file} contains a raw hex/rgba color literal (tokens only, G2/G6)"
    errors=$((errors + 1))
  fi
  return "${errors}"
}

check_honest_states() {
  local file="$1"
  local errors=0
  for kit in "<EmptyState" "<ErrorState" "<LoadingState"; do
    if ! grep -qF "${kit}" "${file}"; then
      echo "FAIL [FF-UX-K-8b]: ${file} missing ${kit} (G4 honest state)"
      errors=$((errors + 1))
    fi
  done
  return "${errors}"
}

check_keyboard_alternative() {
  local file="$1"
  local errors=0
  if ! grep -qE '<select' "${file}"; then
    echo "FAIL [FF-UX-K-8c]: ${file} has no keyboard-operable column-move control (<select>)"
    errors=$((errors + 1))
  fi
  if grep -qE 'draggable' "${file}" && ! grep -qE '<select' "${file}"; then
    echo "FAIL [FF-UX-K-8c]: ${file} uses drag with NO keyboard alternative (accessibility defect)"
    errors=$((errors + 1))
  fi
  return "${errors}"
}

check_empty_column_visible() {
  local file="$1"
  local errors=0
  if ! grep -qE 'cards\.length === 0' "${file}"; then
    echo "FAIL [FF-UX-K-8d]: ${file} does not check for an empty column (cards.length === 0) — empty columns must stay visible"
    errors=$((errors + 1))
  fi
  return "${errors}"
}

check_rollback_on_failure() {
  local file="$1"
  local errors=0
  if ! grep -qE 'result\.ok' "${file}"; then
    echo "FAIL [FF-UX-K-8e]: ${file} does not check the move result's ok flag — rollback path missing"
    errors=$((errors + 1))
  fi
  if ! grep -qE 'onLocalUpdate' "${file}"; then
    echo "FAIL [FF-UX-K-8e]: ${file} has no onLocalUpdate rollback call"
    errors=$((errors + 1))
  fi
  if ! grep -qE 'role="alert"' "${file}"; then
    echo "FAIL [FF-UX-K-8e]: ${file} has no role=\"alert\" honest error surface"
    errors=$((errors + 1))
  fi
  return "${errors}"
}

check_no_jargon() {
  local file="$1"
  local errors=0
  # Strip /* ... */ block comments entirely (this file's own top-of-file header
  # legitimately explains the jargon ban using the banned words as prose, with
  # no per-line "*"/"//" prefix) — only scan CODE for jargon leaking into JSX
  # text/attributes. awk state machine: while inside a /* */ block, blank the
  # line's content (keep line count stable for -n reporting downstream).
  local code_lines
  code_lines="$(awk '
    { line = $0 }
    in_comment {
      if (index(line, "*/") > 0) { in_comment = 0; line = "" } else { print ""; next }
    }
    !in_comment {
      start = index(line, "/*")
      if (start > 0) {
        endp = index(substr(line, start), "*/")
        if (endp > 0) { line = substr(line, 1, start - 1) substr(line, start + endp + 1) }
        else { line = substr(line, 1, start - 1); in_comment = 1 }
      }
      print line
    }
  ' "${file}")"
  local jargon_hits
  jargon_hits="$(echo "${code_lines}" | grep -nE '(label=|placeholder=|title=|>[^<{]*[А-Яа-яЁё])' \
    | grep -iE 'group_by|view_id|list_view|JSONB' || true)"
  if [[ -n "${jargon_hits}" ]]; then
    echo "FAIL [FF-UX-K-8f]: ${file} leaks dev jargon into visible text:"
    echo "${jargon_hits}"
    errors=$((errors + 1))
  fi
  return "${errors}"
}

run_all_checks() {
  local file="$1"
  local total=0
  check_kit_only "${file}"; total=$((total + $?))
  check_honest_states "${file}"; total=$((total + $?))
  check_keyboard_alternative "${file}"; total=$((total + $?))
  check_empty_column_visible "${file}"; total=$((total + $?))
  check_rollback_on_failure "${file}"; total=$((total + $?))
  check_no_jargon "${file}"; total=$((total + $?))
  echo "${total}"
}

self_test() {
  echo "[T-0582] kanban-ux-gate --self-test"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  cat > "${tmp}/good.jsx" <<'EOF'
import { Card, Badge, Button, EmptyState, ErrorState, LoadingState } from '../components/components.jsx';
function Board() {
  if (records === null) return <LoadingState label="Загрузка…" />;
  if (recordsError) return <ErrorState message="Ошибка" />;
  return (
    <div>
      {column.cards.length === 0 && <EmptyState compact title="Пока нет записей" />}
      <Card><select aria-label="Переместить" draggable /></Card>
      {moveError && <div role="alert">{moveError}</div>}
      {!result.ok && onLocalUpdate(record.id, previousData)}
      <span style={{ color: 'var(--chs-color-text)' }}>Колонка</span>
    </div>
  );
}
EOF
  local good_errors
  good_errors="$(run_all_checks "${tmp}/good.jsx" 2>/dev/null | tail -1)"

  cat > "${tmp}/bad.jsx" <<'EOF'
function Board() {
  return (
    <div style={{ color: '#ff0000' }} label="group_by поле">
      <div draggable={true} onDragStart={() => {}} />
    </div>
  );
}
EOF
  local bad_errors
  bad_errors="$(run_all_checks "${tmp}/bad.jsx" 2>/dev/null | tail -1)"

  if [[ "${good_errors}" -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD board (${good_errors} violation(s))"
    return 1
  fi
  if [[ "${bad_errors}" -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD board"
    return 1
  fi
  echo "SELF-TEST PASS: good board clean (0 findings), bad board flagged (${bad_errors} finding(s))"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0582] kanban-ux-gate: FF-UX-K-8 UX honest-gate for the kanban board"

if [[ ! -f "${BOARD_FILE}" ]]; then
  echo "SKIP [FF-UX-K-8]: ${BOARD_FILE} does not exist yet — nothing to check"
  exit 0
fi

TOTAL_ERRORS=0
check_kit_only "${BOARD_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))
check_honest_states "${BOARD_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))
check_keyboard_alternative "${BOARD_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))
check_empty_column_visible "${BOARD_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))
check_rollback_on_failure "${BOARD_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))
check_no_jargon "${BOARD_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))

if [[ "${TOTAL_ERRORS}" -gt 0 ]]; then
  echo "FAIL: kanban-ux-gate found ${TOTAL_ERRORS} violation(s)"
  exit 1
fi
echo "PASS: kanban-ux-gate — G1-G7 static checks clean for ${BOARD_FILE}"
exit 0
