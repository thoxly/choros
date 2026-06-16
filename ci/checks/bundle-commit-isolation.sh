#!/usr/bin/env bash
# T-0083 · E12.2 — bundle-commit-isolation: content-addressing + hash-seam purity.
#
# Fitness invariants (one per breakable boundary):
#
#   FF-BC-1  Content-addressing determinism: src/core/bundle-commit.ts exports
#            `makeCommit` + `canonicalCommitPreimage` (the deterministic preimage
#            builder); the hash function is injected via BundleHashPort, not called
#            directly inside the pure core.
#
#   FF-BC-2  Hash-seam purity (no node:crypto in pure core):
#            src/core/bundle-commit.ts must NOT import node:crypto or crypto.
#            The SHA-256 adapter lives in src/core/bundle-commit-store.ts
#            (the impure adapter layer, same pattern as keyed-digest.ts / T-0118).
#
#   FF-BC-3  No git binary dependency: neither bundle-commit.ts nor
#            bundle-commit-store.ts import 'child_process', spawn, exec, or the
#            'git' binary — this is "git-LIKE" content-addressing, not git itself.
#
#   FF-BC-4  No second versioning authority: bundle-commit.ts does NOT import from
#            any external version-control library (simple-git, isomorphic-git, etc.)
#            and does NOT read process.env on code lines (env boundary = adapter
#            layer / composition root only).
#
#   FF-BC-5  Semantic changelog exposed, not raw hashes: deriveSemanticChangelog
#            exists in bundle-commit.ts and returns SemanticChange[] — the outward
#            surface is a typed diff, not raw hash strings.
#
#   FF-BC-6  BundleHashPort injected — the pure core calls the port; the SHA-256
#            implementation (`makeSha256Port`) lives in bundle-commit-store.ts.
#
#   FF-BC-7  Migration slot correct: migrations/069_bundle_commit.sql exists and
#            creates both `bundle_commit` and `bundle_ref` tables (not 068 or lower).
#
# EXIT CODES:
#   0 — all checks green
#   1 — one or more violations found
#   2 — self-test broken (check itself is broken)
#
# USAGE:
#   bash bundle-commit-isolation.sh           # normal CI run
#   bash bundle-commit-isolation.sh --self-test

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CORE="${ROOT}/src/core/bundle-commit.ts"
STORE="${ROOT}/src/core/bundle-commit-store.ts"
MIGRATION="${ROOT}/migrations/069_bundle_commit.sql"

ERRORS=0

# ---------------------------------------------------------------------------
# --self-test mode
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[bundle-commit-isolation] self-test mode"

  # ST-1: crypto import detection
  TMP_CRYPTO=$(mktemp /tmp/bc_selftest_XXXXX.ts)
  printf 'import { createHash } from "node:crypto";\n' > "${TMP_CRYPTO}"
  if grep -qE 'from "node:crypto"|from '"'"'node:crypto'"'"'|from "crypto"|from '"'"'crypto'"'"'' "${TMP_CRYPTO}"; then
    echo "PASS self-test ST-1: crypto import detection works"
  else
    echo "FAIL self-test ST-1: crypto import NOT detected (exit 2)"
    rm -f "${TMP_CRYPTO}"
    exit 2
  fi
  rm -f "${TMP_CRYPTO}"

  # ST-2: git dependency detection
  TMP_GIT=$(mktemp /tmp/bc_selftest_XXXXX.ts)
  printf 'import { execSync } from "child_process"; execSync("git log");\n' > "${TMP_GIT}"
  if grep -qE 'child_process|execSync|spawnSync|\bgit\b' "${TMP_GIT}"; then
    echo "PASS self-test ST-2: git binary reference detection works"
  else
    echo "FAIL self-test ST-2: git binary reference NOT detected (exit 2)"
    rm -f "${TMP_GIT}"
    exit 2
  fi
  rm -f "${TMP_GIT}"

  # ST-3: BundleHashPort detection
  TMP_PORT=$(mktemp /tmp/bc_selftest_XXXXX.ts)
  printf 'export interface BundleHashPort { hash(data: Buffer): string; }\n' > "${TMP_PORT}"
  if grep -qE 'BundleHashPort' "${TMP_PORT}"; then
    echo "PASS self-test ST-3: BundleHashPort detection works"
  else
    echo "FAIL self-test ST-3: BundleHashPort NOT detected (exit 2)"
    rm -f "${TMP_PORT}"
    exit 2
  fi
  rm -f "${TMP_PORT}"

  echo "PASS: bundle-commit-isolation self-tests all green"
  exit 0
