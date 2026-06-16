# T-0213 / P-5 — docs-pipeline: install-runbook as `scope='system'` docs + provision projection (ADR)

> **Status:** DESIGN — contract for BUILD + adversarial review.
> **Parent ADRs:** `docs/design/T-0134-agent-docs.adr.md` (docs-layer frame, esp. **§2.4 system-doc per-tenant projection**, the load-bearing R-1 invariant),
> `docs/design/T-0211-doc-regen.adr.md` (P-3 REGEN store write-layer + purity seam — reused, not re-invented),
> `docs/design/T-0212-doc-reconcile.adr.md` (P-4 idempotency / draft-first rigor template),
> `docs/design/T-0127-genesis-installer.adr.md` (genesis red-line: one-directional, no kill-switch in core; **the analog here is: genesis must not depend on the docs pipeline**).
> **Substrate (read-only, composed not re-invented):**
> `src/db/doc-page-store.ts` (P-3 `upsertDocPage`/`setDocRefs`/`appendDocLog`), `src/core/doc-ref-lint.ts` (`checkDocRefs`, closed `config_key`/`rest_endpoint` vocab — T-0238),
> `src/core/doc-live-snapshot.ts` (T-0239 collector: `restEndpoints` from `router.register`, `configKeys` from `mcp_tool.name`),
> `migrations/061_doc_page.sql` (schema: `scope ∈ {system,tenant}`, `catalog_version`, the two UNIQUE constraints), `migrations/062_docs_author_seed.sql` / `026_genesis_owner_seed.sql` (the seed-migration provision pattern), `migrations/run.mjs` (the migrator runner genesis already invokes via `ops/docker-entrypoint.sh`).
> **Pipeline:** research-3 docs-pipeline row **P-5** ("install-runbook as system docs + projection at provision").
> **Scope:** ONE governed, idempotent **projection** of the product install-runbook page(s) (`scope='system'`) into a tenant **at provision time**, with install-fact (`config_key` / `rest_endpoint`) refs that lint-clean against the live `LiveSnapshot`. **One-directional:** genesis never reaches into the pipeline.

---

## 1. Context & contract

P-3 (T-0211) built the REGEN motor that turns the `LiveSnapshot` into `scope='tenant'` pages, and the store write-layer (`upsertDocPage`/`setDocRefs`/`appendDocLog`) in `src/db/doc-page-store.ts`. P-4 (T-0212) added RECONCILE. **Both write only `scope='tenant'` pages into a single tenant.** Neither implements the **`scope='system'` per-tenant projection** that T-0134 §2.4 reserved (the R-1 decision: system docs live as ordinary per-tenant rows, NOT a second RLS predicate, NOT a cross-tenant read).

**P-5 (this ADR) is that projection, materialized for ONE concrete system doc: the install-runbook.** The product install-runbook (`docs/runbooks/install.md`, T-0127) becomes a **`scope='system'` `doc_page`** that anchors install-facts as typed `config_key` / `rest_endpoint` refs, and is **projected into a tenant when that tenant is provisioned**. This is **governed replication** (T-0133-class managed-solution, T-0134 §2.4) — NOT runtime generation, NOT REGEN.

### 1.1 Acceptance (from research-3 P-5)

1. A runbook page **is projected into the tenant when it is provisioned** (a `scope='system'` `doc_page` row with `tenant_id = <that tenant>` appears).
2. `config_key`-refs (and `rest_endpoint`-refs) **lint clean against the live `LiveSnapshot`** (the install-facts resolve against the running system the collector sees).
3. **RED-LINE:** the genesis/installer (T-0127/T-0198) must **NOT depend on the docs pipeline** — the coupling is **one-directional** (provision triggers projection; the pipeline never reaches into genesis).

### 1.2 What this ADR is NOT (deferred seams)

- **NOT a generator.** The runbook *content* is a checked-in product source-of-truth (a fixture, §3), not REGEN'd from live state. Only its install-fact **refs** are validated against the live snapshot. (Contrast: REGEN *generates* `scope='tenant'` page bodies from the snapshot.)
- **NOT the full vendor-update merge machinery** (T-0133 §3.6 / T-0134 §2.4 vendor-update). Day-1 = **idempotent re-projection of the current package** with `catalog_version`; locally-edited-projection 3-way merge is Stage-2. (System projections are read-only origin inside a tenant; a tenant edit is an ordinary grant-deny, not a special path — §2.4 framing.)
- **NOT a second system doc beyond the install-runbook.** P-5 ships the install-runbook package (one page family); the projection *mechanism* generalizes, but the seeded content is just the runbook.
- **NOT a new authority mechanism, NOT a new RLS path, NOT a new resource_type.** Projection rides the migrator-role seed path that 026/044/062 already use (§4); reads ride the single `tenant_id` RLS predicate (T-0134 §2.4).

