# ADR · T-0039 — LLM-proposes-grants / human-confirms (E3.5)

**Phase:** DESIGN. **Status:** `ready` (no founder gate — GT-1 signed E3.5 day-1).
**Machine contract:** `docs/design/T-0039.adr.contract.json` (schema `schemas/adr.schema.json`).
**Spec in:** `docs/specs/T-0039-llm-proposes-grants.spec.md` + `.spec.contract.json` (15 AC).

---

## 0. One-paragraph decision

T-0039 adds a single **ephemeral, read-only proposal endpoint** `POST /api/grants/propose` that
(a) resolves the tenant's BYO proposal-agent from `agent_card` by a well-known slug, (b) resolves
its `llm_secret_handle` through an **injected RL-3 secret-resolver port** (custody owned by T-0025,
never implemented here), (c) calls the agent's `llm_endpoint` over plain `globalThis.fetch` (no LLM
SDK, no platform key), (d) **sanitizes** every returned atom through the already-exported
`parseScopeElement` (freeform → dropped), and (e) returns `{ proposal_agent_id, proposed: ProposedGrantAtom[] }`
**without writing any `grant` row**. The endpoint emits one informational `grant.proposal_requested`
audit row via the canonical audit sink. **No new table, no new scope algebra, no LLM dependency.**
Confirmation reuses the *unchanged* `POST /api/grants` write-path: the architectural crux (§3) is
that `proposed_by` is recorded as a **provenance stamp** (the agent-employee UUID echoed from the
proposal response) that **confers zero authority**, while the dual-control approver identity
(`confirmed_by`/`confirmed2_by`) stays R-AUTH-bound to the authenticated actor — so T-0044's
body-assertion close and `scoped-admin.ts` are not weakened. AC-05 ("no grant active without
confirmation") is a predicate on the active-grant load DAO (`confirmed_by IS NOT NULL`), enforced
by a fitness grep + integration test. The static `LLM_PROPOSALS` UI mock is deleted and `propose()`
becomes a live `fetch`.

---

## 1. Context inherited (do not rebuild)

- `src/http/grants.ts` — `POST /api/grants` (T-0030/T-0044), `parseScopeElement` (exported),
  `withTenantTx`, `appendAuditEventInput`, `registerGrantsRoutes`, `registerDictionariesRoute`.
- `migrations/030` — `grant.proposed_by` / `confirmed_by` are nullable **`text`** columns (NOT
  uuid-typed in DDL). `migrations/031` — `confirmed2_by`.
- `migrations/032` — `agent_card(tenant_id, employee_id, kc_client_id, llm_endpoint, llm_model,
  llm_secret_handle, ...)`, RLS-isolated, schema-dormant. The dev seed has all LLM fields `NULL`.
- `src/core/audit-grant-encoder.ts` — `AuditEventInput { id, type, actor, subject, scope?, via,
  payload }` is the canonical seam; `lifecycle-audit.ts` is the precedent for an informational
  (non-grant) `AuditEventInput` carrying a `via`.
- `src/core/grant-resolver.ts` — `resolveFor` is **pure compute**; it consumes `coveringGrants:
  Grant[]`. It does NOT itself query the DB. The active-grant **load** DAO (the query that produces
  `coveringGrants`) is T-0053-deferred; AC-05 attaches to that load.
- `src/core/scoped-admin.ts::validateAdminDelegation` — the narrowing gate. **Frozen by NF-6 / T-0029
  FF-11** (`scoped-admin-isolation.sh`). Untouched.
- HTTP precedent: `src/core/flowable-client.ts` uses `globalThis.fetch` with an injected config and
  no new npm dep. T-0039 mirrors this (NF-1).

---

## 2. Mechanism

### 2.1 New route module `src/http/grant-propose.ts`

A **separate module** (not appended into `grants.ts`) exporting
`registerGrantProposeRoute(router, pool, deps)`. Rationale: keeps the T-0030/T-0044 frozen file
(`grant-editor-isolation.sh` asserts structure of `grants.ts`) free of churn, and isolates the only
network-egress code path in the rights surface into one auditable file. It **imports**
`parseScopeElement` from `./grants.js` (the existing export — compatibility contract, §6), so there
is exactly one scope parser (no second algebra).

`server.ts` registers it alongside the others, **after** `registerGrantsRoutes` (order irrelevant —
the path `/api/grants/propose` is a distinct literal, not captured by any `:id` pattern, because the
grant routes are `/api/grants` (POST root), `/api/grants/:id/revoke`; `propose` is a fixed segment).

### 2.2 Dependency injection (testability + custody boundary)

The route takes a `deps` bag so AC-01/06/08/11/12/13 can be tested with stubs and so the **secret
custody boundary** (E5.5 / T-0025) is honored as a port, not an implementation:

```
interface GrantProposeDeps {
  resolveSecret: (handle: string, ctx: { tenantId: string }) => Promise<string>;  // RL-3 port (T-0025 owns impl)
  callLlm: (req: LlmProposeRequest) => Promise<LlmProposeResponse>;               // BYO HTTP call (default = fetch impl)
  now: () => number;
}
```

Day-1 defaults: `resolveSecret` = an identity/echo stub guarded so the **resolved value is never
logged or returned** (NF-4); `callLlm` = a `globalThis.fetch` POST to `agent_card.llm_endpoint`
carrying the role description + a JSON structured-output schema for grant atoms. The real RL-3
resolver lands with T-0025 and is injected then — **T-0039 does not store or implement secret
custody** (matches E5.5 invariant "platform governs handle, never raw key").

### 2.3 Request / response shape (FR-1)

```
POST /api/grants/propose
  body:    { text: string, role_id: uuid }
  200:     { proposal_agent_id: uuid, proposed: ProposedGrantAtom[] }
  503:     { error: { code: "NO_PROPOSAL_AGENT" } }            // FR-7 / AC-08
  400:     { error: { code: "VALIDATION" } }                  // bad text/role_id
```

`ProposedGrantAtom = { resource_type: string, operation: string, scope: ScopeElement, reason?: string }`.
`scope` is always a **post-`parseScopeElement` normalized** `ScopeElement` (node/tags/interval/set).
There is no `proposed_by` in each atom; the agent identity is carried once at the envelope level
(`proposal_agent_id`) and the UI threads it into the confirm POST (FR-4 / AC-15).

### 2.4 Proposal-agent resolution (FR-2 / FR-8 / NF-5)

Inside a `withTenantTx` (RLS-scoped, same SET LOCAL `choros.tenant_id` guard as `grants.ts`):

```sql
SELECT ac.employee_id, ac.llm_endpoint, ac.llm_secret_handle, ac.llm_model
  FROM choros.agent_card ac
  JOIN choros.employee e ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
 WHERE ac.tenant_id = current_setting('choros.tenant_id')::uuid
   AND e.slug = $1            -- well-known slug, default 'proposal-agent' (env override PROPOSAL_AGENT_SLUG)
   AND ac.llm_endpoint IS NOT NULL
 LIMIT 1;
```

- Zero rows (no agent OR `llm_endpoint IS NULL`) ⇒ **`503 NO_PROPOSAL_AGENT`** (FR-7). No fallback.
- Tenant isolation is **structural** via RLS + the `choros.tenant_id` GUC (FR-8 / AC-12): the query
  cannot see another tenant's `agent_card` row. (If `employee.slug` does not exist in the live
  schema, the coder resolves by `kc_client_id = 'agent-' || slug` or an `employee_id` env override —
  the resolution key is a coder seam; the **contract** is "tenant-scoped, single agent, slug-driven,
  `llm_endpoint NOT NULL` required".)

### 2.5 LLM call + sanitization (FR-5 / NF-1 / NF-2 / NF-3)

1. `resolveSecret(llm_secret_handle, {tenantId})` → credential (held only in a local, never logged).
2. `callLlm({ endpoint, model, secret, text, schema })` → `{ atoms: unknown[] }` over `fetch`.
3. For each raw atom: `parseScopeElement(atom.scope)`. If it returns `null` (invalid OR `freeform`)
   the atom is **dropped** (NF-2/NF-3/AC-06/AC-11) — never a 500. `resource_type`/`operation` are
   carried through as strings (the structural editor and `POST /api/grants` validate them on
   confirm; the proposal endpoint does not re-implement that validation — proportionality).
4. Return the surviving atoms. A response with zero survivors is a valid `200 {proposed: []}`.

### 2.6 Proposal audit (FR-9 / AC-09)

One informational `AuditEventInput` appended through the **canonical** `appendAuditEventInput`
(NF-7 — no parallel audit path), inside the same `withTenantTx`:

```
{ id, type: "grant.proposal_requested", actor: <admin-who-clicked>,
  subject: <role_id>, via: "grant-propose",
  payload: { proposalAgentId, proposedCount, model } }   // NO secret, NO endpoint credential (NF-4)
```

This is **not** a `GrantAuditEvent` (no grant row exists). It is emitted whether or not the admin
later confirms. The credential never enters `payload` (AC-13).

### 2.7 Confirmation path — UNCHANGED endpoint, provenance threading (FR-4 / FR-6 / §3)

`POST /api/grants` is **not modified for authority logic**. The UI confirm handler threads the
agent UUID into the request; the server records it as `proposed_by` provenance only (see §3 for why
this is R-AUTH-safe and what, if anything, the coder must change in `grants.ts`).

---

## 3. The crux: `proposed_by` provenance vs R-AUTH approver identity

**Observed tension.** The spec (AC-03/AC-04/AC-15) requires the confirmed grant to carry
`proposed_by = <agent-employee-UUID>`. But the *current* `POST /api/grants` (T-0044 rev-2 R-AUTH)
**deliberately ignores `b["proposed_by"]`/`b["confirmed_by"]`** and derives both from the
authenticated actor — the comment at `grants.ts:511-515` calls the body-assertion a closed
vulnerability ("the proposer could name their own confirmer"). Naively re-opening the body field
would re-introduce that hole.

**Resolution (design invariant D-1).** Split the two meanings that were conflated:

| Field | Meaning | Source | Authority effect |
|---|---|---|---|
| `confirmed_by`, `confirmed2_by` | dual-control **approver identity** | authenticated actor ONLY (R-AUTH) | gates the change; an approver MUST hold covering `mgmt_object:grant` |
| `proposed_by` | **provenance stamp** — "who suggested this" | request body (agent-employee UUID from the proposal response) | **NONE** — naming an agent confers no capability; the gate still fires on the authenticated `confirmed_by` |

`proposed_by` is **informational**, exactly like `granted_by` already is in the body. An attacker
who forges `proposed_by` gains nothing: the grant is still gated on the *authenticated* confirmer
(`validateAdminDelegation` over the actor), and `confirmed_by` is still never taken from the body.
So D-1 records the agent UUID for audit/provenance **without** weakening R-AUTH.

**What the coder changes in `grants.ts` (minimal, additive):** in the **routine (non-escalating)
INSERT** path the code currently hardcodes `proposed_by = null` (`grants.ts:612`). Change that
single bind to `proposed_by = parseProvenance(b["proposed_by"]) ?? null` where `parseProvenance`
returns the value **only if it is a valid UUID** (reuse `UUID_RE`), else `null`. `confirmed_by`
stays `actorId` (R-AUTH, untouched). The escalating path already binds `proposed_by = actorId`; for
an LLM-proposed escalating grant the agent UUID is the more accurate provenance, but to stay within
T-0044's two-approver R-AUTH model day-1 the escalating path keeps `proposed_by = actorId`
(provenance of the *first human approver*) — LLM-proposed grants that escalate criticality are an
acceptable day-1 narrowing (spec §4 marks E3.5 "lower priority"; multi-approver-with-agent-provenance
is deferred). **No change to `validateAdminDelegation`, no change to `scoped-admin.ts` (NF-6).**

The `GrantAuditEvent` already carries optional `proposedBy?` (`grant-lattice.ts`); the routine path
passes the same parsed UUID into `writeGrantAuditEvent` so AC-04 holds (audit row mirrors the grant
row). This is an additive field on an existing call — no encoder change.

---

## 4. AC-05 — no grant active without `confirmed_by` (the resolver predicate)

`grant_resolver` (`resolveFor`) is pure and takes `coveringGrants` as input — it has no DB query to
filter. AC-05 therefore binds to the **active-grant load DAO**: the query that materializes
`coveringGrants` for the PDP (T-0053-deferred) and the `loadRoleEffectiveGrants` reader in
`grants.ts` MUST carry `AND confirmed_by IS NOT NULL` so a proposed-but-unconfirmed row (or a
semi-confirmed escalating row, which already has `confirmed2_by IS NULL`) yields zero capability.

Design contract **D-2:** every SQL that loads grants **as active/effective** filters
`confirmed_by IS NOT NULL`. T-0039 adds this predicate to `loadRoleEffectiveGrants` (the only live
grant reader today) and writes a fitness grep that any current/future active-grant load query in
`src/` includes the predicate. The semi-confirmed escalation gate (`confirmed2_by IS NOT NULL` for
escalating rows) is T-0044's existing invariant and out of scope to re-litigate here — D-2 covers
the **proposal**-inactivity case the spec names.

---

## 5. UI changes (FR / AC-14 / AC-15)

`web/src/screens/rights/ra-role-editor.jsx`:

1. **Delete** the `LLM_PROPOSALS` constant (lines 33–37) — AC-14 (fitness grep returns zero).
2. `propose()` becomes `async`: `fetch('/api/grants/propose', { method:'POST', headers:{...x-dev-user},
   body: JSON.stringify({ text: llmText, role_id: EDITOR_ROLE_ID }) })`; on 200, set `proposed` from
   `data.proposed` (mapping `ScopeElement` atoms back to the UI grant shape via the inverse of
   `nodeToScope`), and store `data.proposal_agent_id` in state. On 503 show "BYO-агент не настроен".
3. `confirmProposed(i)` sends `proposed_by: proposalAgentId` (the UUID from the response envelope)
   instead of the literal `"llm"` (AC-15). `confirmed_by` is dropped from the body (the server
   derives it from the authenticated actor — the current body `confirmed_by` is ignored anyway;
   removing it documents D-1). `granted_by` stays the acting human.

The proposal panel's static reason/heavy/name fields become optional (`reason` is the spec's optional
atom field; `name`/`heavy` are UI-derived from the resource dictionary, not from the LLM).

