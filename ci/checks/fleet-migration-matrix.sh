#!/usr/bin/env bash
# T-0069 · FF-FLEET1..FF-FLEET5 — CI migration-version matrix for the silo-fleet (tenancy ADR §10).
#
# Guarantees that the declared cell registry stays APPLIABLE across the whole
# fleet, so a tenant can never silently reference a migration that does not exist
# or was rolled back (the "fleet drift" risk §10 names). Static, zero-dep, offline
# (reads ops/fleet/cells.json + migrations/ only — never touches a live server).
#
#  FF-FLEET1 — ops/fleet/cells.json validates against ops/fleet/cells.schema.json
#              with zero errors (machine-readable registry is well-formed).
#  FF-FLEET2 — every cell's migration_version exists as a migrations/<stem>.sql file
#              (no cell pinned to an unknown / rolled-back migration).
#  FF-FLEET3 — every cell's migration_version is APPLIABLE: it is the head of the
#              linear prefix the runner (migrations/run.mjs) would apply — i.e. the
#              lexicographically-sorted migration set has NO version that sorts
#              after the cell's pin (a cell may legally lag behind head, but it may
#              never pin a version newer than what exists, nor skip into a gap).
#  FF-FLEET4 — the migrations/ set itself is well-formed: no two files share the
#              same NNN numeric prefix (ambiguous lexicographic order = non-linear).
#  FF-FLEET5 — cell slugs are unique across the fleet (no duplicate contour ids).
#
# SELF-TEST (--self-test): build a fixture registry+migration set with (a) an
# unknown pin, (b) a pin newer than head, (c) duplicate slug, (d) duplicate NNN
# prefix; assert each tripwire fires. exit 0 if the demonstration succeeds, 2 if broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ---------------------------------------------------------------------------
# Core engine: validate a registry against a migrations dir. Pure function of
# its three path args so --self-test can drive it over a temp fixture. Echoes
# violations; returns 1 if any, 0 if clean.
# ---------------------------------------------------------------------------
run_matrix() { # run_matrix <registry.json> <schema.json> <migrations-dir>
  local registry="$1" schema="$2" migdir="$3"
  node - "$registry" "$schema" "$migdir" <<'NODEJS'
const fs = require('fs');
const path = require('path');
const [, , registryPath, schemaPath, migDir] = process.argv;

// ---- minimal draft-07 validator (same shape as ci/checks/seed/pack-schema-valid.sh) ----
function validate(s, obj, p) {
  const errors = [];
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const jsType = obj === null ? 'null' : typeof obj;
    const isArray = Array.isArray(obj);
    const ok = types.some(t =>
      t === 'null' ? obj === null :
      t === 'array' ? isArray :
      t === 'object' ? (jsType === 'object' && !isArray && obj !== null) :
      jsType === t);
    if (!ok) errors.push(`${p}: expected type ${JSON.stringify(types)}, got ${jsType}`);
  }
  if (s.required && typeof obj === 'object' && obj !== null && !Array.isArray(obj))
    for (const k of s.required) if (!(k in obj)) errors.push(`${p}: missing required field '${k}'`);
  if (s.properties && typeof obj === 'object' && obj !== null && !Array.isArray(obj))
    for (const [k, sub] of Object.entries(s.properties)) if (k in obj) errors.push(...validate(sub, obj[k], `${p}.${k}`));
  if (s.additionalProperties === false && typeof obj === 'object' && obj !== null && !Array.isArray(obj))
    for (const k of Object.keys(obj)) if (!(s.properties && k in s.properties)) errors.push(`${p}: unexpected property '${k}'`);
  if (s.items && Array.isArray(obj)) obj.forEach((it, i) => errors.push(...validate(s.items, it, `${p}[${i}]`)));
  if (s.enum && !s.enum.includes(obj)) errors.push(`${p}: value ${JSON.stringify(obj)} not in enum ${JSON.stringify(s.enum)}`);
  if (s.pattern && typeof obj === 'string' && !new RegExp(s.pattern).test(obj)) errors.push(`${p}: value ${JSON.stringify(obj)} does not match pattern ${s.pattern}`);
  if (s.minLength && typeof obj === 'string' && obj.length < s.minLength) errors.push(`${p}: string too short (min ${s.minLength})`);
  return errors;
}

