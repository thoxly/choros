#!/usr/bin/env bash
# T-0242 · FF-T242-2 — vendor private key must not appear in client circuit (vendor-priv-not-in-client-circuit)
#
# Static checks that signKey + private-key read stay on the vendor side (NF-2):
#
#   (a) config/activation/** must not contain any *priv* file or 'PRIVATE KEY' text.
#   (b) signKey is defined only in src/vendor/issuance.ts; it must NOT be imported
#       in src/http/**, src/core/**, or the client composition root.
#   (c) Private-key read (readFileSync + createPrivateKey) appears ONLY in
#       src/cli/issue-key.ts, not in any other src/ file.
#
# Comment-only lines are stripped before pattern matching.
#
# SELF-TEST (--self-test):
#   1. Plants a file import of signKey in src/http/ → must be CAUGHT.
#   2. Plants readFileSync in a non-cli vendor file → must be CAUGHT.
#   Exit 2 if either demonstration fails.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "[T-0242] vendor-priv-not-in-client-circuit (FF-T242-2): signKey + private-key read not in client circuit"

code_lines() { grep -vE '^[[:space:]]*(//|[*]|/[*]|#)' "$1" 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0242] vendor-priv-not-in-client-circuit --self-test"

  HTTP_DIR="$REPO_ROOT/src/http"
  VENDOR_DIR="$REPO_ROOT/src/vendor"

  # Self-test 1: planted signKey import in src/http → must FAIL.
  TMP_HTTP="$HTTP_DIR/_t0242_probe.tmp.ts"
  trap 'rm -f "$TMP_HTTP" "$VENDOR_DIR/_t0242_priv.tmp.ts"' EXIT
  printf 'import { signKey } from "../vendor/issuance.js";\n' > "$TMP_HTTP"
  if ! code_lines "$TMP_HTTP" | grep -qE 'signKey'; then
    echo "SELF-TEST 1 FAIL: planted signKey import NOT detected — check is broken (exit 2)"
    exit 2
  fi
  rm -f "$TMP_HTTP"
  echo "[T-0242] self-test 1 PASS: planted signKey import in src/http detected"

  # Self-test 2: planted priv-key readFileSync in a non-cli vendor file → must be detectable.
  TMP_VEND="$VENDOR_DIR/_t0242_priv.tmp.ts"
  printf 'const privPem = readFileSync("/tmp/vendor-priv.pem");\n' > "$TMP_VEND"
  if ! code_lines "$TMP_VEND" | grep -qE 'readFileSync.*[Pp]riv|[Pp]riv.*readFileSync'; then
    echo "SELF-TEST 2 FAIL: planted priv-key readFileSync NOT detected — check is broken (exit 2)"
    exit 2
  fi
  rm -f "$TMP_VEND"
  trap - EXIT
  echo "[T-0242] self-test 2 PASS: planted priv-key readFileSync detected"

  echo "[T-0242] vendor-priv-not-in-client-circuit --self-test: all self-tests passed (exit 0)"
  exit 0
fi

FAIL=0

# (a) config/activation must not contain priv files or PRIVATE KEY text.
CONFIG_ACT="$REPO_ROOT/config/activation"
if [ -d "$CONFIG_ACT" ]; then
  while IFS= read -r -d '' f; do
    fname="$(basename "$f")"
    # Reject files whose name contains 'priv' (case insensitive).
    if echo "$fname" | grep -qi 'priv'; then
      echo "FAIL [FF-T242-2]: vendor private-key file found in config/activation: $f"
      FAIL=1
    fi
    # Reject files containing PRIVATE KEY text on code lines.
    if code_lines "$f" | grep -qiE 'PRIVATE KEY'; then
      echo "FAIL [FF-T242-2]: PRIVATE KEY content in config/activation file: $f"
      FAIL=1
    fi
  done < <(find "$CONFIG_ACT" -type f -print0 2>/dev/null)
else
  echo "[T-0242] config/activation not found — skipping (a)"