fi

echo "[T-0083] bundle-commit-isolation: content-addressing + hash-seam purity checks"

# ---------------------------------------------------------------------------
# FF-BC-1: Pure core exports makeCommit + canonicalCommitPreimage
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-BC-1: pure core exports makeCommit + canonicalCommitPreimage ---"

if [[ ! -f "${CORE}" ]]; then
  echo "FAIL FF-BC-1: ${CORE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  if grep -qE "export function makeCommit" "${CORE}"; then
    echo "PASS FF-BC-1a: makeCommit exported"
  else
    echo "FAIL FF-BC-1a: makeCommit not found in ${CORE}"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "export function canonicalCommitPreimage" "${CORE}"; then
    echo "PASS FF-BC-1b: canonicalCommitPreimage exported"
  else
    echo "FAIL FF-BC-1b: canonicalCommitPreimage not found in ${CORE}"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "export function deriveSemanticChangelog" "${CORE}"; then
    echo "PASS FF-BC-1c: deriveSemanticChangelog exported"
  else
    echo "FAIL FF-BC-1c: deriveSemanticChangelog not found in ${CORE}"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# FF-BC-2: No node:crypto in pure core
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-BC-2: no node:crypto in pure core (bundle-commit.ts) ---"

if [[ ! -f "${CORE}" ]]; then
  echo "SKIP FF-BC-2: core file not found (already failed FF-BC-1)"
else
  # Strip comment-only lines, then check for crypto imports
  set +e
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${CORE}")
  STRIP_EXIT=$?
  set -e

  CRYPTO_MATCH=""
  if [[ "${STRIP_EXIT}" -lt 2 ]] && [[ -n "${CODE_LINES}" ]]; then
    CRYPTO_MATCH=$(echo "${CODE_LINES}" | grep -E 'from "node:crypto"|from '"'"'node:crypto'"'"'|from "crypto"|from '"'"'crypto'"'"'' 2>/dev/null) || true
  fi

  if [[ -n "${CRYPTO_MATCH}" ]]; then
    echo "FAIL FF-BC-2: node:crypto imported in pure core (boundary violation):"
    echo "${CRYPTO_MATCH}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-BC-2: no node:crypto in bundle-commit.ts (pure core boundary intact)"
  fi
fi

# FF-BC-2b: The SHA-256 impl MUST be in bundle-commit-store.ts (the adapter)
if [[ ! -f "${STORE}" ]]; then
  echo "FAIL FF-BC-2b: ${STORE} does not exist"
  ERRORS=$((ERRORS + 1))
else
  if grep -qE 'from "node:crypto"|from '"'"'node:crypto'"'"'' "${STORE}"; then
    echo "PASS FF-BC-2b: node:crypto is imported in adapter (bundle-commit-store.ts) — correct seam"
  else
    echo "FAIL FF-BC-2b: node:crypto NOT found in bundle-commit-store.ts (SHA-256 adapter missing?)"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# FF-BC-3: No git binary dependency
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-BC-3: no git binary dependency in bundle-commit modules ---"

for TARGET in "${CORE}" "${STORE}"; do
  if [[ ! -f "${TARGET}" ]]; then continue; fi
  # Strip comments, check for child_process or git invocation
  set +e
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${TARGET}")
  STRIP_EXIT=$?
  set -e

  GIT_MATCH=""
  if [[ "${STRIP_EXIT}" -lt 2 ]] && [[ -n "${CODE_LINES}" ]]; then
    GIT_MATCH=$(echo "${CODE_LINES}" | grep -E 'child_process|execSync|spawnSync|simple-git|isomorphic-git' 2>/dev/null) || true
  fi

  if [[ -n "${GIT_MATCH}" ]]; then
    echo "FAIL FF-BC-3: git binary or child_process found in ${TARGET}:"
    echo "${GIT_MATCH}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-BC-3: no git binary dependency in $(basename "${TARGET}")"
  fi
done

# ---------------------------------------------------------------------------
# FF-BC-4: No process.env in pure core
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-BC-4: no process.env in pure core (bundle-commit.ts) ---"

