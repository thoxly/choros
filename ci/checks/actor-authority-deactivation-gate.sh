#!/usr/bin/env bash
# T-0662 · actor-authority-deactivation-gate — durable anti-recurrence guard for
# the DEACTIVATED-employee authority hole (ADR T-0662; parent T-0658 §3.7).
#
# THE BUG CLASS (T-0658): a resolver that maps an ACTOR's slug → employee id and
# feeds that id into a grant/role/owner/admin AUTHORIZATION decision, WITHOUT the
# `deactivated_at IS NULL` predicate, lets a deactivated employee with a still-live
# KC access token keep their authority. T-0658 found FIVE such bespoke resolvers,
# each patched separately — grep-ripple by one function name misses the others.
# This gate makes the closure STRUCTURAL: it enforces that every registered
# authority actor-resolver carries the predicate, and that no NEW bespoke authority
# `slug = $` employee-lookup slips into an authority module without it.
#
# TWO ARMS (ADR T-0662 §4-5):
#  FF-0662-1 — registry coverage: each function in AUTHORITY_RESOLVERS carries the
#              deactivation predicate (the literal `deactivated_at IS NULL` OR the
#              named marker ACTOR_ACTIVE_SQL from src/db/actor-authority-gate.ts)
#              somewhere in its body. Strip the predicate from any → FAIL.
#  FF-0662-2 — no un-gated NEW authority slug-lookup: in the AUTHORITY_MODULES
#              (the files that host authority resolvers), every
#              `slug = $` employee SELECT sits within some function whose body also
#              references the predicate, UNLESS its enclosing function is on the
#              ALLOWLIST (documented downstream-guarded exception). A bare
#              authority slug-lookup with neither → FAIL.
#
# WHAT IS **NOT** GATED (ADR T-0658 §3.4 / T-0662 §1.1): display / identity-mapping
# (resolveActorSlugFromAuth, humanEmployeeSlugExistsOnClient, actor-resolver.ts),
# SoD constraints (would fail-OPEN if gated), and write-target existence by id
# (`WHERE e.id = $`). This gate deliberately only inspects the AUTHORITY_MODULES
# and the `slug = $` (actor) shape, never the `e.id = $` (target) shape — so it
# does not touch the display invariant.
#
# Comment lines are stripped before every grep (lesson T-0143) so prose naming a
# resolver / the predicate does not trip the check. grep rc=1 (no match) is clean;
# rc>=2 is a hard error.
#
# SELF-TEST (`--self-test`): (1) an authority function missing the predicate → arm
# fires; (2) a function carrying ACTOR_ACTIVE_SQL → passes; (3) an allowlisted
# function without the predicate → passes; (4) a display `e.id = $` lookup → is
# ignored (not authority). A broken gate turns its own self-test red.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

# ---------------------------------------------------------------------------
# REGISTRY (ADR §4.1): every authority actor-resolver. "file:function" pairs.
# Each MUST carry the deactivation predicate in its body. Adding a new authority
# resolver = add a row here AND carry the predicate (or the CI stays red on
# FF-0662-2 when the new bespoke slug-lookup appears un-gated).
# ---------------------------------------------------------------------------
AUTHORITY_RESOLVERS=(
  "src/db/grants-dao.ts:getGrantsForSubject"
  "src/db/org.ts:isGenesisOwnerForTenant"
  "src/db/org.ts:loadAdminContext"
  "src/http/report-page-render.ts:defaultCheckReadGrant"
  "src/http/rights-intents.ts:registerSelfAbsence"
)

# The files that host authority resolvers — the ONLY files FF-0662-2 inspects for
# un-gated NEW authority slug-lookups. (Display/identity/SoD/target files are out
# of scope by construction — see header.)
AUTHORITY_MODULES=(
  "src/db/grants-dao.ts"
  "src/db/org.ts"
  "src/http/report-page-render.ts"
  "src/http/rights-intents.ts"
)

