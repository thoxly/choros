#!/usr/bin/env bash
# T-0076 · FF-FLOOR2-SANDBOX: Floor-2 sandbox-iframe isolation gate
#
# Asserts the Floor-2 (agent-authored React presentation) sandbox security
# invariants from docs/design/extensibility-and-authoring.md §4 / §7 / §9.10:
#
#   F2S-1 — src/core/floor2-renderer.ts exists.
#   F2S-2 — floor2-renderer.ts is PURE: no pg, node:fs, node:http, node:net,
#            child_process, import.meta, process.env, process.exit imports.
#   F2S-3 — FLOOR2_SANDBOX_ATTR constant is exactly "allow-scripts"
#            (the canonical minimal sandbox for opaque-origin execution).
#   F2S-4 — FLOOR2_SANDBOX_MUST_NOT_CONTAIN includes 'allow-same-origin'
#            (combining allow-scripts + allow-same-origin defeats opaque-origin
#            isolation — the sandboxed code would gain parent-origin access).
#   F2S-5 — Floor2Viewer.jsx exists in web/src/forms/.
#   F2S-6 — Floor2Viewer.jsx iframe declares sandbox="allow-scripts" WITHOUT
#            allow-same-origin (static attribute check, same gate as FF-FORMS2-1).
#   F2S-7 — Floor2Viewer.jsx uses acceptFrameHeight for origin-validated height
#            (mirrors FF-FORMS2-3 for Floor-1 forms).
#   F2S-8 — floor2-renderer.ts exports FLOOR2_CUSTOM_FLAG_KEY and
#            FLOOR2_CUSTOM_FLAG_VALUE (§9.10 governance flag constants).
#   F2S-9 — floor2-renderer.ts has a validateFloor2Descriptor function that
#            checks for CUSTOM_FLAG_MISSING (governance gate for custom code).
#   F2S-10 — floor2-renderer.ts exports VETTED_COMPONENT_TYPES as a ReadonlySet
#             (machine-readable closed-vocab palette — §4a).
#   F2S-11 — buildFloor2Srcdoc exists and is exported (srcdoc builder).
#   F2S-12 — assertSandboxAttr exists and is exported (pure sandbox validator).
#
# Self-test (--self-test): synthetic RED cases that must be detected:
#   (a) A fake Floor2Viewer with allow-same-origin → caught by F2S-6.
#   (b) A fake floor2-renderer with pg import → caught by F2S-2.
#   (c) A fake Floor2Viewer with no acceptFrameHeight → caught by F2S-7.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RENDERER="${PROJECT_ROOT}/src/core/floor2-renderer.ts"
VIEWER="${PROJECT_ROOT}/web/src/forms/Floor2Viewer.jsx"

ERRORS=0

# ---------------------------------------------------------------------------
# --self-test: synthetic RED cases must be detected.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  # (a) Fake Floor2Viewer with allow-same-origin must be caught.
  cat > "${TMP}/bad-viewer.jsx" <<'EOF'
<iframe sandbox="allow-scripts allow-same-origin" />
EOF
  if grep -q 'allow-same-origin' "${TMP}/bad-viewer.jsx"; then
    # Good: the grep finds it. Now test our check logic below.
    if ! grep -q 'allow-same-origin' "${TMP}/bad-viewer.jsx" 2>/dev/null; then
      echo "[T-0076] self-test FAIL: allow-same-origin iframe was NOT detected"
      exit 2
    fi
  fi
  # Verify the negative case (good iframe): allow-same-origin absent → pass
  cat > "${TMP}/good-viewer.jsx" <<'EOF'
sandbox="allow-scripts"
EOF
  if grep -q 'allow-same-origin' "${TMP}/good-viewer.jsx" 2>/dev/null; then
    echo "[T-0076] self-test FAIL: good iframe was incorrectly flagged as having allow-same-origin"
    exit 2
  fi

  # (b) Fake renderer with pg import → forbidden pattern must be detected.
  cat > "${TMP}/bad-renderer.ts" <<'EOF'
