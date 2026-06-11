# Spec · T-0187 — package.json duplicate "fitness" key: union-merge + guard

**Status:** ready  
**Phase:** SPEC  
**Date:** 2026-06-11  
**Task:** T-0187 (standard_code, prio 58)

---

## 1. Context

`package.json` contains **two** top-level `"fitness"` keys (lines 13–14). JSON
parsers (including Node.js `JSON.parse` and npm itself) are spec-compliant in
returning only the **last** value when a key appears more than once. The first key
is therefore silently ignored at runtime.

This creates a **gate hole**: any check that exists only in the first key never
runs during `npm run fitness`, meaning its corresponding invariant is structurally
unverifiable until the duplicate is corrected.

---

## 2. Precise diff: what is currently silently NOT running

A raw node comparison of the two key values (`node -e` regex parse) reveals:

### 2.1 Checks present in KEY-1 (line 13) but ABSENT from KEY-2 (line 14) — **LOST** checks

| # | Command | Status on current dev |
|---|---------|----------------------|
| L-1 | `bash ci/checks/named-binding-isolation.sh` | **GREEN** (PASS NB-1..NB-6) |
| L-2 | `npm run build` | **GREEN** (tsc + seed/tsc compile) |

These two entries sit between `bash ci/checks/config-agent-seed.sh` and
`bash ci/checks/worker-auth-config-failfast.sh` in key-1 but were omitted when
key-2 was written (likely copy-paste/edit gap when appending new checks).

### 2.2 Checks present in KEY-2 (line 14) but ABSENT from KEY-1 (line 13) — **NEW** checks added in key-2

`sim-adr-foundations.sh`, `sim-adr-structure.sh`,
`sim-adr-foundations.sh --self-test`, `sim-adr-structure.sh --self-test`,
`tier-isolation.sh`, `demo/pack-serve-no-write.sh`, `demo/frozen-exports.sh`,
`demo/no-hardcoded-tenant.sh`, `demo/self-test-presence.sh`,
`demo/pack-serve-counts.sh`, `demo/no-db-fallback.sh`, `bundle-coherence.sh`,
`grant-trail-bypassrls-predicate.sh`,
`grant-trail-bypassrls-predicate.sh --self-test`,
`db-isolation-setup-registered.sh`, `db-isolation-no-test-change.sh`,
`db-isolation-globalsetup-pure.sh`, `db-isolation-template-url.sh`,
`db-isolation-cleanup-registered.sh`, `db-isolation-run-id-pattern.sh`,
`db-isolation-fallback-path.sh`, `db-isolation-teardown-terminate.sh`,
`db-isolation-self-test.sh` (23 entries, all exclusive to key-2).

### 2.3 Union count

- KEY-1: 72 entries
- KEY-2: 93 entries  
- Union: **95 entries** (72 + 23 new − 0; plus L-1 and L-2 inserted at correct
  position within the key-2 sequence)

---

## 3. Root cause

Key-2 was written by appending new checks onto a copy of an earlier version of
key-1, but the `named-binding-isolation.sh` + `npm run build` entries (L-1, L-2)
had already been present in the then-current key-1 and were inadvertently dropped
during the edit.

---

## 4. Functional requirements

**FR-1.** The `"fitness"` key in `package.json` MUST appear **exactly once**,
containing the union of all commands from both previous keys, in the order:
key-2-body with L-1 (`named-binding-isolation.sh`) and L-2 (`npm run build`)
re-inserted between `config-agent-seed.sh` and `worker-auth-config-failfast.sh`.

**FR-2.** A **duplicate-key guard** CI check MUST be added as a new file
`ci/checks/package-json-no-dup-keys.sh` (owner line `# T-0187 ·`) that:
- Parses `package.json` with a Node.js script to detect any duplicate top-level
  (and scripts-level) keys.
- Exits non-zero (fail) if any duplicate is found.
- Includes a `# SELF-TEST` section that verifies the check correctly detects a
  synthetic duplicate.

**FR-3.** The guard check MUST be registered in `npm run fitness` (appended to the
merged `fitness` value).

**FR-4.** `npm run fitness` (the merged key) MUST run cleanly on the current dev
state (no regressions from re-enabling the previously-lost checks).

---

## 5. Non-functional requirements

**NF-1.** The existing `ci/checks/frozen-checks-immutable.sh` guard MUST be
respected: the guard check file is **new** (not amending any frozen file).

**NF-2.** No changes to any existing `ci/checks/*.sh` files.

**NF-3.** The JSON file MUST remain valid (`JSON.parse` succeeds).

**NF-4.** `npx tsc --noEmit` MUST continue to pass.

**NF-5.** `npm test` (vitest, no ambient `DATABASE_URL`) MUST continue to pass.

---

## 6. Out of scope

- Fixing any pre-existing failures among the key-2 checks (those were already
  running and their status is unchanged).
- Changes to script content or logic of any existing check.
- Re-ordering checks beyond the minimal insertion needed to restore lost entries.
- Adding new functional checks beyond the duplicate-key guard.

---

## 7. Acceptance criteria

### AC-1 — Single fitness key (fitness)

`cat package.json | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); const keys=Object.keys(d.scripts); const dups=keys.filter((k,i)=>keys.indexOf(k)!==i); if(dups.length) process.exit(1)"` exits 0.

**Verifiable as:** fitness

### AC-2 — Lost checks re-enabled and green (fitness)

`bash ci/checks/named-binding-isolation.sh` exits 0.  
`npm run build` exits 0.  
Both are included in `npm run fitness` output.

**Verifiable as:** fitness

### AC-3 — Union count correct (fitness)

The merged `fitness` value contains exactly 96 `&&`-separated commands (95 bash
entries + the guard check appended = 96 total after FR-3 registration).

**Verifiable as:** fitness (count-check in guard self-test)

### AC-4 — Guard check detects duplicate (fitness)

`bash ci/checks/package-json-no-dup-keys.sh` exits 0 on current `package.json`.
Its `--self-test` invocation exits 0 (self-test passes).

**Verifiable as:** fitness

### AC-5 — TypeScript clean (fitness)

`npx tsc --noEmit` exits 0.

**Verifiable as:** fitness

### AC-6 — Vitest green (test)

`npm test` exits 0 without ambient `DATABASE_URL`.

**Verifiable as:** test

---

## 8. Blocking questions

None. The scope is fully determined by the diff analysis. No founder-level
ambiguity.
