# T-0211 / P-3 — docs-pipeline REGEN procedure (ADR)

> **Status:** DESIGN — contract for BUILD + adversarial review.
> **Parent ADRs:** `docs/design/T-0134-agent-docs.adr.md` (docs-layer frame, esp. §3.3/§9/SEAM-3),
> `docs/design/T-0210-docpage-writeful-tools.adr.md` (P-2 writeful tools + authority model),
> `docs/design/T-0209-docsauthor-seed.adr.md` (P-1 DocsAuthorAgent principal + grants).
> **Substrate (read-only, composed not re-invented):**
> `src/core/doc-live-snapshot.ts` (T-0239 collector), `src/core/doc-ref-lint.ts` (T-0238 `checkDocRefs`),
> `src/db/doc-page-store.ts` (T-0238 row-type mirrors), `migrations/061_doc_page.sql` (schema),
> `migrations/062_docs_author_seed.sql` (principal), `migrations/063_docpage_writeful_tools.sql` (tools).
> **Pipeline:** research-3 docs-pipeline row **P-3** ("the REGEN procedure").
> **Scope:** ONE operator-triggered procedure (LiveSnapshot → doc_page/doc_ref/doc_log), idempotent, draft-first.
> **Zero new authority mechanism. Zero new resource_type. Zero schema migration** (reuses 061; see §11).

---

## 1. Context & contract

P-1 seeded the **DocsAuthorAgent** principal (`docs-author` role `e0…005`, employee `d0…015`,
grants `{doc_page,create}`/`{doc_page,update}`). P-2 seeded the two **writeful mcp_tools**
(`doc_page_author`, `doc_ref_set`) that *define the authority surface* for doc writes — they are
pure registry rows (`declares='[]'`, `pure_compute=true`), **not** an execution path. The
`LiveSnapshot` collector (T-0239) introspects the running system into a `LiveSnapshot`. The pure
lint `checkDocRefs` (T-0238) verifies that typed refs resolve against that snapshot.

**P-3 (REGEN) is the missing motor: the procedure that turns the LiveSnapshot into actual
`doc_page` / `doc_ref` / `doc_log` rows**, run by ONE operator command, idempotent across runs.
This is the materialization of **SEAM-3 / T-0134h** (the deferred "agentic docs-pipeline") for the
generation half. REGEN composes the four existing pieces; it invents no new mechanism of authority,
consistency, or audit (T-0134 §1 invariant).

### 1.1 Acceptance (from research-3 P-3, verbatim contract)

A run against the **dev-tenant** `a0000000-0000-0000-0000-000000000001` yields:
1. **≥1 `doc_page`** with **≥1 typed `doc_ref`**;
2. a **`doc_log('regenerated')`** row appended (per affected page);
3. **idempotent** — re-running does **NOT** create duplicate pages or refs (relies on
   `UNIQUE(tenant_id, slug)` on `doc_page` and `UNIQUE(tenant_id, page_id, ref_kind, ref_target)`
   on `doc_ref`).

### 1.2 What this ADR is NOT (deferred seams)

- **NOT the RECONCILE procedure** (P-4) — staleness detection / `broken`/`stale` marking / re-projection
  is a sibling task. REGEN only **creates/updates** pages from the live snapshot; it does not flip
  `broken`/`stale` (those are RECONCILE/lint-runtime T-0134d territory). REGEN writes refs that are
  lint-clean **by construction** (§5.3), so it never produces a broken ref.
- **NOT a hard-gate** (SEAM-2). REGEN is detection+generation, not a merge gate.
- **NOT system-docs cross-tenant projection** (T-0134i, `scope='system'` replication). REGEN writes
  only into the **single dev-tenant** as `scope='tenant'` pages (§6). Cross-tenant projection stays
  with T-0134i.
- **NOT the read-only docs-MCP surface** (T-0134f/g) — REGEN is a writer, reachable only by the
  DocsAuthorAgent authority surface.

---

## 2. Architecture: pure core + thin operator edge (mirrors the codebase convention)

REGEN is split along the project's **core-purity seam** (mirrors `document-render.ts` T-0235,
`doc-ref-lint.ts` T-0238, `report-page-compat.ts` T-0121): **logic is a pure function; all I/O is at
the edge behind injected ports.**

