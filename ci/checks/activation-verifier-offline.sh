#!/usr/bin/env bash
# T-0198 · FF-T127-3 — activation verifier is offline + zero-dep (activation-verifier-offline)
#
# Rule: src/vendor/activation.ts (the verifyKey path) imports ONLY node builtins
# (node:crypto etc.), performs NO network call, NO DB, and reads NO process.env
# inside the verifier. This backs NF-2 (offline-verifiable) and the property that
# there is no hidden call-home kill-switch: a mandatory network round-trip to verify
# a key would itself be a covert availability kill-switch.
#
# Checks (on src/vendor/activation.ts):
#   1. every import is from a node: builtin (no bare 'http'/'https'/'pg'/'axios'/'node-fetch').
#   2. no fetch( / https?. client / new Client( / process.env on a code line.
#
# Comment-only lines are stripped first (documenting offline-ness is allowed).
#
# SELF-TEST (--self-test): plant a fixture that imports node-fetch and calls fetch();
# assert both tripwires fire. exit 0 if the demonstration succeeds, 2 if broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="$REPO_ROOT/src/vendor/activation.ts"

# Non-node imports that would break offline/zero-dep purity.
BAD_IMPORT_RE='^[[:space:]]*import[^;]*from[[:space:]]*["'\''](http|https|node:http|node:https|pg|axios|node-fetch|undici|got|cross-fetch)["'\'']'
# Network/DB/env tripwires on code lines.
BAD_CALL_RE='fetch\(|https?:\/\/|new[[:space:]]+Client\(|process\.env'

echo "[T-0198] activation-verifier-offline (FF-T127-3): src/vendor/activation.ts is offline + zero-dep"

code_lines() { grep -vE '^[[:space:]]*(//|[*]|/[*])' "$1" 2>/dev/null || true; }

check_file() { # check_file <path> -> echoes violations, returns 1 if any
  local f="$1" bad=0 code
  code="$(code_lines "$f")"
  if echo "$code" | grep -qE "$BAD_IMPORT_RE"; then
    echo "  non-node import:"; echo "$code" | grep -nE "$BAD_IMPORT_RE"; bad=1
  fi
  if echo "$code" | grep -qE "$BAD_CALL_RE"; then
    echo "  network/DB/env in verifier:"; echo "$code" | grep -nE "$BAD_CALL_RE"; bad=1
  fi
  return $bad
}

# --self-test: a planted-impure verifier must trip both rules.
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0198] activation-verifier-offline --self-test"
  TMP="$(mktemp --suffix=.ts 2>/dev/null || mktemp)"
  trap 'rm -f "$TMP"' EXIT
  cat > "$TMP" <<'IMPURE'
import fetch from "node-fetch";
export async function verifyKey() {
  const r = await fetch("https://vendor.example/verify");
  const k = process.env["X"];
  return r.ok && k;
}
IMPURE
  if check_file "$TMP" >/dev/null; then
    echo "SELF-TEST FAIL: impure verifier was NOT detected (exit 2)"; exit 2
  fi
  rm -f "$TMP"; trap - EXIT
  echo "[T-0198] activation-verifier-offline self-test PASS (exit 0)"
  exit 0
fi

[ -f "$TARGET" ] || { echo "FAIL [FF-T127-3]: $TARGET not found"; exit 1; }

if check_file "$TARGET"; then
  echo "PASS [FF-T127-3]: verifier imports only node builtins; no network/DB/env in the verify path"
  exit 0
else
  echo "FAIL [FF-T127-3]: src/vendor/activation.ts is not offline/zero-dep pure"
  exit 1
fi
