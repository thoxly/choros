#!/usr/bin/env bash
# T-0043 · FF-8 / FF-9 / FF-10 / FF-12: mcp-tool-registry-isolation
#
# Static assertions (grep / git-diff — no runtime, no DB) over
# src/core/mcp-tool-registry.ts and the frozen public surfaces.
#
#  MCP-ISO1 — Pure module: no pg/fs/net/http/node built-in IO import in
#             mcp-tool-registry.ts (FF-8 / AC-14). All storage access is behind
#             injected McpToolSource/GrantSource ports.
#
#  MCP-ISO2 — No re-declared T-0034/T-0018 types: mcp-tool-registry.ts does NOT
#             contain 'type EffectKind', 'interface EffectDeclaration',
#             'type ResourceType', or 'type Operation' local declarations (FF-9 / AC-17).
#             It re-uses these via imports from ./effect-resource.js and ./grant-lattice.js.
#
#  MCP-ISO3 — Frozen public surfaces unchanged: grant-lattice.ts, object-handle.ts,
#             effect-resource.ts, and types.ts are byte-identical to their dev-branch
#             baseline (FF-10 / AC-15). grant-resolver.ts is also byte-unchanged
#             (ADR §2.3: no resolver edit is the most proportionate choice).
#
#  MCP-ISO4 — No per-agent tool list: no file in migrations/ or src/ contains the
#             tokens agent_tool, agent_tools, or tool_list (FF-12 / AC-23 / NF-6).
#             The toolset is always computed, never stored.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/mcp-tool-registry.ts"
ERRORS=0

echo "[T-0043] mcp-tool-registry-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi

# ---- MCP-ISO1: no forbidden pg/fs/net/http/node built-in imports -----------
FORBIDDEN_IMPORT_PATTERNS=(
  "from.*['\"]pg['\"]"
  "from.*['\"]fs['\"]"
  "from.*['\"]net['\"]"
  "from.*['\"]http['\"]"
  "from.*['\"]node:"
  "require.*['\"](pg|fs|net|http|node:)"
)

before=${ERRORS}
for pattern in "${FORBIDDEN_IMPORT_PATTERNS[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL [MCP-ISO1]: mcp-tool-registry.ts contains a forbidden import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [MCP-ISO1]: no pg/fs/net/http/node imports (all IO via McpToolSource/GrantSource ports)"
fi

# ---- MCP-ISO2: no re-declared T-0034/T-0018 types --------------------------
# These type DECLARATIONS must NOT appear in the module (AC-17: re-use, never re-declare).
# We check for `export type Foo =` or `export interface Foo` patterns — lines that
# would declare new type aliases. Import lines (`type Foo,` or `type Foo }`) are fine.
RE_DECLARED_PATTERNS=(
  "(export\s+)?type\s+EffectKind\s*="
  "(export\s+)?interface\s+EffectDeclaration\s*[{<]"
  "(export\s+)?type\s+ResourceType\s*="
  "(export\s+)?type\s+Operation\s*="
)

before=${ERRORS}
for pattern in "${RE_DECLARED_PATTERNS[@]}"; do
  # Exclude comment lines (// ... or * ...) to avoid false positives from prose.
  matches=$(grep -nE "${pattern}" "${MODULE}" | grep -vE ":[[:space:]]*(//|\*)" || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL [MCP-ISO2]: mcp-tool-registry.ts re-declares a frozen T-0034/T-0018 type (pattern: ${pattern}):"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [MCP-ISO2]: no re-declared T-0034/T-0018 types (imports only, AC-17)"
fi

# ---- MCP-ISO3: frozen public surfaces byte-unchanged -----------------------
# Check that the dev-branch baseline of these frozen files is untouched by T-0043.
FROZEN_FILES=(
  "src/core/grant-lattice.ts"
  "src/core/object-handle.ts"
  "src/core/effect-resource.ts"
  "src/core/types.ts"
  "src/core/grant-resolver.ts"
)

# Use git to detect any uncommitted or staged changes to frozen files.
# We check both staged and unstaged changes against HEAD.
before=${ERRORS}
for rel_path in "${FROZEN_FILES[@]}"; do
  abs_path="${PROJECT_ROOT}/${rel_path}"
  if [[ ! -f "${abs_path}" ]]; then
    echo "FAIL [MCP-ISO3]: frozen file ${rel_path} does not exist"
    ERRORS=$((ERRORS + 1))
    continue
  fi
  # Check for any uncommitted diff (staged or unstaged) relative to HEAD.
  if ! git -C "${PROJECT_ROOT}" diff --quiet HEAD -- "${rel_path}" 2>/dev/null; then
    echo "FAIL [MCP-ISO3]: frozen file ${rel_path} has uncommitted changes (must be byte-unchanged)"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [MCP-ISO3]: all frozen public surfaces are byte-unchanged (AC-15 / NF-2)"
fi

# ---- MCP-ISO4: no per-agent tool list in migrations/ or src/ ---------------
NO_AGENT_TOOL_TOKENS=(
  "agent_tool"
  "agent_tools"
  "tool_list"
)

before=${ERRORS}
for token in "${NO_AGENT_TOOL_TOKENS[@]}"; do
  matches=$(grep -rn "${token}" \
    "${PROJECT_ROOT}/migrations/" \
    "${PROJECT_ROOT}/src/" \
    2>/dev/null || true)
  if [[ -n "${matches}" ]]; then
    echo "FAIL [MCP-ISO4]: found per-agent tool list token '${token}' in migrations/ or src/:"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [MCP-ISO4]: no per-agent tool list tokens (toolset is always computed, NF-6 / AC-23)"
fi

# ---- Result ----------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: mcp-tool-registry-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: mcp-tool-registry-isolation — all checks green (FF-8/FF-9/FF-10/FF-12)"
exit 0
