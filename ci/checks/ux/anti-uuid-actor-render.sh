#!/usr/bin/env bash
# T-0648 [W4-UX/столп 4] · anti-uuid-actor-render — recidivism lock for the
# UX-study §3 finding: "machine layer leaks into the human layer" (UUID/slug
# rendered as content instead of a resolved human-readable name).
#
# THE DEFECT CLASS THIS CATCHES (the exact bug fixed by this task): a JSX
# element renders a raw actor/record identifier field DIRECTLY as a bare child
# — e.g. `<span>{ev.actor}</span>` (screen-audit.jsx, pre-fix) or
# `<MonoId>{instance.recordId}</MonoId>` used AS the sole representation of a
# record-source instead of a resolved title (screen-process-instance.jsx,
# pre-fix). Both are now routed through ActorChip / RecordRef (the T-0648
# primitives — see web/src/components/components.jsx) which resolve a display
# NAME first and keep the raw id secondary (tooltip / explicit MonoId chip).
#
# WHAT THIS GATE DOES NOT DO: it is NOT a JSX/AST parser — it is a targeted,
# high-signal regex scan for the SPECIFIC anti-pattern (a bare `{<wireField>}`
# JSX-text child, where <wireField> is one of the actor/record identifier
# accessors this task's readers emit: .actor, .claimedBy, .completedBy,
# .assignee, .recordId — see docs/design/ux-study-2026-07-05.md §3's "13
# места" table) that is NOT wrapped by one of the sanctioned display
# primitives (ActorChip, RecordRef, MonoId, Mono) on the SAME line. This is a
# deliberately narrow, low-false-positive net — broader than that would need
# a real JSX parser this repo's zero-dep bash-only fitness tier does not have.
#
# SANCTIONED WRAPPERS (a hit on the same line as one of these tag names is NOT
# flagged — the primitive itself resolves/labels the id honestly):
#   ActorChip, RecordRef, MonoId, Mono, ExecutorBadge, AuditEvent
#
# FLAGGED WIRE FIELDS (raw identifier accessors — see the ux-study §3 table):
#   .actor  .claimedBy  .completedBy  .assignee  .recordId  .execSlug
#
# SCOPE: web/src/screens/**/*.jsx (the product-text layer — mirrors ux-g5/g6's
# own scope choice). web/src/components/** (the kit itself) and web/src/design/**
# are excluded — the kit legitimately handles raw ids internally (that IS its
# job) and is exercised by its own unit tests (actor-chip.test.jsx).
#
# MODE: REQUIRED (not informational) — this is a recidivism LOCK, not a
# migration-tracking gate (unlike ux-g5/g6, which track pre-existing debt this
# repo hasn't paid down yet). The offending pattern was fully fixed by T-0648;
# any new occurrence is unambiguously a regression, so this fails immediately
# (exit 1) rather than accumulating as informational debt.
#
# SELF-TEST (--self-test): plants a synthetic BAD fixture (a bare `{row.actor}`
# JSX child with no wrapper) — must be flagged — and a synthetic GOOD fixture
# (the same field routed through `<ActorChip .../>`) — must NOT be flagged —
# plus a comment-only mention (must NOT be flagged). Exit 0 on success, 2 if
# the detector itself is broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# Raw identifier field accessors that must never be rendered as a bare JSX
# TEXT CHILD (i.e. `>{expr}<`, a rendered node) — as opposed to a PROP value
# (`key={r.actor}`, `id={t.claimedBy}`), which is exactly how these fields
# correctly reach ActorChip/RecordRef today and must NOT be flagged. The `>`
# (optionally followed by whitespace) immediately before `{` is the JSX-child
# position signature; a prop assignment is preceded by `propName=`, never `>`.
# `\.` escapes the property-access dot; the trailing `\}` closes the JSX
# expression container so we only match a SOLE bare reference (not, say,
# `foo(item.actor)` used as a comparison/filter, which is not a render).
RAW_FIELD_RE='>[[:space:]]*\{[A-Za-z0-9_]+\.(actor|claimedBy|completedBy|assignee|recordId|execSlug)\}'

# Sanctioned wrapper tags — a line containing one of these tag names is
# presumed to be the primitive's OWN usage (passing the raw field as a PROP,
# e.g. `<ActorChip id={t.claimedBy} .../>`, which is exactly how these fields
# should reach the primitive) and is excluded from the raw-render check.
WRAPPER_RE='<(ActorChip|RecordRef|MonoId|Mono|ExecutorBadge|AuditEvent)[ />]'

# strip_comments — same line-preserving comment blanker as ux-g5 (block /* */,
# JSX {/* */}, line //) so a comment MENTIONING the pattern (explaining the
# ban, like this file's own header) is never a false positive.
strip_comments() {
  awk '
    {
      line = $0; out = ""; i = 1; n = length(line)
      while (i <= n) {
        if (inblock) {
          rest = substr(line, i); p = index(rest, "*/")
          if (p > 0) { inblock = 0; i = i + p + 1; continue }
          else { i = n + 1; continue }
        }
        two = substr(line, i, 2)
        if (two == "/*") { inblock = 1; i += 2; continue }
        if (two == "//") { i = n + 1; continue }
        out = out substr(line, i, 1); i++
      }
      print out
    }
  ' "$1"
}

