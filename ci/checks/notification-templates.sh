#!/usr/bin/env bash
# T-0172 · Notification templates isolation fitness
# (FF-TEMPLATE-NO-LLM, FF-HTML-ESCAPE, FF-TEMPLATE-CLASS)
#
# FF-NT1 (FF-TEMPLATE-NO-LLM): notification-templates.ts contains no eval(,
#   no LLM/template-engine imports, no IO imports (pg/fetch/http/net).
# FF-NT2 (FF-HTML-ESCAPE): escapeHtml and renderTemplate exported; html-escape
#   is the identity check — grep confirms escapeHtml used in substituteVars path.
# FF-NT3 (pure-core): no pg / node:http / node:net / node:https / fetch imports.
# FF-NT4 (FF-TEMPLATE-CLASS): DataClass imported (not redeclared) from data-classification.ts.
# FF-NT5 (no-audit): no appendAuditEvent call in notification-templates.ts.
# FF-NT6 (renderer-port): defaultTemplateRenderer and TemplateRendererPort import present;
#   no switch/if-else chain on event_kind.
# FF-NT7 (map-only): NOTIFICATION_TEMPLATES is a Map; lookup uses .get(), no switch.
# FF-NT8 (five-kinds): all 5 day-1 event_kinds present in NOTIFICATION_TEMPLATES.
#
# Exit 0 on clean, non-zero on any violation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TEMPLATES="${ROOT}/src/core/notification-templates.ts"
ERRORS=0

echo "[FF-NT] notification-templates: checking T-0172 module constraints"

# ---- Precondition: module exists -------------------------------------------
if [[ ! -f "${TEMPLATES}" ]]; then
  echo "FAIL: ${TEMPLATES} does not exist"
  exit 1
fi

# ---- FF-NT1: no eval / LLM / template-engine imports -----------------------
echo ""
echo "Check FF-NT1 (FF-TEMPLATE-NO-LLM): no eval / LLM / template-engine in templates module"

FORBIDDEN_PATTERNS=(
  "eval[(]"
  "import.*handlebars"
  "import.*ejs"
  "import.*mustache"
  "import.*pug"
  "import.*marked"
  "import.*nunjucks"
  "import.*liquidjs"
  "import.*anthropic"
  "import.*openai"
  "require.*handlebars"
  "require.*ejs"
)
FF_NT1_ERRORS=0
# Strip single-line comments (// ...) before checking — avoids false positives
# from doc-comments that mention the forbidden pattern by name.
TEMPLATES_NO_COMMENTS="$(grep -v '^\s*//' "${TEMPLATES}" | grep -v '^\s*\*')"
for pat in "${FORBIDDEN_PATTERNS[@]}"; do
  grep_rc=0
  echo "${TEMPLATES_NO_COMMENTS}" | grep -qiE "${pat}" 2>/dev/null || grep_rc=$?
  if [[ ${grep_rc} -ge 2 ]]; then
    echo "FAIL (FF-NT1): grep error (exit ${grep_rc}) for pattern: ${pat}"
    FF_NT1_ERRORS=$((FF_NT1_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  elif [[ ${grep_rc} -eq 0 ]]; then
    echo "FAIL (FF-NT1): forbidden pattern found: ${pat}"
    echo "${TEMPLATES_NO_COMMENTS}" | grep -niE "${pat}" || true
    FF_NT1_ERRORS=$((FF_NT1_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${FF_NT1_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-NT1): no eval / LLM / template-engine in notification-templates.ts"
fi

# ---- FF-NT2: escapeHtml exported and used in substitution path -------------
echo ""
echo "Check FF-NT2 (FF-HTML-ESCAPE): escapeHtml exported and called in substitution path"

if ! grep -q "export function escapeHtml" "${TEMPLATES}"; then
  echo "FAIL (FF-NT2): escapeHtml not exported from notification-templates.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT2a): escapeHtml exported"
fi

# Verify escapeHtml is actually called (not just defined) in the substitution path.
# It must appear in non-comment, non-export-definition lines.
ESCAPE_CALL_COUNT=$(grep -v "^export function escapeHtml\|^[[:space:]]*//" "${TEMPLATES}" | grep -c "escapeHtml(" || true)
if [[ "${ESCAPE_CALL_COUNT}" -lt 1 ]]; then
  echo "FAIL (FF-NT2): escapeHtml not called anywhere in notification-templates.ts (only defined?)"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT2b): escapeHtml called in module (${ESCAPE_CALL_COUNT} call site(s))"
fi

# ---- FF-NT3: Pure-core — no IO imports -------------------------------------
echo ""
echo "Check FF-NT3 (pure-core): notification-templates.ts must not import IO modules"

IO_PATTERN="^import.*(\"pg\"|'pg'|\"node:pg\"|'node:pg'|\"node:http\"|'node:http'|\"http\"|'http'|\"https\"|'https'|\"node:https\"|'node:https'|\"node:net\"|'node:net'|\"net\"|'net'|\"fetch\"|'fetch'|\"node:fetch\"|'node:fetch'|\"child_process\"|'child_process'|\"node:child_process\"|'node:child_process')"
if grep -qE "${IO_PATTERN}" "${TEMPLATES}"; then
  echo "FAIL (FF-NT3): notification-templates.ts contains a forbidden IO import"
  grep -E "${IO_PATTERN}" "${TEMPLATES}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT3): no IO imports in notification-templates.ts (pure-core)"
fi

# ---- FF-NT4: DataClass imported, not redeclared ----------------------------
echo ""
echo "Check FF-NT4 (FF-TEMPLATE-CLASS): DataClass imported from data-classification.ts, not redeclared"

if ! grep -q "data-classification" "${TEMPLATES}"; then
  echo "FAIL (FF-NT4): data-classification.ts not imported in notification-templates.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT4a): import from data-classification present"
fi

# Ensure DataClass is not redeclared (no 'type DataClass = ...' or 'interface DataClass' here)
if grep -qE "^(export )?(type|interface) DataClass" "${TEMPLATES}"; then
  echo "FAIL (FF-NT4): DataClass re-declared in notification-templates.ts (should be imported)"
  grep -nE "^(export )?(type|interface) DataClass" "${TEMPLATES}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT4b): DataClass not re-declared"
fi

# ---- FF-NT5: No appendAuditEvent in templates module -----------------------
echo ""
echo "Check FF-NT5 (no-audit): no appendAuditEvent in notification-templates.ts"

if grep -v "^\s*//" "${TEMPLATES}" | grep -q "appendAuditEvent("; then
  echo "FAIL (FF-NT5): appendAuditEvent() found in notification-templates.ts (pure function must not audit)"
  grep -n "appendAuditEvent(" "${TEMPLATES}" | grep -v "^\s*//" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT5): no appendAuditEvent calls in notification-templates.ts"
fi

# ---- FF-NT6: TemplateRendererPort imported; defaultTemplateRenderer exported -----
echo ""
echo "Check FF-NT6 (renderer-port): TemplateRendererPort imported; defaultTemplateRenderer exported"

if ! grep -q "TemplateRendererPort" "${TEMPLATES}"; then
  echo "FAIL (FF-NT6): TemplateRendererPort not referenced in notification-templates.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT6a): TemplateRendererPort referenced"
fi

if ! grep -q "export const defaultTemplateRenderer" "${TEMPLATES}"; then
  echo "FAIL (FF-NT6): defaultTemplateRenderer not exported from notification-templates.ts"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT6b): defaultTemplateRenderer exported"
fi

# ---- FF-NT7: NOTIFICATION_TEMPLATES is a Map; .get() used for lookup ------
echo ""
echo "Check FF-NT7 (map-only): NOTIFICATION_TEMPLATES uses Map + .get() for lookup"

if ! grep -q "export const NOTIFICATION_TEMPLATES" "${TEMPLATES}"; then
  echo "FAIL (FF-NT7): NOTIFICATION_TEMPLATES not exported"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT7a): NOTIFICATION_TEMPLATES exported"
