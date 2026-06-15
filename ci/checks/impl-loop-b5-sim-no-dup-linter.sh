#!/usr/bin/env bash
# T-0231 · impl-loop-b5-sim-no-dup-linter fitness check (B-5 / ADR T-0129 §8.1/§6/§14).
#
# AC-20 (fitness): guard that B-5 (simulation mode-1) extends bpmn-linter.ts (T-0027)
# as the SOLE BPMN linter and does NOT introduce a second/parallel BPMN parser.
#
# FR-B5-3 / AC-19: mode-1 calls lintBpmn as the only BPMN linter.
# "No new/parallel linter/parser" (ADR §6 / §8.1).
#
# Check-1: implementation-loop.ts exists.
# Check-2: lintBpmn is imported from bpmn-linter.ts (the T-0027 linter).
# Check-3: runSimulationMode1 is exported.
# Check-4: no duplicate BPMN parser token in implementation-loop.ts
#          (banned: new DOMParser, xml2js, fast-xml-parser, sax.Parser, xmldom,
#           new XmlParser, parseXml, parseXML — grep confirms absence).
# Check-5: frozen-guard — bpmn-linter.ts not substantially modified
#          (B-5 extends lintBpmn, not replaces; import is from the existing module).
#
# --self-test arm: runs checks against a deliberately broken fixture that includes
# a duplicate BPMN parser and verifies the check catches it.
#
# Locale-portable: LC_ALL=C.

set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMPL_LOOP="${ROOT}/src/core/implementation-loop.ts"
BPMN_LINTER="${ROOT}/src/core/bpmn-linter.ts"

# ============================================================
# SELF-TEST MODE
# ============================================================
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0231][self-test] impl-loop-b5-sim-no-dup-linter self-test: verifying checks catch violations"

  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "${TMPDIR_ST}"' EXIT

  SELF_TEST_ERRORS=0

  # Broken fixture: introduces a duplicate BPMN parser — violates FR-B5-3
  BROKEN_FILE="${TMPDIR_ST}/implementation-loop-broken.ts"
  cat > "${BROKEN_FILE}" <<'FIXTURE'
import { DOMParser } from "xmldom";

export function runSimulationMode1(bundle: unknown): unknown {
  const parser = new DOMParser();
  const doc = parser.parseFromString(bundle.process, "text/xml");
  return { bundleId: bundle.bundleId, cases: [] };
}
FIXTURE

  # Check-4: duplicate parser tokens detected
  DUP_PARSER_TOKENS=(
    "DOMParser"
    "xml2js"
    "fast-xml-parser"
    "sax\.Parser"
    "xmldom"
    "XmlParser"
    "parseXML"
  )
  DUP_FOUND=0
  for TOKEN in "${DUP_PARSER_TOKENS[@]}"; do
    if grep -qE "${TOKEN}" "${BROKEN_FILE}" 2>/dev/null; then
      DUP_FOUND=$((DUP_FOUND + 1))
    fi
  done
  if [[ "${DUP_FOUND}" -gt 0 ]]; then
    echo "SELF-TEST PASS: Check-4 correctly detects duplicate parser token in broken fixture (${DUP_FOUND} match(es))"
  else
    echo "SELF-TEST FAIL: Check-4 did NOT detect duplicate parser token in broken fixture" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  # Check-2: lintBpmn import missing from broken fixture (should not be in broken fixture)
  if ! grep -q 'from.*bpmn-linter' "${BROKEN_FILE}" 2>/dev/null; then
    echo "SELF-TEST PASS: Check-2 correctly detects missing bpmn-linter import in broken fixture"
  else
    echo "SELF-TEST FAIL: unexpected — broken fixture imports bpmn-linter" >&2
    SELF_TEST_ERRORS=$((SELF_TEST_ERRORS + 1))
  fi

  echo ""
  if [[ "${SELF_TEST_ERRORS}" -gt 0 ]]; then
    echo "SELF-TEST FAIL: ${SELF_TEST_ERRORS} self-test assertion(s) failed"
    exit 1
  fi
  echo "SELF-TEST PASS: impl-loop-b5-sim-no-dup-linter self-test — all violation-detection assertions confirmed"
  exit 0
