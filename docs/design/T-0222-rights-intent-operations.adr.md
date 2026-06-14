# ADR · T-0222 — Everyday Rights as Intent Operations (intent → preset → grants)

**Status:** ready (one founder-confirmable open question, §10 / D.5 — non-blocking)
**Phase:** DESIGN (documentation; no production code)
**Date:** 2026-06-14
**Task:** D-1 — «Бытовые кейсы прав как intent-операции» — design the four everyday rights actions (hire / fire / substitute / urgent-revoke) as first-class **intent operations** layered over presets.
**Spec:** Section D of the `v1-demo-and-trust-surface` playbook (D.1–D.5), reproduced in the task brief.
**Foundation (consumed, NOT re-decided — every "под капотом / опора" claim is bound to a confirmed file):**
- `src/core/grant-lattice.ts` (T-0018) — `Grant`, `ScopeElement`, `AncestryOracle`, `GrantAuditEvent`, **`validateNarrowing(parent, child, oracle)`** (the write-time subset gate; confirmed at line 408), `isEffective`. **NOT modified.**
- `src/http/grants.ts` (T-0030 write-API + **T-0135 presets**) — **`DICT_PRESETS`** (10 day-1 presets, lines 420–560), `GrantPreset`/`GrantPresetAtom`, `POST /api/grants`, `POST /api/grants/:id/revoke`, `POST /api/role-assignments`, `withTenantTx` (grant INSERT + audit in ONE transaction), the dual-control gate (`dualControlDecision`). **NOT modified.**
- `src/core/substitution.ts` (T-0035) — `SubstitutionRule`, Tier-1 (routing, no mint) / Tier-2 (TTL'd grant, `delegable=false`), `isRuleEffective`, `eligibleForTier2`, `isNonInheritable`, `resolveSubstitution` (reuses `isNarrowerOrEqual` over hierarchy `org`). **NOT modified.**
- `src/http/pdp-explain.ts` + `POST /api/pdp/explain` (T-0136) — explain trace behind `mgmt_object:grant` (admin) or self-query, anti-oracle (no hidden-field leak). **NOT modified.**
- `src/core/actor-event.ts` + `src/core/lifecycle-guard.ts` (T-0019) — typed actor-event ledger (verbs `request|prepare|submit|approve|release`), the transition/lifecycle substrate. **NOT modified.**
- `src/core/agent-hire.ts` + `docs/design/T-0042-agent-provisioning.adr.md` (T-0042) — the **existing** "hire" precedent: `buildAgentHirePlan` creates `employee + role-assignment + agent_card` atomically behind `validateAdminDelegation`. **NOT modified.**
- `src/db/org.ts` + `docs/design/T-0017-org-structure.adr.md` (T-0017) — `employee(kind∈{human,agent})`, `department` tree, `position`. **NOT modified.**
- `src/core/grant-resolver.ts` (T-0021) — read-path PDP, `isEffective`-gated, fail-closed `no_grant`. **NOT modified.**
**Downstream consumers (build ON this ADR, NOT here):** T-0223 (D-2 — the intent UI), T-0224 (D-3 — seed preset-role set).

---

## 1. Context

Choros already has a complete, ratified rights kernel — a closed grant lattice (T-0018), a structural grant write-API (T-0030), grant presets (T-0135), substitutions (T-0035), explain-PDP (T-0136), and an agent-hire path (T-0042). But for a **self-delivered** product the kernel is the wrong altitude for a non-technical admin. The spec (D.1) names the trap directly: «Решётка скоупов требует мат-мышления … админ не должен собирать гранты вручную». A grant editor that asks an admin to assemble `resource_type × operation × scope` tuples kills adoption.

The four everyday things an admin actually wants to do are **nouns of intent**, not lattice edits:
1. **Нанять** — "add Pyotr as an analyst".
2. **Уволить** — "switch off this employee".
3. **Подмена** — "let Petya cover the financial-controller until the 20th".
4. **Срочно отозвать** — "take right X away from this agent/person now".

This ADR pins those four as **first-class intent operations** layered over the existing kernel. The load-bearing decision (D.2): **the admin expresses intent; the system expands it into grants via presets — never the reverse.** A preset is the *distribution of a competence*; grants are its mechanical residue. The admin never sees a lattice.

This is a **design-only** ADR. Every mechanism binds to a primitive that already exists in `dev` (§ Foundation, each file confirmed by read). No new authority subsystem, no new lattice algebra, no new audit path. The deliverable is a contract the impl (T-0223 UI, T-0224 seed presets) can build against without re-deciding architecture.

---

## 2. Decision

**Adopt four named intent operations — `hire`, `fire`, `substitute`, `urgent-revoke` — as a thin orchestration layer over the existing rights kernel. Each intent is expressed by the admin as a single high-level action; the system deterministically expands it into the underlying primitive calls. No intent operation ever writes a grant except by issuing (or revoking) the grant atoms of a *preset* (T-0135 `DICT_PRESETS`) or a *substituted subset* (T-0035); no intent operation exposes the grant lattice to the admin. The four operations reuse, verbatim and unmodified: the grant write-API + presets (`src/http/grants.ts`, T-0030/T-0135), the write-time subset gate (`validateNarrowing`, `src/core/grant-lattice.ts`, T-0018), the substitution model (`src/core/substitution.ts`, T-0035), the explain trace behind a management grant (`src/http/pdp-explain.ts`, T-0136), the actor-event/lifecycle transitions (`src/core/actor-event.ts` + `lifecycle-guard.ts`, T-0019), the agent/human provisioning path (`src/core/agent-hire.ts`, T-0042), and the single canonical audit sink (`appendAuditEvent` via `writeGrantAuditEvent`/`writeAssignmentAuditEvent`, T-0068/T-0031). Each intent operation emits a tamper-evident audit event (who/whom/when/why) through that one sink. The four load-bearing invariants of D.3 (intent→preset→grants; substitution ⊆ substituted via `validateNarrowing`; explain behind a mgmt-grant with no hidden-field leak; audit-per-action) are the acceptance floor the impl MUST satisfy.**

The mechanism is **proportional**: an intent operation is a *named composition* of calls the kernel already exposes. It introduces no new table, no new column, no new resolver branch, no new lattice element kind. The novelty is entirely at the **interaction/orchestration layer** — the admin's vocabulary and the deterministic expansion — not at the authority layer.

### 2.1 The intent → preset → grants pipeline (the crux)

```
ADMIN INTENT            EXPANSION (deterministic, server-known)         PRIMITIVE WRITES
───────────────────────────────────────────────────────────────────────────────────────
"hire Pyotr as          1. create/resolve employee (T-0017/T-0042)      employee row
 financial-controller"  2. role-assignment to the position's role       role_assignment row
                        3. ISSUE preset grant atoms (DICT_PRESETS)       N × grant rows
                                                                         + audit events (one tx)
```

The admin picks a **preset-role** (a named bundle — `DICT_PRESETS[i]`), never individual atoms. The expansion from preset → grant atoms is the *existing* T-0135 client-side expansion (`GrantPreset.grants[]` → `POST /api/grants` per atom; `src/http/grants.ts` lines 408–560 + the `AC-18 — no preset table, client-side expansion only` note). The intent layer adds only the **role-assignment + employee-provisioning** wrapper around that expansion, which is exactly what T-0042's `buildAgentHirePlan` already does for agents (`src/core/agent-hire.ts`). D-1 generalizes that pattern to humans and names it `hire`.

---

## 3. The four intent operations

For each: the **intent** the admin expresses → the **mechanism** it expands to → the **primitive(s)** it binds to (confirmed file:line).

### 3.1 `hire` — "add an employee → position"

| | |
|---|---|
| **Intent** | "Принять Петра аналитиком" — admin names a person (or agent) and a **position/preset-role**; expresses no grants. |
| **Mechanism** | (1) create/resolve `employee` (`kind='human'` or `'agent'`); (2) attach a `role_assignment` binding the employee to the position's role within the admin's org-scope; (3) **issue the preset's grant atoms** (`DICT_PRESETS[preset].grants[]`) onto that role via the existing per-atom `POST /api/grants`. All writes land in the kernel's `withTenantTx` so each grant + its audit event are one transaction. |
| **Primitive(s)** | **T-0135 presets** — `DICT_PRESETS`, `GrantPreset.grants[]`, `src/http/grants.ts:420`. **T-0042 hire precedent** — `buildAgentHirePlan` (employee + role-assignment + agent_card atomically behind `validateAdminDelegation`), `src/core/agent-hire.ts:126`. **T-0017 org** — `employee`/`position`, `src/db/org.ts`. **T-0030 write-API** — `POST /api/role-assignments` + `POST /api/grants`, `src/http/grants.ts:588,927`. |
| **Invariant binding** | D.3-1: grants reach the role **only** as a preset bundle; the admin never POSTs a hand-built atom. D.3-2 (subset): every issued atom still passes `validateAdminDelegation`/`validateNarrowing` against the admin's own delegable grant (the kernel already enforces this on every `POST /api/grants`). D.3-4: each atom-issue + the role-assignment emit `grant.create` / `assignment.create` audit events (already wired, `writeGrantAuditEvent`/`writeAssignmentAuditEvent`). |
| **Critical-preset note** | A preset flagged `critical: true` (`p-treasury-exec`, `p-pay-init-limited`, `p-refund-operator`) routes through the **existing dual-control gate** (`dualControlDecision`, `src/http/grants.ts:734`) per atom — the intent layer does NOT bypass it; a critical hire may land semi-confirmed pending a second approver. |

### 3.2 `fire` — "switch off an employee" (atomic revoke + active-task reassignment)

| | |
|---|---|
| **Intent** | "Отключить сотрудника" — admin names a person/agent; expresses no per-grant detail. |
| **Mechanism** | **All of the principal's authority is removed atomically**, and **active work is handled** (reassigned or interrupted): (1) revoke every `role_assignment` of the employee (`POST /api/role-assignments/:id/revoke` → `UPDATE valid_until = now` + audit, in `withTenantTx`); revoking the assignment removes the employee's reach to the role's grants on the read-path (the PDP only resolves grants of *assigned* roles). (2) For grants minted directly onto a role the employee solely held (e.g. a Tier-2 substitution grant), revoke those rows too (same `UPDATE valid_until = now` path). (3) For **active tasks** owned by the employee, drive a lifecycle transition: reassign (route to a pool holder via the substitution/routing layer) or interrupt (a guarded transition recorded in the actor-event ledger). |
| **Primitive(s)** | **T-0030 revoke** — `POST /api/grants/:id/revoke` (`UPDATE valid_until` + audit, one tx), `src/http/grants.ts:871`; `POST /api/role-assignments/:id/revoke`, `src/http/grants.ts:1083`. **T-0018 TTL=removal** — `isEffective(grant, now)` returns false once `valid_until ≤ now`, so a revoked grant confers **zero** capability on the read-path (`src/core/grant-lattice.ts`; T-0021 resolver `no_grant`). **T-0019 transitions** — `actor-event.ts` verb ledger + `lifecycle-guard.ts` for the active-task reassign/interrupt transition. **T-0035 routing** — `resolveSubstitution` selects a pool stand-in for reassignment, `src/core/substitution.ts:179`. |
| **Atomicity semantics** | **Per-principal atomicity is required (FF-FIRE-2):** all of the employee's assignment + sole-grant revokes execute as **one logical unit** — either all `valid_until` rows are stamped or none. The kernel's revoke is already a single `withTenantTx` per row; D-1 mandates the impl (T-0223) wrap the *set* of revokes for one fire intent in a **single transaction** (one `withTenantTx` enclosing the loop) so a partial-fire cannot leave a principal with residual authority. Active-task reassignment/interrupt is a **lifecycle transition recorded after** the revoke commits (T-0019), not inside the revoke tx — a re-routed task is a forward action, not part of the authority-removal atom; the ordering is **revoke-then-reassign** so no task executes under stale authority. |
| **Invariant binding** | D.3-1: no lattice editing — fire is pure revoke. D.3-4: every revoke emits a `grant.revoke`/`assignment.revoke` audit event; the reassign/interrupt emits an actor-event. |

### 3.3 `substitute` — "let X cover Y until date" (delegated subset, auto-expiry)

| | |
|---|---|
| **Intent** | "Пусть Петя замещает финконтролёра до 20-го" — admin names substitute, absentee, role, and an end date. |
| **Mechanism** | A `substitution_rule` (T-0035) is declared. **Tier-1 (default, zero-mint):** if a pool holder already holds the stand-in role in scope, the routing layer reassigns; **no grant is minted** (`ttl_grant_id IS NULL`); the stand-in acts under their own existing authority. **Tier-2 (fallback):** when there is no pool holder, a **TTL'd delegation grant** is minted — `valid_from=now`, `valid_until=<end date>`, `delegable=false`, `granted_by='substitution:<rule_id>'` — over a **subset** of the substituted role's grants. Auto-expiry needs **zero new code**: `isEffective(grant, now)` denies once `valid_until` passes (T-0035 ADR §2.2). |
| **Primitive(s)** | **T-0035 substitution** — `SubstitutionRule`, Tier-1/Tier-2, `eligibleForTier2(rule, roleGrants)` (the mint-site subset filter, drops `isNonInheritable` grants), `src/core/substitution.ts:233`. **T-0018 subset gate** — Tier-2 mint passes `validateNarrowing(parentGrant, ttlChildGrant, oracle)` so the delegated grant is structurally ⊑ the substituted grant, `src/core/grant-lattice.ts:408`; org-scope containment via `resolveSubstitution`→`isNarrowerOrEqual`. **T-0018 auto-expiry** — `isEffective`, `src/core/grant-lattice.ts`. |
| **Invariant binding** | **D.3-2 (the structural heart): a substitution can never be broader than the substituted principal.** Tier-2's minted grant is subset-checked at write-time by `validateNarrowing` against the substituted role's grant as parent — a widening substitution is **rejected before persistence**, not audited-after. `delegable=false` blocks re-delegation of the loaned authority. D.3-4: the rule declaration (proposal→confirm) and any Tier-2 mint emit audit events. |

### 3.4 `urgent-revoke` — "take right X away now" (immediate revoke + agent-step-stop)

| | |
|---|---|
| **Intent** | "Убрать у агента/человека право X сейчас" — admin names a principal and a specific capability (a single grant or a preset's worth). |
| **Mechanism** | The targeted grant(s) are revoked **immediately** — `POST /api/grants/:id/revoke` stamps `valid_until = now`. Because the read-path resolver gates **every** decision on `isEffective(grant, now)`, the capability is gone on the **next** PDP evaluation — there is no cache to invalidate, no propagation delay; revocation-removes-capability is a single code path (T-0018 §4.5). **For an AGENT principal specifically:** the revoke MUST also **stop the agent's active steps** — an agent step about to invoke under the revoked right must **fail closed**. This binds to the resolver's fail-closed posture: once the grant is non-effective, the gateway returns `no_grant` / `no_effect_grant` and the step is denied (`src/core/grant-resolver.ts` — `fail-closed`, `no_grant`, `no_effect_grant` at lines 510/565/655). |
| **Primitive(s)** | **T-0030 revoke** — `POST /api/grants/:id/revoke`, `src/http/grants.ts:871`. **PDP fail-closed** — `resolveFor` denies on non-effective grant, `src/core/grant-resolver.ts:549,564`. **T-0019** — the agent-step interrupt is recorded as an actor-event/lifecycle transition. **Audit** — `grant.revoke` event, `src/http/grants.ts:907`. |
| **Agent-step-stop semantics** | An agent run is a sequence of gateway-gated steps; **each step re-resolves authority** (the PDP is the chokepoint, not a once-per-run grant snapshot). Therefore an immediate revoke takes effect at the **next step boundary**: any in-flight step that re-checks the revoked grant gets `no_grant`/`no_effect_grant` and **must abort the step (fail closed)** rather than proceed. The intent layer's obligation (FF-REVOKE-3) is that an `urgent-revoke` against an agent does NOT merely stamp `valid_until` and walk away — it also **signals the agent's active run to halt** so no further step is dispatched under the just-removed right. **Cross-link (forward-looking):** the precise halt signal for an in-flight agent step is the territory of T-0220's agent-outcome model (the agent run lifecycle / outcome ledger). T-0220's ADR is **not yet present** in `docs/design/` at the time of writing (confirmed by `ls` — only `T-0020`/`T-0042`/`T-0077`/`T-0134` agent ADRs exist). D-1 therefore fixes the **fail-closed contract** (next-step-boundary denial via the existing resolver) as the floor, and flags the **active-step halt signal** as a seam to be tightened when T-0220 lands — without re-opening this ADR. |

---

## 4. The four load-bearing invariants (D.3)

These are the **acceptance floor**. The impl (T-0223/T-0224) MUST satisfy all four; any intent operation that violates one is wrong by construction.

| # | Invariant | Binding mechanism (confirmed primitive) | Enforced where |
|---|---|---|---|
| **I-1** | **Intent → preset → grants, never a manual lattice edit.** A preset = distribution of a competence. | `DICT_PRESETS` + client-side atom expansion (T-0135, `src/http/grants.ts:420`); no preset table — expansion is the contract. | The intent layer (T-0223) issues grants ONLY by expanding a `GrantPreset`; the admin UI exposes **no** raw atom editor. |
| **I-2** | **Substitution ⊆ substituted.** A temporary access is structurally never broader than the substituted principal's rights. | `validateNarrowing(parent, child, oracle)` (T-0018, `src/core/grant-lattice.ts:408`) + `eligibleForTier2` subset filter (T-0035, `src/core/substitution.ts:233`); `delegable=false` on the Tier-2 mint. | Write-time, pre-persistence: a widening Tier-2 grant returns `scope_widens`/`facet_widens`/`constraint_widens` and never lands. |
| **I-3** | **"Why doesn't Вася see X" = explain-PDP, behind a mgmt-grant, no hidden-field leak.** | `POST /api/pdp/explain` (T-0136, `src/http/pdp-explain.ts`); caller is either the subject (self-query) or an admin holding a delegable `mgmt_object:grant` (read); anti-oracle 403 otherwise; `drop`-mask field names never surfaced even on self-query. | The explain trace is embedded in the employee card (T-0223 UI), gated by `loadAdminContext` + `validateAdminDelegation`. |
| **I-4** | **Every intent action is a tamper-evident audit event (who/whom/when/why).** | One canonical sink — `appendAuditEvent` via `writeGrantAuditEvent`/`writeAssignmentAuditEvent` (T-0031/T-0068); `GrantAuditEvent` carries `actor`, `subjectRoleId`, `capability`, `scope`, `proposedBy?`, `confirmedBy?` (T-0018 §4.6). | Inside the same `withTenantTx` as the grant/assignment write — no parallel audit path (NF-7). Every hire/fire/substitute/revoke folds to ≥1 audit event. |

---

## 5. Rejected alternatives

| Option | Why not |
|---|---|
| **A manual grant-lattice editor as the everyday surface** | The exact trap D.1 names. Forces the admin into `resource_type × operation × scope` math; kills adoption for a self-delivered product. Presets already exist (T-0135) — D-1 layers intents over them, it does not expose the lattice. |
| **A new `intent_operation` table / new authority subsystem** | Two sources of truth for "who may do what"; they drift. Intents are a *composition* of existing kernel calls, not a new store. The kernel (grant + role_assignment + substitution_rule) is the single truth; D-1 adds vocabulary, not tables (mirrors T-0035's discipline). |
| **A new preset *registry table* the intent layer reads from** | T-0135 deliberately keeps presets as **client-side-expanded constants** (`DICT_PRESETS`, `AC-18 — no preset table`). A DB preset table would re-open a ratified decision for zero gain; the intent layer consumes the same constants. |
| **`fire` = soft-flag the employee, leave grants live** | Leaves residual authority — the principal can still act through still-effective grants. Fire MUST remove **all** authority atomically (I-4 / §3.2); the read-path only goes silent once `valid_until ≤ now`. A flag the resolver doesn't read is a silent leak. |
| **`substitute` mints a fresh broad grant for the stand-in** | Breaks I-2 — a hand-built substitution grant could be **wider** than the substituted role. T-0035's Tier-2 mint is subset-checked by `validateNarrowing` against the substituted grant as parent; a fresh unconstrained mint bypasses that gate. |
| **`urgent-revoke` for an agent = stamp `valid_until` and trust the next run to pick it up** | An in-flight agent run mid-step could complete a step under the just-removed right if the run snapshotted authority. The contract (FF-REVOKE-3) requires the resolver to deny at the **next step boundary** (fail-closed) AND the intent layer to signal the active run to halt — not silent stamp-and-walk. |
| **Embed explain for any caller (no mgmt-grant gate)** | Turns explain into an oracle: a non-admin could enumerate another subject's rights / discover hidden fields. T-0136's gate (subject-self OR `mgmt_object:grant`) + anti-oracle 403 is the floor; I-3 keeps it. |
| **A separate audit channel for intent operations** | Two preimage rules / two chains → a verifier false-positives tamper on a mixed chain (the exact T-0030→T-0068 lesson, `src/http/grants.ts:189`). One sink, one chain. |

None re-opens a founder-ratified product decision; these are the standard alternatives, recorded so the choice is auditable.

---

## 6. Object model

**No new entity.** D-1 introduces **zero** new tables and **zero** new columns. The four intent operations are compositions over the existing object model:

| Intent | Reads | Writes (all via existing write-API, all audited) |
|---|---|---|
| `hire` | `DICT_PRESETS`, `employee`, `position`, admin context | `employee` (if new), `role_assignment`, N × `grant` (preset atoms) |
| `fire` | employee's `role_assignment` rows, sole-held `grant` rows, active tasks | `UPDATE grant.valid_until=now`, `UPDATE role_assignment.valid_until=now`, actor-event transitions |
| `substitute` | substituted role's grants, pool holders, admin context | `substitution_rule` (proposal→confirm), optional Tier-2 `grant` (subset, TTL, `delegable=false`) |
| `urgent-revoke` | target `grant` row, principal kind | `UPDATE grant.valid_until=now` + (agent) active-run halt signal |

The intent layer is **orchestration only**: it sequences calls the kernel already exposes. This is the proportionality property — the riskiest surface (authority) is untouched; the new surface (admin vocabulary) holds no authority.

---

## 7. Acceptance / fitness criteria (the downstream contract)

These encode the §4 invariants as executable rules the impl (T-0223 UI, T-0224 seed presets) MUST satisfy. They are the binding hand-off.

| FF | Rule | Maps invariant | How the impl encodes it |
|---|---|---|---|
| **FF-HIRE-1** | A `hire` writes grants **only** by expanding a `GrantPreset` from `DICT_PRESETS` — never a hand-built atom. | I-1 | Lint/test: every grant POST originating from a hire carries a `preset_id` provenance and its `(resource_type, operation, scope_org/own, constraint)` matches a `DICT_PRESETS[preset].grants[]` atom; no atom outside a preset. |
| **FF-INTENT-2** | **No intent op writes a grant except via a preset (or a T-0035 substituted subset).** | I-1, I-2 | The intent layer exposes no raw-atom authoring path; the admin UI has no lattice editor. Asserted by: the only grant-issuing call sites in the intent layer reference a preset or `eligibleForTier2`. |
| **FF-SUB-3** | **A substitution can never be broader than the substituted principal.** | I-2 | Property test: for any substituted role R and any Tier-2 mint M, `validateNarrowing(parentGrant∈R, M, oracle).ok === true`; a constructed widening M (scope-superset / facet-widen / constraint-widen) is rejected with the matching typed reason and **never persisted**. `delegable=false` on M. |
| **FF-FIRE-2** | **Fire is per-principal atomic + revoke-then-reassign.** | §3.2, I-4 | Test: after a fire, the principal has **zero** effective grants and **zero** active role-assignments (`isEffective`/assignment window all false); a partial failure rolls back the whole revoke set (single `withTenantTx` over the revoke loop); no active task executes a step under stale authority (reassign/interrupt strictly after revoke commit). |
| **FF-REVOKE-3** | **Urgent-revoke is immediate; for an agent it stops active steps (fail closed).** | §3.4 | Test: immediately after revoke, `resolveFor` for the revoked capability returns `no_grant`/`no_effect_grant` (no cache); for an agent principal, the active run receives a halt signal and **no subsequent step** is dispatched under the removed right. |
| **FF-EXPLAIN-4** | **Explain is embedded behind a mgmt-grant with no hidden-field leak.** | I-3 | Test: the employee-card explain call goes through `POST /api/pdp/explain`; a non-admin caller about another subject gets 403 (anti-oracle); `drop`-masked field names never appear in a self-query response. |
| **FF-AUDIT-5** | **Every intent op emits ≥1 tamper-evident audit event (who/whom/when/why) via the single sink.** | I-4 | Test: each of hire/fire/substitute/urgent-revoke produces audit event(s) carrying `actor` (who), `subjectRoleId`/employee (whom), event timestamp (when), and intent/preset provenance (why); all through `appendAuditEvent` — no parallel path. |
| **FF-CRITICAL-6** | **A `critical: true` preset routes through the existing dual-control gate.** | §3.1 | Test: hiring into a critical preset (`p-treasury-exec` / `p-pay-init-limited` / `p-refund-operator`) where the criticality fold escalates lands the grant **semi-confirmed** pending a distinct second approver (`dualControlDecision`), not auto-active. |

**Static vs DB:** FF-SUB-3 (subset gate over `validateNarrowing`) and FF-INTENT-2 are **static-now** pure-TS property tests. FF-FIRE-2, FF-REVOKE-3, FF-EXPLAIN-4, FF-AUDIT-5, FF-CRITICAL-6 exercise the live write-API/PDP and run against the Postgres dev stack (the same env as the T-0030/T-0035/T-0136 suites already do).

---

## 8. Consequences

**Positive.**
- **Adoption-grade surface without a new authority subsystem.** The admin speaks intents; the kernel stays the single source of truth. Zero new tables/columns.
- **The hard safety property is already structural.** Substitution ⊆ substituted is enforced by `validateNarrowing` at write-time (I-2) — a widening substitution cannot exist, it is not merely audited.
- **Revocation is instant and cache-free.** `isEffective`-gating means an urgent-revoke takes effect on the next PDP evaluation — no invalidation dance.
- **One audit chain.** Every intent folds to events on the single canonical sink; the trail is queryable and tamper-evident (I-4).
- **The impl re-decides nothing.** T-0223/T-0224 build UI + seed data against a contract that binds every mechanism to an existing, confirmed primitive.

**Negative / accepted costs.**
- **The active-step halt signal for `urgent-revoke` on an agent is a seam, not a closed door.** D-1 fixes the next-step-boundary fail-closed contract; the in-flight halt signal sharpens when T-0220's agent-outcome model lands (§3.4). Flagged, not hand-waved.
- **`fire` atomicity over a *set* of revokes** requires the impl to enclose the revoke loop in one transaction; the kernel's per-row `withTenantTx` is per-row, so this is an impl obligation (FF-FIRE-2), not free.
- **Preset coverage is finite.** The 10 `DICT_PRESETS` cover the seed-demo domain; an org needing a competence outside them needs a new preset constant (T-0135 territory), not a lattice edit. The seed-role-set question is §10.

---

## 9. Non-goals (hard boundaries — MUST NOT be built under T-0222)

1. **The intent UI itself** — T-0223 (D-2). This ADR fixes the contract; the React surface lands there.
2. **The seed preset-role set as data** — T-0224 (D-3). §10 surfaces the question; the seed constants land there.
3. **Any new grant lattice algebra / new `ScopeElement` kind** — `src/core/grant-lattice.ts` is frozen for D-1.
4. **Any new authority table / preset registry table** — presets stay client-side-expanded constants (T-0135 AC-18).
5. **The agent-outcome / agent-run-halt model** — T-0220. D-1 binds to the resolver's fail-closed floor only.
6. **The routing engine that reassigns a fired/substituted task** — orchestrator-layer; D-1 fixes the revoke-then-reassign ordering and the actor-event recording, not the router.
7. **Changes to the dual-control or explain mechanisms** — reused verbatim (T-0044 / T-0136).

---

## 10. Open question to the founder (D.5 — founder-confirmable, non-blocking)

**The seed preset-role set for the demo.** Section D.5 asks for the minimum set of position-presets for the seed-demo: at minimum **Инициатор / Руководитель / Финконтролёр / Админ**.

The codebase already ships **10** day-1 presets in `DICT_PRESETS` (`src/http/grants.ts:420–560`), keyed to the reference-process roles (budget-approver, treasury-exec, audit-observer, contract-initiator, contract-approver, support-L1, escalation-receiver, recon-accountant, pay-init-limited, refund-operator). These map **onto** the D.5 four but do not name them 1:1 (e.g. "Инициатор" ≈ `p-contract-initiator`; "Финконтролёр" ≈ `p-budget-approver`/`p-recon-accountant`; "Руководитель" and "Админ" have **no** exact preset — "Админ" is a `mgmt_object:*` holder, structurally distinct from a competence preset).

**This ADR does NOT decide the set unilaterally.** It surfaces the question for T-0224 (D-3) and the founder:
- Confirm the **demo-minimum four** (Инициатор / Руководитель / Финконтролёр / Админ) as the seed preset-roles, OR ratify the existing 10 `DICT_PRESETS` as the seed and map the four onto them.
- "Админ" specifically is a **management-grant** holder (`mgmt_object:grant` etc.), not a resource-competence preset — the founder should confirm whether "Админ" is a hire-able preset-role or a separately-provisioned management assignment.

This is **non-blocking** for the design: the four intent operations bind to whatever preset set T-0224 seeds. The mechanism does not change with the set.

---

## 11. Traceability (invariant / intent → primitive)

| Anchor | Bound to (confirmed file) |
|---|---|
| I-1 intent→preset→grants | `DICT_PRESETS`, `src/http/grants.ts:420` (T-0135) |
| I-2 substitution ⊆ substituted | `validateNarrowing`, `src/core/grant-lattice.ts:408` (T-0018) + `eligibleForTier2`, `src/core/substitution.ts:233` (T-0035) |
| I-3 explain behind mgmt-grant | `POST /api/pdp/explain`, `src/http/pdp-explain.ts` (T-0136) |
| I-4 audit-per-action | `writeGrantAuditEvent`/`appendAuditEvent`, `src/http/grants.ts:222` (T-0031/T-0068); `GrantAuditEvent`, `src/core/grant-lattice.ts` §4.6 (T-0018) |
| `hire` | `buildAgentHirePlan`, `src/core/agent-hire.ts:126` (T-0042); `POST /api/role-assignments`, `src/http/grants.ts:927`; `employee`/`position`, `src/db/org.ts` (T-0017) |
| `fire` | `POST /api/grants/:id/revoke` + `/role-assignments/:id/revoke`, `src/http/grants.ts:871,1083`; `isEffective` (T-0018); `actor-event.ts`/`lifecycle-guard.ts` (T-0019) |
| `substitute` | `SubstitutionRule`/`eligibleForTier2`/`resolveSubstitution`, `src/core/substitution.ts` (T-0035); `validateNarrowing` (T-0018) |
| `urgent-revoke` | `POST /api/grants/:id/revoke`, `src/http/grants.ts:871`; resolver fail-closed, `src/core/grant-resolver.ts:564` (T-0021); halt seam → T-0220 |

---

## 12. Runtime target

D-1 provisions **nothing** and changes **no** production code. The four intent operations run entirely over the existing kernel: the static subset-gate (`validateNarrowing`) runs locally in `npm run ci`; the live hire/fire/substitute/revoke paths run on the existing Postgres silo stack (founder home server `/srv/choros`, deploy founder-gated) — the same infra T-0030/T-0035/T-0136 already use. No new process, no new dependency, no new infra introduced by T-0222.
