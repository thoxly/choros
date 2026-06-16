# T-0212 / P-4 — docs-pipeline RECONCILE procedure (ADR)

> **Status:** DESIGN — contract for BUILD + adversarial review.
> **Parent ADRs:** `docs/design/T-0134-agent-docs.adr.md` (docs-layer frame, esp. §3.3/§9/SEAM-3),
> `docs/design/T-0211-doc-regen.adr.md` (P-3 REGEN — the procedure RECONCILE reuses for the regenerate path),
> `docs/design/T-0210-docpage-writeful-tools.adr.md` (P-2 writeful tools + authority model),
> `docs/design/T-0209-docsauthor-seed.adr.md` (P-1 DocsAuthorAgent principal + grants).
> **Substrate (read-only, composed not re-invented):**
> `src/core/doc-ref-lint.ts` (T-0238 `checkDocRefs` — THE lint signal),
> `src/core/doc-regen.ts` (T-0211 `planRegen` — the regenerate motor RECONCILE reuses),
> `src/core/doc-live-snapshot.ts` (T-0239 collector — the "live system"),
> `src/db/doc-page-store.ts` (T-0211 write/read layer — RECONCILE writes through it),
> `scripts/doc-regen.ts` (T-0211 operator-edge convention RECONCILE mirrors),
> `migrations/061_doc_page.sql` (schema — incl. `doc_page.stale` boolean + `doc_ref.broken` boolean).
> **Pipeline:** research-3 docs-pipeline row **P-4** ("the RECONCILE procedure").
> **Scope:** ONE operator-triggered procedure, driven by the **lint signal** (`checkDocRefs`); for each
> page with a broken/stale ref → fix the ref OR mark-stale + targeted-regenerate; appends
> `doc_log('reconciled')`; **draft-first** (no promote); **idempotent**; **targeted** (touches only
> affected pages, not the whole wiki).
> **Zero new authority mechanism. Zero new resource_type. Zero schema migration** (reuses 061; see §11).

---

## 1. Context & contract

P-3 (REGEN) is the **generation** half of the docs-pipeline: ONE operator command walks a fresh
`LiveSnapshot` and projects the WHOLE live system into `doc_page`/`doc_ref`/`doc_log` rows, idempotent,
draft-first. Its refs are lint-clean **by construction** (REGEN derives each ref from the same snapshot
it lints against), so REGEN never *produces* a broken ref.

But the live system **drifts after a REGEN run**: a symbol gets renamed, an endpoint removed, a config
key dropped. The previously-correct `doc_ref` rows now point at referents that no longer exist. The
**lint signal** (`checkDocRefs`, T-0238) is the detector that catches this — wired into
`ci/checks/doc-coherence.sh` (T-0239) on every merge to `dev`, and runnable on demand. Per the framing
ADR's load-bearing **"detector vs writer" boundary** (research-3 §1.2): **lint is ONLY a signal**
(`broken`/`stale`/`doc_log`/`audit`); the ONLY thing allowed to *write* docs is the **DocsAuthorAgent**,
in a separate, audited, **draft-first** run. CI never edits docs (that would make CI non-deterministic
and un-auditable, and would let a hallucination merge silently — research-3 R-3).

