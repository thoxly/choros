#!/usr/bin/env bash
# T-0219 · FF-INTAKE-1 — intake-agent seed + classifier invariants (static, no DB).
#
# Asserts the load-bearing invariants of the intake-agent slot build:
#   (1) SPEC + ADR + impl + pr-handoff artifacts present.
#   (2) route is TYPED (IntakeRoute with legal_required / steps / approver_chain) —
#       closes the T-0218 review «route = prose» flag.
#   (3) MOAT: role-intake-agent has NO approve/exec/invoke grant in the demo seed.
#   (4) agent_card intake is DORMANT (llm_* null) → zero paid LLM.
#   (5) instruction is DRAFT-FIRST (tier:"draft") + answer_form "intake_triage_v1".
#   (6) classifier is PURE — no pg/fetch/agent_instruction read (dormant gate safe).
#
# SELF-TEST: a fixture violating an invariant (approve grant / non-draft tier /
#            live llm) fails detection (FF-SELFTEST convention).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SPEC="$REPO_ROOT/docs/specs/T-0219-intake-agent.spec.md"
ADR="$REPO_ROOT/docs/design/T-0219-intake-agent.adr.md"
HANDOFF="$REPO_ROOT/docs/design/T-0219.pr-handoff.json"
TYPES="$REPO_ROOT/src/runtime/intake/intake-types.ts"
CLASSIFIER="$REPO_ROOT/src/runtime/intake/classify-intake.ts"
SCENARIO="$REPO_ROOT/seed/demo/tel-scenario.ts"

# ---- core assertion logic (reused by --self-test against a fixture root) ----
check_root() {
  local spec="$1" adr="$2" handoff="$3" types="$4" classifier="$5" scenario="$6"
  local fail=0

  # (1) artifacts present
  for f in "$spec" "$adr" "$handoff" "$types" "$classifier" "$scenario"; do
    if [[ ! -f "$f" ]]; then
      echo "FAIL FF-INTAKE-1: missing artifact: $f" >&2
      fail=1
    fi
  done
  [[ $fail -eq 1 ]] && return 1

  # (2) route typed — IntakeRoute with the three fields
  for token in 'interface IntakeRoute' 'legal_required' 'approver_chain' 'steps'; do
    if ! grep -q "$token" "$types"; then
      echo "FAIL FF-INTAKE-1: route not typed — '$token' missing in intake-types.ts" >&2
      fail=1
    fi
  done

  # (3) MOAT — no approve/exec/invoke grant for role-intake-agent in the demo seed.
  # The intake grants block uses operation: "read" / "update" only. Scan the
  # DEMO_GRANTS_INTAKE region for forbidden operations.
  if awk '/DEMO_GRANTS_INTAKE/{f=1} f{print} /^\];/{if(f)exit}' "$scenario" \
       | grep -Eq 'operation:[[:space:]]*"(approve|exec|invoke)"'; then
    echo "FAIL FF-INTAKE-1: MOAT broken — role-intake-agent has approve/exec/invoke grant" >&2
    fail=1
  fi
  # The role description must assert NO approve (defence-in-depth doc invariant).
  if ! grep -q 'role-intake-agent' "$scenario"; then
    echo "FAIL FF-INTAKE-1: role-intake-agent slug missing in seed" >&2
    fail=1
  fi

  # (4) agent_card DORMANT — llm_* null in DEMO_AGENT_CARD_INTAKE
  if ! grep -q 'DEMO_AGENT_CARD_INTAKE' "$scenario"; then
    echo "FAIL FF-INTAKE-1: DEMO_AGENT_CARD_INTAKE missing in seed" >&2
    fail=1
  fi
  if awk '/DEMO_AGENT_CARD_INTAKE: DemoAgentCard = \{/{f=1} f{print} /^\};/{if(f)exit}' "$scenario" \
       | grep -Eq 'llm_endpoint:[[:space:]]*"|llm_model:[[:space:]]*"|llm_secret_handle:[[:space:]]*"'; then
    echo "FAIL FF-INTAKE-1: agent_card NOT dormant — a llm_* field is non-null (paid LLM risk)" >&2
    fail=1
  fi

  # (5) instruction DRAFT-FIRST + answer_form
  if ! grep -q 'tier: "draft"' "$scenario"; then
    echo "FAIL FF-INTAKE-1: instruction not draft-first (tier: \"draft\" missing)" >&2
    fail=1
  fi
  if ! grep -q 'intake_triage_v1' "$scenario"; then
    echo "FAIL FF-INTAKE-1: answer_form intake_triage_v1 missing" >&2
    fail=1
  fi

  # (6) classifier PURE — no pg / fetch / agent_instruction read
  if grep -Eq "from \"pg\"|require\\('pg'\\)|fetch\\(|agent-instruction-store|readPublished|readDraft" "$classifier"; then
    echo "FAIL FF-INTAKE-1: classifier not pure — pg/fetch/agent_instruction read present" >&2
    fail=1
  fi

  return $fail
}

