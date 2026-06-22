#!/usr/bin/env bash
# kc-dev-setup.sh — idempotent DEV-only Keycloak reconcile script.
#
# Applies / reconciles the config/keycloak/realm-choros.json fixture against a
# running Keycloak instance so that a fresh KC re-provision restores the full
# dev configuration from committed files.  Safe to re-run: uses PUT (overwrite)
# for clients and SKIP-IF-EXISTS for users so it is idempotent.
#
# Usage:
#   bash scripts/kc-dev-setup.sh
#
# Environment (all optional — DEV defaults match docker-compose.yml):
#   KC_URL          Keycloak base URL            (default: http://localhost:8180)
#   KC_REALM        Realm name                   (default: choros)
#   KC_ADMIN        Admin username               (default: choros_kc_admin)
#   KC_ADMIN_PW     Admin password               (default: choros_kc_dev_pw)
#   REALM_JSON      Path to realm import JSON    (default: config/keycloak/realm-choros.json)
#
# DEV ONLY — never run against production Keycloak.
# Prod credentials are never committed (RL-1/RL-3); prod is managed by the founder.

set -euo pipefail

KC_URL="${KC_URL:-http://localhost:8180}"
KC_REALM="${KC_REALM:-choros}"
KC_ADMIN="${KC_ADMIN:-choros_kc_admin}"
KC_ADMIN_PW="${KC_ADMIN_PW:-choros_kc_dev_pw}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REALM_JSON="${REALM_JSON:-$REPO_ROOT/config/keycloak/realm-choros.json}"

echo "[kc-dev-setup] KC_URL=$KC_URL  realm=$KC_REALM  admin=$KC_ADMIN"
echo "[kc-dev-setup] realm JSON: $REALM_JSON"

if [[ ! -f "$REALM_JSON" ]]; then
  echo "ERROR: realm JSON not found at $REALM_JSON" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 0. Obtain an admin access token (ROPC against the master realm).
# ---------------------------------------------------------------------------
echo "[kc-dev-setup] Obtaining admin token..."
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
echo "[kc-dev-setup] Admin token obtained."

export ADMIN_TOKEN
export ADMIN_BASE="$KC_URL/admin/realms/$KC_REALM"
export REALM_JSON_PATH="$REALM_JSON"

# ---------------------------------------------------------------------------
# 1. Ensure the realm exists (create-or-skip).
#    KC import-on-start already creates it from the mounted JSON; this step
#    handles the edge case where setup runs before the first compose start.
# ---------------------------------------------------------------------------
echo "[kc-dev-setup] Checking realm '$KC_REALM'..."
REALM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$KC_URL/admin/realms/$KC_REALM")

if [[ "$REALM_STATUS" == "404" ]]; then
  echo "[kc-dev-setup] Realm not found — importing from $REALM_JSON..."
  curl -sf \
    -X POST "$KC_URL/admin/realms" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d @"$REALM_JSON"
  echo "[kc-dev-setup] Realm imported."
else
  echo "[kc-dev-setup] Realm '$KC_REALM' already exists (HTTP $REALM_STATUS)."
fi

# ---------------------------------------------------------------------------
# 2. Reconcile clients: upsert each client from realm JSON.
#    If client exists → PUT (update/overwrite redirectUris, webOrigins, etc.)
#    If not → POST (create)
# ---------------------------------------------------------------------------
echo "[kc-dev-setup] Reconciling clients..."

python3 - <<'PYEOF'
import json, subprocess, sys, os

REALM_JSON = os.environ["REALM_JSON_PATH"]
ADMIN_BASE = os.environ["ADMIN_BASE"]
ADMIN_TOKEN = os.environ["ADMIN_TOKEN"]

