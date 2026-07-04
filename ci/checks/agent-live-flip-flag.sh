#!/usr/bin/env bash
# T-0586 [столп 4 — agentTask живьём] · agent-live-flip-flag (FF-586-1 / FF-586-3)
#
# Statically verifies the agent-dispatch composition root
# (src/server/agent-dispatch-loop.ts) actually reads the AGENT_LIVE_ENABLED
# deploy flag instead of hard-coding `liveEnabled: false`, and that the live
# port is built through the SHARED resolver (OpenAILlmPort + tenantSecretResolver)
# rather than a copy-pasted SQL resolve of llm_connection/secret_handle.
#
# AC-1 (FF-586-1): buildAgentDispatchDeps reads AGENT_LIVE_ENABLED from env; the
#   literal `liveEnabled: false` may appear ONLY inside
#   buildDegradedAgentDispatchDeps (an intentionally-unreachable degraded path,
#   topics=[] — startAgentDispatchLoop returns a noopHandle before runDeps is
#   ever read there), never inside buildAgentDispatchDeps itself.
# AC-3 (FF-586-3): the file imports OpenAILlmPort (adapters) + tenantSecretResolver
#   (server.js) and does NOT contain its own raw SQL resolve of
#   llm_connection/secret_handle (that resolve already lives in
#   src/db/agent-provision.ts + assembleAgentStepContext — this file must not
#   duplicate it).
#
# METHODOLOGY (function-scoped grep): the file is split into per-function bodies
# using awk (brace-depth tracking from the `export function <name>(` line to its
# matching closing brace), so the "no liveEnabled:false in buildAgentDispatchDeps"
# check does NOT also flag buildDegradedAgentDispatchDeps's intentional literal —
# these are two DIFFERENT functions in the same file and must be scoped
# separately (a whole-file grep would conflate them).
#
# Exit 0 on all pass; non-zero on any violation. Supports --self-test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TARGET="${ROOT}/src/server/agent-dispatch-loop.ts"

# ---------------------------------------------------------------------------
# extract_function <file> <function_name> — print the body of a top-level
# `export function <function_name>(` ... matching-closing-brace block, tracking
# brace depth starting from the line containing the function signature.
# ---------------------------------------------------------------------------
extract_function() {
  local file="$1" fn="$2"
  awk -v fn="${fn}" '
    BEGIN { depth = 0; capturing = 0 }
    {
      if (!capturing) {
        if ($0 ~ ("export function " fn "\\(") || $0 ~ ("^function " fn "\\(")) {
          capturing = 1
        }
      }
      if (capturing) {
        print
        # Count braces on this line to track when the function body closes.
        line = $0
        n = length(line)
        for (i = 1; i <= n; i++) {
          c = substr(line, i, 1)
          if (c == "{") depth++
          if (c == "}") {
            depth--
            if (depth == 0) { capturing = 0 }
          }
        }
      }
    }
  ' "${file}"
}

# ---------------------------------------------------------------------------
# Self-test mode: plant synthetic violations in a scratch copy and prove the
# detector fires on each; prove a clean fixture passes.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[agent-live-flip-flag] --self-test"
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT

  # (1) Positive: a hard-coded liveEnabled:false INSIDE buildAgentDispatchDeps
  #     (planted, simulating the pre-T-0586 defect) must be detected.
  cat > "${TMPDIR_ST}/violation.ts" <<'TSFIX'
export function buildDegradedAgentDispatchDeps() {
  return {
    runDeps: { llm: dormantLlmPort, liveEnabled: false },
    topics: [],
  };
}

