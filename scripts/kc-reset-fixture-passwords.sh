#!/usr/bin/env bash
# kc-reset-fixture-passwords.sh — idempotent DEV-only reset of fixture (non-owner)
# test-user passwords to DETERMINISTIC values on a Keycloak instance.
#
# PROBLEM (T-0695): config/keycloak/realm-choros.json ships dev-pw-<username>
# passwords for the 7+1 human fixture users, but scripts/kc-dev-setup.sh applies
# users as create-if-not-exists (SKIP-IF-EXISTS — preserves self-registered users
# added after initial import). On a PERSISTENT dev stand (not a fresh docker-compose
# bootstrap), the fixture users already exist in Keycloak's volume, so re-applying
# the realm JSON never restores dev-pw-<username> — it just [SKIP]s. Every
# LIVE_PROOF session since 2026-07-04 independently reset these passwords through
# the KC admin REST API to its OWN one-off ad-hoc value (LiveProof-0611-owner!,
# LiveProof-0630-orlov!, ...) and never centrally documented the result — see
# docs/live-proof/T-0639.md finding P1. This script fixes that by resetting a
# FIXED list of non-owner fixture users to a DETERMINISTIC password derived purely
# from their username — reproducible without archaeology across live-proof docs.
#
# CRITICAL GUARD (founder-cred-lockout rule): this script NEVER touches genesis-owner
# credentials (e-owner, t0586-admin) or the founder's real login (pgv@axonteam.ru).
# The owner skip-list below is HARD-CODED (not read from an external file/argument)
# specifically so it cannot be silently bypassed. is_owner() is checked BEFORE any
# network call, for every user regardless of source (built-in list or --user arg).
#
# Usage:
#   bash scripts/kc-reset-fixture-passwords.sh              # reset all fixture users
#   bash scripts/kc-reset-fixture-passwords.sh --self-test  # offline self-test (no KC needed)
#
# Environment (all optional — dev defaults match docker-compose.yml / kc-dev-setup.sh):
#   KC_URL          Keycloak base URL            (default: http://localhost:8180)
#   KC_REALM        Realm name                   (default: choros)
#   KC_ADMIN        Admin username               (default: choros_kc_admin)
#   KC_ADMIN_PW     Admin password               (default: choros_kc_dev_pw)
#
# To run against the live persistent dev stand, override KC_URL / KC_ADMIN /
# KC_ADMIN_PW to point at the stand's Keycloak (see docs/environments.md, section
# "Фикстурные dev-креды на persistent-стенде"). This script does NOT run itself
# against the live stand — that is an operator/founder action (T-0695 scope: script
# + docs only, per task instructions).
#
# DEV ONLY — never run against production Keycloak (RL-1).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Fixed persona lists.
# ---------------------------------------------------------------------------

# FIXTURE_USERS — non-owner test personas eligible for deterministic reset.
# e-kravtsova..e-belov come from config/keycloak/realm-choros.json (the 7 human
# fixture users, FF-7). e-configurator comes from migrations/088 (human test
# persona holding role-configurator — NOT a tenant-owner).
FIXTURE_USERS=(
  "e-kravtsova"
  "e-mironov"
  "e-larina"
  "e-orlov"
  "e-savina"
  "e-petrov"
  "e-belov"
  "e-configurator"
)

# OWNER_SKIPLIST — genesis-owner / founder identities. NEVER reset by this script.
# e-owner and t0586-admin are both confirmed genesis owners (isGenesisOwner=true)
# created during live-proof sessions T-0583/onward — see docs/live-proof/T-0648.
# live-proof.md, T-0665-e2e.live-proof.md. pgv@axonteam.ru is the founder's real
# Keycloak login (per memory choros-founder-cred-lockout-2026-07-06). HARD-CODED
# on purpose — not sourced from an external file or CLI argument.
OWNER_SKIPLIST=(
  "e-owner"
  "t0586-admin"
  "pgv@axonteam.ru"
)

# ---------------------------------------------------------------------------
# Pure helpers (no side effects — exercised directly by --self-test).
# ---------------------------------------------------------------------------