```
  scripts/doc-regen.ts            src/core/doc-regen.ts           src/db/doc-page-store.ts
  (operator entry, IO)            (PURE planner)                  (thin DB write layer)
  ┌───────────────────┐          ┌──────────────────────┐        ┌───────────────────────┐
  │ assembleFull-      │  live    │ planRegen(           │  plan  │ applyRegenPlan(       │
  │  Snapshot(repo,    │ ───────▶ │   live, currentPages,│ ─────▶ │   client, tenantId,   │
  │  pgClient, devTen) │          │   currentRefs, now,  │        │   plan)               │
  │ readCurrentPages() │ current  │   actor)             │        │  → upserts via store  │
  │ readCurrentRefs()  │ ───────▶ │ ) : RegenPlan        │        │    helpers (§7)       │
  │ applyRegenPlan()   │          │ (PURE, no IO)        │        │  + emits audit (§8)   │
  └───────────────────┘          └──────────────────────┘        └───────────────────────┘
         edge                            core                            edge (DB)
```

- **`src/core/doc-regen.ts`** — PURE. Imports only `./doc-ref-lint.js` (types `LiveSnapshot`,
  `DocRef`, `DocRefKind`, `checkDocRefs`) and the row-type mirrors from `../db/doc-page-store.js`.
  **No** `pg`, `node:fs`, `node:http`, `node:net`, `node:child_process`, `import.meta`,
  `process.env`, `process.exit`. Subject to `ci/checks/no-env-in-core.sh` (full `src/core/` sweep)
  and the new isolation guard (§9, F-7). `randomUUID` from `node:crypto` is the ONLY permitted node
  import — it is the established exception used by `doc-ref-lint`'s sibling cores (e.g.
  `document-render.ts` imports `node:crypto`); the isolation guard's forbidden-list excludes
  `node:crypto` exactly as `document-render-isolation.sh` does. *(If BUILD prefers zero node imports,
  id minting moves to the edge and the plan carries no ids — see §7.2 note; either is acceptable, the
  guard pins the forbidden set, not `node:crypto`.)*
- **`scripts/doc-regen.ts`** — the operator entry (`#!/usr/bin/env npx tsx`), wired into
  `package.json` as `docs:regen` (§4). It does ALL I/O: assemble snapshot, read current pages/refs
  from DB, call the pure planner, apply the plan through the store, emit audit. Mirrors the
  `scripts/demo-tel-walkthrough.ts` / `scripts/db-setup-template.ts` convention (tsx shebang,
  `DATABASE_URL` env, idempotent, structured JSON summary, exit 0/1).
- **`src/db/doc-page-store.ts`** — currently **type-only mirrors**. BUILD ADDS the thin upsert/read
  write-helpers here (§7). This is the ONLY product file that gains write code besides the two REGEN
  files. No raw SQL escapes this module (single-writer discipline, mirrors `audit-writer.ts`).

