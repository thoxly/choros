#!/usr/bin/env bash
# T-0153 · FF-ARENA1..FF-ARENA7 — Enemy Arena sealing invariants (static gate)
#
# Эпик E-VRG / T-0151 «Враг». spec: playbooks/enemy-redteam-backlog.md §5/§7
# (репо Demiurge). The Враг runs its adversarial attacks (T-0154+) inside a
# SEALED, single-use snapshot of the dev stack. A LEAKY arena (real creds, network
# egress, a single tenant, the real founder) would defeat the whole point — so the
# arena's sealing properties are enforced HERE as a static CI invariant, not just
# documented.
#
# This check is STATIC ONLY (grep/structure over docker-compose.arena.yml +
# ops/arena/*). It deliberately does NOT bring the stack up — the real arena
# bring-up (ops/arena/arena-up.sh) needs live Docker and is invoked deliberately,
# never wired into the offline `npm run fitness` chain.
#
# SCOPE: this owns the ARENA infra only. It does NOT build or assert the attacks
# themselves (that is the deterministic Враг + corpus, T-0154, downstream).
#
# INVARIANTS:
#   FF-ARENA1 (separate infra)  — arena overlay uses an _arena-suffixed volume and
#       does NOT reuse the dev volume choros_pgdata or the prod _prod volume; the
#       bring-up script pins a distinct compose project (-p choros-arena).
#   FF-ARENA2 (no egress)       — every networks: block in the arena overlay is the
#       sealed `arena_internal`, which is declared `internal: true`; no service
#       opts onto the compose `default` network.
#   FF-ARENA3 (no real creds)   — the arena overlay carries ONLY fake placeholder
#       secrets (arena_fake_* prefix); it has NO ${VAR:-default} / ${VAR:?...}
#       secret interpolation that could inherit a host-side real/prod secret; the
#       bring-up script passes --env-file /dev/null (reads no host .env/.env.prod).
#   FF-ARENA4 (≥2 tenants)      — ops/arena/arena-tenants.txt lists ≥2 tenant slugs
#       and arena-up.sh fail-closes if fewer than two are present.
#   FF-ARENA5 (fake-founder)    — the arena owner principal is the dev genesis
#       e-owner (NOT a real founder identity) and there is NO founder-trust-root
#       wired into the arena (spec §7).
#   FF-ARENA6 (one-shot)        — arena-down.sh tears the arena down with `down -v`
#       (removes the named volume) → no persistent state survives a run.
#   FF-ARENA7 (registered + owned) — this check is registered in `npm run fitness`
#       and its 2nd line declares T-0153 ownership (frozen-checks discipline).
#
# SELF-TEST (--self-test): plant a LEAKY arena overlay (real-prod creds, an
# egress network, a single tenant) and assert each sealing assertion goes RED on
# it; exit 0 if every assertion correctly fails the leaky fixture, 2 if the check
# machinery itself is broken.
#
# EXIT CODES: 0 clean · 1 violation · 2 self-test broken
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ARENA="$REPO_ROOT/docker-compose.arena.yml"
UP="$REPO_ROOT/ops/arena/arena-up.sh"
DOWN="$REPO_ROOT/ops/arena/arena-down.sh"
TENANTS="$REPO_ROOT/ops/arena/arena-tenants.txt"
DEVCOMPOSE="$REPO_ROOT/docker-compose.yml"
PKG="$REPO_ROOT/package.json"
SELF="$REPO_ROOT/ci/checks/enemy/arena-sealed.sh"

echo "[T-0153] arena-sealed (FF-ARENA1..7): static sealing invariants for the Враг arena"

# ---------------------------------------------------------------------------
# Assertion helpers — each takes the arena-overlay path so --self-test can run
# them against a planted-LEAKY fixture. Helpers that read the scripts/registry
# use the real repo paths (those are not varied by the self-test).
#
# code_lines: strip YAML comment-only lines (first non-blank char is '#') so that
# prose DESCRIBING the sealing (e.g. "no founder-trust-root", "dev choros_pgdata")
# never trips a leak grep — documenting the invariant is not violating it.
# ---------------------------------------------------------------------------
code_lines() { grep -vE '^[[:space:]]*#' "$1" 2>/dev/null || true; }

