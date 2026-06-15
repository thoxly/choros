#!/usr/bin/env bash
# T-0234 · FF-DEMO3-1 — DEMO-3 legal-precheck agent invariants (static, no DB).
#
# Asserts the load-bearing invariants of the DEMO-3 slot impl:
#   (a) AGENT-IS-S3-ACTOR — the demo-run module consumes runLegalPrecheck and
#       injects an LlmPort (the agent, not a human, performs S3).
#   (b) NO-APPROVE-GRANT (moat) — the demo agent role's grants contain read/update
#       but NOT approve/exec/invoke on a transition (the agent cannot self-approve).
#   (c) NO-PAID-LLM-IN-DEMO — the demo-run module makes no network/SDK call
#       (no fetch( / new OpenAI / https.request / openai|@anthropic|axios import).
#   (d) DEALCONTEXT-ALIGNED — the demo dealContext is the T-0233 fixture
#       (service_agreement / outbound), consistent across tel-scenario.ts + demo-run.ts.
#
# SELF-TEST: planted violations (approve grant / network call) are detected.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

DEMO_RUN="$REPO_ROOT/src/runtime/legal-precheck/demo-run.ts"
SCENARIO="$REPO_ROOT/seed/demo/tel-scenario.ts"
SPEC="$REPO_ROOT/docs/specs/T-0234-legal-precheck-demo.spec.md"
ADR="$REPO_ROOT/docs/design/T-0234-legal-precheck-demo.adr.md"

# Network/SDK patterns that would mean a paid LLM path exists in the demo.
NET_PATTERN='(fetch\(|https\.request|new OpenAI\b|XMLHttpRequest|from "(openai|@anthropic|axios)")'
# Grant-operation patterns that would break the moat (approve / exec / invoke).
APPROVE_PATTERN='operation:[[:space:]]*"(approve|exec|invoke)"'

