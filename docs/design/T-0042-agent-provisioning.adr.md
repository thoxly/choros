# ADR · T-0042 — Agent provisioning (E5.2): hire = management grant on `mgmt_object:agent`

**Phase:** DESIGN · **Status:** ready (no founder escalation) · **Date:** 2026-06-11
**Task:** E5.2 — Agent provisioning: hire requires a management grant
`{mgmt_object:agent, create, org-scope}`; creates `employee(kind='agent')` + `agent_card`
+ a Keycloak service-account atomically; a role-less agent has **zero tool access by
construction**; identity (`kc_client_id`) is decoupled from rights (role → grants).

**Spec (input):** `docs/specs/T-0042-agent-provisioning.spec.md` +
`docs/specs/T-0042.spec.contract.json` (status: ready; FR-1..FR-8, NF-1..NF-7, AC-1..AC-17;
no blocking questions).

**Authoritative sources (consumed, NOT re-decided):**
- `src/core/scoped-admin.ts` (T-0029) — `validateAdminDelegation` is the hire-authorization
  gate, reused VERBATIM. Administration is "hold a delegable `mgmt_object:*` grant", not a
  subsystem (NF-1).
- `src/core/grant-lattice.ts` (T-0018) — `Grant`, `ScopeElement`, `AncestryOracle`,
  `GrantAuditEvent`. NOT modified.
- `src/core/grant-resolver.ts` (T-0021) — read-path PDP. NOT modified.
- `src/core/mcp-tool-registry.ts` (T-0043) — `resolveAgentToolset(input, deps)`:
  `toolset = query(grants)`. NOT modified; consumed read-only for AC-8.
- `migrations/016_employee.sql` (T-0017) + `migrations/032_agent_card.sql` (T-0020) — the
  `employee` and `agent_card` schema already exist with the `(tenant_id, kc_client_id)` UNIQUE
  constraint and the `kind='agent'` discriminator FK. **No new migration is required** (NF-5).
- `docs/design/T-0054-keycloak-compose.adr.md` — the Keycloak realm, the `agent-*`
  service-account client pattern (§3.5), `actor_type=agent` mapper (§3.3), the dev Admin
  credentials env-contract (§4.3), and the `client_credentials` grant. The hire-time client is
  created via the **Keycloak Admin REST API** (the alternative the T-0054 build did NOT need,
  but T-0042 does — see §1.1).
- `src/http/grants.ts` (T-0030) — the **write-path composition pattern** this task mirrors:
  `loadAdminContext` → `validateAdminDelegation` (gate before any side-effect) → `withTenantTx`
  (atomic INSERT + audit via the canonical `appendAuditEvent` sink).
- `src/db/audit-writer.ts` (T-0068) — the SINGLE canonical audit sink `appendAuditEvent(tx,
  input)`; the hire audit row goes through it inside the same transaction (FR-6, NF-7).

> **This ADR designs the agent-provisioning seam; it does not write the implementation.**
> It fixes the module boundaries, the object model (request/response/port shapes), the atomic
> composition order, and the fitness functions. `coder` and `tester` read §3–§6 as source of
> truth. **No production code in this file.**

---

## 1. Decision

Ship agent hiring as a **thin HTTP route over a pure hire-service core**, composing four
existing pieces in one atomic unit, with the only new IO boundary being an **injected Keycloak
Admin port**. Concretely:

1. **`src/core/agent-hire.ts`** — a NEW pure core module (no `pg`/`fs`/`net`/`http` import).
   It exports:
   - `deriveKcClientId(slug)` — the deterministic `agent-<slug>` derivation rule (FR-3), with
     normalization (lowercase, `[^a-z0-9-]`→`-`, collapse repeats, length cap) so the result is
     a valid Keycloak `clientId`. Pure; the DB UNIQUE constraint is the conflict enforcement seam.
   - `buildAgentHirePlan(input)` — validates the request shape and produces the immutable plan
     (employee row fields, agent_card row fields with all Stage-2 columns NULL, the derived
     `kc_client_id`, the audit-event shape). Pure; no authorization, no IO.
   - The `KeycloakAdminPort` interface (`createServiceAccountClient` / `deleteClient`) — the
     port/adapter seam (NF-7). The pure core depends on the **interface**, never the adapter.
   - Typed result/error union (`HireOk` | `HireRejected`) carrying the distinct reasons
     (`no_mgmt_grant` re-using the `AdminDelegationResult` reasons, `client_id_conflict`,
     `keycloak_failed`, `db_failed`).

