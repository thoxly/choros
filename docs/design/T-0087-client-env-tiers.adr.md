# ADR · T-0087 — Client env tiers: two logical tiers (draft→published) in one silo

**Task:** T-0087 (E12.6) · product Choros
**Phase:** DESIGN · **Status:** ready (no founder escalation)
**Branch:** `task/T-0087` (base: `3d58bf6` SPEC)
**Date:** 2026-06-11

**Spec consumed:** `docs/specs/T-0087-client-env-tiers.spec.md` + `docs/specs/T-0087.spec.contract.json` (FR-1..FR-7, NF-1..NF-4, AC-1..AC-10).

**Design source (do NOT contradict):** `docs/design/extensibility-and-authoring.md` §8 (две логических тира draft→published в одном silo, config-only promotion, prod managed/locked, физический контур = on-demand ось C) + §9.6 (DRAIN-by-default + managed/locked prod как жёсткие дефолты) + §3 ось B (governance промоушна = self-apply запрещён для ОБОИХ этажей, gated-promote human-confirm) + §10 (среды клиента = логические тиры ВНУТРИ одного silo, ортогональны SDLC Choros).

**Foundation ADRs (consumed, byte-untouched — this ADR does NOT re-open them):**
- `docs/design/T-0013-tenant-isolation.adr.md` — every tenant table is FORCE-RLS default-DENY, `tenant_id` leading PK, accessed via `withTenant` + the `choros.tenant_id` GUC. The `tier` column is added **inside** this convention, not beside it.
- `docs/design/T-0014-registry-model.adr.md` — the JSONB object model (`application ⊃ registry_def ⊃ record`); `registry_def.record_schema` IS the object-schema artifact; `is_system boolean NOT NULL DEFAULT false` is the precedent for an additive config-attribute column.
- `docs/design/T-0016-audit-floor.adr.md` — the append-only per-tenant hash-chained `audit_event` floor; promote events are **ordinary rows** (open `type` vocabulary), written through the canonical `appendAuditEventInput`. NO new audit table, NO parallel audit writer.
- `docs/design/T-0018-grant-authority.adr.md` — the single `grant` authority table + `mgmt_object:*` resource-type reservation. Promote authority is expressed through the **existing** `grant` model (resource-type × operation × scope), NOT a new authority subsystem.
- `docs/design/T-0044-dual-control.adr.md` §9 (rev-2) — **authenticated-only** approver provenance: identity comes from `extractActor(req)` / the `actor_type` claim, **never** a request body. The promote human-gate reuses this exact discipline.

**Siblings — compatible, NOT merged (this ADR must not build their delta nor contradict their model):**
- **T-0082 (E12.1) bundle-coherence** — the *coherent commit* of the BPMN↔form↔schema↔grants bundle **within** a tier. T-0087 gives the tier *attribute* and the promote *contract*; T-0082 gives intra-tier coherence. The promote unit (§4.3) is shaped to accept a bundle-set, not a single row, so T-0082 plugs in without re-opening this ADR.
- **T-0077 (E11.6) config-agent-as-employee** — the governance apparatus of the authoring agent (role→MCP-tools, budget, DRAFT-only). T-0087 only fixes that `draft` is the agent's writable tier and that the agent **cannot** self-promote (AC-7); the agent's full org-card is T-0077.
- **T-0130 simulation** — run/simulate over the draft tier; references T-0087 as load-bearing. T-0087 gives draft-tagged data isolation (FR-5); the run modes are T-0130.
- **T-0084 changelog↔diff validator** — the promote review surface. Out of T-0087's delta.

---

## 1. Context — what already exists vs what the AC names

The spec's AC-1 enumerates config-artifact tables `process_definition, form_definition, object_schema, grant, dmn_table, nav_config`. A **real-code check against this worktree** shows the present (T-0053-built, migrations 001–043) schema does **not** yet have most of those tables. What exists today is:

| Spec-named artifact | Reality on this base | Tier-bearing in T-0087? |
|---|---|---|
| `object_schema` | **`registry_def.record_schema`** (the JSONB object model is here — T-0014 §3.2) | **yes** — `registry_def` is a config table |
| `application` (container/nav root) | **`application`** (T-0014 §3.1) | **yes** — config table |
| `grant` (authority config) | **`grant`** (T-0018) | **yes** — config table |
| `process_definition` | **not built** (owned by E12/T-0071/Flowable deploy line) | **reserved** (forward contract, §4.1) |
| `form_definition` | **not built** (Floor-1/Floor-2 authoring, E12) | **reserved** |
| `dmn_table` | **not built** (Middle layer, E12) | **reserved** |
| `nav_config` | **not built** (E12 §5) | **reserved** |
| data: `record` | **`record`** (T-0014 §3.3) | **yes — data tier** (FR-5/AC-6) |
| data: process instances | **not built** (engine line) | **reserved data tier** |

