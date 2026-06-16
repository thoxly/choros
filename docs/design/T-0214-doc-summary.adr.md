# T-0214 · ADR: doc_page.summary — one-line index without body (P-6 docs-pipeline)

**Status:** accepted  
**Task:** T-0214  
**Date:** 2026-06-16  
**Precedents:** T-0211 (REGEN/P-3), T-0212 (RECONCILE/P-4), migration 061/023  

---

## Context

The docs-pipeline wiki (`doc_page`) stores a full Markdown `body` per page. An index/listing UI
or a tool surface that shows slug/title/scope/stale across many pages must currently SELECT the
full `body` column — potentially large — when it only needs metadata.

P-6 closes this gap by adding a one-line `summary` column:
- populated deterministically by REGEN from the same LiveSnapshot content as `body`,
- used by a new `readDocIndex` query that NEVER selects `body`.

---

## Decisions

### D-1: Additive nullable column — migration 064

`ALTER TABLE choros.doc_page ADD COLUMN IF NOT EXISTS summary text NULL`

- **Nullable:** backward-compatible; existing rows (pre-migration) have `summary IS NULL`.
- **Idempotent:** `ADD COLUMN IF NOT EXISTS`; DO-guard for CHECK constraint.
- **CHECK (single-line):** `summary IS NULL OR (position(E'\n' in summary) = 0 AND char_length(summary) <= 200)`
  — DO-guarded; max 200 chars keeps the constraint tight without risk of truncation for any current kind.
- **Column-not-table:** `known_tenant_tables.txt` is NOT touched (NF-2, mirrors migration 023).

### D-2: Summary derivation — deterministic, no newline, per kind

Summary strings are derived from the same data as `body` in `buildPageSpecs`:

| kind      | summary template                                               |
|-----------|---------------------------------------------------------------|
| code      | `` `${n}` code symbols in ${module} ``                       |
| api       | `` `${n}` REST endpoints ``                                  |
| processes | `` `${n}` process definitions ``                             |
| schema    | `` `${n}` schema fields in ${defId} ``                       |
| config    | `` `${n}` config keys ``                                     |

- `n` is always the count of sorted symbols/endpoints/etc. used for `body` — stable across runs.
- No timestamp, no UUID — idempotent across identical LiveSnapshot inputs.
- No embedded newline — CHECK constraint enforces this.

### D-3: summary in upsertDocPage and readDocPages

- `summary` is added to the INSERT column list and `EXCLUDED.summary` in the ON CONFLICT SET.
- The change-guard (body/title) already covers summary: summary co-varies with body
  (derived from same source), so no separate guard is needed.
- `readDocPages` SELECTs `summary` so round-trip callers get it back.

### D-4: New readDocIndex — no body column

`readDocIndex(client, tenantId)` selects:
```
tenant_id, id, slug, title, summary, scope, stale, updated_at
```
MUST NOT select `body`. Returns `DocPageIndexEntry[]`.

This is the load-bearing "without reading body" invariant enforced by static guard DSB-1.

### D-5: Static guard — ci/checks/doc-summary-no-body-in-index.sh

Grep-guards that `readDocIndex`'s SQL in `doc-page-store.ts` does NOT reference `body`
in its SELECT. Self-test includes a positive fixture (compliant function — passes) and a
negative fixture (function with `body` in SELECT — fails).

Wired into `fitness` chain after `doc-reconcile-isolation.sh --self-test`.

---

## Fitness

- TSC clean (no new types unsatisfied).
- Pure test: `src/core/__tests__/doc-summary.test.ts` — summary one-line, deterministic, all kinds.
- DB test: `ci/checks/db/doc-summary.db.test.ts` — fresh tenant, REGEN → readDocIndex → non-null
  summary, no `body` field in result, idempotent re-run, additive migration (existing rows).
- Static guard: `ci/checks/doc-summary-no-body-in-index.sh` — self-test passes.
- `known_tenant_tables.txt` unchanged (column-not-table, NF-2).
- `frozen-checks-immutable.sh` passes (no frozen-file edits).
