# T-0165 · ORG_SEED_CHILDREN dedup — SPEC

## Goal

Eliminate the 4 legacy local copies of `ORG_SEED_CHILDREN` / `isDescendantOrSelfSeed` /
`SEED_ORACLE` in `src/http/` by migrating each file to import the canonical
`SEED_ORACLE` from `src/http/seed-ancestry.ts` (introduced by T-0136 hotfix).

## Background

T-0136 created `src/http/seed-ancestry.ts` with the canonical `ORG_ANCESTRY_MAP`
and `SEED_ORACLE` export. Four files still carry verbatim copies:

| File | Task origin | Notes |
|---|---|---|
| `src/http/grants.ts` | original | frozen by config-agent-seed.sh Check-6 vs dev |
| `src/http/invoke.ts` | T-0024 | exports `SEED_ORACLE` consumed by `invoke-grant.test.ts` |
| `src/http/agents.ts` | T-0042 | frozen by config-agent-seed.sh Check-6 vs dev |
| `src/http/secret-handle.ts` | T-0025 | not frozen by any live check |

## Design decisions

### allow-list in `ci/checks/seed/single-source.sh`

The allow-list is embedded inside the T-0140-owned `single-source.sh`. The three
entries for `invoke.ts`, `agents.ts`, `secret-handle.ts` become **benign after
migration** (no `*_SEED` const in those files → grep produces no match → no FAIL).
The check semantics are "FAIL on unexpected const outside allow-list", not "FAIL if
listed file has no const". Therefore:

- **Do not modify `single-source.sh`** (T-0140-owned, `frozen-checks-immutable.sh`
  covers top-level `.sh` but not `ci/checks/seed/` subdirectory; regardless the
  allow-list is inside a foreign-owned file).
- The three stale entries are harmless; mark as candidate for cleanup in T-0140
  context when T-0140 owner amends that file.

### `invoke.ts` SEED_ORACLE re-export

`invoke-grant.test.ts` imports `SEED_ORACLE` from `invoke.ts` directly. To maintain
behavioral equivalence without touching the test, `invoke.ts` must continue to
**export** `SEED_ORACLE`. Strategy: `import { SEED_ORACLE } from "./seed-ancestry.js"` +
`export { SEED_ORACLE }` — binds the canonical value in local scope and re-exports it.

### Frozen-file FAILs (config-agent-seed Check-6)

`config-agent-seed.sh` Check-6 diffs `src/http/agents.ts` and `src/http/grants.ts`
vs `merge-base HEAD dev`. This branch modifies both → Check-6 is red on this branch.
This is the same "branch-red, зеленеет post-merge" class documented in
`choros-ci-check-gotchas.md` and sanctioned by review precedent T-0135.

## Acceptance criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | No `ORG_SEED_CHILDREN` const remains in `grants.ts`, `invoke.ts`, `agents.ts`, `secret-handle.ts` | fitness |
| AC-2 | `SEED_ORACLE` in all 4 files resolves to the same instance from `seed-ancestry.ts` | test |
| AC-3 | `npm run build` exits 0 (no new TypeScript errors) | fitness |
| AC-4 | `npm test` exits 0; 1548 tests pass unchanged | test |
| AC-5 | `ci/checks/seed/single-source.sh` exits 0 | fitness |
| AC-6 | `npm run fitness` produces exactly 2 FAIL lines (config-agent-seed Check-6 frozen-guard); all other checks green | fitness |
| AC-7 | `npm run fitness:db` exits 0 (603 DB tests green) | fitness |

## Out of scope

- Removing stale entries from `single-source.sh` allow-list (T-0140 owner cleanup)
- Fixing `config-agent-seed.sh` Check-6 false positives (green on merge to dev)
- DB-backed ancestry oracle (T-0053)
- Any behavioral change to org ancestry logic
