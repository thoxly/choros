#!/usr/bin/env bash
# T-0200
# T-0125 · card-action-isolation — static fitness for the card-action primitive.
#
# Static assertions (grep / boundary analysis — no runtime, no DB) over the new
# pure-core module src/core/card-action.ts. Mirrors connector-isolation.sh /
# effect-resource-isolation.sh. Distinguishes grep rc=1 (no match) from rc>=2
# (error), and ignores comment lines so prose explaining a ban passes (lesson
# T-0143).
#
#  FF-CA-1 — Visibility/executability is decided by `resolveFor` (PDP). The module
#            references resolveFor and carries NO UI-flag authorizer tokens
#            (actionEnabled / canShow / allowedFlag) in non-comment code.
#  FF-CA-2 — `operation`/`semantics` only from the closed enums. No new
#            `*Operation*`/`*Right*` declaration token in the module; semantics →
#            operation map resolves only onto existing Operation members.
#  FF-CA-3 — terminate/message run ONLY through the engine-bridge (FlowableClient);
#            the module has NO own fetch/http(s)/axios/net to the engine.
#  FF-CA-4 — action↔fields binding uses `checkBindingCompat` (T-0072), not a
#            second/fourth consistency mechanism (no redeclared *bindingCheck*).
#
# Pure-core (mirrors FF-CONN-2): the module imports no pg/fs/net/http(s)/
# child_process and contains no bare fetch( call.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODULE="${PROJECT_ROOT}/src/core/card-action.ts"
ERRORS=0

echo "[T-0200/T-0125] card-action-isolation: checking module boundary"

if [[ ! -f "${MODULE}" ]]; then
  echo "FAIL: ${MODULE} does not exist"
  exit 1
fi

# grep wrapper: returns matches, treats rc=1 (no match) as clean, rc>=2 as error.
grep_noncomment() {
  local pattern="$1" file="$2" out rc
  set +e
  out="$(grep -nE "${pattern}" "${file}" | grep -vE ":[[:space:]]*(//|\*)")"
  rc=$?
  set -e
  if [[ ${rc} -ge 2 ]]; then
    echo "ERROR: grep failed (rc=${rc}) on pattern '${pattern}' in ${file}"
    exit 2
  fi
  printf '%s' "${out}"
}

# ---- FF-CA-1: PDP is the arbiter; no UI-flag authorizer -----------------------
before=${ERRORS}
if ! grep -qE "resolveFor" "${MODULE}"; then
  echo "FAIL [FF-CA-1]: card-action.ts does not reference resolveFor (PDP must be the arbiter)"
  ERRORS=$((ERRORS + 1))
fi
UI_FLAG_TOKENS=(
  "actionEnabled"
  "canShow"
  "allowedFlag"
  "alwaysAllow"
)
for token in "${UI_FLAG_TOKENS[@]}"; do
  matches="$(grep_noncomment "${token}" "${MODULE}")"
  if [[ -n "${matches}" ]]; then
    echo "FAIL [FF-CA-1]: card-action.ts references a UI-flag authorizer token '${token}':"
    echo "${matches}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-CA-1]: resolveFor is the arbiter; no UI-flag authorizer"
fi

# ---- FF-CA-2: closed enums; no new right-type / Operation widening ------------
before=${ERRORS}
# Ban a NEW right/operation type DECLARATION inside the module (a `type|enum
# *Operation*`/`*Right*`). Referencing the imported Operation type is fine.
new_right="$(grep_noncomment "(type|enum)[[:space:]]+[A-Za-z]*((Operation)|(Right))" "${MODULE}")"
if [[ -n "${new_right}" ]]; then
  echo "FAIL [FF-CA-2]: card-action.ts declares a new Operation/Right type (closed enum must be reused):"
  echo "${new_right}"
  ERRORS=$((ERRORS + 1))
fi
# The semantics → operation map must resolve only onto existing Operation members.
# Extract the RHS values of SEMANTICS_TO_OPERATION and confirm each is in the
# grant-lattice Operation union.
LATTICE="${PROJECT_ROOT}/src/core/grant-lattice.ts"
# Operation union members are the `| "verb"` lines between `export type Operation`
# and the first line that is NOT a `| "..."` continuation.
op_union="$(awk '/export type Operation/{f=1;next} \
  f&&!/^[[:space:]]*\|/{exit} \
  f&&match($0,/"[a-z_]+"/){t=substr($0,RSTART+1,RLENGTH-2); print t}' "${LATTICE}" \
  | sort -u | tr '\n' ' ')"
# The map RHS values are the `<key>: "<op>"` object-literal lines inside the
# SEMANTICS_TO_OPERATION block (skips the `: Readonly<...>` type annotation and
# any key/comment tokens — only a quoted RHS after a colon counts).
map_ops="$(awk '/SEMANTICS_TO_OPERATION/{f=1} f&&/}[[:space:]]*as const/{exit} \
  f&&/^[[:space:]]*[a-z_]+:[[:space:]]*"[a-z_]+"/{print}' "${MODULE}" \
  | grep -oE ':[[:space:]]*"[a-z_]+"' | grep -oE '"[a-z_]+"' | tr -d '"' \
  | sort -u | tr '\n' ' ')"
if [[ -z "${map_ops}" ]]; then
  echo "FAIL [FF-CA-2]: could not extract the semantics → operation map values"
  ERRORS=$((ERRORS + 1))
else
  for op in ${map_ops}; do
    if [[ " ${op_union} " != *" ${op} "* ]]; then
      echo "FAIL [FF-CA-2]: map resolves onto '${op}' which is NOT a grant-lattice Operation member [${op_union}]"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-CA-2]: closed enums; semantics map resolves only onto existing Operation members"