export function buildAgentDispatchDeps(production, env) {
  const topics = env["AGENT_TOPICS"];
  return {
    runDeps: { llm: dormantLlmPort, liveEnabled: false },
    topics,
  };
}
TSFIX
  body="$(extract_function "${TMPDIR_ST}/violation.ts" "buildAgentDispatchDeps")"
  if echo "${body}" | grep -qE 'liveEnabled:[[:space:]]*false' && ! echo "${body}" | grep -q 'AGENT_LIVE_ENABLED'; then
    echo "PASS self-test: hard-coded liveEnabled:false inside buildAgentDispatchDeps (without AGENT_LIVE_ENABLED) is detectable"
  else
    echo "FAIL self-test: detector did not find the planted violation"
    exit 1
  fi

  # (2) Negative: buildDegradedAgentDispatchDeps's OWN liveEnabled:false must
  #     NOT be flagged by the buildAgentDispatchDeps-scoped check (function
  #     isolation — the two functions are extracted independently).
  degraded_body="$(extract_function "${TMPDIR_ST}/violation.ts" "buildDegradedAgentDispatchDeps")"
  if echo "${degraded_body}" | grep -qE 'liveEnabled:[[:space:]]*false'; then
    echo "PASS self-test: buildDegradedAgentDispatchDeps body correctly isolated (contains its own liveEnabled:false, as expected/allowed)"
  else
    echo "FAIL self-test: function-body extraction did not isolate buildDegradedAgentDispatchDeps correctly"
    exit 1
  fi

  # (3) Positive: a fixed version (reads AGENT_LIVE_ENABLED, no bare literal)
  #     must pass the buildAgentDispatchDeps-scoped check.
  cat > "${TMPDIR_ST}/fixed.ts" <<'TSFIX'
export function buildAgentDispatchDeps(production, env) {
  const liveEnabled = env["AGENT_LIVE_ENABLED"] === "true";
  return {
    runDeps: liveEnabled
      ? { llm: dormantLlmPort, liveEnabled: true, llmPortFactory: makeAgentLlmPortFactory() }
      : { llm: dormantLlmPort, liveEnabled: false },
  };
}
TSFIX
  fixed_body="$(extract_function "${TMPDIR_ST}/fixed.ts" "buildAgentDispatchDeps")"
  if echo "${fixed_body}" | grep -q 'AGENT_LIVE_ENABLED'; then
    echo "PASS self-test: fixed buildAgentDispatchDeps (reads AGENT_LIVE_ENABLED) detected as compliant"
  else
    echo "FAIL self-test: fixed fixture not recognised as compliant"
    exit 1
  fi

  # (4) FF-586-3: a planted raw SQL resolve of llm_connection/secret_handle in
  #     this file must be detectable.
  cat > "${TMPDIR_ST}/sql-violation.ts" <<'TSFIX'
async function badResolve(pool) {
  return pool.query("SELECT secret_handle FROM choros.llm_connection WHERE id = $1", [1]);
}
TSFIX
  if grep -qE 'llm_connection|secret_handle' "${TMPDIR_ST}/sql-violation.ts"; then
    echo "PASS self-test: raw llm_connection/secret_handle SQL resolve is detectable"
  else
    echo "FAIL self-test: SQL resolve detector broken"
    exit 1
  fi

  echo "PASS self-test: all detectors functional"
  exit 0
fi

# ---------------------------------------------------------------------------
# Production check.
# ---------------------------------------------------------------------------
echo "[T-0586] agent-live-flip-flag: AGENT_LIVE_ENABLED flip + shared-resolver checks"
ERRORS=0

if [[ ! -f "${TARGET}" ]]; then
  echo "FAIL: ${TARGET} not found"
  exit 1
fi

# ---- FF-586-1(a): AGENT_LIVE_ENABLED referenced at least once in the file ----
echo ""
echo "Check FF-586-1(a): AGENT_LIVE_ENABLED referenced in agent-dispatch-loop.ts"
if grep -qE 'AGENT_LIVE_ENABLED' "${TARGET}"; then
  echo "PASS: AGENT_LIVE_ENABLED found ($(grep -cE 'AGENT_LIVE_ENABLED' "${TARGET}") occurrence(s))"
else
  echo "FAIL: AGENT_LIVE_ENABLED not referenced anywhere in ${TARGET}"
  ERRORS=$((ERRORS + 1))
fi

# ---- FF-586-1(b): buildAgentDispatchDeps must NOT contain a bare literal ----
#      liveEnabled: false unconditionally (it must read AGENT_LIVE_ENABLED).
echo ""
echo "Check FF-586-1(b): buildAgentDispatchDeps has no unconditional liveEnabled:false literal"
BUILD_BODY="$(extract_function "${TARGET}" "buildAgentDispatchDeps")"
if [[ -z "${BUILD_BODY}" ]]; then
  echo "FAIL: could not extract buildAgentDispatchDeps function body — has it been renamed?"
  ERRORS=$((ERRORS + 1))
