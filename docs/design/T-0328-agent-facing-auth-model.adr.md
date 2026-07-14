# T-0328 — Agent-facing / non-SPA HTTP auth model (ADR)

Status: **ready** (DESIGN only — this task changes no production code)
Task: T-0328 (security) — close the non-SPA / agent-facing `extractActor → x-dev-user`
bypasses **before** `CHOROS_AUTH_MODE=keycloak` is enabled in production.
Branch: `task/T-0328` · base `dev` `4c36b76`
Author: architect (T-0328)
Supersedes the PROPOSED design `docs/design/T-0328-agent-facing-auth-model.md`; builds on the
agent-identity resolution ADR `docs/design/T-0423-agent-service-account-identity.md`.

> **Why a second pass exists.** The original T-0328 design (PROPOSED) named eight surfaces and
> recommended a `withAuth` + mode-aware-actor wrap for seven of them, plus a vendor-signed
> exception for the eighth. That design was then **largely implemented** across T-0418 / T-0420 /
> T-0424 / T-0425 / T-0468 (the `withAuth` wraps + mode-aware `extractActor`) and T-0423
> (the `actor_type=agent` resolver). This ADR records the **realized** state on `dev`, isolates the
> **two real residual gaps** that still block a safe keycloak-prod flip, and gives a minimal,
> reversible per-surface plan plus the durable fitness guard. It is the canonical, schema-shaped
> handoff; the prior `.md` is retained for narrative history.

---

## 1. Decision (summary)

The bypass is **not** a new token system. Choros has exactly one JWT validator
(`src/http/auth.ts` `authenticate()` / `withAuth()`), one identity `WeakMap`
(`getAuthContext()`), one human bridge (`resolveActorSlugFromAuth`, `kind='human'`-only), and one
agent bridge (`resolveAgentSlugFromAuth`, `kind='agent'`-only, T-0423). The eight surfaces are
classified into **three trust models**, all using these existing primitives:

- **keycloak-SSO (human, optionally agent):** `process-defs`, `binding`, `floor1-editor`,
  `email-channel-config`, `secret-handle`, `process-start`. The route is `withAuth`-wrapped (Bearer
  validated, `getAuthContext` populated) and the actor is read mode-aware (token in keycloak,
  `x-dev-user` only as the dev-mode fallback).
- **agent-runtime-identity (service-account JWT, `actor_type=agent`):** `invoke` (and the agent
  caller of `floor1-editor`). Caller derived from the validated token via `resolveAgentSlugFromAuth`,
  never from a header; authorization stays the existing fail-closed invoke-grant lattice.
