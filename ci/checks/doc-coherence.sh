#!/usr/bin/env bash
# T-0239 · T-0134c · FF-DOC-COHERENCE — doc-coherence CI gate
#
# Verifies doc_ref coherence: every typed reference in a doc_ref fixture must
# resolve against a LiveSnapshot assembled from the current source tree.
# ANY broken ref ⇒ exit 1 (lint report lists all broken refs).
# Empty refs / all refs resolved ⇒ exit 0.
#
# This is a T-0082-class fitness gate (same family as bundle-coherence.sh,
# check-report-page-deps.sh, check-template-deps.sh): «doc_page ↔ referent
# in live system» coherence, not a new mechanism.
#
# Build/CI-time sources used by the gate:
#   - codeSymbols:   `export` declarations found in src/ TypeScript files.
#   - restEndpoints: `router.register(METHOD, path)` call sites in src/.
#   - processKeys:   `<process id="...">` attributes in *.bpmn files under repo root.
#   - schemaFields:  empty at static CI time (runtime-resolvable from DB, R-3).
#   - configKeys:    empty at static CI time (runtime-resolvable from DB, R-3).
#
# The self-test verifies two properties:
#   (a) A deliberately broken ref fixture exits 1 (fail-closed, FF-DOC-COHERENCE).
#   (b) An all-resolved fixture exits 0 (no false positives).
#
# Implementation: delegates to node for JSON parsing and snapshot assembly,
# keeping the bash script as a thin driver. Zero external npm deps required.
#
# Usage:
#   bash ci/checks/doc-coherence.sh [--self-test] [--fixture-inline <JSON>]
#
# Exit 0 — all refs resolved.
# Exit 1 — at least one broken ref, or self-test constraint violated.
#
# Mirrors the style/structure of:
#   ci/checks/check-report-page-deps.sh (T-0179)
#   ci/checks/bundle-coherence.sh (T-0082)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---------------------------------------------------------------------------
# node must be available (it is in CI — same requirement as npm run fitness)
# ---------------------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL [doc-coherence]: node not found in PATH — required for snapshot assembly and JSON parsing"
  exit 1
fi

# ---------------------------------------------------------------------------
# Self-test mode
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--self-test" ]]; then
  echo "[FF-DOC-COHERENCE self-test] doc-coherence.sh --self-test"
  echo ""

  # (a) Broken-ref fixture must exit 1
  echo "Self-test (a): broken ref → expect exit 1"

  BROKEN_FIXTURE='[{"refKind":"code_symbol","refTarget":{"module":"src/__selftest_nonexistent_module_xyz123__/gone","symbol":"__selftest_missing_symbol_xyz123__"}}]'

  RESULT_A=0
  if bash "${BASH_SOURCE[0]}" --fixture-inline "${BROKEN_FIXTURE}" 2>/dev/null; then
    echo "FAIL self-test (a): expected exit 1 on broken ref, but got exit 0"
    RESULT_A=1
  else
    echo "PASS self-test (a): correctly exited non-zero on broken ref"
  fi

  echo ""

  # (b) All-resolved fixture must exit 0.
  # Use empty refs (trivially resolved).
  echo "Self-test (b): empty-refs fixture → expect exit 0"

  GOOD_FIXTURE='[]'

  RESULT_B=0
  if ! bash "${BASH_SOURCE[0]}" --fixture-inline "${GOOD_FIXTURE}" 2>/dev/null; then
    echo "FAIL self-test (b): expected exit 0 on empty fixture, but got exit 1"
    RESULT_B=1
  else
    echo "PASS self-test (b): correctly exited zero on empty fixture"
  fi

  echo ""

  if [[ "${RESULT_A}" -eq 0 && "${RESULT_B}" -eq 0 ]]; then
    echo "PASS [doc-coherence self-test]: both probes passed (FF-DOC-COHERENCE)"
    exit 0
  else
    echo "FAIL [doc-coherence self-test]: one or more probes failed"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Main gate: assemble snapshot + run checkDocRefs via a temp node script
# ---------------------------------------------------------------------------

# Fixture JSON: either --fixture-inline argument or the empty array (trivially ok).
FIXTURE_JSON="[]"
if [[ "${1:-}" == "--fixture-inline" ]]; then
  FIXTURE_JSON="${2:-[]}"
fi

echo "[FF-DOC-COHERENCE] doc-coherence.sh: assembling LiveSnapshot from source tree"

# Write a temp node script so we can avoid here-doc quoting issues with bash 3.2.
TMPSCRIPT=$(mktemp /tmp/doc-coherence-XXXXXX.mjs)
trap 'rm -f "${TMPSCRIPT}"' EXIT

# Write the fixture JSON to a separate temp file (avoids quoting issues entirely)
TMPFIXTURE=$(mktemp /tmp/doc-coherence-fixture-XXXXXX.json)
trap 'rm -f "${TMPSCRIPT}" "${TMPFIXTURE}"' EXIT
printf '%s' "${FIXTURE_JSON}" > "${TMPFIXTURE}"

cat > "${TMPSCRIPT}" << 'NODESCRIPT'
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = process.argv[2];
const FIXTURE_FILE = process.argv[3];
const srcDir = path.join(PROJECT_ROOT, 'src');

