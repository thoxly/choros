# ADR · T-0140 — Seed-pack «showcase»: format + importer via public APIs + CLI apply/reset

**Status:** ready
**Phase:** DESIGN (architect)
**Date:** 2026-06-11
**Spec:** `docs/specs/T-0140-seed-pack-showcase.spec.md` (18 AC)
**Authoritative frame:** `playbooks/demo-stand.md` §SP-1 (founder, 2026-06-11) — invariants I-1…I-5
**Runtime target:** local / dev-container (`X-Dev-User` auth-mode). No external resource requested. Public stand = T-0142 (founder-gated, GT-4) — out of scope.

---

## 0. Context & constraints (load-bearing facts from the codebase)

These ground the decision; the coder/tester read them as the source of truth.

- **Schema already exists** (migrations 013–020): `choros.tenant(tenant_id,id,slug,display_name,created_at, UNIQUE(slug))`, `choros.department(…, parent_id, slug, UNIQUE(tenant_id,slug))`, `choros.position(…, department_id, slug, title, UNIQUE(tenant_id,department_id,slug))`, `choros.employee(…, position_id NULL, kind CHECK IN ('human','agent'), slug, display_name, UNIQUE(tenant_id,slug))`, `choros.role(…, slug, display_name, description, UNIQUE(tenant_id,slug))`. **All tables enforce RLS** keyed on `current_setting('choros.tenant_id')`; the only legal write path is a tenant-scoped `withTenant(pool, tenantId, …)` transaction (`src/db/org.ts`). The 5 new endpoints write into these *existing* tables — **no new DDL** in this task.
- **`slug` is the stable idempotency key** for tenant/department/position/employee/role (the UNIQUE constraints above). This is the mechanism that makes both the migration seeds and the importer idempotent. The pack therefore identifies entities **by slug**, never by raw UUID — UUIDs are server-allocated on insert and returned in the 201 body.
- **Genesis-owner** (`migration 026`): employee `slug='e-owner'` (`d0000000-…-00ff`), holds role `tenant-owner` (`e0000000-…-0001`) with 16 delegable `mgmt_object:{role,agent,process,grant}` × CRUD + `agent:invoke` grants scoped to the three root departments. **Critical gap:** the genesis-owner has `mgmt_object` grants for **role/agent/process/grant only** — there is *no* `mgmt_object:department`, `:position`, `:employee`, or `:tenant` kind in the grant vocabulary (`MGMT_OBJECT_KINDS`, `src/core/scoped-admin.ts`). See §2.3 (authz model decision) and §8 (escalation).
- **Existing write-API authz pattern** (`src/http/grants.ts`): every POST does `extractActor(req)` → reads `x-dev-user` header → `loadAdminContext(pool, tenantId, actorId, nowMs)` → `validateAdminDelegation(...)` before any INSERT. `actorId` is the **slug** (`e-owner`), resolved to `employee.id` inside the DB helpers. The new endpoints reuse this exact seam.
- **Seed constants are module-private** (`ORG_SEED` in `org.ts`, `PROCESSES_SEED` in `processes.ts`, `RIGHTS_SEED` in `rights.ts`): grep confirms they are **neither exported nor imported** anywhere else. So this is *not* a frozen-export refactor (§7) — but the GET response *shapes* they feed are a compatibility contract (frozen e2e tests assert on them).
- **`RIGHTS_SEED` is display-data, not the structural grant model.** It is a flat list of 8 UI "role cards" (holders by display-name, MCP-URI grant rows, field-ACLs) consumed by `screen-rights.jsx`. It is **not** isomorphic to `choros.role` + `choros.grant` + `choros.role_assignment`. See §2.2 (the two-plane decision) — this is the single subtlest point of the design.
- **No `process_instance` table exists.** `PROCESSES_SEED` is runtime Flowable state with no public write-API (`POST /api/processes` is out of scope per spec §4.6). It is display-only data.
- Stack: TS-only MVP (T-0057), single-Postgres substrate, zero-runtime-dep convention (only `pg`). Importer adds **no** new runtime dependency — it speaks HTTP via `node:http`/`fetch` (Node ≥18 global `fetch`).