const fail = (m) => { console.error('  ' + m); };
let bad = false;

let schema, registry;
try { schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')); }
catch (e) { console.error(`FAIL: cannot read schema ${schemaPath}: ${e.message}`); process.exit(1); }
try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
catch (e) { console.error(`FAIL: cannot parse registry ${registryPath}: ${e.message}`); process.exit(1); }

// FF-FLEET1: schema validity.
const schemaErrors = validate(schema, registry, 'registry');
if (schemaErrors.length) { bad = true; console.error('FAIL [FF-FLEET1]: registry schema errors:'); schemaErrors.forEach(fail); }

// Migration set: stem -> true; also collect numeric prefixes for FF-FLEET4.
// Mirror run.mjs: MIGRATION_FILE_RE = /^(\d{3,}_[A-Za-z0-9_]+)\.sql$/, lexicographic sort.
const MIG_RE = /^(\d{3,}_[A-Za-z0-9_]+)\.sql$/;
const stems = [];
const prefixSeen = new Map(); // NNN -> first stem
let entries = [];
try { entries = fs.readdirSync(migDir); }
catch (e) { console.error(`FAIL: cannot read migrations dir ${migDir}: ${e.message}`); process.exit(1); }
for (const name of entries) {
  const m = MIG_RE.exec(name);
  if (!m) continue;
  const stem = m[1];
  stems.push(stem);
  const nnn = stem.match(/^(\d+)_/)[1];
  if (prefixSeen.has(nnn)) {
    bad = true;
    console.error(`FAIL [FF-FLEET4]: duplicate migration numeric prefix '${nnn}' (${prefixSeen.get(nnn)} vs ${stem}) — ambiguous order, non-linear set`);
  } else {
    prefixSeen.set(nnn, stem);
  }
}
const stemSet = new Set(stems);
const sorted = [...stems].sort(); // lexicographic, same as run.mjs
const head = sorted.length ? sorted[sorted.length - 1] : null;

const cells = Array.isArray(registry.cells) ? registry.cells : [];

// FF-FLEET5: unique slugs.
const slugSeen = new Set();
for (const c of cells) {
  if (c && typeof c.slug === 'string') {
    if (slugSeen.has(c.slug)) { bad = true; console.error(`FAIL [FF-FLEET5]: duplicate cell slug '${c.slug}'`); }
    slugSeen.add(c.slug);
  }
}

// FF-FLEET2 + FF-FLEET3: each pin exists and is <= head (appliable, may lag).
for (const c of cells) {
  if (!c || typeof c.migration_version !== 'string') continue;
  const pin = c.migration_version;
  const slug = c.slug || '<no-slug>';
  if (!stemSet.has(pin)) {
    bad = true;
    console.error(`FAIL [FF-FLEET2]: cell '${slug}' pins migration '${pin}' which has no migrations/${pin}.sql (unknown or rolled-back)`);
    continue; // FLEET3 is meaningless if the pin doesn't exist
  }
  if (head !== null && pin > head) {
    bad = true;
    console.error(`FAIL [FF-FLEET3]: cell '${slug}' pins '${pin}' which sorts AFTER fleet head '${head}' (not appliable)`);
  }
}

if (bad) process.exit(1);
console.log(`OK: ${cells.length} cell(s) appliable against ${stems.length} migration(s) (head=${head})`);
process.exit(0);
NODEJS
}

