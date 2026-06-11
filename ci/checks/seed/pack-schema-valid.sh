#!/usr/bin/env bash
# FF-1: seed/pack.schema.json exists and validates every seed/*/pack.json with zero errors.
# AC-12.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCHEMA="$REPO_ROOT/seed/pack.schema.json"

if [[ ! -f "$SCHEMA" ]]; then
  echo "FAIL: seed/pack.schema.json does not exist" >&2
  exit 1
fi

# Use validate.py if available (matches existing harness pattern)
VALIDATE_PY="$REPO_ROOT/../demiurge/schemas/validate.py"

if [[ -f "$VALIDATE_PY" ]]; then
  # Use the demiurge validator: validate.py expects <schema-name> <file>
  # For pack schema we use direct json-schema validation below as validate.py
  # has a different contract (pr-handoff / friction-event schemas). Fall through.
  : # not using it
fi

# Use Node.js for JSON Schema draft-07 validation (no new dep — built-in JSON only)
node - <<'NODEJS' "$SCHEMA" "$REPO_ROOT"/seed/*/pack.json
const fs = require('fs');
const [,, schema, ...packs] = process.argv;

function validate(schemaObj, obj, path) {
  const errors = [];
  if (schemaObj.type) {
    const types = Array.isArray(schemaObj.type) ? schemaObj.type : [schemaObj.type];
    const jsType = obj === null ? 'null' : typeof obj;
    const isArray = Array.isArray(obj);
    const matched = types.some(t => {
      if (t === 'null') return obj === null;
      if (t === 'array') return isArray;
      if (t === 'object') return jsType === 'object' && !isArray && obj !== null;
      return jsType === t;
    });
    if (!matched) errors.push(`${path}: expected type ${JSON.stringify(types)}, got ${jsType}`);
  }
  if (schemaObj.required && typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    for (const k of schemaObj.required) {
      if (!(k in obj)) errors.push(`${path}: missing required field '${k}'`);
    }
  }
  if (schemaObj.properties && typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    for (const [k, subSchema] of Object.entries(schemaObj.properties)) {
      if (k in obj) errors.push(...validate(subSchema, obj[k], `${path}.${k}`));
    }
  }
  if (schemaObj.items && Array.isArray(obj)) {
    obj.forEach((item, i) => errors.push(...validate(schemaObj.items, item, `${path}[${i}]`)));
  }
  if (schemaObj.enum && !schemaObj.enum.includes(obj)) {
    errors.push(`${path}: value ${JSON.stringify(obj)} not in enum ${JSON.stringify(schemaObj.enum)}`);
  }
  if (schemaObj.pattern && typeof obj === 'string') {
    if (!new RegExp(schemaObj.pattern).test(obj)) {
      errors.push(`${path}: value ${JSON.stringify(obj)} does not match pattern ${schemaObj.pattern}`);
    }
  }
  if (schemaObj.minLength && typeof obj === 'string' && obj.length < schemaObj.minLength) {
    errors.push(`${path}: string too short (min ${schemaObj.minLength})`);
  }
  return errors;
}

const schemaObj = JSON.parse(fs.readFileSync(schema, 'utf8'));
let failed = false;

for (const packFile of packs) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  } catch(e) {
    console.error(`FAIL: Cannot parse ${packFile}: ${e.message}`);
    failed = true;
    continue;
  }
  const errors = validate(schemaObj, obj, packFile);
  if (errors.length > 0) {
    console.error(`FAIL: ${packFile} schema errors:`);
    errors.forEach(e => console.error('  ' + e));
    failed = true;
  } else {
    console.log(`OK: ${packFile}`);
  }
}
if (failed) process.exit(1);
NODEJS

echo "FF-1: pack-schema-valid PASS"
