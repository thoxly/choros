#!/usr/bin/env bash
# T-0242 · FF-T242-4 — vendor ledger must not appear in tenant substrate (issuance-store-not-tenant-table)
#
# Enforces ADR §1.1: LicenseRecord is a VENDOR ledger, not a tenant table.
# Prevents accidental drift where the vendor record lands in the tenant-DDL:
#
#   (a) known_tenant_tables.txt must not contain any 'license' or 'entitlement' row.
#       (That file is the tenant-table registry; vendor entries do not belong there.)
#   (b) No migration under migrations/ must contain CREATE TABLE with
#       'license_record' or 'entitlement' in the table name.
#
# SELF-TEST (--self-test):
#   1. Plants 'license_record' in a temp copy of known_tenant_tables → must be CAUGHT.
#   2. Plants CREATE TABLE license_record in a temp file → must be CAUGHT.
#   Exit 2 if either demonstration fails.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KNOWN_TABLES="$REPO_ROOT/ci/checks/known_tenant_tables.txt"
MIGRATIONS_DIR="$REPO_ROOT/migrations"

echo "[T-0242] issuance-store-not-tenant-table (FF-T242-4): vendor ledger must not be in tenant substrate"

# ---------------------------------------------------------------------------
# SELF-TEST
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0242] issuance-store-not-tenant-table --self-test"

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  # Self-test 1: planted 'license_record' in known_tenant_tables → must FAIL.
  TMP_KTT="$TMP_DIR/known_tenant_tables.txt"
  printf 'record\nlicense_record\ntenant\n' > "$TMP_KTT"
  if ! grep -qiE '^(license|entitlement)' "$TMP_KTT"; then
    echo "SELF-TEST 1 FAIL: planted license_record NOT detected in known_tenant_tables — check broken (exit 2)"
    exit 2
  fi
  echo "[T-0242] self-test 1 PASS: planted license_record in known_tenant_tables detected"

  # Self-test 2: planted CREATE TABLE license_record in migration SQL → must FAIL.
  TMP_MIG="$TMP_DIR/073_test.sql"
  printf 'CREATE TABLE license_record (id uuid PRIMARY KEY);\n' > "$TMP_MIG"
  if ! grep -qiE 'CREATE[[:space:]]+TABLE[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?(license_record|entitlement)' "$TMP_MIG"; then
    echo "SELF-TEST 2 FAIL: planted CREATE TABLE license_record NOT detected — check broken (exit 2)"
    exit 2
  fi
  echo "[T-0242] self-test 2 PASS: planted CREATE TABLE license_record detected"

  trap - EXIT
  rm -rf "$TMP_DIR"
  echo "[T-0242] issuance-store-not-tenant-table --self-test: all self-tests passed (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK
# ---------------------------------------------------------------------------
FAIL=0

# (a) known_tenant_tables.txt must not contain license/entitlement rows.
if [ -f "$KNOWN_TABLES" ]; then
  if grep -qiE '^(license|entitlement)' "$KNOWN_TABLES"; then
    echo "FAIL [FF-T242-4]: known_tenant_tables.txt contains a vendor-ledger entry (license/entitlement):"
    grep -niE '^(license|entitlement)' "$KNOWN_TABLES"
    FAIL=1
  fi
else
  echo "WARN [FF-T242-4]: known_tenant_tables.txt not found — skipping (a)"
fi

# (b) No migration must CREATE TABLE with license_record / entitlement.
if [ -d "$MIGRATIONS_DIR" ]; then
  while IFS= read -r -d '' f; do
    if grep -qiE 'CREATE[[:space:]]+TABLE[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?(license_record|entitlement)' "$f"; then
      echo "FAIL [FF-T242-4]: migration creates tenant table for vendor ledger: $f"
      grep -niE 'CREATE[[:space:]]+TABLE[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?(license_record|entitlement)' "$f"
      FAIL=1
    fi
  done < <(find "$MIGRATIONS_DIR" -name '*.sql' -print0 2>/dev/null)
else
  echo "[T-0242] migrations/ not found — skipping (b)"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: vendor ledger must not be in tenant substrate (FF-T242-4)"
  exit 1
fi

echo "PASS [FF-T242-4]: vendor ledger not in tenant substrate — known_tenant_tables clean, no migration CREATE TABLE for license/entitlement"
exit 0
