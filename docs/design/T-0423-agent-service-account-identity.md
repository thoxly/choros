# T-0423 — Agent service-account → employee identity (ADR)

Status: **PROPOSED** (design only — no `.ts`/auth code changed by this task)
Task: T-0423 (security) — resolve a Keycloak **service-account** caller (`actor_type=agent`)
to an **agent employee** so that keycloak-mode agent execution works **without**
re-opening the `x-dev-user` bypass that T-0418/T-0420 closed.
Branch: `task/T-0423` · base dev `dc6f38f`
Author: architect (T-0423)
Builds on: `docs/design/T-0328-agent-facing-auth-model.md` (the agent-facing auth model;
this ADR fills in §3.2 "agent-runtime-identity" with a concrete resolution mechanism and
closes its risk-3 `DEV_TENANT_ID` pin).

---

## 0. TL;DR

T-0418/T-0420 wrapped the agent-facing surfaces (`invoke`, etc.) in `withAuth` and made them
derive the caller from the **validated token** via `resolveActorSlugFromAuth`, killing the
`x-dev-user` bypass. But `resolveActorSlugFromAuth` is **`kind='human'`-only** by deliberate
design (the T-0372 anti-impersonation guard, `src/db/org.ts:383`). So in keycloak mode an
**agent** caller — a Keycloak service-account presenting `actor_type=agent`,
`preferred_username=service-account-<clientId>` — resolves to `null` and the route returns
`401 UNAUTHENTICATED` (`src/http/invoke.ts:112-114`). That is the **correct P0 fail-closed
posture**, but it **blocks keycloak-prod agent execution**: no agent can ever call `invoke`.

The fix is **not** to relax the human guard. It is a **second, disjoint resolution path**,
selected by the authenticated `actor_type` claim, that maps an agent's validated identity to
its **agent employee** through the mapping **that already exists**:
`choros.agent_card.kc_client_id` (`migrations/032_agent_card.sql:46`, `UNIQUE (tenant_id,
kc_client_id)` at `:56`). The convention is already wired end-to-end:

```
JWT preferred_username = "service-account-agent-recon"   (KC default for a svc account)
  └─ strip "service-account-" prefix ─────────────────► "agent-recon"  = kc_client_id
       └─ agent_card.kc_client_id = "agent-recon" ─────► employee_id   = d0…0002
            └─ employee.slug                       ────► "a-recon"  (kind='agent')
```

`agent_card.kc_client_id` is populated this exact way by **agent-hire**
(`src/core/agent-hire.ts:78` `deriveKcClientId` → `agent_card.kcClientId`, `:123`/`:180`) and
by the seed migrations (`migrations/032_agent_card.sql:88` `'agent-recon'`, etc.). So this ADR
introduces **no new credential, no new token system, and no new table** — only a **new resolver
function** (`resolveAgentSlugFromAuth`) and the realm/migration plumbing to make
`kc_client_id` carry the live service-account clientId in prod.

The two paths are **provably disjoint**: the human path filters `kind='human'`, the agent path
filters `kind='agent'` via the `agent_card` FK (`migrations/032_agent_card.sql:57-58`
`CHECK (employee_kind = 'agent')`). A human token (`actor_type=human`) never touches the agent
resolver and vice-versa; neither path can yield the other's kind. The `invoke` `DEV_TENANT_ID`
pin (`src/http/invoke.ts:307`) is resolved by deriving the tenant from the resolved agent
employee (`resolveActorTenant`, `src/db/org.ts:276`), exactly as the human surfaces already do.

---

## 1. Current state — grounded in the tree on `task/T-0423`

### 1.1 The one validator, the WeakMap, and `actor_type`

