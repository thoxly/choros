#!/usr/bin/env bash
# T-0191 · registry-defs PDP-gate isolation fitness
#
# FF-RDP1 (no-stub): TODO(T-0021) stub absent from registry-defs.ts; no 'void actor;' stub.
# FF-RDP2 (deps-injectable): RegistryDefAuthzDeps exported + registerRegistryDefRoutes
#   accepts deps parameter.
# FF-RDP3 (gate-wired): checkDestructiveGrant is called inside updateSchemaInTx force-path.
# FF-RDP4 (no-new-acl): no new ACL mechanism — only loadAdminContext; no schema_destructive_acl.
# FF-RDP5 (operation-no-union-expansion): Operation union in grant-lattice.ts does NOT include
#   'apply'; comparison is string-based in registry-defs.ts.
# FF-RDP6 (genesis-short-circuit): isGenesisOwner short-circuit present in defaultCheckDestructiveGrant.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

REGISTRY_DEFS="${ROOT}/src/http/registry-defs.ts"
GRANT_LATTICE="${ROOT}/src/core/grant-lattice.ts"
ERRORS=0

echo "[FF-RDP] registry-defs-pdp-isolation: checking T-0191 PDP gate constraints"

# ---- Precondition: files exist -----------------------------------------
if [[ ! -f "${REGISTRY_DEFS}" ]]; then
  echo "FAIL: ${REGISTRY_DEFS} does not exist"
  exit 1
fi

if [[ ! -f "${GRANT_LATTICE}" ]]; then
  echo "FAIL: ${GRANT_LATTICE} does not exist"
  exit 1
fi

# ---- FF-RDP1: TODO-stub absent -----------------------------------------
echo ""
echo "Check FF-RDP1 (no-stub): TODO(T-0021) stub and 'void actor;' absent from registry-defs.ts"

if grep -q "TODO(T-0021)" "${REGISTRY_DEFS}"; then
  echo "FAIL (FF-RDP1): TODO(T-0021) stub found in ${REGISTRY_DEFS} — T-0191 not applied"
  grep -n "TODO(T-0021)" "${REGISTRY_DEFS}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP1a): TODO(T-0021) stub absent"
fi

if grep -q "void actor;" "${REGISTRY_DEFS}"; then
  echo "FAIL (FF-RDP1): 'void actor;' stub found in ${REGISTRY_DEFS} — T-0191 not applied"
  grep -n "void actor;" "${REGISTRY_DEFS}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP1b): 'void actor;' stub absent"
fi

# ---- FF-RDP2: RegistryDefAuthzDeps exported and deps parameter wired ---
echo ""
echo "Check FF-RDP2 (deps-injectable): RegistryDefAuthzDeps exported + deps parameter"

if ! grep -q "export interface RegistryDefAuthzDeps" "${REGISTRY_DEFS}"; then
  echo "FAIL (FF-RDP2): RegistryDefAuthzDeps not exported from registry-defs.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP2a): RegistryDefAuthzDeps interface exported"
fi

# registerRegistryDefRoutes should accept deps parameter (RegistryDefAuthzDeps)
if ! grep -q "deps.*RegistryDefAuthzDeps\|RegistryDefAuthzDeps.*deps" "${REGISTRY_DEFS}"; then
  echo "FAIL (FF-RDP2): deps parameter of type RegistryDefAuthzDeps not found in registry-defs.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP2b): deps: RegistryDefAuthzDeps parameter present"
fi

# ---- FF-RDP3: checkDestructiveGrant called in registry-defs.ts ---------
echo ""
echo "Check FF-RDP3 (gate-wired): checkDestructiveGrant called in registry-defs.ts"

if ! grep -q "checkDestructiveGrant" "${REGISTRY_DEFS}"; then
  echo "FAIL (FF-RDP3): checkDestructiveGrant not called in registry-defs.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP3): checkDestructiveGrant call present in registry-defs.ts"
fi

# The gate must throw 403 NO_SCHEMA_DESTRUCTIVE_GRANT
if ! grep -q "NO_SCHEMA_DESTRUCTIVE_GRANT" "${REGISTRY_DEFS}"; then
  echo "FAIL (FF-RDP3b): NO_SCHEMA_DESTRUCTIVE_GRANT error code not found in registry-defs.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP3b): NO_SCHEMA_DESTRUCTIVE_GRANT error code present"
