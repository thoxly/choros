#!/usr/bin/env bash
# T-0328 · http-route-auth-coverage — durable guard against the agent-facing /
# non-SPA auth bypass class (ADR docs/design/T-0328-agent-facing-auth-model.adr.md §5).
#
# THE BUG CLASS (ADR §2.1): a route NOT wrapped in withAuth sees getAuthContext()
# === undefined in BOTH auth modes, so a dev-only extractActor falls through to the
# x-dev-user header even in keycloak mode — an UNAUTHENTICATED header driving an
# authorization decision. Wrapping the route in withAuth (a) rejects a keycloak-mode
# request with no valid Bearer (401) and (b) populates getAuthContext so a mode-aware
# actor can be read. This guard proves that closure stays closed and a future
# unwrapped route is caught.
#
# THREE FF ARMS (ADR §5):
#  FF-0328-1 — coverage: every src/http/*.ts that registers a route handler
#              (calls `.register(`) is auth-covered: it wraps a handler in
#              `withAuth(` OR is registered through a registration-site façade
#              (withAuthRegistrar / actorInjectRegistrar) at the composition root
#              OR is on the documented ALLOWLIST (public / vendor-signed / known-gap).
#              An unwrapped, non-allowlisted route file → FAIL.
#  FF-0328-2 — no sole-x-dev-user-identity: every `x-dev-user` read in src/http/*.ts
#              (non-comment code) is either inside a `getAuthContext(...) === undefined`
#              dev-fallback branch, or in the actor-inject façade, or in an allowlisted
#              file. A bare x-dev-user read in an otherwise-covered file → FAIL.
#  FF-0328-3 — frozen byte-unchanged: secret-handle.ts + process-start.ts are
#              byte-identical to the merge-base with the integration branch (the G1
#              fix is purely at the registration/wrapper site).
#
# Comment lines are stripped before every grep (lesson T-0143) so prose explaining a
# ban / an allowlist entry does not trip the check. grep rc=1 (no match) is clean;
# rc>=2 is a hard error.
#
# SELF-TEST (`--self-test`): plants an unwrapped, non-allowlisted _probe.ts route and
# asserts FF-0328-1 fires; plants a bare x-dev-user read and asserts FF-0328-2 fires;
# so a broken check turns CI red immediately (FF-SELFTEST).
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HTTP_DIR="${ROOT}/src/http"
ERRORS=0

# ---------------------------------------------------------------------------
# ALLOWLIST (ADR §5 FF-0328-1). Each entry is a src/http file basename that
# registers a route WITHOUT an in-file `withAuth(` wrap, plus the documented
# reason it is exempt. Adding a row here is a CONSCIOUS, reviewed decision.
#
#  secret-handle.ts      — FROZEN keycloak-SSO surface. Auth-covered at the
#                          REGISTRATION SITE by the actor-inject façade
#                          (actorInjectRegistrar in src/server.ts) — the registrar
#                          applies withAuth + injects the resolved identity. The
#                          file itself contains no withAuth( call by design (frozen
#                          body, byte-unchanged). ADR §4.1 / FF-0328-3.
#  vendor-activation.ts  — vendor-SIGNED trust domain (ADR §3.2 / §3.5). /vendor/*
#                          INTENTIONALLY bypasses withAuth; the credential is the
#                          Ed25519 activation-key signature (verifyKey, fail-closed),
#                          NOT a Keycloak JWT. Documented at vendor-activation.ts:90-116.
#  register.ts           — PUBLIC pre-login self-serve registration (POST /api/register).
#                          Anonymous BY DESIGN (FF-1) — there is no identity yet. The
#                          KC user + tenant are CREATED here.
#  rights.ts             — read-only RBAC display plane (GET /api/rights[/:roleId]),
#                          seed/pack fixtures, same public-read posture as the
#                          processes.ts GETs. No identity-bearing write.
#
# T-0489 CLOSED the three former [KNOWN-GAP] entries (report-page-render.ts,
# artifacts.ts, report-pages.ts): each now wraps its handlers in withAuth at the
# registration site (keycloak ⇒ valid Bearer REQUIRED, x-dev-user no longer
# bypasses) and resolves the actor's real tenant (resolveActorTenant, fail-closed)
# instead of the hardcoded Dev Silo. They are therefore REMOVED from this allowlist
# — the guard now proves they are genuinely auth-covered, not merely exempted.
# ---------------------------------------------------------------------------
ALLOWLIST=(
  "secret-handle.ts"
  "vendor-activation.ts"
  "register.ts"
  "rights.ts"
)