# ---- core assertion logic (reused by --self-test against a fixture root) ----
check_root() {
  local demo_run="$1" scenario="$2" spec="$3" adr="$4"
  local fail=0

  for f in "$demo_run" "$scenario" "$spec" "$adr"; do
    if [[ ! -f "$f" ]]; then
      echo "FAIL FF-DEMO3-1: missing artifact: $f" >&2
      fail=1
    fi
  done
  [[ $fail -eq 1 ]] && return 1

  # (a) agent-is-S3-actor: demo-run consumes runLegalPrecheck + injects an LlmPort.
  if ! grep -q 'runLegalPrecheck' "$demo_run"; then
    echo "FAIL FF-DEMO3-1(a): demo-run does not consume runLegalPrecheck (agent-is-S3-actor)" >&2
    fail=1
  fi
  if ! grep -qE 'llm:[[:space:]]*(new DemoStubLlmPort|.*LlmPort|dormantLlmPort)' "$demo_run"; then
    echo "FAIL FF-DEMO3-1(a): demo-run does not inject an LlmPort" >&2
    fail=1
  fi

  # (b) no-approve-grant moat: the demo agent role grants must NOT carry approve/exec/invoke.
  #     (tel-scenario.ts DEMO_GRANTS_INTAKE = read + update, NO approve.)
  #     Comment lines (// or *-prefixed) are excluded — only real grant properties count.
  local approve_hits
  approve_hits=$(grep -nE "$APPROVE_PATTERN" "$scenario" 2>/dev/null \
    | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' || true)
  if [[ -n "$approve_hits" ]]; then
    echo "FAIL FF-DEMO3-1(b): tel-scenario grants include approve/exec/invoke — moat broken" >&2
    echo "$approve_hits" >&2
    fail=1
  fi
  # The demo-run module must positively express the moat (an approve-denial probe).
  if ! grep -q 'demoApproveDenied' "$demo_run"; then
    echo "FAIL FF-DEMO3-1(b): demo-run lacks the approve-denied moat probe" >&2
    fail=1
  fi

  # (c) no-paid-LLM-in-demo: the demo-run module makes no network/SDK call.
  local net_hits
  net_hits=$(grep -nE "$NET_PATTERN" "$demo_run" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*//|^[0-9]+:[[:space:]]*\*' || true)
  if [[ -n "$net_hits" ]]; then
    echo "FAIL FF-DEMO3-1(c): demo-run contains a network/SDK call (paid-LLM path):" >&2
    echo "$net_hits" >&2
    fail=1
  fi

  # (d) dealContext aligned with T-0233 fixture (service_agreement / outbound).
  if ! grep -q 'service_agreement' "$demo_run"; then
    echo "FAIL FF-DEMO3-1(d): demo-run dealContext not aligned to T-0233 (service_agreement)" >&2
    fail=1
  fi
  if ! grep -q 'service_agreement' "$scenario"; then
    echo "FAIL FF-DEMO3-1(d): tel-scenario dealContext not aligned to T-0233 (service_agreement)" >&2
    fail=1
  fi

  return $fail
}

# ---- SELF-TEST mode ----
if [[ "${1:-}" == "--self-test" ]]; then
  TMP=$(mktemp -d /tmp/ff-demo3-selftest-XXXXXX)
  trap 'rm -rf "$TMP"' EXIT

  mkdir -p "$TMP/good/src/runtime/legal-precheck" "$TMP/good/seed/demo" "$TMP/good/docs/specs" "$TMP/good/docs/design"
  cat > "$TMP/good/src/runtime/legal-precheck/demo-run.ts" <<'EOF'
import { runLegalPrecheck } from "./run-precheck.js";
const deps = { llm: new DemoStubLlmPort() };
export async function demoApproveDenied() { return { denied: true }; }
const DEAL = { kind: "service_agreement", direction: "outbound" };
EOF
  cat > "$TMP/good/seed/demo/tel-scenario.ts" <<'EOF'
const DEMO_GRANTS = [{ operation: "read" }, { operation: "update" }];
export const DEMO_DEAL = { category: "service_agreement", direction: "outbound" };
EOF
  echo spec > "$TMP/good/docs/specs/T-0234-legal-precheck-demo.spec.md"
  echo adr > "$TMP/good/docs/design/T-0234-legal-precheck-demo.adr.md"
  if ! check_root \
    "$TMP/good/src/runtime/legal-precheck/demo-run.ts" \
    "$TMP/good/seed/demo/tel-scenario.ts" \
    "$TMP/good/docs/specs/T-0234-legal-precheck-demo.spec.md" \
    "$TMP/good/docs/design/T-0234-legal-precheck-demo.adr.md"; then
    echo "FAIL FF-SELFTEST: good fixture should PASS but failed" >&2
    exit 1
  fi
  echo "SELF-TEST: good fixture passed as expected"

  # bad 1: approve grant in scenario (moat broken)
  mkdir -p "$TMP/bad1/seed/demo"
  cat > "$TMP/bad1/seed/demo/tel-scenario.ts" <<'EOF'
const DEMO_GRANTS = [{ operation: "approve" }];
export const DEMO_DEAL = { category: "service_agreement", direction: "outbound" };
EOF
  if check_root \
    "$TMP/good/src/runtime/legal-precheck/demo-run.ts" \
    "$TMP/bad1/seed/demo/tel-scenario.ts" \
    "$TMP/good/docs/specs/T-0234-legal-precheck-demo.spec.md" \
    "$TMP/good/docs/design/T-0234-legal-precheck-demo.adr.md" 2>/dev/null; then
    echo "FAIL FF-SELFTEST: bad fixture (approve grant) should FAIL but passed" >&2
    exit 1
  fi
  echo "SELF-TEST: bad fixture (approve grant → moat broken) failed as expected"

  # bad 2: network call in demo-run (paid-LLM path)
  mkdir -p "$TMP/bad2/src/runtime/legal-precheck"
  cat > "$TMP/bad2/src/runtime/legal-precheck/demo-run.ts" <<'EOF'
import { runLegalPrecheck } from "./run-precheck.js";
const deps = { llm: new DemoStubLlmPort() };
export async function demoApproveDenied() { return { denied: true }; }
const r = await fetch("https://api.openai.com/v1/chat/completions");
const DEAL = { kind: "service_agreement" };
EOF
  if check_root \
    "$TMP/bad2/src/runtime/legal-precheck/demo-run.ts" \
    "$TMP/good/seed/demo/tel-scenario.ts" \
    "$TMP/good/docs/specs/T-0234-legal-precheck-demo.spec.md" \
    "$TMP/good/docs/design/T-0234-legal-precheck-demo.adr.md" 2>/dev/null; then
    echo "FAIL FF-SELFTEST: bad fixture (network call) should FAIL but passed" >&2
    exit 1
  fi
  echo "SELF-TEST: bad fixture (network call → paid-LLM) failed as expected"

  echo "FF-DEMO3-1: --self-test PASS"
  exit 0
fi

# ---- live mode ----
if ! check_root "$DEMO_RUN" "$SCENARIO" "$SPEC" "$ADR"; then
  echo "FAIL FF-DEMO3-1: DEMO-3 legal-precheck invariants check failed" >&2
  exit 1
fi

echo "PASS: agent-is-S3-actor; no-approve-grant (moat); no-paid-LLM-in-demo; dealContext aligned (T-0233)"
echo "FF-DEMO3-1: demo3-legal-precheck PASS"
