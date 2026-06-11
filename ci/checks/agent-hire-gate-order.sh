#!/usr/bin/env bash
# FF-HIRE-1: Gate order — validateAdminDelegation must appear BEFORE
# insertAgentRows and createServiceAccountClient in src/http/agents.ts.
#
# Strategy: grep for line numbers of the gate call and each side-effect call,
# then assert gate_line < min(side_effect_lines).

set -euo pipefail

FILE="src/http/agents.ts"

if [ ! -f "$FILE" ]; then
  echo "FAIL FF-HIRE-1: $FILE not found" >&2
  exit 1
fi

# Find gate and side-effect call sites in actual code (not in imports, comments, strings).
# Strategy: use grep -n on the real file, then filter out import lines and comment lines.
# Lines that are actual call sites: they contain "await" or "const <var> = " or "if ("
# followed by the function name, i.e. they are not import/comment lines.

code_line_of() {
  local pattern="$1"
  local file="$2"
  # Get all matching lines with numbers; exclude imports and comment lines
  grep -n "$pattern" "$file" \
    | grep -vE '^[0-9]+:\s*(import |//|\*)' \
    | head -1 | cut -d: -f1
}

GATE_LINE=$(code_line_of "validateAdminDelegation" "$FILE")
if [ -z "$GATE_LINE" ]; then
  echo "FAIL FF-HIRE-1: validateAdminDelegation call site not found in $FILE" >&2
  exit 1
fi

KC_LINE=$(code_line_of "createServiceAccountClient" "$FILE")
DB_LINE=$(code_line_of "insertAgentRows" "$FILE")

if [ -z "$KC_LINE" ] && [ -z "$DB_LINE" ]; then
  echo "FAIL FF-HIRE-1: no side-effect call (createServiceAccountClient or insertAgentRows) found in $FILE" >&2
  exit 1
fi

# Find the minimum side-effect line
FIRST_SIDE_EFFECT="${KC_LINE:-99999}"
if [ -n "$DB_LINE" ] && [ "$DB_LINE" -lt "$FIRST_SIDE_EFFECT" ]; then
  FIRST_SIDE_EFFECT="$DB_LINE"
fi

if [ "$GATE_LINE" -ge "$FIRST_SIDE_EFFECT" ]; then
  echo "FAIL FF-HIRE-1: validateAdminDelegation (line $GATE_LINE) appears AFTER first side-effect (line $FIRST_SIDE_EFFECT) in $FILE" >&2
  exit 1
fi

echo "PASS FF-HIRE-1: gate (line $GATE_LINE) precedes first side-effect (line $FIRST_SIDE_EFFECT)"