is_allowlisted() {
  local name="$1" a
  for a in "${ALLOWLIST[@]}"; do
    [[ "${name}" == "${a}" ]] && return 0
  done
  return 1
}

# grep wrapper: matches on NON-comment code lines only. Comment lines (first
# non-space char is //, * or /*) are stripped FIRST so a URL containing `//` on a
# real code line is NOT mistaken for a comment. rc=1 (no match) is clean; rc>=2 is
# a hard error. (Same idiom as start-route-isolation.sh.)
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

# A file is "auth-covered in-file" if it contains a withAuth( call on a non-comment line.
file_has_withauth() {
  local file="$1"
  [[ -n "$(grep_noncomment 'withAuth\(' "${file}")" ]]
}

# A file "registers a route" if it calls .register( on a non-comment line.
file_registers_route() {
  local file="$1"
  [[ -n "$(grep_noncomment '\.register\(' "${file}")" ]]
}

# ---------------------------------------------------------------------------
# --self-test: plant violations, assert the predicates detect them.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/route-auth-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT

  # (1) FF-0328-1: an unwrapped, non-allowlisted route file must be flagged.
  printf 'router.register("GET", "/api/_probe", async (req, res) => { res.end("x"); });\n' > "$TMP"
  if file_has_withauth "$TMP"; then
    echo "SELF-TEST FAIL: planted unwrapped route falsely reported as withAuth-covered"; exit 2
  fi
  if ! file_registers_route "$TMP"; then
    echo "SELF-TEST FAIL: .register( not detected — coverage check is broken"; exit 2
  fi
  if is_allowlisted "$(basename "$TMP")"; then
    echo "SELF-TEST FAIL: planted probe wrongly allowlisted"; exit 2
  fi

  # (2) FF-0328-1: a withAuth-wrapped route file must pass.
  printf 'router.register("GET", "/api/ok", withAuth(async (req, res) => { res.end("x"); }));\n' > "$TMP"
  if ! file_has_withauth "$TMP"; then
    echo "SELF-TEST FAIL: withAuth( wrap not detected — coverage check is broken"; exit 2
  fi

  # (3) FF-0328-2: a bare x-dev-user read (NOT in a getAuthContext-undefined branch)
  #     must be detectable.
  printf 'const u = req.headers["x-dev-user"];\n' > "$TMP"
  if [[ -z "$(grep_noncomment 'x-dev-user' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: x-dev-user read not detected — FF-0328-2 is broken"; exit 2
  fi
  # And a comment mentioning x-dev-user must be IGNORED (no false positive).
  printf '// the x-dev-user header is the dev fallback only\n' > "$TMP"
  if [[ -n "$(grep_noncomment 'x-dev-user' "$TMP")" ]]; then
    echo "SELF-TEST FAIL: x-dev-user in a COMMENT was not stripped — FF-0328-2 false-positives"; exit 2
  fi

  echo "SELF-TEST PASS: http-route-auth-coverage predicates detect planted violations"
  exit 0
fi

echo "[T-0328] http-route-auth-coverage: auditing src/http route auth posture"

if [[ ! -d "${HTTP_DIR}" ]]; then
  echo "FAIL: ${HTTP_DIR} does not exist"; exit 1
fi

# ---- FF-0328-1: every route-registering file is auth-covered or allowlisted ----
echo ""
echo "Check FF-0328-1: every src/http route file is withAuth-wrapped or allowlisted"
before=${ERRORS}
for f in "${HTTP_DIR}"/*.ts; do
  name="$(basename "$f")"
  # Skip files that register NO route (helpers, registrars, type-only modules).
  file_registers_route "$f" || continue
  if file_has_withauth "$f"; then
    continue  # auth-covered in-file
  fi
  if is_allowlisted "${name}"; then
    continue  # documented exemption (façade-covered / public / vendor-signed / known-gap)
  fi
  echo "FAIL [FF-0328-1]: ${name} registers a route but is neither withAuth-wrapped"
  echo "                  nor on the documented allowlist (a new unwrapped surface?)."
  echo "                  Either wrap its handlers in withAuth(...) / a registrar façade,"
  echo "                  or add it to ALLOWLIST with a documented reason."
  ERRORS=$((ERRORS + 1))
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-0328-1]: all route-registering files are withAuth-wrapped or allowlisted"
fi

# ---- FF-0328-2: no x-dev-user read as sole identity outside a getAuthContext gate ---
# In every NON-allowlisted, withAuth-covered file, any x-dev-user read must sit in a
# block that also references getAuthContext (the mode-aware dev-fallback pattern, e.g.
# processes.ts: `const authCtx = getAuthContext(req); ... else { x-dev-user }`). A file
# that reads x-dev-user but NEVER references getAuthContext is reading the header as the
# SOLE identity — the bug class. The actor-inject façade is the documented exception
# (it sets x-dev-user from the validated JWT, itself getAuthContext-gated).
echo ""
echo "Check FF-0328-2: no x-dev-user as sole identity outside a getAuthContext gate"
before=${ERRORS}
FACADE_FILE="actor-inject-registrar.ts"
# FF-0328-2 exceptions (ADR §5 FF-0328-2): files whose x-dev-user read is fed by the
# registration-site actor-inject façade (the two FROZEN surfaces — the façade resolves
# the JWT identity into x-dev-user, itself getAuthContext-gated):
#   secret-handle.ts / process-start.ts — FROZEN, façade-fed (functional in keycloak).
#
# T-0489 CLOSED the two former [KNOWN-GAP] entries (grant-propose.ts, rights-intents.ts):
# their extractActor is now mode-aware (getAuthContext first → resolveActorSlugFromAuth;
# x-dev-user only as the dev fallback), so each now REFERENCES getAuthContext and passes
# FF-0328-2 on its own merits. They are therefore REMOVED from this exception list.
FF2_EXCEPT=(
  "secret-handle.ts"
  "process-start.ts"
)
in_ff2_except() {
  local name="$1" a
  for a in "${FF2_EXCEPT[@]}"; do [[ "${name}" == "${a}" ]] && return 0; done
  return 1
}
for f in "${HTTP_DIR}"/*.ts; do
  name="$(basename "$f")"
  [[ "${name}" == "${FACADE_FILE}" ]] && continue  # façade sets x-dev-user from the JWT (allowed)
  is_allowlisted "${name}" && continue             # allowlisted posture documented separately
  in_ff2_except "${name}" && continue              # façade-fed frozen surface / documented known-gap
  dev_reads="$(grep_noncomment 'x-dev-user|DEV_USER_HEADER' "$f")"
  [[ -z "${dev_reads}" ]] && continue              # no x-dev-user read → nothing to prove
  if [[ -z "$(grep_noncomment 'getAuthContext' "$f")" ]]; then
    echo "FAIL [FF-0328-2]: ${name} reads x-dev-user but never references getAuthContext"
    echo "                  → it trusts the header as the SOLE identity (bug class). Read"
    echo "                  identity mode-aware (getAuthContext first; x-dev-user only as"
    echo "                  the getAuthContext===undefined dev fallback)."
    echo "${dev_reads}"
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before} ]]; then
  echo "PASS [FF-0328-2]: every x-dev-user read is gated by a getAuthContext check"
fi

# ---- FF-0328-3: frozen files byte-unchanged vs merge-base --------------------
# The G1 fix is purely at the registration/wrapper site; the two frozen surfaces are
# byte-identical to the merge-base with the integration branch. (Mirrors FF-25-6.)
echo ""
echo "Check FF-0328-3: frozen surfaces byte-unchanged vs merge-base"
before=${ERRORS}
FROZEN_FILES=(
  "src/http/secret-handle.ts"
  "src/http/process-start.ts"
)
MERGE_BASE="$(git -C "${ROOT}" merge-base HEAD dev 2>/dev/null || echo "")"
if [[ -z "${MERGE_BASE}" ]]; then
  echo "WARN (FF-0328-3): could not determine merge-base with dev; skipping frozen-file diff"
else
  for rel in "${FROZEN_FILES[@]}"; do
    if git -C "${ROOT}" diff --quiet "${MERGE_BASE}" -- "${rel}" 2>/dev/null; then
      echo "PASS (FF-0328-3): ${rel} byte-unchanged vs merge-base"
    else
      echo "FAIL (FF-0328-3): frozen file modified vs merge-base: ${rel}"
      echo "                  T-0328 closes these surfaces via the registration-site"
      echo "                  actor-inject façade — the frozen body must stay byte-unchanged."
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo ""
  echo "FAIL: http-route-auth-coverage found ${ERRORS} violation(s)"
  exit 1
fi
echo ""
echo "PASS: http-route-auth-coverage (FF-0328-1/2/3) clean"