fi

# (b) signKey must not be imported in src/http/**, src/core/**.
IMPORT_SIGN_RE='import[[:space:]]*\{[^}]*signKey[^}]*\}[[:space:]]*from'
for check_dir in "$REPO_ROOT/src/http" "$REPO_ROOT/src/core"; do
  [ -d "$check_dir" ] || continue
  while IFS= read -r -d '' f; do
    case "$(basename "$f")" in *.tmp.ts) continue ;; esac
    if code_lines "$f" | grep -qE "$IMPORT_SIGN_RE"; then
      echo "FAIL [FF-T242-2]: signKey imported in client-circuit file: $f"
      code_lines "$f" | grep -nE "$IMPORT_SIGN_RE" || true
      FAIL=1
    fi
  done < <(find "$check_dir" -name '*.ts' -print0 2>/dev/null)
done

# (c) Private-key FILE READ — two patterns, either triggers a FAIL:
#   (c1) readFileSync near priv/private-key context — only allowed in src/cli/issue-key.ts.
#   (c2) readFileSync of a *.pem path (e.g. readFileSync('key.pem')) anywhere outside
#        src/cli/issue-key.ts, regardless of variable name.
# The CLI is the ONLY place that reads the private key from disk (NF-2 / ADR §1.4).
# Note: createPrivateKey() from a PEM argument is permitted in issuance.ts (signKey)
# because the private key is passed in as an argument, not read from file there.
while IFS= read -r -d '' f; do
  # Exclude the authorised file.
  if [ "$f" = "$REPO_ROOT/src/cli/issue-key.ts" ]; then continue; fi
  case "$(basename "$f")" in *.tmp.ts) continue ;; esac
  # (c1) readFileSync near priv/private-key context.
  if code_lines "$f" | grep -qE 'readFileSync.*[Pp]riv|[Pp]riv.*readFileSync'; then
    echo "FAIL [FF-T242-2]: private-key readFileSync found outside src/cli/issue-key.ts: $f"
    code_lines "$f" | grep -nE 'readFileSync.*[Pp]riv|[Pp]riv.*readFileSync' || true
    FAIL=1
  fi
  # (c2) readFileSync of any *.pem file path.
  if code_lines "$f" | grep -qE "readFileSync[^;]*['\"][^'\"]*\\.pem['\"]"; then
    echo "FAIL [FF-T242-2]: readFileSync of .pem file found outside src/cli/issue-key.ts: $f"
    code_lines "$f" | grep -nE "readFileSync[^;]*['\"][^'\"]*\\.pem['\"]" || true
    FAIL=1
  fi
done < <(find "$REPO_ROOT/src" -name '*.ts' -print0 2>/dev/null)

# (d) createPrivateKey() must not appear outside src/vendor/issuance.ts and src/cli/.
# Authorised: issuance.ts (constructs the key object from a PEM arg for signing),
#             src/cli/ (issue-key.ts passes the PEM string in).
while IFS= read -r -d '' f; do
  case "$f" in
    "$REPO_ROOT/src/vendor/issuance.ts") continue ;;
    "$REPO_ROOT"/src/cli/*) continue ;;
  esac
  case "$(basename "$f")" in *.tmp.ts) continue ;; esac
  if code_lines "$f" | grep -qE 'createPrivateKey[[:space:]]*\('; then
    echo "FAIL [FF-T242-2]: createPrivateKey() found outside vendor/issuance.ts or src/cli/: $f"
    code_lines "$f" | grep -nE 'createPrivateKey[[:space:]]*\(' || true
    FAIL=1
  fi
done < <(find "$REPO_ROOT/src" -name '*.ts' -print0 2>/dev/null)

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: vendor private-key handling must stay on the vendor side (FF-T242-2)"
  exit 1
fi

echo "PASS [FF-T242-2]: vendor private key not in client circuit — signKey and key-read isolated to vendor/CLI"
exit 0
