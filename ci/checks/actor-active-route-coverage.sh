#!/usr/bin/env bash
# T-0726 · actor-active-route-coverage — durable guard for "universality of
# ACTOR_ACTIVE" (R-3, flagged by the T-0702 judge + T-0714 architect assessment).
#
# THE BUG CLASS (ADR docs/design/ADR-T0726-actor-active-route-coverage.md §1):
# a deactivated employee's already-issued access-JWT stays cryptographically
# valid until its own exp (offline-JWKS, ~300s realm TTL; T-0702 confirmed KC
# session-revocation cannot shrink this). AUTHENTICATION (http-route-auth-
# coverage.sh, FF-0328) is proven universal — every src/http route is withAuth-
# wrapped. But AUTHENTICATION alone does not enforce deactivation: only the 7
# authority-resolvers registered in actor-authority-deactivation-gate.sh
# (FF-0662) carry the `deactivated_at IS NULL` predicate. A GET route that
# returns tenant data WITHOUT ever calling one of those resolvers (or a
# verified derivative) gives a deactivated actor the SAME read access they had
# before deactivation, for the entire residual JWT window — T-0714 found this
# exact pattern on GET /api/processes[/:id] (tenant-scope-only, zero authority-
# resolver touch). This gate mechanizes the search for the same pattern across
# ALL of src/http and requires each hit to be a conscious WHITELIST decision or
# a tracked FINDING — the same "accounting scan forces triage" idea as
# FF-0662-2, aimed one layer up (route → resolver reachability, not resolver →
# predicate coverage).
#
# WHAT THIS GATE PROVES (FF-726-1): every `.register("GET", ...)` call site in
# src/http/*.ts either (a) has, within its OWN handler block (from its
# `.register(` call to the next `.register(` call in the file, or EOF), a
# reference to one of the ACTIVE_MARKERS below — the 7 T-0662 authority-
# resolvers by name, or one of the verified derivative primitives (each cited
# with file:line evidence in ACTIVE_MARKERS below) that compose one of the 7 —
# or (b) is on ROUTE_WHITELIST with a documented, per-route reason.
#
# WHAT THIS GATE DOES **NOT** PROVE (honest limits, by design — narrow-but-real
# over broad-but-leaky):
#  1. NOT a call-graph proof. It is a TEXT match inside a fixed LINE RANGE (the
#     route's own handler block). A marker referenced only in a MODULE-SCOPE
#     helper defined BEFORE the first `.register(` call (e.g. a file-local
#     `requirePrivilege()`/`checkAdminGrant()` wrapper) is invisible to this
#     scan even when the route genuinely calls that helper — verified cases of
#     this are WHITELISTED by hand with a citation (see WHITELIST §D below),
#     not auto-detected. A future new file-local wrapper needs the SAME manual
#     triage; this is the accepted trade-off documented in R2-P3-1-style notes
#     on the sibling FF-0662-1 gate.
#  2. Block granularity is "this register( call to the next register( call in
#     the SAME file" — NOT brace/paren-tracked. A route whose handler is
#     unusually short and immediately followed by unrelated top-level code
#     (rare in this codebase; every sampled file keeps one handler per block)
#     could theoretically absorb or lose a few trailing lines. Spot-checked
#     against ~80 real routes (self-test + live run) with no observed
#     misattribution.
#  3. Scope is GET routes only (ADR §2 rationale: read-exposure to a live-but-
#     deactivated JWT is the concern; POST/PUT/PATCH/DELETE handlers typically
#     echo validated input rather than broad reads, and mixing verbs would
#     multiply the audit surface without proportionate signal for THIS bug
#     class). A write route that also returns a broad read projection is out
#     of this gate's scope — call it out via code review, not this check.
#  4. Does NOT re-verify that a referenced marker/resolver is *called correctly*
#     (right tenant, right operation) — that is FF-0662's job (resolver
#     internals) and http-route-auth-coverage's job (authentication). This gate
#     only proves the route's text summons SOME ACTOR_ACTIVE-gated primitive at
#     all.
#  5. Status: INFORMATIONAL, NOT wired into `npm run fitness` (see ADR §5). The
#     live tree has REAL, uncontested findings (§C below cites them) that this
#     task does not fix (out of scope, substrate/gate task only) — wiring a
#     currently-red check into the required chain would either mask it behind
#     `||true` (dishonest) or break `npm run fitness` for reasons unrelated to
#     whoever's branch trips it next (the exact anti-pattern the fitness-mask-
#     unmask incident already burned this codebase on once). Promote to
#     required once the FINDINGS below are triaged/closed and the live run is
#     clean.
#
# Comment lines are stripped before every grep (lesson T-0143). grep rc=1 (no
# match) is clean; rc>=2 is a hard error.
#
# SELF-TEST (`--self-test`): (1) a GET route with NO marker, NOT whitelisted →
# caught; (2) a GET route WITH a marker → passes silently; (3) a POST route
# with no marker → OUT OF SCOPE, never flagged (proves method-scoping); (4) a
# whitelisted GET route with no marker → passes via ROUTE_WHITELIST, not a
# marker. A broken gate turns its own self-test red.
#
# Exit 0 always when run without --self-test (informational — see status note
# above); findings are printed but do not fail the process. `--self-test`
# exits non-zero on any assertion failure (the self-test itself is a real gate
# on the MECHANISM, not on the live tree's content).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HTTP_DIR="${ROOT}/src/http"

