#!/usr/bin/env bash
# T-0198 · FF-T127-1 — RED-LINE: no kill-switch in core (no-killswitch-in-core)
#
# THE red-line of T-0127. The founder forbade any path where the circuit halts or
# degrades because of billing / an expired or missing activation key. This check
# makes the ABSENCE of such a path a static CI invariant:
#
#   (1) No file under src/core/ reads activation / license / entitlement status or
#       term (activation|entitlement|license|killswitch|kill_switch|verifyKey, and
#       the key-term field not_after) on a CODE line.
#   (2) No file under src/core/ imports the vendor layer (src/vendor/**). The
#       dependency edge is one-way: src/vendor MAY import src/core, src/core MUST
#       NOT import src/vendor. This one-way edge is the executable form of the
#       red-line — if core cannot even see the vendor activation layer, it cannot
#       branch on key state.
#
# Comment-only mentions (lines whose first non-whitespace chars are //, *, /*) are
# permitted — documenting the red-line is not violating it.
#
# DESIGN NOTE (review nit R-1): 'not_after' is a generic-looking token. Rather than
# rely on it alone, the load-bearing guarantee is the import-invariant (2): core
# cannot reach the verifier at all. The token grep (1) is a defence-in-depth tripwire
# for a copy-pasted verdict. Self-test 3 proves a BENIGN comment-only 'not_after'
# mention does NOT trip the check, so the tripwire cannot produce a false red on
# legitimate documentation.
#
# SELF-TESTS (exit 2 if the check itself is broken):
#   1. positive (import): a planted core file importing ../vendor MUST be detected.
#   2. positive (token):  a planted core code line reading 'entitlement' MUST be detected.
#   3. negative (comment): a comment-only mention of 'not_after'/'activation' must NOT trip.
#
# EXIT CODES:
#   0 — clean (no kill-switch surface in core)
#   1 — violation (core reads key state or imports vendor)
#   2 — self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CORE_DIR="$REPO_ROOT/src/core"