---

## 1. Decision (one paragraph)

Adopt a **declarative, slug-keyed, multi-plane seed-pack** (`seed/<name>/pack.json` validated by `seed/pack.schema.json`, JSON-only — not YAML) plus a **TypeScript HTTP-only importer** (`seed/importer.ts`) and a thin **CLI** (`seed/cli.ts` → built `seed/cli.js`) exposing `apply` and `reset`. The pack consolidates `ORG_SEED`, `RIGHTS_SEED`, and `PROCESSES_SEED` into one authoritative file (I-2); the importer applies it strictly through public REST APIs (I-1), in dependency order, idempotently via slug-existence GET-check + 409-as-no-op. Five new write endpoints (`POST /api/tenants|departments|positions|employees|roles`) are added, each gated by the **existing** `extractActor → loadAdminContext → validateAdminDelegation` seam and each idempotent on its slug UNIQUE constraint (201 / 409). The pack is split into **two planes** — a **live plane** (tenant/departments/positions/employees/roles/role_assignments/grants → written via API into RLS tables) and a **display plane** (`process_instances`, and the UI-projection fields of role-cards → served verbatim from the pack file with no write), which is the single, explicitly-scoped exception to I-1 and is itself made safe by a fitness function (FF-7) that forbids the display plane from ever attempting a write. `seed reset` diff-reconciles the live plane to the pack reference (delete-extra + upsert-diff) while a hard exclude-list protects the genesis-owner employee and `tenant-owner`/`budget-approver` system roles (I-3, AC-10). `runtime_target = local/dev-container`.

---

## 2. Mechanism — the three decisions that carry the design

### 2.1 Pack format: JSON, slug-keyed, schema-validated

- **Location:** `seed/<pack-name>/pack.json` (one file per pack; `seed/showcase/pack.json`, `seed/blank/pack.json`).
- **Format = JSON, not YAML.** Rationale: the repo has *no* YAML parser and the zero-runtime-dep rule (only `pg`) forbids adding `js-yaml`; the existing `validate.py` harness and JSON Schema draft-07 convention already cover JSON. YAML would force either a new dependency (violates convention) or a hand-rolled parser (gold-plating). Spec FR-1 explicitly leaves the choice to the implementer; soreness of "must cover both" is resolved by choosing one.
- **Identity = slug, never raw UUID.** Every entity is referenced by `slug` (or a pack-local `ref` for cross-links, see object model). The server allocates UUIDs; the pack never hardcodes them. This is what makes apply idempotent against the UNIQUE(slug) constraints and survives a DB reset (AC-7/AC-8). Migration 014–016 UUIDs are *not* duplicated into the pack (I-2: no second copy of IDs).
- **Schema:** `seed/pack.schema.json` is JSON Schema draft-07, validated by `validate.py` (or `ci/checks/`-equivalent) at CI-time (FF-1 / AC-12) and by the importer at load-time (fail-closed before any HTTP call).

### 2.2 Two-plane content model (THE thin core — soreness here = silent bug downstream)

The spec lists `roles`, `grants`, `role_assignments`, `process_instances` in one pack, but the existing data lives on **two incompatible planes** and conflating them is the trap:

| Plane | Pack section | How it reaches the product | I-1 status |
|---|---|---|---|
| **Live** | `tenant`, `departments`, `positions`, `employees`, `roles`, `role_assignments`, `grants` | Written via public REST API into RLS-protected `choros.*` tables; readable via `GET /api/org`, `GET /api/rights` (DB path) | I-1 honored — all writes through API |
| **Display** | `process_instances`, `rights_cards` (UI projection of role-cards: holders-by-name, MCP-URI grants, field-ACLs) | Served **verbatim** from the pack file by the GET handlers when in pack-backed display mode; **never written** | **Documented I-1 exception** (§2.4) |