# ---------------------------------------------------------------------------
# ACTIVE_MARKERS (ADR §3): every identifier whose PRESENCE in a route's own
# handler block is accepted as proof the route consults an ACTOR_ACTIVE-gated
# primitive. Group 1 is the T-0662 AUTHORITY_RESOLVERS registry verbatim
# (actor-authority-deactivation-gate.sh) — changes there must be mirrored here.
# Group 2 is DERIVATIVES: each verified BY HAND, once, to compose a Group-1
# resolver — cited with file:line evidence (ADR §3.2 carries the same table).
# ---------------------------------------------------------------------------
ACTIVE_MARKERS=(
  # --- Group 1: T-0662 AUTHORITY_RESOLVERS registry (verbatim mirror) -------
  "getGrantsForSubject"        # src/db/grants-dao.ts
  "isGenesisOwnerForTenant"    # src/db/org.ts
  "loadAdminContext"           # src/db/org.ts
  "defaultCheckReadGrant"      # src/http/report-page-render.ts
  "registerSelfAbsence"        # src/http/rights-intents.ts
  "assertApproverIsHuman"      # src/http/rights-change-requests.ts
  "checkRole"                  # src/http/binding.ts
  # --- Group 2: verified derivatives (compose a Group-1 resolver) ----------
  "isRecordReadable"           # core/read-visibility.ts pure predicate, fed by
                                # resolveReadVisibility (server.ts:882-892).
  "resolveReadVisibility"      # server.ts:882-892 → getGrantsForSubject.
  "resolveFieldVisibility"     # server.ts:865-868 → getGrantsForSubject.
  "reportAggReadVisibility"    # server.ts:989-995 → getGrantsForSubject.
  "checkReadGrant"             # report-page-render.ts → defaultCheckReadGrant
                                # chain (ADR-T0658 §3.3).
  "resolveActorPrivilege"      # src/db/sandbox-gate-dao.ts:54-71 → composes
                                # loadAdminContext + getGrantsForSubject directly.
  "resolveRecordOp"            # server.ts:1344-1354 (fileReadResolver) →
                                # makeDbGrantSource(grantsPool) → getGrantsForSubject
                                # (grants-dao.ts:397-403).
  "getFileContentUrl"          # core/file-attachment.ts → resolver.resolveRecordOp
                                # (files.ts download route, see WHITELIST §D note).
  "requirePrivilege"           # local file-scoped helper NAME convention (verified
                                # instance: solution-publish.ts:485-496 wraps
                                # resolveActorPrivilege) — see limitation #1 above;
                                # kept as a marker because it is a common enough
                                # naming pattern that a real hit is worth trusting,
                                # but ANY specific instance should be spot-checked.
)

MARKERS_RE="$(printf '%s|' "${ACTIVE_MARKERS[@]}")"
MARKERS_RE="\\b(${MARKERS_RE%|})\\b"