- **vendor-signed:** `vendor-activation`. A separate trust domain (the vendor control plane, not a
  tenant's Keycloak directory). Credential = the signed activation key, verified offline and
  fail-closed. **Intentionally** outside `withAuth`; documented on an allowlist so a future
  "every route is `withAuth`-or-allowlisted" guard does not false-flag it.

**Realized state on `dev` `4c36b76` (verified file-by-file):** five surfaces are already correctly
wrapped and mode-aware — `invoke` (T-0418/0424, agent+human disjoint resolvers + tenant derived
from caller), `process-defs` (T-0418/0468), `binding` (T-0418), `floor1-editor` (T-0420/0425,
agent-callable), `email-channel-config` (T-0420). Both frozen surfaces are `withAuth`-wrapped **at
the registration site** — `secret-handle` via `withAuthRegistrar(router)` (`server.ts:582`) and
`process-start` via `withAuth(makeStartInstanceHandler(...))` (`processes.ts:249`). `vendor-activation`
already carries the intentional-bypass documentation block (`vendor-activation.ts:92-116`) referencing
this ADR §3.5.

**Two residual gaps remain** (this is the actionable core of T-0328):

- **G1 — frozen-body actor-resolution in keycloak mode.** `withAuth` on `process-start` and
  `secret-handle` **closes the bypass** (a bare `x-dev-user` no longer reaches the body in keycloak
  mode → 401) but does **not make the surface functional**: the frozen bodies still read identity
  from `req.headers['x-dev-user']` (and `process-start` also from `x-tenant-id`), which the SPA stops
  sending in keycloak mode. So in keycloak mode these two surfaces 401 **even with a valid Bearer**.
  The fix is a **registration-site pre-handler façade** that, after `withAuth`, resolves the slug from
  `getAuthContext` and **injects it into `req.headers['x-dev-user']`** (and the resolved tenant into
  `x-tenant-id` for `process-start`) before delegating to the frozen body — leaving both frozen files
  byte-unchanged. This is additive and needs **no founder thaw** (see §4).
- **G2 — no durable fitness guard.** Nothing in CI proves "every `src/http/*` route is `withAuth`-
  wrapped or on the documented vendor allowlist." This bug-class can silently reappear. T-0328 adds a
  static guard (§5).

---

## 2. The 8 surfaces — per-surface decision (grounded in the tree on `task/T-0328`)

| # | Surface (file) | Caller / trust model | Auth model | Realized state on `dev` `4c36b76` | Residual |
|---|---|---|---|---|---|
| 1 | `invoke.ts` | agent runtime (agent→agent); fail-closed invoke-grant authz | **agent-runtime-identity** (+human fallback) | DONE (T-0418/0424): `withAuth` both routes; `extractCallerId` branches on `ctx.actorType` → `resolveAgentSlugFromAuth` / `resolveActorSlugFromAuth`; tenant derived via `resolveInvokeTenant`→`resolveActorTenant` (keycloak), `DEV_TENANT_ID` only in dev | none (auth); follow-ups owned by T-0423 |
| 2 | `process-defs.ts` | SPA human (process_designer) | **keycloak-SSO** | DONE (T-0418/0468): all routes `withAuth`; mode-aware `extractActor`; tenant from `resolveActorTenant`, never `x-tenant-id` | none |
| 3 | `binding.ts` | SPA human (form builder/inbox) | **keycloak-SSO** | DONE (T-0418): legacy `POST` promoted to `extractActorSlug`; all routes `withAuth`; `checkRole` mode-aware | none |
| 4 | `floor1-editor.ts` | SPA human **+ agents** (form-edit) | **keycloak-SSO (human + agent)** | DONE (T-0420/0425): `withAuth`; `extractActor` branches `actor_type` → agent/human resolver; `authorizeEditor`→`checkRole` | none |
| 5 | `email-channel-config.ts` | SPA tenant-admin (PDP `mgmt_object:email_config`) | **keycloak-SSO** | DONE (T-0420): GET/PUT/DELETE `withAuth`; mode-aware `extractActor`; PDP gate intact | none (see note: `DEV_TENANT_ID` pin, §4.3 follow-up) |
| 6 | `process-start.ts` (FROZEN contract) | SPA human (start instance) | **keycloak-SSO** | PARTIAL (T-0420): `withAuth` at `processes.ts:249`. Frozen body still reads `x-dev-user` + `x-tenant-id` → 401 in keycloak even with a valid Bearer | **G1** — façade |
| 7 | `secret-handle.ts` (**FROZEN** — founder-sanction) | SPA human (LLM-key bind; `mgmt_object:agent/update`) | **keycloak-SSO** | PARTIAL (T-0418): `withAuth` via `withAuthRegistrar(router)` at `server.ts:582`. Frozen body still reads `x-dev-user` → 401 in keycloak even with a valid Bearer | **G1** — façade (additive, no thaw) |
| 8 | `vendor-activation.ts` | vendor control plane (circuit↔vendor) | **vendor-signed** | DONE (T-0420): intentional `withAuth`-bypass; gated by Ed25519 activation-key signature (`verifyKey`/`isEntitled`), fail-closed `403/402`; documented at `:92-116` | none in code; **G2** allowlist entry |

### 2.1 The bug class, precisely (unchanged from the prior design, still the invariant)

`getAuthContext()` returns the identity `WeakMap` value, which is populated **only** by
`authenticate()` inside `withAuth()`. A route **not** wrapped in `withAuth` therefore sees
`getAuthContext() === undefined` in **both** modes, so a dev-only `extractActor` falls through to
`x-dev-user` even in keycloak mode — an unauthenticated header driving an authorization decision.
That is the bypass. Wrapping the route in `withAuth` (a) makes keycloak mode reject a request with
no valid Bearer (401) and (b) populates `getAuthContext` so a mode-aware actor can be read. **G1**
is the residue: a frozen body that cannot itself read `getAuthContext` needs the resolved identity
handed to it through the channel it already reads (`x-dev-user`).

---

## 3. The credential model concretely (one validator, three principal kinds)

| Principal kind | Issued by | Validated claim signal | Surfaces |
|---|---|---|---|
| **keycloak-SSO (human)** | `choros-web` public PKCE client | `actor_type=human`, `preferred_username`=employee slug | process-defs, binding, floor1 (human), email-config, process-start, secret-handle |
| **agent-runtime-identity** | Keycloak service-account client (`grant_type=client_credentials`, e.g. `agent-recon`) | `actor_type=agent`, `preferred_username=service-account-<clientId>` | invoke, floor1 (agent caller), `/jobs` workers |
| **vendor-signed** | Vendor control plane (out-of-band Ed25519 key) | activation-key signature (NOT a Keycloak JWT) | vendor-activation |

### 3.1 The worker / service-token model (3–4 sentences)

The "worker token" is a **Keycloak service-account access token** obtained by the agent runtime via
`grant_type=client_credentials` against a confidential per-agent client (the realm already ships
`agent-orchestrator`/`agent-recon`/`agent-invoice`/`agent-triage` with `serviceAccountsEnabled`,
an `actor-type-mapper` emitting `actor_type=agent`, and an audience-mapper adding `choros-api`). It
is validated by the **same** `withAuth`/JWKS path as a human SSO token — no second validator — and
the caller is resolved to its **agent** `employee.slug` by `resolveAgentSlugFromAuth`, which strips
the `service-account-` prefix to recover the `kc_client_id` and looks it up in the existing
`agent_card.kc_client_id` column (T-0423 §2.2; the human and agent paths are provably disjoint via
the `actor_type` selector and the `kind='human'`/`kind='agent'` SQL filters). The tenant is derived
from the resolved actor's own `employee` row (`resolveActorTenant`), so a service token coexists with
SSO on the same middleware and never selects its own tenant; `x-dev-user` is removed without breaking
the Flowable bridge / external workers because those already use `withAuth` (`externalWorker.ts` is
the reference impl) and obtain real tokens — the header path remains only as the **dev-mode** fallback
inside each mode-aware resolver.

### 3.2 vendor-signed (no Keycloak, by design)

`/vendor/*` stays outside `withAuth`: the vendor plane is a separate trust domain from a tenant's user
directory. Its credential is the signed activation key, verified offline by `verifyKey` (Ed25519 over
the canonical payload) and fail-closed (`invalid`→`403 ACTIVATION_INVALID`, no/expired→`402`,
not-entitled→`403 NOT_ENTITLED`). T-0328's deliverable here is **documentation + a verification audit**,
not a code wrap (the audit is satisfied: signature verification is real and fail-closed, and the
intentional-bypass block already cites this ADR). The stronger control (ingress mTLS / network ACL
isolating `/vendor/*` from tenant traffic) is host-level and tracked separately.

---

## 4. secret-handle (FROZEN) verdict, sequencing, and the frozen-body façade

### 4.1 secret-handle frozen verdict — **ADDITIVE, no founder thaw required**

Closing the residual gap on `secret-handle` does **NOT** require editing the frozen file and so does
**NOT** require a founder-class thaw. Two facts establish this:

1. The `withAuth` guard for `secret-handle` is **already** applied additively at the composition root
   (`registerSecretHandleRoutes(withAuthRegistrar(router), grantsPool)`, `server.ts:582`). `secret-handle.ts`
   is byte-unchanged by it.
2. The remaining G1 residue (resolve the JWT slug into `x-dev-user` before the frozen body reads it)
   is likewise a **registration-site pre-handler façade** that wraps the registrar — it adds zero
   lines to `secret-handle.ts`. The façade is the same shape as `withAuthRegistrar`: a `.register`
   wrapper that, after `authenticate`, resolves `getAuthContext()` → `resolveActorSlugFromAuth` →
   sets `req.headers['x-dev-user']` to the validated slug, then delegates.

> **Governance flag.** If — and only if — the implementation chooses to make `secret-handle.ts`
> mode-aware **in-body** (swap its `extractActor(x-dev-user)` for the `getAuthContext`→`resolveActorSlugFromAuth`
> pattern), that edit is **FOUNDER-CLASS** and **not auto-authorable**: `secret-handle.ts` is
> founder-frozen (FF-25 family; the same founder-sanction governance class the orchestrator hit on
> T-0397's FF-DC7). It would require a `founder_decide` record and an append-only entry in
> `ci/checks/data/frozen-sanctions.jsonl`. **This ADR rejects that path** — the additive façade
> achieves the identical security and functional outcome with the frozen file untouched, so no thaw
> is needed. (Note: FF-25-6's byte-frozen `FROZEN_FILES` list is `scoped-admin.ts` / `grant-lattice.ts`
> / `object-handle.ts`, not `secret-handle.ts`; `secret-handle.ts`'s freeze is the FF-25-3 ALLOWED_FILES
> custody allowlist + the founder-frozen reputation in the task brief. Treat any in-body edit as
> founder-class regardless.)

### 4.2 process-start frozen verdict — additive, **no founder thaw** (contract-frozen, not byte-frozen)

`process-start.ts`'s "FROZEN" is the **REST contract** (ADR T-0278 §2.2 — the request/response shape
across the B↔C↔E seam), enforced by `start-route-isolation.sh` (static boundary checks, not a
byte-diff). The same registration-site façade (inject `x-dev-user` **and** `x-tenant-id` from the
resolved actor + `resolveActorTenant`) keeps the frozen REST shape and the frozen body untouched and
needs no thaw. The façade is wired where the start handler is registered (`processes.ts:249` /
`server.ts:618 registerProcessesRoutes`).

### 4.3 Build order (each step independently shippable; dev stays green)

| Order | Step | Surfaces | Buildable-now vs founder-gated | Priority |
|---|---|---|---|---|
| 1 | **G1 façade** — registration-site pre-handler that, in keycloak mode, resolves `getAuthContext`→slug and injects `x-dev-user` (+ `x-tenant-id`/tenant for process-start) before the frozen body. New module `src/http/actor-inject-registrar.ts` (sibling to `auth-wrap-router.ts`); wire at `server.ts:582` (secret-handle) and `processes.ts:249` (process-start). Frozen files byte-unchanged. | secret-handle, process-start | **buildable-now** (additive; no thaw) | **P0** |
| 2 | **G2 fitness guard** — static check "every `src/http/*` route handler is `withAuth`-wrapped (directly or via a registrar façade) OR on the documented vendor allowlist." New `ci/checks/http-route-auth-coverage.sh` + self-test. | all | **buildable-now** | **P1** |
| 3 | **vendor allowlist documentation** — add `/vendor/*` (and the activation-key bypass rationale) to the §5 allowlist consumed by step 2. | vendor-activation | **buildable-now** | **P1** |
| 4 | **Keycloak realm: agent service-account clients** in the **prod** realm export (`config/keycloak/realm-choros.json`) with `actor_type=agent`, `aud ⊇ choros-api`, and `agent_card.kc_client_id` aligned to the live clientId (T-0423 §5.1/§5.2). | invoke (prod) | **founder-gated** (prod realm config + secrets) | **P0 prereq for agent exec in prod** |
| 5 | **`DEV_TENANT_ID` pin removal** on `invoke` (DONE — `resolveInvokeTenant`) and `email-channel-config` (still pinned at `email-channel-config.ts:302/326/365`). The email-config pin is a multi-tenant follow-up, not an auth bypass; close before multi-tenant prod. | email-channel-config | buildable-now (separate task) | **P2** follow-up |
| 6 | **Negative+positive keycloak acceptance** per surface: with a valid Bearer the surface returns 2xx (proving the façade resolves identity into the frozen body); with `x-dev-user` but **no** Bearer it returns 401 (proving the header bypass is dead). | all 8 | buildable-now (needs keycloak stack) | **P0 gate** |

### 4.4 Sibling tasks this unblocks

- **T-0471 (secret-handle fix)** — blocked on this design; unblocked by §4.1 (additive façade, no
  thaw) + step 1. It can proceed in the normal dev-loop.
- **T-0460 (agentTask runtime worker-auth)** — depends on the agent-runtime-identity model (§3.1) and
  the `resolveAgentSlugFromAuth` resolver (already merged, T-0423/T-0424). The realm provisioning
  (step 4) is its prod prerequisite.
- **T-0423** — its §5.3 follow-ups (global `kc_client_id` uniqueness migration; prod-realm agent
  clients) are the same step-4 prereqs surfaced here for the keycloak-prod flip.

### 4.5 Top risks

1. **Silent prod breakage on flip without G1.** Enabling `CHOROS_AUTH_MODE=keycloak` before step 1
   makes `process-start` and `secret-handle` 401 in production even for authenticated users — the
   "start process" and "bind LLM key" screens look broken with no server error. *Mitigation:* the §4.3
   step-6 acceptance gate and the §6 must-close list.
2. **Façade ordering bug.** The pre-handler must run **after** `authenticate` (so `getAuthContext` is
   populated) and **before** the frozen body. Wrapping the wrong handler, or running the injector
   first, silently reintroduces the 401 or the bypass. *Mitigation:* a test asserting valid-Bearer→2xx
   AND `x-dev-user`-only→401 on each frozen surface, proving the façade is in the request path.
3. **`x-dev-user` injection masking a real header.** The injector must **overwrite** any client-supplied
   `x-dev-user` in keycloak mode (the resolved slug is authoritative), never merge — otherwise a client
   header could shadow the JWT identity. *Mitigation:* the façade sets (not appends) the header and only
   in keycloak mode; dev mode is a pure pass-through.

---

## 5. Fitness functions (CI proofs)

The guard set proves the bypass is closed without false-greens. Comment lines are stripped in every
grep (lesson T-0143) so prose explaining a ban does not trip the check.

1. **FF-0328-1 — every `src/http/*` route is auth-covered.** Static: each `src/http/*.ts` that calls
   `router.register(...)` must wrap its handler in `withAuth(...)` **or** be registered through a
   façade (`withAuthRegistrar` / the new actor-inject registrar) at the composition root, **or** be on
   the documented vendor allowlist (`vendor-*.ts`). Any unwrapped, non-allowlisted route handler →
   FAIL. Self-test plants an unwrapped `_probe.ts` route and asserts the check fires.
   *ci_check:* `ci/checks/http-route-auth-coverage.sh` (new, with `--self-test`).
2. **FF-0328-2 — no surface trusts `x-dev-user` as the sole identity in keycloak mode.** Static: no
   `src/http/*.ts` (excluding the dev-fallback branch guarded by `getAuthContext(req) === undefined`)
   may read `req.headers['x-dev-user']` outside a mode-aware resolver. The two frozen surfaces are
   excepted **only** because their `x-dev-user` read is fed by the registration-site façade (which is
   itself `getAuthContext`-gated). *ci_check:* an arm in `ci/checks/http-route-auth-coverage.sh`
   asserting every `x-dev-user` read in `src/http/` is either inside a `getAuthContext`-undefined
   branch or in `actor-inject-registrar.ts`.
3. **FF-0328-3 — frozen files byte-unchanged.** `secret-handle.ts` and the `process-start.ts` body
   are not edited by the implementation. *ci_check:* `git diff --quiet <merge-base> -- src/http/secret-handle.ts src/http/process-start.ts` returns clean (mirrors FF-25-6's merge-base diff arm).
4. **FF-0328-4 — vendor signature fail-closed (audit).** `vendor-activation` honours a service call
   only when `isEntitled(status, service)` is true, which requires a valid signature AND in-term
   (`state:"active"`); any malformed/mismatched key → `state:"invalid"` → `403`. *ci_check:* the
   existing `entitlement-gates-vendor-only.sh` (FF-T127-4) keeps activation vocabulary confined to
   `src/vendor/**` + `src/http/vendor-*.ts`; T-0328 adds an assertion in the vendor unit suite that a
   tampered key resolves to `invalid`→`403`.
5. **FF-0328-5 — keycloak acceptance (negative + positive).** Per surface, in keycloak mode: valid
   Bearer → 2xx (identity reaches the body); `x-dev-user` supplied but no Bearer → 401 (header bypass
   dead). *ci_check:* a keycloak-mode acceptance test (deploy-acceptance lane; needs the live KC stack
   + founder deploy GO) exercising one request per surface.

---

## 6. MUST be closed before `CHOROS_AUTH_MODE=keycloak` in production

- [ ] **`invoke`** — `withAuth` + caller from validated token, disjoint agent/human resolvers,
      tenant from caller. **(DONE — T-0418/0424; verify in keycloak acceptance.)**
- [ ] **`process-defs` / `binding` / `floor1-editor` / `email-channel-config`** — `withAuth` +
      mode-aware actor. **(DONE — T-0418/0420/0468; verify in keycloak acceptance.)**
- [ ] **`process-start`** — registration-site **actor-inject façade** (G1) so a valid Bearer resolves
      to `x-dev-user`/`x-tenant-id` before the frozen body; bypass dead. **(TODO — step 1, buildable-now.)**
- [ ] **`secret-handle`** — registration-site **actor-inject façade** (G1); frozen body byte-unchanged;
      **no founder thaw needed** (additive). **(TODO — step 1; unblocks T-0471.)**
- [ ] **`vendor-activation`** — signature fail-closed verified; routes on the documented `withAuth`-
      bypass allowlist (or ingress-isolated). **(DONE in code; allowlist entry = step 3.)**
- [ ] **Fitness guard** FF-0328-1/2/3 wired (durable prevention). **(TODO — step 2, buildable-now.)**
- [ ] **Keycloak prod realm** ships agent service-account clients (`actor_type=agent`, `aud ⊇ choros-api`)
      with `agent_card.kc_client_id` aligned. **(TODO — step 4, founder-gated.)**
- [ ] **Negative+positive acceptance** per surface (FF-0328-5). **(TODO — step 6, needs KC stack + deploy GO.)**

---

## 7. Rejected alternatives

- **A bespoke per-surface API-key table.** Rejected — one validated token path (Keycloak JWT) and two
  identity bridges already exist; a second authority subsystem doubles the rotation surface and breaks
  the single-decision-path discipline.
- **Editing the frozen `secret-handle.ts` / `process-start.ts` bodies to call the mode-aware resolver.**
  Rejected — `secret-handle.ts` is founder-frozen (in-body edit = FOUNDER-CLASS, requires a
  `founder_decide` + `frozen-sanctions.jsonl` entry) and `process-start.ts` is contract-frozen. The
  additive registration-site façade (§4.1/§4.2) achieves the identical outcome with both files byte-
  unchanged and **no thaw**.
- **Putting `vendor-activation` behind Keycloak.** Rejected — the vendor plane is a separate trust
  domain; its credential is the signed activation key, not an employee JWT. Forcing it through
  `withAuth` conflates two trust domains.
- **Flipping `CHOROS_AUTH_MODE=keycloak` first and fixing fallout reactively.** Rejected — the failure
  is silent SPA breakage (401 on the two frozen surfaces even for authenticated users) plus a missing
  durable guard; the must-close list (§6) gates the flip instead.
- **Relaxing the `kind='human'` guard in `resolveActorSlugFromAuth` to also match agents.** Rejected
  (per T-0423 §2.3) — reverses the T-0372 anti-impersonation guard. The disjoint `resolveAgentSlugFromAuth`
  keeps the human guard a hard invariant.

---

## 8. Traceability (machine-readable handoff)

```json
{
  "task_id": "T-0328",
  "status": "ready",
  "decision": "Three trust models (keycloak-SSO human, agent-runtime-identity service-account JWT, vendor-signed) over one JWT validator and two disjoint identity bridges. Five of eight surfaces already realized (T-0418/0420/0424/0425/0468/0423). Two residual gaps: G1 = registration-site actor-inject facade so the withAuth-wrapped-but-frozen process-start + secret-handle bodies receive the validated identity via x-dev-user/x-tenant-id in keycloak mode (additive, frozen files byte-unchanged, NO founder thaw); G2 = a durable http-route-auth-coverage fitness guard. vendor-activation stays an intentional, documented withAuth-bypass gated by the Ed25519 activation-key signature.",
  "rejected_alternatives": [
    {"option": "Per-surface API-key table", "why_not": "second authority subsystem; doubles rotation surface; breaks single-decision-path"},
    {"option": "Edit frozen secret-handle.ts / process-start.ts bodies", "why_not": "secret-handle.ts is founder-frozen (in-body edit = FOUNDER-CLASS, needs founder_decide + frozen-sanctions.jsonl); additive registration-site facade achieves the same with no thaw"},
    {"option": "Put vendor-activation behind Keycloak", "why_not": "separate trust domain; credential is the signed activation key, not an employee JWT"},
    {"option": "Flip CHOROS_AUTH_MODE=keycloak first, fix reactively", "why_not": "silent 401 on the two frozen surfaces for authenticated users; must-close list gates the flip"},
    {"option": "Relax resolveActorSlugFromAuth kind='human' guard to include agents", "why_not": "reverses the T-0372 anti-impersonation guard (T-0423 §2.3)"}
  ],
  "contracts": [
    "src/http/auth.ts withAuth(handler) / getAuthContext(req) / AuthContext{sub,preferredUsername,actorType} unchanged",
    "src/db/org.ts resolveActorSlugFromAuth (kind='human') + resolveAgentSlugFromAuth (kind='agent') unchanged",
    "NEW src/http/actor-inject-registrar.ts: RegistrarLike facade applying withAuth THEN, in keycloak mode, resolving getAuthContext->slug and setting req.headers['x-dev-user'] (and for process-start req.headers['x-tenant-id'] from resolveActorTenant) before delegating; dev mode pass-through",
    "secret-handle.ts + process-start.ts bodies byte-unchanged (FF-0328-3)",
    "vendor-activation /vendor/* on documented withAuth-bypass allowlist (FF-0328-1)"
  ],
  "fitness_functions": [
    {"id": "FF-0328-1", "rule": "every src/http/* route handler is withAuth-wrapped (direct or via a registrar facade) OR on the vendor-* allowlist", "ci_check": "ci/checks/http-route-auth-coverage.sh (new, --self-test plants an unwrapped probe route)"},
    {"id": "FF-0328-2", "rule": "no src/http/*.ts reads req.headers['x-dev-user'] as sole identity outside a getAuthContext()===undefined dev-fallback branch or the actor-inject-registrar facade", "ci_check": "arm in ci/checks/http-route-auth-coverage.sh (comment-stripped grep)"},
    {"id": "FF-0328-3", "rule": "frozen files secret-handle.ts and process-start.ts are byte-unchanged vs merge-base", "ci_check": "git diff --quiet <merge-base> -- src/http/secret-handle.ts src/http/process-start.ts"},
    {"id": "FF-0328-4", "rule": "vendor-activation honours a service call only when isEntitled (valid Ed25519 signature AND in-term); tampered key -> invalid -> 403", "ci_check": "existing ci/checks/entitlement-gates-vendor-only.sh + new vendor unit assertion tampered-key->403"},
    {"id": "FF-0328-5", "rule": "keycloak mode: valid Bearer -> 2xx per surface; x-dev-user without Bearer -> 401 per surface", "ci_check": "keycloak deploy-acceptance test (live KC stack + founder deploy GO)"}
  ],
  "traceability": [
    {"ac": "invoke caller from validated token, not header", "covered_by": "DONE T-0418/0424; FF-0328-5"},
    {"ac": "SPA writes (process-defs/binding/floor1/email-config) withAuth + mode-aware", "covered_by": "DONE T-0418/0420/0468; FF-0328-1/5"},
    {"ac": "process-start functional in keycloak (frozen body untouched)", "covered_by": "G1 step1 facade; FF-0328-1/3/5"},
    {"ac": "secret-handle functional in keycloak, no founder thaw", "covered_by": "G1 step1 facade; FF-0328-1/3; unblocks T-0471"},
    {"ac": "vendor-activation documented bypass, fail-closed", "covered_by": "DONE code + step3 allowlist; FF-0328-1/4"},
    {"ac": "durable prevention of the bypass class", "covered_by": "FF-0328-1/2 step2"},
    {"ac": "agent runtime worker-auth (T-0460) credential model", "covered_by": "agent-runtime-identity §3.1; realm step4"}
  ],
  "adr_artifact_path": "docs/design/T-0328-agent-facing-auth-model.adr.md",
  "escalation": "FOUNDER-CLASS only if the implementation chooses an in-body edit of secret-handle.ts (founder-frozen, FF-25 family) instead of the additive facade — that path is rejected by this ADR and needs a founder_decide + frozen-sanctions.jsonl entry. Prod keycloak realm agent service-account clients + secrets (step 4) and the keycloak deploy-acceptance GO (FF-0328-5) are founder-gated. Everything else (steps 1,2,3) is buildable in the normal dev-loop with no founder action."
}
```
