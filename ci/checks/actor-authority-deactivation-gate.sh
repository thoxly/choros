#!/usr/bin/env bash
# T-0662 · actor-authority-deactivation-gate — durable anti-recurrence guard for
# the DEACTIVATED-employee authority hole (ADR T-0662; parent T-0658 §3.7).
#
# THE BUG CLASS (T-0658): a resolver that maps an ACTOR's slug → employee id and
# feeds that id into a grant/role/owner/admin AUTHORIZATION decision, WITHOUT the
# `deactivated_at IS NULL` predicate, lets a deactivated employee with a still-live
# KC access token keep their authority. T-0658 found FIVE such bespoke resolvers,
# each patched separately — grep-ripple by one function name misses the others.
# This gate makes the closure STRUCTURAL: every registered authority actor-resolver
# carries the predicate, AND — crucially — no NEW employee actor slug-lookup slips
# into src/db or src/http un-accounted-for (not a registered resolver, not an
# allowlisted display/read/target/SoD path).
#
# TWO ARMS (ADR T-0662 §4-5):
#  FF-0662-1 — registry coverage: each function in AUTHORITY_RESOLVERS carries the
#              deactivation predicate (the literal `deactivated_at IS NULL` OR the
#              named marker ACTOR_ACTIVE_SQL from src/db/actor-authority-gate.ts)
#              somewhere in its body. Strip the predicate from any → FAIL. A second
#              un-gated actor slug-lookup INSIDE a registered resolver (more
#              slug-lookups than predicate markers) → FAIL.
#  FF-0662-2 — ACCOUNTING SCAN (the real anti-recurrence teeth). It GLOBS every
#              src/db/*.ts and src/http/*.ts (like http-route-auth-coverage.sh globs
#              src/http/*.ts) and, per file, compares:
#                total   = every employee actor `slug = $` / `e.slug = $` lookup
#                          (comment-stripped, inside a `FROM choros.employee` window)
#                accounted = the SAME lookups that fall inside the body of a
#                          registered resolver OR an ALLOWLISTED function for that file.
#              total > accounted ⇒ an employee actor slug-lookup exists that is
#              NEITHER a registered authority resolver NOR a documented allowlist
#              entry — i.e. a NEW un-gated authority path (a new function in an
#              existing file, OR a bespoke lookup in a BRAND-NEW file). → FAIL.
#              This is what forces a conscious registry/allowlist decision on every
#              new employee actor-lookup, realising ADR FC-3 / INV-2.
#
# WHAT IS **NOT** GATED (ADR T-0658 §3.4 / T-0662 §1.1): display / identity-mapping,
# tenant-mapping, SoD constraints (fail-OPEN if gated), agent-budget reads, and
# read-only projections. These are real employee slug-lookups but they are NOT
# authority decisions that a deactivated actor could ride; each is on the ALLOWLIST
# below with a per-entry reason (a one-time inventory of the live authority surface).
# Write-target existence by id (`WHERE e.id = $`) is a DIFFERENT shape and never
# matched by this gate at all (it inspects the `slug = $` actor shape only).
#
# Comment lines are stripped before every grep/count (lesson T-0143) so prose naming
# a resolver / the predicate does not trip the check. grep rc=1 (no match) is clean.
#
# SELF-TEST (`--self-test`): plants (1) an un-gated authority function MISSING the
# predicate → coverage predicate is false; (2) ACTOR_ACTIVE_SQL / literal → covered;
# (3) the JUDGE ATTACKS as accounting-scan negatives — a NEW function with a bespoke
# lookup in an existing authority file AND a bespoke lookup in a NEW file must both
# read as UN-ACCOUNTED (total > accounted); (4) a registered-but-RENAMED/missing
# function reaches the graceful FAIL branch (N-1). A broken gate turns its own
# self-test red.
#
# Exit 0 on clean, non-zero on any violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ERRORS=0