**P-4 (RECONCILE) is that writer-side procedure.** It is the **`lint → fix` loop** (Karpathy): take the
lint signal, and for each affected page either (a) **FIX** the `doc_ref` in place (re-derive its target
from the live system) or (b) **MARK** the page stale + **targeted-regenerate** it (reusing P-3's
`planRegen`, scoped to that page's slug). It appends `doc_log('reconciled')` per affected page. RECONCILE
composes the four existing pieces (`checkDocRefs` + `planRegen` + the store + the snapshot collector); it
invents **no new mechanism** of authority, consistency, or audit (T-0134 §1 invariant).

### 1.1 Acceptance (from research-3 P-4, verbatim contract)

A run over a page with a **broken ref** yields:
1. the ref is **fixed** (re-derived against the live system) **OR** the page is **marked stale +
   targeted-regenerated**;
2. a **`doc_log('reconciled')`** row appended (per affected page).

And the procedure is **draft-first** (no promote), **idempotent** (a second run over an
already-clean wiki = no-op: no spurious page churn, no duplicate refs/logs), and **targeted** (only
affected pages are touched — that is REGEN's job, not RECONCILE's).

### 1.2 What this ADR is NOT (deferred seams)

- **NOT REGEN (P-3).** REGEN is a *full* walk that (re)projects the whole live system unconditionally.
  RECONCILE is *targeted*: it acts only on the SET of pages the lint signal flags, and it leaves every
  clean page byte-untouched. RECONCILE *reuses* `planRegen` but scopes it to the affected slugs (§5).
- **NOT a hard-gate** (SEAM-2). RECONCILE is the *cure* the operator runs *after* the CI detector
  reddens; it is not itself the merge gate. The gate is `doc-coherence.sh` (detector-only, T-0239).
- **NOT a new lint mechanism.** RECONCILE consumes `checkDocRefs` output verbatim — it does not invent a
  second staleness check. Fingerprint/provenance-grade staleness ("symbol exists but its signature
  changed") is research-3 §5 R-A / `ref_fingerprint` — **Stage-2**, explicitly out of P-4 scope (§2.1).
- **NOT system-docs cross-tenant projection** (T-0134i). RECONCILE acts within the **single tenant** it
  is scoped to, as `scope='tenant'` pages, exactly like REGEN. Projection stays with T-0134i/P-5.
- **NOT a promote/publish step.** Draft-first: RECONCILE writes pages and flips flags; it never promotes
  `scope='system'`, never crosses a tenant, never publishes (SEAM-2).

---

## 2. The lint signal RECONCILE consumes (day-1 semantics: broken vs stale)

`checkDocRefs(refs, live)` (T-0238) is the single source of truth for the lint signal. Day-1 it emits
exactly ONE violation type: **`missing_referent`** — "this typed ref's referent is absent from the live
snapshot" (doc-ref-lint.ts §3.2). There is no signature/fingerprint comparison yet (that is Stage-2,
§2.1). This pins the day-1 mapping precisely:

| Lint output | Schema flag it corresponds to | Meaning (day-1) |
|---|---|---|
| `missing_referent` on a `doc_ref` | `doc_ref.broken = true` | the referent the ref points at **no longer exists** in the live system |
| (none — page-level) | `doc_page.stale = true` | the page **contains ≥1 broken ref** (i.e. page is affected) |

**Key day-1 fact:** `checkDocRefs` flags a ref as broken **iff its referent is gone** (or the ref_kind is
unknown — fail-closed). There is no "referent moved to a new target" signal day-1 — a renamed symbol is,
to the lint, the *disappearance* of the old `code_symbol#old` and the *appearance* of `code_symbol#new`.
The lint cannot, in general, prove that `old` "became" `new` (that requires the fingerprint/provenance
delta of §5 R-A, Stage-2). **This determines the fix-vs-regenerate rule below.**

### 2.1 Why "FIX the ref in place" reduces to "regenerate the page" (day-1)

The acceptance offers two cures: (a) **fix the ref** (re-derive `ref_target` from live) or (b)
**mark + regenerate the page**. We pin the **simplest correct rule** and justify why the two collapse to
ONE deterministic motor day-1:

- **A "fixed ref"** means: replace the page's `doc_ref` set with the refs that match the *current* live
  system. For a REGEN-owned page (every page RECONCILE touches; §4.2), the *correct* ref set for a given
  live snapshot is **exactly what `planRegen` derives for that page's slug from that snapshot** — refs
  are a pure projection of the snapshot, set-replaced per page (`setDocRefs`, T-0211 §7.2). So "fix the
  refs of page P against live" ≡ "run `planRegen` for P's slug against live and apply its ref-set". The
  body is regenerated alongside (it is the same sorted projection of the same members). **There is no
  cheaper in-place ref-edit that is *also* correct** — to re-derive a ref's target you must consult the
  same snapshot `planRegen` already consumes, and a renamed member changes the page's member-list (and
  hence its body) anyway. Re-deriving one ref while leaving a now-wrong body would *re-break* the lint.

- Therefore **day-1 RECONCILE uses ONE deterministic cure for every affected page: targeted-regenerate
  via `planRegen` scoped to that page's slug.** This *is* the "(a) fix the ref" path expressed through
  the existing motor: the page's refs are re-derived from live (broken refs whose referent vanished are
  dropped by the set-replace; refs whose referent still exists survive; new members appear), the body is
  refreshed, `stale` is cleared, and `doc_log('reconciled')` is appended. It is **simultaneously** "(b)
  mark + regenerate" because we set `stale=true` on detection and clear it on regenerate (§6.3).

> **Pinned rule (no open question for BUILD):** *For every page the lint flags as affected, RECONCILE
> re-derives that page from a fresh `LiveSnapshot` via `planRegen` restricted to the affected slug set,
> applies the resulting page/ref set-replace through the store, sets `doc_page.stale=false` on the
> regenerated page, and appends one `doc_log('reconciled')`.* The "fix vs mark+regen" either/or in the
> acceptance is satisfied by this single path (it is both); the fitness test pins it (F-1/F-3). This is
> the simplest rule consistent with the day-1 lint (which only knows "referent gone", §2), and it reuses
> P-3 wholesale — no new generation logic.

### 2.2 The edge case the rule must handle: a page ALL of whose members vanished

If every member backing a page disappears (e.g. a whole module is deleted), `planRegen` over the live
snapshot will **not produce that page at all** (REGEN emits no page for an empty kind/group — T-0211
§5.1 "empty-kind handling"). The page is now an **orphan**: it exists in `doc_page` with broken refs but
has no live backing. RECONCILE's day-1 cure for an orphan affected page is to **mark it stale** and
**clear its now-broken refs** (set-replace to the empty set), leaving the page row present but flagged
`stale=true` with zero refs (a tombstone the operator/UI can see), and append `doc_log('reconciled',
diff_summary='orphaned: no live referents')`. It does **NOT delete the page** (deletion of human-visible
content is a heavier, separately-audited action out of P-4 scope; orphan *detection*/cleanup is research-3
P-10, Stage-2). This is the one place where "(b) mark stale" is the terminal state rather than a
transient → and it is the explicit acceptance branch "page is marked". F-5 pins it.

---

## 3. Architecture: pure core + thin operator edge (mirrors REGEN exactly)

RECONCILE is split along the project's **core-purity seam** identically to REGEN (mirrors
`doc-regen.ts` T-0211, `doc-ref-lint.ts` T-0238, `document-render.ts` T-0235): **logic is a pure
function; all I/O is at the edge behind injected reads.**