# is_owner <username> — true (rc 0) iff username is in the hard-coded owner
# skip-list (exact, case-sensitive match). This is the guard checked before any
# write call in reset_user_password().
is_owner() {
  local username="$1" owner
  for owner in "${OWNER_SKIPLIST[@]}"; do
    if [[ "$username" == "$owner" ]]; then
      return 0
    fi
  done
  return 1
}

# derive_password <username> — deterministic, pure function of username. Same
# readable shape LIVE_PROOF sessions already used ad-hoc (LiveProof-<tag>-<user>!,
# passes KC's default password policy) but with NO session/task number — the
# single fixed password for a given user, reproducible without consulting
# live-proof history.
derive_password() {
  local username="$1"
  printf 'LiveProof-Fixture-%s!' "$username"
}

# ---------------------------------------------------------------------------
# Self-test mode — offline, no network/KC required.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[kc-reset-fixture-passwords] --self-test"
  FAIL=0

  # (1) derive_password is deterministic: same input -> same output twice.
  p1="$(derive_password "e-orlov")"
  p2="$(derive_password "e-orlov")"
  if [[ "$p1" != "$p2" ]]; then
    echo "FAIL self-test: derive_password not deterministic ('$p1' vs '$p2')" >&2
    FAIL=1
  else
    echo "PASS self-test: derive_password('e-orlov') deterministic ($p1)"
  fi

  # (2) derive_password differs across usernames.
  pa="$(derive_password "e-orlov")"
  pb="$(derive_password "e-larina")"
  if [[ "$pa" == "$pb" ]]; then
    echo "FAIL self-test: derive_password collided for distinct usernames ('$pa')" >&2
    FAIL=1
  else
    echo "PASS self-test: derive_password differs per username ($pa != $pb)"
  fi

  # (3) is_owner true for every OWNER_SKIPLIST entry.
  for owner in "${OWNER_SKIPLIST[@]}"; do
    if is_owner "$owner"; then
      echo "PASS self-test: is_owner('$owner') == true"
    else
      echo "FAIL self-test: is_owner('$owner') expected true, got false" >&2
      FAIL=1
    fi
  done

  # (4) is_owner false for every FIXTURE_USERS entry.
  for u in "${FIXTURE_USERS[@]}"; do
    if is_owner "$u"; then
      echo "FAIL self-test: is_owner('$u') expected false (fixture user), got true" >&2
      FAIL=1
    else
      echo "PASS self-test: is_owner('$u') == false"
    fi
  done

  # (5) reset_user_password() refuses an owner WITHOUT calling the KC API mock —
  #     proves the guard fires before any network side effect. Mock kc() counts
  #     invocations via a file-based counter (subshells in $(...) can't mutate
  #     parent variables).
  MOCK_CALL_COUNT_FILE="$(mktemp)"
  trap 'rm -f "${MOCK_CALL_COUNT_FILE}"' EXIT
  echo 0 > "${MOCK_CALL_COUNT_FILE}"

  # Minimal stand-in for the real kc() REST helper (defined further below) —
  # self-test never touches the network, only proves call/no-call behavior.
  kc_mock() {
    local n
    n="$(cat "${MOCK_CALL_COUNT_FILE}")"
    echo "$((n + 1))" > "${MOCK_CALL_COUNT_FILE}"
  }

  # reset_user_password_guarded — same guard shape as the production
  # reset_user_password(), but calls kc_mock() instead of curl, so the self-test
  # can assert call counts without a live KC.
  reset_user_password_guarded() {
    local username="$1"
    if is_owner "$username"; then
      echo "  [REFUSED] '$username' is in OWNER_SKIPLIST — refusing to reset (self-test)" >&2
      return 1
    fi
    kc_mock
    return 0
  }

  reset_user_password_guarded "e-owner" || true
  count_after_owner="$(cat "${MOCK_CALL_COUNT_FILE}")"
  if [[ "$count_after_owner" != "0" ]]; then
    echo "FAIL self-test: reset attempt on owner 'e-owner' invoked kc() (count=$count_after_owner, expected 0)" >&2
    FAIL=1
  else
    echo "PASS self-test: reset attempt on owner 'e-owner' did NOT call kc() (count=0)"
  fi

  # (6) reset_user_password() calls the mock exactly once per fixture user.
  echo 0 > "${MOCK_CALL_COUNT_FILE}"
  reset_user_password_guarded "e-orlov"
  count_after_fixture="$(cat "${MOCK_CALL_COUNT_FILE}")"
  if [[ "$count_after_fixture" != "1" ]]; then
    echo "FAIL self-test: reset on fixture user 'e-orlov' expected kc() call count=1, got $count_after_fixture" >&2
    FAIL=1
  else
    echo "PASS self-test: reset on fixture user 'e-orlov' called kc() exactly once"
  fi

  # (7) also guard t0586-admin and pgv@axonteam.ru explicitly (regression pin —
  #     the task's own example fixture list incorrectly named t0586-admin; this
  #     locks it firmly into the refused path).
  echo 0 > "${MOCK_CALL_COUNT_FILE}"
  reset_user_password_guarded "t0586-admin" || true
  count_t0586="$(cat "${MOCK_CALL_COUNT_FILE}")"
  if [[ "$count_t0586" != "0" ]]; then
    echo "FAIL self-test: reset attempt on owner 't0586-admin' invoked kc() (count=$count_t0586, expected 0)" >&2
    FAIL=1
  else
    echo "PASS self-test: reset attempt on owner 't0586-admin' did NOT call kc() (count=0)"
  fi

  echo 0 > "${MOCK_CALL_COUNT_FILE}"
  reset_user_password_guarded "pgv@axonteam.ru" || true
  count_founder="$(cat "${MOCK_CALL_COUNT_FILE}")"
  if [[ "$count_founder" != "0" ]]; then
    echo "FAIL self-test: reset attempt on founder login invoked kc() (count=$count_founder, expected 0)" >&2
    FAIL=1
  else
    echo "PASS self-test: reset attempt on founder login did NOT call kc() (count=0)"
  fi

  echo ""
  if [[ "$FAIL" -ne 0 ]]; then
    echo "FAIL: kc-reset-fixture-passwords self-test found violation(s)" >&2
    exit 1
  fi
  echo "PASS: kc-reset-fixture-passwords self-test — all guards and determinism checks green"
  exit 0