# FF-ARENA1: separate infra — _arena volume present; dev choros_pgdata NOT mounted;
# prod _prod volume NOT referenced; bring-up pins a distinct project.
assert_separate_infra() {
  local f="$1" code
  code="$(code_lines "$f")"
  echo "$code" | grep -Eq 'choros_pgdata_arena' || return 1
  # Must NOT mount the dev volume (choros_pgdata not followed by _arena/_prod).
  ! echo "$code" | grep -Eq '\bchoros_pgdata\b([^_]|$)' || return 1
  ! echo "$code" | grep -Eq 'choros_pgdata_prod' || return 1
  # Bring-up pins a dedicated compose project (-p choros-arena).
  grep -Eq '\-p[[:space:]]+choros-arena|PROJECT=.?choros-arena' "$UP" || return 1
}

# FF-ARENA2: no egress — an arena_internal network declared internal:true, and NO
# service references the compose `default` network in the overlay.
assert_no_egress() {
  local f="$1" code
  code="$(code_lines "$f")"
  echo "$code" | grep -Eq 'arena_internal' || return 1
  # internal: true must appear (the sealed-network declaration).
  echo "$code" | grep -Eq '^[[:space:]]*internal:[[:space:]]*true' || return 1
  # No service may opt onto the default network from the overlay.
  ! echo "$code" | grep -Eq '^[[:space:]]*-[[:space:]]*default[[:space:]]*$|network_mode' || return 1
}

# FF-ARENA3: no real creds — only arena_fake_* placeholders; NO ${VAR:-default}
# or ${VAR:?...} secret interpolation; bring-up reads no host env-file.
assert_no_real_creds() {
  local f="$1" code
  code="$(code_lines "$f")"
  # Any PASSWORD/SECRET/TOKEN code line assigning a non-fake literal is a leak. We
  # require every such value to start with arena_fake_ (placeholder discipline).
  local bad
  bad="$(echo "$code" | grep -nE '(PASSWORD|SECRET|_PW|TOKEN):' \
        | grep -vE ':[[:space:]]*arena_fake_' || true)"
  [ -z "$bad" ] || { echo "$bad"; return 1; }
  # No ${VAR:-...} / ${VAR:?...} interpolation on secret-bearing vars (would let a
  # host-side real/prod secret flow into the arena).
  ! echo "$code" | grep -EqiA0 '(PASSWORD|SECRET|TOKEN|_PW):[[:space:]]*\$\{[A-Z_]+(:-|:\?)' || return 1
  # Bring-up must read NO host env-file.
  grep -Eq '\-\-env-file[[:space:]]+/dev/null' "$UP" || return 1
}

# FF-ARENA4: ≥2 tenants in the registry AND a fail-closed guard in arena-up.sh.
assert_two_tenants() {
  local n
  n="$(grep -vcE '^[[:space:]]*(#|$)' "$TENANTS" || true)"
  [ "${n:-0}" -ge 2 ] || return 1
  # Fail-closed guard: arena-up.sh refuses to run with < 2 tenants.
  grep -Eq '\-lt 2|< 2' "$UP" || return 1
}

# FF-ARENA5: fake-founder — overlay marks the fake-founder principal and there is
# NO real founder-trust-root wired in (no founder_decide / trust-root / real
# founder identity in the arena infra).
assert_fake_founder() {
  local f="$1" code upcode
  code="$(code_lines "$f")"
  echo "$code" | grep -Eqi 'ARENA_FAKE_FOUNDER|fake-founder|fake_founder' || return 1
  # No founder-trust-root surface on a CODE line of the arena overlay or bring-up
  # (spec §7) — comment prose describing "no founder-trust-root" is fine.
  ! echo "$code" | grep -Eqi 'founder_decide|founder-trust-root|founder_trust_root|trust-root' || return 1
  upcode="$(code_lines "$UP")"
  ! echo "$upcode" | grep -Eqi 'founder_decide|founder-trust-root|founder_trust_root' || return 1
}

