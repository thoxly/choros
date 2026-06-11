# Spec · T-0143 — Wire keyedDigest into request-path ResolverDeps

**Phase:** SPEC
**Status:** ready (no BLOCKING)
**Product:** Choros · Epic E4.3-fu follow-up (review N-1 of T-0118)
**Base:** dev (T-0118 merged) · branch `task/T-0143-keyed-digest-request-path`
**Born from:** T-0118 post-merge review finding N-1 (ADR §4.4 NOTE):
> "the resolver `ResolverDeps` is not yet assembled inside the shipped `main.ts`
> lifecycle path … Wire the `KeyedDigest` at whichever composition seam
> constructs `makeGrantResolver` for the request path"

---

## 1. Problem

T-0118 introduced the `KeyedDigest` port (`src/core/keyed-digest.ts`) and wired
it through `ResolverDeps → buildMaskContext → MaskContext` so that
`maskFields` uses a secret-keyed HMAC instead of the old keyless djb2 for the
`hash` value transform. The port is fully implemented and T-0118's fitness suite
is green.

**However**: the `KeyedDigest` built at the `startMain` composition root
(`src/main.ts:140–145`) is placed on `MainHandle.resolverDeps` but is **never
threaded into the `ResolverDeps` passed to `makeGrantResolver`** on the actual
HTTP request path. The `createServer()` call inside `startMain` (line 128)
constructs its router via `buildRouter()`, which never receives or propagates
`resolverDeps`. As a result:

- In unit tests that build `ResolverDeps` manually and inject `keyedDigest`,
  the masking oracle fix is active and all T-0118 fitness checks pass.
- In live traffic (any HTTP request through the real server), `makeGrantResolver`
  is never called from the request path at all — the `keyedDigest` built from
  `CHOROS_MASK_DIGEST_KEY` is dead code from the perspective of the served API.

Review finding N-1 documents this as an explicit open item.

## 2. What this task requires

1. **Wire `resolverDeps.keyedDigest` into the composition seam that constructs
   `makeGrantResolver` for the request path.** The `keyedDigest` already built by
   `buildKeyedDigestFromEnv` in `startMain` must be propagated to the
   `ResolverDeps` used by every `resolveFor` call triggered by a real HTTP
   request. The mechanism (how `createServer`/`buildRouter` receives the dep —
   parameter threading, options bag, or a separate factory) is the architect's
   / coder's call; the requirement is that an HTTP request that would reach
   `makeGrantResolver` does so with `keyedDigest` present and bound to the silo
   secret, not absent.

2. **Add an e2e test that proves the wiring is active in the real request path.**
   The test must:
   - Drive a genuine HTTP request through the **real composition root**
     (`startMain` with a controlled `env` that contains `CHOROS_MASK_DIGEST_KEY`).
   - Reach the `makeGrantResolver` / `resolveFor` code path with a
     `classifications`-bearing `ResolverDeps` that contains both a classified
     field resolving to the `hash` transform and the injected `keyedDigest`.
   - Assert that the returned masked value is a keyed HMAC-SHA256 hex string
     (64 hex chars), NOT the pre-T-0118 keyless djb2, NOT the raw value, NOT
     absent (i.e., the `hash` field is present in the masked output).
   - Additionally assert that the same field masked WITHOUT `keyedDigest`
     (same composition root, no `CHOROS_MASK_DIGEST_KEY` in env) produces a
     DROP (the field is absent), never the raw value, never the keyless digest.

   A test that manually assembles `ResolverDeps` and calls `resolveFor` directly
   does NOT satisfy this AC — the composition seam (the link between `startMain`
   → `createServer` → `buildRouter` → route-handler → `makeGrantResolver`) must
   be exercised, not bypassed.

## 3. Functional requirements

- **FR-1 — Composition seam propagates keyedDigest.** When `startMain` is called
  with a `CHOROS_MASK_DIGEST_KEY` env var, the `KeyedDigest` built from that key
  is present on the `ResolverDeps` passed to `makeGrantResolver` for every HTTP
  request that reaches the PDP.

- **FR-2 — Honest degrade in absence.** When `startMain` is called WITHOUT
  `CHOROS_MASK_DIGEST_KEY`, the `keyedDigest` member is absent or bound to a
  fail-closed instance (digest always returns `undefined`), and every `hash`
  field drops — never keyless, never raw. This mirrors T-0118 AC-6 but at the
  request-path level.

