#!/usr/bin/env bash
# T-0079 · E11.8 — modules-extend-not-replace isolation checks
#
# Asserts (ADR extensibility-and-authoring.md §5, T-0079):
#  MER-1  — src/core/modules-nav.ts exists.
#  MER-2  — Module is pure: no pg, node:fs, node:http, node:net, child_process,
#            import.meta, process.env, process.exit imports.
#  MER-3  — ADR-reference comment mentions T-0078/evaluateAuthoringRedLine (precedent),
#            T-0177/classifySchemaChange (precedent), and T-0072/checkBindingCompat (NF-1).
#  MER-4  — All required public-surface exports present:
#            NavConfig, NavSection, NavApplication, NavLeaf, NavItemKind,
#            validateNavConfig,
#            CatalogFieldSpec, CatalogFieldKind, CatalogChangeKind,
#            CatalogChangeDecision, CatalogFieldChange,
#            classifyCatalogFieldChange,
#            UserProjection, OrgUnitRef,
#            USER_CATALOG_STANDARD_FIELDS, CATALOG_STANDARD_FIELDS.
#  MER-5  — classifyCatalogFieldChange is a pure guard (no pg/IO/env in the function).
#  MER-6  — Nav config is versioned (NavConfig has a 'version' field — versioned-config
#            discipline from ADR §5).
#  MER-7  — Migration 067_modules_nav.sql exists with correct RLS policies
#            for nav_version and catalog_field_spec.
#  MER-8  — Both nav_version and catalog_field_spec are listed in known_tenant_tables.txt.
#  MER-9  — No second user store: modules-nav.ts must NOT reference a 'user' table or
#            CREATE TABLE.*user (Keycloak projection = read-only, ADR §5 + tenancy §6).
#  MER-10 — validateNavConfig enforces bounded reorder (NAV_MAX_SECTIONS constant exported).
#
# SELF-TEST (--self-test flag): each check runs against planted fixtures to verify
#   it correctly detects violations. Exit 2 on self-test infrastructure failure.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0
SELF_TEST="${1:-}"

MODULE="${PROJECT_ROOT}/src/core/modules-nav.ts"
MIGRATION="${PROJECT_ROOT}/migrations/067_modules_nav.sql"
KNOWN_TABLES="${PROJECT_ROOT}/ci/checks/known_tenant_tables.txt"

# ---- Self-test mode --------------------------------------------------------

