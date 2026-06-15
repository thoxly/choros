#!/usr/bin/env bash
# T-0218 · FF-DEMO1-1 — first-demo scenario shape gate (static, no DB).
#
# Asserts that the DEMO-1 design artifacts exist and carry the load-bearing shape:
#   (1) SPEC + ADR + walkthrough + pr-handoff present.
#   (2) walkthrough lists the 5 named screens S1..S5 IN ORDER.
#   (3) both agent slots are specified in the scenario module:
#       - intake slot acts on S2, built_by T-0219;
#       - legal_precheck slot acts on S3, built_by T-0234, with the ≥ 5M₽ trigger
#         and the runLegalPrecheck dealContext signature.
#
# SELF-TEST: a fixture missing a screen / a slot fails detection (FF-SELFTEST-8).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

SPEC="$REPO_ROOT/docs/specs/T-0218-demo-1-scenario.spec.md"
ADR="$REPO_ROOT/docs/design/T-0218-demo-1-scenario.adr.md"
WALK="$REPO_ROOT/docs/demo/T-0218-walkthrough.md"
HANDOFF="$REPO_ROOT/docs/design/T-0218.pr-handoff.json"
SCENARIO="$REPO_ROOT/seed/demo/tel-scenario.ts"

# ---- core assertion logic (reused by --self-test against a fixture root) ----
check_root() {
  local spec="$1" adr="$2" walk="$3" handoff="$4" scenario="$5"
  local fail=0

  for f in "$spec" "$adr" "$walk" "$handoff" "$scenario"; do
    if [[ ! -f "$f" ]]; then
      echo "FAIL FF-DEMO1-1: missing artifact: $f" >&2
      fail=1
    fi
  done
  [[ $fail -eq 1 ]] && return 1

  # (2) walkthrough lists S1..S5 in order
  local last=0
  for n in 1 2 3 4 5; do
    if ! grep -q "S$n" "$walk"; then
      echo "FAIL FF-DEMO1-1: walkthrough missing screen S$n" >&2
      fail=1
    fi
  done
  # order check: line number of first S1 < first S2 < ... < first S5
  local prev_line=0
  for n in 1 2 3 4 5; do
    local ln
    ln=$(grep -n "S$n" "$walk" | head -1 | cut -d: -f1 || echo 0)
    if [[ -z "$ln" || "$ln" -eq 0 ]]; then
      echo "FAIL FF-DEMO1-1: S$n not found for order check" >&2
      fail=1
    elif [[ "$ln" -le "$prev_line" ]]; then
      echo "FAIL FF-DEMO1-1: screens out of order at S$n (line $ln <= prev $prev_line)" >&2
      fail=1
    fi
    prev_line="$ln"
  done

  # (3) scenario module specifies both slots
  # intake slot — S2, T-0219
  if ! grep -q 'id: "intake"' "$scenario"; then
    echo "FAIL FF-DEMO1-1: intake slot id missing in scenario module" >&2
    fail=1
  fi
  if ! grep -q '"T-0219"' "$scenario"; then
    echo "FAIL FF-DEMO1-1: intake slot built_by T-0219 missing" >&2
    fail=1
  fi
  # legal_precheck slot — S3, T-0234, ≥5M trigger + dealContext signature
  if ! grep -q 'id: "legal_precheck"' "$scenario"; then
    echo "FAIL FF-DEMO1-1: legal_precheck slot id missing in scenario module" >&2
    fail=1
  fi
  if ! grep -q '"T-0234"' "$scenario"; then
    echo "FAIL FF-DEMO1-1: legal_precheck slot built_by T-0234 missing" >&2
    fail=1
  fi
  if ! grep -q 'TEL_LEGAL_THRESHOLD_RUB = 5_000_000' "$scenario"; then
    echo "FAIL FF-DEMO1-1: ≥5M₽ threshold constant missing" >&2
    fail=1
  fi
  if ! grep -q 'dealContext.amount' "$scenario"; then
    echo "FAIL FF-DEMO1-1: legal_precheck dealContext signature missing" >&2
    fail=1
  fi

  return $fail
}

