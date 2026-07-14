#!/usr/bin/env bash
# T-0280 · start-route-isolation — static fitness for the start-instance write-path.
#
# ADR T-0278 §5 FF-7: start-instance is the ONLY new write-path to the engine from
# the processes HTTP surface; the GET display-plane routes never mutate / touch the
# engine, and the write-path reaches the engine ONLY through the injected
# FlowableClient (no env reads, no own http client).
#
# Static assertions (grep / boundary analysis — no runtime, no DB) over the new
# module src/http/process-start.ts and the display-plane src/http/processes.ts.
# Mirrors card-action-isolation.sh / connector-isolation.sh. Distinguishes grep
# rc=1 (no match) from rc>=2 (error), and ignores comment lines so prose explaining
# a ban passes (lesson T-0143).
#
#  FF-7-1 — process-start.ts reaches the engine ONLY via the injected client
#           (references flowable.startInstance) and has NO own engine transport
#           (no bare `fetch(`, no http(s)/axios/net import).
#  FF-7-2 — process-start.ts reads NO process.env (the env boundary is the
#           composition root src/server.ts; pool + FlowableClient are injected).
#  FF-7-3 — the display plane src/http/processes.ts does NOT import pg or src/db/*
#           and does NOT call the engine (no .startInstance(/.deployBpmn(/bare
#           fetch() in non-comment code) — its GETs stay read-only.
#
# SELF-TEST (`--self-test`): plants violations in temp copies and asserts the grep
# predicates fire, so a broken check turns CI red immediately (FF-SELFTEST).
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
START_MODULE="${PROJECT_ROOT}/src/http/process-start.ts"
DISPLAY_MODULE="${PROJECT_ROOT}/src/http/processes.ts"
ERRORS=0

# grep wrapper: returns matches on NON-comment code lines.
# Comment lines (first non-space char is //, * or /*) are stripped FIRST via a
# line-anchored predicate, so a URL containing `//` on a real code line is NOT
# mistaken for a comment (lesson: the naive ':[[:space:]]*(//|\*)' filter eats any
# line with `://`). rc=1 (no match) is clean; rc>=2 is a hard error.
grep_noncomment() {
  local pattern="$1" file="$2" out rc
  set +e
  out="$(grep -vE '^[[:space:]]*(//|\*|/\*)' "${file}" | grep -nE "${pattern}")"
  rc=$?
  set -e
  if [[ ${rc} -ge 2 ]]; then
    echo "ERROR: grep failed (rc=${rc}) on pattern '${pattern}' in ${file}"
    exit 2
  fi
  printf '%s' "${out}"
}

# ---------------------------------------------------------------------------
# --self-test: plant violations, assert the predicates detect them.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/start-route-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT

  # plant a bare engine fetch + a process.env read
  printf 'const r = await fetch("http://flowable:8082/runtime/process-instances");\nconst p = process.env["X"];\n' > "$TMP"
  if [[ -z "$(grep_noncomment 'fetch\(' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: bare fetch( not detected — check is broken"; exit 2
  fi
  if [[ -z "$(grep_noncomment 'process\.env' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: process.env not detected — check is broken"; exit 2
  fi

  # plant a pg import — must be detected by the display-plane predicate
  printf "import pg from 'pg';\n" > "$TMP"
  if ! grep -qE "from ['\"]pg['\"]" "$TMP"; then
    echo "SELF-TEST FAIL: pg import not detected — check is broken"; exit 2
  fi
  echo "SELF-TEST PASS: start-route-isolation predicates detect planted violations"
  exit 0
fi

echo "[T-0280] start-route-isolation: checking start-instance write-path boundary"

if [[ ! -f "${START_MODULE}" ]]; then
  echo "FAIL: ${START_MODULE} does not exist"; exit 1
fi
if [[ ! -f "${DISPLAY_MODULE}" ]]; then
  echo "FAIL: ${DISPLAY_MODULE} does not exist"; exit 1
fi

# ---- FF-7-1: engine ONLY via injected client; no own engine transport ---------
before=${ERRORS}
if ! grep -qE "flowable\.startInstance" "${START_MODULE}"; then
  echo "FAIL [FF-7-1]: process-start.ts does not reach the engine via injected flowable.startInstance"
  ERRORS=$((ERRORS + 1))
fi
own_fetch="$(grep_noncomment 'fetch\(' "${START_MODULE}")"
if [[ -n "${own_fetch}" ]]; then
  echo "FAIL [FF-7-1]: process-start.ts has its own fetch( call (engine must be the injected client):"
  echo "${own_fetch}"
  ERRORS=$((ERRORS + 1))
fi
# A VALUE import of an http client (axios) or a RUNTIME `import ... from "node:http(s)/net"`
# / require would be an own transport. `import type {...} from "node:http"` carries NO
# runtime transport (it is type-erased) — route handlers legitimately type req/res from
# it, exactly as process-defs.ts does — so type-only imports are excluded by dropping
# any `import type` line before matching.
own_transport="$(grep_noncomment "from ['\"]axios['\"]" "${START_MODULE}")"
# strip `import type ...` lines first, then look for a value import/require of node http stack
http_value_import="$(grep -vE '^[[:space:]]*import[[:space:]]+type[[:space:]]' "${START_MODULE}" \
  | grep -nE "import[[:space:]].*from ['\"](node:)?(http|https|net)['\"]|require\(['\"](node:)?(http|https|net)['\"]\)" || true)"
if [[ -n "${own_transport}" || -n "${http_value_import}" ]]; then
  echo "FAIL [FF-7-1]: process-start.ts imports an own engine transport (axios / runtime http/https/net):"
  echo "${own_transport}${http_value_import}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-7-1]: engine reached only via injected FlowableClient; no own transport"
fi

# ---- FF-7-2: no env reads in the write-path module ----------------------------
before=${ERRORS}
env_reads="$(grep_noncomment 'process\.env' "${START_MODULE}")"
if [[ -n "${env_reads}" ]]; then
  echo "FAIL [FF-7-2]: process-start.ts reads process.env (env boundary is the composition root):"
  echo "${env_reads}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-7-2]: process-start.ts reads no process.env (pool + client injected)"
fi

# ---- FF-7-3: display plane stays read-only (no pg/db import, no engine call) ---
before=${ERRORS}
if grep -qE "from ['\"]pg['\"]" "${DISPLAY_MODULE}"; then
  echo "FAIL [FF-7-3]: processes.ts imports 'pg' directly (display plane must not)"
  ERRORS=$((ERRORS + 1))
fi
if grep -qE "from ['\"](\.\.\/db\/|.*src/db)" "${DISPLAY_MODULE}"; then
  echo "FAIL [FF-7-3]: processes.ts imports from src/db/* (display plane must not)"
  ERRORS=$((ERRORS + 1))
fi
engine_call="$(grep_noncomment '\.(startInstance|deployBpmn)\(|fetch\(' "${DISPLAY_MODULE}")"
if [[ -n "${engine_call}" ]]; then
  echo "FAIL [FF-7-3]: processes.ts calls the engine directly (GETs must stay read-only):"
  echo "${engine_call}"
  ERRORS=$((ERRORS + 1))
fi
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-7-3]: processes.ts display plane is pg-free and never calls the engine"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo "FAIL: start-route-isolation found ${ERRORS} violation(s)"
  exit 1
fi
echo "PASS: start-route-isolation (FF-7) clean"
