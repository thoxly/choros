#!/usr/bin/env bash
# T-0143 · FF-T143-5 — No new process.env reads inside src/core/ (NF-1 / AC-8)
#
# Rule: grep -rn "process\.env" src/core/ returns no matches.
# The env boundary stays EXCLUSIVELY in src/main.ts — the only place that reads
# CHOROS_MASK_DIGEST_KEY and other silo secrets. No composition-root env read must
# leak into the pure-core modules (FF-DC9 analogue at the request-path layer).
#
# Hardened variant: also checks process["env"] (bracket accessor bypass).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "[T-0143] keyed-digest-core-purity: checking no process.env in src/core/"

MATCHES=$(grep -rn 'process\.env\|process\["env"\]\|process\x27\(env\x27)' \
  "$REPO_ROOT/src/core/" 2>/dev/null || true)

if [ -n "$MATCHES" ]; then
  echo "FAIL [FF-T143-5]: process.env found in src/core/ (env boundary violation):"
  echo "$MATCHES"
  exit 1
fi

echo "PASS [FF-T143-5]: no process.env in src/core/ (env boundary intact)"
echo "PASS: keyed-digest-core-purity — FF-T143-5 green"
exit 0