- **FR-3 — No-op when `makeGrantResolver` is not yet on the request path.**
  If the current server routes do not yet call `makeGrantResolver` / `resolveFor`
  for any live endpoint, the composition seam must be laid out so that WHEN such
  a route is added it automatically inherits the `keyedDigest` from the root
  (no second wiring step). The e2e test is the proof: it must call `resolveFor`
  through the REAL composition root, not through a manually constructed `deps`.

- **FR-4 — T-0118 fitness functions stay green.** The 13 T-0118 fitness checks
  (unit + shell) must remain passing. The request-path wiring is additive; the
  core logic does not change.

- **FR-5 — `MainHandle.resolverDeps` shape preserved.** The `resolverDeps:
  { keyedDigest: KeyedDigest }` field on `MainHandle` must remain (it is the
  composition root's output surface and is tested in the wired-entry test);
  downstream consumers that read `handle.resolverDeps.keyedDigest` must continue
  to work.

## 4. Non-functional requirements

- **NF-1 — No `process.env` under `src/core/`.** FF-DC9 (the forbidden-import
  check on `data-classification.ts`) and the analogous purity invariant on
  `grant-resolver.ts` remain green. The secret stays at the `src/main.ts`
  boundary only.

- **NF-2 — Additive only (no signature breakage, FE-W23-0008).** The
  `resolveFor` / `makeGrantResolver` / `projectFields` / `visibleFields` /
  `grantFacetFields` exports retain their existing signatures. `ResolverDeps`
  already has `keyedDigest?: KeyedDigest` as an additive optional member; no
  further widening is needed on the interface.

- **NF-3 — Backward-compatible degrade.** Routes or callers that pass a
  `ResolverDeps` without `keyedDigest` continue to behave exactly as before
  T-0118 (hash → drop, never raw, never keyless). The wiring change must not
  break any existing test.

## 5. Out of scope

- Changing the `hash` transform semantics, class ladder, or clearance model.
- Adding new HTTP endpoints or modifying any route handler beyond what is needed
  to thread `keyedDigest` to `makeGrantResolver`.
- Per-tenant key management, key rotation, or key-table DB design (T-0118
  ADR §2.1 settled this: one silo-level env secret, no DB table).
- Migration (there is no persisted hash to update — masking is on-read).
- Python bindings or non-TypeScript implementations (T-0057 Stage-2).
- T-0143 does NOT re-test T-0118's core HMAC correctness (that is FF-T118-2
  through FF-T118-13, already green).

## 6. Acceptance criteria

### AC-1 — keyedDigest present at request-path makeGrantResolver (wiring test)

**Verifiable as:** test

A test that calls `startMain({ env: { CHOROS_MASK_DIGEST_KEY: <32-byte hex> },
listen: false })` and then invokes `resolveFor` (or the route that calls it)
with `deps.keyedDigest` injected from `handle.resolverDeps.keyedDigest` must
produce a hex-format masked value (64 hex chars) for a field classified as
`restricted` read by a `public`-clearance subject — i.e., the `hash` transform
is keyed, not absent.

Equivalently: an assertion on `handle.resolverDeps.keyedDigest.digest(...)` must
return a 64-char hex string (not `undefined`) when a valid key is bound.

### AC-2 — e2e: keyed hash active through real HTTP composition root

**Verifiable as:** test

An e2e test drives a real HTTP request through the actual `startMain`-wired
server (not a manually assembled `deps` object). The request reaches
`makeGrantResolver` / `resolveFor` with both a `ClassificationSource` and the
`keyedDigest` from the composition root. The response field that resolves to
`hash` must be a 64-char lowercase hex string, NOT the pre-T-0118 keyless djb2
output, NOT the raw value, NOT absent.

The test passes `CHOROS_MASK_DIGEST_KEY` via the `env` injection seam of
`StartMainOptions` — no actual secret is committed.

### AC-3 — e2e: absent key → hash field drops (fail-closed at request-path level)

**Verifiable as:** test

The same e2e test (or a sibling) repeats the request with `startMain({ env: {}
})` (no `CHOROS_MASK_DIGEST_KEY`). The response field that would be `hash`-masked
is ABSENT from the output (dropped), never the raw value, never the keyless djb2
hex string. The server must start and respond normally — this is an honest degrade,
not a crash.

### AC-4 — T-0118 unit suite non-regression

**Verifiable as:** test

