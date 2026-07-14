# T-0209 / P-1 — DocsAuthorAgent seed (ADR addendum)

> **Status:** DESIGN (thin slot-pinning addendum). Parent ADR: `docs/design/T-0134-agent-docs.adr.md`
> (docs layer). Pipeline spec: `playbooks/research-3-docs-pipeline.md` §1.1 (DocsAuthorAgent row),
> §8 (P-1 row + critical path), §6 day-1, §7 R-5/R-7.
> **Scope:** ONE data-seed migration `062_docs_author_seed.sql` that materializes the system
> **DocsAuthorAgent** (employee + agent_card + role `docs-author` + role_assignment + grants on
> `doc_page` `{create,update}`). Pattern mirror: `migrations/044_config_agent_seed.sql` (T-0077
> config-agent) and `migrations/059_implementation_agent_seed.sql` (T-0207 impl-agent).
> This addendum exists so the coder is **mechanical** — every row, column value, and UUID is pinned.

---

## 1. Context

`playbooks/research-3-docs-pipeline.md` §1.1 names the **author** of the docs-wiki layer: a *system
employee* (pattern T-0077 config-agent) holding write authority on `doc_page`. T-0134 designed the
**frame** (`doc_page`/`doc_ref`/`doc_log` DDL = T-0134a, now landed as `migrations/061_doc_page.sql` +
T-0238/T-0239 in `dev`) but explicitly did **not** materialize the author (research §5 R-B). P-1 fills
exactly that seam and nothing more: it establishes the *principal + grants* so a later writeful tool
(P-2 = `doc_page_author`, NOT in scope here) becomes structurally reachable, and the REGEN/RECONCILE
procedures (P-3/P-4) have an authorized actor.

**Invariant carried from research §1.1:** the pipeline introduces **no new tables / no new authority
store / no new audit mechanism**. The author's write power = grant rows on `resource_type='doc_page'`
with `operation∈{create,update}` attached to a role `docs-author` — exactly the shape of config-agent's
`authoring_draft` grants, but on the `doc_page` resource_type. The external harness surface (docs-MCP
read-only, T-0122 / T-0134f/g) gets **read** grants on the same resource_type and is a *different role*;
P-1 touches none of it.

### Dependency state (verified on this branch, off `dev`)
- `doc_page`/`doc_ref`/`doc_log` tables exist (migration 061, T-0238) and are listed in
  `ci/checks/known_tenant_tables.txt` — **the seed adds no table**.
- Resolver `src/core/mcp-tool-registry.ts::isToolReachable` decides write-reachability: a tool with
  `resourceOps=[{doc_page,create},{doc_page,update}]` is reachable **iff** the agent's role has effective
  grants matching `resourceType='doc_page'` AND each of those operations (same-tenant, `isEffective`).
  Zero grants ⇒ zero tools (AC-12 structural). So the two grant rows below are *necessary and sufficient*
  to authorize a doc-author write tool and **nothing wider** (no `read`, no `delete`, no other resource_type).

---

## 2. The one real decision — "draft-first" resolved

Research §1.1/§8 says the author "writes draft, promote = seam (like `authoring_draft`→published)". But
`doc_page` (migration 061) has **no draft/published/status column** — only `stale boolean`,
`scope CHECK IN (system,tenant)`, `UNIQUE(tenant_id,slug)`.

**Resolution: P-1 is a PURE DATA SEED. No schema change. No new published-state mechanism is invented here.**

Rationale and precise operational meaning of "draft-first" for P-1:

1. **No status column is added.** Inventing `doc_page.status`/`published` here would be scope creep and
   would re-open a T-0134 framework decision. The promote/publish seam for docs is a **later framework
   piece**, not a P-1 concern. It is deferred to:
   - **SEAM-2 / T-0134d** (lint-runtime `broken`/`stale` + `doc_log` + `audit('docs.stale_detected')`) and
     the **hard-gate** explicitly parked as **P-9 `[design] hard-gate lint (SEAM-2)`** in research §8;
   - the UI/promote surface (T-0134e) and the RECONCILE draft-first prentation (research §6 day-1: "RECONCILE
     — draft-first") which live in **P-3/P-4**, downstream of P-1.
   The research itself confirms day-1 lint = *detector+signal*, hard-gate = SEAM-2 (Stage-2); there is no
   day-1 published-gate to encode in this seed.

2. **"draft-first" for P-1 = the shape of the grant set, not a column.** Concretely:
   - The role gets grants **only** `{doc_page, create}` and `{doc_page, update}` — **NO `delete`**, **NO
     publish-equivalent** (there is no such operation/resource_type to grant). This mirrors config-agent's
     `authoring_draft` create+update with zero `authoring_published` (`044` Step 6 / `053` / `059`
     DRAFT-boundary). The author can *write* page content but holds no authority that would correspond to
     "publish" — the absence is structural, exactly as the config-agent's published-boundary is.
   - The agent is **dormant**: `agent_card` LLM fields (`llm_endpoint`/`llm_model`/`llm_secret_handle`/
     `autonomy_threshold`) are `NULL`, identical to config-agent (`044` Step 3) and impl-agent (`059`
     Step 3). Runtime activation is a later increment (P-3 REGEN motor), not P-1.
   - Any "published/promote" gate is **explicitly out-of-scope-for-P-1 / deferred** (SEAM-2 / T-0134d / P-9).

3. **Why `delegable=false` and not `is_external`** (boundary, research §7 R-7):
   - `delegable=false` on every grant = the author cannot sub-delegate its write authority (structural
     DRAFT-boundary discipline of `044`/`053`/`059`).
   - The role is an **internal system author**. There is **no `is_external` column** anywhere in the schema
     or `src/` (verified: `grep -ri is_external` over `migrations/` and `src/` returns nothing). "Not
     is_external" therefore means: `docs-author` is an ordinary internal role of the *same shape* as
     config-agent/impl-agent — it is **NOT** the synthetic external-principal surface of T-0122/T-0134f.
     The external docs-MCP surface holds `{doc_page, read}` grants and is a *different role* this seed never
     creates or touches. Contrast is preserved by construction.

**Conclusion:** P-1 = role + employee + agent_card(dormant) + role_assignment + exactly 2 `doc_page` grants.
Zero DDL. The promote-seam is deferred to the docs framework (SEAM-2 / T-0134d / P-9), cited above.

---

## 3. Namespace reconciliation (next-free UUIDs)

`grep -rohiE` over `migrations/` for each namespace (dev-tenant `a0000000-…-000000000001` throughout):

| Namespace | Already taken (max) | Used by | **P-1 picks (next free)** |
|---|---|---|---|
| `e0…` role | `…003` (config-agent, 044), `…004` (impl-agent, 059); `…001/002` = owner/budget (019) | 019/044/059 | **`e0000000-0000-0000-0000-000000000005`** |
| `d0…` employee | `…014` (impl-agent, 059); `…001`–`…013` org/agents; `…0ff` sentinel | ≤059 | **`d0000000-0000-0000-0000-000000000015`** |
| `f0…` role_assignment | `…003` (impl-agent, 059); `…0ff` sentinel | ≤059 | **`f0000000-0000-0000-0000-000000000004`** |
| `e2…` grant | `…017` (template_def, **060**); `…008/009` (053), `…00a–015` (059) | ≤060 | **`e2000000-0000-0000-0000-000000000018`** (create), **`…000000000019`** (update) |

> Critical: the grant ceiling is **`e2…017`** (migration **060** `template_def`, not 059) — picking `…016`
> or `…017` would collide. Next free pair = `…018`, `…019`.
> `mcp_tool` namespace (`10…`, ceiling `…012` in 060) is **NOT consumed by P-1** — the writeful
> `doc_page_author` tool is **P-2**, a separate task. P-1 is role+grants only.

---

## 4. Exact migration plan — `migrations/062_docs_author_seed.sql`

Pure data seed. **FK order: role → employee → agent_card → role_assignment → grant.** Every INSERT
`ON CONFLICT DO NOTHING` (idempotent). No `CREATE TABLE`, no DDL. Header block mirrors `044`/`059` prose
(dev-tenant constants + design-discipline checklist).

### Step 1 — `role` (docs-author)
| column | value |
|---|---|
| tenant_id | `a0000000-0000-0000-0000-000000000001` |
| id | `e0000000-0000-0000-0000-000000000005` |
| slug | `docs-author` |
| display_name | `Docs Author Agent` |
| description | `System docs-author role — doc_page create/update boundary only (T-0209 P-1 / research-3-docs-pipeline §1.1)` |
| created_at, updated_at | `0, 0` |

### Step 2 — `employee` (kind='agent', position_id=NULL)
| column | value |
|---|---|
| tenant_id | `a0000000-0000-0000-0000-000000000001` |
| id | `d0000000-0000-0000-0000-000000000015` |
| position_id | `NULL` |
| kind | `agent` |
| slug | `docs-author-seed` |
| display_name | `Агент-документатор (seed)` |
| created_at, updated_at | `0, 0` |

### Step 3 — `agent_card` (dormant: LLM fields NULL)
| column | value |
|---|---|
| tenant_id | `a0000000-0000-0000-0000-000000000001` |
| employee_id | `d0000000-0000-0000-0000-000000000015` |
| employee_kind | `agent` |
| kc_client_id | `agent-docs-author` |
| llm_endpoint / llm_model / llm_secret_handle / autonomy_threshold | `NULL, NULL, NULL, NULL` |
| budget_policy_id | `b0000000-0000-0000-0000-000000000001` (existing instance_budget, migration 034) |
| escalation_rule_id | `NULL` |
| created_at, updated_at | `0, 0` |

### Step 4 — `role_assignment` (CONFIRMED)
| column | value |
|---|---|
| tenant_id | `a0000000-0000-0000-0000-000000000001` |
| id | `f0000000-0000-0000-0000-000000000004` |
| employee_id | `d0000000-0000-0000-0000-000000000015` |
| role_id | `e0000000-0000-0000-0000-000000000005` |
| org_scope | `{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}`::jsonb |
| valid_from / valid_until | `NULL, NULL` |
| source / granted_by / proposed_by / confirmed_by | `'seed', 'seed', NULL, 'seed'` |
| created_at, updated_at | `0, 0` |

> `confirmed_by='seed'` (NOT NULL) = CONFIRMED assignment (migration 020 contract: `confirmed_by IS NULL`
> = proposal → zero grants resolve). Identical to `044` Step 4 / `059` Step 4.

### Step 5 — `grant` × 2 (doc_page create + update)
Table `choros."grant"`, columns `(tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
"constraint", delegable, granted_by, valid_from, valid_until, created_at)`:

| id | resource_type | resource_facet | operation | scope | constraint | delegable | granted_by |
|---|---|---|---|---|---|---|---|
| `e2000000-0000-0000-0000-000000000018` | `doc_page` | `NULL` | `create` | fin-dept node (same jsonb as Step 4 org_scope) | `NULL` | `false` | `seed` |
| `e2000000-0000-0000-0000-000000000019` | `doc_page` | `NULL` | `update` | fin-dept node (same jsonb as Step 4 org_scope) | `NULL` | `false` | `seed` |

(`valid_from`/`valid_until`/`created_at` = `NULL, NULL, 0`, mirroring `044` Step 6.)

> `scope` is the **same fin-dept org node** as the role_assignment `org_scope` (`b0…001`,
> `nodeLevel:department`) — consistent with the resolver's scope-meet (config-agent/impl-agent precedent).
> `resource_type='doc_page'` is a **TEXT column** (no DB CHECK on grant.resource_type — same as
> `authoring_draft` in `044`); it matches `op.resourceType` in `isToolReachable` for a future
> `doc_page_author` tool whose `resource_ops=[{doc_page,create},{doc_page,update}]`.

---

## 5. Boundary invariants (reviewer-checkable)

1. Role `docs-author` (`e0…005`) exists in dev-tenant; slug = `docs-author`.
2. **NO grant with `delegable=true`** for this role (both grants `delegable=false`).
3. Role is **NOT** the external surface: it is an internal system role (no `is_external` column exists;
   role is not the T-0122 synthetic external principal; zero grants on any read-only-external surface).
4. Grants are **exactly two**: `{doc_page, create}` and `{doc_page, update}` — and **no others**.
5. **Zero `{doc_page, delete}`** grant (and zero any non-create/update operation on `doc_page`).
6. **Zero `{doc_page, read}`** grant for this role (read is the external docs-MCP surface's, T-0134g —
   a different role; the author needs only write).
7. `agent_card` for `d0…015` is dormant: all four LLM fields `NULL`; `budget_policy_id` references an
   existing `instance_budget`.
8. `role_assignment` is CONFIRMED (`confirmed_by` NOT NULL) so grants resolve.
9. Grant `scope` is consistent with `role_assignment.org_scope` (same `b0…001` fin-dept node).
10. Pure data seed: no `CREATE TABLE`; `ci/checks/known_tenant_tables.txt` unchanged.

---

## 6. Fitness / acceptance checklist (machine-checkable DoD)

Two artifacts, mirroring `config-agent-seed.sh` (static) + `db/config-agent-seed.test.ts` (live PG).

### 6a. Static guard — `ci/checks/docs-author-seed.sh`
- **Check-1:** `migrations/062_docs_author_seed.sql` exists.
- **Check-2 (idempotency):** every non-comment `INSERT` is followed by `ON CONFLICT DO NOTHING`
  (count(ON CONFLICT) ≥ count(INSERT) over non-comment lines).
- **Check-3 (no new table):** no `CREATE TABLE` in non-comment lines (data-seed only).
- **Check-4 (write-boundary):** the migration contains `'doc_page'` with both `'create'` and `'update'`
  operations and **no `'delete'`** grant on `doc_page`; no `delegable.*true` on any grant line.
- **Check-5 (resource_type present):** `resource_type` value `'doc_page'` present (grant rows target the
  correct resource_type).
- **Check-6 (frozen-guard):** none of the frozen files modified vs merge-base with `dev`
  (`grant-lattice.ts`, `grant-resolver.ts`, `mcp-tool-registry.ts`, `agents.ts`, `grants.ts`,
  `audit-writer.ts`) — identical FROZEN list to `config-agent-seed.sh` Check-6.
- **Check-7 (known_tenant_tables untouched):** `git diff` vs merge-base shows
  `ci/checks/known_tenant_tables.txt` unchanged (pure seed adds no table).
- **Check-8 (next-free UUIDs):** migration uses `e0…005` / `d0…015` / `f0…004` / `e2…018` / `e2…019`
  and does **not** reuse any UUID present in migrations ≤061 (collision guard).

### 6b. DB-tier probes — `ci/checks/db/docs-author-seed.test.ts`
(run in `fitness:db`; mint **fresh random tenant** only if appending audit — this suite reads dev-tenant
`a0…001`, no audit append, so no `freshTenant()` needed — per [[choros-db-test-shared-db-gotcha]].)
- **AC-01:** `choros.role` has exactly one row `(a0…001, e0…005)` with `slug='docs-author'`.
- **AC-02:** exactly **2** grant rows for role `e0…005` with `resource_type='doc_page'`; operation set =
  `{create, update}` (both present, count = 2).
- **AC-03 (no delete):** **0** grants for role `e0…005` with `resource_type='doc_page'` AND
  `operation='delete'`.
- **AC-04 (delegable boundary):** **0** grants for role `e0…005` with `delegable=true`.
- **AC-05 (no read):** **0** grants for role `e0…005` with `resource_type='doc_page'` AND
  `operation='read'` (read = external surface, not the author).
- **AC-06 (dormant card):** `agent_card` for `d0…015` has `llm_endpoint`/`llm_model`/`llm_secret_handle`
  all NULL and a non-null `budget_policy_id` joining `instance_budget`.
- **AC-07 (confirmed assignment):** `role_assignment` `f0…004` has `confirmed_by` NOT NULL, links
  `d0…015`↔`e0…005`, `org_scope.nodeId = b0…001`.
- **AC-08 (scope consistency):** both grants' `scope->>'nodeId' = b0…001` (= role_assignment org_scope).
- **AC-09 (idempotency):** re-running the seed INSERTs in a txn leaves role/grant/assignment counts stable.
- **AC-10 (RLS):** a `choros_app` session bound to OTHER_TENANT sees **0** `doc_page` grants for `e0…005`
  (cross-tenant isolation, FORCE RLS).
- **AC-11 (toolset reachability, optional pure assertion):** a synthetic `mcp_tool` with
  `resource_ops=[{doc_page,create},{doc_page,update}]` is reachable for these 2 grants via
  `isToolReachable`, and **not** reachable with the create grant removed (proves grants are necessary &
  sufficient, nothing wider). Pure unit-level; can also live as a `src/__tests__` vitest.

---

## 7. Frozen / known-tables impact

- **`ci/checks/known_tenant_tables.txt`:** **NOT touched.** `doc_page`/`doc_ref`/`doc_log` are already listed
  (T-0238/migration 061). P-1 adds no table → file unchanged (Check-7 / AC re: NF-1).
- **Frozen check files:** **NOT modified.** The seed adds only `migrations/062_*.sql` and two new
  `ci/checks/` test artifacts; it does not edit `src/core/*` or any existing frozen file
  (frozen-guard Check-6).

---

## 8. Open risks / deferrals

- **Promote-seam deferred** (research §7 R-5): "who reviews the author" is mitigated by lint (auto fact-
  reviewer) + draft→promote seam + stale-badge, but the *promote gate itself* is SEAM-2 / T-0134d / P-9 —
  out of P-1. P-1 only ensures the author holds no publish-equivalent authority (structural absence).
- **Writeful tool is P-2** (`doc_page_author`): until P-2 seeds an `mcp_tool` with
  `resource_ops=[{doc_page,create/update}]`, the grants are dormant-but-correct (resolver returns no tool
  because none declares those ops yet). This is intentional sequencing per research §8 critical path
  (P-1 → P-2 → P-3 → P-4); P-1 is the principal, P-2 the surface.
- **`budget_policy_id` reuse** of `b0…001`: same shared dev instance_budget as config-agent/impl-agent —
  acceptable for a dormant seed; a dedicated budget policy is a runtime-activation concern (P-3), not P-1.
