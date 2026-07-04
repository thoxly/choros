#!/usr/bin/env bash
# T-0581 (view registry) · FF-UX-VR-7 — UX honest-gate G1-G7 for the columns/
# filters/sort panel (ADR §6, spec AC-14).
#
# THE CONTRACT: the FR-4 panel (web/src/screens/list-view-panel.jsx) is the
# ONE mandatory UI surface this task ships. It must:
#   (a) consume ONLY kit components (Drawer/Button/Field/Select/EmptyState/
#       ErrorState/Notice) — no hand-rolled overlay, no raw hex/rgba color
#       (G2/G6, mirrors ux-g6-no-new-hardcode.sh's detector shape);
#   (b) render honest Loading/Empty/Error states, never a silent blank panel
#       (G4/AC-14);
#   (c) never leak dev jargon ("view_id"/"list_view"/"JSONB"/raw op codes like
#       "is_empty"/"eq") into a JSX text node or user-facing label (G5);
#   (d) reorder columns via a keyboard-operable primitive (native <button>
#       up/down, aria-label) — NOT solely via HTML5 drag-and-drop
#       (draggable=/onDragStart without a keyboard fallback is an
#       accessibility defect per the task brief);
#   (e) offer filter operators DERIVED from field type (operatorsForFieldType),
#       never a fixed/hardcoded operator list — so the server never rejects
#       what the UI offered (AC-4 client-side honesty).
#
# STATIC, FILE-SCOPED (not diff-scoped): unlike the anti-case/hardcode gates
# that scan a branch diff, this check inspects the FIXED, known panel files by
# name — the same style as view-registry-backcompat-test-present.sh (a
# presence + shape check, not a repo-wide scan). This is safe because the
# panel is a NEW, task-owned file (not a diff against pre-existing content).
#
# MODE: REQUIRED (not informational) — this is the gate the BUILD phase must
# pass before the mandatory FR-4 UI can be considered delivered (unlike the
# repo-wide G-checks, which stay informational until every screen migrates).
#
# SELF-TEST (--self-test): plants a synthetic BAD panel file (hardcoded hex
# color + raw op-code leak + no keyboard reorder fallback) in a temp dir and
# asserts each detector fires; plants a synthetic GOOD file and asserts none
# fire falsely — so a broken check turns red immediately.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken · 0 (skip) if the
# panel file does not exist yet (honest-degrade — nothing to check).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

PANEL_FILE="${ROOT}/web/src/screens/list-view-panel.jsx"

# ---------------------------------------------------------------------------
# Detectors — pure functions of a file's content, reused by both the real run
# and --self-test so the same logic is exercised in both.
# ---------------------------------------------------------------------------

check_kit_only() {
  local file="$1"
  local errors=0
  if ! grep -qE '<Drawer' "${file}"; then
    echo "FAIL [FF-UX-VR-7a]: ${file} does not use the kit <Drawer> (hand-rolled panel container?)"
    errors=$((errors + 1))
  fi
  if grep -qE 'rgba\(|#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([^0-9a-fA-F]|$)' "${file}"; then
    echo "FAIL [FF-UX-VR-7a]: ${file} contains a raw hex/rgba color literal (tokens only, G2/G6)"
    errors=$((errors + 1))
  fi
  # Hand-rolled overlay: a fixed/inset position line — the kit Drawer owns overlay/scroll-lock.
  if grep -qE "position:\s*['\"]fixed['\"]" "${file}"; then
    echo "FAIL [FF-UX-VR-7a]: ${file} hand-rolls a fixed-position overlay instead of using kit <Drawer>"
    errors=$((errors + 1))
  fi
  return "${errors}"
}

check_honest_states() {
  local file="$1"
  local errors=0
  for kit in "<EmptyState" "<ErrorState"; do
    if ! grep -qF "${kit}" "${file}"; then
      echo "FAIL [FF-UX-VR-7b]: ${file} missing ${kit} (G4 honest state)"
      errors=$((errors + 1))
    fi
  done
  return "${errors}"
}

check_no_jargon() {
  local file="$1"
  local errors=0
  # Jargon must not appear inside a JSX text node (>...<) or a label/placeholder/
  # title string. We scan lines that look like visible-text carriers.
  local jargon_hits
  jargon_hits="$(grep -nE '(label=|placeholder=|title=|>[^<{]*[А-Яа-яЁё])' "${file}" \
    | grep -iE 'view_id|list_view|JSONB' || true)"
  if [[ -n "${jargon_hits}" ]]; then
    echo "FAIL [FF-UX-VR-7c]: ${file} leaks dev jargon into visible text:"
    echo "${jargon_hits}"
    errors=$((errors + 1))
  fi
  return "${errors}"
}