fi

if ! grep -q "new Map(" "${TEMPLATES}"; then
  echo "FAIL (FF-NT7): NOTIFICATION_TEMPLATES is not constructed with new Map()"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT7b): NOTIFICATION_TEMPLATES created as Map"
fi

if ! grep -q "NOTIFICATION_TEMPLATES.get(" "${TEMPLATES}"; then
  echo "FAIL (FF-NT7): NOTIFICATION_TEMPLATES.get() not used — Map-based lookup missing"
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT7c): NOTIFICATION_TEMPLATES.get() used for lookup"
fi

# No switch on eventKind in core render functions.
SWITCH_PATTERN="switch[[:space:]]*[(][[:space:]]*eventKind"
grep_rc=0
grep -qE "${SWITCH_PATTERN}" "${TEMPLATES}" || grep_rc=$?
if [[ ${grep_rc} -ge 2 ]]; then
  echo "FAIL (FF-NT7): grep error (exit ${grep_rc}) for switch pattern"
  ERRORS=$((ERRORS + 1))
elif [[ ${grep_rc} -eq 0 ]]; then
  echo "FAIL (FF-NT7): switch(eventKind) found in notification-templates.ts"
  grep -nE "${SWITCH_PATTERN}" "${TEMPLATES}" || true
  ERRORS=$((ERRORS + 1))
else
  echo "PASS (FF-NT7d): no switch(eventKind) in templates module"
fi

# ---- FF-NT8: all 5 required event_kinds present ----------------------------
echo ""
echo "Check FF-NT8: all 5 day-1 event_kinds present in NOTIFICATION_TEMPLATES"

REQUIRED_EVENTS=("task.assigned" "approval.requested" "sla.warning" "sla.breach" "escalation.raised")
FF_NT8_ERRORS=0
for ev in "${REQUIRED_EVENTS[@]}"; do
  if ! grep -q "\"${ev}\"" "${TEMPLATES}"; then
    echo "FAIL (FF-NT8): required event_kind '${ev}' not found in notification-templates.ts"
    FF_NT8_ERRORS=$((FF_NT8_ERRORS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${FF_NT8_ERRORS} -eq 0 ]]; then
  echo "PASS (FF-NT8): all 5 required event_kinds present"
fi

# ---- Result -----------------------------------------------------------------
echo ""
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: notification-templates found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: notification-templates — all checks green"
exit 0
