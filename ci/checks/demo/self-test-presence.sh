#!/usr/bin/env bash
# T-0141 · FF-SELFTEST-8 — each FF smoke script must contain a SELF-TEST marker
#
# Greps each ci/checks/demo/*.sh script (except this one) for the
# "# SELF-TEST:" comment marker. Any file missing the marker fails.
#
# SELF-TEST: verifies this check detects a script without the marker.
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THIS_SCRIPT="$(basename "${BASH_SOURCE[0]}")"

FAIL=0
for SH in "$DEMO_DIR"/*.sh; do
  BASENAME="$(basename "$SH")"
  [[ "$BASENAME" == "$THIS_SCRIPT" ]] && continue  # skip self

  if ! grep -q "# SELF-TEST:" "$SH"; then
    echo "FAIL FF-SELFTEST-8: $BASENAME is missing '# SELF-TEST:' marker" >&2
    FAIL=1
  else
    echo "PASS: $BASENAME has SELF-TEST marker"
  fi
done

if [[ $FAIL -eq 1 ]]; then
  echo "FAIL FF-SELFTEST-8: one or more demo checks missing SELF-TEST marker" >&2
  exit 1
fi

# SELF-TEST: verify a temp script WITHOUT the marker fails detection
# SELF-TEST: also verify a temp script WITH the marker passes
TMPDIR_SELF=$(mktemp -d /tmp/ff-selftest8-XXXXXX)
trap 'rm -rf "$TMPDIR_SELF"' EXIT

# File without marker — should be detected as missing
echo '#!/usr/bin/env bash' > "$TMPDIR_SELF/no-marker.sh"
if grep -q "# SELF-TEST:" "$TMPDIR_SELF/no-marker.sh"; then
  echo "FAIL FF-SELFTEST-8: self-test broken — no-marker file matched" >&2
  exit 1
fi

# File with marker — should pass
echo '#!/usr/bin/env bash' > "$TMPDIR_SELF/with-marker.sh"
echo '# SELF-TEST: intentional check' >> "$TMPDIR_SELF/with-marker.sh"
if ! grep -q "# SELF-TEST:" "$TMPDIR_SELF/with-marker.sh"; then
  echo "FAIL FF-SELFTEST-8: self-test broken — with-marker file not matched" >&2
  exit 1
fi

echo "SELF-TEST PASS: marker detection logic verified"
echo "FF-SELFTEST-8: self-test-presence PASS"