```
  scripts/doc-reconcile.ts          src/core/doc-reconcile.ts        src/db/doc-page-store.ts
  (operator entry, IO)              (PURE planner)                   (thin DB write layer, REUSED)
  ┌────────────────────────┐        ┌────────────────────────┐       ┌────────────────────────┐
  │ assembleFullSnapshot   │ live   │ planReconcile(         │ plan  │ upsertDocPage          │
  │ readDocPages           │ ─────▶ │   lintResult,          │ ────▶ │ setDocRefs             │
  │ readDocRefs            │ pages/ │   live,                │       │ markPageStale (NEW §7) │
  │ checkDocRefs ──────────│ refs   │   currentPages,        │       │ appendDocLog           │
  │   (build lintResult)   │ ─────▶ │   currentRefs,         │       │ (+ run-level audit §8) │
  │ planReconcile          │ lint   │   nowMs, actor)        │       └────────────────────────┘
  │ apply plan + audit     │ ─────▶ │ ) : ReconcilePlan      │
  └────────────────────────┘        │   (PURE, no IO)        │
            edge                     └────────────────────────┘
                                              core
```

- **`src/core/doc-reconcile.ts`** — PURE. Imports only `./doc-ref-lint.js` (types `LiveSnapshot`,
  `DocRef`, `DocLintResult`, `DocRefViolation`, and `checkDocRefs` for the post-plan self-guard),
  `./doc-regen.js` (`planRegen`, `slugify`, `RegenPlan`/`RegenPagePlan` types — the reused motor), and
  the row-type mirrors from `../db/doc-page-store.js`. **No** `pg`, `node:fs`, `node:http`, `node:net`,
  `node:child_process`, `import.meta`, `process.env`, `process.exit`. `randomUUID` from `node:crypto` is
  the ONLY permitted node import (the established exception, identical to `doc-regen.ts`). Subject to the
  full `src/core/` sweep `ci/checks/no-env-in-core.sh` AND the new isolation guard (§9, F-6,
  `doc-reconcile-isolation.sh`, mirroring `doc-regen-isolation.sh`).
- **`scripts/doc-reconcile.ts`** — the operator entry (`#!/usr/bin/env npx tsx`), wired into
  `package.json` as `docs:reconcile` (§4). It does ALL I/O: assemble snapshot, read current pages/refs,
  **compute the lint signal** (`checkDocRefs(currentRefs-as-DocRef[], live)`), call the pure planner,
  apply the plan through the store, emit audit. Mirrors `scripts/doc-regen.ts` line-for-line (tsx
  shebang, `DATABASE_URL`, `--tenant`, `--dry-run`, JSON summary, exit 0/1, `choros_app` + `SET LOCAL
  choros.tenant_id`). Exports `DEFAULT_TENANT` and `DOCS_AUTHOR_ACTOR` constants (F-10 static target,
  same as REGEN).
- **`src/db/doc-page-store.ts`** — **REUSED as-is** for `readDocPages`/`readDocRefs`/`upsertDocPage`/
  `setDocRefs`/`appendDocLog`. BUILD adds **ONE** small helper, `markPageStale` (§7), for the
  mark-stale/clear-stale flag write (set-replace already exists). No raw SQL escapes this module
  (single-writer discipline). No second authz mechanism.

**Rationale for the split (same as REGEN):** the adversarially-interesting logic — *which* pages are
affected, idempotency, the targeting restriction, the orphan branch — lives in a deterministic,
fixture-testable pure core; the DB layer only faithfully executes the plan. The planner is fully testable
without a DB.

---

## 4. Targeting: which pages RECONCILE touches (and ONLY those)

### 4.1 Affected-page set (pinned)

The edge computes the lint signal once, then the pure planner derives the affected set:

1. **Edge** reads `currentRefs` (all `doc_ref` rows for the tenant, each carrying `pageId`) and a fresh
   `live` snapshot, and computes `lintResult = checkDocRefs(currentRefs mapped to DocRef[], live)`.
   (The edge also passes the raw `currentRefs` so the planner can map each violation back to its
   `pageId` — `checkDocRefs` output carries `refKind`+`refTarget` but not `pageId`; the planner re-joins
   by matching `(refKind, refTarget)` against `currentRefs`. The join key is exactly the `doc_ref`
   UNIQUE tuple, so it is unambiguous within a page.)
2. **Planner** computes `affectedSlugs` = the set of `slug`s of pages that own ≥1 ref appearing in
   `lintResult.violations`. (`{ ok: true }` ⇒ empty affected set ⇒ empty plan ⇒ no-op — the idempotent
   clean-wiki case, §6.)
3. **Planner** restricts the regenerate to `affectedSlugs`: it runs `planRegen(live, currentPages,
   currentRefs, nowMs, actor)` and **keeps only the page-plans whose `slug ∈ affectedSlugs`** (plus the
   orphan handling of §2.2 for affected slugs that `planRegen` does not re-emit). Every page-plan for a
   slug **not** in `affectedSlugs` is **dropped** — RECONCILE emits no write for it.

> **Targeting invariant (F-2, the load-bearing "not REGEN" property):** a page whose refs are all
> lint-clean is **never** in `affectedSlugs`, so RECONCILE emits **zero** writes for it — its
> `updated_at`, `body`, refs, and `stale` flag are byte-unchanged. This is what makes RECONCILE
> *targeted* and distinguishes it from REGEN (which rewrites every page). The fitness test seeds a
> clean page alongside a broken one and asserts the clean page is untouched.

### 4.2 Ownership boundary (same as REGEN §6.4)