fi

# ---- FF-CA-3: single channel to the engine (no own http client) ---------------
before=${ERRORS}
FORBIDDEN_NET=(
  "from.*['\"]pg['\"]"
  "from.*['\"].*node:fs['\"]"
  "from.*['\"]fs['\"]"
  "from.*['\"].*node:net['\"]"
  "from.*['\"]net['\"]"
  "from.*['\"].*node:http['\"]"
  "from.*['\"]http['\"]"
  "from.*['\"].*node:https['\"]"
  "from.*['\"]https['\"]"
  "from.*['\"]axios['\"]"
  "from.*['\"].*node:child_process['\"]"
)
for pattern in "${FORBIDDEN_NET[@]}"; do
  if grep -Eq "${pattern}" "${MODULE}"; then
    echo "FAIL [FF-CA-3]: card-action.ts contains a forbidden net/io import matching: ${pattern}"
    ERRORS=$((ERRORS + 1))
  fi
done
fetch_calls="$(grep_noncomment "fetch\(" "${MODULE}")"
if [[ -n "${fetch_calls}" ]]; then
  echo "FAIL [FF-CA-3]: card-action.ts contains a fetch( call (engine path must go via the bridge):"
  echo "${fetch_calls}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-CA-3]: no own http/net client (terminate/message go via the engine bridge)"
fi

# ---- FF-CA-4: one binding-consistency mechanism (checkBindingCompat) ----------
before=${ERRORS}
if ! grep -qE "checkBindingCompat" "${MODULE}"; then
  echo "FAIL [FF-CA-4]: card-action.ts does not reference checkBindingCompat (T-0072 reuse required)"
  ERRORS=$((ERRORS + 1))
fi
# Ban a redeclared second binding/dep consistency function.
redeclared="$(grep -nE '^(export )?function (checkBindingCompat|bindingCheck|depResolve)' "${MODULE}" || true)"
if [[ -n "${redeclared}" ]]; then
  echo "FAIL [FF-CA-4]: card-action.ts redeclares a binding/dep mechanism (must reuse checkBindingCompat):"
  echo "${redeclared}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-CA-4]: one binding-consistency mechanism (checkBindingCompat reused)"
fi

# ---- Result -------------------------------------------------------------------
if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: card-action-isolation found ${ERRORS} violation(s)"
  exit 1
fi

echo "PASS: card-action-isolation — all checks green (FF-CA-1..4)"
exit 0
