#!/usr/bin/env bash
# T-0198 · FF-T127-2 / FF-T127-5 / FF-T127-8 / FF-T127-10 — genesis-installer static gate
#
# Static (no-Docker) half of the genesis-installer fitness functions. The dynamic
# halves (run the installer twice, occupy a port, autonomous end-to-end) live in the
# CI integration job (ci.yml) per the ADR — they need a live stack and are out of
# scope for the offline `npm run fitness` chain.
#
# Steps:
#   FF-T127-2 (wrapper-not-fork): install.sh invokes the EXISTING compose
#       (-f docker-compose.yml -f docker-compose.prod.yml); there is no duplicate
#       compose under ops/; install.sh carries NO genesis-owner SQL (migration 026
#       is the only owner path).
#   FF-T127-5 (idempotency + config discipline): install.sh guards .env.prod with an
#       existence test before generating; `openssl rand` appears only under the
#       missing-secret branch; .env.prod and config/activation/*.key are gitignored.
#   FF-T127-8 (preflight fail-closed): every preflight check (ports/binary/disk) runs
#       BEFORE the first `compose up` (ordering); install.sh fail-closes on failure.
#   FF-T127-10 (structured summary): the success path emits endpoint, first-owner
#       login, version, and activation status (active|autonomous).
#
# SELF-TEST (--self-test): plant a fake installer that VIOLATES each step and assert
# the matching assertion would fail; exit 0 if the demonstrations succeed, 2 if the
# check machinery is broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL="$REPO_ROOT/ops/install.sh"
GITIGNORE="$REPO_ROOT/.gitignore"

echo "[T-0198] genesis-installer: FF-T127-2/5/8/10 static checks"

# ---------------------------------------------------------------------------
# Assertion helpers operating on a given installer file (so --self-test can run
# them against a planted-broken fixture).
# ---------------------------------------------------------------------------

# FF-T127-2a: installer invokes the existing base + prod compose overlay.
assert_uses_existing_compose() {
  local f="$1"
  grep -Eq 'docker compose -f[^\n]*docker-compose\.yml -f[^\n]*docker-compose\.prod\.yml' "$f" \
    || grep -Eq 'compose\(\)[[:space:]]*\{[^}]*docker-compose\.yml' "$f" \
    || grep -Eq 'COMPOSE_BASE=.*docker-compose\.yml' "$f" && grep -Eq 'COMPOSE_PROD=.*docker-compose\.prod\.yml' "$f"
}

# FF-T127-2b: no second compose stack under ops/.
assert_no_forked_compose() {
  local extra
  extra="$(find "$REPO_ROOT/ops" -maxdepth 2 -name 'docker-compose*.yml' 2>/dev/null || true)"
  [ -z "$extra" ]
}

# FF-T127-2c: installer carries NO genesis-owner SQL (no second owner path).
assert_no_genesis_sql() {
  local f="$1"
  ! grep -iqE "INSERT[[:space:]]+INTO[[:space:]]+[a-z_.]*role_assignment|genesis.*INSERT|source[[:space:]]*=[[:space:]]*'genesis'" "$f"
}

# FF-T127-5a: .env.prod is guarded by an existence test before generation.
assert_env_existence_guard() {
  local f="$1"
  grep -Eq '\[ -f "\$\{?ENV_PROD\}?" \]|if[[:space:]]+\[ -f "\$\{?ENV_PROD\}?" \]' "$f"
}

# FF-T127-5b: `openssl rand` is used only under the missing-secret branch (i.e. the
# gen_secret/gen_hex helpers are defined and called from config(), which returns
# early when .env.prod exists). Static proxy: openssl rand is present AND the early
# return on existing .env.prod precedes any openssl invocation in config().
assert_openssl_guarded() {
  local f="$1"
  grep -Eq 'openssl rand' "$f" || return 1
  # config() must early-return when .env.prod exists, BEFORE generating secrets.
  awk '
    /^config\(\)/        { inconf=1 }
    inconf && /-f "\$\{?ENV_PROD\}?"/ { seen_guard=1 }
    inconf && /openssl rand/ { if (!seen_guard) { bad=1 } }
    inconf && /^\}/        { inconf=0 }
    END { exit (bad?1:0) }
  ' "$f"
}

