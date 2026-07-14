#!/usr/bin/env bash
# T-0572 (rights UI writes) · FF-T0572-BADGE — «Каталог ролей» badge verdict
# (FR-8/AC-12, ADR §2.7).
#
# THE CONTRACT: DESIGN's verdict (ADR §2.7) is that /rights/editor's badge
# STAYS "demo" — ra-role-editor.jsx writes real grants (POST /api/grants/
# propose/confirm2) but its grant DRAFT is seeded from INITIAL_GRANTS (a
# static fixture), not a live projection of the role's existing grants from
# the DB. G7 (бейдж≡контент) requires the tooltip name THIS SPECIFICALLY —
# not the old generic "данные иллюстративные (mock)" wording — so a reader
# knows exactly what's mocked.
#
# Checks the CURRENT content of web/src/app-shell/shell.jsx (state assertion,
# not diff-scoped — mirrors rights-overview-source-switch.sh's style):
#   1. REFERENCE_TABS' "editor" entry still has status:"demo" (NOT "live" —
#      flipping it silently would violate the DESIGN verdict without a new
#      ADR decision).
#   2. Its demoTooltip (or inline Tooltip label at the render site) contains a
#      CONCRETE marker — mentions "гранты роли" (or "черновик") — not the bare
#      generic wording alone.
#
# Exit 0 clean, non-zero on any violation. --self-test exercises the detector
# against synthetic good/bad fixture files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TARGET="${PROJECT_ROOT}/web/src/app-shell/shell.jsx"

# check_file <path> — sets `errors` global (bash 3.2 compatible).
check_file() {
  local file="$1"
  errors=0
  if [[ ! -f "${file}" ]]; then
    echo "FAIL [FF-T0572-BADGE]: file not found: ${file}"
    errors=$((errors + 1))
    return
  fi

  # 1. The "editor" REFERENCE_TABS entry must still declare status:"demo".
  #    (grep the whole line containing id:"editor" through its status field —
  #    a single-line object literal in this file's convention.)
  local editor_line
  editor_line="$(grep -E 'id:\s*"editor"' "${file}" || true)"
  if [[ -z "${editor_line}" ]]; then
    echo "FAIL [FF-T0572-BADGE]: no REFERENCE_TABS entry with id:\"editor\" found in ${file}"
    errors=$((errors + 1))
  elif ! echo "${editor_line}" | grep -qE 'status:\s*"demo"'; then
    echo "FAIL [FF-T0572-BADGE]: REFERENCE_TABS \"editor\" entry is not status:\"demo\" — DESIGN verdict (ADR §2.7) requires it stay \"demo\":"
    echo "${editor_line}"
    errors=$((errors + 1))
  fi

  # 2. A concrete tooltip marker must exist SOMEWHERE in the file — either as
  #    a demoTooltip field value or the Tooltip label prop at the render site.
  if ! grep -qE '(гранты роли|черновик)' "${file}"; then
    echo "FAIL [FF-T0572-BADGE]: no concrete demo-badge tooltip marker found (expected mention of 'гранты роли' or 'черновик') — G7 requires a SPECIFIC reason, not the generic 'данные иллюстративные' wording alone"
    errors=$((errors + 1))
  fi
}

self_test() {
  echo "[T-0572] rights-editor-badge-verdict --self-test: synthetic fixtures"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  cat > "${tmp}/good.jsx" <<'EOF'
const REFERENCE_TABS = [
  { id: "editor", label: "Каталог ролей", path: "/rights/editor", status: "demo",
    demoTooltip: "Черновик грантов засеян примером; гранты роли из БД пока не подгружаются." },
];
EOF
  check_file "${tmp}/good.jsx"
  local good_errors=${errors}

  # BAD 1 — badge flipped to "live" without a new ADR decision.
  cat > "${tmp}/bad-live.jsx" <<'EOF'
const REFERENCE_TABS = [
  { id: "editor", label: "Каталог ролей", path: "/rights/editor", status: "live" },
];
EOF
  check_file "${tmp}/bad-live.jsx"
  local bad_live_errors=${errors}

  # BAD 2 — stays "demo" but with only the generic wording, no concrete marker.
  cat > "${tmp}/bad-generic.jsx" <<'EOF'
const REFERENCE_TABS = [
  { id: "editor", label: "Каталог ролей", path: "/rights/editor", status: "demo" },
];
const tip = "Демо — данные иллюстративные (mock)";
EOF
  check_file "${tmp}/bad-generic.jsx"
  local bad_generic_errors=${errors}

  if [[ ${good_errors} -ne 0 ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged the GOOD fixture (${good_errors} violation(s))"
    return 1
  fi
  if [[ ${bad_live_errors} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD (status:live) fixture"
    return 1
  fi
  if [[ ${bad_generic_errors} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on the BAD (generic-tooltip-only) fixture"
    return 1
  fi
  echo "SELF-TEST PASS: good fixture clean, both bad fixtures flagged (live=${bad_live_errors}, generic=${bad_generic_errors})"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0572] rights-editor-badge-verdict: FF-T0572-BADGE gate"
check_file "${TARGET}"
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: rights-editor-badge-verdict found ${errors} violation(s)"
  exit 1
fi
echo "PASS: rights-editor-badge-verdict — /rights/editor badge honestly demo with a concrete reason"
exit 0