| Mechanism | Where | Behaviour |
|---|---|---|
| Mode switch | `src/http/auth.ts:36` `getAuthMode()` | `CHOROS_AUTH_MODE` ∈ `dev`\|`keycloak`, default `dev`. |
| JWT validator | `src/http/auth.ts:403` `authenticate()` | keycloak: validates Bearer via JWKS; on success stores `{sub, preferredUsername, actorType}` in a `WeakMap`. **dev: no-op pass-through** (`:404-407`). |
| **`actor_type` is carried** | `src/http/auth.ts:438-442` | The validated claim `actor_type` IS stored on the `AuthContext` (`actorType: claims.actor_type`). It is currently **read but never branched on** for identity resolution — that is the seam this ADR uses. |
| Guard decorator | `src/http/auth.ts:461` `withAuth()` | Wraps a handler with `authenticate()`; the **only** path that populates the identity `WeakMap`. |
| Identity read | `src/http/auth.ts:113` `getAuthContext()` | Returns the `WeakMap` value — `undefined` unless `withAuth` ran. |
| `AuthContext` type | `src/http/auth.ts:55-59` | `{ sub: string; preferredUsername: string; actorType: "human" \| "agent" }`. |
| JWT claim contract | `docs/worker-api.md:164-172` | `sub` (UUID), `preferred_username` (= employee-id **or** `service-account-<clientId>`), `actor_type` ∈ `human`\|`agent`, `aud` ⊇ `choros-api`. |
| Agent token grant | `docs/worker-api.md:193-205` | agents obtain a token via `grant_type=client_credentials` (`client_id=agent-orchestrator`, etc.). |

### 1.2 `resolveActorSlugFromAuth` — the human bridge, and WHY it is human-only

`src/db/org.ts:360-412`. Given a validated `(sub, preferredUsername)` it returns the
`employee.slug` to use for tenant/grant resolution, or `null` (fail-closed):

1. **sub-first** (`:394`): if an employee exists with `slug == sub` → return `sub`. This is the
   T-0342 registered-user invariant (`employee.slug == jwt.sub`) and **short-circuits**, so a
   registered user never reaches the fallback.
2. **preferred_username fallback** (`:399-404`): for seeded human personas whose KC `sub` ≠ slug
   (e-orlov, e-larina, e-configurator), resolve by `preferred_username`.
3. else → `null` (`:408`, fail-closed; the caller MUST NOT fall through to a UUID that
   `resolveActorTenant` would silently map to `DEV_TENANT_ID`).

**The `kind='human'` restriction** lives in the existence helper
(`src/db/org.ts:377-388`):

```sql
SELECT EXISTS (
  SELECT 1 FROM choros.employee WHERE slug = $1 AND kind = 'human'
) AS exists
```

The comment (`src/db/org.ts:369-376`) states the threat it closes (T-0372): *agents authenticate
via their Keycloak client_id (service-account JWT), never via `preferred_username`; restricting
to `kind='human'` ensures a forged or stolen `preferred_username` can never resolve to a
no-KC-user agent or seed slug (e.g. `config-agent-seed`, which holds `authoring_draft`
grants).* This is locked by a test (`src/__tests__/resolve-actor-slug.test.ts:183-202`,
"agent slug not in `kind='human'` set → null"). **This guard is correct and this ADR does NOT
touch it.**

### 1.3 Exactly why an agent service-account 401s today

The agent surface `invoke` derives its caller via `extractCallerId`
(`src/http/invoke.ts:107-124`), which in keycloak mode calls
`resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername)` (`:111`) and **throws 401 if it
returns `null`** (`:112-114`). For an agent service-account:

- `ctx.actorType === "agent"` (from the validated claim, `auth.ts:441`);
- `ctx.sub` = the KC service-account **user UUID** — there is **no `employee` row with
  `slug == that-uuid`** (agents' slugs are `a-recon` etc.), so step 1 misses;
- `ctx.preferredUsername` = `"service-account-agent-recon"` — there is **no `kind='human'`
  employee** with that slug, and even `a-recon` would be excluded by `kind='human'`. Step 2
  misses.
- → `resolveActorSlugFromAuth` returns `null` → `invoke` throws **`401 UNAUTHENTICATED — no
  employee matches authenticated identity`**.

So a perfectly valid, JWKS-validated agent token is rejected. The `x-dev-user` fallback in
`extractCallerId` (`:117-123`) is **not** reached in keycloak mode (because `getAuthContext` is
populated, the function returns/throws in the `ctx !== undefined` branch). That is correct — we
must not re-open the header bypass — but it means **there is currently no path at all for an
agent caller in keycloak mode.**

### 1.4 How an agent is represented as an "employee" today

Agents are first-class `employee` rows with `kind='agent'`, paired 1:1 with an `agent_card`:

| Artifact | Where | Notes |
|---|---|---|
| `employee.kind='agent'` rows | `migrations/016_employee.sql:48-53` | slugs `a-recon`, `a-invoice`, `a-triage`, `s-ledger`, `s-ocr`. |
| `kind`-discriminated FK | `migrations/032_agent_card.sql:37-64` | `UNIQUE (tenant_id, id, kind)` on `employee` (`:38-39`) makes `(tenant_id, id, kind)` FK-targetable; `agent_card` carries `employee_kind` pinned by `CHECK (employee_kind = 'agent')` (`:57-58`) and FKs into it (`:61-63`). **A card can only point at a `kind='agent'` employee** — pointing at a human violates the FK (PG 23503). |
| `agent_card.kc_client_id` | `migrations/032_agent_card.sql:46` | `text NOT NULL`; the **Keycloak service-account clientId** linkage seam (T-0054 §3.5). `UNIQUE (tenant_id, kc_client_id)` (`:56`). |
| seeded `kc_client_id` values | `migrations/032_agent_card.sql:88-92` | `agent-recon`, `agent-invoice`, `agent-triage` (the a-* agents use the `agent-<slug-tail>` service-account clientIds); `s-ledger`/`s-ocr` seeded with their slug as a placeholder (`:79-81`). |
| hire-time mapping | `src/core/agent-hire.ts:78-86` | `deriveKcClientId(slug)` = `"agent-" + normalized(slug)`; written to `agent_card.kcClientId` (`:123`, `:148`) and to the KC `KcClientSpec` (`:180`, with `actorType: "agent"`, `:184`). |
| **identity ⊥ rights** | `src/core/agent-hire.ts:15-16` | "kc_client_id is an identity artifact; the rights layer keys ONLY on employee_id." The grant lattice never keys on the clientId — it keys on the resolved `employee`. |

So the `client_id → agent-employee` mapping **already exists** as a column with a uniqueness
constraint. There is nothing to invent; we only need a resolver that reads it.

### 1.5 The Keycloak side already ships agent service-accounts

`config/keycloak/realm-choros.json`:

- agent clients `agent-orchestrator` (`:110-152`), `agent-recon` (`:153`), `agent-invoice`
  (`:197`), `agent-triage` (`:254`) — all `serviceAccountsEnabled: true`,
  `standardFlowEnabled: false`, `directAccessGrantsEnabled: false`, `publicClient: false`
  (client_credentials only);
- each carries an **`actor-type-mapper`** protocol mapper emitting `actor_type` into the access
  token (`:124-139`);
- each has an **audience-mapper** putting `choros-api` in `aud` (`:140-150`);
- each has a service-account **user** `service-account-<clientId>` with attribute
  `actor_type: ["agent"]` (`:424-458`).

Keycloak's default `preferred_username` for a service-account user **is** its username, i.e.
`service-account-<clientId>` — which is the value the contract documents
(`docs/worker-api.md:171`) and the prior ADR assumes (T-0328 §3.2). This ADR depends on that
default and makes it explicit (§5.1).

---

## 2. Design — the agent-identity resolution path

### 2.1 Selector: branch on the validated `actor_type` claim

The single decision is made on `ctx.actorType`, which is **already** on the `AuthContext`
(`auth.ts:441`) and comes **only** from the validated JWT — never from a header or body (the
same discipline `env-tier.ts:59` enforces: *"From the AUTHENTICATED actor_type claim. Never from
request body."*). Proposed shared shape (pseudocode; the implementation task wires it):

```ts
// keycloak path inside extractCallerId / the future shared resolver:
const ctx = getAuthContext(req);            // populated only by withAuth
if (ctx.actorType === "agent") {
  const slug = await resolveAgentSlugFromAuth(pool, ctx);   // NEW — §2.2
  if (slug === null) throw new HttpError(401, "UNAUTHENTICATED", "...");
  return slug;                               // an agent employee.slug, kind='agent'
}
// actorType === "human" → the EXISTING human bridge, untouched:
const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
```

The human resolver (`resolveActorSlugFromAuth`) is left exactly as-is — its `kind='human'`
guard and its tests remain the invariant.

### 2.2 `resolveAgentSlugFromAuth` — the new agent bridge (mechanism)

A **new, separate** DAO function in `src/db/org.ts`, sibling to `resolveActorSlugFromAuth`,
**never** called for human tokens. It maps the validated agent identity to its agent
`employee.slug` via the existing `agent_card.kc_client_id` column:

```ts
export async function resolveAgentSlugFromAuth(
  pool: pg.Pool,
  ctx: { sub: string; preferredUsername: string; actorType: "human" | "agent" },
): Promise<string | null> {
  if (ctx.actorType !== "agent") return null;           // hard kind gate (defense-in-depth)

  // KC default: a service-account user's preferred_username is
  // "service-account-<clientId>". Strip the prefix to recover the clientId.
  const PREFIX = "service-account-";
  if (!ctx.preferredUsername.startsWith(PREFIX)) return null;  // fail-closed
  const kcClientId = ctx.preferredUsername.slice(PREFIX.length);
  if (!kcClientId) return null;

  // Cross-tenant BYPASSRLS existence/lookup — mirrors resolveActorSlugFromAuth
  // (no tenant GUC; the tenant is scoped afterwards by resolveActorTenant on the
  // returned slug). Join enforces kind='agent' via the agent_card FK semantics.
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ slug: string }>(
      `SELECT e.slug
         FROM choros.agent_card ac
         JOIN choros.employee e
           ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
        WHERE ac.kc_client_id = $1
          AND e.kind = 'agent'
        LIMIT 1`,                                         // see §3.4 on multi-tenant collisions
      [kcClientId],
    );
    return rows.length > 0 ? rows[0]!.slug : null;        // null ⇒ caller throws 401
  } finally {
    client.release();
  }
}
```

Properties (each mirrors a property the human resolver already has):

- **Returns only an agent slug.** The `JOIN … e.kind = 'agent'` plus the `agent_card` FK
  (`migrations/032_agent_card.sql:61-63`, which can only reference `kind='agent'` employees)
  make it structurally impossible to return a human slug.
- **Confers no authority on its own** — like `resolveActorSlugFromAuth`, it returns a *slug
  string*; authorization remains the existing fail-closed **invoke-grant** check
  (`coversInvoke`, `src/http/invoke.ts:155-173`). Identity ⊥ rights (`agent-hire.ts:15-16`).
- **Fail-closed** on any ambiguity: not `service-account-`-prefixed, empty clientId, or no
  matching card → `null` → the surface throws 401. We never fall through to `DEV_TENANT_ID` or
  to an arbitrary employee.

**Where the mapping lives:** the `agent_card.kc_client_id` column (existing). No new table. The
`UNIQUE (tenant_id, kc_client_id)` constraint already guarantees at most one card per clientId
**within a tenant**; §3.4 addresses cross-tenant uniqueness (the constraint is per-tenant, and
the lookup is intentionally cross-tenant because we don't yet know the tenant).

**Why a column, not a convention-only `service-account-<clientId>` → slug derivation:** the slug
(`a-recon`) and the clientId (`agent-recon`) **differ** (`deriveKcClientId` prefixes/normalizes,
`agent-hire.ts:78-86`), so there is no safe string transform from `preferred_username` to slug.
The `agent_card` row is the authoritative, hire-time-recorded binding — and it is also the row
that proves the agent is **provisioned in this Choros** (a KC client with no `agent_card` is
unknown to the platform and correctly resolves to `null`). Convention is used only for the
`preferred_username → kc_client_id` strip, which is a stable Keycloak default.

### 2.3 Why not relax `resolveActorSlugFromAuth` to include agents

Rejected. Folding agents into the human resolver would (a) reverse the T-0372 guard, re-opening
the impersonation vector it closes (a stolen `preferred_username` resolving to an agent slug that
holds `authoring_draft` grants), and (b) conflate the two kinds in one query so a single bug
widens authority across both. Keeping a **separate function** keeps the human guard a hard
invariant and makes the agent path independently testable and auditable.

---

## 3. Anti-impersonation safety (the crux)

The security property to prove: **the human and agent resolution paths are disjoint, each can
yield only its own `kind`, and neither lets a principal escalate across kinds or across
tenants.** Four claims:

### 3.1 An agent token can NEVER resolve to a human employee

- Selector: agent tokens have `actor_type=agent` (validated claim, `auth.ts:441`;
  realm mapper `realm-choros.json:124-139`; svc-account user attr `:429-431`). They take the
  **agent path only** — `resolveAgentSlugFromAuth` — and **never** call the human resolver.
- The agent resolver's SQL filters `e.kind = 'agent'` and joins through `agent_card`, whose FK
  can only point at `kind='agent'` employees (`migrations/032_agent_card.sql:61-63`). There is
  **no** code path by which an agent token reaches a `kind='human'` row.
- Even the defense-in-depth guard `if (ctx.actorType !== "agent") return null` (§2.2) makes the
  agent resolver a no-op for anything but an agent claim.

### 3.2 A human token can NEVER resolve to an agent employee

- Human tokens (`actor_type=human`) take the human path only; `resolveActorSlugFromAuth` filters
  `kind='human'` (`src/db/org.ts:383`) — already proven and test-locked
  (`resolve-actor-slug.test.ts:183-202`, T-0372). A human's `preferred_username` matching an
  agent slug still returns `null`.
- A human token never invokes `resolveAgentSlugFromAuth` (the `actor_type` selector, §2.1), and
  even if it somehow did, the `if (ctx.actorType !== "agent") return null` guard rejects it.

### 3.3 A compromised agent client cannot escalate to a human's grants

The deepest threat: an attacker who steals an agent's KC client secret. With it they can mint a
**valid** `actor_type=agent` token for **that one clientId**.

- They resolve to **exactly that agent's** employee (the `kc_client_id` in their token's
  `preferred_username` is fixed by Keycloak to their own service-account username — they cannot
  set `preferred_username` arbitrarily; it is derived by KC from the service-account user, not
  taken from a request field). They get **that agent's** invoke-grants, **no more**.
- They cannot become a human: `actor_type` is baked into the token by the realm mapper from the
  service-account user's attribute (`realm-choros.json:429-431`), not chosen by the client. A
  compromised agent client cannot mint an `actor_type=human` token without compromising
  Keycloak itself (out of scope; it is the trust root for both kinds).
- They cannot impersonate **another** agent: their `preferred_username` is their own
  `service-account-<theirClientId>`; the resolver maps it to their own card. To act as a
  different agent they'd need that other client's secret too.
- **Authority is the grant lattice, not the token.** Even resolved to their agent employee,
  every action is re-checked against fail-closed grants (`coversInvoke`, `invoke.ts:341-343`
  `403` on no covering grant). Per-agent least privilege is expressed as grants, so a compromised
  agent is bounded by what that agent was granted — the standard blast-radius containment.

### 3.4 Tenant scoping — no cross-tenant escalation

This is the one place the design must be explicit, because the lookup is **cross-tenant by
necessity** (we resolve the slug **before** we know the tenant, mirroring
`resolveActorSlugFromAuth`'s cross-tenant existence check, `src/db/org.ts:330-334`).

- `UNIQUE (tenant_id, kc_client_id)` (`migrations/032_agent_card.sql:56`) guarantees uniqueness
  **per tenant**, not globally. In a multi-tenant prod, two tenants could in principle each have
  an `agent_card` with the same `kc_client_id`.
- **Resolution:** a Keycloak **clientId is realm-global-unique** — a single realm cannot host two
  clients with the same clientId. Since every tenant's agents are provisioned as clients **in the
  same realm** (`agent-hire` creates one KC client per agent, `agent-hire.ts:179-185`;
  `deriveKcClientId` + the DB `UNIQUE (tenant_id, kc_client_id)` is the conflict seam,
  `:74-76`), a given `kc_client_id` value maps to **exactly one** agent across the whole platform.
  So the cross-tenant `LIMIT 1` lookup is unambiguous **in practice**.
- **But we must enforce, not assume.** Two safety follow-ups for the implementation task:
  1. **Add a global uniqueness guard** on `agent_card.kc_client_id` (a `UNIQUE` index on
     `kc_client_id` alone, or — preferred, RLS-friendly — a deferred check at hire-time that the
     clientId is unused in any tenant). Until then, the resolver returning the **first** row on a
     (hypothetical) collision is a cross-tenant risk; the global-uniqueness migration removes it.
  2. After resolving the agent slug, **the tenant is derived from that agent's own row** (§4),
     so even a collision would land the caller in a deterministic single tenant, and every
     downstream query runs under that tenant's RLS GUC. The agent cannot select its tenant.
- The resolved slug then drives `resolveActorTenant` (`src/db/org.ts:276`), and **all** invoke
  logic runs inside `withTenantTx(pool, tenantId, …)` (`invoke.ts:316`) under the tenant RLS
  policy — the agent never sees another tenant's `agent_card`, `role_assignment`, or grants.

### 3.5 Summary of the disjointness invariant

| Token `actor_type` | Resolver | Filter | Can return |
|---|---|---|---|
| `human` | `resolveActorSlugFromAuth` (existing, unchanged) | `e.kind = 'human'` (`org.ts:383`) | **only** a human slug |
| `agent` | `resolveAgentSlugFromAuth` (new, §2.2) | `e.kind = 'agent'` + `agent_card` FK | **only** an agent slug |

The two are selected by a validated claim, query disjoint `kind` partitions, and each fails
closed (`null` → `401`). The crossover set is empty.

---

## 4. The `invoke` `DEV_TENANT_ID` pin (T-0328 risk 3)

Today `invoke` hard-pins the tenant (`src/http/invoke.ts:307` `const tenantId = DEV_TENANT_ID;`,
identically at the `/command` route). This was acceptable while the caller was also dev-pinned,
but with a real agent identity it is a **cross-tenant correctness gap**: a multi-tenant agent
token would still operate against `DEV_TENANT_ID`'s `agent_card`/grants.

**Design:** resolve the tenant **from the agent identity**, exactly as the human surfaces already
do via `resolveActorTenant` (`src/db/org.ts:276`, used across `inbox.ts`, `applications.ts`,
etc.). The flow becomes:

```ts
const callerSlug = await extractCallerId(req, pool);            // §2 (agent or human)
const tenantId = (getAuthMode() === "keycloak")
  ? await resolveActorTenant(pool, callerSlug)                  // derive from the resolved actor
  : DEV_TENANT_ID;                                              // dev keeps the single-silo pin
const result = await withTenantTx(pool, tenantId, async (client) => { /* unchanged */ });
```

Notes:

- `resolveActorTenant(pool, slug)` already returns the employee's `tenant_id` (cross-tenant
  BYPASSRLS lookup, `org.ts:287-297`) and falls back to `DEV_TENANT_ID` only when the slug is
  unknown / DB is down (`:301-304`). For an agent that resolved through `resolveAgentSlugFromAuth`
  the slug **always** exists (it came from a real `agent_card` row), so the fallback is not the
  hot path.
- The **target agent** (`target_agent_id`) is then validated **within that tenant**
  (`loadAgentCard(client, tenantId, targetAgentId)`, `invoke.ts:318`) under the tenant RLS GUC —
  so an agent in tenant A cannot invoke a target in tenant B (the card lookup misses → `400`).
  This makes invoke correctly **single-tenant per call**, keyed off the caller's own tenant.
- **Scope discipline:** this is the one change that is *not* a pure auth wrap. To keep the
  security fix shippable independently, the implementation task SHOULD land the agent-resolver +
  `actor_type` selector first (closes the 401, single-tenant via `DEV_TENANT_ID` still acceptable
  on the single-tenant prod silo), then land the `resolveActorTenant` swap as the explicit
  multi-tenant enabler. Both are listed in §5.

---

## 5. Rollout

### 5.1 Keycloak realm

The dev realm already ships agent service-account clients with the `actor_type` mapper and the
`service-account-<clientId>` users (`config/keycloak/realm-choros.json:110-152` and `:424-458`),
matching the T-0343 note. The production-realm work:

1. **Per-agent service-account client.** Every provisioned agent needs a confidential KC client
   with `serviceAccountsEnabled: true`, `standardFlowEnabled: false`,
   `directAccessGrantsEnabled: false`, the **`actor-type-mapper`** emitting `actor_type=agent`,
   and the **audience-mapper** adding `choros-api`. This is exactly what `agent-hire`'s
   `KcClientSpec` describes (`src/core/agent-hire.ts:43-50`, `actorType: "agent"`) — the live
   `KeycloakAdminPort` adapter (`src/keycloak/admin-port.ts`, per `agent-hire.ts:54`) provisions
   it at hire time. The dev seed clients (`agent-recon`/`agent-invoice`/`agent-triage`) are the
   pattern; the prod realm export must carry the equivalent for any pre-seeded agents.
2. **Confirm `preferred_username = service-account-<clientId>`.** This is the Keycloak default
   for service-account users and the strip in §2.2 depends on it. The implementation task MUST
   add a keycloak-mode acceptance check that a `client_credentials` token for an agent client
   carries `preferred_username` starting `service-account-`. (Optional hardening: add an explicit
   `username` protocol mapper on the agent clients so the value is pinned, not relied upon as a
   default.)
3. **Secrets.** Agent client secrets are founder-held in prod (`agent-hire.ts:49` `devSecret?`
   dev-only; prod secret out-of-band). Rotation is a Keycloak-admin action; access tokens rotate
   via short TTL. No Choros code change to rotate.

### 5.2 Migration

- **No new table.** The mapping column (`agent_card.kc_client_id`) and its per-tenant uniqueness
  exist (`migrations/032_agent_card.sql:46,56`).
- **One additive migration (recommended): global `kc_client_id` uniqueness** (§3.4) — a
  platform-wide guarantee that a clientId maps to exactly one agent across tenants, closing the
  cross-tenant `LIMIT 1` ambiguity at the schema level rather than relying on the
  realm-global-clientId property at runtime. Additive `CREATE UNIQUE INDEX` (or a hire-time
  uniqueness check) — no data rewrite.
- **Backfill of live `kc_client_id`.** Seeded agents have `kc_client_id` set to the
  `agent-<slug-tail>` clientId (`migrations/032:88-90`) or a slug placeholder for `s-ledger`/`s-ocr`
  (`:91-92`, `:79-81`). Any agent expected to authenticate in prod MUST have its `kc_client_id`
  equal to its **real** KC service-account clientId. A small data migration aligns placeholders
  to the provisioned clientIds (only for agents that get a live KC client).

### 5.3 Implementation follow-up (this is DESIGN ONLY — separate gated task)

| # | Work | Files | Priority |
|---|---|---|---|
| 1 | Add `resolveAgentSlugFromAuth` (§2.2) next to `resolveActorSlugFromAuth` | `src/db/org.ts` | **P0** |
| 2 | Branch on `ctx.actorType` in the keycloak path of `extractCallerId` (and any shared resolver) → agent path vs human path | `src/http/invoke.ts:107-124` | **P0** |
| 3 | Negative + positive tests: agent token → resolves to its agent slug (200/201); human token still `kind='human'`; agent `preferred_username` not `service-account-…`-prefixed → 401; unknown `kc_client_id` → 401; cross-kind never crosses (mirror `resolve-actor-slug.test.ts` + `invoke-caller-spoof.adversarial.test.ts`) | `src/__tests__/…` | **P0** |
| 4 | Resolve `invoke` tenant via `resolveActorTenant` instead of `DEV_TENANT_ID` pin (§4) | `src/http/invoke.ts:307` (+`/command`) | **P0/P1** (multi-tenant enabler) |
| 5 | Global `kc_client_id` uniqueness migration (§3.4 / §5.2) | `migrations/NNN_…sql` | **P1** |
| 6 | Prod-realm agent service-account clients + `preferred_username` acceptance check (§5.1) | `config/keycloak/realm-choros.json`, deploy | **P0** prerequisite for agent exec in prod |
| 7 | Apply the same agent-aware resolver to **other** agent-callable surfaces flagged by T-0328 (e.g. `floor1-editor`, which T-0328 §2.5 notes is called by "agents") so they accept `actor_type=agent` too | per T-0328 §2 | **P1** |

### 5.4 Top risks

1. **`preferred_username` not being `service-account-<clientId>` in some KC setup.** If a custom
   username mapper changes it, the strip in §2.2 silently returns `null` → agents 401. *Mitigation:*
   the §5.1.2 acceptance check; optionally pin via an explicit username mapper.
2. **Cross-tenant `kc_client_id` collision** before the global-uniqueness migration (§3.4).
   *Mitigation:* land migration #5; until then rely on the realm-global-clientId property and the
   tenant-derivation in §4 (a collision still lands in one deterministic tenant under RLS).
3. **Scope-creep coupling auth and multi-tenant.** Fixing the 401 (items 1-3) and the
   `DEV_TENANT_ID` pin (item 4) are separable; ship the auth fix first so agent exec works on the
   single-tenant prod silo, then the tenant-derivation as the multi-tenant enabler — exactly the
   sequencing T-0328 risk 3 recommends.

### 5.5 MUST be true before agents run in `CHOROS_AUTH_MODE=keycloak` prod

- [ ] `resolveAgentSlugFromAuth` exists; `extractCallerId` branches on `actor_type` and routes
      agent tokens to it (item 2). An agent `client_credentials` token → `invoke` succeeds (201),
      not 401.
- [ ] A human token still resolves `kind='human'` only; the T-0372 test stays green.
- [ ] Disjointness tests green: agent token cannot reach a human slug; human token cannot reach
      an agent slug; unknown/mis-prefixed identities → 401.
- [ ] Each provisioned prod agent has a KC service-account client (`actor_type=agent`,
      `aud ⊇ choros-api`) **and** an `agent_card` row whose `kc_client_id` equals that client's
      clientId.
- [ ] `kc_client_id` is globally unique (migration #5) **or** the realm-global-clientId property
      is documented as the relied-upon invariant.
- [ ] `invoke` tenant is derived from the caller (item 4) before multi-tenant prod (single-tenant
      prod may ship with the `DEV_TENANT_ID` pin if explicitly accepted).

---

## 6. Rejected alternatives

- **Relax `resolveActorSlugFromAuth` to also match `kind='agent'`.** Rejected — reverses the
  T-0372 anti-impersonation guard and conflates the two kinds in one query, so one bug widens
  authority across both. A separate resolver keeps the human guard a hard invariant (§2.3).
- **Pure convention `service-account-<clientId>` → `slug` with no DB lookup.** Rejected — the
  clientId (`agent-recon`) and the slug (`a-recon`) differ (`deriveKcClientId`,
  `agent-hire.ts:78-86`); there is no safe string transform, and a convention-only path would
  accept any well-named KC client even if no `agent_card` exists (no proof the agent is
  provisioned in this Choros). The `agent_card` row IS the authoritative binding.
- **A new `client_id → employee` table.** Rejected — `agent_card.kc_client_id`
  (`migrations/032_agent_card.sql:46`, `UNIQUE (tenant_id, kc_client_id)`) already is that table,
  populated at hire time and by seeds. A second one doubles the rotation/consistency surface.
- **Keep failing closed (401) and require agents to use the dev `x-dev-user` path.** Rejected —
  re-opens the exact bypass T-0418/T-0420 closed; and `x-dev-user` is a no-op in keycloak mode
  anyway. Agents must authenticate with a real validated token.
- **Let `invoke` keep `DEV_TENANT_ID` permanently.** Rejected for multi-tenant prod — it would
  run every agent against one tenant's grants/cards. Acceptable only as an explicitly-accepted
  interim on a single-tenant silo (§4, §5.4).