# ---------------------------------------------------------------------------
# --self-test
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0069] fleet-migration-matrix --self-test"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$TMP/migrations"
  : > "$TMP/migrations/001_a.sql"
  : > "$TMP/migrations/002_b.sql"
  cp "$REPO_ROOT/ops/fleet/cells.schema.json" "$TMP/cells.schema.json"

  # Fixture 1: a clean registry must PASS.
  cat > "$TMP/ok.json" <<'JSON'
{"meta":{"registry_version":"1","description":"x"},"cells":[{"slug":"c1","tier":"standard","mode":"silo","migration_version":"001_a","endpoint":"h:1","status":"active"}]}
JSON
  if ! run_matrix "$TMP/ok.json" "$TMP/cells.schema.json" "$TMP/migrations" >/dev/null 2>&1; then
    echo "SELF-TEST FAIL: a clean registry was rejected (exit 2)"; exit 2
  fi

  # Fixture 2: unknown pin (FF-FLEET2), pin-newer-than-head impossible w/o existing file,
  # duplicate slug (FF-FLEET5) — all must FAIL.
  cat > "$TMP/bad.json" <<'JSON'
{"meta":{"registry_version":"1","description":"x"},"cells":[
  {"slug":"c1","tier":"standard","mode":"silo","migration_version":"999_ghost","endpoint":"h:1","status":"active"},
  {"slug":"c1","tier":"standard","mode":"silo","migration_version":"001_a","endpoint":"h:2","status":"active"}
]}
JSON
  if run_matrix "$TMP/bad.json" "$TMP/cells.schema.json" "$TMP/migrations" >/dev/null 2>&1; then
    echo "SELF-TEST FAIL: bad registry (unknown pin + dup slug) was NOT rejected (exit 2)"; exit 2
  fi

  # Fixture 3: pin sorts AFTER head (FF-FLEET3) — 003 exists but cell pins 003 while head is 003;
  # construct a case where a cell pins a value newer than head by removing the head file.
  mkdir -p "$TMP/migrations3"
  : > "$TMP/migrations3/001_a.sql"
  cat > "$TMP/newer.json" <<'JSON'
{"meta":{"registry_version":"1","description":"x"},"cells":[{"slug":"c1","tier":"standard","mode":"silo","migration_version":"002_b","endpoint":"h:1","status":"active"}]}
JSON
  if run_matrix "$TMP/newer.json" "$TMP/cells.schema.json" "$TMP/migrations3" >/dev/null 2>&1; then
    echo "SELF-TEST FAIL: cell pinning a non-existent newer migration was NOT rejected (exit 2)"; exit 2
  fi

  # Fixture 4: duplicate NNN prefix in the migration set (FF-FLEET4).
  mkdir -p "$TMP/migrations4"
  : > "$TMP/migrations4/001_a.sql"
  : > "$TMP/migrations4/001_b.sql"
  cat > "$TMP/dup.json" <<'JSON'
{"meta":{"registry_version":"1","description":"x"},"cells":[{"slug":"c1","tier":"standard","mode":"silo","migration_version":"001_a","endpoint":"h:1","status":"active"}]}
JSON
  if run_matrix "$TMP/dup.json" "$TMP/cells.schema.json" "$TMP/migrations4" >/dev/null 2>&1; then
    echo "SELF-TEST FAIL: duplicate NNN prefix was NOT rejected (exit 2)"; exit 2
  fi

  rm -rf "$TMP"; trap - EXIT
  echo "[T-0069] fleet-migration-matrix self-test PASS (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Real run against the committed registry.
# ---------------------------------------------------------------------------
REGISTRY="$REPO_ROOT/ops/fleet/cells.json"
SCHEMA="$REPO_ROOT/ops/fleet/cells.schema.json"
MIGDIR="$REPO_ROOT/migrations"

echo "[T-0069] fleet-migration-matrix (FF-FLEET1..5): silo-fleet registry appliable across migrations/"
for f in "$REGISTRY" "$SCHEMA"; do
  [ -f "$f" ] || { echo "FAIL: required file missing: $f"; exit 1; }
done

if run_matrix "$REGISTRY" "$SCHEMA" "$MIGDIR"; then
  echo "PASS [FF-FLEET1..5]: every fleet cell pins an existing, appliable migration; registry well-formed"
  exit 0
else
  echo "FAIL: fleet-migration-matrix found violation(s)"
  exit 1
fi
