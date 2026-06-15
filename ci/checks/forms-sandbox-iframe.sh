#!/usr/bin/env bash
# T-0101 · FF-FORMS2 — forms sandbox-iframe isolation gate
#
# The form runtime (form-js HTML + inline script) is UNTRUSTED. It MUST execute
# inside an isolated sandbox-iframe with an OPAQUE origin
# (sandbox="allow-scripts" WITHOUT allow-same-origin), and the parent's
# auto-height postMessage receiver MUST validate the message origin/source
# before resizing — never trust a raw postMessage. This static gate asserts
# those isolation invariants cannot silently regress:
#
#   FF-FORMS2-1 — Every form-execution iframe (web/src/forms/FormViewer.jsx and
#                 BOTH iframes in web/preview/forms.html) declares a sandbox that
#                 contains `allow-scripts` and does NOT contain `allow-same-origin`.
#                 (allow-scripts + allow-same-origin together defeats the sandbox.)
#   FF-FORMS2-2 — The canonical pure receiver web/src/forms/frame-height.js (and its
#                 TS twin src/core/form-frame-height.ts) exists, validates origin
#                 (rejects anything but the opaque 'null' origin) and clamps height
#                 to an upper bound (anti-DoS).
#   FF-FORMS2-3 — Both parent message receivers (FormViewer.jsx + forms.html)
#                 origin-validate before resizing (reference `origin` + the opaque
#                 'null' origin, directly or via acceptFrameHeight).
#
# Self-test (--self-test): a synthetic iframe with allow-same-origin AND a
# synthetic receiver with no origin check are both RED.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

FORM_VIEWER="${PROJECT_ROOT}/web/src/forms/FormViewer.jsx"
PREVIEW="${PROJECT_ROOT}/web/preview/forms.html"
RECEIVER_JS="${PROJECT_ROOT}/web/src/forms/frame-height.js"
RECEIVER_TS="${PROJECT_ROOT}/src/core/form-frame-height.ts"

# ---------------------------------------------------------------------------
# Helper: assert a file has at least one sandbox="..." attribute and that EVERY
# sandbox attribute in the file contains allow-scripts and NOT allow-same-origin.
# Args: <label> <file>
# Returns 0 on pass, 1 on fail (prints reason).
# ---------------------------------------------------------------------------
check_sandbox_attrs() {
  local label="$1" file="$2"
  if [ ! -f "$file" ]; then
    echo "FAIL [FF-FORMS2-1]: ${label}: file missing: ${file}"
    return 1
  fi
  # Extract every sandbox="..." occurrence (greedy-safe: stop at the closing quote).
  local sandboxes
  sandboxes="$(grep -oE 'sandbox="[^"]*"' "$file" || true)"
  if [ -z "$sandboxes" ]; then
    echo "FAIL [FF-FORMS2-1]: ${label}: no sandbox=\"...\" attribute found (form iframe must be sandboxed)"
    return 1
  fi
  local rc=0 line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if ! echo "$line" | grep -q 'allow-scripts'; then
      echo "FAIL [FF-FORMS2-1]: ${label}: sandbox without allow-scripts: ${line}"
      rc=1
    fi
    if echo "$line" | grep -q 'allow-same-origin'; then
      echo "FAIL [FF-FORMS2-1]: ${label}: sandbox MUST NOT contain allow-same-origin (defeats opaque origin): ${line}"
      rc=1
    fi
  done <<< "$sandboxes"
  return "$rc"
}

# ---------------------------------------------------------------------------
# Helper: assert a receiver file origin-validates (references `origin` AND the
# opaque 'null' origin literal).
# Args: <label> <file>
# ---------------------------------------------------------------------------
check_origin_validated() {
  local label="$1" file="$2"
  if [ ! -f "$file" ]; then
    echo "FAIL [FF-FORMS2-3]: ${label}: file missing: ${file}"
    return 1
  fi
  local rc=0
  # The receiver must reference event origin AND the opaque 'null' origin, either
  # directly (forms.html / frame-height.js) or by delegating to acceptFrameHeight
  # (FormViewer.jsx imports it). Accept either signal.
  if grep -q 'acceptFrameHeight' "$file"; then
    return 0
  fi
  if ! grep -qE '\.origin|origin' "$file"; then
    echo "FAIL [FF-FORMS2-3]: ${label}: receiver does not reference message origin (must validate origin before resize)"
    rc=1
  fi
  if ! grep -qE "['\"]null['\"]" "$file"; then
    echo "FAIL [FF-FORMS2-3]: ${label}: receiver does not check the opaque 'null' origin"
    rc=1
  fi
  return "$rc"
}

# ---------------------------------------------------------------------------
# --self-test: synthetic RED cases.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  # (a) iframe with allow-same-origin must be caught.
  cat > "${TMP}/bad-iframe.html" <<'EOF'
  <iframe sandbox="allow-scripts allow-same-origin" title="bad"></iframe>
EOF
  if check_sandbox_attrs "self-test/bad-iframe" "${TMP}/bad-iframe.html" >/dev/null 2>&1; then
    echo "[T-0101] self-test FAIL: allow-same-origin iframe was NOT caught"
    exit 2
  fi

  # (b) a sandbox missing allow-scripts label must be caught (sanity).
  cat > "${TMP}/no-scripts.html" <<'EOF'
  <iframe sandbox="allow-forms" title="x"></iframe>
EOF
  if check_sandbox_attrs "self-test/no-scripts" "${TMP}/no-scripts.html" >/dev/null 2>&1; then
    echo "[T-0101] self-test FAIL: sandbox without allow-scripts was NOT caught"
    exit 2
  fi

  # (c) receiver with no origin check must be caught.
  cat > "${TMP}/bad-receiver.js" <<'EOF'
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'fjs-height') { resize(e.data.h); }
  });