---

## 6. Public-surface compatibility (refactor-compat pattern)

T-0039 adds exports; it removes none. Importer audit (grep `from ".*http/grants"` + `parseScopeElement`):

| Symbol | Importers today | T-0039 action |
|---|---|---|
| `registerGrantsRoutes` | `src/server.ts` | unchanged |
| `registerDictionariesRoute` | `src/server.ts` (frozen order, `grant-editor-isolation.sh` FF-R1b) | unchanged |
| `parseScopeElement` | (exported, used internally) — new importer: `src/http/grant-propose.ts` | **kept** (compatibility contract — grant-propose imports it; do not inline a copy) |

New export `registerGrantProposeRoute` (additive). `grants.ts` structural invariants asserted by
`grant-editor-isolation.sh` (FF-R1a/b/c, FF-R2, FF-R4) MUST stay green — the §3 routine-path bind
change is a one-line value edit inside the existing INSERT, touching none of those asserted
structures. Frozen `scoped-admin-isolation.sh` (FF-11: `scoped-admin.ts` byte-unchanged) stays green
(NF-6 — file untouched).

---

## 7. Object model / contracts

See `T-0039.adr.contract.json` `object_model` + `contracts`. No new table, no migration (proposals
ephemeral — spec §4). The only schema touch surface is `loadRoleEffectiveGrants`'s WHERE clause (D-2).