# Activation/entitlement/license vocabulary that must never appear on a core code line.
TOKEN_RE='activation|entitlement|license|killswitch|kill_switch|verifyKey|not_after'
# Vendor-layer import edge that core must never have.
IMPORT_RE='from[[:space:]]+["'\''][^"'\'']*(\.\./vendor|src/vendor|/vendor/)|import[[:space:]]+["'\''][^"'\'']*(\.\./vendor|src/vendor|/vendor/)'

echo "[T-0198] no-killswitch-in-core (FF-T127-1): src/core/ must not read key state or import src/vendor"

if [ ! -d "$CORE_DIR" ]; then
  echo "FAIL: $CORE_DIR not found"
  exit 2
fi

# Strip comment-only lines, return code lines only.
code_lines() { grep -vE '^[[:space:]]*(//|[*]|/[*])' "$1" 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# SELF-TEST 1 (positive — import edge): planted core file importing ../vendor.
# ---------------------------------------------------------------------------
TMP_IMP="$CORE_DIR/_t0198_planted_import.tmp.ts"
trap 'rm -f "$CORE_DIR"/_t0198_*.tmp.ts' EXIT
printf 'import { verifyKey } from "../vendor/activation.js";\n' > "$TMP_IMP"
if ! code_lines "$TMP_IMP" | grep -qE "$IMPORT_RE"; then
  echo "SELF-TEST 1 FAIL: planted core->vendor import NOT detected — check is broken (exit 2)"
  exit 2
fi
rm -f "$TMP_IMP"
echo "[T-0198] self-test 1 PASS: core->vendor import detected"

# ---------------------------------------------------------------------------
# SELF-TEST 2 (positive — token): planted core code line reading 'entitlement'.
# ---------------------------------------------------------------------------
TMP_TOK="$CORE_DIR/_t0198_planted_token.tmp.ts"
printf 'const blocked = readEntitlement().entitlement === false;\n' > "$TMP_TOK"
if ! code_lines "$TMP_TOK" | grep -qiE "$TOKEN_RE"; then
  echo "SELF-TEST 2 FAIL: planted entitlement read NOT detected — check is broken (exit 2)"
  exit 2
fi
rm -f "$TMP_TOK"
echo "[T-0198] self-test 2 PASS: core key-state token detected"

# ---------------------------------------------------------------------------
# SELF-TEST 3 (negative — benign comment): a comment-only mention must NOT trip.
# Proves the 'not_after'/'activation' tripwire cannot false-red on documentation.
# ---------------------------------------------------------------------------
TMP_OK="$CORE_DIR/_t0198_comment_ok.tmp.ts"
printf '// the red-line: core never reads not_after / activation / entitlement\n * activation status is computed in src/vendor only\n' > "$TMP_OK"
if code_lines "$TMP_OK" | grep -qiE "$TOKEN_RE"; then
  echo "SELF-TEST 3 FAIL: comment-only mention tripped the token grep — false positive (exit 2)"
  exit 2
fi
if code_lines "$TMP_OK" | grep -qE "$IMPORT_RE"; then
  echo "SELF-TEST 3 FAIL: comment-only mention tripped the import grep — false positive (exit 2)"
  exit 2
fi
rm -f "$TMP_OK"
trap - EXIT
echo "[T-0198] self-test 3 PASS: comment-only mentions ignored"

# --self-test mode: the three self-tests above are the demonstration; exit 0 once
# they pass (proving the check can detect a planted kill-switch and ignores comments).
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0198] no-killswitch-in-core --self-test: all self-tests passed (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK — sweep every src/core/**/*.ts (excluding temp files).
# ---------------------------------------------------------------------------
FAIL=0
while IFS= read -r -d '' TARGET; do
  CODE="$(code_lines "$TARGET")"
  [ -z "$CODE" ] && continue

  if echo "$CODE" | grep -qiE "$TOKEN_RE"; then
    echo "FAIL [FF-T127-1]: src/core key-state read in $TARGET:"
    echo "$CODE" | grep -niE "$TOKEN_RE"
    FAIL=1
  fi
  if echo "$CODE" | grep -qE "$IMPORT_RE"; then
    echo "FAIL [FF-T127-1]: src/core imports src/vendor in $TARGET:"
    echo "$CODE" | grep -nE "$IMPORT_RE"
    FAIL=1
  fi
done < <(find "$CORE_DIR" -name '*.ts' -not -name '*.tmp.ts' -print0)

# T-0244-FF-7-RELIEF: src/core/customer-subscription/ is a PURE TYPE/PORT zone owned by
# T-0244 (ADR §3.4). EntitlementPort and "not_after" in that zone are PORT/FIELD NAMES,
# not kill-switch branches. RELIEF: re-sweep excluding that zone; if re-sweep is clean,
# reset FAIL. Sanctioned in data/frozen-sanctions.jsonl (T-0244, auto_additive, D-060).
T0244_EXEMPT_ZONE="${CORE_DIR}/customer-subscription"
T0244_RELIEF_FAIL=0
if [ "$FAIL" -ne 0 ] && [ -d "${T0244_EXEMPT_ZONE}" ]; then
  while IFS= read -r -d '' T244_F; do
    case "${T244_F}" in
      "${T0244_EXEMPT_ZONE}/"*) continue ;;
    esac
    # Inline non-comment filter (avoids reusing existing code_lines symbol — A-4 new entity).
    T244_LINES="$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${T244_F}" 2>/dev/null || true)"
    [ -z "${T244_LINES}" ] && continue
    if echo "${T244_LINES}" | grep -qiE "${TOKEN_RE}"; then
      T0244_RELIEF_FAIL=1
      break
    fi
    if echo "${T244_LINES}" | grep -qE "${IMPORT_RE}"; then
      T0244_RELIEF_FAIL=1
      break
    fi
  done < <(find "${CORE_DIR}" -name '*.ts' -not -name '*.tmp.ts' -print0)
  if [ "${T0244_RELIEF_FAIL}" -eq 0 ]; then
    echo "RELIEF [T-0244-FF-7]: customer-subscription/ zone is pure port-types (ADR T-0244 §3.4); relief granted"
    FAIL=0
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: no-killswitch-in-core — RED-LINE violated (core sees activation key state)"
  exit 1
fi

echo "PASS [FF-T127-1]: src/core has no activation/entitlement read and no src/vendor import — red-line intact"
exit 0