**The load-bearing decision this forces (§2):** T-0087 does **not** create the missing config tables — that would build T-0082/T-0071's delta and invent schema this ADR has no mandate for. Instead T-0087 fixes **`tier` as a registered convention over a config-artifact-table class and a data-table class**, materializes it day-1 on the tables that exist (`application`, `registry_def`, `grant`, `record`), and pins a **forward contract + a fitness gate** so that every config/data table added later by E12 (`process_definition`, `form_definition`, `dmn_table`, `nav_config`, process-instance) inherits the tier column-or-is-flagged-by-CI. This is the proportional reading of an MVP "thin core" (rubric axis 5): the *mechanism* (tier attribute + config-only promote + managed-locked published + draft-data isolation) is complete and enforced now; the *table inventory* grows as E12 builds, governed by a registry the CI checks against — exactly the `known_tenant_tables.txt` anti-drift pattern (T-0115) re-applied to a `tier_bearing_tables.txt` registry.

This is **design-only** for the SQL/DDL/triggers/endpoint/handler — those land in a follow-on coder run on the **already-live dev silo** (`/srv/choros`, migrations applied by `migrations/run.mjs`). The follow-on is an additive migration (the `030`/`031` precedent), a new pure `src/core/env-tier.ts` module, a `promoteTier` service, and a `POST /api/artifacts/:id/promote` handler on the existing HTTP server. No new external resource, no new Postgres container (NF-4).

---

## 2. Decision (the mechanism)