# ---------------------------------------------------------------------------
# REGISTRY (ADR §4.1): every authority actor-resolver that MUST carry the
# deactivation predicate. "file:function" pairs. Removing a predicate from any →
# FF-0662-1 FAIL. A NEW authority resolver added here without the predicate also
# fails FF-0662-1; a NEW authority lookup NOT added here (and not allowlisted)
# fails the FF-0662-2 accounting scan.
# ---------------------------------------------------------------------------
AUTHORITY_RESOLVERS=(
  "src/db/grants-dao.ts:getGrantsForSubject"
  "src/db/org.ts:isGenesisOwnerForTenant"
  "src/db/org.ts:loadAdminContext"
  "src/http/report-page-render.ts:defaultCheckReadGrant"
  "src/http/rights-intents.ts:registerSelfAbsence"
)

# ---------------------------------------------------------------------------
# ALLOWLIST (ADR §4.2): "file:function" pairs that resolve an employee actor slug
# but are NOT authority-by-deactivation decisions — each with a documented reason.
# This is a ONE-TIME, complete inventory of the live employee actor-lookup surface
# in src/db + src/http (2026-07-07): every `slug = $` employee lookup is EITHER a
# registered authority resolver above OR one of these. The FF-0662-2 accounting
# scan proves the inventory is complete (total == accounted on a clean tree); a NEW
# lookup that is neither breaks the scan red until it is triaged into one bucket.
#
#  DISPLAY / IDENTITY (INV-1 — gating these breaks name-display & re-activation):
#   org.ts:findEmployeeById                 — resolve slug → {name,kind} for DISPLAY.
#   org.ts:humanEmployeeSlugExistsOnClient  — sub→slug AUTHENTICATION mapping (ADR §3
#                                             variant-(a) rejection; gating = 401-on-all).
#   org.ts:resolveActorTenant               — resolves the actor's TENANT (BYPASSRLS),
#                                             not an authority grant.
#  READ-ONLY PROJECTIONS (report what a subject already has; endpoint authz upstream):
#   pdp-explain.ts:loadSubjectGrants        — /pdp-explain diagnostic: reports the
#                                             subject's grants for display; the route
#                                             is authz-gated (self-query or admin) before
#                                             this read. Showing a deactivated subject's
#                                             would-be grants is DISPLAY, not authority.
#   rights-overview.ts:resolveCallerEmployeeId — resolves caller id to scope the
#                                             "self" projection of a read-only overview.
#   rights-sod.ts:checkSodForSubject        — SoD read (returns constraint violations
#                                             for a subject); a CONSTRAINT view, not a grant.
#  SoD CONSTRAINT (fail-OPEN if gated — ADR §1.1):
#   sod-dao.ts:effectiveAssignmentsOf       — SoD is a RESTRICTION; subtracting a
#                                             deactivated actor's assignments = "no
#                                             violation" = fail-OPEN. Must NOT be gated.
#  KIND CHECK (human vs agent — orthogonal to deactivation):
#   rights-change-requests.ts:assertApproverIsHuman — rejects AGENT approvers
#                                             (dual-control). A deactivated HUMAN is
#                                             still human; this guard is not the
#                                             deactivation control (that lives on the
#                                             grant/approve path it precedes).
#  SUBSTITUTION READS (resolve target employee for substitution-rule reads):
#   substitution-dao.ts:getActiveSubstitutionsForEmployee   — reads rules for an
#                                             absent employee; not an authorizing lookup.
#   substitution-dao.ts:getActiveSubstitutionsForSubstitute — symmetric.
#  AGENT / NOTIFICATION (agents have no deactivated_at; display-only):
#   assistant.ts:fetchBudget                — agent budget read (agent slug; no
#                                             deactivation mechanism on agents).
#   assistant.ts:captureConfigRequest       — resolves requester id to NAME them in a
#                                             notification body and skip self-notify.
#   solution-bundles.ts:resolveActorType    — resolves actor human/agent TYPE for
#                                             display/branching (getAuthContext-first).
#  DOWNSTREAM-GUARDED authority projection (ADR §1.2 / §4.2):
#   grants-dao.ts:getRoleSlugsForActor      — role-slug PROJECTION. Its sole consumer
#                                             inbox.ts holds its own deactivation gate
#                                             (T-0588 BLOCK-3/RE-VERIFY,
#                                             inbox.ts:1413/1631: findEmployeeById +
#                                             deactivatedAt!=null BEFORE the call). A NEW
#                                             consumer must duplicate the gate OR move
#                                             the resolver onto the predicate.
# ---------------------------------------------------------------------------
ALLOWLIST=(
  "src/db/org.ts:findEmployeeById"
  "src/db/org.ts:humanEmployeeSlugExistsOnClient"
  "src/db/org.ts:resolveActorTenant"
  "src/http/pdp-explain.ts:loadSubjectGrants"
  "src/http/rights-overview.ts:resolveCallerEmployeeId"
  "src/http/rights-sod.ts:checkSodForSubject"
  "src/db/sod-dao.ts:effectiveAssignmentsOf"
  "src/http/rights-change-requests.ts:assertApproverIsHuman"
  "src/db/substitution-dao.ts:getActiveSubstitutionsForEmployee"
  "src/db/substitution-dao.ts:getActiveSubstitutionsForSubstitute"
  "src/http/assistant.ts:fetchBudget"
  "src/http/assistant.ts:captureConfigRequest"
  "src/http/solution-bundles.ts:resolveActorType"
  "src/db/grants-dao.ts:getRoleSlugsForActor"
)