---

## 2. The genesis red-line and how the seam proves it (load-bearing §)

### 2.1 What genesis actually is (discovery — not a runtime per-tenant call)

There is **no `provisionTenant()` / `bootstrapTenant()` runtime function**. Tenant bootstrap in MVP is **migration-seeded**: the genesis owner (`migrations/026_genesis_owner_seed.sql`), the config-agent (`044`), the DocsAuthorAgent (`062`) — all are **INSERT-only data seeds** run by `migrations/run.mjs` **as the `choros_migrator` role** (which bypasses FORCE-RLS by nature — the legitimate provision-time context-obviating operation T-0134 §2.4 names), invoked by `ops/docker-entrypoint.sh` **before** the app server starts. `ops/install.sh` (T-0198) is a one-shot bash wrapper that `docker compose up`s the stack; the entrypoint runs migrations; genesis is **ignorant of what any individual migration does** — it only runs the lexicographically-ordered `migrations/NNN_*.sql` files.

**Therefore the provision hook = a new seed migration `065_install_runbook_projection.sql`.** "Provision triggers projection" = the migration runner (which genesis already invokes) applies `065` in the same pass that applies `026`/`062`. The tenant receives the projected runbook page exactly as it receives the genesis owner: as an idempotent seed row, written by the migrator role, before any external/harness read.

### 2.2 Why this is *the* one-directional seam (and statically provable)

The red-line is "genesis must not depend on the docs pipeline." The seam makes the dependency **structurally impossible**, because:

- `065_install_runbook_projection.sql` is **pure SQL data** (INSERT … ON CONFLICT DO NOTHING). It imports **nothing** — not `src/core/doc-*`, not `src/db/doc-page-store.ts`, not the collector. It writes `doc_page`/`doc_ref`/`doc_log` rows directly (it is a *seed*, exactly as `062` writes `role`/`grant` rows directly).
- `ops/install.sh`, `ops/docker-entrypoint.sh`, `migrations/run.mjs`, `src/vendor/*` (the genesis/installer modules) **import no `src/core/doc-*` or `src/db/doc-*` module.** The direction is: *the migration runner applies a data file*; the data file does not reach back into TypeScript, and genesis does not reach into the pipeline.
- The pipeline (REGEN/RECONCILE TS code) likewise **never imports** `migrations/run.mjs`, `ops/install.sh`, or `src/vendor/activation.ts`. There is no edge from pipeline → genesis.

This is enforced by **F-7 (static guard `ci/checks/install-runbook-projection.sh`)**, which greps the genesis/installer surface for **any** import of a doc-pipeline module → must be **absent** (mirrors `no-killswitch-in-core.sh`'s grep-invariant shape and `doc-regen-isolation.sh`'s forbidden-import sweep). The guard proves the seam in both directions: genesis ⇏ pipeline (the red-line) and pipeline ⇏ genesis (no back-edge).

