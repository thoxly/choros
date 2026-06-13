#!/usr/bin/env bash
# T-0198 · FF-T127-4 — entitlement gates ONLY vendor endpoints (exclusion check)
#
# Rule (AC-8): activation/entitlement reads appear ONLY in src/vendor/** and the
# vendor HTTP edges (src/http/vendor-*.ts). Any OTHER http handler — auth.ts,
# processes.ts, inbox.ts, audit.ts, rights.ts, grants.ts, org.ts, … — that
# references activation / entitlement / verifyKey / isEntitled is a violation:
# refusal on a missing/expired key must land on the vendor call, never on a
# user-facing endpoint.
#
# This is an EXCLUSION check (review nit R-2): activation vocabulary is permitted
# ONLY under the allowlisted paths; it FAILS the moment a non-vendor src/http/*.ts
# mentions it on a code line. New non-vendor handlers are covered automatically —
# the rule is "any src/http/*.ts that is not vendor-*".
#
# Comment-only lines are stripped (documenting the boundary is allowed).
#
# SELF-TEST (--self-test): plant src/http/_probe.ts that reads entitlement and assert
# the exclusion fires; plant src/http/vendor-_probe.ts that reads it and assert it is
# ALLOWED. exit 0 if both demonstrations hold, 2 if broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HTTP_DIR="$REPO_ROOT/src/http"

VOCAB_RE='activation|entitlement|verifyKey|isEntitled|not_after'

echo "[T-0198] entitlement-gates-vendor-only (FF-T127-4): activation reads only in vendor edges"

code_lines() { grep -vE '^[[:space:]]*(//|[*]|/[*])' "$1" 2>/dev/null || true; }

# Is this http file an ALLOWED vendor edge? (src/http/vendor-*.ts)
is_vendor_edge() {
  case "$(basename "$1")" in
    vendor-*.ts) return 0 ;;
    *) return 1 ;;
  esac
}

# Scan all non-vendor http handlers; echo violations, return 1 if any.
scan_dir() {
  local dir="$1" bad=0
  while IFS= read -r -d '' f; do
    is_vendor_edge "$f" && continue
    case "$(basename "$f")" in *.tmp.ts) continue ;; esac
    local code
    code="$(code_lines "$f")"
    if echo "$code" | grep -qiE "$VOCAB_RE"; then
      echo "  FAIL: non-vendor handler reads activation/entitlement: $f"
      echo "$code" | grep -niE "$VOCAB_RE" | sed 's/^/    /'
      bad=1
    fi
  done < <(find "$dir" -maxdepth 1 -name '*.ts' -print0)
  return $bad
}

# --self-test.
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0198] entitlement-gates-vendor-only --self-test"
  PROBE_BAD="$HTTP_DIR/_t0198_probe.tmp.ts"
  PROBE_OK="$HTTP_DIR/vendor-_t0198_probe.tmp.ts"
  trap 'rm -f "$HTTP_DIR"/_t0198_probe.tmp.ts "$HTTP_DIR"/vendor-_t0198_probe.tmp.ts' EXIT
  # NOTE: tmp.ts are excluded by the *.tmp.ts skip in scan_dir for the REAL run, but
  # the self-test calls the assertion logic directly on isolated single files.
  printf 'const e = readEntitlement().entitlement;\n' > "$PROBE_BAD"
  printf 'const e = readEntitlement().entitlement;\n' > "$PROBE_OK"

  # Bad probe (non-vendor) must be flagged.
  if is_vendor_edge "$PROBE_BAD" || ! code_lines "$PROBE_BAD" | grep -qiE "$VOCAB_RE"; then
    echo "SELF-TEST FAIL: non-vendor probe not classified as a violation (exit 2)"; exit 2
  fi
  # OK probe (vendor-*) must be allowlisted.
  if ! is_vendor_edge "$PROBE_OK"; then
    echo "SELF-TEST FAIL: vendor-* probe not recognised as an allowed edge (exit 2)"; exit 2
  fi
  rm -f "$PROBE_BAD" "$PROBE_OK"; trap - EXIT
  echo "[T-0198] entitlement-gates-vendor-only self-test PASS (exit 0)"
  exit 0
fi

[ -d "$HTTP_DIR" ] || { echo "FAIL [FF-T127-4]: $HTTP_DIR not found"; exit 1; }

if scan_dir "$HTTP_DIR"; then
  echo "PASS [FF-T127-4]: activation/entitlement read only in src/vendor/** and src/http/vendor-*.ts"
  exit 0
else
  echo "FAIL [FF-T127-4]: a non-vendor http handler reads activation/entitlement (gating leaked off the vendor edge)"
  exit 1
fi
