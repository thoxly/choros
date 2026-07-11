# Local live-proof stack recipe (dev-stand OFFLINE surrogate)

> **Purpose.** When the shared Choros dev-stand is OFFLINE, a merged
> `changes_product=1` task cannot reach `done` because its LIVE_PROOF phase has
> nowhere to run. This recipe brings up a **full local stack** (fresh Keycloak
> with the committed realm → Postgres → Choros server in **keycloak-mode** → web
> SPA) as a live-proof surrogate, and shows how to drive both **HTTP-integration**
> and **browser** proofs against it. It converts offline-stand merged work to
> proven work.
>
> First proven end-to-end on **2026-07-11** for **T-0668** (bare-fetch 401
> auth-bypass class): browser render of the Rights «Бытовые операции прав» screen
> loading live dictionaries with a Bearer token. Evidence in
> `docs/live-proof/T-0668-evidence/`.
>
> **Established pattern lineage:** builds on T-0753 (fresh KC + committed realm +
> ROPC login) and the offline-stand DURABLE note in
> `memory/choros-run-poehali-w6-2026-07-10` ("coder-agent поднимает ЛОКАЛЬНЫЙ
> полный стек → live-proof-суррогат когда dev-стенд offline").

---

## 0. Boundaries (do NOT break these)

- **Reuse** the already-running `choros-postgres-1` on host port **55432** — it is
  the dev Postgres and is at schema HEAD. Live-proofs that only **read** (GET)
  may reuse it; anything that **writes** should use a fresh throwaway DB (see §3b).
- **Do NOT touch** the founder's `e-owner` KC user, nor the pre-existing
  `t-0633-keycloak-1` (:8180) / `t-0633-postgres-1` / `choros-postgres-1`
  containers. Bring up your **own** namespaced KC on a **spare port** (this recipe
  uses **8380**).
- Work only in your worktree + your own docker containers/processes. **Tear down
  what you start** (§7). Do NOT push/merge.

---

## 1. Prerequisites (verify first)

```bash
docker ps                 # confirm choros-postgres-1 :55432 is up; note occupied ports
docker images | grep keycloak   # quay.io/keycloak/keycloak:25.0.6 should be present
node --version            # v23.x used here
# Postgres reachable + at HEAD:
PGPASSWORD=choros_dev_pw psql -h localhost -p 55432 -U choros_migrator -d choros \
  -tA -c "select version from choros.schema_migrations order by version desc limit 1;"
# -> latest migration (e.g. 132_engine_process_name_seed); compare with `ls migrations | tail -1`
```

Pick spare ports that don't collide with anything in `docker ps` / `lsof`:
- **KC host port `8380`** (→ container 8180)
- **App port `3080`** (or `3000`/`8080` if you need the browser PKCE login flow — see §5 note)

---

## 2. Fresh Keycloak with the committed realm (spare port 8380)

Keycloak 25 `start-dev --import-realm` uses strategy **IGNORE_EXISTING**, so an
in-place restart will NOT pick up realm changes — always `docker rm -f` + `docker
run` fresh so the import is clean.

```bash
cd <YOUR_WORKTREE>        # e.g. /Users/shoxy/Code/choros-wt/T-0668
docker rm -f my-kc-lp 2>/dev/null
docker run -d --name my-kc-lp \
  -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  -e KC_HTTP_PORT=8180 -e KC_HOSTNAME_STRICT=false -e KC_HTTP_ENABLED=true \
  -p 8380:8180 \
  -v "$(pwd)/config/keycloak:/opt/keycloak/data/import:ro" \
  quay.io/keycloak/keycloak:25.0.6 start-dev --import-realm
```

Wait for readiness (import + JVM start takes **~2–3.5 min** — be patient, poll):

```bash
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8380/realms/master)" = "200" ]; do sleep 5; done
curl -s -o /dev/null -w 'choros realm=%{http_code}\n' http://localhost:8380/realms/choros
docker logs my-kc-lp 2>&1 | grep -iE "imported|Import finished"   # confirms "Realm 'choros' imported"
```

> ⚡ **Gotcha:** a shell `until`/poll loop can exceed a 2-min tool timeout while KC
> is still booting. Poll in short non-looping checks, or run the loop in the
> background — do NOT assume failure just because the first poll returns `000`.

### Get a token (ROPC — proves KC + realm + issuer)

Human builder fixture `e-configurator` / `dev-pw-configurator` (actor_type=human,
DB authority chain from migration 088). Client `choros-api` / `choros-api-dev-secret`.
Other fixtures: `e-kravtsova`/`dev-pw-kravtsova`, `e-larina`/`dev-pw-larina`, …
(rank-and-file, `src/http/org.ts`); agents via client_credentials on `agent-orchestrator`.

```bash
curl -s -X POST http://localhost:8380/realms/choros/protocol/openid-connect/token \
  -d grant_type=password -d client_id=choros-api -d client_secret=choros-api-dev-secret \
  -d username=e-configurator -d password=dev-pw-configurator | python3 -m json.tool
# access_token JWT: iss=http://localhost:8380/realms/choros, aud=choros-api, actor_type=human
```

The token's `iss` embeds the **host port you exposed KC on** (8380). The server's
`KC_ISSUER` MUST match it exactly (§4), or JWT validation fails on the `iss` claim.

---

## 3. Database

### 3a. Reuse the shared dev DB (read-only proofs — simplest)

Already at HEAD; contains the demo fixtures (7 human employees, dictionaries,
tenants). GET-only proofs are safe:

```
DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros
```

### 3b. Fresh throwaway DB (needed if your proof WRITES)

```bash
PGPASSWORD=choros_dev_pw psql -h localhost -p 55432 -U choros_migrator -d postgres \
  -c "CREATE DATABASE choros_lp TEMPLATE template0;"
DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros_lp npm run migrate
# migrate runner (migrations/run.mjs) creates the choros schema, applies NNN_*.sql,
# and seeds the demo company by default (CHOROS_SEED_DEMO defaults ON).
# Drop when done: ... -c "DROP DATABASE choros_lp;"
```

> ⚡ `npm run migrate` **requires** `DATABASE_URL` in the env or it no-ops silently.

---

## 4. Build + start the Choros server in keycloak-mode

```bash
cd <YOUR_WORKTREE>
npm run build        # tsc -> dist/  (entry: dist/index.js, reads PORT env, default 8080)
npm --prefix web run build   # vite -> web/dist  (only if you need the browser proof)

# The critical env for keycloak-mode. KC_ISSUER MUST equal the token's iss.
CHOROS_AUTH_MODE=keycloak \
KC_ISSUER=http://localhost:8380/realms/choros \
KEYCLOAK_URL=http://localhost:8380 \
KEYCLOAK_PUBLIC_URL=http://localhost:8380 \
KEYCLOAK_REALM=choros \
KEYCLOAK_AUDIENCE=choros-api \
KEYCLOAK_WEB_CLIENT_ID=choros-web \
DATABASE_URL="postgres://choros_migrator:choros_dev_pw@localhost:55432/choros" \
CHOROS_WEB_DIST="$(pwd)/web/dist" \
NODE_ENV=development \
PORT=3080 \
node dist/index.js > /tmp/choros-lp-server.log 2>&1 &
```

Verify it came up in the right mode:

```bash
curl -s -o /dev/null -w 'health=%{http_code}\n' http://localhost:3080/health   # 200
curl -s http://localhost:3080/api/auth-config    # {"mode":"keycloak", "keycloak":{...}}  <- proves keycloak-mode
```

**Env var reference** (`docs/environments.md` §6/§7, resolved in `src/http/auth.ts`):
| var | value used | why |
|---|---|---|
| `CHOROS_AUTH_MODE` | `keycloak` | turns on Bearer JWT gate (`withAuth`); `dev` = x-dev-user stub |
| `KC_ISSUER` | `http://localhost:8380/realms/choros` | JWT `iss` must match; overrides KEYCLOAK_URL+realm |
| `KEYCLOAK_URL` | `http://localhost:8380` | server-side JWKS discovery base |
| `KEYCLOAK_AUDIENCE` | `choros-api` | expected `aud` claim |
| `KEYCLOAK_PUBLIC_URL`+`KEYCLOAK_WEB_CLIENT_ID` | `http://localhost:8380`, `choros-web` | shipped to browser via `/api/auth-config` for PKCE |
| `DATABASE_URL` | :55432/choros | pool for DB-backed routes |
| `CHOROS_WEB_DIST` | `web/dist` | static SPA served as router fallback |
| `PORT` | `3080` | app listen port |

> Leaving `FLOWABLE_BASE_URL` unset makes the agent-dispatch loop + lifecycle
> bridge degrade to no-ops (no Flowable needed for auth/read proofs).

---

## 5. Prove it

### 5a. HTTP-integration proof (always available; no browser needed)

Get a token (§2), then hit endpoints with and without the `Authorization: Bearer`
header. The **mechanism** to prove: in keycloak-mode a `withAuth`-gated route
returns **401 "missing Authorization header"** with no token, and passes the gate
(200, or a downstream 403/business code — i.e. **not** 401) with the token. This
is exactly what the SPA's `authHeaders()` helper supplies.

```bash
TOK=$(curl -s -X POST http://localhost:8380/realms/choros/protocol/openid-connect/token \
  -d grant_type=password -d client_id=choros-api -d client_secret=choros-api-dev-secret \
  -d username=e-configurator -d password=dev-pw-configurator \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')

# withAuth-gated route (e.g. the T-0649/T-0648 incident routes):
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3080/api/org                    # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOK" http://localhost:3080/api/org  # 200
```

> ⚡ **Do NOT wrap curl in a zsh function with array args** — a PATH quirk made
> `curl`/`sed` "command not found" inside the function. Use a **Python
> `urllib`** driver instead (see `scratchpad/proof.py` shape) — robust and
> parses JSON inline. Note some target routes (`/api/rights/dictionaries`,
> `/api/users`) are **not** server-`withAuth`-gated (the 401 in the deployed
> stand comes from the front gateway); they return 200 + live data regardless of
> token. Prove those return **live** data, and prove the 401/pass mechanism on a
> genuinely `withAuth`-gated route.

### 5b. Browser proof (strongest — Playwright; chromium already cached)

Playwright + chromium are in `node_modules` (`~/Library/Caches/ms-playwright/`).
**Bypass the interactive PKCE form by seeding the KC session directly** into
`localStorage['chs-kc-session']` (the app's `getToken()`/`isAuthenticated()` read
it). Then react-router navigates to the target screen and the fixed fetch fires
with the Bearer header.

Session shape (`web/src/app-shell/keycloak-auth.js`):
`{ accessToken, idToken, refreshToken, expiresAt:<ms epoch, future>, user:{id,sub,preferredUsername,name,position,actorType} }`

Script skeleton (run **from the worktree root** so `import 'playwright'` resolves;
`node <script>.mjs`, then delete the temp file — it lives outside `docs/`):

```js
import { chromium } from 'playwright';
// 1. fetch ROPC token via http to :8380 (browser has no client_secret)
// 2. const session = { accessToken: tok, expiresAt: Date.now()+280000, user:{...from claims} }
// 3. ctx.addInitScript(s => localStorage.setItem('chs-kc-session', JSON.stringify(s)), session)
// 4. page.on('request'/'response') to capture the fixed call's Authorization header + status
// 5. page.goto('http://localhost:3080/rights/intents', { waitUntil:'networkidle' })
// 6. assert captured Bearer header + 200 + presets>0; read document.body.innerText for live labels
// 7. page.screenshot({ path: 'docs/live-proof/<T>-evidence/screen.png', fullPage:true })
```

Full working example that produced the T-0668 evidence: see the driver preserved
in this task's session (seeds session, navigates to `/rights/intents`, captures
`/api/rights/dictionaries` carrying `Authorization: Bearer` → 200 presets=14,
screenshots the rendered «Бытовые операции прав» screen).