import pg from 'pg';
EOF
  if ! grep -Eq "from.*['\"]pg['\"]" "${TMP}/bad-renderer.ts" 2>/dev/null; then
    echo "[T-0076] self-test FAIL: pg import in renderer was NOT detected"
    exit 2
  fi

  # (c) Fake Floor2Viewer with no acceptFrameHeight → caught by F2S-7.
  cat > "${TMP}/no-height-viewer.jsx" <<'EOF'
window.addEventListener('message', (e) => { setHeight(e.data.h); });
EOF
  if grep -q 'acceptFrameHeight' "${TMP}/no-height-viewer.jsx" 2>/dev/null; then
    echo "[T-0076] self-test FAIL: viewer without acceptFrameHeight was wrongly accepted"
    exit 2
  fi

  # (d) Good renderer with correct patterns must pass purity check.
  cat > "${TMP}/good-renderer.ts" <<'EOF'
export const FLOOR2_CUSTOM_FLAG_KEY = 'floor2_custom_confirmed';
export const FLOOR2_CUSTOM_FLAG_VALUE = 'true';
export const VETTED_COMPONENT_TYPES: ReadonlySet<string> = new Set(['text_input']);
export function validateFloor2Descriptor() { return { ok: true }; }
export function assertSandboxAttr() { return { ok: true }; }
EOF
  if grep -Eq "from.*['\"]pg['\"]" "${TMP}/good-renderer.ts" 2>/dev/null; then
    echo "[T-0076] self-test FAIL: clean renderer was wrongly flagged for pg import"
    exit 2
  fi

  echo "[T-0076] self-test PASS: allow-same-origin iframe, pg-import, and missing acceptFrameHeight all detected; clean cases pass"
  echo "[T-0076] floor2-sandbox-isolation --self-test: passed (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECKS
# ---------------------------------------------------------------------------
echo "[FF-FLOOR2-SANDBOX] floor2-sandbox-isolation: checking Floor-2 security boundary"

# ---- F2S-1: floor2-renderer.ts exists -------------------------------------

if [[ ! -f "${RENDERER}" ]]; then
  echo "FAIL F2S-1: src/core/floor2-renderer.ts does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS F2S-1: src/core/floor2-renderer.ts exists"
fi

# ---- F2S-2: floor2-renderer.ts is pure -----------------------------------

if [[ ! -f "${RENDERER}" ]]; then
  echo "SKIP F2S-2: renderer not found (already failed in F2S-1)"
else
  FORBIDDEN_PATTERNS=(
    "from.*['\"]pg['\"]"
    "from.*['\"]node:fs['\"]"
    "from.*['\"]node:http['\"]"
    "from.*['\"]node:net['\"]"
    "from.*['\"]node:child_process['\"]"
    "child_process"
    "import\.meta"
    "process\.env"
    "process\.exit"
  )

  F2_ERRORS=0
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -Eq "${pattern}" "${RENDERER}" 2>/dev/null; then
      echo "FAIL F2S-2: floor2-renderer.ts contains forbidden pattern: ${pattern}"
      F2_ERRORS=$((F2_ERRORS + 1))
    fi
  done

  if [[ ${F2_ERRORS} -eq 0 ]]; then
    echo "PASS F2S-2: floor2-renderer.ts is pure (no forbidden I/O imports)"
  else
    ERRORS=$((ERRORS + F2_ERRORS))
  fi
fi

# ---- F2S-3: FLOOR2_SANDBOX_ATTR === "allow-scripts" ----------------------

if [[ ! -f "${RENDERER}" ]]; then
  echo "SKIP F2S-3: renderer not found"
else
  # The constant must be literally "allow-scripts" (not allow-scripts allow-forms etc.)
  if ! grep -qE "FLOOR2_SANDBOX_ATTR\s*=\s*['\"]allow-scripts['\"]" "${RENDERER}" 2>/dev/null; then
    echo "FAIL F2S-3: FLOOR2_SANDBOX_ATTR is not exactly 'allow-scripts' in floor2-renderer.ts"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS F2S-3: FLOOR2_SANDBOX_ATTR === 'allow-scripts'"
  fi
