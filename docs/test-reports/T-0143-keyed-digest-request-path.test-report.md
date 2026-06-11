# Test Report · T-0143 — Wire keyedDigest into request-path ResolverDeps

**Verdict:** PASS
**Date:** 2026-06-11
**Branch:** task/T-0143-keyed-digest-request-path
**HEAD:** 20f7c5a23fd80ea5bc6c4302772fbc4253a301eb
**Tester role:** tester (D-025 — deterministic CI primary, LLM secondary)

---

## 1. Integration honesty check (D-056)

- **merge-base with dev:** `353ec791d997d0e5325ea660055188a0cf3a845d`
- **dev HEAD:**            `465d6aeaa9c4b957f58f763bd5485f61b6ea88df`
- **dev gap:** dev has moved ahead (8 commits: T-0145 + T-0119 docs + T-0039 merge). Rebase onto current dev HEAD is required **before merge** — orchestrator's decision per D-056. Gap does NOT affect the test verdict because the gap commits (T-0145 tenant-table counter, T-0119 docs-only) do not touch any files that T-0143 modifies.

---

## 2. CI gate — `npm run ci`

| Step       | Result       | Detail |
|------------|--------------|--------|
| `tsc --noEmit` | PASS (exit 0) | 0 type errors |
| `eslint src`   | PASS (exit 0) | 2 pre-existing warnings (`no-console` in bridge-runner.ts + externalTaskBridge.ts), 0 errors |
| `npm run fitness` | PASS | All 43 static fitness checks green incl. `keyed-digest-core-purity.sh` (FF-T143-5) with positive+negative self-tests |
| `vitest run`   | PASS | 908 passed / 5 skipped / 0 failed across 46 test files (1 skipped file = flowable integration, requires live Flowable) |

**Total deterministic:** 908 passed, 0 failed.

---

## 3. AC-by-AC coverage

### AC-1 — keyedDigest present at request-path makeGrantResolver (wiring test)

**Test:** `src/__tests__/keyed-digest-e2e.test.ts` > `FF-T143-2` > "keyedDigest.digest() returns 64-char hex when CHOROS_MASK_DIGEST_KEY is set"

- Calls `startMain({ listen: false, env: { CHOROS_MASK_DIGEST_KEY: "a".repeat(64) } })`
- Asserts `handle.resolverDeps.keyedDigest.digest(...)` matches `/^[0-9a-f]{64}$/`
- **Result: PASS**

### AC-2 — e2e: keyed hash active through real HTTP composition root

**Test:** `src/__tests__/keyed-digest-e2e.test.ts` > `FF-T143-3` > "resolveFor with CHOROS_MASK_DIGEST_KEY set: restricted ssn field is a 64-char lowercase hex string"

- Calls `startMain` (real composition root, `listen: false`) with `CHOROS_MASK_DIGEST_KEY` set
- Takes `keyedDigest` from `handle.resolverDeps.keyedDigest` — the SAME allocation passed to `createServer()` (object identity proven by R-2 fix in `main.ts:134,152`)
- Calls `resolveFor(testDeps(handle), ...)` — exercises the real resolver through the composition-root bound digest
- Asserts `ssn` field is `64-char lowercase hex`, NOT raw value, NOT keyless djb2
- **Result: PASS**
- **Pattern-b proof:** `resolverDepsObj` in `startMain` is a single allocation passed to `createServer()` AND returned as `MainHandle.resolverDeps`. The test uses the handle's field — same object identity as the server closure.

### AC-3 — e2e: absent key → hash field drops (fail-closed at request-path level)

**Test:** `src/__tests__/keyed-digest-e2e.test.ts` > `FF-T143-4` > "resolveFor without CHOROS_MASK_DIGEST_KEY: restricted ssn field is ABSENT (honest degrade)"

- Same composition root, `env: {}` (no key)
- Asserts `"ssn" in result.fields === false`; paranoia checks raw value + keyless djb2 absent from output JSON
- **Result: PASS**

### AC-4 — T-0118 unit suite non-regression

**Test:** `src/__tests__/hash-oracle.test.ts` — 14 tests

- All 14 tests pass unchanged
- **Result: PASS**

### AC-5 — T-0033 + T-0021 unit suites non-regression

**Tests:** `src/__tests__/data-classification.test.ts` (34 tests), `src/__tests__/grant-resolver.test.ts` (48 tests)

- 34 + 48 = 82 tests, all pass
- **Result: PASS**

### AC-6 — FF-DC9 purity invariant still green

**Fitness:** `ci/checks/data-classification-isolation.sh` — FF-DC9 check

- CI output: `PASS [DC9]: no forbidden imports (no pg/fs/net/http/crypto; no process.env; keyed digest via injected port)`
- **Result: PASS**

### AC-7 — MainHandle.resolverDeps.keyedDigest is the bound port (composition test)

**Test:** `src/__tests__/keyed-digest-e2e.test.ts` > `FF-T143-2` — two sub-tests:
1. With key: `digest(...)` returns `/^[0-9a-f]{64}$/`
2. Without key: `digest(...)` returns `undefined`

- **Result: PASS**

### AC-8 — No new process.env reads inside src/core/ (static grep)

**Fitness:** `ci/checks/keyed-digest-core-purity.sh` (FF-T143-5)

- CI output: `PASS [FF-T143-5]: no process.env in masking modules (env boundary intact)`
- Independent grep verification: `git diff $(merge-base)..HEAD -- src/core/` contains zero new `process.env` lines.
- Pre-existing `flowable-client.ts:264/269/274` reads are not introduced by T-0143 (pre-existing code).
- **Result: PASS**

### AC-9 — Existing wired-entry test (main-wired-entry.test.ts) stays green

**Test:** `src/__tests__/main-wired-entry.test.ts` — 1 test

- Test passes unchanged
- **Result: PASS**

---

## 4. Negative scenario verification (§7)

- Pre-T-0118 keyless djb2 output verified absent from AC-2 test (explicit `expect(ssnValue).not.toBe(keylessDjb2)`)
- Drop-on-absent verified in AC-3 test (explicit `expect("ssn" in result.fields).toBe(false)` + JSON.stringify paranoia)
- **Result: PASS**

---

## 5. Fitness function self-test proof (per review R-1)

The `keyed-digest-core-purity.sh` fitness function ships with:
- **Self-test 1 (positive):** planted `process.env` code line in temp file → grep detects it → PASS
- **Self-test 2 (negative):** comment-only `process.env` mention → no match → PASS

Both self-tests ran green in CI output above.

---

## 6. Summary

| Metric | Value |
|--------|-------|
| ACs covered | 9/9 |
| Deterministic tests: total | 908 |
| Deterministic tests: passed | 908 |
| Deterministic tests: failed | 0 |
| Fitness checks | 43/43 PASS |
| Dev gap (commits behind) | 8 (T-0145, T-0119 docs, T-0039) — no conflict with T-0143 file set |
| Verdict | **PASS** |

---

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