**Rationale for this split:** the planner is fully testable without a DB (pure unit tests over
fixtures, mirrors `checkDocRefs`' test); idempotency, slug stability, and ref-typing are proven at
the pure layer; the DB layer only has to faithfully execute upserts. This keeps the adversarially
interesting logic (idempotency, tenant scoping decisions, lint-cleanliness) in a deterministic,
fixture-testable core.

---

## 3. Inputs the planner consumes

`planRegen(live, currentPages, currentRefs, nowMs, actor)` is pure. Its inputs:

| Input | Type | Source (at the edge) |
|---|---|---|
| `live` | `LiveSnapshot` (doc-ref-lint.ts) | `assembleFullSnapshot(repoRoot, pgClient, devTenantId)` (T-0239) |
| `currentPages` | `readonly DocPage[]` | `SELECT … FROM choros.doc_page` (tenant-scoped, RLS) |
| `currentRefs` | `readonly DocRef[]` (with `pageId`) | `SELECT … FROM choros.doc_ref` (tenant-scoped, RLS) |
| `nowMs` | `number` | injected clock at edge (`Date.now()`) |
| `actor` | `string` | `'docs-author'` (DocsAuthorAgent employee/role label, §8) |

`currentPages`/`currentRefs` are passed in so the planner can compute **upsert vs insert** and **diff
summaries** purely (no DB round-trips inside the planner). The edge reads them once before planning.

---

## 4. Operator entry — ONE command

```jsonc
// package.json "scripts" (additive — appended after fitness:db:cleanup-orphans)
"docs:regen": "npx tsx scripts/doc-regen.ts"
```

Invocation (mirrors db-setup-template / demo-tel-walkthrough):

```
DATABASE_URL=postgres://choros_app:...@localhost:55432/choros \
  npm run docs:regen [-- --tenant a0000000-0000-0000-0000-000000000001] [--dry-run]
```

- Default `--tenant` = the dev-tenant `a0000000-0000-0000-0000-000000000001`.
- `--dry-run`: assemble + plan + print the JSON plan, **write nothing** (no DB writes). Used by the
  fitness self-check to verify plan shape offline.
- Exit codes: `0` = regen applied (or dry-run printed), `1` = error (DB unreachable, plan
  application failed). Prints a structured JSON summary:
  `{ tenant, pagesUpserted, pagesUnchanged, refsSet, logsAppended, durationMs }`.

**Connection identity:** the script connects as **`choros_app`** (the NOBYPASSRLS role, FORCE-RLS
enforced) and sets `SET LOCAL choros.tenant_id = '<dev-tenant>'` inside a transaction — so every
write is structurally tenant-scoped through the single RLS predicate (NF-1). It does **not** connect
as `choros_migrator` and does **not** bypass RLS. This is the same discipline the importer/REST write
path uses; REGEN is "the DocsAuthorAgent acting", and the DocsAuthorAgent is a `choros_app` principal.

---

## 5. Mapping: LiveSnapshot entity → doc_page + typed doc_refs

The `LiveSnapshot` (doc-ref-lint.ts) has five member sets. REGEN groups them into **pages** and emits
one **typed `doc_ref`** per snapshot member, with `ref_target` shaped EXACTLY as `resolveRef`
(doc-ref-lint.ts) expects — so every emitted ref is lint-clean **against the same snapshot** (§5.3).

### 5.1 Grouping into pages (slug derivation — STABLE across runs)

The unit of a page is a **coherent slice of the live system**. The grouping is deterministic and
purely a function of the snapshot member's identity (NOT of run order, timestamps, or row ids), so
slugs are byte-identical run-to-run → `UNIQUE(tenant_id, slug)` makes re-runs an update-in-place.

| Snapshot member | Page grouping key | slug (stable) | doc_ref per member |
|---|---|---|---|
| `codeSymbols` `${module}#${symbol}` | by **module** (`src/core/grant-lattice`) | `code/<module-path-slugified>` e.g. `code/src-core-grant-lattice` | one `code_symbol` ref `{module, symbol}` per symbol in that module |
| `restEndpoints` `${METHOD} ${path}` | all endpoints → **one API index page** | `api/endpoints` | one `rest_endpoint` ref `{method, path}` per endpoint |
| `processKeys` `processKey` | all processes → **one process index page** | `processes/index` | one `process` ref `{processKey}` per key |
| `schemaFields` `${registryDefId}#${fieldKey}` | by **registryDefId** | `schema/<registryDefId>` | one `schema_field` ref `{registryDefId, fieldKey}` per field |
| `configKeys` `key` | all config keys → **one config index page** | `config/keys` | one `config_key` ref `{key}` per key |

**Slug derivation function (pinned, pure):**
`slugify(s)` = lowercase; replace every run of non-`[a-z0-9]` with a single `-`; trim leading/trailing
`-`; collapse repeats. Module path `src/core/grant-lattice` → `src-core-grant-lattice`. The slug is
**prefixed by kind** (`code/`, `api/`, `processes/`, `schema/`, `config/`) so two members from
different kinds never collide. The slug is the IDENTITY of the page across runs — it is NEVER derived
from a uuid, a timestamp, or run order. **This is the load-bearing idempotency primitive** (§6).

**Empty-kind handling:** a kind that yields zero members produces **no page** (no empty index page).
`codeSymbols` and `restEndpoints` are build-time over `src/` and are **always non-empty** in this
repo (verified: `router.register` call sites exist; `export`s exist) → the acceptance "≥1 page with
≥1 typed ref" is structurally guaranteed even when the DB-backed sets (schemaFields/configKeys) are
empty.

### 5.2 Page field generation

For each grouped page the planner produces a `DocPage` plan with:

- `slug`: per §5.1 (stable).
- `title`: human label derived from the group key, e.g. `Code symbols — src/core/grant-lattice`,
  `REST endpoints`, `Process definitions`, `Schema fields — <registryDefId>`, `Config keys`.
- `body`: **deterministically generated** Markdown — a sorted, stable rendering of the member list
  (e.g. a bullet per symbol/endpoint). Sorting makes the body byte-stable run-to-run when the live
  system is unchanged → re-run is a true no-op for unchanged pages (no spurious `updated_at` churn;
  see §6.2). The body is generated, not authored prose; REGEN is a projection of live state.
- `scope`: **`'tenant'`** for ALL REGEN pages (§6 — REGEN never writes `scope='system'`;
  cross-tenant system-docs projection is T-0134i). `catalog_version` = `NULL` (required null for
  `scope='tenant'`).
- `app_id`: `NULL` (no navigation binding in P-3).
- `stale`: `false` (REGEN writes fresh, present-referent pages; staleness is RECONCILE's job).
- `authoredBy`: the DocsAuthorAgent actor label (§8).
- `authoredAt`/`updatedAt`: `nowMs` for inserts; for updates, `authoredAt` is **preserved** from the
  existing row, `updatedAt` = `nowMs` (the store helper, not the planner, preserves `authoredAt` —
  the planner emits an `upsert` intent and the store resolves create-vs-update; see §7.2).

### 5.3 Typed refs — lint-clean by construction (the core correctness invariant)

Every emitted `doc_ref.ref_target` is shaped EXACTLY as `resolveRef` (doc-ref-lint.ts lines 157–182)
keys it:

| ref_kind | ref_target (exact keys) | resolveRef key it must hit |
|---|---|---|
| `code_symbol` | `{ module, symbol }` | `${module}#${symbol}` ∈ `live.codeSymbols` |
| `rest_endpoint` | `{ method, path }` | `${method} ${path}` ∈ `live.restEndpoints` |
| `schema_field` | `{ registryDefId, fieldKey }` | `${registryDefId}#${fieldKey}` ∈ `live.schemaFields` |
| `process` | `{ processKey }` | `processKey` ∈ `live.processKeys` |
| `config_key` | `{ key }` | `key` ∈ `live.configKeys` |

Because **REGEN derives each ref directly from a member of the same `LiveSnapshot`** it lints against,
`checkDocRefs(plannedRefs, live)` is **`{ ok: true }` by construction**. The planner asserts this
internally (F-4): it calls `checkDocRefs` on its own planned refs against `live` and **refuses to
emit** (returns an error result) if any violation appears — a self-guard against a future mapping bug
silently producing a broken ref. `broken=false`, `createdAt=nowMs` on every emitted ref.

---

## 6. Idempotency — the central guarantee

Re-running REGEN against an unchanged live system produces **zero new pages and zero new refs**.

### 6.1 Mechanism (pinned)

1. **Stable slug** (§5.1) → the same live state always maps to the same `slug`.
2. **`doc_page` upsert keyed on `(tenant_id, slug)`** (the existing UNIQUE constraint, migration 061
   line 52–53). The store's `upsertDocPage` (§7.2) does
   `INSERT … ON CONFLICT (tenant_id, slug) DO UPDATE SET title=…, body=…, updated_at=…` (preserving
   `id`, `authored_at`, `scope`). A second run = UPDATE-in-place of the SAME row, never a second row.
3. **`doc_ref` upsert keyed on `(tenant_id, page_id, ref_kind, ref_target)`** (the existing UNIQUE
   constraint, migration 061 line 111–112). The store's ref writer does
   `INSERT … ON CONFLICT (tenant_id, page_id, ref_kind, ref_target) DO NOTHING` per ref. A second run
   re-inserting the identical typed ref is a no-op (the conflict tuple matches).
4. **Removed referents** (a symbol/endpoint deleted from the live system between runs): the page's
   ref set shrinks. The store's ref reconciliation is **set-replacement scoped to the page**: for
   each page, delete the page's `doc_ref` rows whose `(ref_kind, ref_target)` is NOT in the new
   planned set, then upsert the planned set. This keeps `doc_ref` a faithful mirror with no
   duplicates and no orphans. (Deletion is scoped to REGEN-owned pages only; see §6.3.)

### 6.2 `updated_at` / body stability

Because `body` is a **sorted deterministic rendering** (§5.2), an unchanged live system yields a
byte-identical `body` and `title`. The store's `ON CONFLICT DO UPDATE` MAY therefore guard the SET
with a change check (`WHERE doc_page.body IS DISTINCT FROM EXCLUDED.body OR …`) so unchanged pages do
not bump `updated_at` or append a no-op log. **This is a SHOULD, not a MUST** for acceptance (counts
are what F-1 asserts); BUILD picks one and the fitness test pins the chosen behavior. The MUST is:
**counts of pages and refs are stable across runs.**

### 6.3 `doc_log` on re-run (append-only history — NOT deduplicated)

`doc_log` is **append-only changelog** (open-vocab `op`, pattern T-0016). Each run that **affects**
a page appends ONE `doc_log` row with `op='regenerated'` for that page. **It is correct and expected
that re-running grows `doc_log`** — the log is history, not state. The acceptance "no duplicates"
applies to **pages and refs**, NOT to log rows. To avoid log spam on true no-ops, REGEN appends
`op='regenerated'` only for pages it actually inserted-or-changed (paired with the §6.2 change-guard);
on a fully-unchanged re-run it MAY append zero log rows. **Minimum guarantee for acceptance:** the
FIRST run appends ≥1 `doc_log('regenerated')`; a no-op second run does not create duplicate
pages/refs. `diff_summary` (optional) carries a short machine summary, e.g. `created` /
`refs +3 −1` / `body changed`.

### 6.4 Ownership boundary (so REGEN's delete in §6.1.4 is safe)

REGEN only ever touches pages whose `slug` is in its own kind-prefixed namespace
(`code/`, `api/`, `processes/`, `schema/`, `config/`) — these are **REGEN-owned**. The set-replace
delete in §6.1.4 is scoped to a specific REGEN-owned `page_id`'s refs only. REGEN never deletes or
mutates a page authored by a human or another agent (a page outside its slug-prefix namespace is
invisible to REGEN's plan and untouched). This is enforced structurally: the planner only emits plans
for slugs it derives from the snapshot; the store applies only what the plan contains.

---

## 7. Store layer contract (BUILD adds to `src/db/doc-page-store.ts`)

`doc-page-store.ts` is currently type-only. BUILD adds these write/read helpers (single-writer
discipline — no raw doc SQL anywhere else):

### 7.1 Reads (for the planner's inputs)

- `readDocPages(client, tenantId): Promise<DocPage[]>` — `SELECT … WHERE tenant_id = $1` (RLS already
  scopes; explicit predicate is belt-and-suspenders).
- `readDocRefs(client, tenantId): Promise<(DocRef & {pageId:string})[]>`.

### 7.2 Writes (idempotent, the ONLY mutation path)

- `upsertDocPage(client, tenantId, page): Promise<{id, action:'inserted'|'updated'|'unchanged'}>` —
  `INSERT … ON CONFLICT (tenant_id, slug) DO UPDATE …` preserving `id`/`authored_at`/`scope`,
  honoring the §6.2 change-guard. Returns the resolved `id` (existing or new). **id minting:** if the
  planner did not mint ids (the zero-node-import variant, §2 note), the store mints `randomUUID()`
  for inserts; on conflict the existing id is kept. Either way the planner stays pure.
- `setDocRefs(client, tenantId, pageId, refs): Promise<{set:number, deleted:number}>` — set-replace
  per §6.1.4: delete page refs not in `refs`, then
  `INSERT … ON CONFLICT (tenant_id, page_id, ref_kind, ref_target) DO NOTHING` each.
- `appendDocLog(client, tenantId, pageId, op, actor, diffSummary, nowMs): Promise<void>` — plain
  INSERT (append-only; no upsert).

All helpers run inside the caller's transaction with `choros.tenant_id` GUC set; they NEVER set the
GUC themselves and NEVER open their own connection (edge owns the connection — mirrors
`audit-writer.ts` taking a `tx`).

### 7.3 `applyRegenPlan(client, tenantId, plan, actor, nowMs)` (edge orchestration in scripts/)

Within ONE transaction: for each planned page → `upsertDocPage` → `setDocRefs` → if changed
`appendDocLog('regenerated')` → emit audit (§8). COMMIT. On any error: ROLLBACK, exit 1.

---

## 8. Audit & log

Per the framing ADR (T-0134 §3.3 / FF-DOCS-AUDIT, §6 audit table): **doc operations are `audit_event`
rows (open-vocab `docs.*`), NOT a second log table.** REGEN therefore emits, at the edge
(`applyRegenPlan`), one **`audit_event`** per regenerated page (or one run-level summary event — see
below), via the existing append path (`appendAuditEvent` / the `AuditSink` port,
`src/core/audit-grant-encoder.ts` → `AuditEventInput`):

- `type`: `'docs.regenerated'` (open-vocab, pattern T-0016 — new event = string, not table).
- `actor`: the DocsAuthorAgent (`d0…015` / `docs-author`), derived from the principal, never a raw
  secret.
- `subject`/`scope`: the dev-tenant + page slug; tenant-scoped.
- `payload`: small machine summary (`{slug, action, refsSet, refsDeleted}`); **no secrets**.

This is **in addition to** the `doc_log('regenerated')` row (§6.3). The distinction (mirrors
report_page / external-participant): `doc_log` = the page's **content changelog** (LLM-wiki "log"
member); `audit_event` = the **system audit floor** (who-did-what, hash-chained). Both are required by
the framing ADR. **Decision:** REGEN emits **one `audit_event('docs.regenerated')` per run** (a
run-level summary with counts) to keep the audit floor uncluttered, PLUS **one
`doc_log('regenerated')` per affected page** (per-page content history). F-3 asserts the doc_log
rows; F-9 asserts the audit event is emitted and carries no secret. *(If the adversarial reviewer
prefers per-page audit events for symmetry with §3.3's "каждое обращение", that is a one-line edge
change and acceptable; the MUST is: ≥1 `docs.regenerated` audit_event per run, secret-free.)*

---

## 9. Machine-checkable fitness criteria (F-1 .. F-10)

The tester/CI must assert ALL of the following. F-1/F-2/F-3/F-8 are **db-tier** (live Postgres,
`npm run fitness:db`, fresh-tenant discipline T-0205 OR explicit dev-tenant scoping — see note);
F-4/F-5 are **pure unit tests** (no DB); F-6/F-7/F-10 are **static guards** (bash, wired into
`npm run fitness`).

> **db-tier tenant note:** the acceptance is specifically "against the dev-tenant
> `a0000000-…-001`". The db test runs REGEN's planner+store against a **fresh random tenant** seeded
> with a minimal fixture (to honor T-0205 shared-DB isolation — never mutate shared dev-tenant rows
> in CI), AND a thin assertion that the *operator script's default tenant constant* equals the
> dev-tenant UUID (static). This proves the procedure on a real tenant without polluting the shared
> dev-tenant fixture. The "≥1 page with ≥1 ref" guarantee holds on any tenant because
> codeSymbols/restEndpoints are build-time, tenant-independent.

### F-1 — ≥1 page with ≥1 typed ref produced (db)
After one REGEN run on the test tenant:
```sql
SELECT count(*)::int FROM choros.doc_page WHERE tenant_id = $1;            -- ≥ 1
SELECT count(*)::int FROM choros.doc_ref  r
  JOIN choros.doc_page p ON p.tenant_id=r.tenant_id AND p.id=r.page_id
  WHERE r.tenant_id = $1;                                                  -- ≥ 1
```
Assert at least one page has at least one ref, and every ref's `ref_kind` is in the closed vocab.

### F-2 — idempotent: run twice → page & ref counts stable (db)
Capture `(pageCount, refCount)` after run 1; run REGEN again with the **same** live snapshot; assert
`pageCount` and `refCount` are **unchanged** (DO-NOTHING / DO-UPDATE-in-place, no new rows). Also
assert no `doc_page.id` changed (upsert preserved ids).

### F-3 — `doc_log('regenerated')` appended (db)
After run 1: `SELECT count(*) FROM choros.doc_log WHERE tenant_id=$1 AND op='regenerated'` ≥ 1, each
joined to an existing page. (Log is append-only; F-2's "stable" applies to pages/refs, NOT log — this
is asserted explicitly so a reviewer doesn't mistake growing logs for a duplicate bug.)

### F-4 — refs are lint-clean by construction (pure)
Unit test: build a `LiveSnapshot` fixture; call `planRegen(...)`; call
`checkDocRefs(plan.allRefs, fixtureSnapshot)` → expect `{ ok: true }`. Negative sub-test: a snapshot
that loses a member after planning makes `checkDocRefs` report the now-missing referent — proving the
planner's refs were exactly the live members (no fabricated refs).

### F-5 — idempotency at the pure layer (pure)
Unit test: `planRegen(live, [], [], now, actor)` (cold) → N page plans, M ref plans. Materialize those
as `currentPages`/`currentRefs`, call `planRegen(live, currentPages, currentRefs, now2, actor)` again
→ assert the second plan marks every page `action:'unchanged'` (or upsert-no-change) and emits zero
NEW refs (every ref already present). Proves slug stability + no-duplicate logic without a DB.

### F-6 — `scope='tenant'` only; single tenant; no system projection (static + db)
Static: grep `src/core/doc-regen.ts` + `scripts/doc-regen.ts` for any literal `'system'` scope write
or any tenant id other than the configured target → none. Db: every REGEN-written `doc_page` has
`scope='tenant'` and `catalog_version IS NULL`; all rows share ONE `tenant_id`. (REGEN is not the
T-0134i projection writer.)

### F-7 — core is pure (static guard `ci/checks/doc-regen-isolation.sh`)
New isolation guard (mirrors `doc-ref-lint-isolation.sh` / `document-render-isolation.sh`), with
`--self-test`:
- `src/core/doc-regen.ts` exists.
- Forbidden imports absent: `pg`, `node:fs`, `node:http`, `node:net`, `node:child_process`,
  `child_process`, `import.meta`, `process.env`, `process.exit`. (`node:crypto` permitted, as in
  `document-render`.)
- Exports the public surface: `planRegen`, `RegenPlan` (+ plan member types).
- Asserts `doc-regen.ts` does NOT import `./doc-live-snapshot.js` (collector is edge-only — the
  planner takes a `LiveSnapshot`, it does not assemble one; keeps the core DB-free).

### F-8 — tenant isolation / RLS not bypassed (db)
Db: the operator path connects as `choros_app` (NOBYPASSRLS). Assert a second tenant's `doc_page`
rows are invisible during a REGEN run scoped to tenant A (cross-tenant probe, mirrors
`cross_tenant.test.ts`), and that REGEN never writes a row whose `tenant_id` ≠ the GUC tenant
(FORCE-RLS `WITH CHECK` would reject it — assert the write path sets `SET LOCAL choros.tenant_id`).

### F-9 — audit emitted, secret-free (db or unit)
Assert ≥1 `audit_event` with `type='docs.regenerated'`, actor = DocsAuthorAgent, tenant-scoped, and
`payload` contains no secret material. (If the audit emit is edge-only and hard to probe in the db
tier, a unit test over the `AuditEventInput` builder suffices.)

### F-10 — additive only: no new grants, no new tools, no new resource_type, no migration,
frozen/known_tables unchanged (static + db)
- No new migration file beyond 063 added by THIS task (REGEN reuses 061 tables + 063 tools). If a
  migration *were* added it would be slot **064** — but F-10 asserts there is none (§11).
- `choros."grant"` count for `docs-author` (`e0…005`) unchanged = 2 (P-1's grants only).
- No new `mcp_tool` row (P-2's two tools are sufficient; REGEN *uses* `doc_page_author`/`doc_ref_set`
  authority semantics — it does not seed a third tool).
- `ci/checks/known_tenant_tables.txt` unchanged (doc tables already listed since 061).
- Frozen files unchanged: `src/core/mcp-tool-registry.ts`, `migrations/040_mcp_tool.sql`,
  `migrations/061_doc_page.sql`, `migrations/063_docpage_writeful_tools.sql`,
  `src/core/doc-ref-lint.ts`, `src/core/doc-live-snapshot.ts`, `ci/checks/frozen-sanctions.jsonl`.

---

## 10. Authority argument (SEAM-2: draft-first, no promote, no new grant)

REGEN writes as the **DocsAuthorAgent** — a `choros_app` principal holding exactly P-1's two grants
`{doc_page,create}` and `{doc_page,update}`. Its writes correspond to the `doc_page_author` and
`doc_ref_set` tool *semantics* (P-2):

- **Create/update pages** ⇒ `doc_page_author` authority (`{doc_page,create}` + `{doc_page,update}`).
- **Set refs** ⇒ `doc_ref_set` authority, which **rides `{doc_page,update}`** (doc_ref = child of
  doc_page, FK CASCADE — T-0210 §2). REGEN needs no `doc_ref` resource_type and seeds no grant.
- **Append `doc_log`** ⇒ part of the page-update operation (log is the page's changelog child, FK
  CASCADE). No separate authority.
- **No promote power, no `scope='system'` projection, no second tenant** (SEAM-2 draft-first). REGEN
  cannot escalate: it has no grant beyond create/update on `doc_page` in ONE tenant; FORCE-RLS
  `WITH CHECK` structurally blocks any cross-tenant write; the planner never emits `scope='system'`.

The adversarial reviewer's privilege-escalation checklist: (a) REGEN cannot write a second tenant
(RLS); (b) cannot create a new grant/tool/resource_type (F-10); (c) cannot promote (no promote
grant/tool exists in its toolset); (d) cannot touch frozen objects (F-10); (e) cannot forge a ref to
a non-existent referent (F-4 self-guard refuses to emit broken refs). All structural, not
gatekeeping-by-convention.

---

## 11. Migration decision: **NONE required**

REGEN is **runtime code + operator script only**. It reuses:
- `doc_page` / `doc_ref` / `doc_log` tables (migration **061**, with the two UNIQUE constraints that
  make idempotency work);
- the two writeful tools' authority semantics (migration **063**);
- the DocsAuthorAgent principal + grants (migration **062**).

No DDL, no new seed rows, no new vocab. **`needs_migration = false.`** For the record: the next-free
migration slot after 063 is **064** — REGEN does NOT consume it. (If a future reviewer argues a
`doc_log` index or a `ref_target` GIN index is needed for REGEN's set-replace performance, that would
be an *additive index migration* at slot 064 — but it is NOT required for correctness or acceptance,
and is explicitly out of P-3 scope. Day-1 dev-tenant volumes are tiny; the existing
`doc_log_tenant_page_at_idx` and the UNIQUE indexes cover REGEN's queries.)

---

## 12. Decisions summary

| Decision | Choice | Rationale |
|---|---|---|
| Where REGEN lives | pure `src/core/doc-regen.ts` (`planRegen`) + edge `scripts/doc-regen.ts` (`npm run docs:regen`) + store helpers in `src/db/doc-page-store.ts` | mirrors core-purity seam (document-render/doc-ref-lint); logic fixture-testable, IO at edge |
| Operator command | `npm run docs:regen` (tsx, DATABASE_URL, `--tenant`, `--dry-run`, JSON summary, exit 0/1) | mirrors db-setup-template / demo-tel-walkthrough convention |
| slug derivation | kind-prefixed, slugified group key (`code/<module>`, `api/endpoints`, `processes/index`, `schema/<defId>`, `config/keys`); never from uuid/time/run-order | **the** idempotency primitive — stable slug + UNIQUE(tenant_id,slug) |
| Idempotency | `doc_page` upsert ON CONFLICT (tenant_id,slug); `doc_ref` upsert ON CONFLICT (tenant_id,page_id,ref_kind,ref_target) DO NOTHING; per-page set-replace for removed referents | reuses 061's two UNIQUE constraints; re-run = update-in-place / no-op |
| Refs lint-clean | refs derived from the same LiveSnapshot they lint against; planner self-asserts `checkDocRefs(plan.refs, live).ok` and refuses to emit on violation | broken refs structurally impossible in REGEN output |
| `doc_log` on re-run | append-only; `op='regenerated'` per affected page each run; NOT deduplicated (log = history) | pattern T-0016; "no duplicates" is about pages/refs, not log |
| Audit | one `audit_event('docs.regenerated')` per run (open-vocab, secret-free) via existing AuditSink — no second log table | T-0134 §3.3 / FF-DOCS-AUDIT |
| Scope / tenant | ALL pages `scope='tenant'`, single dev-tenant, `choros_app` NOBYPASSRLS, GUC-scoped writes | draft-first SEAM-2; system-projection is T-0134i, not REGEN |
| Authority | DocsAuthorAgent, P-1's 2 grants, P-2's 2 tool semantics; no promote, no new grant/tool/resource_type | T-0210 ride-on model; SEAM-2 |
| Migration | **none** (reuses 061/062/063); next-free = 064 (unconsumed) | runtime code only; no DDL/seed/vocab change |
| Fitness | F-1..F-10 (db + pure + static guard `doc-regen-isolation.sh` w/ self-test) | mirrors T-0210 §7 rigor |

---

## 13. Build plan (for the coder)

1. `src/db/doc-page-store.ts` — add read helpers (`readDocPages`, `readDocRefs`) and idempotent write
   helpers (`upsertDocPage`, `setDocRefs`, `appendDocLog`) per §7. Single-writer; takes a `tx`.
2. `src/core/doc-regen.ts` — PURE `planRegen(live, currentPages, currentRefs, nowMs, actor)` returning
   `RegenPlan` per §5/§6; `slugify`; per-kind mapping; `checkDocRefs` self-guard (§5.3/F-4). No
   forbidden imports (§9 F-7).
3. `scripts/doc-regen.ts` — operator entry: parse `--tenant`/`--dry-run`; connect `choros_app`;
   `BEGIN; SET LOCAL choros.tenant_id`; `assembleFullSnapshot` → `readDocPages`/`readDocRefs` →
   `planRegen` → `applyRegenPlan` (upsert pages, set refs, append log, emit audit); `COMMIT`; print
   JSON summary; exit 0/1.
4. `package.json` — add `"docs:regen": "npx tsx scripts/doc-regen.ts"` (no dup keys — passes
   `package-json-no-dup-keys.sh`).
5. `ci/checks/doc-regen-isolation.sh` (+ `--self-test`) — purity/exports/no-collector-import guard
   (§9 F-7); wire into `npm run fitness` (append, after `docpage-writeful-tools.sh --self-test`).
6. Tests:
   - `src/core/__tests__/doc-regen.test.ts` — pure: F-4 (lint-clean), F-5 (idempotent plan), slug
     stability, mapping per kind, empty-kind → no page.
   - `ci/checks/db/doc-regen.db.test.ts` — db: F-1, F-2 (run-twice counts), F-3 (log), F-6 (scope),
     F-8 (tenant isolation), F-9 (audit), F-10 (no new grant/tool/table). Fresh-tenant fixture per
     T-0205; assert script default-tenant const = dev-tenant UUID (static).
7. Adversarial review focus: §10 privilege-escalation checklist + idempotency under
   referent-removal (§6.1.4 set-replace must not orphan or duplicate, must not cross page boundary).

**Fitness wiring summary:** pure tests run under `npm run test` / `vitest`; db tests under
`npm run fitness:db` (vitest `--dir ci/checks/db --no-file-parallelism`); the static guard
`doc-regen-isolation.sh` appends to the `fitness` script chain (and its `--self-test` immediately
after, matching the repo's `<check>.sh && <check>.sh --self-test` convention).