> **Why a seed-migration and NOT an operator script (`scripts/install-runbook-project.ts`)?** An operator script would couple the projection to TS pipeline code, and would NOT run at provision time (it is operator-triggered, like `docs:regen`). The acceptance is specifically *"projected when the tenant is **provisioned**"*. Provision = migration-seed time. A seed migration is the only hook that (a) fires at provision, (b) runs as the migrator (the only role that may write `scope='system'` rows into a tenant per §2.4's provision-writer authority), and (c) carries **zero dependency** on the pipeline. **This is why `needs_migration = true`** (§7) — the projection IS the seed, it is not optional code-only.

---

## 3. Runbook content: source-of-truth and install-fact anchoring

### 3.1 Source-of-truth (pinned)

The canonical install-runbook is the **already-checked-in product doc `docs/runbooks/install.md`** (T-0127). P-5 does **not** author new prose. The `065` seed embeds the runbook's **install-relevant slice** as the projected `doc_page.body` (a stable, deterministic Markdown rendering — the same idempotency discipline as REGEN bodies, §6). BUILD copies the operative section (the one-command flow, ports, endpoints) verbatim from `install.md` into the seed; a coherence guard (F-6) asserts the seeded page's referenced facts stay in sync with the live system (the refs, below), so the projection cannot silently rot.

> **One either/or left to BUILD (pinned by F-1/F-6):** the seed MAY embed the full `install.md` body OR a curated install-summary body. Either is acceptable; the MUST is: the page exists with `scope='system'` and carries ≥1 lint-clean `rest_endpoint` ref + ≥1 lint-clean `config_key` ref. F-1 pins existence+scope; F-3 pins lint-clean refs.

### 3.2 Install-facts → typed refs, lint-clean against the LiveSnapshot (the correctness invariant)

The runbook documents **install-facts**: the endpoints the installer verifies and the config keys it touches. These become **typed `doc_ref` rows** shaped EXACTLY as `resolveRef` (doc-ref-lint.ts) keys them, so `checkDocRefs(runbookRefs, live)` is `{ ok: true }`:

| Install-fact in runbook | ref_kind | ref_target (exact keys) | Resolves against (collector source) |
|---|---|---|---|
| Health-verify endpoint (`GET /health`) | `rest_endpoint` | `{ method: 'GET', path: '/health' }` | `live.restEndpoints` ← `router.register("GET","/health")` in `src/server.ts:146` |
| Activation-status endpoint (`GET /vendor/activation`) | `rest_endpoint` | `{ method: 'GET', path: '/vendor/activation' }` | `live.restEndpoints` ← `router.register` in `src/http/vendor-activation.ts:102` |
| A config-agent tool key the runbook references (e.g. `emit_form_code`) | `config_key` | `{ key: '<mcp_tool.name present in tenant>' }` | `live.configKeys` ← `SELECT name FROM mcp_tool` (collector `collectConfigKeys`) |

**Honest pinning of the acceptance phrase "lint against the live compose/.env" (DESIGN DECISION D-1).** The acceptance text says install-facts (ports/endpoints) lint against compose/.env. **The `LiveSnapshot` collector (T-0239) does NOT read compose/.env** — `restEndpoints` derive from `router.register` call sites in `src/` and `configKeys` from `mcp_tool.name`. Inventing a new "compose/.env collector" source would be a **new collector mechanism on a frozen module** (`doc-live-snapshot.ts`), violating "compose existing pieces, no new mechanism" and the additive constraint. **Resolution:** the runbook anchors its install-facts to the collector's *actual* sources — which ARE the live install-relevant surface:
- The endpoints the installer's **verify** step (`GET /health`) and **activation** report (`GET /vendor/activation`) hit are *the very HTTP endpoints* the runbook documents, and they are registered routes the collector sees → `rest_endpoint` refs lint clean against the **running system** (the spirit of "lint against live", honestly).
- `config_key` refs anchor to live `mcp_tool` keys the tenant actually has (collector source), not fabricated compose strings.

This keeps the refs **lint-clean by construction** (they are derived from the same collector the lint uses) and avoids a frozen-module change. The runbook's prose may *mention* host ports (55432/8180/…) as documentation text, but those are **not** typed refs (no `config_key`/`rest_endpoint` collector source exists for host ports) — they are body content, not lint-checked refs. **If the founder/BUILD later wants host-ports lint-checked, that requires extending the collector with a compose/.env source = a separate task on `doc-live-snapshot.ts`, explicitly out of P-5 scope (noted §10 open-risk).**

### 3.3 `scope='system'` + `catalog_version` (the projection markers)

The projected page is written with `scope='system'`, `authored_by='system'`, and a non-null `catalog_version` (the system-docs package version, e.g. `'install-runbook.v1'`) — per T-0134 §2.4 and migration 061 (`catalog_version` nullable, required-null only for `scope='tenant'`; non-null carries the package version for `scope='system'`). `stale=false`, `app_id=NULL`.

---

## 4. Projection mechanism (idempotent, one-directional, tenant-scoped)

### 4.1 The seed migration `065_install_runbook_projection.sql`

Mirrors `026`/`062` exactly (pure data seed, run by the migrator role):

```sql
-- 065 · install-runbook projection (T-0213 · P-5 · docs-pipeline)
-- Projects the product install-runbook as a scope='system' doc_page into the
-- dev-tenant, anchoring install-facts as typed config_key/rest_endpoint refs.
-- ADDITIVE & IDEMPOTENT: INSERT-only, ON CONFLICT DO NOTHING. No DDL.
-- known_tenant_tables.txt unchanged (doc_page/doc_ref/doc_log listed since 061).
-- One-directional: this file imports NOTHING from the docs pipeline (it IS data).
--   DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
--   PAGE_ID         = <stable uuid, d…/c… namespace next-free>
--   slug            = 'system/install-runbook'   (stable — idempotency key)
--   catalog_version = 'install-runbook.v1'

INSERT INTO choros.doc_page
  (tenant_id, id, slug, title, body, summary, scope, catalog_version, app_id,
   stale, authored_by, authored_at, updated_at)
VALUES
  ('a0000000-…-001', '<PAGE_ID>', 'system/install-runbook',
   'Установка и обновление (genesis-runbook)', $body$…verbatim install slice…$body$,
   'Установка одной командой ops/install.sh; verify GET /health; статус активации.',
   'system', 'install-runbook.v1', NULL, false, 'system', 0, 0)
ON CONFLICT (tenant_id, slug) DO NOTHING;   -- re-run = no dup (idempotency)

INSERT INTO choros.doc_ref
  (tenant_id, id, page_id, ref_kind, ref_target, broken, created_at)
VALUES
  ('a0000000-…-001', '<REF1>', '<PAGE_ID>', 'rest_endpoint',
   '{"method":"GET","path":"/health"}'::jsonb, false, 0),
  ('a0000000-…-001', '<REF2>', '<PAGE_ID>', 'rest_endpoint',
   '{"method":"GET","path":"/vendor/activation"}'::jsonb, false, 0),
  ('a0000000-…-001', '<REF3>', '<PAGE_ID>', 'config_key',
   '{"key":"<live mcp_tool name>"}'::jsonb, false, 0)
ON CONFLICT (tenant_id, page_id, ref_kind, ref_target) DO NOTHING;

INSERT INTO choros.doc_log
  (tenant_id, id, page_id, op, agent_actor, diff_summary, at)
VALUES
  ('a0000000-…-001', '<LOG1>', '<PAGE_ID>', 'system_doc_projected', 'system',
   'install-runbook.v1 projected at provision', 0)
ON CONFLICT DO NOTHING;
```

- **Idempotency:** stable `slug='system/install-runbook'` + `UNIQUE(tenant_id, slug)` → re-provision / re-run migrations = `ON CONFLICT DO NOTHING`, zero duplicate pages. Refs keyed on `UNIQUE(tenant_id, page_id, ref_kind, ref_target)` → `DO NOTHING`, no duplicate refs. `doc_log` is append-only history but the seed uses fixed UUIDs + `ON CONFLICT DO NOTHING`, so re-applied migration = no new log row either. (`migrations/run.mjs` already skips already-recorded versions, so `065` runs once per fresh DB anyway; `ON CONFLICT` is the belt-and-suspenders for re-clone/re-template.)
- **One-directional:** the file is data; it imports nothing. Genesis runs it without knowing it is "the docs pipeline."
- **Tenant-scoped + provision-writer authority (§2.4):** written by the migrator role (the only role that may write `scope='system'` rows into a tenant — the legitimate provision-time RLS-obviating operation, T-0134 §2.4 "Write-путь проекции = provision-time системная операция"). It writes **only** `scope='system'` rows into the dev-tenant — never `scope='tenant'` via this path (F-4 static grep).
- **`op='system_doc_projected'`** is the exact open-vocab label T-0134 §2.4 / migration 061's column comment names for projection.

### 4.2 New-tenant generalization (pinned, day-1 = dev-tenant)

MVP provisions **one** tenant via seed migrations (the dev-tenant `a0…001`). The projection seeds into that tenant. When a **new** tenant is provisioned (Stage-2 multi-tenant, or a fresh silo install), the **same `065` seed pattern** projects the runbook into it — the seed is parameterized only by `tenant_id`. Because day-1 has one seeded tenant, `065` targets `a0…001`; the **mechanism** (a `scope='system'` projection seed keyed on `(tenant_id, slug)`) is what generalizes, and the db fitness test (F-1) proves it on a **fresh random tenant** (T-0205 discipline) by applying the projection's INSERT shape to that tenant, so the test does not assert against the shared dev-tenant fixture.

---

## 5. Authority argument (no new grant/tool; reuse §2.4 provision-writer)

**No new grant, no new tool, no new resource_type, no promote.**

- The **write** of a `scope='system'` row into a tenant is, by T-0134 §2.4's explicit decision, a **provision-time migrator-role operation** — the same class as `026`/`044`/`062` seeds. It does **not** use the DocsAuthorAgent's `{doc_page,create/update}` grants (those are `choros_app`, NOBYPASSRLS, and may write only `scope='tenant'` — REGEN's lane, T-0211 §10). The projection-writer is the migrator, and its authority is structural (migrator bypasses FORCE-RLS), audited (`doc_log('system_doc_projected')`), and **unavailable to the harness/external surface** (the migrator role is never handed to a harness principal — T-0122 `delegable=false`).
- **Why a distinct authority from `scope='tenant'` REGEN (justified precisely):** writing `tenant_id=B, scope='system'` is a cross-origin replication that `choros_app` **cannot** do (FORCE-RLS `WITH CHECK` blocks any row whose `tenant_id` ≠ the GUC, and the DocsAuthorAgent has no `scope='system'` authority). Only the provision-time migrator may. This is not a new mechanism — it is the **existing seed-migration authority** (026/062). REGEN's `choros_app` lane is *deliberately* unable to project system docs (T-0211 §10 privilege checklist (a)/(b)) — P-5 does not weaken that; it uses the orthogonal, pre-existing provision lane.
- **Reads** of the projected page (UI / docs-MCP / lint) ride the **single `tenant_id` RLS predicate** — system docs are ordinary `tenant_id=<his>` rows (T-0134 §2.4). **Zero second RLS predicate, zero cross-tenant read, zero context-switch** (the R-1 invariant). F-5 asserts no second authz path is introduced.

---

## 6. Idempotency + draft-first (consistent with P-3/P-4)

- **Idempotent** per §4.1: stable slug, `ON CONFLICT DO NOTHING` on all three tables, `migrations/run.mjs` version-skip. Re-provision = zero new rows.
- **Draft-first / no-promote:** there is no `published`/`status` column (SEAM-2 deferred, T-0134d). The projected page is `scope='system'` (origin marker), `stale=false`. A tenant cannot edit it via the normal write path (it would need `scope='system'` write authority it does not hold — ordinary grant-deny, not a special lock). No promote power is introduced.
- **Body stability:** the seeded `body` is fixed text (a checked-in slice), so it is byte-stable across provisions — no churn. (Unlike REGEN, no per-run regeneration.)

---

## 7. Migration decision: **`065` required (justified)**

**`needs_migration = true`, slot `065`** (`064` = `doc_page.summary`, T-0214; `065` is next-free). **Justification (not gold-plating):** the acceptance is *"projected when the tenant is provisioned."* Provision = seed-migration time (§2.1 discovery: there is no runtime per-tenant provision call). A seed migration is the **only** hook that fires at provision **and** keeps genesis one-directional (it is data, importing nothing). A code-only / operator-script approach would (a) not fire at provision and (b) couple to the pipeline. The migration is a **pure additive data seed** (INSERT-only, `ON CONFLICT DO NOTHING`) — **no DDL, no new table, no new column, no vocab change** (`scope`/`catalog_version`/`config_key`/`rest_endpoint` all already exist). `ci/checks/known_tenant_tables.txt` unchanged (doc tables listed since 061). This is structurally identical to `026`/`062`, which are themselves data-seed migrations.

---

## 8. Architecture summary

```
  genesis (ops/install.sh, T-0198)         migrations/run.mjs (migrator role)
  ┌────────────────────────────┐  invokes  ┌──────────────────────────────────┐
  │ docker compose up           │ ───────▶ │ applies 026,…,062, 065_install_…  │
  │ (ignorant of migrations'    │          │ 065 = pure-SQL data seed:          │
  │  contents — runs NNN_*.sql) │          │   INSERT scope='system' doc_page   │
  └────────────────────────────┘          │   + typed install-fact doc_refs    │
         NO import of doc-* pipeline       │   + doc_log('system_doc_projected')│
              (F-7 static guard)           └──────────────────────────────────┘
                                                       │ (no import back into genesis)
                                                       ▼  reads ride single tenant_id RLS
  lint/UI/docs-MCP ── checkDocRefs(runbookRefs, LiveSnapshot) == { ok:true }  (F-3)
```

The projection is **data the migrator writes**; genesis runs the migrator; neither reaches into `src/core/doc-*` or `src/db/doc-*`. The pipeline's lint (`checkDocRefs`, collector) is exercised **by the fitness tests** against the seeded refs — proving the install-facts resolve, without genesis touching the pipeline at runtime.

---

## 9. Machine-checkable fitness criteria (F-1 .. F-8)

> **db-tier tenant note (T-0205):** db tests run the projection's INSERT shape against a **fresh random tenant** (never mutate the shared dev-tenant fixture), PLUS a static assertion that `065` targets the dev-tenant UUID `a0…001`. The "≥1 system page with lint-clean refs" guarantee holds on any tenant because `restEndpoints` are build-time (collector reads `src/`), tenant-independent.

### F-1 — runbook page projected at provision, `scope='system'` (db)
After applying the projection (fresh-tenant analog of `065`):
```sql
SELECT scope, catalog_version FROM choros.doc_page
 WHERE tenant_id = $1 AND slug = 'system/install-runbook';
```
Assert exactly one row, `scope='system'`, `catalog_version IS NOT NULL`, `authored_by='system'`, `stale=false`. (Acceptance #1.)

### F-2 — idempotent re-projection: no duplicate (db)
Apply the projection twice on the same tenant. Assert `doc_page` count for `slug='system/install-runbook'` = **1**, `doc_ref` count for that page unchanged, page `id` unchanged. (`ON CONFLICT DO NOTHING` proven.) `doc_log('system_doc_projected')` rows also do not duplicate (fixed-UUID + `ON CONFLICT`).

### F-3 — install-fact refs lint-clean against the LiveSnapshot (db + unit) — Acceptance #2
- Build/assemble a `LiveSnapshot` (the static collector for `restEndpoints` over `src/`; configKeys from the tenant's `mcp_tool`). Read the projected page's `doc_ref` rows; map to `DocRef[]`; call `checkDocRefs(refs, live)` → expect `{ ok: true }`.
- Assert the two `rest_endpoint` refs (`GET /health`, `GET /vendor/activation`) are present and each resolves (`live.restEndpoints` contains `GET /health` and `GET /vendor/activation` — both are real `router.register` sites).
- Assert ≥1 `config_key` ref present and resolving against `live.configKeys`.
- Negative sub-test: a snapshot missing `/health` makes `checkDocRefs` report the missing referent — proving the test actually exercises the lint (not a vacuous pass).

### F-4 — projection writes ONLY `scope='system'` (static) — §2.4 provision-writer boundary
Static grep of `migrations/065_install_runbook_projection.sql`: every `INSERT INTO choros.doc_page` row sets `scope='system'`; **no** `scope='tenant'` write via this seed (mirrors T-0134 §2.4 FF-DOCS-PROJECTION-WRITE). All rows target a single `tenant_id`.

### F-5 — no second authz path; reads ride single `tenant_id` RLS (db + static)
- Db: a second tenant cannot see the projected page (cross-tenant probe, mirrors `cross_tenant.test.ts`): `SET LOCAL choros.tenant_id = <tenantB>` → `SELECT … WHERE slug='system/install-runbook'` returns 0 rows for tenant B. The projection lives as tenant A's ordinary row; tenant B has its own projection only if seeded for B.
- Static: no new RLS policy, no `USING (scope=…)` predicate added anywhere (grep migrations for any `scope`-based RLS policy → none). The single `tenant_id` predicate (061) is the only read path.

### F-6 — one-directional genesis seam: genesis does NOT import the pipeline (static guard `ci/checks/install-runbook-projection.sh`) — Acceptance #3 RED-LINE
New static guard (mirrors `no-killswitch-in-core.sh` grep-invariant + `doc-regen-isolation.sh` forbidden-import shape), with `--self-test`:
- `migrations/065_install_runbook_projection.sql` exists; is **pure SQL** (no shell, no `\i`, no `COPY … FROM PROGRAM`); imports nothing.
- **Genesis surface carries NO import of any doc-pipeline module.** Grep `ops/install.sh`, `ops/docker-entrypoint.sh`, `migrations/run.mjs`, `src/vendor/activation.ts`, `src/vendor/entitlement.ts`, `src/http/vendor-activation.ts` for any reference to `doc-page-store`, `doc-regen`, `doc-reconcile`, `doc-ref-lint`, `doc-live-snapshot`, `scripts/doc-` → **must be absent** (0 hits).
- **No back-edge:** grep `src/core/doc-*.ts`, `src/db/doc-page-store.ts`, `scripts/doc-*.ts` for any import of `migrations/run`, `ops/install`, `src/vendor/activation` → **must be absent**.
- `065` carries **no** owner/genesis SQL (no `INSERT INTO choros.role_assignment` with `source='genesis'`, no `mgmt_object` grant) — it is docs-only; genesis's owner path stays migration 026's sole responsibility.
- **`--self-test`:** plant a fixture genesis file that imports `doc-page-store`, assert the guard flags it; plant a `065` with a shell escape, assert flagged.

### F-7 — additive only: no new grant/tool/resource_type/table/column; frozen + known_tables unchanged (static + db)
- `065` is the ONLY new migration; it is INSERT-only (no `CREATE TABLE`, no `ALTER TABLE`, no `CREATE POLICY`). Grep asserts no DDL keyword in `065`.
- `choros."grant"` count for `docs-author` (`e0…005`) unchanged = 2 (P-1's grants); **no new grant row** introduced by `065` (the projection uses migrator authority, not a grant).
- No new `mcp_tool` row; no new `role`/`role_assignment` for docs.
- `ci/checks/known_tenant_tables.txt` unchanged; `ci/checks/frozen-sanctions.jsonl` unchanged.
- Frozen files unchanged: `src/core/doc-ref-lint.ts`, `src/core/doc-live-snapshot.ts`, `migrations/061_doc_page.sql`, `migrations/062_docs_author_seed.sql`, `migrations/063_docpage_writeful_tools.sql`, `migrations/026_genesis_owner_seed.sql`, `ops/install.sh`, `migrations/run.mjs`.

### F-8 — audit/log emitted, secret-free (db)
Assert ≥1 `doc_log` row with `op='system_doc_projected'` for the projected page, `agent_actor='system'`, tenant-scoped, `diff_summary` carries the `catalog_version` and **no secret**. (Per T-0134 §2.4: projection is audited via `doc_log('system_doc_projected')` + the framing ADR's `audit_event('docs.system_projected')`; for a pure-SQL seed the `doc_log` row is the in-band record — a run-level `audit_event` is **not** emitted by a data seed and is **not** required for a seed-time projection. The MUST is: the `doc_log('system_doc_projected')` row exists and is secret-free.)

---

## 10. Open risks / deferrals

- **`config_key` host-ports vs collector source (D-1).** The acceptance's "lint against compose/.env" is honored via the collector's *actual* sources (registered endpoints + `mcp_tool` keys), NOT a new compose/.env collector. Host-ports as lint-checked refs would require extending `doc-live-snapshot.ts` with a compose/.env source — **a separate task on the frozen collector, explicitly out of P-5 scope.** Risk: a reviewer reads "compose/.env" literally and expects port-refs. Mitigation: §3.2 D-1 pins the honest interpretation; F-3 proves the refs that *do* exist lint clean against the real collector.
- **Multi-tenant projection generalization (Stage-2).** Day-1 seeds one tenant (`065` → `a0…001`). A runtime "project into every new tenant" loop is Stage-2 (needs a per-tenant provision call that does not yet exist). F-1's fresh-tenant test proves the *mechanism* generalizes; the *seed* targets the one day-1 tenant.
- **Vendor-update vX→vY re-projection (Stage-2).** `catalog_version` is seeded; the day-1 update path is "re-apply a higher-versioned seed migration `066`" (re-projection with notification). 3-way merge of locally-edited projections is T-0133-class Stage-2 (T-0134 §2.4).

---

## 11. Build plan (for the coder)

1. **`migrations/065_install_runbook_projection.sql`** — pure data seed (§4.1): one `scope='system'` `doc_page` (slug `system/install-runbook`, `catalog_version='install-runbook.v1'`, body = verbatim install slice from `docs/runbooks/install.md`), the typed `doc_ref` rows (2× `rest_endpoint` for `/health` + `/vendor/activation`, ≥1 `config_key` for a live `mcp_tool` name), one `doc_log('system_doc_projected')`. Stable UUIDs (d…/c… next-free namespace), `ON CONFLICT DO NOTHING` on all. No DDL.
2. **`ci/checks/install-runbook-projection.sh`** (+ `--self-test`) — the F-6 one-directional guard (genesis ⇏ pipeline, pipeline ⇏ genesis, `065` is pure SQL with no shell escape, no genesis-owner SQL). Wire into `npm run fitness` (append after `doc-summary-no-body-in-index.sh --self-test`, with its `--self-test` immediately after — matching the repo convention).
3. **`ci/checks/db/install-runbook.db.test.ts`** — db tests F-1, F-2 (idempotent re-apply), F-3 (lint-clean against assembled `LiveSnapshot` — reuse `assembleStaticSnapshot`/`collectRestEndpoints` for endpoints + a tenant `mcp_tool` read for configKeys; reuse `readDocPages`/`readDocRefs` from the store), F-4 (scope grep is static — but db side asserts the seeded row is `scope='system'`), F-5 (cross-tenant invisibility), F-7 (grant count unchanged), F-8 (doc_log). Fresh-tenant fixture per T-0205; static assert `065` targets `a0…001`.
4. **No change to** `ops/install.sh`, `migrations/run.mjs`, `src/core/doc-*`, `src/db/doc-page-store.ts` (the store is *reused* by the test to read rows, not modified), `src/core/doc-live-snapshot.ts`. No `package.json` script (this is provision-time, not an operator command).
5. **Adversarial review focus:** (a) F-6 genesis no-import both directions is real (not a vacuous grep); (b) the `config_key` ref's key is an actual `mcp_tool.name` present in the tenant (else F-3 fails honestly — do NOT fabricate); (c) `065` writes only `scope='system'` (F-4); (d) idempotent re-apply produces zero dup (F-2); (e) no second RLS predicate (F-5); (f) `065` has no DDL and no genesis-owner SQL (F-7).

**Fitness wiring summary:** db tests under `npm run fitness:db` (vitest `--dir ci/checks/db --no-file-parallelism`); the static guard `install-runbook-projection.sh` appends to the `fitness` script chain (with `--self-test` immediately after, per the `<check>.sh && <check>.sh --self-test` convention).

---

## 12. Decisions summary

| Decision | Choice | Rationale |
|---|---|---|
| **Provision hook (D-2)** | seed migration `065_install_runbook_projection.sql` (pure SQL data, run by migrator via `run.mjs`, before app start) | provision = seed-migration time (no runtime provision call exists); only hook that fires at provision AND stays one-directional (data imports nothing) |
| **One-directional seam (D-3)** | `065` is data; genesis (`install.sh`/`run.mjs`/`vendor/*`) imports no doc-pipeline module; pipeline imports no genesis module | F-6 static guard proves both directions; red-line structurally impossible to violate |
| **Authority (D-4)** | provision-time migrator role (same as 026/062), writes only `scope='system'`; reads ride single `tenant_id` RLS | T-0134 §2.4 provision-writer; no new grant/tool/resource_type; REGEN's `choros_app` lane stays unable to project system docs |
| **Install-fact anchoring (D-1)** | `rest_endpoint` refs (`GET /health`, `GET /vendor/activation`) + `config_key` refs (live `mcp_tool` names), lint-clean against the collector's real sources | collector has no compose/.env source; refs derived from same collector the lint uses ⇒ clean by construction; host-ports-as-refs = Stage-2 collector extension (out of scope) |
| **Content source (D-5)** | checked-in `docs/runbooks/install.md` slice, seeded verbatim as `scope='system'` body; deterministic/stable | not generated (P-5 ≠ REGEN); byte-stable across provisions |
| **Idempotency (D-6)** | stable `slug='system/install-runbook'` + `UNIQUE(tenant_id,slug)` + `ON CONFLICT DO NOTHING` on all 3 tables + `run.mjs` version-skip | re-provision/re-clone = zero dup pages/refs/logs |
| **Migration (D-7)** | **`065` required** (additive data seed, no DDL/table/column/vocab) | provision hook must be a seed; `064`=summary, `065` next-free |
| **Fitness (D-8)** | F-1..F-8 (db + static guard `install-runbook-projection.sh` w/ self-test) | mirrors T-0211 §9 / T-0212 rigor; F-6 = the genesis red-line check |
```
