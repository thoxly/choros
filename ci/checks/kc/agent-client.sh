#!/usr/bin/env bash
# FF-8: At least one client with serviceAccountsEnabled=true and clientId matching 'agent-*' pattern.
set -euo pipefail
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

REALM_FILE="config/keycloak/realm-choros.json"

echo "[FF-8] Checking agent service-account client in realm JSON..."

COUNT=$(python3 -c "
import json
data = json.load(open('$REALM_FILE'))
clients = data.get('clients', [])
agent_clients = [
  c for c in clients
  if c.get('serviceAccountsEnabled') is True and c.get('clientId', '').startswith('agent-')
]
print(len(agent_clients))
")

if [[ "$COUNT" -lt 1 ]]; then
  echo "ERROR: no client with serviceAccountsEnabled=true and clientId starting with 'agent-' found in realm JSON" >&2
  exit 1
fi

echo "[FF-8] PASS: $COUNT agent service-account client(s) found in realm JSON."