> **Route note:** screens are path-based (react-router); the server does SPA
> fallback, so `GET /rights/intents` serves `index.html` and the router mounts
> `IntentsScreen`. The `choros-web` realm client only whitelists redirect URIs for
> ports **3000/8080/100.121.76.86:3000** — so a **real** PKCE login needs the app
> served on 3000/8080; **seeding the session sidesteps that** and works on any port.

---

## 6. What "proven" looks like (T-0668 concrete result)

- Server `/api/auth-config` → `{"mode":"keycloak",...}` (correct mode).
- `/api/org` (withAuth): **401 "missing Authorization header"** no-token → **200**
  full org tree with token. `/api/grant-trail`: 401 → 403 (identity resolved past
  the gate, then a business authority check).
- Browser: «Бытовые операции прав» screen rendered; the `/api/rights/dictionaries`
  request **carried `Authorization: Bearer <JWT iss=…:8380 aud=choros-api>`** →
  **HTTP 200, presets=14, resources=10**; live preset labels rendered in the
  «ПРЕСЕТ-РОЛЬ» dropdown (not empty/seed). Screenshot: `T-0668-evidence/`.

---

## 7. Teardown (leave PG:55432 and t-0633 alone)

```bash
# stop the server you started:
pkill -f 'dist/index.js'          # or kill the specific PID from /tmp/choros-lp-server.log
# remove YOUR KC only:
docker rm -f my-kc-lp
# drop the throwaway DB if you made one (§3b):
PGPASSWORD=choros_dev_pw psql -h localhost -p 55432 -U choros_migrator -d postgres -c "DROP DATABASE IF EXISTS choros_lp;"
# leave: choros-postgres-1 (:55432), t-0633-keycloak-1 (:8180), t-0633-postgres-1
rm -f <worktree>/lp-*.tmp.mjs     # remove any temp browser-driver scripts (keep docs/live-proof/)
```

---

## 8. Blockers hit & resolutions (for the next wave)

| blocker | resolution |
|---|---|
| KC boot > 2 min → poll loop hits tool timeout | poll in short non-looping checks or background the wait; ~200s is normal for `start-dev --import-realm` |
| KC restart didn't pick up realm changes | `start-dev --import-realm` is IGNORE_EXISTING; always `docker rm -f` + fresh `docker run` |
| curl "command not found" inside a zsh function with array args | drive HTTP from **Python urllib**, not a shell function |
| `import 'playwright'` ERR_MODULE_NOT_FOUND from scratchpad | run the driver **from the worktree root** (node_modules is there); delete the temp file after |
| `choros-web` PKCE redirect_uri not whitelisted for :3080 | **seed `localStorage['chs-kc-session']`** to skip the form, or serve the app on 3000/8080 |
| target routes `/api/users` `/api/rights/dictionaries` return 200 without a token | they're not server-`withAuth`-gated (front-gateway concern in prod); prove **live data** on them + prove the **401/pass mechanism** on a genuinely gated route |
| `npm run migrate` silently no-ops | it needs `DATABASE_URL` in env |