RECONCILE only ever acts on pages whose `slug` is in the REGEN-owned kind-prefixed namespace
(`code/`, `api/`, `processes/`, `schema/`, `config/`). These are the only pages that *have* typed
`doc_ref` rows derivable from a `LiveSnapshot`, so they are the only pages the lint signal can flag and
the only pages `planRegen` can regenerate. A page authored by a human or another agent outside this
namespace has no machine-derivable refs, is never in `affectedSlugs`, and is structurally invisible to
RECONCILE's plan. RECONCILE never deletes or mutates such a page.

---

## 5. The plan the core produces

`planReconcile(lintResult, live, currentPages, currentRefs, nowMs, actor) : ReconcilePlan | ReconcileError`

```ts
interface ReconcilePlan {
  tenantId: string;                 // '' in core; stamped at edge (like RegenPlan)
  affectedSlugs: readonly string[]; // the targeted set (audit/summary visibility)
  // Pages to regenerate (reused RegenPagePlan, filtered to affectedSlugs that still have live backing):
  regenerate: readonly RegenPagePlan[];
  // Affected pages with NO live backing (orphans, §2.2) — mark stale + clear refs, do not delete:
  orphan: readonly OrphanPagePlan[];
  // Per affected page, the 'reconciled' doc_log entry (op='reconciled'):
  logs: readonly ReconcileLogPlan[];
  counts: { pagesRegenerated: number; pagesOrphaned: number; refsFixed: number; logsAppended: number };
}
interface OrphanPagePlan { pageId: string; slug: string; nowMs: number; }
interface ReconcileLogPlan {
  id: string; pageId: string; op: 'reconciled';
  agentActor: string; diffSummary: string | null; at: number;
}
interface ReconcileError { error: true; reason: 'post_reconcile_lint_dirty'; violations: DocRefViolation[]; }
```

Construction (pure, deterministic):
1. `affectedSlugs` = §4.1.
2. `regen = planRegen(live, currentPages, currentRefs, nowMs, actor)`. If `planRegen` returns its
   `RegenError` (broken-refs self-guard) — that is impossible here because its refs derive from `live` —
   propagate as `ReconcileError`. Otherwise filter `regen.pages` to `slug ∈ affectedSlugs` →
   `regenerate`. For each, the page's `log` (REGEN emits `op='regenerated'`) is **replaced** with an
   `op='reconciled'` `ReconcileLogPlan` (RECONCILE's distinct op-string; research-3 §2 vocab is open,
   T-0016-class — no migration). `doc_page.stale` is set to `false` for regenerated pages (cleared
   because the page now matches live; the store helper `markPageStale(false)` or, simpler, the
   `upsertDocPage` already writes `stale=false` literally — see §7).
3. **Orphans:** for each `slug ∈ affectedSlugs` for which `regen.pages` has **no** plan (the page lost
   all live backing, §2.2), emit an `OrphanPagePlan` (mark `stale=true`, ref-set → empty) and an
   `op='reconciled'` log with `diff_summary='orphaned: no live referents'`.
