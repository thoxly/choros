#!/usr/bin/env bash
# T-0734 · FF-UP1 — realm JSON declares actor_type as a MANAGED, admin-editable,
# options-validated user-profile attribute (static anti-regression lock).
#
# ROOT CAUSE THIS LOCKS (T-0734): KC 25's declarative user profile ships with
# unmanaged attributes DISABLED. If actor_type is not a DECLARED managed
# attribute, KC silently drops it on every admin-REST user create (POST /users)
# — so a user created from the product UI (createHumanUser) gets a login token
# with NO actor_type claim and verifyClaims (src/http/auth.ts) rejects every
# request with 401. This check fails the build if that declaration regresses
# (e.g. the components entry is deleted, or actor_type is removed / made
# user-editable / loses its option validator).
#
# It is STATIC (no live KC): it parses the committed realm import file only.
set -euo pipefail
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

REALM_FILE="config/keycloak/realm-choros.json"

echo "[FF-UP1] Checking actor_type is a managed, admin-editable, options-validated profile attribute..."

if [[ ! -f "$REALM_FILE" ]]; then
  echo "[FF-UP1] FAIL: $REALM_FILE not found" >&2
  exit 1
fi

python3 - "$REALM_FILE" <<'PYEOF'
import json, sys

realm = json.load(open(sys.argv[1]))
fail = []

# 1. The realm-import-native declarative-user-profile component must exist.
#    (This is the ONLY shape KC 25 --import-realm activates — verified T-0734.)
prov = realm.get("components", {}).get(
    "org.keycloak.userprofile.UserProfileProvider", [])
if not prov:
    fail.append("no components.org.keycloak.userprofile.UserProfileProvider entry")
else:
    entry = prov[0]
    if entry.get("providerId") != "declarative-user-profile":
        fail.append("providerId is not 'declarative-user-profile'")
    cfgs = entry.get("config", {}).get("kc.user.profile.config", [])
    if not cfgs:
        fail.append("config.kc.user.profile.config is empty")
    else:
        try:
            profile = json.loads(cfgs[0])
        except Exception as e:
            profile = None
            fail.append("kc.user.profile.config[0] is not valid JSON: %s" % e)

        if profile is not None:
            attrs = {a.get("name"): a for a in profile.get("attributes", [])}
            at = attrs.get("actor_type")
            if at is None:
                fail.append("actor_type is not declared in the user profile")
            else:
                edit = at.get("permissions", {}).get("edit", [])
                # admin MUST be able to edit -> registrar (manage-users = admin
                # context) create persists actor_type.
                if "admin" not in edit:
                    fail.append("actor_type must be admin-editable (permissions.edit lacks 'admin')")
                # user MUST NOT be able to edit -> no self-escalation of actor_type.
                if "user" in edit:
                    fail.append("actor_type must NOT be user-editable (self-escalation risk)")
                # value must be pinned to the actor vocabulary.
                opts = (at.get("validations", {})
                          .get("options", {})
                          .get("options", []))
                if sorted(opts) != ["agent", "human"]:
                    fail.append("actor_type options validator must be exactly [human, agent], got %r" % (opts,))

if fail:
    for f in fail:
        print("  [FAIL] " + f, file=sys.stderr)
    print("[FF-UP1] FAIL: actor_type profile declaration is missing or weakened.", file=sys.stderr)
    sys.exit(1)

print("  [OK] actor_type declared: admin-editable, not user-editable, options=[human, agent]")
print("[FF-UP1] PASS: actor_type is a managed, admin-writable, options-validated profile attribute.")
PYEOF