2. **`src/keycloak/admin-port.ts`** — a NEW file holding the **live HTTP adapter**
   `makeHttpKeycloakAdminPort(config)` implementing `KeycloakAdminPort` against the Keycloak
   Admin REST API (token via `client_credentials` against the realm admin client; `POST
   /admin/realms/<realm>/clients` to create the confidential client with
   `serviceAccountsEnabled:true` + `directAccessGrantsEnabled:false`; set `actor_type=agent` on
   the auto-created service-account user; `DELETE` for orphan cleanup). Admin credentials are
   read from env (`KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`, realm, base URL) — never
   committed (NF-6). A NEW `src/keycloak/fake-admin-port.ts` ships the in-memory
   `InMemoryKeycloakAdminPort` (a capture-log fake) used by unit tests (NF-7, AC-16) — it lives
   OUTSIDE `src/core/` so the live adapter and the fake are both injectable substitutes.

3. **`src/db/agent-provision.ts`** — a NEW DB DAO `insertAgentRows(tx, plan)` that runs INSIDE
   the caller's open `withTenantTx` transaction (the `grants.ts` pattern): INSERT `employee` +
   INSERT `agent_card`, both bound with `tenant_id` leading. It does NOT open its own BEGIN/COMMIT.

4. **`src/http/agents.ts`** — a NEW route `registerAgentRoutes(router, pool, kcPort)` exposing
   **`POST /api/agents/hire`**. The handler composition (the atomic unit, §4):
   1. `extractActor(req)` (x-dev-user under `CHOROS_AUTH_MODE=dev`; mirrors `grants.ts`).
   2. `loadAdminContext(pool, tenantId, actor, now)` + `validateAdminDelegation` with a
      `{kind:"assignment", targetOrgScope}` target whose scope is the target `position_id`'s
      org node — the hire authorization gate (FR-1, AC-1/AC-3). **Rejected before any DB write
      or Keycloak call.**
   3. `buildAgentHirePlan(body)` → derive `kc_client_id`.
   4. **Keycloak first, DB second** (so DB rollback cleanly undoes the only durable side-effect
      and the orphan-cleanup window is a single Keycloak client): call
      `kcPort.createServiceAccountClient(plan)`; on failure → 5xx/typed error, **no DB write**
      (AC-6). On success, open `withTenantTx`:
      - `insertAgentRows(tx, plan)` — the UNIQUE `(tenant_id, kc_client_id)` violation surfaces
        as `client_id_conflict` → 409 (AC-12).
      - `appendAuditEvent(tx, hireAuditInput)` — the hire audit row, same tx (FR-6, AC-11).
      - If the transaction throws/rolls back AFTER the Keycloak client was created →
        best-effort `kcPort.deleteClient(kc_client_id)` for orphan cleanup; audit the failure if
        the delete also fails (NF-4, AC-7).
   5. 201 with `{ employee_id, kc_client_id }` (AC-2/AC-5).

The mechanism is deliberately **proportional** (rubric axis 5): one pure core, one port + two
adapters (live + fake), one DAO, one route. No new table, no second authority store, no edit to
any frozen rights module. The hire is "compose four finished pieces" — exactly what the spec §1
promised.

### 1.1 Keycloak Admin REST API — why a hire-time call (not realm-import)

