#!/usr/bin/env bash
# T-0102 · FF-FORMS1 — forms schema-binding gate
#
# Binds the VISUAL form layer (web/src/forms/form-defs.js — form-js HTML rendered
# inside the sandbox-iframe) to the SERVER-SIDE validation schema
# (src/core/form-schema.ts). The validation RULES live only in the server schema
# (single source of truth); form-defs contributes field identity. This gate
# asserts the two cannot silently drift:
#
#   FF-FORMS1-1 — src/core/form-schema.ts and src/core/form-validator.ts exist.
#   FF-FORMS1-2 — Every form-field key exposed by form-defs.js (via `data-field="…"`,
#                 `select("…")`, or `name="…"` radio groups) has a matching
#                 `key: "<k>"` in form-schema.ts. A field added to the UI without a
#                 server rule (= a field the server would not validate) → FAIL.
#   FF-FORMS1-3 — The HTTP submit route src/http/forms.ts re-validates server-side:
#                 it imports validateFormSubmission (never trusts the client).
#   FF-FORMS1-4 — The validator core is pure: no node:http / pg / node:fs / env reads.
#
# Self-test (--self-test): a synthetic form-defs with an unbound field is RED.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

FORM_DEFS="${PROJECT_ROOT}/web/src/forms/form-defs.js"
SCHEMA="${PROJECT_ROOT}/src/core/form-schema.ts"
VALIDATOR="${PROJECT_ROOT}/src/core/form-validator.ts"
ROUTE="${PROJECT_ROOT}/src/http/forms.ts"

# Extract the set of field keys the visual layer exposes from a given form-defs file.
#   - data-field="<k>"  (text/number/date/textarea/checkbox/select/radio wrappers)
#   - select("<k>"      (select-generator first arg)
#   - name="<k>"        (radio-group name = field key)
extract_keys() {
  local file="$1"
  {
    grep -oE 'data-field="[a-zA-Z0-9_]+"' "$file" | sed -E 's/data-field="([a-zA-Z0-9_]+)"/\1/'
    grep -oE 'select\(\s*"[a-zA-Z0-9_]+"' "$file" | sed -E 's/select\(\s*"([a-zA-Z0-9_]+)"/\1/'
    grep -oE 'name="[a-zA-Z0-9_]+"' "$file" | sed -E 's/name="([a-zA-Z0-9_]+)"/\1/'
  } | sort -u
}

# Returns 0 if every key from $1 has a `key: "<k>"` entry in schema file $2.
check_binding() {
  local defs_file="$1" schema_file="$2"
  local missing=0 k
  while IFS= read -r k; do
    [ -z "$k" ] && continue
    if ! grep -qE "key:[[:space:]]*\"${k}\"" "$schema_file"; then
      echo "FAIL [FF-FORMS1-2]: form-defs field '${k}' has no server-side validation rule (key: \"${k}\") in $(basename "$schema_file")"
      missing=1
    fi
  done < <(extract_keys "$defs_file")
  return "$missing"
}

# ---------------------------------------------------------------------------
# --self-test: a synthetic form-defs whose extra field has no schema rule → RED.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  cat > "${TMP}/defs.js" <<'EOF'
  '<div data-field="supplier">' + select("supplier", "...", ...) +
  '<div data-field="ghost_unbound_field">'  // a field with NO server rule
EOF
  cat > "${TMP}/schema.ts" <<'EOF'
  { key: "supplier", type: "enum" },
EOF
  if check_binding "${TMP}/defs.js" "${TMP}/schema.ts" >/dev/null 2>&1; then
    echo "[T-0102] self-test FAIL: unbound 'ghost_unbound_field' was NOT caught"
    exit 2
  fi
  echo "[T-0102] self-test PASS: unbound form-defs field is detected (RED as expected)"
  echo "[T-0102] forms-schema-binding --self-test: passed (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK
# ---------------------------------------------------------------------------
FAIL=0

# FF-FORMS1-1
for f in "$SCHEMA" "$VALIDATOR"; do
  if [ ! -f "$f" ]; then
    echo "FAIL [FF-FORMS1-1]: required file missing: $f"
    FAIL=1
  fi
done

if [ ! -f "$FORM_DEFS" ]; then
  echo "FAIL [FF-FORMS1]: form-defs visual layer missing: $FORM_DEFS"
  FAIL=1
fi

# FF-FORMS1-2 — every UI field key is bound to a server rule.
if [ -f "$FORM_DEFS" ] && [ -f "$SCHEMA" ]; then
  if ! check_binding "$FORM_DEFS" "$SCHEMA"; then
    FAIL=1
  fi
fi

# FF-FORMS1-3 — the submit route re-validates on the server.
if [ -f "$ROUTE" ]; then
  if ! grep -qE "validateFormSubmission" "$ROUTE"; then
    echo "FAIL [FF-FORMS1-3]: $ROUTE does not call validateFormSubmission (server must distrust client)"
    FAIL=1
  fi
else
  echo "FAIL [FF-FORMS1-3]: submit route missing: $ROUTE"
  FAIL=1
fi

# FF-FORMS1-4 — validator core purity (no transport/DB/fs/env in the pure module).
if [ -f "$VALIDATOR" ]; then
  if grep -nE "node:http|node:fs|node:net|child_process|from \"pg\"|process\.env" "$VALIDATOR"; then
    echo "FAIL [FF-FORMS1-4]: src/core/form-validator.ts is not pure (transport/DB/fs/env reference above)"
    FAIL=1
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: forms-schema-binding — UI fields and server validation drifted, or route does not re-validate"
  exit 1
fi

echo "PASS [FF-FORMS1]: every form-defs field is bound to a server validation rule; submit route re-validates; validator pure"
exit 0
