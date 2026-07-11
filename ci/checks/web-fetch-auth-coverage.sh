#!/usr/bin/env bash
# T-0668 · web-fetch-auth-coverage — durable, WIDE guard against the "bare fetch"
# auth-bypass class in the browser SPA (web/src).
#
# THE BUG CLASS (whack-a-mole, seen live twice already):
#   A `fetch('/api/…')` issued WITHOUT an auth header. In keycloak mode the
#   Bearer-only gateway rejects it with 401 "missing Authorization" BEFORE the
#   identity ever resolves, so the screen silently falls back to seed data or a
#   false "session not authorized" state. Unit tests DON'T catch it — they mock
#   fetch. Live-proof caught it twice:
#     - ra-grant-trail.jsx  (rights journal showed seed instead of live, T-0648)
#     - fetchEmployees /api/org ("Сотрудник" field dead with 401, T-0649)
#   …and T-0668's own sweep found a third (ra-intents.jsx `/api/rights/dictionaries`)
#   plus the pre-login `/api/users` picker.
#
# THE FIX POSTURE: every /api call from the SPA must carry mode-aware auth — via
#   the shared header helper `authHeaders()` / its alias `devHeaders()` (or a
#   thin per-file wrapper that spreads them, e.g. `apiHeaders()`), or through the
#   canonical `fetchWithAuthRetry()` wrapper (dev-auth.js) which merges
#   authHeaders() itself. In dev mode authHeaders() sends X-Dev-User; in keycloak
#   mode it sends Authorization: Bearer.
#
# WHY THIS GATE IS WIDER THAN THE TWO INCIDENT SITES (memory lesson: a narrow
# gate hides the next hole). It does NOT enumerate the known-bad files; it scans
# EVERY bare `fetch(` in every non-test web/src module and FAILS unless the call
# is provably authenticated OR its host file is on a small, documented allowlist
# of auth-infrastructure modules that genuinely cannot route through authHeaders.
# A truly-bare fetch, an opaque-url fetch with no header, or a NEW file that
# forgets the helper all turn CI red — including the `const u='/api/x'; fetch(u)`
# split-line shape the two incidents did NOT have.
#
# DECISION per bare `fetch(` call (balanced-paren span, comments+string bodies
# masked so a `//` or `)` inside a URL never fools the parser):
#   AUTHED if the call text references an auth source
#     ( authHeaders | devHeaders | buildAuthHeaders | apiHeaders | Authorization
#       | X-Dev-User | x-dev-user | Bearer ),
#   OR the call delegates its headers to a variable (`headers,` shorthand /
#     `headers: someVar`) AND that variable is built from an auth source within
#     the 12 lines immediately above the call (the `const headers = {…authHeaders()}`
#     then `fetch(url,{headers})` shape — ra-role-editor.jsx).
#   Otherwise NOT authed → VIOLATION, UNLESS the URL is a STRING LITERAL that does
#     NOT contain `/api` (a legitimately-unauthenticated external/relative fetch),
#     or the file is ALLOWLISTED.
#
# ALLOWLIST (auth-infrastructure that cannot use authHeaders — documented, each a
# conscious reviewed exemption):
#   app-shell/dev-auth.js      — DEFINES fetchWithAuthRetry; its inner
#                                `fetch(url, buildInit())` merges authHeaders()
#                                via buildInit(). This is the canonical wrapper.
#   app-shell/keycloak-auth.js — OIDC token/refresh endpoint (NOT /api/*, the
#                                external IdP). The request OBTAINS the Bearer, so
#                                by definition it cannot carry one.
#   app-shell/auth-mode.js     — GET /api/auth-config public bootstrap. It runs to
#                                DISCOVER the auth mode before it is known, and
#                                importing authHeaders here would create a
#                                dev-auth ↔ auth-mode circular import. The server
#                                route is public by design (src/http/auth.ts, no
#                                withAuth).
#
# SELF-TEST (`--self-test`): plants (1) a bare fetch('/api/x') → must be flagged;
# (2) a split-line `const u='/api/x'; fetch(u)` opaque bare fetch → must be
# flagged; (3) an authHeaders()-carrying call → must PASS; (4) a headers-var
# delegate with authHeaders 4 lines up → must PASS; (5) an external string-literal
# fetch('https://cdn/x') → must PASS. So a broken/loosened gate turns CI red.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WEB_SRC="${ROOT}/web/src"

