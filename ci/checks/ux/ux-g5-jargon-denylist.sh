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
# COMMENT-SCOPING (T-0298 review fix): the scan runs over each file with its
# COMMENTS STRIPPED FIRST — block comments (/* … */, multi-line), JSX comments
# ({/* … */}), and // line comments are blanked (line numbers preserved). Dev
# jargon inside comments (`{/* T-0295 */}`, file-header `/* … T-0267 … */`
# blocks, `// T-0099: …`) is NOT visible product text, so flagging it was pure
# noise — 86 of 88 findings were T-ids inside comments, which would make the
# future `--required` flip fire on hundreds of legit comments and is therefore
# impossible to land. Stripping comments drops that noise to 0 while the
# genuine visible-text leaks (`telLinear`, `анти-oracle` in JSX text / string
# literals) are still caught. NOTE: this is a line-level comment stripper, not a
# full JS/JSX parser — it does not understand that a `/*` inside a string
# literal is not a comment; for these screen files that is a non-issue, and the
# conservative failure mode (under-flagging a contrived `"/* T-0001 */"` string)
# is acceptable for an informational gate.
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
# placeholder (must be flagged) plus a `T-0299` token buried in a JSX/block/line
# comment (must NOT be flagged — proves the comment-scoping), and asserts the
# detector behaves accordingly; exit 0 on success, 2 if the machinery is broken.
#
# EXIT CODES: 0 clean / informational · 1 violation (only with --required) · 2 self-test broken
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# Bare-UUID inside a JSX placeholder= attribute. A real product placeholder
# should read "напр. 3-фаза согласования", not a raw v4 UUID the user must type.
UUID_RE='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
UUID_PLACEHOLDER_RE="placeholder=[\"'][^\"']*${UUID_RE}"

# strip_comments <path> — emit the file with comments blanked but LINE NUMBERS
# PRESERVED (a stripped line becomes empty, not deleted), so a downstream
# `grep -n` still reports the true source line. Blanks: /* … */ block comments
# (tracked across lines), {/* … */} JSX comments (a {/* is just a /* with a
# leading brace), and // line comments. See COMMENT-SCOPING in the header for
# why (and the documented limitation re: /* inside string literals).
strip_comments() {
  awk '
    {
      line = $0; out = ""; i = 1; n = length(line)
      while (i <= n) {
        if (inblock) {
          rest = substr(line, i); p = index(rest, "*/")
          if (p > 0) { inblock = 0; i = i + p + 1; continue }
          else { i = n + 1; continue }          # whole remainder is comment
        }
        two = substr(line, i, 2)
        if (two == "/*") { inblock = 1; i += 2; continue }
        if (two == "//") { i = n + 1; continue } # rest of line is a line-comment
        out = out substr(line, i, 1); i++
      }
      print out
    }
  ' "$1"
}

# scan_file <path> — print "path:line:RULE:text" for each jargon hit in the
# COMMENT-STRIPPED file (so only plausibly-visible text/string-literal nodes are
# scanned); return 0 always (callers tally). Emits nothing for a clean file.
scan_file() {
  local f="$1" stripped
  stripped="$(strip_comments "$f" 2>/dev/null || true)"
  # Plain-token denylist (one ERE per rule so the matched rule is reportable).
  grep -nE 'T-[0-9]{3,}'   <<<"${stripped}" | sed "s#^#${f}:T-id:#"        || true
  grep -nE 'is_system'     <<<"${stripped}" | sed "s#^#${f}:is_system:#"   || true
  grep -nE 'genesis-seed'  <<<"${stripped}" | sed "s#^#${f}:genesis-seed:#" || true
  grep -nE 'telLinear'     <<<"${stripped}" | sed "s#^#${f}:telLinear:#"   || true
  grep -nE 'dogfood'       <<<"${stripped}" | sed "s#^#${f}:dogfood:#"     || true
  grep -nE 'анти-oracle'   <<<"${stripped}" | sed "s#^#${f}:anti-oracle:#" || true
  grep -nE '1970-01-01'    <<<"${stripped}" | sed "s#^#${f}:epoch-date:#"  || true
  grep -nE "${UUID_PLACEHOLDER_RE}" <<<"${stripped}" | sed "s#^#${f}:bare-uuid-placeholder:#" || true
}

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0298] ux-g5-jargon-denylist: --self-test"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT

  # Fixture 1: a screen leaking telLinear (visible JSX text) and a bare-UUID
  # placeholder — BOTH must be flagged — while T-ids buried in a file-header
  # block comment, a // line comment, and a {/* … */} JSX comment must NOT be
  # flagged (comment-scoping).
  cat >"${tmp}/screen-bad.jsx" <<'JSX'
/*
 * Header block comment — references T-0901 and T-0902 (must NOT flag).
 */
export function Bad() {
  // inline note T-0903 (must NOT flag)
  return (
    <div>
      {/* T-0904: layout note (must NOT flag) */}
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
  echo "  [OK] detected telLinear jargon (visible text)"
  if ! grep -q ':bare-uuid-placeholder:' <<<"${hits}"; then
    echo "SELF-TEST FAIL: detector missed bare-UUID placeholder"; exit 2
  fi
  echo "  [OK] detected bare-UUID placeholder"
  if grep -qE 'T-090[1-4]' <<<"${hits}"; then
    echo "SELF-TEST FAIL: detector flagged a T-id buried in a comment (comment-scoping broken)"; exit 2
  fi
  echo "  [OK] T-ids inside block / line / JSX comments not flagged"

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
