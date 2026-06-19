#!/usr/bin/env bash
# T-0298 · OBLIK UX honest-gate G5 — dev-jargon denylist in visible product text
#
# G5 (design/ux-quality-system.md §2.3): no developer jargon leaks into the
# VISIBLE product text. Audit found T-0244, is_system=true, genesis-seed,
# telLinear, анти-oracle, 1970-01-01, bare-UUID placeholders surfacing to the
# end user (findings #6, #7, #10). This check scans the screen/app-shell .jsx
# sources for those tokens.
#
# SCOPE: web/src/screens/*.jsx and web/src/app-shell/*.jsx (the product-text
# layer). The design/showcase and forms layers are excluded — they legitimately
# carry token names and theme machinery.
#
# DENYLIST (regex, case-sensitive where it matters):
#   T-\d{3,}          task ids (T-0244, T-0150, …)
#   is_system         internal column name
#   genesis-seed      bootstrap seed name
#   telLinear         demo process id
#   dogfood           internal jargon
#   анти-oracle       internal jargon (Cyrillic)
#   1970-01-01        epoch placeholder date (seed default)
#   bare-UUID in placeholder=  e.g. placeholder="3fa85f64-5717-4562-b3fc-2c963f66afa6"
#
# MODE — INFORMATIONAL (default): prints every finding as file:line plus a
# total count, but exits 0 (the screens are not migrated yet, so the chain
# stays green on current dev). Pass --required to make any finding fail (exit
# 1); this is the future honest-gate flip (D-056, after the screen migration).
#
# SELF-TEST (--self-test): plants a temp .jsx with `telLinear` and a bare-UUID
# placeholder and asserts the detector finds them; exit 0 on success, 2 if the
# check machinery is broken.
#
# EXIT CODES: 0 clean / informational · 1 violation (only with --required) · 2 self-test broken
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# Bare-UUID inside a JSX placeholder= attribute. A real product placeholder
# should read "напр. 3-фаза согласования", not a raw v4 UUID the user must type.
UUID_RE='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
UUID_PLACEHOLDER_RE="placeholder=[\"'][^\"']*${UUID_RE}"

# scan_file <path> — print "path:line:RULE:text" for each jargon hit; return 0
# always (callers tally). Emits nothing for a clean file.
scan_file() {
  local f="$1"
  # Plain-token denylist (one ERE per rule so the matched rule is reportable).
  grep -nE 'T-[0-9]{3,}'   "$f" 2>/dev/null | sed "s#^#${f}:T-id:#"        || true
  grep -nE 'is_system'     "$f" 2>/dev/null | sed "s#^#${f}:is_system:#"   || true
  grep -nE 'genesis-seed'  "$f" 2>/dev/null | sed "s#^#${f}:genesis-seed:#" || true
  grep -nE 'telLinear'     "$f" 2>/dev/null | sed "s#^#${f}:telLinear:#"   || true
  grep -nE 'dogfood'       "$f" 2>/dev/null | sed "s#^#${f}:dogfood:#"     || true
  grep -nE 'анти-oracle'   "$f" 2>/dev/null | sed "s#^#${f}:anti-oracle:#" || true
  grep -nE '1970-01-01'    "$f" 2>/dev/null | sed "s#^#${f}:epoch-date:#"  || true
  grep -nE "${UUID_PLACEHOLDER_RE}" "$f" 2>/dev/null | sed "s#^#${f}:bare-uuid-placeholder:#" || true
}

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0298] ux-g5-jargon-denylist: --self-test"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT

  # Fixture 1: a screen leaking telLinear and a bare-UUID placeholder.
  cat >"${tmp}/screen-bad.jsx" <<'JSX'
export function Bad() {
  return (
    <div>
      <p>Процесс: telLinear</p>
      <input placeholder="3fa85f64-5717-4562-b3fc-2c963f66afa6" />
    </div>
  );
}
JSX
  hits="$(scan_file "${tmp}/screen-bad.jsx")"
  if ! grep -q ':telLinear:' <<<"${hits}"; then
    echo "SELF-TEST FAIL: detector missed 'telLinear'"; exit 2
  fi
  echo "  [OK] detected telLinear jargon"
  if ! grep -q ':bare-uuid-placeholder:' <<<"${hits}"; then
    echo "SELF-TEST FAIL: detector missed bare-UUID placeholder"; exit 2
  fi
  echo "  [OK] detected bare-UUID placeholder"

  # Fixture 2: a clean screen → no hits.
  cat >"${tmp}/screen-good.jsx" <<'JSX'
export function Good() {
  return <input placeholder="Название процесса" />;
}
JSX
  if [[ -n "$(scan_file "${tmp}/screen-good.jsx")" ]]; then
    echo "SELF-TEST FAIL: detector flagged a clean screen"; exit 2
  fi
  echo "  [OK] clean screen produced no findings"

  echo "[T-0298] ux-g5-jargon-denylist: --self-test PASS"
  exit 0
fi

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
REQUIRED=0
if [[ "${1:-}" == "--required" ]]; then REQUIRED=1; fi

MODE_LABEL="INFORMATIONAL"
[[ "${REQUIRED}" -eq 1 ]] && MODE_LABEL="REQUIRED"
echo "[T-0298] ux-g5-jargon-denylist (G5): scanning visible product text for dev-jargon (mode=${MODE_LABEL})"

FINDINGS=""
shopt -s nullglob
for f in "${ROOT}"/web/src/screens/*.jsx "${ROOT}"/web/src/app-shell/*.jsx; do
  [[ -f "$f" ]] || continue
  rel="${f#"${ROOT}/"}"
  hits="$(cd "${ROOT}" && scan_file "${rel}")"
  [[ -n "${hits}" ]] && FINDINGS+="${hits}"$'\n'
done
shopt -u nullglob

COUNT=0
if [[ -n "${FINDINGS//[$'\n']/}" ]]; then
  COUNT="$(grep -c . <<<"${FINDINGS}" || true)"
  echo "${FINDINGS}" | sed '/^$/d'
fi

echo "[T-0298] ux-g5-jargon-denylist: ${COUNT} dev-jargon finding(s) in visible product text"

if [[ "${COUNT}" -gt 0 && "${REQUIRED}" -eq 1 ]]; then
  echo "FAIL [G5]: dev-jargon present in product text (run with screens migrated, then this gate is required)" >&2
  exit 1
fi
echo "PASS [G5]: informational (exit 0) — flip to required with --required after screen migration"
exit 0