# The dirs the accounting scan globs (mirrors http-route-auth-coverage's HTTP_DIR glob).
SCAN_DIRS=("src/db" "src/http")

# The deactivation-predicate markers (literal OR named). Either satisfies coverage.
PREDICATE_MARKERS='deactivated_at IS NULL|ACTOR_ACTIVE_SQL'

# The employee-actor slug-lookup shape: bare `slug = $N` (unqualified) OR `e.slug = $N`
# (the employee alias). Deliberately NOT `r.slug`/`t.slug` (role/tenant) and NOT
# `e.id = $` (write-target). Used to COUNT lookups inside a `FROM choros.employee`
# window and inside function bodies.
SLUG_LOOKUP_SHAPE='(^|[^A-Za-z0-9_.])slug[[:space:]]*=[[:space:]]*\$[0-9]|[^A-Za-z0-9_]e\.slug[[:space:]]*=[[:space:]]*\$[0-9]'

# EMP_WINDOW: how many lines after a `FROM choros.employee` a `slug = $` may sit and
# still count as that SELECT's actor lookup (multi-line SQL).
EMP_WINDOW=8

# ---------------------------------------------------------------------------
# entries_for_file <file-rel> — echo the "file:function" registry+allowlist entries
# whose file part == <file-rel> (one function name per line).
# ---------------------------------------------------------------------------
entries_for_file() {
  local want="$1" e
  for e in "${AUTHORITY_RESOLVERS[@]}" "${ALLOWLIST[@]}"; do
    [[ "${e%%:*}" == "${want}" ]] && printf '%s\n' "${e##*:}"
  done
}

# Is "file:function" a registered authority resolver?
is_registered() {
  local pair="$1" e
  for e in "${AUTHORITY_RESOLVERS[@]}"; do [[ "${e}" == "${pair}" ]] && return 0; done
  return 1
}