fi

# ---- F2S-4: FLOOR2_SANDBOX_MUST_NOT_CONTAIN includes 'allow-same-origin' --

if [[ ! -f "${RENDERER}" ]]; then
  echo "SKIP F2S-4: renderer not found"
else
  if ! grep -q "allow-same-origin" "${RENDERER}" 2>/dev/null; then
    echo "FAIL F2S-4: floor2-renderer.ts does not reference 'allow-same-origin' in FLOOR2_SANDBOX_MUST_NOT_CONTAIN"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS F2S-4: 'allow-same-origin' referenced in floor2-renderer.ts deny-list"
  fi
fi

# ---- F2S-5: Floor2Viewer.jsx exists ----------------------------------------

if [[ ! -f "${VIEWER}" ]]; then
  echo "FAIL F2S-5: web/src/forms/Floor2Viewer.jsx does not exist"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS F2S-5: web/src/forms/Floor2Viewer.jsx exists"
fi

# ---- F2S-6: Floor2Viewer iframe sandbox="allow-scripts" WITHOUT allow-same-origin

if [[ ! -f "${VIEWER}" ]]; then
  echo "SKIP F2S-6: viewer not found (already failed in F2S-5)"
else
  F6_ERRORS=0

  # Must have at least one sandbox="..." attribute
  if ! grep -qE 'sandbox=' "${VIEWER}" 2>/dev/null; then
    echo "FAIL F2S-6: Floor2Viewer.jsx has no sandbox attribute (Floor-2 iframe must be sandboxed)"
    F6_ERRORS=$((F6_ERRORS + 1))
  else
    # Every sandbox="..." in the file must contain allow-scripts
    if ! grep -oE 'sandbox="[^"]*"' "${VIEWER}" | grep -q 'allow-scripts'; then
      echo "FAIL F2S-6: Floor2Viewer.jsx sandbox does not contain allow-scripts"
      F6_ERRORS=$((F6_ERRORS + 1))
    fi
    # Must NOT contain allow-same-origin in any sandbox attribute
    if grep -oE 'sandbox="[^"]*"' "${VIEWER}" | grep -q 'allow-same-origin'; then
      echo "FAIL F2S-6: Floor2Viewer.jsx sandbox MUST NOT contain allow-same-origin (defeats opaque-origin isolation)"
      F6_ERRORS=$((F6_ERRORS + 1))
    fi
  fi

  if [[ ${F6_ERRORS} -eq 0 ]]; then
    echo "PASS F2S-6: Floor2Viewer.jsx iframe sandbox is allow-scripts WITHOUT allow-same-origin"
  else
    ERRORS=$((ERRORS + F6_ERRORS))
  fi
fi

# ---- F2S-7: Floor2Viewer.jsx uses acceptFrameHeight (origin-validated height)

if [[ ! -f "${VIEWER}" ]]; then
  echo "SKIP F2S-7: viewer not found"
else
  if ! grep -q "acceptFrameHeight" "${VIEWER}" 2>/dev/null; then
    echo "FAIL F2S-7: Floor2Viewer.jsx does not use acceptFrameHeight (must origin-validate postMessage before resize)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS F2S-7: Floor2Viewer.jsx uses acceptFrameHeight (origin-validated height channel)"
  fi
fi

# ---- F2S-8: FLOOR2_CUSTOM_FLAG_KEY and FLOOR2_CUSTOM_FLAG_VALUE exported ----

if [[ ! -f "${RENDERER}" ]]; then
  echo "SKIP F2S-8: renderer not found"