T-0054 provisions agent clients **declaratively** via realm-JSON import-on-start, and its ADR
§2 explicitly rejected build-time Admin-REST calls for the *static fixture* set. T-0042 is the
**dynamic** path: an agent hired at runtime cannot be in a committed realm file. The Admin REST
API is therefore the correct seam *here* — it is created at hire-time, behind the injected
`KeycloakAdminPort` (NF-7) so the pure core never imports `http` and unit tests run without a
live Keycloak. This does not contradict T-0054: realm-import remains the path for the seed
fixture; the Admin API is the path for runtime-provisioned agents.

### 1.2 No migration (NF-5 / AC-17 satisfied vacuously)

Migration slot **042 is reserved but NOT used.** The required schema already exists:
`employee(kind='agent')` (016), `agent_card` with `(tenant_id, kc_client_id)` UNIQUE and the
`kind='agent'` discriminator FK (032), and `audit_event`/`audit_head` (006/007). FR-4 forbids
any new column/FK from the rights tables to `agent_card`/`kc_client_id`, and the audit
infrastructure (FR-6) is reused. **No new table is needed**; introducing one would violate NF-1
(no second store) and the spec's own §7 assessment. AC-17 is satisfied vacuously — stated here
explicitly per the AC's instruction.

### 1.3 Identity ⊥ rights is structural, not enforced by this task

`kc_client_id` is written to `agent_card` by the DAO and **never read by the rights layer**.
`resolveAgentToolset` (T-0043) takes `(tenantId, employeeId, nowMs)` and `mcp-tool-registry.ts`
/ `grant-resolver.ts` / `grant-lattice.ts` contain no `kc_client_id` / `agent_card` reference
today — T-0042 adds none (FR-4, AC-9). The zero-toolset property (FR-5, AC-8) is a *consequence*
of `getGrants` returning `[]` for a role-less subject, demonstrated by calling the unmodified
`resolveAgentToolset` against the new `employee_id` — not a deny-config this task writes.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **DB-first, then Keycloak** | A Keycloak failure would require deleting already-committed DB rows (a compensating DELETE outside the tx, fighting RLS/audit-append-only). Keycloak-first makes the DB transaction the *last* mutation: its ROLLBACK is the clean undo, and the only orphan window is a single Keycloak client (one best-effort DELETE, NF-4). |
| **Call the Keycloak Admin API directly from the route handler (no port)** | Couples the hire core to `http` + a live Keycloak; unit tests would need a running server (violates NF-7, AC-16). The injected `KeycloakAdminPort` keeps the core pure and lets the fake capture-log substitute. |
| **New migration 042 with a `hire_event` table** | Redundant with the canonical `audit_event` chain (FR-6 audits through the same sink as grants/assignments). A second event store would violate NF-1 and the spec §7 assessment. Slot 042 stays reserved-and-clear. |
| **Add a `kc_client_id` column/index to `grant`/`role`/`assignment` to "link" identity** | Directly violates FR-4 (identity decoupled from rights) and AC-9. The rights layer keys on `employee_id` only; the Keycloak identity is invisible to it by construction. |
| **A new admin flag / ACL table to authorize the hire** | Violates NF-1 / AC-13. Hire authorization is an ordinary `{mgmt_object:agent, create, org-scope}` grant checked by the existing `validateAdminDelegation` — no second authority subsystem. |
| **Auto-assign a "default agent role" on hire** | Violates FR-5: a freshly hired agent MUST have zero grants (structural least-privilege). Role assignment is a separate admin action (E3.2 / out-of-scope §3). Hire ends at employee + agent_card + KC client. |
| **Assign a Keycloak realm role to the service account** | Violates FR-8 / AC-10. Choros rights live in the TS core; the service-account carries only the `actor_type=agent` attribute, no realm role. |
| **Idempotency via a new `idempotency_key` column** | Over-builds FR-7 (best-effort NF). The `(tenant_id, kc_client_id)` UNIQUE constraint is the write-time guard (a retry deriving the same `kc_client_id` hits the conflict → `client_id_conflict`/existing record). A dedicated idempotency table is deferred; the unique constraint suffices day-1. |
| **Put the hire route under the worker-API / touch JWT validation** | T-0060's seam (E1.4). T-0042 only *creates* the service account; it never validates the agent's token. The hire route is an admin (human-caller) endpoint under the existing dev-auth seam. |