**Why two planes, not one.** `RIGHTS_SEED`'s "role card" is a *denormalized UI view* (it mixes a `choros.role` row, several `choros.grant` rows with display labels like "Реестр счетов"/`mcp://ledger.invoices`, holder display-names, and field-level ACLs that have no structural-grant analog yet). Forcing it into live `POST /api/roles` + `POST /api/grants` would (a) require resource-type/MCP-URI mapping that does not exist in the grant vocabulary, (b) lose the display labels, (c) explode scope far past "consolidate the seeds." The proportionate split: the pack carries the **structural role identity** (`roles` → `POST /api/roles`, live) **and** the **display projection** (`rights_cards` → served by `GET /api/rights` from the pack, display) as **two sections of one file**, single source (I-2 satisfied: there is exactly one copy of each datum, in the pack). AC-11 ("`GET /api/rights` returns the 8 roles") is satisfied by the display plane; AC-6 ("`POST /api/roles` creates a `choros.role` row") is satisfied by the live plane. The two are linked by slug.

> **Note for coder:** the 8 `rights_cards` and the live `roles` overlap by `slug`. The pack MUST keep them consistent; FF-8 (consistency check) enforces that every `rights_cards[].role_slug` has a matching `roles[].slug` so the display plane cannot drift from the structural plane.

### 2.3 Importer authz: reuse the genesis-owner seam, do not invent a second authority

The importer authenticates **every** write as `X-Dev-User: e-owner` (genesis-owner, AC-18). The new endpoints reuse the existing `extractActor → loadAdminContext → validateAdminDelegation` chain from `grants.ts` verbatim (FF-6). A non-owner dev-user must get **403** (AC-18). **No new authority subsystem, no hardcoded `isOwner` bypass** — owner-ness is resolved from the DB (`isGenesisOwnerForTenant`), identical to the grant write-path (matches the `grant-resolver-isolation` / `scoped-admin-isolation` invariants already in CI).

**Open authz gap (decided, with escalation flag in §8):** the genesis-owner's 16 grants cover `mgmt_object:{role,agent,process,grant}` but **not** `department`/`position`/`employee`/`tenant`. Three options were weighed:

- **(A) Extend the grant vocabulary** with new `mgmt_object` kinds (`tenant`,`department`,`position`,`employee`) + add 16 more genesis grants in a migration. *Largest blast radius* — touches `MGMT_OBJECT_KINDS`, `scoped-admin.ts`, the `role-migration-set` fitness check, and the SoD constraint. High-leverage, cross-cutting.
- **(B) Gate the 4 org-structure endpoints on `isGenesisOwner` directly** (the boolean already resolved by `loadAdminContext`), without a per-resource `mgmt_object` grant. Org-structure creation is a tenant-bootstrap-class privilege; the genesis-owner *is* the root of that authority by construction (migration 026 comment: "without which the tenant does not exist" = bootstrap). `POST /api/tenants` is even more clearly bootstrap (creating a *new* tenant cannot be authorized by a grant *inside* a tenant that doesn't exist yet).
- **(C) Mixed:** `POST /api/tenants` = `isGenesisOwner` of a designated bootstrap principal; `departments/positions/employees` = same; `roles` = the **existing** `mgmt_object:role:create` grant the owner already holds.

**Decision: (C).** It is the most proportionate: it reuses the one grant kind that *already exists* for roles (so `POST /api/roles` is a real grant check, not a bypass — strengthens AC-18), and treats tenant/department/position/employee creation as a **bootstrap-class capability gated on `isGenesisOwner`** (a DB-resolved boolean, not a hardcoded slug). This avoids a vocabulary expansion whose only consumer today is the seed importer (YAGNI / proportionality, rubric axis 5), while keeping the 403-for-non-owner guarantee. **This is flagged to the founder (§8)** because "org-structure CRUD authority sits on the owner-boolean, not on the grant lattice" is a product-direction choice about how far the grant lattice governs writes; if the founder wants full lattice coverage, that becomes its own task (E2 authority-core, post-MVP) and option (A) is the path. The fitness function FF-6 pins whichever gate is chosen so it cannot silently degrade to "no check."

### 2.4 The one documented I-1 exception, made safe

Display-plane data (`process_instances`, `rights_cards`) is served from the pack file without a write (no `POST /api/processes` — out of scope, and Flowable instance state is not reconstructible via public BPMN API). **Proportionality check against the founder frame:** I-1's *purpose* (demo-stand.md) is "an incompatible API change breaks CI at apply-time rather than silently rotting data." For live entities the importer *does* write through the API, so that protection holds. For process-instances there is **no live entity to rot** — they were *never* in a table; they are static demo JSON today (in `PROCESSES_SEED`) and stay static demo JSON (in the pack). The exception does not weaken I-1's purpose; it relocates already-static data into the single source (I-2) and is *narrower* than today (one file vs. a hardcoded array). **Safety rail:** FF-7 asserts the importer's apply loop **never iterates the display plane into an HTTP write** — display sections are load-and-serve only, structurally fenced from the write path, so the exception cannot creep into a silent SQL/HTTP write later. The exception is bounded, declared, and CI-enforced. Verdict: **proportionate to the frame; no founder escalation required for the exception itself** (distinct from the §8 authz escalation).

---

## 3. Object model — pack format (the field/type contract)

`pack.json` top-level (all `slug` fields: `^[a-z0-9][a-z0-9-]*$`):

### 3.1 `meta`
| field | type | notes |
|---|---|---|
| name | string | pack name, must equal directory name (FF-5) |
| version | string | semver-ish; informational |
| description | string | |

### 3.2 `tenant`
| field | type | notes |
|---|---|---|
| slug | string | idempotency key; UNIQUE(slug) on `choros.tenant` |
| display_name | string | |

### 3.3 `departments[]`
| field | type | notes |
|---|---|---|
| slug | string | idempotency key within tenant |
| display_name | string | |
| parent_slug | string \| null | cross-ref by slug; null = root dept |

### 3.4 `positions[]`
| field | type | notes |
|---|---|---|
| slug | string | unique within (tenant, department) |
| title | string | |
| department_slug | string | cross-ref → departments[].slug |

### 3.5 `employees[]`
| field | type | notes |
|---|---|---|
| slug | string | idempotency key within tenant |
| display_name | string | |
| kind | "human" \| "agent" | maps to `choros.employee.kind` CHECK |
| position_slug | string \| null | cross-ref → positions[].slug; null allowed (agents/owner) |

### 3.6 `roles[]` (live plane)
| field | type | notes |
|---|---|---|
| slug | string | idempotency key within tenant; UNIQUE(tenant,slug) |
| display_name | string | |
| description | string \| null | |
| system | boolean | true ⇒ referenced, NOT created (e.g. `tenant-owner`, `budget-approver` from migration 019); importer skips create, reset never deletes |

### 3.7 `role_assignments[]` (live plane)
| field | type | notes |
|---|---|---|
| employee_slug | string | cross-ref → employees[].slug |
| role_slug | string | cross-ref → roles[].slug |
| org_scope | object | scope element JSON (see `choros.role_assignment.org_scope`); slug- or node-keyed |

### 3.8 `grants[]` (live plane)
| field | type | notes |
|---|---|---|
| role_slug | string | cross-ref → roles[].slug |
| resource_type | string | e.g. `mgmt_object:role` (existing vocabulary) |
| operation | string | create/read/update/delete/exec/invoke |
| scope | object | scope element JSON |
| delegable | boolean | |

> Grants/assignments are emitted via the **existing** `POST /api/grants` and `POST /api/role-assignments` (no new endpoint). For the showcase pack, grants are limited to what the existing grant vocabulary + genesis-owner delegation can express; richer display-grants live in `rights_cards`.

### 3.9 `rights_cards[]` (display plane — served verbatim by `GET /api/rights`)
| field | type | notes |
|---|---|---|
| role_slug | string | MUST match a `roles[].slug` (FF-8) |
| name | string | UI label |
| dept | string | UI label |
| scope | string | UI label |
| holders[] | {type, name} | display only |
| grants[] | {res, uri, ops[], scope} | MCP-URI display rows |
| fields[] | {name, a:"read"\|"write"\|"hidden"} | field-ACL display |

### 3.10 `process_instances[]` (display plane — served verbatim by `GET /api/processes`)
Verbatim `ProcessInstance` shape from `src/http/processes.ts`: `{ id, name, procId, status:"running"|"waiting"|"done"|"failed", node, started, elapsed, progress:{done,total}, execs:("human"|"agent"|"service")[] }`.

### 3.11 New table rows touched (existing schema — no DDL)
`choros.tenant`, `choros.department`, `choros.position`, `choros.employee`, `choros.role` — all written via the 5 new endpoints; `choros.grant`, `choros.role_assignment` via existing endpoints.

---

## 4. Contracts — 5 new endpoints (the API signature contract)

All: `Content-Type: application/json`; auth = `X-Dev-User` header (dev mode); error envelope `{error:{code,message}}` (router.ts); idempotency via slug UNIQUE → **409 `CONFLICT`** which the importer treats as no-op; non-owner / insufficient delegation → **403** (`NOT_OWNER`). Each handler does `extractActor → loadAdminContext → (gate per §2.3) → withTenant INSERT`.

```
POST /api/tenants
  body:    { slug: string, display_name: string }
  201:     { id: uuid, slug: string }
  409:     slug exists                         (AC-1)
  gate:    isGenesisOwner (bootstrap-class, §2.3 option C)

POST /api/departments
  body:    { tenant_id: uuid, slug: string, display_name: string, parent_id?: uuid|null }
  201:     { id: uuid, slug: string }
  409:     (tenant_id, slug) exists            (AC-2)
  gate:    isGenesisOwner

POST /api/positions
  body:    { tenant_id: uuid, department_id: uuid, slug: string, title: string }
  201:     { id: uuid, slug: string }
  409:     (tenant_id, department_id, slug) exists   (AC-3)
  gate:    isGenesisOwner

POST /api/employees
  body:    { tenant_id: uuid, position_id?: uuid|null, kind: "human"|"agent", slug: string, display_name: string }
  201:     { id: uuid, slug: string }
  409:     (tenant_id, slug) exists            (AC-4, AC-5)
  400:     kind not in {human,agent}
  gate:    isGenesisOwner

POST /api/roles
  body:    { tenant_id: uuid, slug: string, display_name: string, description?: string|null }
  201:     { id: uuid, slug: string }
  409:     (tenant_id, slug) exists            (AC-6)
  gate:    mgmt_object:role:create grant (existing) — genesis-owner holds it (§2.3 option C)
```

> Bodies take `tenant_id`/`department_id`/`position_id` as **UUIDs**, but the *pack* carries slugs. The **importer** resolves slug→UUID from the 201 responses it accumulates as it walks the dependency order (it keeps an in-memory `slug→id` map per entity type). This keeps the API clean (UUID FKs, matching existing tables) while the pack stays UUID-free.

### 4.1 Importer / CLI contracts
```
seed/importer.ts
  applyPack(opts: { baseUrl: string, tenantSlug: string, packName: string, devUser?: string })
    : Promise<ApplySummary>      // ApplySummary = { created: Record<entity,number>, skipped: Record<entity,number> }
  resetPack(opts: { baseUrl, tenantSlug, packName, devUser? }): Promise<ResetSummary>
  loadPack(packName: string): Pack         // reads + schema-validates seed/<name>/pack.json; throws on invalid (fail-closed)

seed/cli.ts → seed/cli.js (built)
  node seed/cli.js apply --tenant <slug> --pack <name> [--base-url http://localhost:8080]
  node seed/cli.js reset --tenant <slug> [--pack <name>]
  exit 0 on success; non-zero on first error; structured-JSON summary to stdout, errors to stderr (NF-4, AC-15)
  default devUser = e-owner (AC-18)
```

`applyPack` order (FR-2): tenant → departments → positions → employees → roles → role_assignments → grants. Display plane is **not** applied (FF-7). Per entity: GET-check existence by slug *or* POST and treat 409 as `skipped` (idempotent, AC-8). `resetPack`: for each live entity type, `GET` current tenant state, compute `delete = inTenant \ pack` and `upsert = differs`, apply via API; **exclude-list** `{employee:'e-owner', role:'tenant-owner', role:'budget-approver'}` is never deleted (AC-10, I-3). (Delete endpoints for org entities may be needed for reset; if `DELETE /api/departments/:id` etc. are absent, that is a coder-surfaced dependency — reset's delete-extra path requires them. Flagged in §6.)

---

## 5. Fitness functions (CI-enforced architecture boundaries)

| id | rule | ci_check |
|---|---|---|
| **FF-1** | `seed/pack.schema.json` exists (JSON Schema draft-07) and validates every `seed/*/pack.json` with zero errors. | `ci/checks/seed/pack-schema-valid.sh` → runs `validate.py` (or node JSON-Schema validator) over each `seed/*/pack.json` against `seed/pack.schema.json`; non-zero on any error. Covers AC-12. |
| **FF-2** | No direct DB access in the seed tooling: `seed/*.ts` import neither `pg` nor any `src/db/*`. All writes go through HTTP. | `ci/checks/seed/no-direct-pg-in-importer.sh` → `grep -REn "from ['\"]pg['\"]\|require\(['\"]pg['\"]\)\|from ['\"].*src/db" seed/` must return zero matches. Covers AC-13 / NF-2. |
| **FF-3** | No secrets/credentials committed under `seed/`. | `ci/checks/seed/no-seed-secret.sh` (or extend `no-committed-secret.sh` glob to `seed/**`) → scans `seed/**` for credential patterns; zero matches. Covers AC-14 / NF-5. |
| **FF-4** | Single source of truth (I-2): the demo *content* is not duplicated. After this task no NEW hardcoded copy of the org/role/process demo IDs may be added outside the pack; existing in-memory `ORG_SEED`/`PROCESSES_SEED`/`RIGHTS_SEED` fallbacks are the ONLY permitted second locus and are frozen (no third copy). | `ci/checks/seed/single-source.sh` → asserts (a) exactly one `seed/showcase/pack.json`, (b) no `*_SEED` const declared in `src/` other than the three known fallbacks in `org.ts`/`processes.ts`/`rights.ts` (grep allow-list), (c) no `.ts`/`.json` under `src/` or `test/` re-declares the showcase department/employee/role slug set. Covers I-2. |
| **FF-5** | Pack integrity: `meta.name` equals the containing directory name; all cross-refs resolve (every `position.department_slug` ∈ departments, every `employee.position_slug` ∈ positions ∪ {null}, every `role_assignment.{employee_slug,role_slug}` resolves). | `ci/checks/seed/pack-refs-resolve.sh` → small node script loads each pack and asserts referential closure; non-zero on dangling ref. |
| **FF-6** | Importer auth seam preserved: the 5 new write handlers each call `loadAdminContext` (or `isGenesisOwnerForTenant`) and gate before INSERT — no hardcoded owner bypass, no INSERT before the gate. | `ci/checks/seed/write-api-auth-gate.sh` → for each of `tenants|departments|positions|employees|roles` route registration in `src/http/`, assert the handler references `loadAdminContext`/`isGenesisOwnerForTenant`/`validateAdminDelegation` and contains no literal `=== "e-owner"` / `=== 'e-owner'` slug comparison. Covers AC-18. |
| **FF-7** | I-1 exception fence: the importer apply path NEVER issues an HTTP write for display-plane sections (`process_instances`, `rights_cards`). Display data is load-and-serve only. | `ci/checks/seed/display-plane-no-write.sh` → `grep` asserts `seed/importer.ts` references `process_instances`/`rights_cards` only inside `loadPack`/serve helpers, never inside the apply/POST loop (the POST loop iterates an explicit live-entity allow-list, not the whole pack object). Covers the §2.4 safety rail. |
| **FF-8** | Display↔live consistency: every `rights_cards[].role_slug` has a matching `roles[].slug` in the same pack (display plane cannot drift from structural plane). | folded into `ci/checks/seed/pack-refs-resolve.sh` (FF-5) — asserts `rights_cards[].role_slug ⊆ roles[].slug`. |
| **FF-9** | Smoke-apply on clean DB: `seed apply --tenant showcase --pack showcase` against a migrated empty DB exits 0 and `GET /api/org` / `GET /api/rights` return the expected entity counts. | `npm run seed:smoke` (new script) wired into CI after `npm run migrate`; runs apply, then asserts `GET /api/org` → 3 depts/7 positions/12 employees and `GET /api/rights` → 8 roles. Covers AC-7 / AC-11 / FR-7. (Runtime check, lives under `fitness:db` style gating where a DB is available.) |
| **FF-10** | e2e fixtures read IDs from the pack, not hardcoded duplicates: no test file hardcodes a department/employee/role slug or UUID that also lives in the pack. | `ci/checks/seed/no-hardcoded-fixture-ids.sh` → grep test/ for the showcase slug/UUID set; any match outside a `loadPack`-derived reference fails. Covers AC-17 / FR-8. |

---

## 6. Coder-surfaced dependencies (not blocking DESIGN, flag for SPEC-of-next or coder)

- **`reset` needs DELETE endpoints** for org entities (`DELETE /api/departments/:id`, `/positions/:id`, `/employees/:id`, `/roles/:id`) to remove pack-absent extras (AC-9). The spec lists only POST endpoints. Options for the coder: (a) add the 4 DELETE endpoints (same authz seam), or (b) scope `reset` v1 to *upsert-only* + delete restricted to a designated demo subtree. **Recommended:** add DELETE endpoints behind the same `isGenesisOwner` gate — AC-9 explicitly requires removing a manually-inserted extra department, which is not satisfiable by upsert-only. This is in-scope work the coder must size; surfaced here so it is not a silent gap.
- **`GET /api/org` / `GET /api/rights` DB-path** must be wired so that after `seed apply` the DB-backed response reflects pack content (today the DB path exists for `/api/org`; `/api/rights` currently serves only `RIGHTS_SEED` in-memory — AC-11 requires it to reflect the pack's `rights_cards` display plane; coder decides DB-table vs. pack-file-serve, ADR §2.2 leans pack-file-serve for display plane).

---

## 7. Public-surface refactor / compatibility contract (FE-W23-0008)

- **`ORG_SEED`, `PROCESSES_SEED`, `RIGHTS_SEED` are module-private** (grep-confirmed: not exported, not imported). Moving their *content* into the pack does **not** break any import. They are **retained** as in-memory no-DB fallbacks (spec §4.9 / FR-5) — this task does not remove them; FF-4 freezes them as the single permitted second locus.
- **Frozen exports in `org.ts`** — `findEmployee`, `listSelectableUsers`, `registerOrgRoutes` (consumed by `auth.ts`, `inbox.ts`) — are **untouched** by this task (no signature change). No migration plan needed.
- **GET response shapes are the live compatibility contract.** The frozen e2e tests (`org.e2e.test.ts`, `processes.e2e.test.ts`, `rights.e2e.test.ts`) assert on response *shape* (departments[].{id,name,positions[]}, instances[].{id,name,status,node,progress}, roles[].{id,name,grants,fields,holders}) — **not** on hardcoded ID lists. The pack-backed responses MUST preserve these shapes byte-for-shape. This is the contract the coder must hold; FF-9 (smoke) + the existing e2e suite enforce it.
- **No constitution/agents/control-plane files touched** (role rule §5).

---

## 8. Escalation

**`needs_founder` is NOT set** (status: ready) — the design is implementable as specified. **One product-direction flag is raised for founder awareness (not a blocker):** §2.3 decision (C) places authority for **tenant/department/position/employee creation on the genesis-owner boolean** (`isGenesisOwner`, DB-resolved) rather than on a per-resource `mgmt_object` grant in the grant lattice, because that grant vocabulary does not exist today and its only present consumer would be the seed importer. This is proportionate for the MVP demo-stand and keeps the 403-for-non-owner guarantee (AC-18, FF-6). **If the founder wants the grant lattice to govern org-structure writes end-to-end** (full E2 authority-core coverage — option A: extend `MGMT_OBJECT_KINDS` + genesis grants + SoD), that is a separate, higher-leverage task (post-MVP, E2/E11-E12 authority-core), and this ADR's FF-6 is written to pin whichever gate is chosen so the choice is explicit and CI-enforced, not silent. Surfaced per role-rule "высоколеверажный выбор → escalation, не молчи"; treated as a flag rather than a hard gate because it does not change product direction *now* and the demo-stand frame (bootstrap-vs-demo boundary, I-3) already endorses owner-as-bootstrap-root.

---

## 9. Traceability (AC → design locus)

| AC | covered_by |
|---|---|
| AC-1 | §4 `POST /api/tenants` 201/409; FF-9 |
| AC-2 | §4 `POST /api/departments` 201/409 |
| AC-3 | §4 `POST /api/positions` 201/409 |
| AC-4 | §4 `POST /api/employees` kind=human 201/409 |
| AC-5 | §4 `POST /api/employees` kind=agent 201/409 |
| AC-6 | §4 `POST /api/roles` 201/409 (mgmt_object:role:create gate) |
| AC-7 | §4.1 applyPack order; FF-9 smoke (3/7/12 via GET /api/org) |
| AC-8 | §2.1 slug-idempotency + §4.1 GET-check/409-no-op; FF-9 |
| AC-9 | §4.1 resetPack delete-extra; §6 DELETE-endpoint dependency |
| AC-10 | §4.1 resetPack exclude-list {e-owner, tenant-owner, budget-approver}; I-3 |
| AC-11 | §2.2 display plane `rights_cards` served by GET /api/rights; FF-9 |
| AC-12 | §2.1 / FF-1 pack-schema-valid |
| AC-13 | FF-2 no-direct-pg-in-importer |
| AC-14 | FF-3 no-seed-secret |
| AC-15 | §4.1 ApplySummary structured summary (NF-4) |
| AC-16 | §3.10 `process_instances` display plane served by GET /api/processes |
| AC-17 | FF-10 no-hardcoded-fixture-ids |
| AC-18 | §2.3 extractActor→loadAdminContext gate (e-owner=owner, non-owner→403); FF-6 |

---

## 10. Rejected alternatives

- **YAML pack format** — rejected: no YAML parser in-repo; adding `js-yaml` violates the zero-runtime-dep convention (only `pg`); `validate.py` + JSON Schema already cover JSON. Spec leaves choice open.
- **Raw-SQL / migration-based seed apply** — rejected: violates I-1 (the whole point is API-time CI breakage on schema drift, not silent SQL inserts).
- **One-plane pack (force role-cards + process-instances through live POSTs)** — rejected: `RIGHTS_SEED` is a denormalized UI projection with no structural-grant isomorphism, and process-instances have no public write-API (Flowable state). Forcing them live explodes scope past "consolidate seeds" and is impossible for processes (§2.2 / §2.4).
- **UUID-keyed pack (copy migration 014–016 UUIDs into the pack)** — rejected: creates a second copy of IDs (violates I-2), breaks on DB reset (UUIDs server-allocated), and couples the pack to migration internals. Slug-keyed + slug→id map at apply-time is the idempotent, decoupled path.
- **Extend grant vocabulary with `mgmt_object:{tenant,department,position,employee}` now (option A)** — rejected for *this* task: high blast radius (`MGMT_OBJECT_KINDS`, `scoped-admin`, SoD, role-migration-set fitness), only consumer is the seed importer ⇒ disproportionate (rubric axis 5). Flagged to founder (§8) as the path *if* full-lattice coverage is wanted as a separate authority-core task.
- **Hardcoded `isOwner = slug === 'e-owner'` shortcut in new handlers** — rejected: duplicates a second authority truth, diverges from `grants.ts` DB-resolved owner-ness, and would fail the isolation-style invariants; FF-6 forbids it.