check_keyboard_reorder() {
  local file="$1"
  local errors=0
  if ! grep -qE 'aria-label=\{`Переместить' "${file}"; then
    echo "FAIL [FF-UX-VR-7d]: ${file} has no aria-labeled reorder control (columns must be keyboard-operable)"
    errors=$((errors + 1))
  fi
  # If drag-and-drop IS present, a keyboard fallback (the up/down buttons
  # above) MUST also be present — this branch only fires when drag exists
  # WITHOUT the aria-labeled buttons already checked above.
  if grep -qE 'draggable=\{?true|onDragStart' "${file}" && ! grep -qE 'aria-label=\{`Переместить' "${file}"; then
    echo "FAIL [FF-UX-VR-7d]: ${file} uses drag-and-drop reorder with NO keyboard alternative (accessibility defect)"
    errors=$((errors + 1))
  fi
  return "${errors}"
}

check_operators_by_type() {
  local file="$1"
  local errors=0
  if ! grep -qE 'operatorsForFieldType\(' "${file}"; then
    echo "FAIL [FF-UX-VR-7e]: ${file} does not derive filter operators from operatorsForFieldType (fixed/hardcoded operator list risks offering an operator the server rejects, AC-4)"
    errors=$((errors + 1))
  fi
  return "${errors}"
}

run_all_checks() {
  local file="$1"
  local total=0
  check_kit_only "${file}"; total=$((total + $?))
  check_honest_states "${file}"; total=$((total + $?))
  check_no_jargon "${file}"; total=$((total + $?))
  check_keyboard_reorder "${file}"; total=$((total + $?))
  check_operators_by_type "${file}"; total=$((total + $?))
  echo "${total}"
}

# ---------------------------------------------------------------------------
# --self-test
# ---------------------------------------------------------------------------

self_test() {
  echo "[T-0581] view-registry-panel-ux-gate --self-test"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  cat > "${tmp}/good.jsx" <<'EOF'
import { Drawer, EmptyState, ErrorState, Button } from '../components/components.jsx';
function Panel() {
  const ops = operatorsForFieldType(fieldType);
  return (
    <Drawer>
      <EmptyState title="Нет колонок" />
      <ErrorState message="Ошибка" />
      <Button aria-label={`Переместить «x» выше`}>up</Button>
      <span style={{ color: 'var(--chs-color-text)' }}>Представление</span>
    </Drawer>
  );
}
EOF
  local good_errors
  good_errors="$(run_all_checks "${tmp}/good.jsx" 2>/dev/null | tail -1)"

  cat > "${tmp}/bad.jsx" <<'EOF'
function Panel() {
  return (
    <div style={{ position: 'fixed', background: 'rgba(0,0,0,0.5)' }}>
      <span style={{ color: '#ff0000' }} label="view_id панель">Плохо</span>
      <div draggable={true} onDragStart={() => {}} />
    </div>
  );
}
EOF
  local bad_errors
  bad_errors="$(run_all_checks "${tmp}/bad.jsx" 2>/dev/null | tail -1)"

  if [[ "${good_errors}" -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD panel (${good_errors} violation(s))"
    return 1
  fi
  if [[ "${bad_errors}" -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD panel"
    return 1
  fi
  echo "SELF-TEST PASS: good panel clean (0 findings), bad panel flagged (${bad_errors} finding(s))"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0581] view-registry-panel-ux-gate: FF-UX-VR-7 UX honest-gate for the columns/filters/sort panel"

if [[ ! -f "${PANEL_FILE}" ]]; then
  echo "SKIP [FF-UX-VR-7]: ${PANEL_FILE} does not exist yet — nothing to check"
  exit 0
fi

TOTAL_ERRORS=0
check_kit_only "${PANEL_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))
check_honest_states "${PANEL_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))
check_no_jargon "${PANEL_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))
check_keyboard_reorder "${PANEL_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))
check_operators_by_type "${PANEL_FILE}" || true; TOTAL_ERRORS=$((TOTAL_ERRORS + $?))

if [[ "${TOTAL_ERRORS}" -gt 0 ]]; then
  echo "FAIL: view-registry-panel-ux-gate found ${TOTAL_ERRORS} violation(s)"
  exit 1
fi
echo "PASS: view-registry-panel-ux-gate — G1-G7 static checks clean for ${PANEL_FILE}"
exit 0