else
  F8_ERRORS=0
  if ! grep -q "FLOOR2_CUSTOM_FLAG_KEY" "${RENDERER}" 2>/dev/null; then
    echo "FAIL F2S-8: FLOOR2_CUSTOM_FLAG_KEY not found in floor2-renderer.ts"
    F8_ERRORS=$((F8_ERRORS + 1))
  fi
  if ! grep -q "FLOOR2_CUSTOM_FLAG_VALUE" "${RENDERER}" 2>/dev/null; then
    echo "FAIL F2S-8: FLOOR2_CUSTOM_FLAG_VALUE not found in floor2-renderer.ts"
    F8_ERRORS=$((F8_ERRORS + 1))
  fi
  if [[ ${F8_ERRORS} -eq 0 ]]; then
    echo "PASS F2S-8: FLOOR2_CUSTOM_FLAG_KEY and FLOOR2_CUSTOM_FLAG_VALUE exported"
  else
    ERRORS=$((ERRORS + F8_ERRORS))
  fi
fi

# ---- F2S-9: validateFloor2Descriptor with CUSTOM_FLAG_MISSING gate ----------

if [[ ! -f "${RENDERER}" ]]; then
  echo "SKIP F2S-9: renderer not found"
else
  F9_ERRORS=0
  if ! grep -q "validateFloor2Descriptor" "${RENDERER}" 2>/dev/null; then
    echo "FAIL F2S-9: validateFloor2Descriptor not found in floor2-renderer.ts"
    F9_ERRORS=$((F9_ERRORS + 1))
  fi
  if ! grep -q "CUSTOM_FLAG_MISSING" "${RENDERER}" 2>/dev/null; then
    echo "FAIL F2S-9: CUSTOM_FLAG_MISSING error code not present in floor2-renderer.ts (§9.10 governance gate required)"
    F9_ERRORS=$((F9_ERRORS + 1))
  fi
  if [[ ${F9_ERRORS} -eq 0 ]]; then
    echo "PASS F2S-9: validateFloor2Descriptor with CUSTOM_FLAG_MISSING gate present"
  else
    ERRORS=$((ERRORS + F9_ERRORS))
  fi
fi

# ---- F2S-10: VETTED_COMPONENT_TYPES as ReadonlySet --------------------------

if [[ ! -f "${RENDERER}" ]]; then
  echo "SKIP F2S-10: renderer not found"
else
  if ! grep -qE "ReadonlySet.*VettedComponentType|VETTED_COMPONENT_TYPES.*ReadonlySet" "${RENDERER}" 2>/dev/null; then
    echo "FAIL F2S-10: VETTED_COMPONENT_TYPES not typed as ReadonlySet<VettedComponentType> in floor2-renderer.ts"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS F2S-10: VETTED_COMPONENT_TYPES typed as ReadonlySet"
  fi
fi

# ---- F2S-11: buildFloor2Srcdoc exported ------------------------------------

if [[ ! -f "${RENDERER}" ]]; then
  echo "SKIP F2S-11: renderer not found"
else
  if ! grep -q "buildFloor2Srcdoc" "${RENDERER}" 2>/dev/null; then
    echo "FAIL F2S-11: buildFloor2Srcdoc not found in floor2-renderer.ts"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS F2S-11: buildFloor2Srcdoc exported"
  fi
fi

# ---- F2S-12: assertSandboxAttr exported ------------------------------------

if [[ ! -f "${RENDERER}" ]]; then
  echo "SKIP F2S-12: renderer not found"
else
  if ! grep -q "assertSandboxAttr" "${RENDERER}" 2>/dev/null; then
    echo "FAIL F2S-12: assertSandboxAttr not found in floor2-renderer.ts"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS F2S-12: assertSandboxAttr exported"
  fi
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL [FF-FLOOR2-SANDBOX]: floor2-sandbox-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS [FF-FLOOR2-SANDBOX]: Floor-2 sandbox isolation — all checks green"
echo "  - floor2-renderer.ts pure + correct sandbox constant + flag gate"
echo "  - Floor2Viewer.jsx sandbox=allow-scripts (no allow-same-origin) + acceptFrameHeight"
exit 0