# ---------------------------------------------------------------------------
# ALLOWLIST (ADR §4.2): enclosing functions in the AUTHORITY_MODULES that resolve
# an actor slug WITHOUT the in-resolver predicate BY DESIGN, each with a reason.
#
#  getRoleSlugsForActor (grants-dao.ts) — DOWNSTREAM-GUARDED. Its sole consumer
#    inbox.ts holds its own deactivation gate (T-0588 BLOCK-3/RE-VERIFY,
#    inbox.ts:1413/1631: findEmployeeById + deactivatedAt!=null BEFORE the call).
#    It is a role-slug PROJECTION, not a grant resolver; the guard lives in the
#    caller. A NEW consumer must duplicate the gate OR move the resolver onto the
#    predicate. Documented at grants-dao.ts getRoleSlugsForActor.
# ---------------------------------------------------------------------------
ALLOWLIST=(
  "getRoleSlugsForActor"
)

# The deactivation-predicate markers (literal OR named). Either satisfies coverage.
PREDICATE_MARKERS='deactivated_at IS NULL|ACTOR_ACTIVE_SQL'

is_allowlisted() {
  local name="$1" a
  for a in "${ALLOWLIST[@]}"; do
    [[ "${name}" == "${a}" ]] && return 0
  done
  return 1
}