fi

# ---------------------------------------------------------------------------
# Production path — talks to a real Keycloak instance.
# ---------------------------------------------------------------------------

KC_URL="${KC_URL:-http://localhost:8180}"
KC_REALM="${KC_REALM:-choros}"
KC_ADMIN="${KC_ADMIN:-choros_kc_admin}"
KC_ADMIN_PW="${KC_ADMIN_PW:-choros_kc_dev_pw}"

echo "[kc-reset-fixture-passwords] KC_URL=$KC_URL  realm=$KC_REALM  admin=$KC_ADMIN"
echo "[kc-reset-fixture-passwords] fixture users: ${FIXTURE_USERS[*]}"
echo "[kc-reset-fixture-passwords] owner skip-list (never touched): ${OWNER_SKIPLIST[*]}"

echo "[kc-reset-fixture-passwords] Obtaining admin token..."
ADMIN_TOKEN=$(curl -sf \
  -X POST "$KC_URL/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli" \
  -d "username=$KC_ADMIN" \
  -d "password=$KC_ADMIN_PW" \
  -d "grant_type=password" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

if [[ -z "$ADMIN_TOKEN" ]]; then
  echo "ERROR: failed to obtain admin token from $KC_URL" >&2
  exit 1
fi
echo "[kc-reset-fixture-passwords] Admin token obtained."

ADMIN_BASE="$KC_URL/admin/realms/$KC_REALM"

# kc <method> <path> [json-data] — authenticated KC admin REST call. Prints the
# response body (if any) to stdout, returns the underlying curl exit code.
kc() {
  local method="$1" path="$2" data="${3:-}"
  local -a cmd=(curl -sf -X "$method"
    -H "Authorization: Bearer $ADMIN_TOKEN"
    -H "Content-Type: application/json"
    "$ADMIN_BASE$path")
  if [[ -n "$data" ]]; then
    cmd+=(-d "$data")
  fi
  "${cmd[@]}"
}

# reset_user_password <username> — the guarded, production write path. Refuses
# (no network call) if is_owner(username); otherwise looks the user up by exact
# username, resets their password to derive_password(username) with
# temporary=false, and re-applies attributes.actor_type="human" as a SCALAR
# (T-0638 lesson: realm-reimport strips this single-valued profile attribute —
# it must be restored as a bare string, not an array, on every reset).
declare -A RESULT_PASSWORDS
declare -a SKIPPED_NOT_FOUND

reset_user_password() {
  local username="$1"

  if is_owner "$username"; then
    echo "  [REFUSED] '$username' is in OWNER_SKIPLIST — refusing to reset (founder-cred-lockout guard)" >&2
    return 1
  fi

  local lookup user_id password
  lookup="$(kc GET "/users?username=$username&exact=true")" || {
    echo "  [WARN] lookup failed for '$username' — skipping" >&2
    SKIPPED_NOT_FOUND+=("$username")
    return 0
  }

  user_id="$(printf '%s' "$lookup" | python3 -c "
import json, sys
rows = json.load(sys.stdin)
print(rows[0]['id'] if rows else '')
")"

  if [[ -z "$user_id" ]]; then
    echo "  [SKIP] user '$username' not found in KC — not created by this script (see kc-dev-setup.sh)" >&2
    SKIPPED_NOT_FOUND+=("$username")
    return 0
  fi

  password="$(derive_password "$username")"

  # Reset password (temporary:false — do not force a change-password screen,
  # LIVE_PROOF browser flows expect to log straight in).
  kc PUT "/users/$user_id/reset-password" \
    "{\"type\":\"password\",\"value\":\"$password\",\"temporary\":false}" \
    > /dev/null

  # Merge-restore attributes.actor_type as a SCALAR "human" (T-0638 lesson).
  # GET the current representation first so we don't clobber firstName/email/etc.
  local current updated
  current="$(kc GET "/users/$user_id")"
  updated="$(printf '%s' "$current" | python3 -c "
import json, sys
u = json.load(sys.stdin)
attrs = u.get('attributes') or {}
attrs['actor_type'] = 'human'
u['attributes'] = attrs
print(json.dumps(u))
")"
  kc PUT "/users/$user_id" "$updated" > /dev/null

  RESULT_PASSWORDS["$username"]="$password"
  echo "  [OK] '$username' password reset + actor_type=human restored"
  return 0
}

echo ""
echo "[kc-reset-fixture-passwords] Resetting fixture users..."
for u in "${FIXTURE_USERS[@]}"; do
  reset_user_password "$u" || true
done

echo ""
echo "[kc-reset-fixture-passwords] Result — user -> password:"
printf '%-20s %s\n' "USERNAME" "PASSWORD"
for u in "${FIXTURE_USERS[@]}"; do
  if [[ -n "${RESULT_PASSWORDS[$u]:-}" ]]; then
    printf '%-20s %s\n' "$u" "${RESULT_PASSWORDS[$u]}"
  fi
done
if [[ ${#SKIPPED_NOT_FOUND[@]} -gt 0 ]]; then
  echo ""
  echo "  SKIPPED (not found in KC — run scripts/kc-dev-setup.sh first if they should exist): ${SKIPPED_NOT_FOUND[*]}"
fi
echo ""
echo "  OWNER (never touched, founder-cred-lockout guard): ${OWNER_SKIPLIST[*]}"
echo ""
echo "[kc-reset-fixture-passwords] Done. See docs/environments.md for the recorded"
echo "  deterministic credential table (this output should match it)."
echo ""
echo "  DEV ONLY — never run against production Keycloak (RL-1)."