4. **Post-plan self-guard (F-1 correctness invariant, mirrors REGEN's F-4):** the planner computes the
   ref set that *would exist after applying the plan* — for each affected page, the refs from its
   `RegenPagePlan` (orphans contribute zero refs) plus every **unaffected** page's existing refs — and
   calls `checkDocRefs(postRefs, live)`. It must be `{ ok: true }` **EXCEPT** for refs that belong to
   orphan pages (which are intentionally cleared → contribute nothing) — i.e. the post-plan ref universe
   is lint-clean. If a violation survives on a *regenerated* page, the planner returns `ReconcileError`
   (a mapping bug; refuse to emit). This is the machine guarantee behind acceptance "ref fixed OR page
   marked": after RECONCILE, lint is clean OR the only-remaining-violations' pages are marked stale.

---

## 6. Idempotency — the central guarantee

A second RECONCILE run over an **already-clean** wiki is a **no-op**: zero page churn, zero duplicate
refs, zero duplicate logs.

### 6.1 Mechanism (pinned)

- **Clean wiki ⇒ empty affected set ⇒ empty plan.** After a first RECONCILE fixes everything, a fresh
  `checkDocRefs(currentRefs, live)` returns `{ ok: true }` (every surviving ref's referent is present;
  orphan pages have *zero* refs, so they contribute zero violations). `affectedSlugs = ∅` ⇒
  `regenerate = []`, `orphan = []`, `logs = []`. The edge writes nothing and appends no log. **No new
  pages, no new refs, no new doc_log rows.** (F-4.)
- **Re-run that DOES re-fix (live changed again) is still duplicate-free**, because every write goes
  through the same idempotent store helpers REGEN uses: `upsertDocPage` `ON CONFLICT (tenant_id, slug)
  DO UPDATE` (no second page row, id preserved), `setDocRefs` set-replace with
  `ON CONFLICT (tenant_id, page_id, ref_kind, ref_target) DO NOTHING` (no duplicate refs, orphaned refs
  deleted). Slugs are stable (T-0211 §5.1), so the same page is updated in place.
- **`doc_log('reconciled')` is append-only history** (NOT deduplicated — research-3 §2, pattern T-0016).
  Each run that *affects* a page appends ONE `reconciled` row for it. A no-op clean re-run affects zero
  pages → appends zero rows. Growing `doc_log` across *non-clean* runs is correct (it is the page's
  changelog), exactly as REGEN's `doc_log('regenerated')`. The "idempotent / no duplicate" acceptance
  applies to **pages and refs**, not to log history (F-4 asserts the clean re-run appends zero; F-3
  asserts the fixing run appends ≥1).

### 6.2 Post-reconcile lint cleanliness (acceptance "ref fixed")

After a RECONCILE that regenerates an affected page, `checkDocRefs` over that page's *new* refs against
`live` is `{ ok: true }` by construction (the new refs are `planRegen`'s, which are lint-clean against
the same `live` — T-0211 §5.3). After a RECONCILE that *orphans* a page, that page has zero refs → it
contributes zero violations, and `doc_page.stale=true` records the "marked" outcome (acceptance "page is
marked"). Either way the **whole-tenant** post-reconcile lint is clean. F-1 + F-7 pin this.

### 6.3 `stale` flag lifecycle (pinned)

`doc_page.stale` is the page-level signal. RECONCILE is the only writer of it in P-4 (lint/CI is a
detector and MAY set it in T-0134d runtime-lint, but P-4's operator path owns the *clearing*):
- a page that gets **regenerated** (live backing restored/refs re-derived) → `stale=false`;
- a page that becomes an **orphan** (no live backing) → `stale=true` (terminal until live returns or a
  human deletes it).
The `upsertDocPage` helper already writes `stale=false` literally on every upsert (T-0211 store, line
213). So regenerated pages get `stale=false` for free. Orphans need an explicit `stale=true` write — the
ONE new store helper `markPageStale` (§7). This is the only flag-mutation RECONCILE performs.

---

## 7. Store layer contract (REUSE + ONE additive helper)

`doc-page-store.ts` already has everything RECONCILE needs for the regenerate path:
`readDocPages`, `readDocRefs`, `upsertDocPage`, `setDocRefs`, `appendDocLog` (T-0211 §7). RECONCILE
**reuses them unchanged**. The ONLY addition:

```ts
/** Marks a page stale (or clears) WITHOUT touching body/title/refs. Used by RECONCILE's
 *  orphan branch (§2.2). Scoped to ONE page_id; tenant-scoped (RLS + explicit predicate, NF-1). */
export async function markPageStale(
  client: DocStoreClient, tenantId: string, pageId: string,
  stale: boolean, updatedAt: number,
): Promise<void>;
// UPDATE choros.doc_page SET stale = $3, updated_at = $4 WHERE tenant_id = $1 AND id = $2
```

- It runs INSIDE the caller's transaction (never opens its own connection, never sets the GUC) — same
  discipline as the other helpers (mirrors `audit-writer.ts` taking a `tx`).
- Orphan pages also need their refs cleared → reuse `setDocRefs(client, tenantId, pageId, [])` (the
  existing empty-set branch already deletes all refs for the page — T-0211 store, lines 279–288).

> **Either/or left to BUILD (1 line, pinned by fitness):** the orphan branch could instead set
> `stale=true` *via* `upsertDocPage` by passing the existing body and a `stale` arg — but `upsertDocPage`
> hard-codes `stale=false` (T-0211). Rather than widen that frozen-ish helper's signature, RECONCILE adds
> the focused `markPageStale`. **BUILD MUST use `markPageStale` for the orphan `stale=true` write**; F-5
> asserts the orphan page ends `stale=true` with zero refs. (No change to `upsertDocPage`.)

### 7.1 Edge orchestration (`scripts/doc-reconcile.ts`)

Within ONE transaction as `choros_app` with `SET LOCAL choros.tenant_id`:
`assembleFullSnapshot` → `readDocPages`/`readDocRefs` → `checkDocRefs` → `planReconcile` → for each
`regenerate` page: `upsertDocPage` → `setDocRefs(page.refs)` → `appendDocLog('reconciled')`; for each
`orphan`: `markPageStale(true)` → `setDocRefs([])` → `appendDocLog('reconciled')`; then emit ONE
run-level `audit_event('docs.reconciled')` (§8) → COMMIT. On any error: ROLLBACK, exit 1. `--dry-run`
prints the plan and ROLLBACKs. JSON summary:
`{ tenant, pagesRegenerated, pagesOrphaned, refsFixed, logsAppended, durationMs }`.

---

## 8. Audit & log

Mirrors REGEN (T-0211 §8) exactly — **doc operations are `audit_event` rows (open-vocab `docs.*`), NOT a
second log table.** RECONCILE emits, at the edge, **ONE `audit_event` per run** (run-level, matching
REGEN's chosen granularity) via the existing `AuditSink` path (`makePgAuditWriter` →
`appendAuditEvent`, `src/core/audit-grant-encoder.ts` → `AuditEventInput`):

- `type`: `'docs.reconciled'` (open-vocab, pattern T-0016 — new event = string, not table/migration).
- `actor`: the DocsAuthorAgent (`d0…015` / `docs-author`), never a raw secret.
- `subject`: `tenant:<id>`; tenant-scoped. `scope`: null (no cross-scope).
- `payload`: small machine summary `{ tenant, affectedSlugs, pagesRegenerated, pagesOrphaned, refsFixed,
  logsAppended, durationMs }`; **no secrets**.

This is **in addition to** the per-affected-page `doc_log('reconciled')` (§5/§6.1). The distinction is
identical to REGEN: `doc_log` = the page's content changelog (LLM-wiki "log" member); `audit_event` =
the hash-chained system audit floor. F-3 asserts the `doc_log` rows; F-8 asserts the audit event exists,
is tenant-scoped, and carries no secret.

---

## 9. Machine-checkable fitness criteria (F-1 .. F-10)

The tester/CI must assert ALL of the following. F-1/F-2/F-3/F-4/F-5/F-7/F-8/F-9 are **db-tier**
(live Postgres, `npm run fitness:db`, **fresh random tenant** per T-0205 — never mutate shared dev-tenant
fixtures); F-7 is also a **pure unit test**; F-6/F-10 are **static guards** (bash + a static-import
assertion), wired into `npm run fitness`. The db tests build a **deliberately-broken ref** by seeding a
tenant, running REGEN to produce real pages/refs, then *removing* a member from the snapshot fixture
(`assembleStaticSnapshot` + a member deleted, OR a hand-seeded `doc_ref` whose referent is absent) so
`checkDocRefs` reports a `missing_referent` — exactly the acceptance scenario.

### F-1 — broken ref → ref fixed OR page marked; post-reconcile lint clean (db, ACCEPTANCE)
Seed a tenant; create a page P with a `doc_ref` whose referent is **absent** from the live snapshot
(deliberately broken). Run RECONCILE. Assert: P's `doc_ref` set after the run contains **no** ref with a
missing referent (`checkDocRefs(refs_of_P, live).ok === true`) **OR** `doc_page.stale = true` for P
(orphan branch). Assert the **whole-tenant** post-reconcile lint is clean (every surviving ref resolves;
orphan pages have zero refs). This is the verbatim acceptance.

### F-2 — targeted: unaffected pages untouched (db, the "not REGEN" property)
Seed TWO pages: P_broken (≥1 broken ref) and P_clean (all refs resolve). Capture P_clean's
`(updated_at, body, ref rows, stale)` before. Run RECONCILE. Assert P_clean's row is **byte-identical**
after (same `updated_at`, same body, same refs, `stale` unchanged) and **no** `doc_log` row was appended
for P_clean. Proves RECONCILE touches only affected pages.

### F-3 — `doc_log('reconciled')` appended per affected page (db, ACCEPTANCE)
After the fixing run: `SELECT count(*) FROM choros.doc_log WHERE tenant_id=$1 AND op='reconciled'` ≥ 1,
each joined to an existing affected page. (Log is append-only; growing it is correct — asserted
explicitly so a reviewer doesn't mistake it for a duplicate bug.)

### F-4 — idempotent over a clean wiki = no-op (db)
After F-1's fixing run (wiki now clean), capture `(pageCount, refCount, logCount, max(updated_at))`. Run
RECONCILE **again** with the same live snapshot. Assert: `pageCount`/`refCount`/`logCount` **all
unchanged**, no `doc_page.id` changed, no `doc_page.updated_at` bumped, **zero** new
`doc_log('reconciled')` rows (empty affected set → empty plan → no writes). The central idempotency
guarantee.

### F-5 — orphan branch: page marked stale, refs cleared, not deleted (db)
Seed a page whose **every** backing member is absent from the live snapshot (orphan). Run RECONCILE.
Assert: the page **still exists** in `doc_page`, `stale = true`, has **zero** `doc_ref` rows, and a
`doc_log('reconciled')` row exists for it. (The explicit "(b) page is marked" acceptance branch.)

### F-6 — core is pure (static guard `ci/checks/doc-reconcile-isolation.sh` + `--self-test`)
New isolation guard (mirrors `doc-regen-isolation.sh`):
- `src/core/doc-reconcile.ts` exists.
- Forbidden imports absent: `pg`, `node:fs`, `node:http`, `node:net`, `node:child_process`,
  `child_process`, `import.meta`, `process.env`, `process.exit`. (`node:crypto` permitted, as in
  `doc-regen.ts`.)
- Does NOT import `./doc-live-snapshot.js` (collector is edge-only — the planner takes a `LiveSnapshot`
  + a `DocLintResult`, it assembles neither).
- Required exports present: `planReconcile`, `ReconcilePlan` (+ member types).
- `--self-test`: negative fixtures prove each violation is caught.

### F-7 — refs lint-clean / page marked, at the pure layer (pure unit)
Unit test over `planReconcile`: (a) fixture with a page whose ref's referent is present after a
live-change → plan regenerates it, and `checkDocRefs(postPlanRefs, live).ok === true`; (b) fixture where
all of a page's members vanished → plan puts it in `orphan` (not `regenerate`), refs → ∅; (c)
clean-input fixture (`lintResult.ok`) → empty plan (`regenerate=[]`, `orphan=[]`, `logs=[]`). Proves the
fix-vs-mark rule + idempotency without a DB.

### F-8 — audit emitted, secret-free (db or unit)
Assert ≥1 `audit_event` with `type='docs.reconciled'`, `actor='docs-author'`, tenant-scoped, `payload`
free of secret material. (If edge-only and hard to probe in db tier, a unit test over the
`AuditEventInput` builder suffices.)

### F-9 — tenant isolation / RLS not bypassed (db)
The operator path connects as `choros_app` (NOBYPASSRLS) and `SET LOCAL choros.tenant_id`. Assert a
second tenant's pages/refs are invisible during a RECONCILE scoped to tenant A (cross-tenant probe,
mirrors `cross_tenant.test.ts` / REGEN F-8), and RECONCILE never writes a row whose `tenant_id` ≠ the
GUC tenant (FORCE-RLS `WITH CHECK` would reject it).

### F-10 — additive only: no new grant/tool/resource_type/migration; frozen/known_tables unchanged
(static + db)
- **No new migration** by THIS task (RECONCILE reuses 061 tables + 063 tool authority; §11). If one were
  added it would be slot **064** — F-10 asserts there is none.
- `choros."grant"` count for `docs-author` (`e0…005`) unchanged = **2** (P-1's grants only).
- No new `mcp_tool` row (P-2's `doc_page_author`/`doc_ref_set` authority suffices; RECONCILE *uses* it).
- `ci/checks/known_tenant_tables.txt` unchanged (doc tables already listed since 061).
- New `doc_log.op` value `'reconciled'` is an **open-vocab string**, NOT a schema/CHECK change (T-0016
  class — `doc_log.op` has no CHECK; migration 061 line 146). No migration, no frozen-file edit.
- Frozen files unchanged: `src/core/mcp-tool-registry.ts`, `migrations/040_mcp_tool.sql`,
  `migrations/061_doc_page.sql`, `migrations/062_docs_author_seed.sql`,
  `migrations/063_docpage_writeful_tools.sql`, `src/core/doc-ref-lint.ts`,
  `src/core/doc-live-snapshot.ts`, `src/core/doc-regen.ts` (reused, not edited),
  `ci/checks/frozen-sanctions.jsonl`.
- **STATIC:** `scripts/doc-reconcile.ts` `DEFAULT_TENANT` constant === dev-tenant UUID
  `a0000000-0000-0000-0000-000000000001` (imported + asserted, same as REGEN F-10).

---

## 10. Authority argument (SEAM-2: draft-first, no promote, no new grant)

RECONCILE writes as the **DocsAuthorAgent** — a `choros_app` principal holding exactly P-1's two grants
`{doc_page,create}` and `{doc_page,update}`. Its writes correspond to P-2's `doc_page_author` /
`doc_ref_set` tool *semantics*:

- **Regenerate a page (upsert + body refresh)** ⇒ `doc_page_author` authority (`{doc_page,update}`).
- **Re-derive its refs / clear orphan refs (set-replace)** ⇒ `doc_ref_set` authority, which **rides
  `{doc_page,update}`** (doc_ref = child of doc_page, FK CASCADE — T-0210 §2). No `doc_ref`
  resource_type, no new grant.
- **Mark stale (`markPageStale`)** ⇒ a `doc_page` field write ⇒ `{doc_page,update}`. No new authority.
- **Append `doc_log('reconciled')`** ⇒ part of the page-update operation (log = page's changelog child,
  FK CASCADE). No separate authority. The new `op` string is open-vocab (no migration, no CHECK).
- **No promote power, no `scope='system'` projection, no second tenant** (SEAM-2 draft-first).

Adversarial privilege-escalation checklist (all structural, not gatekeeping-by-convention):
(a) RECONCILE cannot write a second tenant (FORCE-RLS `WITH CHECK` + `SET LOCAL choros.tenant_id`);
(b) cannot create a grant/tool/resource_type/migration (F-10);
(c) cannot promote (no promote grant/tool in its toolset; never writes `scope='system'`);
(d) cannot touch frozen objects (F-10; `doc-regen.ts` is reused read-only, not edited);
(e) cannot forge a ref to a non-existent referent (F-1/F-7 post-plan self-guard refuses to emit a
    surviving broken ref on a regenerated page; orphan refs are *cleared*, never fabricated);
(f) cannot widen `upsertDocPage` to smuggle a `stale`/`scope` change — the orphan write goes through the
    focused `markPageStale` (stale + updated_at only), `upsertDocPage` is unchanged (§7).

---

## 11. Migration decision: **NONE required**

RECONCILE is **runtime code + operator script + ONE store helper only**. It reuses:
- `doc_page` / `doc_ref` / `doc_log` tables (migration **061**, incl. `doc_page.stale` boolean and the
  two UNIQUE constraints that make idempotency work, and `doc_log.op`'s open vocab — no CHECK);
- the two writeful tools' authority semantics (migration **063**);
- the DocsAuthorAgent principal + grants (migration **062**);
- REGEN's `planRegen` + store helpers (T-0211 product code, reused).

No DDL, no new seed rows, no new vocab table, no new field. The `doc_log.op='reconciled'` value is an
open-vocab string (T-0016 class), not a schema change. **`needs_migration = false.`** For the record: the
next-free migration slot after 063 is **064** — RECONCILE does NOT consume it. (If a future reviewer
argues a partial index on `doc_page.stale` is wanted for orphan queries, that is an *additive index*
at 064 — NOT required for correctness/acceptance, day-1 volumes are tiny, explicitly out of P-4 scope.)

---

## 12. Decisions summary

| Decision | Choice | Rationale |
|---|---|---|
| Where RECONCILE lives | pure `src/core/doc-reconcile.ts` (`planReconcile`) + edge `scripts/doc-reconcile.ts` (`npm run docs:reconcile`) + reused store + ONE new helper `markPageStale` | mirrors REGEN's core-purity seam; logic fixture-testable, IO at edge |
| Operator command | `npm run docs:reconcile` (tsx, DATABASE_URL, `--tenant`, `--dry-run`, JSON summary, exit 0/1) | mirrors `scripts/doc-regen.ts` line-for-line |
| Lint signal source | `checkDocRefs(currentRefs, freshLive)` at the edge → `DocLintResult` into the planner | the ONE detector (T-0238); no second staleness mechanism (fingerprint = Stage-2) |
| Targeting | `affectedSlugs` = slugs of pages owning ≥1 violated ref; regenerate **only** those (filter `planRegen` output by slug); clean pages emit zero writes | the "not REGEN" property — targeted, not full-wiki |
| Fix-vs-regenerate rule | **ONE deterministic cure: targeted-regenerate the affected page via `planRegen` restricted to its slug** (re-derives refs from live = "(a) fix"; refreshes body + clears `stale`). Orphan (all members gone → `planRegen` emits no page) → **mark `stale=true` + clear refs** = "(b) mark" | day-1 lint only knows "referent gone"; "fix a ref" ≡ "re-project the page from the same snapshot `planRegen` consumes"; the two acceptance branches collapse to one motor + an orphan tombstone |
| Idempotency | clean wiki ⇒ empty affected set ⇒ empty plan ⇒ no writes; all writes via REGEN's idempotent store helpers (upsert ON CONFLICT slug; ref set-replace DO NOTHING); slugs stable | re-run over clean wiki = byte no-op; re-fix is duplicate-free |
| `doc_log` on re-run | append-only `op='reconciled'` per affected page; clean re-run appends zero; NOT deduplicated | pattern T-0016; "no duplicates" is pages/refs, not log history |
| `stale` lifecycle | regenerated page → `stale=false` (via `upsertDocPage`'s literal); orphan → `stale=true` (via new `markPageStale`); RECONCILE is the operator-path clearer | single page-level signal; only flag-mutation RECONCILE does |
| Audit | one `audit_event('docs.reconciled')` per run (open-vocab, secret-free) via existing AuditSink | T-0134 §3.3 / mirrors REGEN §8 |
| Scope / tenant | ALL pages `scope='tenant'`, single tenant, `choros_app` NOBYPASSRLS, GUC-scoped writes | draft-first SEAM-2; projection is T-0134i, not RECONCILE |
| Authority | DocsAuthorAgent, P-1's 2 grants, P-2's 2 tool semantics; no promote, no new grant/tool/resource_type | T-0210 ride-on model; SEAM-2 |
| Migration | **none** (reuses 061/062/063 + T-0211 code); `op='reconciled'` = open vocab; next-free = 064 (unconsumed) | runtime code only; no DDL/seed/vocab-table change |
| Fitness | F-1..F-10 (db + pure + static guard `doc-reconcile-isolation.sh` w/ self-test) | mirrors REGEN §9 / T-0210 §7 rigor |

---

## 13. Build plan (for the coder)

1. `src/db/doc-page-store.ts` — add ONE helper `markPageStale(client, tenantId, pageId, stale,
   updatedAt)` per §7 (UPDATE stale + updated_at only; takes a `tx`; tenant-scoped). Reuse all other
   helpers unchanged.
2. `src/core/doc-reconcile.ts` — PURE `planReconcile(lintResult, live, currentPages, currentRefs, nowMs,
   actor) → ReconcilePlan | ReconcileError` per §4/§5/§6. Reuses `planRegen` (filter by `affectedSlugs`),
   `slugify` (re-join violations→pageId/slug), `checkDocRefs` (post-plan self-guard). Replaces REGEN's
   `op='regenerated'` log with `op='reconciled'`. Orphan branch per §2.2. No forbidden imports (§9 F-6);
   does NOT import `doc-live-snapshot.js`.
3. `scripts/doc-reconcile.ts` — operator entry mirroring `scripts/doc-regen.ts`: parse
   `--tenant`/`--dry-run`; connect `choros_app`; `BEGIN; SET LOCAL choros.tenant_id`;
   `assembleFullSnapshot` → `readDocPages`/`readDocRefs` → `checkDocRefs` (build lintResult) →
   `planReconcile` → apply (`upsertDocPage`/`setDocRefs`/`markPageStale`/`appendDocLog('reconciled')`) →
   one `audit_event('docs.reconciled')` → `COMMIT`; JSON summary; exit 0/1. Export `DEFAULT_TENANT`,
   `DOCS_AUTHOR_ACTOR`.
4. `package.json` — add `"docs:reconcile": "npx tsx scripts/doc-reconcile.ts"` (no dup keys — passes
   `package-json-no-dup-keys.sh`).
5. `ci/checks/doc-reconcile-isolation.sh` (+ `--self-test`) — purity/exports/no-collector-import guard
   (§9 F-6); wire into `npm run fitness` (append, after `doc-regen-isolation.sh --self-test`).
6. Tests:
   - `src/core/__tests__/doc-reconcile.test.ts` — pure: F-7 (fix → lint-clean; orphan → marked;
     clean-input → empty plan), targeting filter, op='reconciled', slug-stable.
   - `ci/checks/db/doc-reconcile.db.test.ts` — db: F-1 (broken→fixed/marked), F-2 (targeted/untouched),
     F-3 (log), F-4 (idempotent clean re-run), F-5 (orphan marked), F-8 (audit), F-9 (tenant isolation),
     F-10 (no new grant/tool/table; DEFAULT_TENANT const static). Fresh-tenant fixture per T-0205;
     build the deliberately-broken ref by REGEN-then-remove-a-member.
7. Adversarial review focus: §10 privilege-escalation checklist + targeting (F-2 unaffected pages MUST
   be byte-untouched) + orphan branch (F-5 page survives, marked, refs cleared, not deleted) +
   idempotency (F-4 clean re-run = byte no-op).

**Fitness wiring summary:** pure tests run under `vitest`; db tests under `npm run fitness:db`
(`--dir ci/checks/db --no-file-parallelism`); the static guard `doc-reconcile-isolation.sh` appends to
the `fitness` script chain (followed immediately by its `--self-test`, matching the repo's
`<check>.sh && <check>.sh --self-test` convention, right after the `doc-regen-isolation.sh` pair).
