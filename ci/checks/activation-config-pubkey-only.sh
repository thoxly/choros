#!/usr/bin/env bash
# T-0198 · FF-T127-(config) — config/activation holds ONLY the public key (review nit R-3)
#
# Rule (NF-3 / RL-1 / RL-3 secret discipline): the committed config/activation/
# directory ships ONLY the vendor PUBLIC key (vendor-pub.ed25519). The runtime
# activation.key and ANY private/secret key material are gitignored and must NEVER
# be tracked. The vendor PRIVATE signing key never enters the client circuit at all
# (key issuance is control-plane, OS-3).
#
# Checks:
#   1. config/activation/vendor-pub.ed25519 exists and is a PUBLIC key (PEM
#      'BEGIN PUBLIC KEY'); it is NOT a private key.
#   2. NO git-TRACKED file under config/activation/ other than *.ed25519 public
#      anchors (no *.key, no *private*, no *.pem private material).
#   3. .gitignore excludes config/activation/*.key.
#
# SELF-TEST (--self-test): assert the public-key sniff rejects a PRIVATE-key PEM and
# accepts a PUBLIC-key PEM. exit 0 if the demonstration holds, 2 if broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ACT_DIR="$REPO_ROOT/config/activation"
PUB="$ACT_DIR/vendor-pub.ed25519"
GITIGNORE="$REPO_ROOT/.gitignore"

echo "[T-0198] activation-config-pubkey-only: config/activation ships only the public key"

is_public_key_pem() { grep -q 'BEGIN PUBLIC KEY' "$1" 2>/dev/null; }
is_private_key_pem() { grep -qE 'BEGIN ((RSA |EC |OPENSSH )?)PRIVATE KEY' "$1" 2>/dev/null; }

# --self-test.
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0198] activation-config-pubkey-only --self-test"
  TMP_PUB="$(mktemp)"; TMP_PRIV="$(mktemp)"
  trap 'rm -f "$TMP_PUB" "$TMP_PRIV"' EXIT
  printf -- '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n' > "$TMP_PUB"
  printf -- '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' > "$TMP_PRIV"
  if ! is_public_key_pem "$TMP_PUB"; then echo "SELF-TEST FAIL: public PEM not recognised (exit 2)"; exit 2; fi
  if is_public_key_pem "$TMP_PRIV"; then echo "SELF-TEST FAIL: private PEM mis-read as public (exit 2)"; exit 2; fi
  if ! is_private_key_pem "$TMP_PRIV"; then echo "SELF-TEST FAIL: private PEM not detected (exit 2)"; exit 2; fi
  rm -f "$TMP_PUB" "$TMP_PRIV"; trap - EXIT
  echo "[T-0198] activation-config-pubkey-only self-test PASS (exit 0)"
  exit 0
fi

FAIL=0

# 1. public anchor present and genuinely public.
if [ ! -f "$PUB" ]; then
  echo "FAIL: missing $PUB (public trust anchor must ship with the image)"; FAIL=1
elif ! is_public_key_pem "$PUB"; then
  echo "FAIL: $PUB is not a PEM PUBLIC KEY"; FAIL=1
elif is_private_key_pem "$PUB"; then
  echo "FAIL: $PUB contains PRIVATE key material (must be public only)"; FAIL=1
else
  echo "PASS: vendor-pub.ed25519 is a public PEM key"
fi

# 2. no git-tracked non-public file under config/activation/.
while IFS= read -r tracked; do
  [ -z "$tracked" ] && continue
  base="$(basename "$tracked")"
  case "$base" in
    *.ed25519) : ;;  # public anchor — allowed
    *)
      echo "FAIL: unexpected git-tracked file under config/activation/: $tracked (only *.ed25519 public keys may be committed)"
      FAIL=1
      ;;
  esac
  # Any tracked file that LOOKS like private material is an immediate fail.
  if is_private_key_pem "$REPO_ROOT/$tracked" 2>/dev/null; then
    echo "FAIL: git-tracked private key material at $tracked"
    FAIL=1
  fi
done < <(git -C "$REPO_ROOT" ls-files config/activation/ 2>/dev/null || true)

# 3. .gitignore excludes runtime *.key.
if grep -Eq 'config/activation/\*\.key' "$GITIGNORE"; then
  echo "PASS: .gitignore excludes config/activation/*.key"
else
  echo "FAIL: .gitignore does not exclude config/activation/*.key"; FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: activation-config-pubkey-only — secret discipline violated"
  exit 1
fi
echo "PASS: config/activation ships only the public key; secrets gitignored"
exit 0