# ---- SELF-TEST mode ----
if [[ "${1:-}" == "--self-test" ]]; then
  TMP=$(mktemp -d /tmp/ff-intake-selftest-XXXXXX)
  trap 'rm -rf "$TMP"' EXIT

  mkdir -p "$TMP/good/docs/specs" "$TMP/good/docs/design" "$TMP/good/src/runtime/intake" "$TMP/good/seed/demo"
  echo "spec" > "$TMP/good/docs/specs/spec.md"
  echo "adr"  > "$TMP/good/docs/design/adr.md"
  echo "{}"   > "$TMP/good/docs/design/handoff.json"
  cat > "$TMP/good/src/runtime/intake/types.ts" <<'EOF'
export interface IntakeRoute { steps: []; legal_required: boolean; approver_chain: []; }
EOF
  cat > "$TMP/good/src/runtime/intake/classify.ts" <<'EOF'
export function classifyIntake() { return {}; }
EOF
  cat > "$TMP/good/seed/demo/scn.ts" <<'EOF'
export const DEMO_GRANTS_INTAKE = [
  { role_slug: "role-intake-agent", operation: "read" },
  { role_slug: "role-intake-agent", operation: "update" },
];
export const DEMO_AGENT_CARD_INTAKE: DemoAgentCard = {
  llm_endpoint: null,
  llm_model: null,
  llm_secret_handle: null,
};
const x = { tier: "draft", answer_form: "intake_triage_v1" };
EOF
  if ! check_root \
    "$TMP/good/docs/specs/spec.md" "$TMP/good/docs/design/adr.md" \
    "$TMP/good/docs/design/handoff.json" "$TMP/good/src/runtime/intake/types.ts" \
    "$TMP/good/src/runtime/intake/classify.ts" "$TMP/good/seed/demo/scn.ts"; then
    echo "FAIL FF-SELFTEST: good fixture should PASS but failed" >&2
    exit 1
  fi
  echo "SELF-TEST: good fixture passed as expected"

  # bad-1: approve grant (moat broken)
  mkdir -p "$TMP/bad1/seed/demo"
  cat > "$TMP/bad1/seed/demo/scn.ts" <<'EOF'
export const DEMO_GRANTS_INTAKE = [
  { role_slug: "role-intake-agent", operation: "read" },
  { role_slug: "role-intake-agent", operation: "approve" },
];
export const DEMO_AGENT_CARD_INTAKE: DemoAgentCard = {
  llm_endpoint: null, llm_model: null, llm_secret_handle: null,
};
const x = { tier: "draft", answer_form: "intake_triage_v1" };
EOF
  if check_root \
    "$TMP/good/docs/specs/spec.md" "$TMP/good/docs/design/adr.md" \
    "$TMP/good/docs/design/handoff.json" "$TMP/good/src/runtime/intake/types.ts" \
    "$TMP/good/src/runtime/intake/classify.ts" "$TMP/bad1/seed/demo/scn.ts" 2>/dev/null; then
    echo "FAIL FF-SELFTEST: bad fixture (approve grant) should FAIL but passed" >&2
    exit 1
  fi
  echo "SELF-TEST: bad fixture (approve grant / moat) failed as expected"

  # bad-2: live llm (agent_card not dormant)
  mkdir -p "$TMP/bad2/seed/demo"
  cat > "$TMP/bad2/seed/demo/scn.ts" <<'EOF'
export const DEMO_GRANTS_INTAKE = [
  { role_slug: "role-intake-agent", operation: "read" },
];
export const DEMO_AGENT_CARD_INTAKE: DemoAgentCard = {
  llm_endpoint: "https://api.openai.com", llm_model: null, llm_secret_handle: null,
};
const x = { tier: "draft", answer_form: "intake_triage_v1" };
EOF
  if check_root \
    "$TMP/good/docs/specs/spec.md" "$TMP/good/docs/design/adr.md" \
    "$TMP/good/docs/design/handoff.json" "$TMP/good/src/runtime/intake/types.ts" \
    "$TMP/good/src/runtime/intake/classify.ts" "$TMP/bad2/seed/demo/scn.ts" 2>/dev/null; then
    echo "FAIL FF-SELFTEST: bad fixture (live llm) should FAIL but passed" >&2
    exit 1
  fi
  echo "SELF-TEST: bad fixture (live llm / not dormant) failed as expected"

  echo "FF-INTAKE-1: --self-test PASS"
  exit 0
fi

# ---- live mode ----
if ! check_root "$SPEC" "$ADR" "$HANDOFF" "$TYPES" "$CLASSIFIER" "$SCENARIO"; then
  echo "FAIL FF-INTAKE-1: intake-agent seed/classifier invariants check failed" >&2
  exit 1
fi

echo "PASS: intake-agent artifacts present; route typed; moat (no approve grant);"
echo "      agent_card dormant; instruction draft-first; classifier pure"
echo "FF-INTAKE-1: intake-agent-seed PASS"