fi

# ---- FF-RDP4: no new ACL mechanism -------------------------------------
echo ""
echo "Check FF-RDP4 (no-new-acl): no new ACL mechanism in registry-defs.ts"

ACL_FORBIDDEN=(
  "schema_destructive_acl"
  "CREATE TABLE.*acl"
  "registry_def_rights"
)
FF_RDP4_ERRORS=0
for pat in "${ACL_FORBIDDEN[@]}"; do
  grep_rc=0
  grep -qiE "${pat}" "${REGISTRY_DEFS}" 2>/dev/null || grep_rc=$?
  if [[ ${grep_rc} -ge 2 ]]; then
    echo "FAIL (FF-RDP4): grep error (exit ${grep_rc}) for pattern: ${pat}"
    FF_RDP4_ERRORS=$((FF_RDP4_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  elif [[ ${grep_rc} -eq 0 ]]; then
    echo "FAIL (FF-RDP4): forbidden ACL pattern found: ${pat}"
    grep -niE "${pat}" "${REGISTRY_DEFS}" || true
    FF_RDP4_ERRORS=$((FF_RDP4_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${FF_RDP4_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-RDP4): no new ACL mechanism in registry-defs.ts"
fi

# loadAdminContext must be imported (the PDP machinery)
if ! grep -q "loadAdminContext" "${REGISTRY_DEFS}"; then
  echo "FAIL (FF-RDP4b): loadAdminContext not imported in registry-defs.ts — PDP gate missing"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP4b): loadAdminContext imported in registry-defs.ts"
fi

# ---- FF-RDP5: Operation union does NOT include 'apply' -----------------
echo ""
echo "Check FF-RDP5 (operation-no-union-expansion): 'apply' absent from Operation union in grant-lattice.ts"

# The Operation union is: "read"|"create"|"update"|"delete"|"approve"|"transition"|"invoke"
# We check that 'apply' is NOT added to this union.
# Pattern: look for '"apply"' within the Operation type definition block.
# We extract lines 25-35 approximately (where Operation is defined) and check.

if awk '/^export type Operation =/,/^export type [A-Z]/' "${GRANT_LATTICE}" | grep -q '"apply"'; then
  echo "FAIL (FF-RDP5): 'apply' found in Operation union in grant-lattice.ts — frozen union was expanded"
  awk '/^export type Operation =/,/^export type [A-Z]/' "${GRANT_LATTICE}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP5): Operation union does not contain 'apply' (frozen union preserved)"
fi

# Verify 'apply' comparison in registry-defs.ts is string-based (not through Operation type)
if ! grep -q '"apply"' "${REGISTRY_DEFS}"; then
  echo "FAIL (FF-RDP5b): 'apply' string literal not found in registry-defs.ts — grant check may be broken"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP5b): 'apply' string literal present in registry-defs.ts (string comparison)"
fi

# ---- FF-RDP6: genesis-owner short-circuit present ----------------------
echo ""
echo "Check FF-RDP6 (genesis-short-circuit): isGenesisOwner short-circuit in defaultCheckDestructiveGrant"

if ! grep -q "isGenesisOwner" "${REGISTRY_DEFS}"; then
  echo "FAIL (FF-RDP6): isGenesisOwner short-circuit not found in registry-defs.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP6): isGenesisOwner short-circuit present in registry-defs.ts"
fi

# ---- FF-RDP7: mgmt_object:schema_destructive resource type present -----
echo ""
echo "Check FF-RDP7: mgmt_object:schema_destructive resource type present in registry-defs.ts"

if ! grep -q "mgmt_object:schema_destructive" "${REGISTRY_DEFS}"; then
  echo "FAIL (FF-RDP7): 'mgmt_object:schema_destructive' resource type not found in registry-defs.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-RDP7): mgmt_object:schema_destructive resource type present"
fi

# ---- Result -------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: registry-defs-pdp-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: registry-defs-pdp-isolation — all checks green"
exit 0
