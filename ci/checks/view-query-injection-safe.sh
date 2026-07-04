#!/usr/bin/env bash
# T-0581 (view registry) · FF-VR-3 — dynamic ORDER BY/WHERE injection safety.
#
# THE CONTRACT (NF-6/AC-13, ADR §4/§6): field_key must NEVER be string-
# interpolated into a SQL fragment except through the fixed, code-controlled
# `jsonbTextPath` template — and even then, only AFTER the caller has verified
# the key is a Map member of the whitelist (a lookup, not a pattern match).
# Filter VALUES must ALWAYS be bind parameters ($n), never concatenated into
# the SQL string.
#
# This is a STATIC linter (grep-based, mirrors read-pdp-anti-case.sh style):
# it does not prove semantic correctness (the unit tests in
# src/core/__tests__/view-query.test.ts do that) — it guards the SHAPE of
# view-query.ts against a future edit reintroducing raw interpolation.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VIEW_QUERY="${ROOT}/src/core/view-query.ts"

ERRORS=0

echo "[FF-VR-3] view-query-injection-safe: checking T-0581 NF-6/AC-13"

if [[ ! -f "${VIEW_QUERY}" ]]; then
  echo "FAIL: ${VIEW_QUERY} does not exist"
  exit 1
fi

# ---- Positive: the fixed jsonbTextPath template must exist -----------------
if grep -qE "function jsonbTextPath" "${VIEW_QUERY}"; then
  echo "PASS (FF-VR-3a): jsonbTextPath (fixed field_key->SQL-path template) present"
else
  echo "FAIL (FF-VR-3a): jsonbTextPath function not found — no fixed field_key template"
  ERRORS=$((ERRORS + 1))
fi

# ---- Positive: filter values must be pushed to params[], never templated ---
if grep -qE 'params\.push\(' "${VIEW_QUERY}"; then
  echo "PASS (FF-VR-3b): filter values are appended to a params[] bind-array"
else
  echo "FAIL (FF-VR-3b): no params.push( calls found — values may not be parameterized"
  ERRORS=$((ERRORS + 1))
fi

# ---- Negative: no template-string interpolation of a filter VALUE into SQL
# TEXT (a `conds.push(...)` argument). Interpolating `filter.value` into a
# STRING that is itself later pushed to `params` (e.g. building a LIKE pattern
# `%${value}%` that becomes a single bind parameter) is safe and intentional —
# so this check greps ONLY lines whose interpolation target is a `conds.push(`
# call, never a `params.push(` call (the two are on visually distinct lines in
# this module by construction; a value must never appear inside conds.push).
CONDS_VALUE_INTERP="$(grep -nE 'conds\.push\([^)]*\$\{[^}]*\bvalue\b' "${VIEW_QUERY}" || true)"
if [[ -n "${CONDS_VALUE_INTERP}" ]]; then
  echo "FAIL (FF-VR-3c): a filter VALUE is template-interpolated directly into a conds.push(...) SQL fragment:"
  echo "${CONDS_VALUE_INTERP}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-VR-3c): no filter value is interpolated directly into a conds.push(...) SQL fragment"
fi

# ---- Negative: field_key must never be interpolated directly without going
# through the sanctioned jsonbTextPath/jsonbArrayPath templates or a call to
# one of them — i.e. no OTHER site in the file builds a JSONB path by raw
# `${...field_key...}` string-templating. We check every `${...field_key...}`
# occurrence and require it to appear ONLY on a line that also mentions
# `jsonbTextPath` or `jsonbArrayPath` (their own definitions, which legitimately
# interpolate their already-whitelist-checked `fieldKey` PARAMETER — the single
# sanctioned pattern; every OTHER call site passes field_key as a plain function
# ARGUMENT, e.g. `jsonbTextPath(filter.field_key)`, never as `${filter.field_key}`).
RAW_FIELD_KEY_INTERP="$(grep -nE '\$\{[^}]*field_key[^}]*\}' "${VIEW_QUERY}" | grep -vE 'jsonbTextPath|jsonbArrayPath' || true)"
if [[ -n "${RAW_FIELD_KEY_INTERP}" ]]; then
  echo "FAIL (FF-VR-3d): field_key interpolated into a template literal outside the sanctioned jsonbTextPath/jsonbArrayPath sites:"
  echo "${RAW_FIELD_KEY_INTERP}"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-VR-3d): no raw field_key template-interpolation outside the sanctioned jsonbTextPath/jsonbArrayPath sites"
fi

# ---- Positive: whitelist lookup gate present (Map.get / .has before use) ---
if grep -qE 'whitelist\.typeByKey\.get\(' "${VIEW_QUERY}"; then
  echo "PASS (FF-VR-3e): field_key is resolved via a whitelist Map lookup before use"
else
  echo "FAIL (FF-VR-3e): no whitelist.typeByKey.get( lookup found — field_key may not be gated"
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: view-query-injection-safe found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: view-query-injection-safe — NF-6/AC-13 shape guards hold"
exit 0