def kc(method, path, data=None):
    cmd = ["curl", "-sf", "-X", method,
           "-H", f"Authorization: Bearer {ADMIN_TOKEN}",
           "-H", "Content-Type: application/json",
           f"{ADMIN_BASE}{path}"]
    if data is not None:
        cmd += ["-d", json.dumps(data)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode, result.stdout.strip()

data = json.load(open(REALM_JSON))
clients = data.get("clients", [])

for c in clients:
    cid = c["clientId"]
    rc, out = kc("GET", f"/clients?clientId={cid}")
    existing = json.loads(out) if out else []
    if existing:
        internal_id = existing[0]["id"]
        kc("PUT", f"/clients/{internal_id}", c)
        print(f"  [OK] updated client '{cid}'")
    else:
        kc("POST", "/clients", c)
        print(f"  [OK] created client '{cid}'")

print("[kc-dev-setup] Clients reconciled.")
PYEOF

# ---------------------------------------------------------------------------
# 3. Reconcile users: create-if-not-exists (skip existing to preserve
#    self-registered users added after initial import).
#    Service-account users are auto-created by KC when the client with
#    serviceAccountsEnabled=true is created; skip them here.
# ---------------------------------------------------------------------------
echo "[kc-dev-setup] Reconciling fixture users..."

python3 - <<'PYEOF'
import json, subprocess, sys, os

REALM_JSON = os.environ["REALM_JSON_PATH"]
ADMIN_BASE = os.environ["ADMIN_BASE"]
ADMIN_TOKEN = os.environ["ADMIN_TOKEN"]

def kc(method, path, data=None):
    cmd = ["curl", "-sf", "-X", method,
           "-H", f"Authorization: Bearer {ADMIN_TOKEN}",
           "-H", "Content-Type: application/json",
           f"{ADMIN_BASE}{path}"]
    if data is not None:
        cmd += ["-d", json.dumps(data)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode, result.stdout.strip()

data = json.load(open(REALM_JSON))
users = data.get("users", [])

for u in users:
    uname = u.get("username", "")
    if uname.startswith("service-account-"):
        # KC auto-creates these when the client is created
        continue

    rc, out = kc("GET", f"/users?username={uname}&exact=true")
    existing = json.loads(out) if out else []
    if existing:
        print(f"  [SKIP] user '{uname}' already exists")
    else:
        # POST create (credentials + attributes; clientRoles handled separately)
        user_payload = {k: v for k, v in u.items() if k != "clientRoles"}
        kc("POST", "/users", user_payload)
        print(f"  [OK] created user '{uname}'")

print("[kc-dev-setup] Users reconciled.")
PYEOF

# ---------------------------------------------------------------------------
# 4. Reconcile realm-management roles for choros-registrar service account.
#    Grants manage-users/view-users on realm-management client.
#    Idempotent: KC ignores already-granted roles on POST.
# ---------------------------------------------------------------------------
echo "[kc-dev-setup] Reconciling realm-management grants for choros-registrar..."

python3 - <<'PYEOF'
import json, subprocess, sys, os

ADMIN_BASE = os.environ["ADMIN_BASE"]
ADMIN_TOKEN = os.environ["ADMIN_TOKEN"]

def kc(method, path, data=None):
    cmd = ["curl", "-sf", "-X", method,
           "-H", f"Authorization: Bearer {ADMIN_TOKEN}",
           "-H", "Content-Type: application/json",
           f"{ADMIN_BASE}{path}"]
    if data is not None:
        cmd += ["-d", json.dumps(data)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode, result.stdout.strip()

# Find choros-registrar service-account user
rc, out = kc("GET", "/users?username=service-account-choros-registrar&exact=true")
users = json.loads(out) if out else []
if not users:
    print("  [WARN] service-account-choros-registrar not found — skipping role grant", file=sys.stderr)
    sys.exit(0)

sa_user_id = users[0]["id"]

# Find realm-management client
rc, out = kc("GET", "/clients?clientId=realm-management")
rm_clients = json.loads(out) if out else []
if not rm_clients:
    print("  [WARN] realm-management client not found", file=sys.stderr)
    sys.exit(0)

rm_client_id = rm_clients[0]["id"]

# Get roles from realm-management
rc, out = kc("GET", f"/clients/{rm_client_id}/roles")
all_roles = json.loads(out) if out else []
roles_to_grant = ["manage-users", "view-users"]
grant_payload = [r for r in all_roles if r["name"] in roles_to_grant]

if not grant_payload:
    print("  [WARN] manage-users/view-users roles not found in realm-management", file=sys.stderr)
    sys.exit(0)

# POST is idempotent — KC ignores already-granted roles
kc("POST", f"/users/{sa_user_id}/role-mappings/clients/{rm_client_id}", grant_payload)
granted_names = [r["name"] for r in grant_payload]
print(f"  [OK] granted {granted_names} to service-account-choros-registrar")
print("[kc-dev-setup] Realm-management grants reconciled.")
PYEOF

# ---------------------------------------------------------------------------
# 5. Update user-profile (declarative schema: firstName/lastName optional,
#    actor_type attribute declared with options validation).
#    Uses the KC 25 user-profile Admin REST endpoint (PUT /users/profile).
# ---------------------------------------------------------------------------
echo "[kc-dev-setup] Reconciling user-profile schema..."

python3 - <<'PYEOF'
import json, subprocess, os

REALM_JSON = os.environ["REALM_JSON_PATH"]
ADMIN_BASE = os.environ["ADMIN_BASE"]
ADMIN_TOKEN = os.environ["ADMIN_TOKEN"]

def kc(method, path, data=None):
    cmd = ["curl", "-sf", "-X", method,
           "-H", f"Authorization: Bearer {ADMIN_TOKEN}",
           "-H", "Content-Type: application/json",
           f"{ADMIN_BASE}{path}"]
    if data is not None:
        cmd += ["-d", json.dumps(data)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode, result.stdout.strip()

data = json.load(open(REALM_JSON))
user_profile = data.get("userProfile")
if not user_profile:
    print("  [SKIP] no userProfile section in realm JSON")
else:
    rc, _ = kc("PUT", "/users/profile", user_profile)
    if rc == 0:
        print("  [OK] user-profile schema applied")
    else:
        print("  [WARN] PUT /users/profile returned non-zero (KC version may differ)")
print("[kc-dev-setup] User-profile reconciled.")
PYEOF

echo ""
echo "[kc-dev-setup] Done. DEV Keycloak configuration reconciled from:"
echo "  $REALM_JSON"
echo ""
echo "  To verify, visit: $KC_URL/admin/master/console/#/$KC_REALM/clients"
echo ""
echo "  NOTE: DEV ONLY — never run against production Keycloak (RL-1)."