---

## 3. Object model & contracts (source of truth for `coder` / `tester`)

### 3.1 HTTP contract — `POST /api/agents/hire`

**Request body** (JSON):

| Field | Type | Notes |
|---|---|---|
| `position_id` | `string` (UUID) | Target position; its org node is the scope the admin grant must admit (FR-1). |
| `slug` | `string` | Stable agent slug; basis of `kc_client_id` derivation and the `employee.slug` UNIQUE key. |
| `display_name` | `string` | Human-readable label for the `employee` row. |
| `llm_endpoint?` / `llm_model?` / `llm_secret_handle?` / `autonomy_threshold?` | optional | Accepting them is autonomous; if omitted, persisted as NULL (dormant, §3 spec). |

**Response** (201): `{ employee_id: string (UUID), kc_client_id: string }`.
**Errors:** 403 `no_mgmt_grant` / admin-gate reason (FR-1); 409 `client_id_conflict` (FR-7/AC-12);
5xx `keycloak_failed` (AC-6) / `db_failed` (AC-7).

### 3.2 `KeycloakAdminPort` (NF-7 — the only new IO boundary)

```ts
export interface KcClientSpec {
  clientId: string;            // = deriveKcClientId(slug), e.g. "agent-<slug>"
  serviceAccountsEnabled: true;
  standardFlowEnabled: false;
  directAccessGrantsEnabled: false;   // client_credentials only (FR-3)
  actorType: "agent";          // set on the service-account user (FR-3, AC-4)
  devSecret?: string;          // dev only; prod secret founder-held (NF-6, RL-1)
}
export interface KeycloakAdminPort {
  createServiceAccountClient(spec: KcClientSpec): Promise<{ clientId: string }>;
  deleteClient(clientId: string): Promise<void>;   // best-effort orphan cleanup (NF-4)
}
```

The **live adapter** `makeHttpKeycloakAdminPort(cfg)` (`src/keycloak/admin-port.ts`) and the
**in-memory fake** `InMemoryKeycloakAdminPort` (`src/keycloak/fake-admin-port.ts`, with a
capture log + a `failOnCreate` / `failAfterCreate` switch for AC-6/AC-7) both implement this
interface. The pure core (`src/core/agent-hire.ts`) imports only the interface.

### 3.3 Pure core — `src/core/agent-hire.ts`

```ts
export function deriveKcClientId(slug: string): string;   // "agent-" + normalized(slug)

export interface AgentHireInput {
  tenantId: string; positionId: string; slug: string; displayName: string;
  llmEndpoint?: string|null; llmModel?: string|null;
  llmSecretHandle?: string|null; autonomyThreshold?: number|null;
  nowMs: number;
}
export interface AgentHirePlan {
  employee: { tenantId; id /*new UUID*/; positionId; kind: "agent"; slug; displayName; createdAt; updatedAt };
  agentCard: { tenantId; employeeId; employeeKind: "agent"; kcClientId;
               llmEndpoint; llmModel; llmSecretHandle; autonomyThreshold;
               budgetPolicyId: null; escalationRuleId: null; createdAt; updatedAt };
  kcSpec: KcClientSpec;
}
export function buildAgentHirePlan(input: AgentHireInput): AgentHirePlan;   // pure, no auth/IO

// hire-audit shape → encoded to AuditEventInput (type: "agent.hire")
export interface AgentHireAuditEvent {
  actor: string;              // caller employee_id (FR-6)
  subject: string;            // new agent employee_id
  capability: { resourceType: "mgmt_object:agent"; operation: "create" };
  scope: ScopeElement;        // admitting org-scope
}
export function encodeAgentHireAuditEvent(e: AgentHireAuditEvent, nowMs: number): AuditEventInput;
```