All tests in `src/__tests__/hash-oracle.test.ts` continue to pass unchanged.
The T-0143 change is additive to the composition layer; the core masking behavior
asserted by T-0118 is not altered.

### AC-5 — T-0033 + T-0021 unit suites non-regression

**Verifiable as:** test

`src/__tests__/data-classification.test.ts` and `src/__tests__/grant-resolver.test.ts`
continue to pass unchanged. The additive wiring must not break any pre-T-0118 path.

### AC-6 — FF-DC9 purity invariant still green

**Verifiable as:** fitness

`ci/checks/data-classification-isolation.sh` (the FF-T118-1 / DC9 forbidden-import
fitness function that checks `data-classification.ts` does NOT import
`node:crypto`, `crypto`, `process.env`, or `process\.env`) stays green after the
T-0143 change. The request-path wiring change must not introduce any
env/crypto import into the pure core.

### AC-7 — MainHandle.resolverDeps.keyedDigest is the bound port (composition test)

**Verifiable as:** test

When `startMain({ env: { CHOROS_MASK_DIGEST_KEY: <key> }, listen: false })` is
called, `handle.resolverDeps.keyedDigest.digest({ value: "v", tenantId: "t",
resourceType: "r", facetField: "f" })` returns a 64-char hex string. When called
without `CHOROS_MASK_DIGEST_KEY`, the same call returns `undefined` (fail-closed
honest-degrade).

### AC-8 — No new process.env reads inside src/core/ (static grep)

**Verifiable as:** fitness

`grep -rn "process\.env\|process\[.env.\]" src/core/` returns no new matches
introduced by T-0143. The env boundary stays exclusively in `src/main.ts`.

### AC-9 — Existing wired-entry test (main-wired-entry.test.ts) stays green

**Verifiable as:** test

`src/__tests__/main-wired-entry.test.ts` passes without modification. The
T-0143 change must not break the existing `startMain` → lifecycle-bridge
composition asserted there.

## 7. Negative scenario (what must be proven impossible)

The pre-T-0118 keyless djb2 output MUST NOT appear in any HTTP response for a
`hash`-masked field, regardless of whether `CHOROS_MASK_DIGEST_KEY` is set:

- Key present → keyed HMAC-SHA256 hex (64 chars, deterministic per
  `(tenant, field, value, key)`).
- Key absent → field dropped (key absent from response JSON), never keyless.

This is the property the T-0118 ADR §4.4 NOTE called out as not yet active
in live traffic. The AC-2/AC-3 e2e pair constitutes the evidence that it is now
active.

## 8. Test approach note (for tester)

The e2e test for AC-2/AC-3 must exercise the REAL composition seam. Acceptable
patterns (architect/coder chooses one):

a. `startMain` + inject in-memory `GrantSource`/`RecordSource`/
   `ClassificationSource` via whatever seam `createServer`/`buildRouter` exposes
   after T-0143 wires `resolverDeps`, then call an HTTP endpoint that exercises
   `resolveFor`.

b. Call `resolveFor(handle.resolverDeps, ...)` directly where `handle` is the
   `MainHandle` returned by `startMain` — this is valid IFF `handle.resolverDeps`
   is the SAME `ResolverDeps` object passed to `makeGrantResolver` in the request
   path (i.e., the composition seam is proven by the object identity or by
   construction, not by coincidence).

Pattern (a) is preferred — it tests the FULL stack from HTTP socket to masked
field. Pattern (b) requires a proof-of-equivalence comment in the test.

## 9. Traceability

| AC | Requirement | T-0118 basis |
|----|-------------|--------------|
| AC-1 | FR-1 — keyedDigest wired to request-path | ADR §4.4 NOTE |
| AC-2 | FR-1, FR-3 — e2e active in live traffic | ADR §4.4 NOTE |
| AC-3 | FR-2 — honest degrade at request-path | T-0118 AC-6 |
| AC-4 | FR-4 — T-0118 unit suite non-regression | T-0118 §5 |
| AC-5 | FR-4 — T-0033/T-0021 non-regression | FF-T118-10/12 |
| AC-6 | NF-1 — FF-DC9 purity invariant | FF-T118-1 |
| AC-7 | FR-1, FR-5 — MainHandle.resolverDeps shape | ADR §4.4 |
| AC-8 | NF-1 — no env in core (grep fitness) | FF-DC9 |
| AC-9 | NF-3 — backward-compatible degrade | D-056 R-1 gate |

---

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