# ---------------------------------------------------------------------------
# ROUTE_WHITELIST (ADR §4): "file:GET:path" entries — a GET route with none of
# ACTIVE_MARKERS in its own block, triaged BY HAND as NOT an authority decision
# (self-scoped / pre-login / vendor-signed / tenant-uniform config-catalog /
# explicitly product-ratified) or as gated via a verified local wrapper the
# text-scan cannot see (limitation #1). Every entry below carries its reason.
# This is a ONE-TIME inventory of the live src/http GET surface (2026-07-10) —
# NOT exhaustive re-verification of every route on every future run; a NEW GET
# route not on this list and without a marker fails FF-726-1 until triaged.
# ---------------------------------------------------------------------------
ROUTE_WHITELIST=(
  # --- A. Pre-login / no actor established yet (mirrors T-0328 register.ts) --
  "auth.ts:GET:/api/auth-config"                          # public OIDC config
  "auth.ts:GET:/api/users"                                # pre-login picker, DEMO_TENANT_SLUG only
  "auth.ts:GET:/api/me"                                   # dev-mode self-echo; keycloak mode 501s

  # --- B. Self-scoped (query/response keyed to the AUTHENTICATED actor's own id) --
  "notifications.ts:GET:/api/notifications"                          # recipient_id = actor (FF-NO-CROSS-USER)
  "notifications.ts:GET:/api/notifications/unread-count"             # same
  "user-prefs.ts:GET:/api/user-prefs"                                # own prefs only
  "assistant.ts:GET:/api/assistant/threads"                          # fetchThreads(client, actorSlug) — own threads
  "assistant.ts:GET:/api/assistant/threads/:id/messages"             # thread ownership implied
  "assistant.ts:GET:/api/assistant/threads/:id/budget"                # thread ownership implied
  "notification-prefs.ts:GET:/api/notification-preferences/self"     # actor's own prefs row
  "list-views.ts:GET:/api/list-views"                                # ownerVisibilityClause: self ∪ tenant-common
  "list-views.ts:GET:/api/list-views/:id"                            # same ownerVisibilityClause

  # --- C. Vendor-signed trust domain, not a Choros actor (mirrors T-0328 §3.2/§3.5) --
  "vendor-activation.ts:GET:/vendor/activation"
  "vendor-activation.ts:GET:/vendor/support/ticket"

  # --- D. Verified gated via a file-local wrapper the block-scan cannot see
  #        (limitation #1) — hand-verified, cited ---------------------------
  "solution-publish.ts:GET:/api/applications/:id/publish-preview"
  #   requirePrivilege() (solution-publish.ts:485-496) wraps resolveActorPrivilege
  #   (owner/admin OR authoring_draft grant); defined before this route's block.
  "notification-prefs.ts:GET:/api/notification-preferences"
  #   deps.checkAdminGrant → defaultCheckAdminGrant (notification-prefs.ts:69-90)
  #   wraps loadAdminContext; defined before this route's block.
  "files.ts:GET:/api/files/:fileVersionId/download"
  #   getFileContentUrl IS an ACTIVE_MARKERS hit inside this route's own block
  #   (files.ts:614) — listed here only for documentation; the marker scan
  #   already passes this route without needing this entry.
  "audit.ts:GET:/api/audit"
  #   requireAuditRead() (audit.ts:554-569) wraps loadAdminContext (owner-only
  #   audit-read gate, T-0500/T-0737); defined before this route's block.
  "audit.ts:GET:/api/audit/export"
  #   T-0737 (was a FINDING — no gate at all before this task): SAME
  #   requireAuditRead() (audit.ts:554-569) as GET /api/audit above.
  "audit.ts:GET:/api/audit/:instanceId"
  #   T-0737 (was a FINDING — no gate at all before this task): SAME
  #   requireAuditRead() (audit.ts:554-569) as GET /api/audit above.

  # --- E. Tenant-uniform config/catalog surfaces — no employee-specific
  #        grant/instance/record decision (mirrors ADR-T0658 §3.4 "display
  #        list" doctrine + T-0328's rights.ts precedent) ------------------
  "applications.ts:GET:/api/applications"
  "applications.ts:GET:/api/applications/:id"
  "process-defs.ts:GET:/api/process-defs"
  "process-defs.ts:GET:/api/process-defs/:key"
  "process-catalog.ts:GET:/api/process-catalog"
  "process-catalog.ts:GET:/api/process-app-bindings"
  "sections.ts:GET:/api/sections"
  "dmn-rule-table.ts:GET:/api/dmn-rule-tables"
  "dmn-rule-table.ts:GET:/api/dmn-rule-tables/:id"
  "registry-defs.ts:GET:/api/registry-defs"
  "registry-defs.ts:GET:/api/registry-defs/:id"
  "email-channel-config.ts:GET:/api/email-channel-config"
  "llm-config.ts:GET:/api/llm-config"
  "llm-connections.ts:GET:/api/llm-connections"
  "grants.ts:GET:/api/rights/dictionaries"
  "rights.ts:GET:/api/rights"                              # role-definition catalog (T-0328 precedent)
  "rights.ts:GET:/api/rights/:roleId"
  "rights-sod.ts:GET:/api/rights/sod-rules"                # SoD RULE definitions, not per-employee violations
  "rights-resources.ts:GET:/api/rights/resources"
  "agents-list.ts:GET:/api/agents"                         # AI-agent roster; secret handle never echoed
  "agents-list.ts:GET:/api/agents/:id"
  "agents.ts:GET:/api/agents/:id/activity"
  "agents.ts:GET:/api/agents/:id/instruction"
  "assistant-prompt-routes.ts:GET:/api/assistant/prompt/:role"
  "report-pages.ts:GET:/api/report-pages"                  # page DEFINITION/layout, not rendered data
  "report-pages.ts:GET:/api/report-pages/:id"
  "app-secret.ts:GET:/api/llm-connections/:id/key/status"  # boolean status only, never the secret
  "secret-handle.ts:GET:/api/agents/:agentId/secret-handle/status"  # same shape
  "files.ts:GET:/api/records/:recordId/files"
  #   LIST is metadata-only (no bytes/url); ratified founder policy T-0521 п.1
  #   "record-level metadata enumeration within a tenant is intentional"
  #   (FF-NOACL, files.ts:540-548). The sibling DOWNLOAD route on this SAME file
  #   IS gated (getFileContentUrl marker, §D above) — this is the exact case
  #   this gate's per-ROUTE (not per-file) granularity exists to distinguish.
  "spend.ts:GET:/api/spend"                                # ratified: "any tenant member can view spend" (spend.ts:12)
  "spend.ts:GET:/api/spend/recent"
  "org.ts:GET:/api/org"                                    # org roster/tree — established tenant-open precedent
  "org.ts:GET:/api/my-tenant"
  "org.ts:GET:/api/org/employee/:id"
  "seed-write.ts:GET:/api/tenants/:slug"                   # tenant existence/slug lookup, pre-tenant-context bootstrap
  "binding.ts:GET:/tenants/:tenantId/processes/:processKey/forms/:formKey/binding"  # form<->process binding config
  "binding.ts:GET:/api/forms/binding"
)