### 3.4 DB DAO — `src/db/agent-provision.ts`

```ts
// Runs INSIDE caller's withTenantTx (tenant GUC set). No own BEGIN/COMMIT.
// INSERT employee (kind='agent') then agent_card; tenant_id leading on both.
// A unique-violation (23505) on (tenant_id, kc_client_id) OR (tenant_id, slug) is
// translated by the route to a typed client_id_conflict / 409 (AC-12).
export async function insertAgentRows(tx: PgClientLike, plan: AgentHirePlan): Promise<void>;
```

### 3.5 Entities touched (no schema change — read-only confirmation)

| Entity | Source | T-0042 action |
|---|---|---|
| `employee` | 016 | INSERT one `kind='agent'` row (additive data; no DDL). |
| `agent_card` | 032 | INSERT one row; Stage-2 columns NULL; `kc_client_id` from the port. |
| `audit_event`/`audit_head` | 006/007/T-0068 | APPEND one `agent.hire` row via `appendAuditEvent` (same tx). |
| `grant` (mgmt_object:agent) | 008/T-0029 | READ-only via `loadAdminContext` for the gate. |

---

## 4. Atomicity & failure matrix (NF-4)

| Stage outcome | Keycloak client | DB rows | Result |
|---|---|---|---|
| Admin gate rejects | not called | not written | 403; zero side-effects (AC-1/AC-3). |
| KC create fails | none | not written (tx never opened) | 5xx `keycloak_failed` (AC-6). |
| KC ok, DB INSERT/audit/commit fails | created → **best-effort `deleteClient`** | rolled back | 5xx `db_failed`; delete attempt asserted in test (AC-7). |
| KC ok, `kc_client_id` already in `agent_card` | created → delete the just-created dup (cleanup) | conflict, rolled back | 409 `client_id_conflict` (AC-12). |
| All ok | created | committed | 201 `{employee_id, kc_client_id}` (AC-2/AC-5); audit row present (AC-11). |

Audit row + DB rows share one `withTenantTx` ⇒ a failed audit append rolls back the rows (FR-6).
The Keycloak client is created *before* the tx, so the only orphan risk is "KC ok, DB fails" —
handled by the best-effort delete.

---

## 5. Traceability (AC → design)

| AC | Covered by |
|---|---|
| AC-1 (hire blocked without grant; zero side-effects) | §1 step 2 gate-before-write · §4 row 1 · **FF-HIRE-1**, **FF-HIRE-5** |
| AC-2 (hire succeeds with grant; 1 employee + 1 agent_card) | §1 steps 2–4 · §3.4 DAO · **FF-HIRE-5** (integration) |
| AC-3 (scope narrowing; disjoint position rejected) | §1 step 2 `validateAdminDelegation` org-axis · **FF-HIRE-5** |
| AC-4 (KC service account: serviceAccountsEnabled, client_credentials, actor_type=agent) | §3.2 `KcClientSpec` · §1.1 adapter · **FF-HIRE-5** (fake-port capture) |
| AC-5 (kc_client_id stored in agent_card) | §3.3 plan · §3.4 DAO INSERT · **FF-HIRE-5** |
| AC-6 (DB rollback on KC failure) | §1 step 4 KC-first · §4 row 2 · **FF-HIRE-5** (fake `failOnCreate`) |
| AC-7 (KC orphan cleanup on DB failure) | §1 step 4 best-effort delete · §4 row 3 · **FF-HIRE-5** (fake `failAfterCreate`) |
| AC-8 (zero toolset by construction) | §1.3 · unmodified `resolveAgentToolset` · **FF-HIRE-2** (no resolver edit) · **FF-HIRE-5** |
| AC-9 (kc_client_id not in rights layer) | §1.3 · **FF-HIRE-2** (grep rights modules) |
| AC-10 (no KC realm role assigned) | §3.2 (no role-mapping call) · rejected-alt · **FF-HIRE-5** (fake captures no role-add) |
| AC-11 (hire audited; one record, correct actor/subject/capability/scope) | §1 step 4 audit-in-tx · §3.3 encoder · **FF-HIRE-5** |
| AC-12 (duplicate kc_client_id rejected, typed) | §1 step 4 UNIQUE → 409 · §4 row 4 · **FF-HIRE-5** |
| AC-13 (no second authority subsystem) | §1 (gate = `validateAdminDelegation` only) · **FF-HIRE-3** |
| AC-14 (additive-only to shared files) | §1 (no edit to frozen modules) · **FF-HIRE-4** |
| AC-15 (dev-auth compatibility) | §1 step 1 `extractActor`/x-dev-user · **FF-HIRE-5** (CHOROS_AUTH_MODE=dev) · existing suite |
| AC-16 (Keycloak port injectable) | §3.2 port + fake adapter · **FF-HIRE-6** |
| AC-17 (migration seam, vacuous) | §1.2 no migration · **FF-HIRE-7** |