**Adopt a single `tier text NOT NULL DEFAULT 'draft' CHECK (tier IN ('draft','published'))` column on every registered tier-bearing table — both the config-artifact class and the data class — inside one silo. The tier attribute is a self-contained, joinless column (NF-1) governed by a `ci/checks/tier_bearing_tables.txt` registry. Write to `published` is forbidden two ways held simultaneously (mirroring the T-0016 append-only discipline): (a) the app-layer write-path rejects any non-promote mutation of a `published` row with `409 PUBLISHED_LOCKED`; and (b) a `BEFORE UPDATE`/`BEFORE DELETE` trigger on every config table rejects any statement that targets a `published` row unless the connection is inside the sanctioned promote transaction (a transaction-local `choros.promoting` GUC set only by `promoteTier`). Promotion is a single pure transition `draft → published` performed only by `promoteTier()`, exposed as `POST /api/artifacts/:id/promote`; it is config-only (it flips the artifact row's `tier`, copying NO `record`/instance/audit data across the tier line — FR-3), atomic with its audit event (NF-2/NF-3), and human-gated by reusing the existing `actor_type: "human" | "agent"` authenticated claim — an `agent` actor is rejected `403 FORBIDDEN_AGENT_SELF_PROMOTE` (AC-7, no new authority model). Published-context reads default-filter to `tier = 'published'` so draft-tagged data never surfaces in prod (FR-5/AC-6). The promote *authority* is an ordinary `grant` row (`mgmt_object:tier_promote` resource-type, `operation = 'transition'`); the audit event is an ordinary `audit_event` row of `type = 'artifact.promoted'`. No new table for tiers, no new authority subsystem, no new audit writer, no second physical contour (NF-4 / FR-7 / AC-8).**

The mechanism is **proportional**: one additive column, one CHECK, one app-guard + one trigger pair per config table (the *same* dual-mechanism shape T-0016 already ships for append-only), one pure transition function, one endpoint, one default read-scope helper. No environment-orchestration engine, no CD pipeline, no solution-import/export apparatus (that is Power-Platform-grade gold-plating the §8 source explicitly rejects in favour of "the lightest working variant"). The thin core is **the tier column + the promote transition + the published-locked dual guard**; everything else is convention enforced by fitness functions.

### 2.1 Why tier lives on the artifact row (not a separate tier table or a physical contour)

NF-1 demands the tier attribute be queryable **without a join**. A separate `artifact_tier(artifact_id, tier)` table would (a) re-introduce a join on every read-path tier check, (b) create a second source of truth that can drift from the artifact's existence, and (c) duplicate the tenant-isolation surface. A physical second DB/silo is the §8 ось-C on-demand escalation, **explicitly not the default** (FR-7/NF-4/AC-8). So the tier is a **column on the artifact itself**, exactly as `registry_def.is_system` is a config-attribute column today — same precedent, same proportionality.

### 2.2 Why the published-lock is dual-mechanism (app-guard + trigger)

§3 ось B is categorical: self-apply to prod is forbidden for **both** floors; the risk lives in the gate, not the artifact format. A pure app-layer check is defeated by any code-path that issues an `UPDATE` without routing through the guard (the same hole T-0016 names for audit-mutation and T-0044/T-0030 name for body-asserted authority). So published-immutability is enforced **both** at the application write-path **and** at a DB trigger that fires regardless of code-path — defeating it requires a CI-visible diff that *both* removes the app-guard *and* drops/disables the trigger (caught by FF-2's grep + the live probe). The trigger admits a write only when `current_setting('choros.promoting', true) = '1'`, a transaction-local flag set **only** inside `promoteTier`'s transaction — so the one sanctioned path (promote itself, which sets `tier := 'published'`) is allowed and every other path is rejected.

---

## 3. Rejected alternatives

| Option | Why not |
|---|---|
| **Create the missing config tables (`process_definition`, `form_definition`, `dmn_table`, `nav_config`) in T-0087 to give them a tier column** | Builds T-0082/T-0071/E12's delta and invents schema T-0087 has no mandate for. The spec §8 scopes T-0087 to *the tier model and the read/write contract*, not the artifact inventory. T-0087 instead defines tier as a **registered convention** and a **forward fitness gate**: tables added later are CI-required to carry the column. (See §4.1 registry.) |
| **A separate `artifact_tier` / `environment` table keyed by artifact id** | Violates NF-1 (re-introduces a join on every tier check); a second source of truth that drifts from artifact existence; a duplicate tenant-isolation surface. Tier is a column on the artifact (§2.1), like `is_system`. |
| **Separate physical DB / second silo per tier as the default** | This is §8 ось-C, the **on-demand escalation**, explicitly *not* the default (FR-7). NF-4 forbids a new Postgres container for tiers. The default is two logical tiers in one silo; the physical contour stays a human-gated rare flip (AC-8 grep proves no auto-provision). |
| **Enforce published-immutability only at the application layer** | A single forgotten/new `UPDATE` path silently re-opens prod mutation — the exact discipline-not-structure anti-pattern T-0016 §2 names. The DB trigger is the orthogonal fail-closed half (§2.2). |
| **Enforce published-immutability only with a DB trigger (no app-guard)** | The HTTP layer must still return a *typed* `409 PUBLISHED_LOCKED` (AC-2) with a clear error rather than a raw DB exception; and the guard is where the promote-vs-direct-write distinction is most legible to reviewers. Both kept (defence in depth). |
| **Copy draft data into published on promote (env-clone semantics)** | Directly violates FR-3 / §8 "данные НИКОГДА не копируются". Promote is **config-only**: it flips the artifact row's `tier`; `record`/instance/audit rows never cross the tier line. AC-3 asserts published-context data count stays 0. |
| **Invent a new "promote" privilege / a new authority store** | Violates T-0018 NF-1 (single authority subsystem). Promote authority is an ordinary `grant` (`mgmt_object:tier_promote` reserved resource-type, `operation='transition'`), resolved by the existing PDP (T-0021). No parallel store. |
| **A new audit table / writer for promote events** | Violates T-0016 (one append-only floor; new event *types*, never new tables). `artifact.promoted` is an ordinary `audit_event` row via the canonical `appendAuditEventInput`, atomic with the tier flip (NF-3). |
| **Human-gate via a body-supplied `confirmed_by` / `is_human` flag** | The exact body-asserted-authority hole T-0044 §9 closed. The gate reads the **authenticated** `actor_type` claim (`human`/`agent`) from `extractActor`/`getAuthContext`, never the body. An `agent` ⇒ `403 FORBIDDEN_AGENT_SELF_PROMOTE`. |
| **Map `draft`→Choros-dev and `published`→Choros-prod environments** | Violates FR-6/§10 orthogonality: client tiers are an attribute *inside* the product, decoupled from Choros's own dev/prod SDLC. A dev Choros instance must serve both tiers (AC-9). FF-9 greps that no config maps tier→SDLC env. |
| **A nullable `tier` (no NOT NULL DEFAULT)** | A NULL tier is an un-governed third state — a row neither draft nor published, invisible to both read-scopes and to the lock. AC-1 mandates `NOT NULL DEFAULT 'draft'` + CHECK; every artifact is born in draft. |

None of these re-opens a founder-ratified decision. The "two logical tiers in one silo, config-only promotion, managed/locked prod, physical contour on-demand" shape is the **direct §8 synthesis the founder ratified** (extensibility-ADR, signed direction); T-0087 pins its data model and contract, it does not fork it.

---

## 4. Object model & contracts

### 4.1 The `tier` column + the tier-bearing-table registry

Added to every registered tier-bearing table (Postgres types authoritative; the additive DDL is the coder's, mirroring migration `030`):

| Field | Type | Constraint / Notes |
|---|---|---|
| `tier` | `text` | `NOT NULL DEFAULT 'draft'`, `CHECK (tier IN ('draft','published'))`. Joinless (NF-1). No new index required day-1 (small config sets); read-scope helper filters in the `WHERE`. |

**Registry (anti-drift, the `known_tenant_tables.txt` pattern re-applied):** a new fixture `ci/checks/tier_bearing_tables.txt` lists the tables that MUST carry `tier`. Day-1 content — **config class:** `application`, `registry_def`, `grant`; **data class:** `record`. Each E12 follow-on that creates a config/data table (`process_definition`, `form_definition`, `dmn_table`, `nav_config`, process-instance) appends its table to this fixture in the same migration, and FF-1's lint asserts every listed table has the `tier` column + CHECK in the migration DDL — so a new artifact table that forgets its tier column fails CI (the silent-drift guard). The registry is the **single source of truth** for "which tables are tiered"; the read-scope helper, the lock trigger, and the promote service all iterate it, never a hard-coded list.

> The day-1 registry is intentionally the four tables that exist. The spec-named `process_definition`/`form_definition`/`object_schema`/`dmn_table`/`nav_config` are reconciled thus: `object_schema` ≡ `registry_def` (already listed); the other four are **reserved** — when E12 builds them they join the fixture and inherit the column under FF-1. AC-1's intent (tier on every config-artifact table) is satisfied *as a standing invariant over the registry*, not as a one-shot table list T-0087 cannot honestly create.

**Additive-migration shape (coder contract, NOT built here):**

```sql
-- 0NN · tier (T-0087 E12.6) — additive ALTER TABLE on registered config + data tables.
-- ADDITIVE & IDEMPOTENT (ADD COLUMN IF NOT EXISTS). No new table, no RLS change,
-- known_tenant_tables.txt BYTE-UNCHANGED (additive column on already-registered tenant tables).
ALTER TABLE choros.application
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'draft'
  CHECK (tier IN ('draft','published'));
-- … identical ADD COLUMN for choros.registry_def, choros."grant", choros.record …
```

The existing PK `(tenant_id, id)`, the RLS policy, and `GRANT … TO choros_app` are all unchanged (additive). `tenant_id` stays the leading PK column (T-0013); tier is a non-key attribute scoped within the tenant (it is meaningful only in a tenant context — there is no global tier).

### 4.2 Published-locked write guard (dual mechanism — the AC-2 / FR-4 invariant)

**(a) App-layer (typed error, AC-2):** every artifact-mutation write-path (the `PUT`/`PATCH`/edit and `DELETE` handlers on config tables) consults a pure helper before mutating:

```ts
// src/core/env-tier.ts — pure, no IO.
export type Tier = "draft" | "published";

// FR-4 / AC-2: a direct (non-promote) mutation of a published row is forbidden.
// Returns the typed rejection the HTTP layer turns into 409 PUBLISHED_LOCKED.
export function assertWritable(currentTier: Tier): { ok: true } | { ok: false; code: "PUBLISHED_LOCKED" };
//   ok       iff currentTier === "draft"
//   rejected iff currentTier === "published"  → HTTP 409 PUBLISHED_LOCKED, no row mutated.
```

**(b) DB trigger (fail-closed, fires regardless of code-path):** a `BEFORE UPDATE`/`BEFORE DELETE` trigger on every config table raises unless the row being mutated is `draft`, **or** the transaction is the sanctioned promote (a transaction-local GUC `choros.promoting = '1'` that only `promoteTier` sets):

```sql
CREATE FUNCTION choros.tier_published_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tier = 'published'
     AND current_setting('choros.promoting', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'tier published rows are managed/locked (T-0087 FR-4): direct write forbidden';
  END IF;
  RETURN NEW;  -- draft rows, or the sanctioned promote txn, pass
END $$;
-- CREATE TRIGGER … BEFORE UPDATE OR DELETE ON choros.<config-table> FOR EACH ROW …
```

Both are held simultaneously: removing the app-guard does not remove the trigger and vice-versa (§2.2). The trigger is on **config tables only** — data rows (`record`, instances) are not promoted and are not locked; their tier isolation is the read-scope (§4.4), not a write-lock.

### 4.3 The promote transition (config-only, atomic, the FR-3 / NF-2 / NF-3 core)

```ts
// src/core/env-tier.ts — the pure transition decision (no IO).
// A promote is the single allowed tier change. It validates the source state and
// the human-gate signal; the actual UPDATE + audit append is the service (§4.5).
export interface PromoteInput {
  currentTier: Tier;
  actorType: "human" | "agent";   // from the AUTHENTICATED claim (T-0044 §9 discipline)
}
export type PromoteDecision =
  | { ok: true; from: "draft"; to: "published" }
  | { ok: false; code: "FORBIDDEN_AGENT_SELF_PROMOTE" }   // actorType === "agent" → 403 (AC-7)
  | { ok: false; code: "NOT_IN_DRAFT" };                  // currentTier !== "draft" → already published / nothing to promote
export function decidePromote(input: PromoteInput): PromoteDecision;
```

**Service contract (`promoteTier`, the transactional shell — pseudocode; impl is coder's):**

```text
// POST /api/artifacts/:id/promote   (config-only, human-gated, atomic — NF-2/NF-3)
actor   = extractActor(req)                  // authenticated id (x-dev-user / JWT sub)
authCtx = getAuthContext(req)                // carries actor_type — NEVER a body field (R-AUTH)
within withTenantTx(client, tenantId):       // RLS scoped to the tenant (T-0013)
  row = SELECT tier FROM choros.<artifact-table> WHERE id = $id        // FOR UPDATE
  decision = decidePromote({ currentTier: row.tier, actorType: authCtx.actorType })
  if !decision.ok: throw HttpError(403|409, decision.code)             // no mutation, no audit
  // authority check: the actor's role must hold a grant
  //   resource_type='mgmt_object:tier_promote', operation='transition', scope ⊒ this artifact
  // resolved by the EXISTING PDP (T-0021) — NOT a new authority path.
  assertGranted(actor, "mgmt_object:tier_promote", "transition", artifactRef)
  SET LOCAL choros.promoting = '1'            // unlocks the trigger for THIS txn only
  UPDATE choros.<artifact-table> SET tier = 'published' WHERE id = $id  -- config-only flip
  // ATOMIC audit (NF-3): same transaction, canonical writer (T-0016 / T-0031).
  appendAuditEventInput(client, tenantId, {
    type: "artifact.promoted", actor, subject: $id, via: "tier-promote",
    proposed_by: null, confirmed_by: actor,        // the authenticated human confirmer
    payload: { artifact_table, tier_from: "draft", tier_to: "published" },
    occurred_at: nowMs, scope: artifactRef })
  // COMMIT — tier flip + audit row land together, or neither does (NF-2).
```

**Config-only invariant (FR-3, AC-3):** the `UPDATE` touches **only** the artifact row's `tier`. It issues **no** `INSERT`/`UPDATE`/copy against `record`, process-instance, or `audit_event` data rows. There is no data motion across the tier line — `assertGranted` failing or any exception aborts the whole transaction (no partial-published state, NF-2/AC-4).

**Forward bundle seam (T-0082 compatibility):** `promoteTier` accepts an artifact reference (and, when T-0082 lands, a coherent bundle-set) and flips the tier of the whole set in one transaction. T-0087 fixes the single-artifact contract; the bundle iteration is an additive extension that does not change this signature's meaning.

### 4.4 Published-context read scope (FR-5 / AC-6 — draft data never surfaces in prod)

```ts
// src/core/env-tier.ts — the default read tier for a request context.
// A request is published-context UNLESS it explicitly opts into draft (e.g. the
// simulation/authoring surface T-0130/T-0077). No explicit flag ⇒ published.
export function readTierScope(ctx: { draftRequested?: boolean }): Tier;
//   returns "published" by default; "draft" only when draftRequested === true.
```

Data-read endpoints (`GET /api/records`, `GET /api/instances`) and config-read endpoints add `AND tier = $readTier` (from `readTierScope`) to their queries. In the default published context this is `tier = 'published'`, so a `draft`-tagged record or instance returns 0 rows (AC-6). A draft-authoring/simulation surface passes `draftRequested = true` to see draft rows; that surface is T-0077/T-0130's, not T-0087's — T-0087 fixes only the default-deny-to-published read contract.

> **Tier vs SDLC orthogonality (FR-6/AC-9):** `readTierScope` is a per-request product concern; it never reads `NODE_ENV`/`CHOROS_ENV`/compose env. A dev Choros instance creates and serves `published` rows identically to prod (AC-9 test: create a published artifact in the dev silo — no error). FF-9 greps the config/compose for any `tier→SDLC-env` mapping and fails if present.

### 4.5 Promote authority — an ordinary `grant`, not a new subsystem (T-0018 compliance)

The right to promote is `resource_type = 'mgmt_object:tier_promote'` (a value reserved by T-0018 §4.1's `mgmt_object:*` namespace), `operation = 'transition'`, `scope` = the artifact/application subtree. It is minted, narrowed (monotonic lattice), and resolved by the **existing** grant model + PDP (T-0021). The human-gate (AC-7) is **orthogonal** to the grant: even a role *holding* the promote grant cannot promote via an `agent`-typed token (the `decidePromote` agent check fires first). Authority answers "is this principal allowed to promote this artifact"; the human-gate answers "is the *act* performed by a human, not an autonomous agent" — both must pass.

### 4.6 The `artifact.promoted` audit event (T-0016 ordinary row)

| field | value |
|---|---|
| `type` | `"artifact.promoted"` |
| `actor` | authenticated promoter id |
| `subject` | artifact id |
| `scope` | the artifact `ResourceRef` (JCS-canonicalized by the append path) |
| `via` | `"tier-promote"` |
| `proposed_by` | `null` (or the draft-author when the bundle carries one; day-1 `null`) |
| `confirmed_by` | the authenticated human promoter (AC-5) |
| `payload` | `{ artifact_table, tier_from: "draft", tier_to: "published" }` |
| `occurred_at` | caller `nowMs` |

Written via the canonical `appendAuditEventInput` (the SHA-256-chained single writer) **in the same transaction** as the tier flip (NF-3/AC-5). No new audit table, no parallel writer (T-0016). `tier_from`/`tier_to` ride the payload (AC-5).

---

## 5. Fitness functions

Each invariant is an executable CI rule. `gating`: **static-now** = a source/lint/unit check runnable in today's `npm run ci` / `npm run fitness` (the repo is zero-runtime-dep: TS + vitest + `ci/checks/*.sh` greps over migration SQL / source); **live-dev** = a live-DB probe authored now as `ci/checks/db/*.test.ts`, wired into `npm run fitness:db` (vitest `--dir ci/checks/db`) against the dev silo Postgres. All are authored now so none can be silently dropped. A new lint `ci/checks/tier-isolation.sh` is appended to `npm run fitness`; the live halves join `ci/checks/db/`.

| ID | Rule | ci_check | gating |
|---|---|---|---|
| **FF-1** | Every table in `ci/checks/tier_bearing_tables.txt` has `tier text NOT NULL DEFAULT 'draft'` + `CHECK (tier IN ('draft','published'))` in the migration DDL; the fixture lists `application,registry_def,grant,record` day-1; no listed table is missing the column (anti-drift). | `ci/checks/tier-isolation.sh`: for each table in the fixture, grep the migration SQL for the `tier` column + CHECK; FAIL if any listed table lacks it. Live: `information_schema.columns` shows `tier` on each, and the CHECK rejects `tier='x'`. | static-now (lint) + live-dev (AC-1) |
| **FF-2** | Published-locked is dual-mechanism: (a) the write-path consults `assertWritable` before any config mutation; (b) a `BEFORE UPDATE`/`BEFORE DELETE` trigger on every config table rejects mutation of a `published` row unless `choros.promoting='1'`. | `ci/checks/tier-isolation.sh`: assert the trigger function + `BEFORE UPDATE OR DELETE` trigger exist for each config table; assert no config write-handler UPDATEs a row without an `assertWritable`/promote guard (grep). Live: a direct `UPDATE`/`DELETE` on a seeded `published` row fails (app 409 / DB exception); the row is byte-unchanged; verified for `registry_def` **and** `application` (≥2 types, AC-2). | static-now (lint) + live-dev (AC-2) |
| **FF-3** | Promote is config-only: `promoteTier` issues exactly one `UPDATE … SET tier='published'` on the artifact table and **no** write to `record`/instance/`audit_event` data rows beyond the single `artifact.promoted` append. | `ci/checks/tier-isolation.sh`: grep the `promoteTier` body — no `INSERT INTO choros.record`, no instance copy, no cross-tier data motion. Live: after promote of artifact A, `count(record WHERE tier='published')` unchanged from before (draft data did not cross); `A.tier='published'`. | static-now (lint) + live-dev (AC-3) |
| **FF-4** | Promote is atomic: the tier flip and the `artifact.promoted` audit append are in one transaction; a failure after the flip and before the audit leaves the artifact `draft` and writes no audit. | Live (`ci/checks/db/tier_promote_atomic.test.ts`): inject a fault between the `UPDATE` and the append → assert `A.tier='draft'`, no `artifact.promoted` row, no row with `tier ∉ {draft,published}` (CHECK guarantees the third clause structurally). | live-dev (AC-4) |
| **FF-5** | Promote emits an `artifact.promoted` audit row with `actor`, `subject=A.id`, `tier_from='draft'`, `tier_to='published'`, written atomically (no promote without audit). | Live (`tier_promote_atomic.test.ts`): after a successful promote, the audit floor contains exactly one matching row; a forced audit-append failure rolls back the tier flip (no promote without audit). | live-dev (AC-5) |
| **FF-6** | Published-context reads default to `tier='published'`; draft rows return 0 in the default context. | Live (`ci/checks/db/tier_read_scope.test.ts`): seed ≥1 `draft` `record` + (when built) instance; `GET /api/records` / `GET /api/instances` without a draft flag returns 0 draft rows; with `draftRequested` they appear. Static-now: `readTierScope` unit returns `published` unless `draftRequested`. | static-now (unit) + live-dev (AC-6) |
| **FF-7** | Agent cannot self-promote: `decidePromote` returns `FORBIDDEN_AGENT_SELF_PROMOTE` for `actorType==='agent'`; the handler maps it to `403`; a `human` actor with authority → `200`. The gate reads the **authenticated** `actor_type` claim, never the body. | Static-now (unit) `env-tier.test.ts`: `decidePromote({currentTier:'draft', actorType:'agent'})` ⇒ forbidden; `'human'` ⇒ ok. `ci/checks/tier-isolation.sh`: grep the promote handler sets `actorType` from `getAuthContext(req)`/`extractActor`, bans `body.actor_type`/`b["is_human"]`/`b["confirmed_by"]` feeding the gate. Live: agent-token promote → 403; human-token with grant → 200. | static-now (unit+lint) + live-dev (AC-7) |
| **FF-8** | No automatic physical-contour provisioning: the tenant-onboarding / genesis path contains no `createDatabase`/`provisionContour`/new-Postgres-container call triggered by the two tiers. | `ci/checks/tier-isolation.sh`: grep the tenant-init / genesis-seed path + the promote path for `createDatabase`/`provisionContour`/`new Pool(.*new-db)`/compose-up of a per-tier DB → FAIL if present (AC-8). | static-now (lint) (AC-8) |
| **FF-9** | Tier ⟂ SDLC: no config maps `tier→Choros dev/prod` env; a dev Choros instance can create a `published` artifact. | `ci/checks/tier-isolation.sh`: grep `docker-compose*.yml` / env-config / source for any `tier.*(NODE_ENV\|CHOROS_ENV\|dev\|prod)` mapping → FAIL if present. Live: in the dev silo, `INSERT … tier='published'` (and promote) succeeds without error (AC-9). | static-now (lint) + live-dev (AC-9) |
| **FF-10** | `tier='published'` is assigned **only** through `promoteTier`: no `UPDATE … SET tier='published'` (or insert of a published row outside seed/migration) exists anywhere but the promote module. | `ci/checks/tier-isolation.sh`: grep all of `src/` for `tier` ` = ` `'published'` / `SET tier='published'`; every hit must be inside `src/core/env-tier.ts` / the promote service; any other hit ⇒ FAIL (AC-10). | static-now (lint) (AC-10) |
| **FF-11** | Tier model adds no new table and no parallel authority/audit store: `known_tenant_tables.txt` byte-unchanged; no `*_tier` table, no new authority/audit writer; promote authority is a `grant` row, promote audit is an `audit_event` row. | `ci/checks/tier-isolation.sh`: assert the migration is additive-`ALTER TABLE`-only (no `CREATE TABLE`), `known_tenant_tables.txt` unchanged in the diff; grep bans a new `tier`/`environment` authority/audit table; assert promote authority uses `mgmt_object:tier_promote` `grant` + `appendAuditEventInput`. | static-now (lint) (NF-4 / T-0016 / T-0018) |

**CI wiring.** `ci/checks/tier-isolation.sh` is appended to the `npm run fitness` chain (alongside the existing `*-isolation.sh` checks). The new unit suite `src/__tests__/env-tier.test.ts` joins `vitest run`. The live probes `ci/checks/db/tier_promote_atomic.test.ts` / `tier_read_scope.test.ts` join `npm run fitness:db`. The `tier_bearing_tables.txt` fixture is the single source of truth iterated by the lint, the trigger-generation, the read-scope helper, and the live probes.

---

## 6. Traceability (AC-1..AC-10 → design)

| AC | Covered by |
|---|---|
| **AC-1** (tier column + CHECK + NOT NULL DEFAULT on config tables; migration-test per table) | §4.1 `tier` column + `tier_bearing_tables.txt` registry · **FF-1** |
| **AC-2** (direct write to published → 409 PUBLISHED_LOCKED; row unchanged; ≥2 types) | §4.2 `assertWritable` + `tier_published_locked` trigger (dual) · **FF-2** |
| **AC-3** (promote config-only; data not copied to published) | §4.3 single-`UPDATE` config-only invariant · **FF-3** |
| **AC-4** (promote atomic; mid-failure leaves draft, no audit, no intermediate state) | §4.3 `withTenantTx` one-transaction + CHECK structural third-state bar · **FF-4** |
| **AC-5** (`artifact.promoted` audit row with actor/artifact/tier_from/tier_to, atomic) | §4.3 same-txn append + §4.6 event shape · **FF-5** |
| **AC-6** (published-context reads return 0 draft rows; records + instances) | §4.4 `readTierScope` default `published` + `AND tier=$readTier` · **FF-6** |
| **AC-7** (agent self-promote → 403; human-confirmed → 200) | §4.3 `decidePromote` agent check + §4.5 authenticated `actor_type` gate · **FF-7** |
| **AC-8** (no auto physical-contour provision on two tiers) | §2 single-silo + §3 (physical contour = on-demand) · **FF-8** |
| **AC-9** (tier ⟂ SDLC; published artifact creatable in dev Choros) | §4.4 orthogonality note + FR-6 · **FF-9** |
| **AC-10** (`tier='published'` set only via promoteTier) | §4.3 sole transition + §2.2 trigger-gated promote-only path · **FF-10** |

Every AC-1..AC-10 maps to at least one fitness function. The cross-cutting NF-4 / T-0016 / T-0018 no-new-store invariant is additionally guarded by **FF-11**.

---

## 7. Runtime / deploy target

**Local + dev silo** (no new external resource). The pure `src/core/env-tier.ts` module runs in-process under `npm run ci` (static-now). The `tier` column, the published-locked trigger, the `promoteTier` service, and the `POST /api/artifacts/:id/promote` handler activate in the **already-live** Postgres silo (`/srv/choros`, dev stack, T-0065 DONE) via an **additive idempotent migration** applied by `migrations/run.mjs` — the `030`/`031` precedent. **No new Postgres container, no new schema, no new service** (NF-4). `known_tenant_tables.txt` is byte-unchanged (additive columns on already-registered tenant tables).

**Infra dependency — NOT built in T-0087 (design-only):** the additive `ALTER TABLE … ADD COLUMN tier` migration, the `tier_published_locked` trigger DDL, the `promoteTier` service + endpoint, the read-scope wiring on `GET /api/records|/instances`, the live probes, and the `tier-isolation.sh` lint are the **coder's** deliverables on the dev silo. T-0087 fixes the invariants, the object model, the contracts (`assertWritable` / `decidePromote` / `readTierScope` / `promoteTier` / the `artifact.promoted` event), and the fitness functions. No founder server-provision gate (GT-4) is needed — the dev silo already exists; promotion to prod (GT-2) stays founder-gated, unchanged by this ADR.

---

## 8. Escalation

**None.** The "two logical tiers in one silo, config-only promotion, managed/locked prod, physical contour on-demand, agent-proposes-human-promotes" shape is the **founder-ratified §8 synthesis** of the extensibility-and-authoring ADR (the adversarial-debate result the founder signed). T-0087 pins its data model and read/write contract onto the existing T-0013/T-0014/T-0016/T-0018/T-0044 foundation **without re-opening any of them** and **without inventing a new authority or audit subsystem**. The one consequential reconciliation — that the spec's AC-named config tables (`process_definition`, `form_definition`, `dmn_table`, `nav_config`) do not yet exist — is resolved **conservatively and inside scope**: T-0087 defines `tier` as a *registered convention + forward fitness gate* over the tables that exist today, rather than building E12/T-0082's table inventory (which would be the gold-plating / scope-bleed the rubric forbids). That is an implementation-shape decision under the ratified `founder-autonomy-impl` frame (DB/schema/wiring is autonomous), not a product-direction fork — so it is recorded here, not escalated. The friction note for the next phase: **FE-2026-W24-0087-A** — when E12 builds `process_definition`/`form_definition`/`dmn_table`/`nav_config`/process-instance, each MUST append itself to `ci/checks/tier_bearing_tables.txt` and inherit the `tier` column under FF-1; the resolver/read-paths for those tables MUST apply `readTierScope` (so a future config table does not silently leak draft into published).