if [[ -f "${CORE}" ]]; then
  set +e
  CODE_LINES=$(grep -vE '^[[:space:]]*(//|[*]|/[*])' "${CORE}")
  STRIP_EXIT=$?
  set -e

  ENV_MATCH=""
  if [[ "${STRIP_EXIT}" -lt 2 ]] && [[ -n "${CODE_LINES}" ]]; then
    ENV_MATCH=$(echo "${CODE_LINES}" | grep -E 'process\.env' 2>/dev/null) || true
  fi

  if [[ -n "${ENV_MATCH}" ]]; then
    echo "FAIL FF-BC-4: process.env found on code line in pure core:"
    echo "${ENV_MATCH}"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS FF-BC-4: no process.env in bundle-commit.ts"
  fi
fi

# ---------------------------------------------------------------------------
# FF-BC-5: SemanticChange + deriveSemanticChangelog exists in core
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-BC-5: SemanticChange + deriveSemanticChangelog in pure core ---"

if [[ -f "${CORE}" ]]; then
  if grep -qE "export interface SemanticChange" "${CORE}"; then
    echo "PASS FF-BC-5a: SemanticChange interface exported"
  else
    echo "FAIL FF-BC-5a: SemanticChange interface not found in core"
    ERRORS=$((ERRORS + 1))
  fi

  # Verify changelog does NOT serialize raw hashes (the output must be SemanticChange[])
  # Check that deriveSemanticChangelog's return annotation is SemanticChange[]
  if grep -qE "deriveSemanticChangelog.*SemanticChange\[\]|SemanticChange\[\].*deriveSemanticChangelog" "${CORE}"; then
    echo "PASS FF-BC-5b: deriveSemanticChangelog returns SemanticChange[] (typed semantic diff)"
  else
    echo "FAIL FF-BC-5b: deriveSemanticChangelog does not declare SemanticChange[] return type"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# FF-BC-6: BundleHashPort is the injected seam (pure core never calls createHash)
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-BC-6: BundleHashPort injected (hash seam in place) ---"

if [[ -f "${CORE}" ]]; then
  if grep -qE "export interface BundleHashPort" "${CORE}"; then
    echo "PASS FF-BC-6a: BundleHashPort interface exported from pure core"
  else
    echo "FAIL FF-BC-6a: BundleHashPort not found in bundle-commit.ts"
    ERRORS=$((ERRORS + 1))
  fi
fi

if [[ -f "${STORE}" ]]; then
  if grep -qE "export function makeSha256Port" "${STORE}"; then
    echo "PASS FF-BC-6b: makeSha256Port factory exported from adapter"
  else
    echo "FAIL FF-BC-6b: makeSha256Port not found in bundle-commit-store.ts"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# FF-BC-7: Migration 069_bundle_commit.sql exists with correct tables
# ---------------------------------------------------------------------------
echo ""
echo "--- FF-BC-7: migration 069_bundle_commit.sql correctness ---"

if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL FF-BC-7: ${MIGRATION} does not exist"
  ERRORS=$((ERRORS + 1))
else
  if grep -qE "CREATE TABLE IF NOT EXISTS choros\.bundle_commit" "${MIGRATION}"; then
    echo "PASS FF-BC-7a: bundle_commit table created in migration 069"
  else
    echo "FAIL FF-BC-7a: bundle_commit CREATE TABLE not found in migration 069"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "CREATE TABLE IF NOT EXISTS choros\.bundle_ref" "${MIGRATION}"; then
    echo "PASS FF-BC-7b: bundle_ref table created in migration 069"
  else
    echo "FAIL FF-BC-7b: bundle_ref CREATE TABLE not found in migration 069"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "FORCE[[:space:]]+ROW LEVEL SECURITY" "${MIGRATION}"; then
    echo "PASS FF-BC-7c: FORCE ROW LEVEL SECURITY present in migration 069"
  else
    echo "FAIL FF-BC-7c: FORCE ROW LEVEL SECURITY missing from migration 069"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "GRANT SELECT, INSERT, UPDATE, DELETE ON choros\.bundle_commit TO choros_app" "${MIGRATION}"; then
    echo "PASS FF-BC-7d: choros_app GRANT on bundle_commit present"
  else
    echo "FAIL FF-BC-7d: choros_app GRANT on bundle_commit missing"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -qE "GRANT SELECT, INSERT, UPDATE, DELETE ON choros\.bundle_ref TO choros_app" "${MIGRATION}"; then
    echo "PASS FF-BC-7e: choros_app GRANT on bundle_ref present"
  else
    echo "FAIL FF-BC-7e: choros_app GRANT on bundle_ref missing"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: bundle-commit-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: bundle-commit-isolation — all FF-BC-1..FF-BC-7 green (T-0083)"
exit 0