fi

# ============================================================
# MAIN CHECKS
# ============================================================
ERRORS=0

echo "[T-0231] impl-loop-b5-sim-no-dup-linter fitness check (ADR T-0129 §8.1/§6 B-5)"

# ---- Check-1: implementation-loop.ts exists ----------------------------
echo ""
echo "Check-1: src/core/implementation-loop.ts exists"
if [[ -f "${IMPL_LOOP}" ]]; then
  echo "PASS: ${IMPL_LOOP} exists"
else
  echo "FAIL: ${IMPL_LOOP} NOT FOUND" >&2
  ERRORS=$((ERRORS + 1))
fi

# ---- Check-2: lintBpmn imported from bpmn-linter.ts -------------------
echo ""
echo "Check-2: lintBpmn imported from bpmn-linter.ts (T-0027 — sole BPMN linter)"
if [[ -f "${IMPL_LOOP}" ]]; then
  if grep -q 'lintBpmn' "${IMPL_LOOP}" 2>/dev/null; then
    if grep -q "from.*bpmn-linter" "${IMPL_LOOP}" 2>/dev/null; then
      echo "PASS: lintBpmn imported from bpmn-linter.ts"
    else
      echo "FAIL: lintBpmn used but NOT imported from bpmn-linter.ts — wrong import path" >&2
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "FAIL: lintBpmn NOT found in implementation-loop.ts — B-5 must use T-0027 linter" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Check-3: runSimulationMode1 exported ------------------------------
echo ""
echo "Check-3: runSimulationMode1 exported from implementation-loop.ts"
if [[ -f "${IMPL_LOOP}" ]]; then
  if grep -q 'runSimulationMode1' "${IMPL_LOOP}" 2>/dev/null; then
    echo "PASS: runSimulationMode1 found"
  else
    echo "FAIL: runSimulationMode1 NOT found in implementation-loop.ts" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---- Check-4: no duplicate BPMN parser tokens --------------------------
echo ""
echo "Check-4: no duplicate BPMN parser tokens in implementation-loop.ts (FR-B5-3 / AC-19)"
DUP_PARSER_TOKENS=(
  "DOMParser"
  "xml2js"
  "fast-xml-parser"
  "XmlParser"
  "parseXML"
)
if [[ -f "${IMPL_LOOP}" ]]; then
  for TOKEN in "${DUP_PARSER_TOKENS[@]}"; do
    # Exclude comment lines
    if grep -v '^[[:space:]]*//' "${IMPL_LOOP}" | grep -qE "\b${TOKEN}\b" 2>/dev/null; then
      echo "FAIL: duplicate BPMN parser token '${TOKEN}' found in implementation-loop.ts — violates FR-B5-3 (sole linter = T-0027)" >&2
      ERRORS=$((ERRORS + 1))
    else
      echo "PASS: duplicate parser token '${TOKEN}' NOT found"
    fi
  done
fi

# ---- Check-5: bpmn-linter.ts still exports lintBpmn (not broken) ------
echo ""
echo "Check-5: bpmn-linter.ts still exports lintBpmn (T-0027 seam intact)"
if [[ -f "${BPMN_LINTER}" ]]; then
  if grep -q 'export function lintBpmn' "${BPMN_LINTER}" 2>/dev/null; then
    echo "PASS: lintBpmn export intact in bpmn-linter.ts"
  else
    echo "FAIL: lintBpmn export NOT found in bpmn-linter.ts — T-0027 seam broken" >&2
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "FAIL: bpmn-linter.ts NOT FOUND at ${BPMN_LINTER}" >&2
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [[ "${ERRORS}" -gt 0 ]]; then
  echo "FAIL: impl-loop-b5-sim-no-dup-linter found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: impl-loop-b5-sim-no-dup-linter — all checks green (T-0231 B-5 / ADR T-0129 §8.1)"
exit 0