# ---- SELF-TEST mode ----
if [[ "${1:-}" == "--self-test" ]]; then
  TMP=$(mktemp -d /tmp/ff-demo1-selftest-XXXXXX)
  trap 'rm -rf "$TMP"' EXIT

  mkdir -p "$TMP/good/docs/specs" "$TMP/good/docs/design" "$TMP/good/docs/demo" "$TMP/good/seed/demo"
  # good fixture: all artifacts + ordered screens + both slots
  echo "spec" > "$TMP/good/docs/specs/spec.md"
  echo "adr" > "$TMP/good/docs/design/adr.md"
  printf 'S1\nS2\nS3\nS4\nS5\n' > "$TMP/good/docs/demo/walk.md"
  echo "{}" > "$TMP/good/docs/design/handoff.json"
  cat > "$TMP/good/seed/demo/scn.ts" <<'EOF'
export const TEL_LEGAL_THRESHOLD_RUB = 5_000_000;
id: "intake" built_by "T-0219"
id: "legal_precheck" built_by "T-0234" dealContext.amount
EOF
  if ! check_root \
    "$TMP/good/docs/specs/spec.md" "$TMP/good/docs/design/adr.md" \
    "$TMP/good/docs/demo/walk.md" "$TMP/good/docs/design/handoff.json" \
    "$TMP/good/seed/demo/scn.ts"; then
    echo "FAIL FF-SELFTEST-8: good fixture should PASS but failed" >&2
    exit 1
  fi
  echo "SELF-TEST: good fixture passed as expected"

  # bad fixture: missing S4 (out of order / missing screen)
  mkdir -p "$TMP/bad/docs/specs" "$TMP/bad/docs/design" "$TMP/bad/docs/demo" "$TMP/bad/seed/demo"
  echo s > "$TMP/bad/docs/specs/spec.md"; echo a > "$TMP/bad/docs/design/adr.md"
  printf 'S1\nS2\nS3\nS5\n' > "$TMP/bad/docs/demo/walk.md"
  echo "{}" > "$TMP/bad/docs/design/handoff.json"
  cp "$TMP/good/seed/demo/scn.ts" "$TMP/bad/seed/demo/scn.ts"
  if check_root \
    "$TMP/bad/docs/specs/spec.md" "$TMP/bad/docs/design/adr.md" \
    "$TMP/bad/docs/demo/walk.md" "$TMP/bad/docs/design/handoff.json" \
    "$TMP/bad/seed/demo/scn.ts" 2>/dev/null; then
    echo "FAIL FF-SELFTEST-8: bad fixture (missing S4) should FAIL but passed" >&2
    exit 1
  fi
  echo "SELF-TEST: bad fixture (missing S4) failed as expected"

  # bad fixture 2: missing legal_precheck slot
  mkdir -p "$TMP/bad2/seed/demo"
  printf 'S1\nS2\nS3\nS4\nS5\n' > "$TMP/good/docs/demo/walk.md"  # reuse good docs
  cat > "$TMP/bad2/seed/demo/scn.ts" <<'EOF'
export const TEL_LEGAL_THRESHOLD_RUB = 5_000_000;
id: "intake" built_by "T-0219"
EOF
  if check_root \
    "$TMP/good/docs/specs/spec.md" "$TMP/good/docs/design/adr.md" \
    "$TMP/good/docs/demo/walk.md" "$TMP/good/docs/design/handoff.json" \
    "$TMP/bad2/seed/demo/scn.ts" 2>/dev/null; then
    echo "FAIL FF-SELFTEST-8: bad fixture (no legal_precheck slot) should FAIL but passed" >&2
    exit 1
  fi
  echo "SELF-TEST: bad fixture (no legal_precheck slot) failed as expected"

  echo "FF-DEMO1-1: --self-test PASS"
  exit 0
fi

# ---- live mode ----
if ! check_root "$SPEC" "$ADR" "$WALK" "$HANDOFF" "$SCENARIO"; then
  echo "FAIL FF-DEMO1-1: scenario shape check failed" >&2
  exit 1
fi

echo "PASS: DEMO-1 artifacts present; S1..S5 ordered; both agent slots specified"
echo "FF-DEMO1-1: demo1-scenario-shape PASS"
