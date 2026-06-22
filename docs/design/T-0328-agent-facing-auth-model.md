# T-0328 — Agent-facing / non-SPA HTTP auth model (ADR)

Status: **PROPOSED** (design only — no code changed by this task)
Task: T-0328 (security) — close the `x-dev-user` bypass on agent-/worker-/vendor-facing
surfaces **before** `CHOROS_AUTH_MODE=keycloak` is enabled in production.
Branch: `task/T-0411` · base dev `b96f7cb`
Author: architect (T-0411)

---

## 0. TL;DR

Eight HTTP surfaces resolve their caller identity through a **dev-only `extractActor`**
that reads the `x-dev-user` header and is **not** wrapped in `withAuth`. They never run
the JWT validator, so in keycloak mode they cannot see the Bearer identity at all and
two failure modes appear:

- **SPA-facing surfaces** (`process-defs`, `binding` POST, `floor1-editor`,
  `secret-handle`, `process-start`, `email-channel-config`) break: the SPA stops sending
  `x-dev-user` and sends `Authorization: Bearer` instead
  (`web/src/app-shell/dev-auth.js:68`), so `extractActor` throws `401 missing x-dev-user`.
- **agent/vendor surfaces** (`invoke`, `vendor-activation`) are worse: in dev they accept
  any attacker-supplied `x-dev-user` value as the caller identity, and in keycloak mode
  there is still no token check on the route, so **the `x-dev-user` bypass is reachable
  even with `CHOROS_AUTH_MODE=keycloak`** for any surface that isn't behind `withAuth`.

The fix is **not** a new token system. Choros already validates Keycloak JWTs
(`src/http/auth.ts`), already has a mode-aware identity seam
(`resolveActorSlugFromAuth`, used by `binding.ts:126` `extractActorSlug`), and the
worker contract already documents **service-account `client_credentials`** tokens with an
`actor_type` claim (`docs/worker-api.md` §3.2–3.3). So for **7 of 8** surfaces the work is
a **mechanical `withAuth` + mode-aware-actor** wrap. Only `vendor-activation` needs a
genuinely **new credential type** (a `vendor-signed` channel cred), and it is already
gated by the activation-key signature, not by `extractActor`.

---

## 1. How auth works today (the seam this ADR builds on)

Grounding facts, all cited from the actual tree on `task/T-0411`:

| Mechanism | Where | Behaviour |
|---|---|---|
| Mode switch | `src/http/auth.ts:36` `getAuthMode()` | `CHOROS_AUTH_MODE` ∈ `dev`\|`keycloak`, default `dev`. |
| JWT validator | `src/http/auth.ts:402` `authenticate()` | keycloak mode: validates Bearer via JWKS, throws `401/503`, then stores `{sub, preferredUsername, actorType}` in a `WeakMap`. **dev mode: no-op pass-through.** |
| Guard decorator | `src/http/auth.ts:454` `withAuth()` | Wraps a handler with `authenticate()`. **Only** path that populates the identity `WeakMap`. |
| Identity read | `src/http/auth.ts:111` `getAuthContext()` | Returns the `WeakMap` value — **`undefined` unless `withAuth` ran**. |
| Mode-aware actor | `src/db/org.ts` `resolveActorSlugFromAuth(pool, sub, preferredUsername)` | keycloak: resolve JWT `sub`/`preferred_username` → `employee.slug`; the canonical bridge. |
| Worker reference impl | `src/http/externalWorker.ts:42` | The **only** surface today that does it right: every `/jobs*` route is `withAuth(...)`, plus `assertKeycloakConfig()` fail-fast. |
| JWT claim contract | `docs/worker-api.md` §3.2 | `sub`, `preferred_username` (= employee-id **or** `service-account-<clientId>`), `actor_type` ∈ `human`\|`agent`, `aud` ⊇ `choros-api`. |
| Service-account cred | `docs/worker-api.md` §3.3 | Agents already obtain tokens via Keycloak `grant_type=client_credentials` (`client_id=agent-orchestrator`). |

**The canonical correct pattern** is already in the tree at `binding.ts:126`:

```ts
async function extractActorSlug(req, pool): Promise<string> {
  const ctx = getAuthContext(req);                 // populated ONLY if withAuth ran
  if (ctx !== undefined) {                          // keycloak path
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) throw new HttpError(401, "UNAUTHENTICATED", ...);
    return slug;
  }
  // dev path: x-dev-user
  ...
}
```

Every surface below should converge on this shape (route wrapped in `withAuth`,
identity read via `getAuthContext`→`resolveActorSlugFromAuth`, dev `x-dev-user` retained
only as the dev-mode fallback). The two distinct `extractActor` flavours in the codebase
are exactly the gap: the **dev-only** one (`invoke.ts:91`, `binding.ts:112`,
`process-defs.ts:55`, `process-start.ts:56`, `floor1-editor.ts:97`,
`email-channel-config.ts:219`, `secret-handle.ts`) vs the **mode-aware** one
(`binding.ts:126`, `seed-write.ts:77`, `notifications.ts:76`).

### 1.1 The bug class, precisely

`getAuthContext()` returns `undefined` for any route **not** wrapped in `withAuth`, in
**both** modes (the `WeakMap` is only written by `authenticate()`). So a dev-only
`extractActor` that does `if (!devUser) throw 401`:

- in **dev** mode: trusts the unauthenticated client-supplied `x-dev-user` (acceptable for dev only);
- in **keycloak** mode: there is no `getAuthContext` value to fall back to → it still reads
  `x-dev-user`, which the SPA no longer sends → `401`, **and** if a caller *does* send
  `x-dev-user`, the route honours it with **no token validation at all**. That is the
  production bypass T-0328 must close.

---

## 2. The 8 surfaces

For each: route(s) · who calls it · current auth state · trust model needed.

### 2.1 `invoke` — `src/http/invoke.ts`
- **Routes:** `POST /api/invoke/request` (`:277`), `POST /api/invoke/command` (`:346`).
- **Who calls it:** the **agent runtime** — one agent asks the platform to invoke (or
  propose invoking) another *provisioned agent* toward a `goal`. Authorization is a real
  fail-closed grant check (`coversInvoke`, `loadCallerInvokeGrants`, `403` on no covering
  invoke-grant, `invoke.ts:304-315`). Not an SPA screen.
- **Current auth:** `callerId = extractActor(req)` (dev-only `x-dev-user`, `:91`/`:278`/`:347`).
  **No `withAuth`.** `tenantId` is hard-pinned to `DEV_TENANT_ID` (`:279`). In keycloak mode
  the caller identity that drives the grant decision is an **unauthenticated header** → an
  attacker can impersonate any `callerId` and ride that actor's invoke-grants.
- **Trust model needed:** **agent-runtime-identity.** The caller is a non-human service
  principal; identity must be a validated service-account JWT with `actor_type=agent`, and
  `callerId` must be derived from the token, never from a header.

### 2.2 `process-defs` — `src/http/process-defs.ts`
- **Routes:** `POST /api/process-defs` (`:223`), `GET /api/process-defs` (`:298`),
  `GET /api/process-defs/:key` (`:324`), `POST /api/process-defs/:key/publish` (`:364`).
- **Who calls it:** the **SPA** process editor (`web/src/canvas/process-editor-api.js:47/94/128`,
  `screen-process-editor.jsx`). A human process-designer saves/publishes BPMN.
- **Current auth:** writes call dev-only `extractActor` (`:225`/`:366`); header doc explicitly
  says "Auth via x-dev-user convention" (`:16`). **No `withAuth`.** The SPA sends
  `authHeaders()` which is Bearer in keycloak mode → these writes 401 in prod.
- **Trust model needed:** **keycloak-SSO** (human in SPA), and the write path *should* enforce
  the `process_designer` role like `binding.ts` does — today it only asserts "authenticated".

### 2.3 `binding` — `src/http/binding.ts`
- **Routes:** `GET`/`POST /tenants/:tenantId/processes/:processKey/forms/:formKey/binding`
  (`:234`/`:263`); actor-scoped `GET`/`POST /api/forms/binding` (`:344`/`:382`).