# scan_file <path> — print "path:lineno:matched-text" for each bare raw-field
# render NOT accompanied by a sanctioned wrapper tag on the same line.
scan_file() {
  local f="$1" stripped
  stripped="$(strip_comments "$f" 2>/dev/null || true)"
  awk -v file="$f" -v raw_re="${RAW_FIELD_RE}" -v wrap_re="${WRAPPER_RE}" '
    {
      if ($0 ~ raw_re && $0 !~ wrap_re) {
        print file ":" NR ":" $0
      }
    }
  ' <<<"${stripped}"
}

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0648] anti-uuid-actor-render: --self-test"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT

  # BAD fixture: bare {row.actor} with no sanctioned wrapper — must be flagged.
  cat >"${tmp}/screen-bad.jsx" <<'JSX'
function BadRow({ row }) {
  return (
    <div className="chs-ev">
      <span className="chs-ev__actor">{row.actor}</span>
    </div>
  );
}
JSX
  bad_hits="$(scan_file "${tmp}/screen-bad.jsx")"
  if [[ -z "${bad_hits}" ]]; then
    echo "SELF-TEST FAIL: detector missed a bare {row.actor} render"; exit 2
  fi
  echo "  [OK] detected bare {row.actor} render (the fixed screen-audit.jsx defect class)"

  # GOOD fixture: the SAME field, routed through ActorChip — must NOT be flagged.
  cat >"${tmp}/screen-good.jsx" <<'JSX'
function GoodRow({ row }) {
  return (
    <div className="chs-ev">
      <ActorChip type={row.actorDisplay?.type} name={row.actorDisplay?.name} id={row.actor} />
    </div>
  );
}
JSX
  good_hits="$(scan_file "${tmp}/screen-good.jsx")"
  if [[ -n "${good_hits}" ]]; then
    echo "SELF-TEST FAIL: detector wrongly flagged a line using the sanctioned ActorChip wrapper"; exit 2
  fi
  echo "  [OK] ActorChip-wrapped usage not flagged"

  # COMMENT fixture: a bare-looking mention inside a comment — must NOT be flagged.
  cat >"${tmp}/screen-comment.jsx" <<'JSX'
function CommentedRow({ row }) {
  // old code used to do: <span>{row.actor}</span> — now fixed via ActorChip
  return <ActorChip name={row.actorDisplay?.name} id={row.actor} />;
}
JSX
  comment_hits="$(scan_file "${tmp}/screen-comment.jsx")"
  if [[ -n "${comment_hits}" ]]; then
    echo "SELF-TEST FAIL: detector flagged a comment-only mention of the banned pattern"; exit 2
  fi
  echo "  [OK] comment-only mention not flagged"

  # recordId variant — proves the field list beyond .actor also fires.
  cat >"${tmp}/screen-bad2.jsx" <<'JSX'
function BadInstance({ instance }) {
  return <span>{instance.recordId}</span>;
}
JSX
  bad2_hits="$(scan_file "${tmp}/screen-bad2.jsx")"
  if [[ -z "${bad2_hits}" ]]; then
    echo "SELF-TEST FAIL: detector missed a bare {instance.recordId} render"; exit 2
  fi
  echo "  [OK] detected bare {instance.recordId} render (the fixed screen-process-instance.jsx defect class)"

  echo "[T-0648] anti-uuid-actor-render: --self-test PASS"
  exit 0
fi

# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
echo "[T-0648] anti-uuid-actor-render: scanning web/src/screens/**/*.jsx for bare raw-identifier renders"

FINDINGS=""
while IFS= read -r -d '' f; do
  rel="${f#"${ROOT}/"}"
  hits="$(scan_file "${f}")"
  [[ -n "${hits}" ]] && FINDINGS+="${hits//${f}/${rel}}"$'\n'
done < <(find "${ROOT}/web/src/screens" -name '*.jsx' -print0 2>/dev/null)

COUNT=0
if [[ -n "${FINDINGS//[$'\n']/}" ]]; then
  COUNT="$(grep -c . <<<"${FINDINGS}" || true)"
  echo "${FINDINGS}" | sed '/^$/d'
fi

echo "[T-0648] anti-uuid-actor-render: ${COUNT} bare raw-identifier render(s) found"

if [[ "${COUNT}" -gt 0 ]]; then
  echo "FAIL [T-0648]: a screen renders a raw actor/record identifier as a bare JSX child — route it through ActorChip/RecordRef/MonoId instead" >&2
  exit 1
fi
echo "PASS [T-0648]: no bare raw-identifier renders under web/src/screens/"
exit 0
