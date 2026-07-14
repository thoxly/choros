#!/usr/bin/env bash
# ci/checks/worker-api-docs.sh
# FF-9 (static-now): docs/worker-api.md синхронизирован с кодом.
# Падает при дрейфе (добавление эндпоинта/поля/error-code без правки доки).
# T-0066 · E1.5 · Документация external-worker API
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DOC="${ROOT}/docs/worker-api.md"

echo "[FF-9] Checking docs/worker-api.md (T-0066 worker-api-docs)..."

# AC-14: файл существует
if [[ ! -f "$DOC" ]]; then
  echo "  FAIL: $DOC not found" >&2; exit 1
fi

fail() { echo "  FAIL [$1]: $2" >&2; exit 1; }

check_count() {
  local id="$1" pattern="$2" min="$3"
  local count
  count=$(grep -cE "$pattern" "$DOC" || true)
  [[ "$count" -ge "$min" ]] || fail "$id" "pattern '$pattern' found $count times, expected >= $min"
  echo "  [OK] $id: $count matches"
}

# AC-1: все 4 эндпоинта (route literals из externalWorker.ts)
check_count "AC-1" \
  'POST /jobs|POST /external-task/fetch-and-lock|POST /external-task/.*complete|POST /external-task/.*fail' 4

# AC-2: поля POST /jobs (externalWorker.ts строки 49, 56, 67, 73, 85)
check_count "AC-2" '\btopic\b|\bvariables\b|\bretries\b|\bidempotencyKey\b' 4

# AC-3: поля fetch-and-lock (externalWorker.ts строки 122-127)
check_count "AC-3" '\bworkerId\b|\btopics\b|\bmaxJobs\b|\blockDurationMs\b' 4

# AC-4: Job-объект (src/core/types.ts interface Job — 9 полей)
check_count "AC-4" \
  '\bid\b|\btopic\b|\bvariables\b|\bstate\b|\bretries\b|\blockOwner\b|\blockExpiry\b|\bcreatedAt\b|\bavailable_at\b' 9

# AC-5: error codes (jobStoreTypes.ts ErrorCode union + auth.ts UNAUTHENTICATED + AUTH_UNAVAILABLE)
check_count "AC-5" \
  'NOT_FOUND|NOT_LOCKED|LOCK_EXPIRED|NOT_OWNER|RECORD_IN_PAYLOAD|UNAUTHENTICATED|AUTH_UNAVAILABLE' 7

# AC-6: happy-path walkthrough (enqueue → fetch-and-lock → complete)
check_count "AC-6" 'enqueue|fetch.and.lock|complete' 3

# AC-7: curl примеры (≥4 — по одному на каждый эндпоинт)
check_count "AC-7" 'curl' 4

# AC-8: python блок
check_count "AC-8" '```python|```py' 1

# AC-9: оба auth-режима (x-dev-user, Bearer, CHOROS_AUTH_MODE)
check_count "AC-9" 'x-dev-user|Bearer|CHOROS_AUTH_MODE' 3

# AC-10: env vars поштучно (environments.md §7 + auth.ts resolveConfig())
for VAR in CHOROS_AUTH_MODE KEYCLOAK_URL KEYCLOAK_REALM KEYCLOAK_AUDIENCE JWKS_CACHE_TTL_MS; do
  grep -q "$VAR" "$DOC" || fail "AC-10" "env var $VAR missing from $DOC"
  echo "  [OK] AC-10: $VAR found"
done

# AC-11: retry семантика (retryTimeoutMs, CREATED, FAILED, lock-reclaim, sweepInterval, 30)
check_count "AC-11" 'retryTimeoutMs|CREATED|FAILED|lock.reclaim|sweepInterval|30' 4

# AC-12: idempotency
check_count "AC-12" 'idempotencyKey|idempotent' 2

echo "[FF-9] PASS: all docs/worker-api.md checks passed."
