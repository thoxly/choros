#!/usr/bin/env bash
# T-0249 (review CE-1) · completion-effect-wired — the completion-effect primitive
# is LIVE in the production composition root, not "green over a dead circuit"
# (D-064): src/server.ts MUST build the registry via the production assembly
# (buildCompletionEffectRegistry, src/composition/completion-effects-root.ts) and
# pass it into registerInboxRoutes' writeDeps (completionEffectRegistry key).
#
# WHY A STATIC LOCK IN ADDITION TO THE ROUTE TEST: the route-level RED-lock test
# (ci/checks/db/T-0249-action-route-effect.db.test.ts) proves the ASSEMBLED
# registry fires through the real /action handler — but it necessarily builds its
# own writeDeps. Only this check pins that server.ts ITSELF passes the registry,
# so a future refactor cannot silently drop the wire while the tests stay green
# (the exact defect class CE-1 flagged).
#
# Checks:
#   (a) src/composition/completion-effects-root.ts exists and exports
#       buildCompletionEffectRegistry.
#   (b) src/server.ts imports buildCompletionEffectRegistry (code line, not comment).
#   (c) src/server.ts passes `completionEffectRegistry:` built via
#       buildCompletionEffectRegistry (code line, not comment).
#   (d) src/http/inbox.ts's InboxWriteDeps declares completionEffectRegistry and
#       the action handler destructures it (the seam consumes the wire).
#
# --self-test: verifies the detectors fire on planted good/bad fixtures.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# code_grep <pattern> <file> — count code-level (non-comment) occurrences.
code_grep() {
  local pattern="$1" file="$2" raw rc
  raw="$(grep -nE "${pattern}" "${file}" 2>&1)"; rc=$?
  if [[ ${rc} -ge 2 ]]; then
    echo "FAIL [completion-effect-wired]: grep error (rc=${rc}) on '${file}': ${raw}" >&2
    exit 2
  fi
  # NB: single-file `grep -n` output is `line:content` (no leading filename colon),
  # so the comment-strip anchor is ^line: — unlike the -rn variants elsewhere.
  ( printf '%s\n' "${raw}" || true ) | ( grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' || true ) | ( grep -c . || true )
}

if [[ "${1:-}" == "--self-test" ]]; then
  echo "[completion-effect-wired] --self-test"
  TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
  cat > "${TMP}/wired.ts" <<'TS'
import { buildCompletionEffectRegistry } from "./composition/completion-effects-root.js";
const x = { completionEffectRegistry: buildCompletionEffectRegistry(pool) };
TS
  cat > "${TMP}/dead.ts" <<'TS'
// buildCompletionEffectRegistry mentioned only in a comment — must NOT count.
const x = {};
TS
  [[ "$(code_grep 'buildCompletionEffectRegistry' "${TMP}/wired.ts")" -ge 2 ]] \
    || { echo "FAIL self-test: wired fixture not detected"; exit 1; }
  [[ "$(code_grep 'buildCompletionEffectRegistry' "${TMP}/dead.ts")" -eq 0 ]] \
    || { echo "FAIL self-test: comment-only mention false-positived"; exit 1; }
  echo "PASS self-test: wire detector functional (code-only, comment-immune)"
  exit 0
fi

echo "[T-0249] completion-effect-wired: primitive is live in the composition root"
ERRORS=0

ROOT_FILE="${PROJECT_ROOT}/src/composition/completion-effects-root.ts"
SERVER_FILE="${PROJECT_ROOT}/src/server.ts"
INBOX_FILE="${PROJECT_ROOT}/src/http/inbox.ts"

# (a) production assembly module exists + exports the builder.
if [[ ! -f "${ROOT_FILE}" ]]; then
  echo "FAIL (a): ${ROOT_FILE} not found — no production assembly for the registry"
  ERRORS=$((ERRORS + 1))
elif [[ "$(code_grep 'export function buildCompletionEffectRegistry' "${ROOT_FILE}")" -eq 0 ]]; then
  echo "FAIL (a): buildCompletionEffectRegistry not exported from completion-effects-root.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (a): completion-effects-root.ts exports buildCompletionEffectRegistry"
fi

# (b) server.ts imports the builder (code line).
if [[ "$(code_grep 'import \{ buildCompletionEffectRegistry \}' "${SERVER_FILE}")" -eq 0 ]]; then
  echo "FAIL (b): src/server.ts does not import buildCompletionEffectRegistry — the wire is dead (CE-1)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (b): server.ts imports the production builder"
fi

# (c) server.ts passes completionEffectRegistry built via the builder (code line).
if [[ "$(code_grep 'completionEffectRegistry: buildCompletionEffectRegistry\(' "${SERVER_FILE}")" -eq 0 ]]; then
  echo "FAIL (c): src/server.ts does not pass completionEffectRegistry: buildCompletionEffectRegistry(...) into inbox writeDeps (CE-1)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (c): server.ts passes the registry into registerInboxRoutes writeDeps"
fi

# (d) the seam consumes the wire.
if [[ "$(code_grep 'completionEffectRegistry\?: CompletionEffectRegistry' "${INBOX_FILE}")" -eq 0 ]]; then
  echo "FAIL (d): InboxWriteDeps.completionEffectRegistry not declared in inbox.ts"
  ERRORS=$((ERRORS + 1))
elif [[ "$(code_grep 'runCompletionEffect\(' "${INBOX_FILE}")" -eq 0 ]]; then
  echo "FAIL (d): inbox.ts never calls runCompletionEffect — seam does not consume the registry"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (d): inbox.ts seam declares + consumes the registry"
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: completion-effect-wired found ${ERRORS} violation(s) — the primitive is (partly) dead in prod"
  exit 1
fi
echo "PASS: completion-effect-wired — registry built by composition root, passed to the inbox seam"
exit 0