EOF
  if check_origin_validated "self-test/bad-receiver" "${TMP}/bad-receiver.js" >/dev/null 2>&1; then
    echo "[T-0101] self-test FAIL: receiver without origin validation was NOT caught"
    exit 2
  fi

  # (d) a good iframe + good receiver must PASS.
  cat > "${TMP}/good-iframe.html" <<'EOF'
  <iframe sandbox="allow-scripts" title="ok"></iframe>
EOF
  if ! check_sandbox_attrs "self-test/good-iframe" "${TMP}/good-iframe.html" >/dev/null 2>&1; then
    echo "[T-0101] self-test FAIL: a valid allow-scripts iframe was wrongly rejected"
    exit 2
  fi
  cat > "${TMP}/good-receiver.js" <<'EOF'
  if (e.origin !== 'null') return null;
EOF
  if ! check_origin_validated "self-test/good-receiver" "${TMP}/good-receiver.js" >/dev/null 2>&1; then
    echo "[T-0101] self-test FAIL: a valid origin-validating receiver was wrongly rejected"
    exit 2
  fi

  echo "[T-0101] self-test PASS: allow-same-origin iframe, sandbox-without-scripts, and origin-blind receiver are all detected (RED as expected); valid cases pass"
  echo "[T-0101] forms-sandbox-iframe --self-test: passed (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK
# ---------------------------------------------------------------------------
FAIL=0

# FF-FORMS2-1 — every form iframe is allow-scripts WITHOUT allow-same-origin.
check_sandbox_attrs "FormViewer.jsx" "$FORM_VIEWER" || FAIL=1
check_sandbox_attrs "forms.html (preview)" "$PREVIEW" || FAIL=1

# FF-FORMS2-2 — canonical pure receiver exists, validates origin, clamps height.
for f in "$RECEIVER_JS" "$RECEIVER_TS"; do
  if [ ! -f "$f" ]; then
    echo "FAIL [FF-FORMS2-2]: pure receiver missing: $f"
    FAIL=1
    continue
  fi
  if ! grep -qE "['\"]null['\"]" "$f"; then
    echo "FAIL [FF-FORMS2-2]: $(basename "$f") does not reject non-opaque origin (no 'null' origin check)"
    FAIL=1
  fi
  if ! grep -q 'FRAME_MAX_HEIGHT' "$f"; then
    echo "FAIL [FF-FORMS2-2]: $(basename "$f") does not clamp to an upper bound (FRAME_MAX_HEIGHT missing — anti-DoS)"
    FAIL=1
  fi
done

# FF-FORMS2-3 — both parent receivers origin-validate before resize.
check_origin_validated "FormViewer.jsx" "$FORM_VIEWER" || FAIL=1
check_origin_validated "forms.html (preview)" "$PREVIEW" || FAIL=1

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: forms-sandbox-iframe — form iframe isolation or origin-validated auto-height regressed"
  exit 1
fi

echo "PASS [FF-FORMS2]: every form iframe is sandbox=allow-scripts WITHOUT allow-same-origin (opaque origin); auto-height receiver origin-validated and height-clamped"
exit 0