# ---------------------------------------------------------------------------
# Node analyzer — written to a temp file (heredoc/quoting hygiene, mirrors
# package-json-no-dup-keys.sh). argv: <rootDir> [--allow=relpath,relpath,...]
# Prints one line per violation; exits 1 if any violation, 0 if clean, 2 on
# internal error.
# ---------------------------------------------------------------------------
write_analyzer() {
  cat > "$1" <<'NODESCRIPT'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

const rootDir = process.argv[2];
let allow = [];
for (const a of process.argv.slice(3)) {
  if (a.startsWith('--allow=')) allow = a.slice('--allow='.length).split(',').filter(Boolean);
}
if (!rootDir || !existsSync(rootDir)) {
  console.error('ANALYZER-ERROR: root dir missing: ' + rootDir);
  process.exit(2);
}

const AUTH_INLINE = /\b(authHeaders|devHeaders|buildAuthHeaders|apiHeaders)\s*\(|Authorization|X-Dev-User|x-dev-user|Bearer/;
const DELEGATES_HEADERS = /\bheaders\s*[,}]|\bheaders\s*:\s*[A-Za-z_$]/;

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules') continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(js|jsx|ts|tsx)$/.test(e)) acc.push(p);
  }
  return acc;
}

// Mask comments and the CONTENTS of string/template literals with spaces so that
// (a) a `fetch(` inside a comment/string is not treated as a call and (b) a `)`
// or `,` inside a URL literal does not break paren/arg balancing. Offsets stay
// aligned with the raw source (we only overwrite, never delete).
function mask(src) {
  const out = src.split('');
  let i = 0; const n = src.length; let st = 'code';
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (st === 'code') {
      if (c === '/' && c2 === '/') { out[i] = out[i + 1] = ' '; i += 2; st = 'line'; continue; }
      if (c === '/' && c2 === '*') { out[i] = out[i + 1] = ' '; i += 2; st = 'block'; continue; }
      if (c === '"') { st = 'dq'; i++; continue; }
      if (c === "'") { st = 'sq'; i++; continue; }
      if (c === '`') { st = 'tpl'; i++; continue; }
      i++; continue;
    }
    if (st === 'line') { if (c === '\n') st = 'code'; else out[i] = ' '; i++; continue; }
    if (st === 'block') { if (c === '*' && c2 === '/') { out[i] = out[i + 1] = ' '; i += 2; st = 'code'; continue; } if (c !== '\n') out[i] = ' '; i++; continue; }
    if (st === 'dq') { if (c === '\\') { i += 2; continue; } if (c === '"') { st = 'code'; i++; continue; } out[i] = ' '; i++; continue; }
    if (st === 'sq') { if (c === '\\') { i += 2; continue; } if (c === "'") { st = 'code'; i++; continue; } out[i] = ' '; i++; continue; }
    if (st === 'tpl') { if (c === '\\') { i += 2; continue; } if (c === '`') { st = 'code'; i++; continue; } out[i] = ' '; i++; continue; }
  }
  return out.join('');
}