---

## 8. Fitness functions

See contract `fitness_functions` (FF-39-1 … FF-39-8). Highlights: FF-39-2 (no LLM key/SDK in `src/`,
AC-07), FF-39-3 (`LLM_PROPOSALS` gone, AC-14), FF-39-4 (`confirmed_by IS NOT NULL` on active-grant
load, AC-05), FF-39-5 (no new grant table / no new scope algebra — `grant-propose.ts` imports
`parseScopeElement`, defines no `ScopeElement` kind), FF-39-6 (`scoped-admin.ts` byte-unchanged),
FF-39-8 (secret-handle never in logs/response/audit, static-grep guard for AC-13).

---

## 9. Runtime target

`runtime_target = контейнер` — Choros dev stack on `/srv/choros` (homeserver-vm, T-0065). The
proposal endpoint makes an **outbound** HTTP call to a *client-hosted* BYO LLM endpoint; the platform
requests **no new external resource and no platform LLM credential** (NF-1). No GT-4 provision. The
BYO endpoint is configured per-tenant in `agent_card` by the client, not provisioned by the platform.

---

## 10. Escalation

**None.** D-1 (provenance-vs-authority split) and D-2 (active-load predicate) are local
architectural calls fully determined by the signed model (BYO-only RL-3 posture, T-0044 R-AUTH,
T-0021 PDP purity). They do not alter product direction or cross a vendor boundary. The parallel
E5.5 (T-0025 secret custody) is honored as an **injected port** (`resolveSecret`), so there is no
conflict to escalate — T-0039 depends on the port's contract, not its implementation.