---

## 6. Fitness functions (executable CI rules)

Each is `static-now` (lint/grep/script in `npm run fitness`) unless marked `test`
(vitest in `npm run ci`). New `*.sh` checks are **appended** to the `npm run fitness` chain and
the new vitest files join `vitest run` — both additive, no edit to existing checks (NF-2).

| ID | Rule | ci_check | gating |
|---|---|---|---|
| **FF-HIRE-1** | The hire route calls `validateAdminDelegation` (or `loadAdminContext`+gate) BEFORE any `insertAgentRows` / `createServiceAccountClient` call — authorization precedes side-effects. | static-now: `ci/checks/agent-hire-gate-order.sh` — in `src/http/agents.ts`, assert the line index of the `validateAdminDelegation` call is less than the first `insertAgentRows`/`createServiceAccountClient` call (grep -n line-number comparison); fail if a side-effect call precedes the gate. | static-now |
| **FF-HIRE-2** | Identity invisible to rights: `grant-resolver.ts`, `grant-lattice.ts`, `mcp-tool-registry.ts` reference no `kc_client_id` / `agent_card` / `kc_` token (AC-9). | static-now: `ci/checks/agent-hire-identity-isolation.sh` — `grep -nE 'kc_client_id\|agent_card\|kc_' src/core/{grant-resolver,grant-lattice,mcp-tool-registry}.ts` (excluding `//` comment lines) returns 0 matches; non-zero = fail. | static-now |
| **FF-HIRE-3** | No second authority subsystem: the hire path (`src/http/agents.ts`, `src/core/agent-hire.ts`, `src/db/agent-provision.ts`) introduces no `*_acl` / admin-flag / ACL-store token and authorizes ONLY via `validateAdminDelegation` (AC-13). | static-now: `ci/checks/agent-hire-no-second-authority.sh` — (a) `grep -E '_acl\|adminFlag\|admin_table\|aclStore'` over the three files = 0; (b) `grep -c 'validateAdminDelegation' src/http/agents.ts` ≥ 1; fail otherwise. | static-now |
| **FF-HIRE-4** | Additive-only to frozen/shared files: `grant-lattice.ts`, `grant-resolver.ts`, `mcp-tool-registry.ts`, `scoped-admin.ts`, `router.ts`, `auth.ts` are unmodified by this task (or, if `auth.ts`/`router.ts` touched, additive only — no deleted/changed existing lines) (AC-14, NF-2). | static-now: `ci/checks/agent-hire-frozen-additive.sh` — `git diff --stat <dev-base> -- src/core/grant-lattice.ts src/core/grant-resolver.ts src/core/mcp-tool-registry.ts src/core/scoped-admin.ts` shows 0 changed files; for `src/http/auth.ts`/`router.ts`, `git diff --numstat` shows `deleted == 0`. | static-now |
| **FF-HIRE-5** | End-to-end hire behavior: AC-1/2/3/4/5/6/7/8/10/11/12/15 covered by an integration test using the in-memory `KeycloakAdminPort` fake (capture log) + a transactional DB (or the static-now DAO test double): asserts gate rejection (no rows, no KC call), success (1 employee + 1 agent_card + kc_client_id + `actor_type=agent` captured, no realm role), KC-fail rollback, DB-fail orphan-delete, duplicate→409, audit row present, and `resolveAgentToolset(new employee)` === `[]`. | test: `src/__tests__/agent-hire.test.ts` (vitest, runs in `npm run ci`); the fake port's `failOnCreate`/`failAfterCreate` switches drive AC-6/AC-7. | test |
| **FF-HIRE-6** | Keycloak port is injectable: `registerAgentRoutes` / the hire-service factory accepts a `KeycloakAdminPort` parameter; the live HTTP adapter (`src/keycloak/admin-port.ts`) and the fake (`src/keycloak/fake-admin-port.ts`) are SEPARATE files from the pure core; `src/core/agent-hire.ts` imports no `node:http`/`pg` (AC-16, NF-7). | static-now: `ci/checks/agent-hire-port-injectable.sh` — (a) `test -f src/keycloak/admin-port.ts && test -f src/keycloak/fake-admin-port.ts`; (b) `grep -E "from .*['\"](pg\|node:http\|http)['\"]" src/core/agent-hire.ts` = 0; (c) `grep 'KeycloakAdminPort' src/http/agents.ts` ≥ 1 (port is a route param). | static-now |
| **FF-HIRE-7** | Migration seam: NO `migrations/042_*.sql` is added (this task needs no migration, §1.2); IF one is ever added it must be `042_`-prefixed, additive, FORCE-RLS/default-DENY/tenant_id-leading, seeds `ON CONFLICT DO NOTHING` (AC-17). | static-now: `ci/checks/agent-hire-migration-seam.sh` — assert no new `migrations/04[13]_*` touched by this task; IF `migrations/042_*.sql` exists, grep it for `FORCE ROW LEVEL SECURITY`, a leading `tenant_id`, and `ON CONFLICT DO NOTHING` on any INSERT; absent file ⇒ pass (vacuous). | static-now |