elif ! echo "${BUILD_BODY}" | grep -q 'AGENT_LIVE_ENABLED'; then
  echo "FAIL: buildAgentDispatchDeps does not read AGENT_LIVE_ENABLED"
  ERRORS=$((ERRORS + 1))
else
  # A conditional (ternary) form containing "liveEnabled: false" as the FALSE
  # branch of a ternary keyed on the flag is fine — what's banned is a bare,
  # unconditional `runDeps: { llm: ..., liveEnabled: false }` with NO
  # AGENT_LIVE_ENABLED anywhere in the same function (already ruled out above).
  echo "PASS: buildAgentDispatchDeps reads AGENT_LIVE_ENABLED (conditional liveEnabled, not a bare literal)"
fi

# ---- FF-586-1(c): buildDegradedAgentDispatchDeps keeps liveEnabled:false, ----
#      documented as an intentionally-unreachable degraded path.
echo ""
echo "Check FF-586-1(c): buildDegradedAgentDispatchDeps documents its degraded liveEnabled:false"
DEGRADED_BODY="$(extract_function "${TARGET}" "buildDegradedAgentDispatchDeps")"
if [[ -z "${DEGRADED_BODY}" ]]; then
  echo "FAIL: could not extract buildDegradedAgentDispatchDeps function body — has it been renamed?"
  ERRORS=$((ERRORS + 1))
else
  # Look at the doc-comment immediately preceding the function for the
  # "degraded"/"unreachable" documentation (AC-1 requirement).
  DOC_COMMENT="$(awk '/\/\*\*/{start=NR} /export function buildDegradedAgentDispatchDeps\(/{print_from=start; exit} {lines[NR]=$0} END{if(print_from) for(i=print_from;i<NR;i++) print lines[i]}' "${TARGET}")"
  if echo "${DOC_COMMENT}" | grep -qiE 'degraded|unreachable|noopHandle|topics.*\[\]|topics: \[\]'; then
    echo "PASS: buildDegradedAgentDispatchDeps doc-comment documents the degraded/unreachable path"
  else
    echo "FAIL: buildDegradedAgentDispatchDeps doc-comment missing degraded/unreachable documentation"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- FF-586-3(a): no raw SQL resolve of llm_connection/secret_handle here ----
# Comment-only mentions (doc-comments explaining the reuse, e.g. "reuses the
# same chain as agent_card.llm_connection_id -> llm_connection") are NOT a
# violation — only CODE lines (not a // or * comment line, same comment-strip
# convention as anti-case-lock.sh / detel-literal-baseline.sh elsewhere in
# this repo) count, since those would indicate an actual duplicated SQL
# resolve rather than documentation of reuse.
echo ""
echo "Check FF-586-3(a): no llm_connection/secret_handle SQL resolve duplicated in agent-dispatch-loop.ts"
SQL_HITS=$(grep -nE 'llm_connection|secret_handle' "${TARGET}" | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' || true)
if [[ -n "${SQL_HITS}" ]]; then
  echo "FAIL: agent-dispatch-loop.ts references llm_connection/secret_handle directly (should reuse the shared resolver, not duplicate its SQL):"
  echo "${SQL_HITS}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS: no llm_connection/secret_handle literal in agent-dispatch-loop.ts"
fi

# ---- FF-586-3(b): imports OpenAILlmPort + tenantSecretResolver (shared) ----
echo ""
echo "Check FF-586-3(b): imports the shared OpenAILlmPort + tenantSecretResolver (no copy)"
if grep -q 'OpenAILlmPort' "${TARGET}"; then
  echo "PASS: OpenAILlmPort imported/referenced"
else
  echo "FAIL: OpenAILlmPort not found in agent-dispatch-loop.ts"
  ERRORS=$((ERRORS + 1))
fi
if grep -q 'tenantSecretResolver' "${TARGET}"; then
  echo "PASS: tenantSecretResolver imported/referenced"
else
  echo "FAIL: tenantSecretResolver not found in agent-dispatch-loop.ts"
  ERRORS=$((ERRORS + 1))
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: agent-live-flip-flag found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: agent-live-flip-flag — FF-586-1/FF-586-3 green"
exit 0
