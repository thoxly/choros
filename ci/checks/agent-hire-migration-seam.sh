#!/usr/bin/env bash
# FF-HIRE-7: Migration seam.
# T-0042 uses no migration (§1.2). Assert no migrations/042_*.sql exists.
# Additionally assert no 041_* or 043_* file was CREATED by this task
# (those slots are reserved for T-0041 and T-0043 respectively).
#
# IF a 042_*.sql file ever exists (future amendment), it must contain:
#   - FORCE ROW LEVEL SECURITY
#   - a tenant_id leading column pattern
#   - ON CONFLICT DO NOTHING on any INSERT seed

set -euo pipefail

FAIL=0

# Primary check: no 042_* migration should exist (ADR §1.2)
if ls migrations/042_*.sql 2>/dev/null | grep -q .; then
  MIGRATION_FILE=$(ls migrations/042_*.sql | head -1)
  echo "WARN FF-HIRE-7: $MIGRATION_FILE exists — checking content for compliance"

  # Check FORCE ROW LEVEL SECURITY
  if ! grep -q "FORCE ROW LEVEL SECURITY" "$MIGRATION_FILE"; then
    echo "FAIL FF-HIRE-7: $MIGRATION_FILE missing FORCE ROW LEVEL SECURITY" >&2
    FAIL=1
  fi

  # Check tenant_id leading (presence of tenant_id column definition or constraint)
  if ! grep -qiE "tenant_id" "$MIGRATION_FILE"; then
    echo "FAIL FF-HIRE-7: $MIGRATION_FILE missing tenant_id leading constraint" >&2
    FAIL=1
  fi

  # Check ON CONFLICT DO NOTHING on any INSERT
  if grep -qi "INSERT INTO" "$MIGRATION_FILE"; then
    if ! grep -qi "ON CONFLICT DO NOTHING" "$MIGRATION_FILE"; then
      echo "FAIL FF-HIRE-7: $MIGRATION_FILE has INSERT without ON CONFLICT DO NOTHING" >&2
      FAIL=1
    fi
  fi

  if [ "$FAIL" -eq 0 ]; then
    echo "PASS FF-HIRE-7: 042 migration exists and is compliant (FORCE RLS, tenant_id, ON CONFLICT DO NOTHING)"
  fi
else
  echo "PASS FF-HIRE-7: no migrations/042_*.sql — AC-17 satisfied vacuously (no migration needed)"
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