# Extract a function body: from the line declaring `function <name>(` (with or
# without export/async) up to (but not including) the NEXT top-level
# `export ... function ` OR `^function ` OR `^async function ` declaration, or EOF.
# Good enough for these modules (one-level top-level functions). Comment lines are
# stripped so prose does not leak the marker.
func_body() {
  local file="$1" fn="$2"
  awk -v fn="$fn" '
    # start line: an (export)?(async)? function <fn>(
    $0 ~ ("(^|[^A-Za-z0-9_])function[[:space:]]+" fn "[[:space:]]*\\(") { grab=1 }
    grab==1 && started==1 {
      # a NEW top-level function declaration ends the previous body
      if ($0 ~ /^(export[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]/ && $0 !~ ("function[[:space:]]+" fn "[[:space:]]*\\(")) {
        exit
      }
    }
    grab==1 { print; started=1 }
  ' "$file" \
    | grep -vE '^[[:space:]]*(//|\*|/\*)'
}

# Does string CONTAIN a predicate marker (on a non-comment line)?
body_has_predicate() {
  printf '%s' "$1" | grep -qE "${PREDICATE_MARKERS}"
}

# ---------------------------------------------------------------------------
# --self-test: plant probes, assert the predicates detect them.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/actor-auth-gate-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT

  # (1) authority function MISSING the predicate → body_has_predicate must be false.
  cat > "$TMP" <<'EOF'
export async function proberResolver(pool, tenantId, actorSlug) {
  const { rows } = await client.query(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
    [tenantId, actorSlug],
  );
  return rows;
}
EOF
  body="$(func_body "$TMP" "proberResolver")"
  if body_has_predicate "$body"; then
    echo "SELF-TEST FAIL: un-gated authority function falsely reported as predicate-covered"; exit 2
  fi

  # (2) authority function carrying ACTOR_ACTIVE_SQL → covered.
  cat > "$TMP" <<'EOF'
export async function proberResolver(pool, tenantId, actorSlug) {
  const { rows } = await client.query(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 AND ${ACTOR_ACTIVE_SQL} LIMIT 1`,
    [tenantId, actorSlug],
  );
  return rows;
}
EOF
  body="$(func_body "$TMP" "proberResolver")"
  if ! body_has_predicate "$body"; then
    echo "SELF-TEST FAIL: ACTOR_ACTIVE_SQL marker not detected — coverage arm is broken"; exit 2
  fi

  # (2b) authority function carrying the LITERAL predicate → covered.
  cat > "$TMP" <<'EOF'
export async function proberResolver(pool, tenantId, actorSlug) {
  const { rows } = await client.query(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 AND deactivated_at IS NULL LIMIT 1`,
    [tenantId, actorSlug],
  );
  return rows;
}
EOF
  body="$(func_body "$TMP" "proberResolver")"
  if ! body_has_predicate "$body"; then
    echo "SELF-TEST FAIL: literal deactivated_at IS NULL not detected — coverage arm is broken"; exit 2
  fi

  # (3) allowlisted function name is recognised.
  if ! is_allowlisted "getRoleSlugsForActor"; then
    echo "SELF-TEST FAIL: getRoleSlugsForActor not recognised as allowlisted"; exit 2
  fi
  if is_allowlisted "someBrandNewResolver"; then
    echo "SELF-TEST FAIL: unknown function wrongly reported allowlisted"; exit 2
  fi

  # (4) FF-0662-2 counting: a resolver with TWO actor slug-lookups but only ONE
  #     predicate marker has an un-gated lookup (slug_hits > pred_hits).
  cat > "$TMP" <<'EOF'
export async function proberResolver(pool, tenantId, actorSlug, fallbackSlug) {
  const a = await client.query(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 AND ${ACTOR_ACTIVE_SQL} LIMIT 1`, [tenantId, actorSlug]);
  const b = await client.query(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`, [tenantId, fallbackSlug]);
  return [a, b];
}
EOF
  body="$(func_body "$TMP" "proberResolver")"
  slug_hits="$(printf '%s\n' "${body}" | grep -cE 'slug[[:space:]]*=[[:space:]]*\$[0-9]' || true)"
  pred_hits="$(printf '%s\n' "${body}" | grep -cE "${PREDICATE_MARKERS}" || true)"
  if [[ "${slug_hits}" -le "${pred_hits}" ]]; then
    echo "SELF-TEST FAIL: 2-lookup/1-predicate resolver not detected as un-gated (slug=${slug_hits} pred=${pred_hits})"; exit 2
  fi
  # …and a resolver where BOTH lookups carry the marker is clean.
  cat > "$TMP" <<'EOF'
export async function proberResolver(pool, tenantId, actorSlug, fallbackSlug) {
  const a = await client.query(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 AND ${ACTOR_ACTIVE_SQL} LIMIT 1`, [tenantId, actorSlug]);
  const b = await client.query(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 AND ${ACTOR_ACTIVE_SQL} LIMIT 1`, [tenantId, fallbackSlug]);
  return [a, b];
}
EOF
  body="$(func_body "$TMP" "proberResolver")"
  slug_hits="$(printf '%s\n' "${body}" | grep -cE 'slug[[:space:]]*=[[:space:]]*\$[0-9]' || true)"
  pred_hits="$(printf '%s\n' "${body}" | grep -cE "${PREDICATE_MARKERS}" || true)"
  if [[ "${slug_hits}" -gt "${pred_hits}" ]]; then
    echo "SELF-TEST FAIL: a fully-gated 2-lookup resolver wrongly reported un-gated (slug=${slug_hits} pred=${pred_hits})"; exit 2
  fi

  echo "SELF-TEST PASS: actor-authority-deactivation-gate predicates detect planted violations"
  exit 0
fi

echo "[T-0662] actor-authority-deactivation-gate: auditing authority actor-resolvers"

# Guard: the named marker module exists and exports the canonical predicate.
GATE_MODULE="${ROOT}/src/db/actor-authority-gate.ts"
if [[ ! -f "${GATE_MODULE}" ]]; then
  echo "FAIL: ${GATE_MODULE} missing — the named predicate source of truth is gone"; exit 1
fi
if ! grep -qE 'ACTOR_ACTIVE_SQL[[:space:]]*=[[:space:]]*"deactivated_at IS NULL"' "${GATE_MODULE}"; then
  echo "FAIL: ACTOR_ACTIVE_SQL is not === \"deactivated_at IS NULL\" in ${GATE_MODULE}"
  echo "      (INV-4: the single named predicate must stay the canonical literal)"
  ERRORS=$((ERRORS + 1))
fi

# ---- FF-0662-1: every registered authority resolver carries the predicate -----
echo ""
echo "Check FF-0662-1: every authority resolver carries the deactivation predicate"
before=${ERRORS}
for entry in "${AUTHORITY_RESOLVERS[@]}"; do
  file="${entry%%:*}"
  fn="${entry##*:}"
  path="${ROOT}/${file}"
  if [[ ! -f "${path}" ]]; then
    echo "FAIL [FF-0662-1]: registered file ${file} does not exist (registry stale?)"
    ERRORS=$((ERRORS + 1)); continue
  fi
  body="$(func_body "${path}" "${fn}")"
  if [[ -z "${body}" ]]; then
    echo "FAIL [FF-0662-1]: could not locate function ${fn} in ${file} (renamed? registry stale?)"
    ERRORS=$((ERRORS + 1)); continue
  fi
  if body_has_predicate "${body}"; then
    echo "PASS [FF-0662-1]: ${file}:${fn} carries the deactivation predicate"
  else
    echo "FAIL [FF-0662-1]: ${file}:${fn} is a registered authority resolver but its body"
    echo "                  carries NEITHER 'deactivated_at IS NULL' NOR ACTOR_ACTIVE_SQL."
    echo "                  A deactivated actor would resolve to authority here (T-0658 hole)."
    ERRORS=$((ERRORS + 1))
  fi
done

# ---- FF-0662-2: no SECOND un-gated actor slug-lookup INSIDE a registered resolver -
#
# WHY THIS SHAPE (not "every slug=$ lookup in the module"): the authority modules
# also host legitimate NON-authority slug lookups — findEmployeeById (DISPLAY),
# humanEmployeeSlugExistsOnClient (identity/AUTH mapping — INV-1: must NOT be
# gated), resolveActorTenant (tenant mapping), resolveTenantBySlug (resolves a
# TENANT, not an actor), getRoleAssignmentOrgScopesForEmployee (org-scope read).
# Requiring the predicate on ALL of them would break the display invariant. So
# FF-0662-2 only looks INSIDE the bodies of the REGISTERED authority resolvers
# (FF-0662-1's list): a registered resolver that gains a SECOND actor `slug = $`
# employee-lookup WITHOUT the predicate is the real recurrence risk (a new query
# in a known-authority function that forgets the gate). A genuinely NEW authority
# resolver in a NEW function is admitted the same way http-route-auth-coverage.sh
# admits a new route — a conscious registry addition at review time — and if it
# lands un-gated it fails FF-0662-1 the moment it is registered.
echo ""
echo "Check FF-0662-2: no second un-gated actor slug-lookup inside a registered resolver"
before2=${ERRORS}
for entry in "${AUTHORITY_RESOLVERS[@]}"; do
  file="${entry%%:*}"
  fn="${entry##*:}"
  path="${ROOT}/${file}"
  [[ -f "${path}" ]] || continue
  is_allowlisted "${fn}" && continue
  body="$(func_body "${path}" "${fn}")"
  [[ -z "${body}" ]] && continue
  # Count actor slug=$ employee-lookup lines in this resolver's body.
  slug_hits="$(printf '%s\n' "${body}" | grep -cE 'slug[[:space:]]*=[[:space:]]*\$[0-9]' || true)"
  pred_hits="$(printf '%s\n' "${body}" | grep -cE "${PREDICATE_MARKERS}" || true)"
  # A resolver with N slug-lookups must carry at least N predicate markers (one per
  # lookup) — a second lookup without a matching predicate is the un-gated case.
  if [[ "${slug_hits}" -gt 0 && "${pred_hits}" -lt "${slug_hits}" ]]; then
    echo "FAIL [FF-0662-2]: ${file}:${fn} has ${slug_hits} actor slug-lookup(s) but only"
    echo "                  ${pred_hits} deactivation predicate(s) — a lookup is un-gated."
    echo "                  Add '\${ACTOR_ACTIVE_SQL}' to every actor slug=\$ lookup in this resolver."
    ERRORS=$((ERRORS + 1))
  fi
done
if [[ ${ERRORS} -eq ${before2} ]]; then
  echo "PASS [FF-0662-2]: every actor slug-lookup inside a registered resolver is gated"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo ""
  echo "FAIL: actor-authority-deactivation-gate found ${ERRORS} violation(s)"
  exit 1
fi
echo ""
echo "PASS: actor-authority-deactivation-gate (FF-0662-1/2) clean"