**CI wiring.** All `static-now` checks append to the existing `npm run fitness` chain in
`package.json` and gate on the existing `ci` job — no new workflow infrastructure (NF-2). The
`test` (vitest) file joins the existing `vitest run`. The optional `live-kc` exercise (hiring an
agent against a real Keycloak and reading back the client) is NOT added to the gating path — the
fake-port integration test (FF-HIRE-5) is the day-1 enforcement; a live-kc smoke can be added to
the additive `kc` job later (out of scope for T-0042's gate).

---

## 7. Runtime target

**Local dev + silo docker-compose stack.** The hire route runs in the Choros core server
(`node dist/index.js`) and calls the Keycloak Admin REST API of the `keycloak` service (T-0054)
over the compose network. Unit/integration tests run with the in-memory `KeycloakAdminPort` fake
— **no live Keycloak required** (NF-7). No external resource is provisioned by this task: the dev
Keycloak already exists (choros-server-provisioned, /srv/choros). Production Keycloak deploy +
the founder-held prod Admin secret remain **E0.7, founder-gated (GT-4 / RL-1)** — T-0042 commits
no prod credential.

---

## 8. Escalation

**None.** All high-leverage forks are founder-ratified (spec §6): agent = polymorphic employee
(GT-1), hire = `mgmt_object:agent, create` grant (T-0029), Keycloak service-account identity
(T-0054), structural 0-roles→0-tools (T-0043), identity decoupled from rights (T-0021/T-0054).
The decisions made here (Keycloak-first ordering, the `agent-<slug>` derivation rule, the
port/adapter split, no-migration) are autonomous implementation/architecture details the spec
marks as DESIGN-owned. `status: ready`.

**Unresolved forks:** none. The FR-7 idempotency mechanism is intentionally left as the
unique-constraint write-guard (best-effort NF); a dedicated idempotency-key table is deferred,
not a blocking fork.