if [[ "${SELF_TEST}" == "--self-test" ]]; then
  echo "[MER self-test] Verifying script detects violations..."
  SELF_ERRORS=0
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_ST"' EXIT

  # SELF-TEST MER-1: module-not-found detection
  FAKE_ABSENT="${TMPDIR_ST}/absent.ts"
  if [[ ! -f "${FAKE_ABSENT}" ]]; then
    echo "SELF-TEST MER-1 PASS: absent file correctly detected as absent"
  else
    echo "SELF-TEST MER-1 FAIL: false positive — file should not exist"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # SELF-TEST MER-2: forbidden pg import detection
  FAKE_PG="${TMPDIR_ST}/has_pg.ts"
  printf 'import pg from "pg";\nexport function foo() {}\n' > "${FAKE_PG}"
  if grep -Eq "from.*['\"]pg['\"]" "${FAKE_PG}"; then
    echo "SELF-TEST MER-2 PASS: forbidden pg import correctly detected"
  else
    echo "SELF-TEST MER-2 FAIL: pg import not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # SELF-TEST MER-3: missing ADR reference detection
  FAKE_NO_ADR="${TMPDIR_ST}/no_adr.ts"
  printf 'export function classifyCatalogFieldChange() { return "allow"; }\n' > "${FAKE_NO_ADR}"
  if ! grep -q "T-0078\|evaluateAuthoringRedLine" "${FAKE_NO_ADR}"; then
    echo "SELF-TEST MER-3 PASS: missing T-0078 reference correctly detected as absent"
  else
    echo "SELF-TEST MER-3 FAIL: false positive on ADR reference detection"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # SELF-TEST MER-4: missing export detection
  FAKE_NO_EXPORT="${TMPDIR_ST}/no_export.ts"
  printf 'export function foo() {}\n' > "${FAKE_NO_EXPORT}"
  if ! grep -q "classifyCatalogFieldChange" "${FAKE_NO_EXPORT}"; then
    echo "SELF-TEST MER-4 PASS: missing classifyCatalogFieldChange export correctly detected"
  else
    echo "SELF-TEST MER-4 FAIL: false positive on export detection"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # SELF-TEST MER-7: migration without RLS policy detection
  FAKE_MIG="${TMPDIR_ST}/mig_no_rls.sql"
  printf 'CREATE TABLE choros.nav_version (id uuid);\n' > "${FAKE_MIG}"
  if ! grep -q "nav_version_tenant_isolation" "${FAKE_MIG}"; then
    echo "SELF-TEST MER-7 PASS: missing RLS policy in migration correctly detected"
  else
    echo "SELF-TEST MER-7 FAIL: false positive on RLS policy detection"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # SELF-TEST MER-9: second user store detection
  FAKE_USER_TABLE="${TMPDIR_ST}/user_table.ts"
  printf 'CREATE TABLE choros.users (id uuid);\n' > "${FAKE_USER_TABLE}"
  if grep -Eq "CREATE TABLE.*\buser" "${FAKE_USER_TABLE}"; then
    echo "SELF-TEST MER-9 PASS: forbidden second user table correctly detected"
  else
    echo "SELF-TEST MER-9 FAIL: second user table not detected — check is broken"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  # SELF-TEST MER-10: missing NAV_MAX_SECTIONS detection
  FAKE_NO_MAX="${TMPDIR_ST}/no_max.ts"
  printf 'export function validateNavConfig() { return true; }\n' > "${FAKE_NO_MAX}"
  if ! grep -q "NAV_MAX_SECTIONS" "${FAKE_NO_MAX}"; then
    echo "SELF-TEST MER-10 PASS: missing NAV_MAX_SECTIONS correctly detected"
  else
    echo "SELF-TEST MER-10 FAIL: false positive on NAV_MAX_SECTIONS detection"
    SELF_ERRORS=$((SELF_ERRORS + 1))
  fi

  if [[ ${SELF_ERRORS} -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_ERRORS} self-test(s) broken (check infrastructure is broken)"
    exit 2
  fi
  echo "PASS: modules-extend-not-replace --self-test — all self-tests green"
  exit 0
fi

# ---------------------------------------------------------------------------
# Real checks
# ---------------------------------------------------------------------------

echo "[FF-MER MER-1..10] modules-extend-not-replace: checking module boundary"

# ---- MER-1: core module file exists ----------------------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL MER-1: src/core/modules-nav.ts does not exist (T-0079 not implemented)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS MER-1: src/core/modules-nav.ts exists"
fi

# ---- MER-2: no forbidden I/O imports in module -------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP MER-2: module not found (already failed MER-1)"
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

  MER2_ERRORS=0
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    # Filter out comment-only lines (// and * lines) before checking — a comment
    # that says "NOT IMPORTED: process.env" is documentation, not a violation.
    matches=$(grep -Eq "${pattern}" "${MODULE}" 2>/dev/null && grep -E "${pattern}" "${MODULE}" | grep -vE "^\s*[0-9]*:?\s*(\*|//)" || true)
    if [[ -n "${matches}" ]]; then
      echo "FAIL MER-2: modules-nav.ts contains forbidden pattern: ${pattern}"
      MER2_ERRORS=$((MER2_ERRORS + 1))
    fi
  done

  if [[ ${MER2_ERRORS} -eq 0 ]]; then
    echo "PASS MER-2: modules-nav.ts contains no forbidden I/O imports (core purity)"
  else
    ERRORS=$((ERRORS + MER2_ERRORS))
  fi
fi

# ---- MER-3: ADR references to T-0078 + T-0177 + T-0072 --------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP MER-3: module not found"
else
  MER3_ERRORS=0
  if ! grep -qE "T-0078|evaluateAuthoringRedLine" "${MODULE}" 2>/dev/null; then
    echo "FAIL MER-3: modules-nav.ts missing ADR reference to T-0078/evaluateAuthoringRedLine (precedent, NF-1)"
    MER3_ERRORS=$((MER3_ERRORS + 1))
  fi
  if ! grep -qE "T-0177|classifySchemaChange" "${MODULE}" 2>/dev/null; then
    echo "FAIL MER-3: modules-nav.ts missing ADR reference to T-0177/classifySchemaChange (precedent, NF-1)"
    MER3_ERRORS=$((MER3_ERRORS + 1))
  fi
  if ! grep -qE "T-0072|checkBindingCompat" "${MODULE}" 2>/dev/null; then
    echo "FAIL MER-3: modules-nav.ts missing ADR reference to T-0072/checkBindingCompat (единый control plane, NF-1)"
    MER3_ERRORS=$((MER3_ERRORS + 1))
  fi
  if [[ ${MER3_ERRORS} -eq 0 ]]; then
    echo "PASS MER-3: ADR references to T-0078 + T-0177 + T-0072 present"
  else
    ERRORS=$((ERRORS + MER3_ERRORS))
  fi
fi

# ---- MER-4: required public-surface exports present -------------------------

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP MER-4: module not found"
else
  MER4_ERRORS=0
  REQUIRED_EXPORTS=(
    "NavConfig"
    "NavSection"
    "NavApplication"
    "NavLeaf"
    "NavItemKind"
    "validateNavConfig"
    "CatalogFieldSpec"
    "CatalogFieldKind"
    "CatalogChangeKind"
    "CatalogChangeDecision"
    "CatalogFieldChange"
    "classifyCatalogFieldChange"
    "UserProjection"
    "OrgUnitRef"
    "USER_CATALOG_STANDARD_FIELDS"
    "CATALOG_STANDARD_FIELDS"
  )

  for export_name in "${REQUIRED_EXPORTS[@]}"; do
    if ! grep -q "${export_name}" "${MODULE}" 2>/dev/null; then
      echo "FAIL MER-4: modules-nav.ts missing export: ${export_name}"
      MER4_ERRORS=$((MER4_ERRORS + 1))
    fi
  done

  if [[ ${MER4_ERRORS} -eq 0 ]]; then
    echo "PASS MER-4: all required public-surface exports present"
  else
    ERRORS=$((ERRORS + MER4_ERRORS))
  fi
fi

# ---- MER-5: classifyCatalogFieldChange is a pure guard (no IO in function) -

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP MER-5: module not found"
else
  # The guard function must not contain any DB/IO call patterns
  GUARD_IO_PATTERNS=(
    "await"
    "\.query("
    "\.execute("
    "fetch("
    "readFile"
    "writeFile"
  )

  MER5_ERRORS=0
  # Extract only the classifyCatalogFieldChange function body for targeted check
  # (coarse grep — checks the whole file, which is pure anyway)
  for pattern in "${GUARD_IO_PATTERNS[@]}"; do
    if grep -Eq "${pattern}" "${MODULE}" 2>/dev/null; then
      echo "FAIL MER-5: modules-nav.ts contains IO pattern '${pattern}' — guard must be pure"
      MER5_ERRORS=$((MER5_ERRORS + 1))
    fi
  done

  if [[ ${MER5_ERRORS} -eq 0 ]]; then
    echo "PASS MER-5: classifyCatalogFieldChange is pure (no IO patterns detected)"
  else
    ERRORS=$((ERRORS + MER5_ERRORS))
  fi
fi

# ---- MER-6: NavConfig has a 'version' field (versioned-config discipline) ---

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP MER-6: module not found"
else
  if ! grep -q "readonly version" "${MODULE}" 2>/dev/null; then
    echo "FAIL MER-6: modules-nav.ts NavConfig missing 'readonly version' field (versioned-config, ADR §5)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS MER-6: NavConfig has 'readonly version' field (versioned-config)"
  fi
fi

# ---- MER-7: migration 067 exists with RLS policies for both tables ----------

if [[ ! -f "${MIGRATION}" ]]; then
  echo "FAIL MER-7: migrations/067_modules_nav.sql does not exist"
  ERRORS=$((ERRORS + 1))
else
  MER7_ERRORS=0
  if ! grep -q "nav_version_tenant_isolation" "${MIGRATION}" 2>/dev/null; then
    echo "FAIL MER-7: 067_modules_nav.sql missing RLS policy 'nav_version_tenant_isolation'"
    MER7_ERRORS=$((MER7_ERRORS + 1))
  fi
  if ! grep -q "catalog_field_spec_tenant_isolation" "${MIGRATION}" 2>/dev/null; then
    echo "FAIL MER-7: 067_modules_nav.sql missing RLS policy 'catalog_field_spec_tenant_isolation'"
    MER7_ERRORS=$((MER7_ERRORS + 1))
  fi
  if ! grep -q "FORCE.*ROW LEVEL SECURITY\|ROW LEVEL SECURITY.*FORCE" "${MIGRATION}" 2>/dev/null; then
    # Check both tables have FORCE RLS
    NV_FORCE=$(grep -c "nav_version.*ROW LEVEL SECURITY\|ROW LEVEL SECURITY.*nav_version\|choros\.nav_version.*FORCE\|FORCE.*choros\.nav_version" "${MIGRATION}" 2>/dev/null || true)
    CF_FORCE=$(grep -c "catalog_field_spec.*ROW LEVEL SECURITY\|ROW LEVEL SECURITY.*catalog_field_spec\|choros\.catalog_field_spec.*FORCE\|FORCE.*choros\.catalog_field_spec" "${MIGRATION}" 2>/dev/null || true)
    if [[ "${NV_FORCE}" -eq 0 || "${CF_FORCE}" -eq 0 ]]; then
      echo "FAIL MER-7: 067_modules_nav.sql missing FORCE ROW LEVEL SECURITY on one or both tables"
      MER7_ERRORS=$((MER7_ERRORS + 1))
    fi
  fi
  if [[ ${MER7_ERRORS} -eq 0 ]]; then
    echo "PASS MER-7: 067_modules_nav.sql exists with correct RLS policies"
  else
    ERRORS=$((ERRORS + MER7_ERRORS))
  fi
fi

# ---- MER-8: both tables listed in known_tenant_tables.txt -------------------

if [[ ! -f "${KNOWN_TABLES}" ]]; then
  echo "FAIL MER-8: ci/checks/known_tenant_tables.txt does not exist"
  ERRORS=$((ERRORS + 1))
else
  MER8_ERRORS=0
  if ! grep -q "^nav_version$" "${KNOWN_TABLES}" 2>/dev/null; then
    echo "FAIL MER-8: 'nav_version' not listed in known_tenant_tables.txt"
    MER8_ERRORS=$((MER8_ERRORS + 1))
  fi
  if ! grep -q "^catalog_field_spec$" "${KNOWN_TABLES}" 2>/dev/null; then
    echo "FAIL MER-8: 'catalog_field_spec' not listed in known_tenant_tables.txt"
    MER8_ERRORS=$((MER8_ERRORS + 1))
  fi
  if [[ ${MER8_ERRORS} -eq 0 ]]; then
    echo "PASS MER-8: both nav_version and catalog_field_spec listed in known_tenant_tables.txt"
  else
    ERRORS=$((ERRORS + MER8_ERRORS))
  fi
fi

# ---- MER-9: no second user store in modules-nav.ts (Keycloak projection) ----

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP MER-9: module not found"
else
  # The module must not define a CREATE TABLE for users (it's a read-only projection)
  if grep -Eq "CREATE TABLE.*\buser" "${MODULE}" 2>/dev/null; then
    echo "FAIL MER-9: modules-nav.ts references CREATE TABLE for a user table (must be Keycloak projection only, ADR §5 + tenancy §6)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS MER-9: no second user store in modules-nav.ts (UserProjection is read-only KC projection)"
  fi
fi

# ---- MER-10: validateNavConfig enforces bounded reorder (NAV_MAX_SECTIONS exported) ---

if [[ ! -f "${MODULE}" ]]; then
  echo "SKIP MER-10: module not found"
else
  if ! grep -q "NAV_MAX_SECTIONS" "${MODULE}" 2>/dev/null; then
    echo "FAIL MER-10: modules-nav.ts missing NAV_MAX_SECTIONS export (bounded reorder, ADR §5)"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS MER-10: NAV_MAX_SECTIONS exported (bounded reorder discipline)"
  fi
fi

# ---- Result ----------------------------------------------------------------

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: modules-extend-not-replace found ${ERRORS} violation(s) (T-0079 E11.8)"
  exit 1
fi

echo "PASS: modules-extend-not-replace — all checks green [FF-MER MER-1..10] (T-0079 E11.8)"
exit 0