function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// First top-level argument of a call, extracted from RAW using the masked span so
// commas inside string/template literals are ignored.
function firstArgRaw(rawCall, maskedCall) {
  // strip leading `fetch` + `(`
  const openRel = maskedCall.indexOf('(');
  let depth = 0, end = -1;
  for (let i = openRel; i < maskedCall.length; i++) {
    const ch = maskedCall[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    else if (ch === ',' && depth === 1) { end = i; break; }
  }
  if (end === -1) end = maskedCall.length - 1;
  return rawCall.slice(openRel + 1, end).trim();
}

const files = walk(rootDir).filter((f) => {
  const rel = relative(rootDir, f);
  return !/\.test\.|\.spec\.|(^|\/)__tests__\//.test(rel);
});

const violations = [];
for (const f of files) {
  const rel = relative(rootDir, f);
  if (allow.includes(rel)) continue;
  const raw = readFileSync(f, 'utf8');
  const masked = mask(raw);
  const maskedLines = masked.split('\n'); // comments + string bodies blanked
  const re = /\bfetch\s*\(/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const idx = m.index;
    const pc = idx > 0 ? masked[idx - 1] : '';
    if (/[A-Za-z0-9_$.]/.test(pc)) continue; // part of a longer ident (fetchX) or a .fetch( method
    const openParen = masked.indexOf('(', idx);
    const close = matchParen(masked, openParen);
    if (close === -1) continue;
    const rawCall = raw.slice(idx, close + 1);
    const maskedCall = masked.slice(idx, close + 1);
    const line = raw.slice(0, idx).split('\n').length;

    let authed = AUTH_INLINE.test(rawCall);
    if (!authed && DELEGATES_HEADERS.test(maskedCall)) {
      // header building may be a few lines above (const headers = {…authHeaders()}).
      // Scan the MASKED window (comments + string bodies blanked) so a comment
      // like `// TODO Authorization` cannot masquerade as real auth; only an
      // actual helper CALL (authHeaders()/devHeaders()/apiHeaders()) counts.
      const from = Math.max(0, line - 1 - 12);
      const window = maskedLines.slice(from, line).join('\n');
      if (/\b(authHeaders|devHeaders|buildAuthHeaders|apiHeaders)\s*\(/.test(window)) authed = true;
    }
    if (authed) continue;

    // Not authed. Allow ONLY string-literal URLs that do not target /api.
    const arg = firstArgRaw(rawCall, maskedCall);
    const isStringLiteral = /^['"`]/.test(arg);
    const targetsApi = /\/api(\/|['"`]|$)/.test(arg) || /\/api\b/.test(rawCall);
    if (isStringLiteral && !targetsApi) continue; // external / relative literal — no auth needed

    const reason = targetsApi
      ? 'bare fetch to /api without an auth header'
      : 'bare fetch to an opaque (variable) URL without an auth header';
    violations.push({ rel, line, reason, snip: rawCall.replace(/\s+/g, ' ').slice(0, 110) });
  }
}

for (const v of violations) {
  console.log(`VIOLATION ${v.rel}:${v.line} — ${v.reason}\n            ${v.snip}`);
}
process.exit(violations.length > 0 ? 1 : 0);
NODESCRIPT
}

# ---------------------------------------------------------------------------
# --self-test: plant fixtures, assert the analyzer flags the bad ones and passes
# the good ones. A broken/loosened analyzer turns CI red here.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp -d /tmp/web-fetch-auth-selftest-XXXXXX)"
  ANALYZER="$(mktemp /tmp/web-fetch-auth-analyzer-XXXXXX.mjs)"
  trap 'rm -rf "$TMP" "$ANALYZER"' EXIT
  write_analyzer "$ANALYZER"

  mkdir -p "$TMP/good" "$TMP/bad"

  # (BAD 1) plain bare fetch to /api
  printf "export function a(){ return fetch('/api/x'); }\n" > "$TMP/bad/bare.js"
  # (BAD 2) split-line opaque URL bare fetch (the shape the incidents did NOT have)
  printf "export function b(){ const u = '/api/x'; return fetch(u); }\n" > "$TMP/bad/opaque.js"
  # (BAD 3) delegate-headers var built WITHOUT a real helper — only a COMMENT
  #         mentions Authorization. The masked-window scan must NOT be fooled.
  printf "export async function g(){\n  // TODO: add Authorization later\n  const headers = { 'Content-Type':'application/json' };\n  return fetch('/api/x', { method:'POST', headers, body:'{}' });\n}\n" > "$TMP/bad/comment-only.js"

  # (GOOD 1) authHeaders inline
  printf "import { authHeaders } from './h.js';\nexport function c(){ return fetch('/api/x', { headers: { ...authHeaders() } }); }\n" > "$TMP/good/inline.js"
  # (GOOD 2) headers-var delegate, authHeaders a few lines up
  printf "import { authHeaders } from './h.js';\nexport async function d(){\n  const headers = { 'Content-Type':'application/json', ...authHeaders() };\n  const r = await fetch('/api/x', { method:'POST', headers, body:'{}' });\n  return r;\n}\n" > "$TMP/good/delegate.js"
  # (GOOD 3) external string-literal fetch — no auth needed, not /api
  printf "export function e(){ return fetch('https://cdn.example.com/x.json'); }\n" > "$TMP/good/external.js"
  # (GOOD 4) a test file with a bare fetch must be IGNORED (scope excludes tests)
  printf "it('x', () => { fetch('/api/x'); });\n" > "$TMP/good/thing.test.js"

  set +e
  BAD_OUT="$(node "$ANALYZER" "$TMP/bad" 2>&1)"; BAD_RC=$?
  GOOD_OUT="$(node "$ANALYZER" "$TMP/good" 2>&1)"; GOOD_RC=$?
  set -e

  fail=0
  if [[ ${BAD_RC} -eq 0 ]]; then
    echo "SELF-TEST FAIL: planted bare fetches were NOT flagged"; echo "$BAD_OUT"; fail=1
  fi
  if ! grep -q "bare.js" <<<"$BAD_OUT"; then
    echo "SELF-TEST FAIL: bare fetch('/api/x') not detected"; fail=1
  fi
  if ! grep -q "opaque.js" <<<"$BAD_OUT"; then
    echo "SELF-TEST FAIL: split-line opaque bare fetch not detected"; fail=1
  fi
  if ! grep -q "comment-only.js" <<<"$BAD_OUT"; then
    echo "SELF-TEST FAIL: delegate-headers with only a COMMENT mentioning Authorization was not flagged"; fail=1
  fi
  if [[ ${GOOD_RC} -ne 0 ]]; then
    echo "SELF-TEST FAIL: legitimately-authed / external / test calls were flagged (false positive)"; echo "$GOOD_OUT"; fail=1
  fi
  if [[ ${fail} -ne 0 ]]; then exit 2; fi
  echo "SELF-TEST PASS: web-fetch-auth-coverage flags bare/opaque /api fetches and passes authed+external+test calls"
  exit 0
fi

# ---------------------------------------------------------------------------
# Normal run: scan web/src with the documented auth-infrastructure allowlist.
# ---------------------------------------------------------------------------
echo "[T-0668] web-fetch-auth-coverage: auditing web/src fetch() auth posture"

if [[ ! -d "${WEB_SRC}" ]]; then
  echo "FAIL: ${WEB_SRC} does not exist"; exit 1
fi

ALLOWLIST="app-shell/dev-auth.js,app-shell/keycloak-auth.js,app-shell/auth-mode.js"

ANALYZER="$(mktemp /tmp/web-fetch-auth-analyzer-XXXXXX.mjs)"
trap 'rm -f "$ANALYZER"' EXIT
write_analyzer "$ANALYZER"

set +e
OUT="$(node "$ANALYZER" "${WEB_SRC}" "--allow=${ALLOWLIST}" 2>&1)"
RC=$?
set -e

if [[ ${RC} -eq 2 ]]; then
  echo "ERROR: analyzer failed to run"; echo "$OUT"; exit 2
fi
if [[ ${RC} -ne 0 ]]; then
  echo ""
  echo "FAIL: web-fetch-auth-coverage found bare /api fetch(es) with no auth header."
  echo "      Route the call through the shared helper — attach { headers: { ...authHeaders() } }"
  echo "      (or use fetchWithAuthRetry from app-shell/dev-auth.js). In keycloak mode a bare"
  echo "      fetch is rejected 401 BEFORE identity resolves → the screen silently shows seed data."
  echo ""
  echo "$OUT"
  exit 1
fi

echo "PASS: web-fetch-auth-coverage — every web/src /api fetch carries mode-aware auth"