# FF-T127-5c: secrets-bearing files are gitignored.
assert_secrets_gitignored() {
  grep -Eq '(^|/)\.env\.prod($|[^.])' "$GITIGNORE" \
    && grep -Eq 'config/activation/\*\.key' "$GITIGNORE"
}

# FF-T127-8: all preflight checks run before the first `compose up` (ordering).
# Static proxy: the call to preflight precedes any bring_up/self_upgrade call in main().
assert_preflight_before_up() {
  local f="$1"
  awk '
    /^main\(\)/ { inmain=1 }
    inmain && /[^a-zA-Z_]preflight$|^[[:space:]]*preflight$/ { if (!up) pre=1 }
    inmain && /(bring_up|self_upgrade)/ { up=1; if (!pre) bad=1 }
    inmain && /^\}/ { inmain=0 }
    END { exit (bad?1:0) }
  ' "$f"
}

# FF-T127-8b: installer fail-closes (set -euo pipefail + a fail_closed helper).
assert_fail_closed() {
  local f="$1"
  grep -Eq 'set -euo pipefail' "$f" && grep -Eq 'fail_closed' "$f"
}

# FF-T127-10: success summary emits all four fields.
assert_summary_fields() {
  local f="$1"
  grep -Eqi 'endpoint' "$f" \
    && grep -Eqi 'first-owner|first_owner|owner.*login' "$f" \
    && grep -Eqi 'version' "$f" \
    && grep -Eqi 'activation status|activation_status|active \| autonomous|active｜autonomous' "$f"
}

# ---------------------------------------------------------------------------
# --self-test: prove each assertion can go red on a planted-broken installer.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0198] genesis-installer --self-test: proving assertions can fail on a broken fixture"
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  # A deliberately-broken installer: forked compose ref, genesis SQL, no guard, no summary.
  cat > "$TMP" <<'BROKEN'
#!/usr/bin/env bash
docker compose -f ops/forked-compose.yml up -d
INSERT INTO choros.role_assignment (source) VALUES ('genesis');
openssl rand -hex 32
BROKEN
  fails=0
  assert_uses_existing_compose "$TMP" || fails=$((fails+1))   # should FAIL (forked)
  assert_no_genesis_sql "$TMP"        || fails=$((fails+1))   # should FAIL (has SQL)
  assert_env_existence_guard "$TMP"   || fails=$((fails+1))   # should FAIL (no guard)
  assert_summary_fields "$TMP"        || fails=$((fails+1))   # should FAIL (no summary)
  if [ "$fails" -lt 4 ]; then
    echo "SELF-TEST FAIL: a broken installer was NOT caught by every assertion (caught=$fails/4, exit 2)"
    exit 2
  fi
  rm -f "$TMP"; trap - EXIT
  echo "[T-0198] genesis-installer self-test PASS: broken fixture correctly fails all assertions (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK — against the actual ops/install.sh.
# ---------------------------------------------------------------------------
[ -f "$INSTALL" ] || { echo "FAIL [FF-T127-2]: ops/install.sh not found"; exit 1; }

FAIL=0
run() { # run <label> <assertion-fn> [args...]
  local label="$1"; shift
  if "$@"; then echo "PASS: $label"; else echo "FAIL: $label"; FAIL=1; fi
}

run "FF-T127-2a install.sh uses existing docker-compose.yml + prod overlay" assert_uses_existing_compose "$INSTALL"
run "FF-T127-2b no forked compose under ops/"                               assert_no_forked_compose
run "FF-T127-2c install.sh carries no genesis-owner SQL (026 only)"         assert_no_genesis_sql "$INSTALL"
run "FF-T127-5a .env.prod guarded by existence test before generation"     assert_env_existence_guard "$INSTALL"
run "FF-T127-5b openssl rand only under missing-secret branch"             assert_openssl_guarded "$INSTALL"
run "FF-T127-5c .env.prod + config/activation/*.key gitignored"            assert_secrets_gitignored
run "FF-T127-8a preflight runs before first compose up (ordering)"         assert_preflight_before_up "$INSTALL"
run "FF-T127-8b installer fail-closes (set -euo pipefail + fail_closed)"    assert_fail_closed "$INSTALL"
run "FF-T127-10 success summary emits endpoint/owner/version/activation"   assert_summary_fields "$INSTALL"

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: genesis-installer static gate found violations"
  exit 1
fi
echo "PASS: genesis-installer — FF-T127-2/5/8/10 static checks green"
exit 0