# ---------------------------------------------------------------------------
# func_body <file> <fn> — extract a function/method body. Anchors on a top-level
# `function <fn>(` OR a class-method DECLARATION `  (async)? <fn>(` (a call line —
# ending in `;` — is NOT an anchor). From the anchor, tracks net brace depth and
# stops after the closing `}` of the function. Comment lines are stripped from the
# OUTPUT so prose does not leak markers. Robust to inner arrows / subqueries /
# scoped blocks. N-1: the trailing `grep -vE` is guarded with `|| true` so an empty
# body (missing/renamed function) does NOT trip pipefail before the caller's
# graceful diagnostic branch runs.
# ---------------------------------------------------------------------------
func_body() {
  local file="$1" fn="$2"
  awk -v fn="$fn" '
    function trim(s){ sub(/^[[:space:]]+/,"",s); sub(/[[:space:]]+$/,"",s); return s }
    function is_decl_anchor(l,   t) {
      if (l ~ ("(^|[^A-Za-z0-9_])function[[:space:]]+" fn "[[:space:]]*\\(")) return 1
      if (l ~ ("^[[:space:]]+(public[[:space:]]+|private[[:space:]]+|protected[[:space:]]+)?(async[[:space:]]+)?" fn "[[:space:]]*\\(")) {
        t=trim(l)
        if (t ~ /;[[:space:]]*(\/\/.*)?$/) return 0   # a call statement — not a declaration
        return 1
      }
      return 0
    }
    !grab && is_decl_anchor($0) { grab=1; depth=0; opened=0 }
    grab {
      line=$0
      n=gsub(/{/,"{",line); depth+=n
      m=gsub(/}/,"}",line); depth-=m
      if (n>0) opened=1
      print $0
      if (opened && depth<=0) exit
    }
  ' "$file" \
    | { grep -vE '^[[:space:]]*(//|\*|/\*)' || true; }
}

# Count employee actor slug-lookups in the given TEXT (already comment-stripped by
# func_body, or raw — we strip again for safety). Non-comment lines only.
count_lookups_in_text() {
  printf '%s\n' "$1" \
    | { grep -vE '^[[:space:]]*(//|\*|/\*)' || true; } \
    | { grep -cE "${SLUG_LOOKUP_SHAPE}" || true; }
}

# Count employee actor slug-lookups in a whole FILE, restricted to lines that sit
# within an EMP_WINDOW-line window after a `FROM choros.employee` (so a `slug = $`
# on a tenant/role/application table is not miscounted). Comment lines ignored.
# NB: awk EMITS the in-window non-comment lines and `grep -cE` counts the shape —
# BSD awk mangles a `\$` in a *dynamic* regex (`line ~ shape`), so the shape match
# MUST run through grep, not awk's `~`.
count_lookups_in_file() {
  awk -v EMP_WINDOW="${EMP_WINDOW}" '
    { line=$0 }
    line ~ /^[[:space:]]*(\/\/|\*|\/\*)/ { next }               # comment — skip
    line ~ /FROM[[:space:]]+choros\.employee/ { emp=EMP_WINDOW }
    emp>0 { print; emp-- }
  ' "$1" \
    | { grep -cE "${SLUG_LOOKUP_SHAPE}" || true; }
}

# Does string CONTAIN a predicate marker (on a non-comment line)?
body_has_predicate() {
  printf '%s' "$1" | grep -qE "${PREDICATE_MARKERS}"
}

# ---------------------------------------------------------------------------
# --self-test: plant probes, assert the predicates & accounting scan detect them.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMPDIR_ST="$(mktemp -d /tmp/actor-auth-gate-selftest-XXXXXX)"
  trap 'rm -rf "$TMPDIR_ST"' EXIT
  TMP="${TMPDIR_ST}/probe.ts"

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

  # (3) FF-0662-1 per-resolver counting: a resolver with TWO actor slug-lookups but
  #     only ONE predicate marker has an un-gated lookup (slug_hits > pred_hits).
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
  slug_hits="$(count_lookups_in_text "$body")"
  pred_hits="$(printf '%s\n' "${body}" | grep -cE "${PREDICATE_MARKERS}" || true)"
  if [[ "${slug_hits}" -le "${pred_hits}" ]]; then
    echo "SELF-TEST FAIL: 2-lookup/1-predicate resolver not detected as un-gated (slug=${slug_hits} pred=${pred_hits})"; exit 2
  fi

  # ===================================================================
  # (4) ACCOUNTING SCAN — the JUDGE ATTACKS as fakeroot negatives.
  #     Build a tiny fakeroot with a src/db + src/http, plant the two attacks,
  #     and assert the accounting predicate (total > accounted) fires for each.
  # ===================================================================
  # accounted_for_file_in <rootdir> <file-rel> — sum lookups inside the registry+
  # allowlist function bodies KNOWN for that file. (Uses the SAME entries the live
  # scan uses; the self-test plants functions whose names are NOT registered, so
  # they contribute 0 to accounted and MUST show up as total>accounted.)
  accounted_for_file_in() {
    local rootdir="$1" rel="$2" fn acc=0 c
    while IFS= read -r fn; do
      [[ -z "$fn" ]] && continue
      c="$(count_lookups_in_text "$(func_body "${rootdir}/${rel}" "$fn")")"
      acc=$((acc + c))
    done < <(entries_for_file "$rel")
    printf '%s' "$acc"
  }

  FR="${TMPDIR_ST}/fakeroot"
  mkdir -p "${FR}/src/db" "${FR}/src/http"

  # ATTACK (a): a NEW file src/http/foo.ts with a bespoke un-gated authority lookup.
  cat > "${FR}/src/http/foo.ts" <<'EOF'
export async function isFooAllowed(pool, tenantId, actorSlug) {
  const { rows } = await pool.query(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
    [tenantId, actorSlug],
  );
  return rows.length > 0 ? "allow" : "deny";
}
EOF
  total_a="$(count_lookups_in_file "${FR}/src/http/foo.ts")"
  acc_a="$(accounted_for_file_in "${FR}" "src/http/foo.ts")"
  if [[ "${total_a}" -le "${acc_a}" ]]; then
    echo "SELF-TEST FAIL: JUDGE ATTACK (a) — new-file bespoke authority lookup NOT caught"
    echo "                (src/http/foo.ts total=${total_a} accounted=${acc_a}); scan is toothless"; exit 2
  fi

  # ATTACK (b): a NEW un-gated authority function appended INTO an existing authority
  #     file (org.ts). We simulate org.ts as: one KNOWN accounted function + one NEW
  #     bespoke un-gated function. The KNOWN one is accounted; the NEW one is not →
  #     total (2) > accounted (1).
  cat > "${FR}/src/db/org.ts" <<'EOF'
export async function findEmployeeById(pool, tenantId, slug) {
  const { rows } = await pool.query(
    `SELECT e.slug FROM choros.employee e WHERE e.tenant_id = $1 AND e.slug = $2`,
    [tenantId, slug],
  );
  return rows[0] ?? null;
}
export async function isFooOwner(pool, tenantId, actorSlug) {
  const { rows } = await pool.query(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
    [tenantId, actorSlug],
  );
  return rows.length > 0;
}
EOF
  total_b="$(count_lookups_in_file "${FR}/src/db/org.ts")"
  acc_b="$(accounted_for_file_in "${FR}" "src/db/org.ts")"
  if [[ "${total_b}" -le "${acc_b}" ]]; then
    echo "SELF-TEST FAIL: JUDGE ATTACK (b) — new authority fn in an existing authority file NOT caught"
    echo "                (org.ts total=${total_b} accounted=${acc_b}); scan is toothless"; exit 2
  fi

  # (4c) POSITIVE control: a file whose ONLY lookup IS an accounted function must be
  #      clean (total == accounted) — no false positive on the display path.
  cat > "${FR}/src/db/clean.ts" <<'EOF'
export async function findEmployeeById(pool, tenantId, slug) {
  const { rows } = await pool.query(
    `SELECT e.slug FROM choros.employee e WHERE e.tenant_id = $1 AND e.slug = $2`,
    [tenantId, slug],
  );
  return rows[0] ?? null;
}
EOF
  # register.ts a temporary mapping: we reuse the real allowlist entry name
  # findEmployeeById by pointing the accounting at src/db/org.ts's entries. Here we
  # assert directly: a lone accounted function has total==accounted.
  total_c="$(count_lookups_in_file "${FR}/src/db/clean.ts")"
  acc_c="$(count_lookups_in_text "$(func_body "${FR}/src/db/clean.ts" "findEmployeeById")")"
  if [[ "${total_c}" -ne "${acc_c}" ]]; then
    echo "SELF-TEST FAIL: accounting false-positive — a lone accounted display fn read as un-gated (total=${total_c} acc=${acc_c})"; exit 2
  fi

  # (5) N-1: a REGISTERED-but-missing/renamed function reaches the graceful FAIL
  #     branch. func_body on a nonexistent function returns EMPTY (not an error), so
  #     the caller's `[[ -z body ]]` diagnostic fires. Assert empty body + clean rc.
  cat > "$TMP" <<'EOF'
export async function someOtherResolver(pool, tenantId, actorSlug) {
  return [];
}
EOF
  set +e
  missing_body="$(func_body "$TMP" "isGenesisOwnerForTenantV2_renamed")"
  rc_fb=$?
  set -e
  if [[ ${rc_fb} -ne 0 ]]; then
    echo "SELF-TEST FAIL: func_body on a MISSING function errored (rc=${rc_fb}) under set -e/pipefail"
    echo "                — the graceful 'renamed? registry stale?' branch is unreachable (N-1)"; exit 2
  fi
  if [[ -n "${missing_body}" ]]; then
    echo "SELF-TEST FAIL: func_body returned a body for a function that does not exist"; exit 2
  fi

  echo "SELF-TEST PASS: actor-authority-deactivation-gate — coverage + accounting-scan"
  echo "                (incl. judge attacks a/b, positive control, N-1 missing-fn) all detect."
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
    echo "                  Update AUTHORITY_RESOLVERS to the new name, or restore the function."
    ERRORS=$((ERRORS + 1)); continue
  fi
  # A registered resolver with N actor slug-lookups must carry >= N predicate markers.
  slug_hits="$(count_lookups_in_text "${body}")"
  pred_hits="$(printf '%s\n' "${body}" | grep -cE "${PREDICATE_MARKERS}" || true)"
  if [[ "${slug_hits}" -gt 0 && "${pred_hits}" -lt "${slug_hits}" ]]; then
    echo "FAIL [FF-0662-1]: ${file}:${fn} has ${slug_hits} actor slug-lookup(s) but only"
    echo "                  ${pred_hits} deactivation predicate(s) — a lookup is un-gated."
    echo "                  Add '\${ACTOR_ACTIVE_SQL}' to every actor slug=\$ lookup in this resolver."
    ERRORS=$((ERRORS + 1))
  elif [[ "${slug_hits}" -eq 0 ]] && ! body_has_predicate "${body}"; then
    echo "FAIL [FF-0662-1]: ${file}:${fn} is a registered authority resolver but its body"
    echo "                  carries NEITHER an actor slug-lookup NOR the predicate — registry stale?"
    ERRORS=$((ERRORS + 1))
  else
    echo "PASS [FF-0662-1]: ${file}:${fn} carries the deactivation predicate on all ${slug_hits} lookup(s)"
  fi
done

# ---- FF-0662-2: ACCOUNTING SCAN — no un-accounted employee actor slug-lookup ---
#
# GLOB every src/db/*.ts and src/http/*.ts. Per file: total employee actor
# slug-lookups vs the lookups that fall inside a REGISTERED or ALLOWLISTED function.
# total > accounted ⇒ a lookup exists that is neither → a NEW un-gated authority
# path (new function, or a bespoke lookup in a brand-new file). This is the real
# anti-recurrence teeth (ADR FC-3 / INV-2): every new employee actor-lookup forces a
# conscious registry/allowlist triage or CI stays red.
echo ""
echo "Check FF-0662-2: accounting scan — every employee actor slug-lookup is registered or allowlisted"
before2=${ERRORS}
for dir in "${SCAN_DIRS[@]}"; do
  dpath="${ROOT}/${dir}"
  [[ -d "${dpath}" ]] || continue
  for f in "${dpath}"/*.ts; do
    [[ -f "$f" ]] || continue
    rel="${f#${ROOT}/}"
    total="$(count_lookups_in_file "$f")"
    [[ "${total}" -eq 0 ]] && continue   # no employee actor lookup in this file
    # Sum lookups inside registered + allowlisted function bodies for this file.
    accounted=0
    while IFS= read -r fn; do
      [[ -z "$fn" ]] && continue
      c="$(count_lookups_in_text "$(func_body "$f" "$fn")")"
      accounted=$((accounted + c))
    done < <(entries_for_file "${rel}")
    if [[ "${total}" -gt "${accounted}" ]]; then
      echo "FAIL [FF-0662-2]: ${rel} has ${total} employee actor slug-lookup(s) but only ${accounted}"
      echo "                  fall inside a registered resolver / allowlisted function."
      echo "                  A NEW un-gated employee actor-lookup exists. Triage it:"
      echo "                    • authority (grant/role/owner/admin)? → carry \${ACTOR_ACTIVE_SQL}"
      echo "                      and add file:function to AUTHORITY_RESOLVERS."
      echo "                    • display/identity/tenant/SoD/read/agent/downstream-guarded?"
      echo "                      → add file:function to ALLOWLIST with a documented reason."
      ERRORS=$((ERRORS + 1))
    fi
  done
done
if [[ ${ERRORS} -eq ${before2} ]]; then
  echo "PASS [FF-0662-2]: every employee actor slug-lookup in src/db + src/http is accounted for"
fi

if [[ ${ERRORS} -gt 0 ]]; then
  echo ""
  echo "FAIL: actor-authority-deactivation-gate found ${ERRORS} violation(s)"
  exit 1
fi
echo ""
echo "PASS: actor-authority-deactivation-gate (FF-0662-1/2) clean"