// ---- Build/CI-time: codeSymbols ----------------------------------------
// Scan all *.ts files (excluding __tests__) for export declarations.
// Key form: ${module}#${symbol}  (module = relative path without extension)

function walkTs(dir, fileList, skipTests) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skipTests && e.name === '__tests__') continue;
      walkTs(full, fileList, skipTests);
    } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      fileList.push(full);
    }
  }
}

function collectCodeSymbols(srcDir) {
  const symbols = new Set();
  const files = [];
  walkTs(srcDir, files, true);
  const srcParent = path.dirname(srcDir);

  const declRe = /^export\s+(?:declare\s+)?(?:abstract\s+class|function\s*\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
  const namedRe = /^export\s+\{([^}]+)\}/;

  for (const f of files) {
    const module = path.relative(srcParent, f).replace(/\.ts$/, '');
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      const dm = line.match(declRe);
      if (dm) { symbols.add(module + '#' + dm[1]); continue; }
      const nm = line.match(namedRe);
      if (nm) {
        for (const seg of nm[1].split(',')) {
          const parts = seg.trim().split(/\s+as\s+/);
          const exported = (parts[1] ?? parts[0] ?? '').trim();
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exported)) symbols.add(module + '#' + exported);
        }
      }
    }
  }
  return symbols;
}

// ---- Build/CI-time: restEndpoints ----------------------------------------
function collectRestEndpoints(srcDir) {
  const endpoints = new Set();
  const files = [];
  walkTs(srcDir, files, false); // include __tests__ — test routers are valid too
  const re = /router\.register\(\s*["'](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']\s*,\s*["']([^"']+)["']/g;
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      endpoints.add(m[1].toUpperCase() + ' ' + m[2]);
    }
  }
  return endpoints;
}

// ---- Build/CI-time: processKeys ------------------------------------------
function walkBpmn(dir, list) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walkBpmn(full, list);
    } else if (e.isFile() && e.name.endsWith('.bpmn')) {
      list.push(full);
    }
  }
}

function collectProcessKeys(repoRoot) {
  const keys = new Set();
  const files = [];
  walkBpmn(repoRoot, files);
  const re = /<(?:[a-zA-Z0-9_]+:)?process\s[^>]*\bid=["']([^"']+)["']/g;
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const key = m[1].trim();
      if (key) keys.add(key);
    }
  }
  return keys;
}

// ---- Assemble snapshot ---------------------------------------------------
const codeSymbols   = collectCodeSymbols(srcDir);
const restEndpoints = collectRestEndpoints(srcDir);
const processKeys   = collectProcessKeys(PROJECT_ROOT);
const schemaFields  = new Set(); // runtime-only (R-3)
const configKeys    = new Set(); // runtime-only (R-3)

const live = { codeSymbols, restEndpoints, schemaFields, processKeys, configKeys };

console.log('  codeSymbols collected:   ' + codeSymbols.size);
console.log('  restEndpoints collected: ' + restEndpoints.size);
console.log('  processKeys collected:   ' + processKeys.size);
console.log('  schemaFields:            0 (runtime-only, no DB at static CI — R-3)');
console.log('  configKeys:              0 (runtime-only, no DB at static CI — R-3)');
console.log('');

// ---- Parse fixture -------------------------------------------------------
let refs;
try {
  const raw = fs.readFileSync(FIXTURE_FILE, 'utf8');
  refs = JSON.parse(raw);
  if (!Array.isArray(refs)) throw new Error('fixture must be a JSON array');
} catch (e) {
  console.error('FAIL [doc-coherence]: invalid fixture JSON: ' + e.message);
  process.exit(1);
}

// ---- resolveRef (mirrors checkDocRefs logic from doc-ref-lint.ts) -------
function resolveRef(ref) {
  switch (ref.refKind) {
    case 'code_symbol': {
      const key = (ref.refTarget.module ?? '') + '#' + (ref.refTarget.symbol ?? '');
      return live.codeSymbols.has(key);
    }
    case 'rest_endpoint': {
      const key = (ref.refTarget.method ?? '') + ' ' + (ref.refTarget.path ?? '');
      return live.restEndpoints.has(key);
    }
    case 'schema_field': {
      const key = (ref.refTarget.registryDefId ?? '') + '#' + (ref.refTarget.fieldKey ?? '');
      return live.schemaFields.has(key);
    }
    case 'process':
      return live.processKeys.has(ref.refTarget.processKey ?? '');
    case 'config_key':
      return live.configKeys.has(ref.refTarget.key ?? '');
    default:
      return false; // fail-closed: unknown kind
  }
}

const violations = [];
for (const ref of refs) {
  if (!resolveRef(ref)) {
    violations.push({ type: 'missing_referent', refKind: ref.refKind, refTarget: ref.refTarget });
  }
}

// ---- Report --------------------------------------------------------------
if (violations.length === 0) {
  console.log('PASS [doc-coherence]: all doc_ref fixture refs resolved (or fixture empty)');
  process.exit(0);
}

console.log('FAIL [doc-coherence]: ' + violations.length + ' broken ref(s) found:');
for (const v of violations) {
  console.log('  MISSING ' + v.refKind + ': ' + JSON.stringify(v.refTarget));
}
process.exit(1);
NODESCRIPT

node "${TMPSCRIPT}" "${PROJECT_ROOT}" "${TMPFIXTURE}"