- **Who calls it:** the **SPA** form builder / inbox (`web/src/forms/FormBuilder.jsx:296/372`,
  `screen-inbox.jsx:164`). Human process-designer / assignee.
- **Current auth (mixed — the tell):** the legacy tenant-pathed `POST` uses **dev-only**
  `extractActor` (`:112`/`:265`) and is **not** wrapped; the newer `/api/forms/binding`
  routes already use the **mode-aware** `extractActorSlug` (`:126`/`:345`/`:383`) — so this
  file already contains the target pattern next to the broken one. `checkRole` (`:157`) is
  already mode-aware (`process_designer` lookup in keycloak, soft in dev). Neither route is
  `withAuth`-wrapped, so even `extractActorSlug` never gets a populated `getAuthContext` →
  in keycloak mode it falls through to `x-dev-user` and 401s.
- **Trust model needed:** **keycloak-SSO.** Make the legacy `POST` mode-aware (use
  `extractActorSlug`) and wrap all binding routes in `withAuth`.

### 2.4 `process-start` — `src/http/process-start.ts`
- **Route:** `POST /api/processes/start` (handler `makeStartInstanceHandler`, `:125`;
  registered via `registerProcessesRoutes` in `server.ts:423`).
- **Who calls it:** the **SPA** processes screen (`web/src/app-shell/nav-config.js:122`).
  A human starts a process instance. Header doc: `x-dev-user` (actor) + `x-tenant-id`
  (`process-start.ts:8`). The handler is **FROZEN** per `server.ts:420` ("T-0280, FROZEN
  ADR §2.2") — so this surface is a *design-around*, like secret-handle: do not rewrite its
  body; wrap it.
- **Current auth:** dev-only `extractActor` (`:56`/`:130`), `401` if no `x-dev-user`; real
  cross-tenant deny via `resolveActorTenant` (`:160-165`). **No `withAuth`.** 401s in prod
  for the same reason as the others.
- **Trust model needed:** **keycloak-SSO.** Because the handler is frozen, prefer the
  **registration-site `withAuth` wrap** (wrap the handler returned by
  `makeStartInstanceHandler` at `server.ts:423`) plus a mode-aware actor resolver injected
  as a dep — without editing the frozen body. (See §3.4.)

### 2.5 `floor1-editor` — `src/http/floor1-editor.ts`
- **Route:** `POST /tenants/:tenantId/processes/:processKey/forms/:formKey/edits` (`:381`).
- **Who calls it:** stateless Floor-1 form-edit transform. Header doc says callers are
  "UI, agents" (`:41`); no SPA screen wires it yet (no `web/src` reference found) — it is a
  **process-authoring surface** invoked by the editor/agents and reuses `binding.ts`
  `checkRole` (`process_designer`).
- **Current auth:** dev-only `extractActor` (`:97`/`:386`); `authorizeEditor`→`checkRole`
  is already mode-aware (`:124-137`). **No `withAuth`.** Same break in keycloak.
- **Trust model needed:** **keycloak-SSO** for the human-editor path. Because the doc also
  names "agents" as callers, the actor resolver must accept both `actor_type=human` and
  `actor_type=agent` tokens (the `process_designer` role check then decides authorization
  uniformly). Mechanically the same wrap as `binding`.

### 2.6 `email-channel-config` — `src/http/email-channel-config.ts`
- **Routes:** `GET`/`PUT`/`DELETE /api/email-channel-config` (`:277`/`:300`/`:338`).
- **Who calls it:** **tenant-admin via SPA** (header doc `:5`). No SPA screen wires it yet
  (no `web/src` reference found) — but the trust model is human-admin: authorization is a
  real PDP gate `loadAdminContext` / `mgmt_object:email_config` with genesis-owner override
  (`:77-95`).
- **Current auth:** dev-only `extractActor` (`:219`/`:278`/`:301`/`:339`). **No `withAuth`.**
  Authz is real, but the *identity* feeding it is an unauthenticated header in keycloak mode.
- **Trust model needed:** **keycloak-SSO** (tenant admin). Mechanical `withAuth` + mode-aware
  actor; the existing PDP gate is correct and stays.

### 2.7 `vendor-activation` — `src/http/vendor-activation.ts`
- **Routes:** `GET /vendor/activation` (`:102`), `POST /vendor/updates/check` (`:114`),
  `POST /vendor/agentic-ops/run` (`:121`), `GET /vendor/support/ticket` (`:128`).
- **Who calls it:** the **vendor control plane** (the Choros vendor's own ops/billing
  services) — the circuit↔vendor boundary (`:3-7`). Never user-facing (`FF-T127-4`).
- **Current auth:** **none via `extractActor`** — this surface does **not** read identity at
  all. It gates on the **activation-key signature / entitlement state** (`isEntitled`,
  `currentActivationStatus`, `:56`/`refuseIfNotEntitled`): `402` no/expired entitlement,
  `403` invalid signature or not-entitled. So it is *not* part of the `x-dev-user` bypass —
  but it is non-SPA and has a **different trust model** that must be made explicit.
- **Trust model needed:** **vendor-signed.** Identity = a signed activation key /
  vendor-issued credential, independent of Keycloak (the vendor plane is a separate trust
  domain from a tenant's user directory). The existing signature check is the right
  primitive; T-0328 should (a) confirm the signature verification is real and fail-closed
  before prod, and (b) document that these routes intentionally bypass `withAuth`.

### 2.8 `secret-handle` — `src/http/secret-handle.ts` **(FROZEN — design-around only)**
- **Routes:** `POST`/`PUT`/`DELETE /api/agents/:agentId/secret-handle`,
  `GET .../secret-handle/status` (`:6-9`).
- **Who calls it:** the **SPA** agents screen, "Привязать LLM" (`web/src/screens/screen-agents.jsx:203`,
  `agents-form.js`). A human binds a BYO-LLM key for an agent.
- **Current auth:** dev-only `extractActor` (`x-dev-user`, header doc `:12`); authz via
  `loadAdminContext` + `holdsAgentMgmtUpdate` (`403` if denied). **No `withAuth`.** File is
  **FROZEN by founder-sanction — do not edit it.**
- **Trust model needed:** **keycloak-SSO** (human, agent-mgmt:update authority). Because the
  file is frozen, the fix must come **at the registration site** (`server.ts:371`
  `registerSecretHandleRoutes`) — wrap the registered handlers in `withAuth` from the
  outside, or have the composition root inject a mode-aware actor resolver. No edit to
  `secret-handle.ts` itself. (See §3.4 "frozen design-around".)

---

## 3. Credential / token design

### 3.1 Principle: one validator, three principal kinds

Choros already has exactly one token validator (`authenticate`/JWKS) and one identity
bridge (`resolveActorSlugFromAuth`). We do **not** introduce a parallel token system.
Instead we recognise three **principal kinds**, all minted by the same Keycloak realm and
all validated by the same `withAuth`, distinguished by the `actor_type` claim and the
Keycloak client that issued them — plus one out-of-band vendor channel.

| Principal kind | Issued by | Claim signal | Surfaces |
|---|---|---|---|
| **keycloak-SSO (human)** | `choros-web` public PKCE client (SPA) | `actor_type=human`, `preferred_username`=employee slug | process-defs, binding, floor1 (human), email-config, process-start, secret-handle |
| **agent-runtime-identity** | Keycloak **service-account** client (`grant_type=client_credentials`, e.g. `agent-orchestrator`) | `actor_type=agent`, `preferred_username=service-account-<clientId>` | invoke, floor1 (agent caller), `/jobs` workers |
| **vendor-signed** | Vendor control plane (out-of-band signing key) | activation-key signature (not a Keycloak JWT) | vendor-activation |

The first two are **already specified** in `docs/worker-api.md` §3.2–3.3 and validated by
the existing code — there is no new credential to build, only **provisioning** (create the
service-account client in the realm) and **wiring** (`withAuth` + mode-aware actor).

### 3.2 agent-runtime-identity (for `invoke`) — service-account JWT

- **How it authenticates:** the agent runtime obtains a token from Keycloak via
  `grant_type=client_credentials` against a dedicated service-account client (the realm
  already ships `agent-orchestrator`, `docs/worker-api.md:196`). The token carries
  `actor_type=agent` and `preferred_username=service-account-<clientId>`.
- **Where the token lives:** the client secret lives only in the agent-runtime's
  environment / secret store (never in the browser, never in the DB). The **access token**
  is short-lived and request-scoped — fetched on demand, held in memory, never persisted.
  This mirrors how `secret-handle` keeps the *LLM* key opaque: the agent's own Keycloak
  credential is likewise never stored by Choros.
- **Rotation:** rotate the Keycloak **client secret** out-of-band (Keycloak admin); access
  tokens rotate automatically via their short TTL. No Choros code change to rotate.
- **Scoping:** the service-account is mapped to an `employee`/agent identity via
  `resolveActorSlugFromAuth` (`sub`/`preferred_username` → slug), and `invoke`'s authorization
  remains the existing **invoke-grant** check (`coversInvoke`) — the token authenticates the
  caller, the grant lattice authorizes the action. Per-agent least privilege is therefore
  expressed as grants, not as token scopes.
- **Identity derivation change required:** `invoke.ts` must derive `callerId` from
  `getAuthContext`→`resolveActorSlugFromAuth` (keycloak) with `x-dev-user` only as the
  dev fallback — i.e. promote its dev-only `extractActor` (`:91`) to the `binding.ts:126`
  mode-aware shape — and the hard-pinned `DEV_TENANT_ID` (`:279`) must be replaced by the
  actor's resolved tenant before prod multi-tenant (tracked separately, but called out here
  because it is co-located with the auth bypass).

### 3.3 keycloak-SSO (humans) — already minted, just enforce it

No new credential. The SPA already attaches `Authorization: Bearer <access token>` in
keycloak mode for every screen (`web/src/app-shell/dev-auth.js:68-95`). The surfaces simply
need to (a) be wrapped in `withAuth` so the token is validated and `getAuthContext`
populated, and (b) read the actor via the mode-aware `extractActorSlug` pattern instead of
the dev-only `extractActor`. Rotation/scoping are owned by Keycloak (token TTL, realm roles
e.g. `process_designer`). The dev `x-dev-user` path stays as the dev-mode fallback inside
the mode-aware resolver, so dev ergonomics are unchanged.

### 3.4 Frozen design-around (`secret-handle`, `process-start`)

Two surfaces must not be edited in-body: `secret-handle.ts` (founder-frozen) and the
`makeStartInstanceHandler` body (`server.ts:420` "FROZEN ADR §2.2"). For these, apply the
guard **at the composition root** without touching the frozen file:

- **`withAuth` at the registration site:** `withAuth` is a pure handler decorator
  (`auth.ts:454`). Wrapping the *registered* handler validates the Bearer token and
  populates `getAuthContext` **before** the frozen body runs — no change to the frozen file.
  For `secret-handle`, this is done where `registerSecretHandleRoutes` is called
  (`server.ts:371`); for `process-start`, where the handler from `makeStartInstanceHandler`
  is registered (`server.ts:423`).
- **Mode-aware actor without editing the body:** because `withAuth` populates the
  `WeakMap`, the frozen body's *existing* `extractActor(x-dev-user)` still 401s in keycloak
  mode. Two acceptance-safe options, decided at implementation time:
  1. **Preferred:** inject a mode-aware actor resolver as a *dependency* the frozen handler
     already accepts (both handlers take a `deps`/factory object) — if the frozen contract
     exposes the resolver as a seam, swap in the `resolveActorSlugFromAuth`-backed one with
     no body edit.
  2. **Fallback:** add a thin **pre-handler** at the registration site that, in keycloak
     mode, reads `getAuthContext`, resolves the slug, and **sets `req.headers['x-dev-user']`
     to the resolved slug** before delegating to the frozen handler. This keeps the frozen
     body byte-identical while making it honest (the value it now trusts is a
     JWT-validated slug, not an attacker header). This is a *façade*, explicitly allowed
     because it adds no logic to the frozen surface.

Both options keep the frozen files untouched; the choice is an implementation detail for
the build task and should be the one the founder-frozen sanction permits.

### 3.5 vendor-signed (`vendor-activation`)

Keep this surface **outside** `withAuth` by design — it is a different trust domain (the
vendor, not a tenant's Keycloak). The credential is the **signed activation key** already
verified by `currentActivationStatus`/`isEntitled`. T-0328's deliverable here is
**documentation + a verification audit**, not a wrap:
- confirm the signature check is cryptographic and fail-closed (`invalid` → `403`) before
  prod;
- add an explicit allowlist/comment that `/vendor/*` legitimately bypasses `withAuth`, so a
  future "every route must be `withAuth`" fitness check doesn't false-flag it (or, better,
  bind these to a vendor-mTLS / network ACL at the ingress so they are unreachable from
  tenant traffic).

---

## 4. Rollout

### 4.1 Order (each step independently shippable, dev stays green)

1. **Promote `invoke` to mode-aware identity + `withAuth`** (highest severity: agent
   surface, real grant authority driven by a spoofable header). Wrap both routes; derive
   `callerId` from the token. — *P0*
2. **Wrap the human-SSO writes** so the SPA works in keycloak mode and the header bypass
   closes: `process-defs` (writes), `binding` (legacy `POST` → mode-aware + wrap all
   binding routes), `email-channel-config`, `floor1-editor`. Each is the same mechanical
   transform; ship in one or a few PRs. — *P0/P1*
3. **Frozen design-around** for `secret-handle` and `process-start` at the registration
   site (§3.4). — *P0* for secret-handle (it guards LLM-key custody), *P1* for process-start.
4. **vendor-activation**: signature-verification audit + explicit `withAuth`-bypass
   allowlist / ingress ACL. — *P1*, no code wrap.
5. **Provision the Keycloak service-account client** for the agent runtime in the
   production realm (`config/keycloak/realm-choros.json`) with `actor_type=agent`. — *P0*
   prerequisite for step 1 in prod.
6. **Add a fitness guard**: "every `src/http/*` route handler is `withAuth`-wrapped **or**
   on the documented vendor-bypass allowlist" — turns this class of bug into a CI failure.
   — *P2* (durable prevention).

### 4.2 Top risks

1. **Silent prod breakage on flip.** Enabling `CHOROS_AUTH_MODE=keycloak` *without* steps
   1–3 makes every SPA write (process editor, form builder, agent LLM-bind, process start,
   email config) 401 in production — the screens look broken with no server error. The
   keycloak-enable MUST be gated on the must-close list below. *Mitigation:* an e2e
   keycloak-mode smoke that exercises one write per surface before flip.
2. **Frozen-file constraint forcing a façade.** `secret-handle` and `process-start` cannot
   be edited; the registration-site wrap / header-façade (§3.4) is correct but easy to get
   subtly wrong (e.g. wrapping the wrong handler, or the façade not running before the
   frozen body). *Mitigation:* a test asserting that in keycloak mode an unauth request to
   each frozen surface returns `401` *and* a valid Bearer is accepted — proving the wrap is
   actually in the request path.
3. **`invoke` tenant pin + spoofable caller.** `invoke` both trusts `x-dev-user` for the
   grant decision **and** pins `DEV_TENANT_ID`. Fixing only the token without the tenant
   resolution leaves a cross-tenant gap; fixing both at once risks scope-creep into the
   multi-tenant work. *Mitigation:* close the auth bypass first (derive `callerId` from
   token), file the `DEV_TENANT_ID` pin as a tracked follow-up, and keep `invoke` single-
   tenant-only until then.

### 4.3 MUST be closed before `CHOROS_AUTH_MODE=keycloak` in production

- [ ] **`invoke`** — `withAuth`-wrapped; `callerId` derived from validated token, **not**
      `x-dev-user`. (P0 — agent surface with real grant authority.)
- [ ] **`secret-handle`** — registration-site `withAuth` wrap so LLM-key custody is behind a
      validated human identity (frozen body untouched). (P0 — secret custody.)
- [ ] **`process-defs` writes** (`POST`, `POST .../publish`) — `withAuth` + mode-aware actor.
- [ ] **`binding`** legacy `POST .../binding` — promoted to `extractActorSlug`; all binding
      routes `withAuth`-wrapped.
- [ ] **`email-channel-config`** (PUT/DELETE) — `withAuth` + mode-aware actor.
- [ ] **`floor1-editor`** — `withAuth` + mode-aware actor (human + agent `actor_type`).
- [ ] **`process-start`** — registration-site `withAuth` wrap (frozen body untouched).
- [ ] **`vendor-activation`** — activation-key signature verified, fail-closed, and routes
      either ingress-isolated from tenant traffic or on a documented `withAuth`-bypass
      allowlist.
- [ ] **Keycloak realm** ships the agent service-account client (`actor_type=agent`) in the
      prod realm export.
- [ ] **Negative test** per surface: keycloak mode, `x-dev-user` supplied but **no** Bearer
      → `401` (proves the header bypass is dead in prod).

---

## 5. Summary table

| # | Surface (file) | Caller | Recommended model | Mechanical `withAuth` vs new credential | Priority |
|---|---|---|---|---|---|
| 1 | `invoke` (`src/http/invoke.ts`) | agent runtime (agent→agent) | **agent-runtime-identity** (service-account JWT) | mechanical `withAuth` **+ identity change** (derive caller from token); credential already exists in realm | **P0** |
| 2 | `secret-handle` (`src/http/secret-handle.ts`, FROZEN) | SPA human (LLM-key bind) | **keycloak-SSO** | mechanical — **registration-site `withAuth`** (no body edit) | **P0** |
| 3 | `process-defs` (`src/http/process-defs.ts`) | SPA human (process designer) | **keycloak-SSO** | mechanical `withAuth` + mode-aware actor | **P0** |
| 4 | `binding` (`src/http/binding.ts`) | SPA human (form builder/inbox) | **keycloak-SSO** | mechanical — promote legacy `POST` to `extractActorSlug`, wrap all | **P0** |
| 5 | `email-channel-config` (`src/http/email-channel-config.ts`) | SPA tenant-admin | **keycloak-SSO** | mechanical `withAuth` + mode-aware actor | **P1** |
| 6 | `floor1-editor` (`src/http/floor1-editor.ts`) | SPA human + agents (form-edit) | **keycloak-SSO** (human + agent token) | mechanical `withAuth` + mode-aware actor | **P1** |
| 7 | `process-start` (`src/http/process-start.ts`, FROZEN handler) | SPA human (start process) | **keycloak-SSO** | mechanical — **registration-site `withAuth`** (no body edit) | **P1** |
| 8 | `vendor-activation` (`src/http/vendor-activation.ts`) | vendor control plane | **vendor-signed** (activation key) | **new credential type** (already present as activation-key signature); **not** a `withAuth` wrap — audit + ingress ACL | **P1** |

---

## 6. Rejected alternatives

- **A bespoke per-surface API-key table.** Rejected: Choros already has one validated token
  path (Keycloak JWT) and one identity bridge; a second authority subsystem violates the
  "single decision path" discipline seen across `invoke`/`grants` and doubles the rotation
  surface. Service-account `client_credentials` gives us agent identity for free.
- **Editing `secret-handle.ts` / the frozen `process-start` body to call
  `extractActorSlug`.** Rejected: both are frozen. The registration-site `withAuth` wrap +
  optional header-façade (§3.4) achieves the same guard without mutating a frozen surface.
- **Putting `vendor-activation` behind Keycloak.** Rejected: the vendor plane is a separate
  trust domain from a tenant's user directory; its credential is the signed activation key,
  not an employee JWT. Forcing it through `withAuth` would conflate two trust domains.
- **Flipping `CHOROS_AUTH_MODE=keycloak` first and fixing fallout reactively.** Rejected:
  the failure is silent SPA breakage (401 on writes) and a still-open header bypass on
  agent surfaces; the must-close list (§4.3) gates the flip instead.