# ---------------------------------------------------------------------------
# entries_for_key <key> — true iff <key> is in ROUTE_WHITELIST.
# ---------------------------------------------------------------------------
is_whitelisted() {
  local want="$1" e
  for e in "${ROUTE_WHITELIST[@]}"; do
    [[ "${e}" == "${want}" ]] && return 0
  done
  return 1
}

# grep wrapper: matches on NON-comment lines only (lesson T-0143).
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

# block_has_marker <file> <startLine> <endLine> — true iff the (comment-
# stripped) line range contains an ACTIVE_MARKERS hit.
block_has_marker() {
  local file="$1" startl="$2" endl="$3" body
  body="$(sed -n "${startl},${endl}p" "${file}" | grep -vE '^[[:space:]]*(//|\*|/\*)')"
  printf '%s' "${body}" | grep -qE "${MARKERS_RE}"
}

# ---------------------------------------------------------------------------
# extract_routes <file> — emit one TSV line per `.register(` call site:
# method<TAB>path<TAB>startLine<TAB>endLine. See ADR §2.2 for the block-
# boundary rationale (this register( call to the next register( call in the
# SAME file, or EOF).
# ---------------------------------------------------------------------------
extract_routes() {
  local file="$1"
  awk '
    BEGIN { WINDOW = 8; n = 0 }
    {
      raw[NR] = $0
      line = $0
      is_comment = (line ~ /^[[:space:]]*(\/\/|\*|\/\*)/)
      if (!is_comment && line ~ /\.register\(/) {
        n++
        anchor[n] = NR
      }
    }
    END {
      total_lines = NR
      for (i = 1; i <= n; i++) {
        start = anchor[i]
        endl = (i < n) ? anchor[i+1] - 1 : total_lines
        buf = ""
        lim = start + WINDOW
        if (lim > total_lines) lim = total_lines
        for (j = start; j <= lim; j++) buf = buf " " raw[j]
        method = ""; path = ""; tmp = buf; ntok = 0
        while (match(tmp, /["'"'"'][^"'"'"']*["'"'"']/) > 0) {
          tok = substr(tmp, RSTART + 1, RLENGTH - 2)
          ntok++
          if (ntok == 1) method = tok
          else if (ntok == 2) { path = tok; break }
          tmp = substr(tmp, RSTART + RLENGTH)
        }
        printf "%s\t%s\t%d\t%d\n", method, path, start, endl
      }
    }
  ' "${file}"
}

# ---------------------------------------------------------------------------
# --self-test: plant probes, assert the predicates detect them.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  TMP="$(mktemp /tmp/actor-active-route-selftest-XXXXXX.ts)"
  trap 'rm -f "$TMP"' EXIT

  # (1) unwrapped GET route, no marker, NOT whitelisted → must be flagged.
  cat > "$TMP" <<'EOF'
export function registerProbeRoutes(router) {
  router.register("GET", "/api/_probe", withAuth(async (req, res) => {
    const tenantId = await resolveActorTenant(actor);
    const rows = await pool.query("SELECT * FROM choros.probe WHERE tenant_id = $1", [tenantId]);
    res.end(JSON.stringify(rows));
  }));
}
EOF
  routes="$(extract_routes "$TMP")"
  found_unmarked=0
  while IFS=$'\t' read -r method path startl endl; do
    [[ "${method}" != "GET" ]] && continue
    if ! block_has_marker "$TMP" "$startl" "$endl"; then
      key="probe.ts:GET:${path}"
      if ! is_whitelisted "$key"; then
        found_unmarked=1
      fi
    fi
  done <<< "$routes"
  if [[ "${found_unmarked}" -ne 1 ]]; then
    echo "SELF-TEST FAIL: unmarked, non-whitelisted GET route NOT detected — FF-726-1 coverage is broken"; exit 2
  fi

  # (2) GET route WITH a marker in its own block → must NOT be flagged.
  cat > "$TMP" <<'EOF'
export function registerProbeRoutes(router) {
  router.register("GET", "/api/_probe_ok", withAuth(async (req, res) => {
    const tenantId = await resolveActorTenant(actor);
    const grants = await getGrantsForSubject(pool, tenantId, actor, Date.now());
    res.end(JSON.stringify(grants));
  }));
}
EOF
  routes="$(extract_routes "$TMP")"
  found_unmarked=0
  while IFS=$'\t' read -r method path startl endl; do
    [[ "${method}" != "GET" ]] && continue
    block_has_marker "$TMP" "$startl" "$endl" || found_unmarked=1
  done <<< "$routes"
  if [[ "${found_unmarked}" -eq 1 ]]; then
    echo "SELF-TEST FAIL: getGrantsForSubject in-block reference NOT detected — marker regex is broken"; exit 2
  fi

  # (3) POST route, no marker → OUT OF SCOPE, never flagged (proves method-scoping).
  cat > "$TMP" <<'EOF'
export function registerProbeRoutes(router) {
  router.register("POST", "/api/_probe_write", withAuth(async (req, res) => {
    const tenantId = await resolveActorTenant(actor);
    await pool.query("INSERT INTO choros.probe (tenant_id) VALUES ($1)", [tenantId]);
    res.end("{}");
  }));
}
EOF
  routes="$(extract_routes "$TMP")"
  saw_post_as_get=0
  while IFS=$'\t' read -r method path startl endl; do
    [[ "${method}" == "GET" ]] && saw_post_as_get=1
  done <<< "$routes"
  if [[ "${saw_post_as_get}" -eq 1 ]]; then
    echo "SELF-TEST FAIL: a POST route was mis-classified as GET — method extraction is broken"; exit 2
  fi

  # (4) whitelisted GET route, no marker → passes via ROUTE_WHITELIST, not a marker.
  ROUTE_WHITELIST+=("probe.ts:GET:/api/_probe_wl")
  cat > "$TMP" <<'EOF'
export function registerProbeRoutes(router) {
  router.register("GET", "/api/_probe_wl", withAuth(async (req, res) => {
    const tenantId = await resolveActorTenant(actor);
    res.end(JSON.stringify({ ok: true }));
  }));
}
EOF
  routes="$(extract_routes "$TMP")"
  while IFS=$'\t' read -r method path startl endl; do
    [[ "${method}" != "GET" ]] && continue
    if block_has_marker "$TMP" "$startl" "$endl"; then
      echo "SELF-TEST FAIL: test (4) fixture unexpectedly has a marker — fixture is wrong"; exit 2
    fi
    if ! is_whitelisted "probe.ts:GET:${path}"; then
      echo "SELF-TEST FAIL: whitelisted route not recognized via ROUTE_WHITELIST — whitelist lookup is broken"; exit 2
    fi
  done <<< "$routes"

  echo "SELF-TEST PASS: actor-active-route-coverage — unmarked/marked/method-scope/whitelist all detect correctly"
  exit 0
fi

# ---------------------------------------------------------------------------
# Live run — informational (see status note in the header). Always exits 0;
# findings are printed as FINDING lines, not FAIL, to make the informational
# status visually unambiguous. A future promotion to `required` flips this to
# a hard FAIL + non-zero exit once FINDINGS below is empty.
# ---------------------------------------------------------------------------
echo "[T-0726] actor-active-route-coverage: auditing GET route -> ACTOR_ACTIVE-resolver reachability"

if [[ ! -d "${HTTP_DIR}" ]]; then
  echo "FAIL: ${HTTP_DIR} does not exist"; exit 1
fi

TOTAL_GET=0
COVERED=0
WHITELISTED=0
FINDINGS=0

for f in "${HTTP_DIR}"/*.ts; do
  [[ -f "$f" ]] || continue
  name="$(basename "$f")"
  routes="$(extract_routes "$f")"
  [[ -z "${routes}" ]] && continue
  while IFS=$'\t' read -r method path startl endl; do
    [[ "${method}" != "GET" ]] && continue
    [[ -z "${path}" ]] && continue
    TOTAL_GET=$((TOTAL_GET + 1))
    key="${name}:GET:${path}"
    if block_has_marker "$f" "$startl" "$endl"; then
      COVERED=$((COVERED + 1))
      continue
    fi
    if is_whitelisted "${key}"; then
      WHITELISTED=$((WHITELISTED + 1))
      continue
    fi
    FINDINGS=$((FINDINGS + 1))
    echo "FINDING [FF-726-1]: ${key} (lines ${startl}-${endl}) — no ACTIVE_MARKERS hit in its own"
    echo "                    handler block and not on ROUTE_WHITELIST. Either the route consults"
    echo "                    an ACTOR_ACTIVE-gated resolver via a pattern this scan cannot see"
    echo "                    (verify by hand and add to ROUTE_WHITELIST §D with a citation), or"
    echo "                    this is a genuine gap (deactivated actor's live JWT reads this route"
    echo "                    unfiltered for its residual ~300s window) — track as a follow-up task."
  done <<< "$routes"
done

echo ""
echo "SUMMARY: ${TOTAL_GET} GET routes audited — ${COVERED} marker-covered, ${WHITELISTED} whitelisted, ${FINDINGS} findings"
if [[ ${FINDINGS} -gt 0 ]]; then
  echo "STATUS: informational (see ADR-T0726 §5) — ${FINDINGS} pre-existing findings, not fixed by this gate."
else
  echo "STATUS: clean — candidate for promotion to required (see ADR-T0726 §5)."
fi
exit 0