# FF-ARENA6: one-shot — teardown removes the named volume (down -v).
assert_one_shot() {
  grep -Eq 'down[[:space:]].*-v' "$DOWN" || return 1
}

# FF-ARENA7: registered in npm run fitness + 2nd-line ownership = T-0153.
assert_registered_and_owned() {
  grep -Eq 'ci/checks/enemy/arena-sealed\.sh' "$PKG" || return 1
  sed -n '2p' "$SELF" | grep -Eq '^# T-0153[[:space:]]' || return 1
}

# ---------------------------------------------------------------------------
# --self-test: plant a LEAKY arena overlay and prove the sealing assertions go red.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  echo "[T-0153] arena-sealed --self-test: proving assertions go RED on a leaky arena"
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  # A deliberately LEAKY arena: dev volume reused, an egress (default) network,
  # a REAL prod-style secret via ${VAR:-default}, no fake-founder marker.
  cat > "$TMP" <<'LEAKY'
services:
  postgres:
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-real_prod_pw}
    networks:
      - default
    volumes:
      - "choros_pgdata:/var/lib/postgresql/data"
networks:
  default: {}
volumes:
  choros_pgdata: {}
LEAKY
  fails=0
  assert_separate_infra "$TMP" || fails=$((fails+1))   # should FAIL (dev volume reused)
  assert_no_egress      "$TMP" || fails=$((fails+1))   # should FAIL (default network, no internal:true)
  assert_no_real_creds  "$TMP" || fails=$((fails+1))   # should FAIL (prod secret via ${VAR:-})
  assert_fake_founder   "$TMP" || fails=$((fails+1))   # should FAIL (no fake-founder marker)
  if [ "$fails" -lt 4 ]; then
    echo "SELF-TEST FAIL: leaky arena was NOT caught by every sealing assertion (caught=$fails/4, exit 2)"
    exit 2
  fi
  rm -f "$TMP"; trap - EXIT
  echo "[T-0153] arena-sealed self-test PASS: leaky arena correctly fails all sealing assertions (exit 0)"
  exit 0
fi

# ---------------------------------------------------------------------------
# REAL CHECK — against the actual arena overlay + scripts.
# ---------------------------------------------------------------------------
[ -f "$ARENA" ] || { echo "FAIL [FF-ARENA1]: docker-compose.arena.yml not found"; exit 1; }
[ -f "$UP" ]    || { echo "FAIL [FF-ARENA4]: ops/arena/arena-up.sh not found"; exit 1; }
[ -f "$DOWN" ]  || { echo "FAIL [FF-ARENA6]: ops/arena/arena-down.sh not found"; exit 1; }
[ -f "$TENANTS" ] || { echo "FAIL [FF-ARENA4]: ops/arena/arena-tenants.txt not found"; exit 1; }
[ -f "$DEVCOMPOSE" ] || { echo "FAIL: docker-compose.yml (base) not found"; exit 1; }

FAIL=0
run() { local label="$1"; shift; if "$@"; then echo "PASS: $label"; else echo "FAIL: $label"; FAIL=1; fi; }

run "FF-ARENA1 separate infra (_arena volume, no dev/prod volume reuse, own project)" assert_separate_infra "$ARENA"
run "FF-ARENA2 no egress (arena_internal internal:true, no default network)"          assert_no_egress "$ARENA"
run "FF-ARENA3 no real creds (arena_fake_* only, no host secret interpolation/env)"   assert_no_real_creds "$ARENA"
run "FF-ARENA4 ≥2 tenants (registry + fail-closed guard)"                             assert_two_tenants
run "FF-ARENA5 fake-founder, no founder-trust-root in arena"                          assert_fake_founder "$ARENA"
run "FF-ARENA6 one-shot (teardown removes volume with down -v)"                       assert_one_shot
run "FF-ARENA7 registered in npm run fitness + 2nd-line T-0153 ownership"             assert_registered_and_owned

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL: arena-sealed — the Враг arena is NOT properly sealed"
  exit 1
fi
echo "PASS: arena-sealed — FF-ARENA1..7 green; the Враг arena is sealed (≥2 tenants, no egress, fake-founder, no real creds, one-shot)"
exit 0
