# ADR · T-0143 — Wire keyedDigest into request-path ResolverDeps

**Phase:** DESIGN
**Status:** ready (no founder blocker)
**Product:** Choros · Epic E4.3-fu follow-up (review N-1 of T-0118)
**Base:** dev (T-0118 merged) · branch `task/T-0143-keyed-digest-request-path`
**Spec:** `docs/specs/T-0143-keyed-digest-request-path.spec.md` (9 AC, ready) +
`docs/specs/T-0143.spec.contract.json`
**Born from:** T-0118 ADR §4.4 NOTE — "Wire the KeyedDigest at whichever composition
seam constructs makeGrantResolver for the request path"

---

## 1. Context (what the design must fix)

T-0118 introduced `KeyedDigest` and wired it through `ResolverDeps → buildMaskContext
→ MaskContext → maskFields`. All unit fitness checks are green. The gap is at the
composition boundary:

- `startMain` (line 128) calls `createServer()` with NO `resolverDeps` argument.
- `buildRouter` receives no `resolverDeps` argument from `createServer`.
- No HTTP route currently calls `makeGrantResolver` or `resolveFor`.
- `MainHandle.resolverDeps.keyedDigest` is built and placed on the handle but is
  never propagated to where `makeGrantResolver` would be constructed in a request
  handler.

Result: `keyedDigest` is dead code from the perspective of live HTTP traffic. The
seam from `startMain` → `createServer` → `buildRouter` → `makeGrantResolver`
is completely absent.

---

## 2. Decision (the mechanism, one paragraph)

**Thread `resolverDeps` through the composition stack as an optional parameter on
`createServer` and `buildRouter`, and expose the SAME `resolverDeps` instance on
`MainHandle` so that e2e tests can call `resolveFor(handle.resolverDeps, ...)` and
prove the wiring by construction (spec §8 pattern b).**

Concretely:

1. `createServer` gains an additive optional second parameter:
   `resolverDeps?: ResolverDeps` (the full interface, not just `{ keyedDigest }`
   — avoids widening in the future).
2. `buildRouter` gains a matching optional last parameter: `resolverDeps?: ResolverDeps`.
3. `startMain` passes `{ keyedDigest }` (already built from `buildKeyedDigestFromEnv`)
   as the `resolverDeps` argument to `createServer()`. The SAME object is placed on
   `MainHandle.resolverDeps` (preserving FR-5 / AC-7 / AC-9 unchanged). Object
   identity between `handle.resolverDeps` and the object received by `buildRouter`
   is guaranteed by construction — both come from the same allocation in `startMain`.
4. `buildRouter` stores `resolverDeps` in local scope; every route-registration
   function that calls `makeGrantResolver` (now or in the future) receives it from
   this captured variable. No second wiring step is required when a new route is
   added (FR-3).
5. The proof of wiring (AC-1/AC-2/AC-7) is established by calling
   `resolveFor(handle.resolverDeps, ...)` directly in the e2e test (spec §8
   pattern b). The proof-of-equivalence comment in the test states:
   `handle.resolverDeps` is the exact object `startMain` passed to `createServer`
   (verified by construction, same allocation — not by coincidence or object
   comparison at runtime). A real HTTP route that calls `makeGrantResolver` will use
   the same `resolverDeps` from `buildRouter`'s closure, which closes the seam
   chain.
6. No new HTTP endpoint is added. No route handler is changed except to accept
   `resolverDeps` from the `buildRouter` closure parameter — a mechanical pass-down.
   This is the "additive only, no signature breakage" constraint (NF-2 / FE-W23-0008).

This is the minimum-footprint seam that closes the noted gap (T-0118 ADR §4.4 NOTE),
keeps all 13 T-0118 fitness checks green (additive on the composition layer only),
and satisfies FR-3 (any future route auto-inherits). No existing test is modified.

---

## 3. Rejected alternatives

| Option | Why not |
|--------|---------|
| **Add a minimal probe HTTP route (`GET /api/resolve-probe`) to force an e2e HTTP request through `makeGrantResolver`** | Gold-plating: FR-3 spec says "additive only; no new routes beyond threading keyedDigest". A probe endpoint that exists only for test purposes is extra surface and test-coupling. Pattern (b) from spec §8 is explicitly provided as a valid e2e proof; it avoids adding any new production route. |
| **Wrap `resolverDeps` in a singleton module-level variable in server.ts** | Creates hidden global state; makes `createServer` non-re-entrant and non-testable with different deps. The pattern across this codebase is explicit injection (injected ports, not globals). |
| **Pass `resolverDeps` via an environment-variable read inside `buildRouter`** | Violates FF-DC9 / NF-1 — `process.env` reads must stay exclusively in `src/main.ts`. Re-introduces the env boundary inside `server.ts`. |
| **Make `MainHandle` expose a `makeResolver()` factory and call it from the route** | Adds a route-level dependency on `MainHandle` and couples the request path back to the startup handle. Violates single-direction dependency (routes do not know about the handle). |
| **Thread `keyedDigest` only (not the full `ResolverDeps`)** | Narrowing the parameter type to `{ keyedDigest: KeyedDigest }` creates a second partial `ResolverDeps` shape and will require a signature change when the next optional port is threaded. The full `ResolverDeps` interface is the established pattern; the optional type makes it backward-compatible. |

---

## 4. Object model / contracts (source of truth for `coder`/`tester`)

### 4.1 `createServer` signature change (ADDITIVE, `src/server.ts`)

```ts
// BEFORE (existing):
export function createServer(
  store: JobStore | PostgresJobStore | InMemoryJobStore = createJobStore()
): http.Server

// AFTER (additive optional second parameter):
export function createServer(
  store: JobStore | PostgresJobStore | InMemoryJobStore = createJobStore(),
  resolverDeps?: ResolverDeps   // T-0143: threaded to buildRouter; absent => hash fields drop (FR-2)
): http.Server
```

`handleRequest` (the lazy-built compatibility export) does NOT need `resolverDeps`
— it is explicitly a backward-compatible shim used only by tests that import
`handleRequest` directly and do not test masking. Its `buildRouter()` call gains
no second argument; `resolverDeps` is absent there; `hash` fields will drop
(honest degrade, consistent with FR-2/NF-3).

Importers of `createServer` that pass zero or one argument are unaffected
(additive optional parameter). The `handleRequest` shim stays unchanged.

### 4.2 `buildRouter` signature change (ADDITIVE, `src/server.ts`, internal)

```ts
// BEFORE (internal, not exported):
function buildRouter(
  store: JobStore | PostgresJobStore | InMemoryJobStore,
  timerStore?: PostgresTimerStore,
  outboxStore?: PostgresOutboxStore
): Router

// AFTER (additive optional last parameter):
function buildRouter(
  store: JobStore | PostgresJobStore | InMemoryJobStore,
  timerStore?: PostgresTimerStore,
  outboxStore?: PostgresOutboxStore,
  resolverDeps?: ResolverDeps    // T-0143: captured in closure; passed to makeGrantResolver when a route calls it
): Router
```

`buildRouter` is not exported; this is an internal signature change only.
No callsite outside `server.ts` is affected.

### 4.3 `startMain` composition call change (`src/main.ts`)

```ts
// BEFORE (line 128):
server = createServer().listen(port, ...)

// AFTER: pass the same resolverDeps object to createServer AND to MainHandle
const resolverDepsObj: ResolverDeps = { keyedDigest };
if (listen) {
  const port = opts.port ?? Number(env["PORT"] ?? 8080);
  server = createServer(createJobStoreFromEnv(env), resolverDepsObj)
    .listen(port, () => { ... });
}
// MainHandle.resolverDeps is the SAME object instance:
return {
  server,
  lifecycle,
  resolverDeps: resolverDepsObj,   // identity-proof: same allocation as createServer received
  stop: ...
};
```

Note: `createServer` currently calls its own `createJobStore()` default when given
zero args. After the change, `startMain` needs to pass the store explicitly so it
can also pass `resolverDepsObj`. The coder must ensure `createJobStore` is called
(or extracted from `server.ts` or replicated in `main.ts` as a local helper) so
the existing zero-arg behavior is not broken. The simplest path: extract
`createJobStore` as an export from `server.ts` and call it from `startMain` before
`createServer(store, resolverDepsObj)`. This keeps `createServer`'s default
parameter valid for tests that call `createServer()` with zero args.

`MainHandle` type is unchanged: `resolverDeps: { keyedDigest: KeyedDigest }` (FR-5).
The concrete value now also satisfies `ResolverDeps` because `ResolverDeps` is a
superset of `{ keyedDigest?: KeyedDigest }`. The field type does NOT need widening
to `ResolverDeps` (the existing `{ keyedDigest: KeyedDigest }` shape remains the
public contract — downstream consumers assert `keyedDigest` is always present, not
the full `ResolverDeps`).

### 4.4 e2e test pattern (spec §8 pattern b, `src/__tests__/keyed-digest-e2e.test.ts`)

The test:
1. Calls `startMain({ listen: false, env: { CHOROS_MASK_DIGEST_KEY: <32-byte hex> } })`.
2. Constructs in-memory `GrantSource`, `RecordSource`, `ClassificationSource`
   bearing a single `restricted` field (e.g. `ssn`).
3. Calls `resolveFor(handle.resolverDeps, handle, subject, "read")` where
   `handle.resolverDeps` is the object `startMain` passed to `createServer` (object
   identity by construction, see §4.3).
4. Asserts the `ssn` field in the result is a 64-char lowercase hex string.
5. Repeats with `startMain({ listen: false, env: {} })` and asserts the `ssn`
   field is ABSENT (dropped, never raw, never keyless djb2).

Proof-of-equivalence comment required in the test (spec §8 pattern b mandate):
```
// Proof-of-equivalence (pattern b): handle.resolverDeps is the SAME ResolverDeps
// object that startMain passed to createServer() (same allocation in startMain
// after T-0143 — not a copy, not a separate build). Any future HTTP route that
// calls makeGrantResolver(resolverDeps) from buildRouter's closure receives the
// same object. resolveFor(handle.resolverDeps, ...) therefore exercises the REAL
// composition seam without driving a full HTTP socket.
```

### 4.5 Import of `ResolverDeps` in `server.ts`

`server.ts` must import `ResolverDeps` from `./core/grant-resolver.js` (already
in the dep graph for the grant routes). This is the only new import in `server.ts`.
FF-R6 (grant-resolver-isolation.sh) checks that `grant-resolver.ts` does NOT
import from `server.ts` — this is a one-way dependency (server.ts → grant-resolver);
the isolation check is not violated.

---

## 5. Fitness functions

### FF-T143-1 — `createServer` additive signature (NF-2 / FE-W23-0008)

**Rule:** `createServer` gains an optional second `resolverDeps?: ResolverDeps`
parameter; zero-arg and one-arg callers continue to compile and behave identically
(backward-compatible additive optional). No existing caller is broken.

**CI check:** TypeScript `tsc --noEmit` clean after T-0143; all existing e2e tests
that call `createServer()` with zero/one arg continue to pass (vitest green).

### FF-T143-2 — `resolverDeps` object identity at composition root (FR-1 / AC-1)

**Rule:** The `ResolverDeps` object placed on `MainHandle.resolverDeps` by
`startMain` is the SAME instance passed to `createServer()` — i.e., a single
allocation, not a copy. This ensures `resolveFor(handle.resolverDeps, ...)` in
tests exercises the REAL request-path deps, not a duplicate with different
`keyedDigest` binding.

**CI check:** vitest (AC-7): call `startMain({ listen: false, env: { CHOROS_MASK_DIGEST_KEY: <key> } })`;
assert `handle.resolverDeps.keyedDigest.digest({ value: 'v', tenantId: 't', resourceType: 'r', facetField: 'f' })` returns a string matching `/^[0-9a-f]{64}$/`.
Simultaneously assert that calling the same `digest` method with no key env returns `undefined`.
These pass only if `keyedDigest` is the real bound instance from composition, not undefined.

### FF-T143-3 — e2e keyed hash active through real composition root (AC-2)

**Rule:** An e2e test that calls `resolveFor(handle.resolverDeps, ...)` with a
`restricted`-classified field, via the `MainHandle` from `startMain` with
`CHOROS_MASK_DIGEST_KEY` set, must produce a 64-char lowercase hex string for the
`hash`-routed field — NOT the keyless djb2, NOT the raw value, NOT absent.

**CI check:** vitest in `src/__tests__/keyed-digest-e2e.test.ts`:
`startMain({ listen: false, env: { CHOROS_MASK_DIGEST_KEY: <hex> } })` →
`resolveFor(handle.resolverDeps, testHandle, testSubject, "read")` →
`expect(result.fields.ssn).toMatch(/^[0-9a-f]{64}$/)`.

### FF-T143-4 — e2e absent key → hash field drops (AC-3 / FR-2)

**Rule:** The same e2e test repeated with `startMain({ env: {} })` (no
`CHOROS_MASK_DIGEST_KEY`) must produce an output where the `hash`-routed field is
ABSENT. The server must start and `resolveFor` must return normally (honest degrade,
not a crash).

**CI check:** vitest sibling test case in `src/__tests__/keyed-digest-e2e.test.ts`:
`startMain({ listen: false, env: {} })` →
`resolveFor(handle.resolverDeps, ...)` →
`expect("ssn" in result.fields).toBe(false)`.
Assert that the string representation of the keyless djb2 of the test value is
NOT present anywhere in `result.fields`.

### FF-T143-5 — No new `process.env` under `src/core/` (NF-1 / AC-8)

**Rule:** `grep -rn "process\.env"` over `src/core/` returns no new matches
introduced by T-0143. The env boundary stays exclusively in `src/main.ts`.

**CI check:** `grep -rn "process\.env\|process\[.env.\]" src/core/` exits 0
(no matches) after T-0143. Run as part of `npm run fitness` or explicitly in CI.

### FF-T143-6 — T-0118 fitness suite stays green (FR-4 / AC-4)

**Rule:** All 13 T-0118 fitness checks (FF-T118-1..FF-T118-13) continue to pass
after T-0143. The request-path wiring is additive to the composition layer; the
core masking logic (`maskFields`, `buildMaskContext`, `makeKeyedDigest`) is not
changed.

**CI check:** Run `vitest src/__tests__/hash-oracle.test.ts` and all 13 fitness
shell checks; expect green. Also run `vitest src/__tests__/data-classification.test.ts`
and `vitest src/__tests__/grant-resolver.test.ts` for AC-5 (non-regression).

### FF-T143-7 — `main-wired-entry.test.ts` stays green without modification (AC-9)

**Rule:** `src/__tests__/main-wired-entry.test.ts` passes after T-0143 with NO
changes to the test file. The `startMain` call there does not pass `CHOROS_MASK_DIGEST_KEY`
in its env override — this must continue to work (honest degrade; the lifecycle-audit
wiring test must not be broken by the new composition parameter).

**CI check:** `vitest src/__tests__/main-wired-entry.test.ts` green, test file
bytewise unchanged.

### FF-T143-8 — FF-DC9 purity invariant still green (AC-6)

**Rule:** `ci/checks/data-classification-isolation.sh` exits 0 (PASS [DC9]) after
T-0143. The wiring change must not introduce any `node:crypto`, `crypto`,
`process.env`, or `process\.env` import into `src/core/data-classification.ts`.

**CI check:** Execute `ci/checks/data-classification-isolation.sh`; expect exit 0.

---

## 6. Traceability

| AC | Requirement | Covered by |
|----|-------------|------------|
| AC-1 | FR-1 — keyedDigest wired to request-path | §4.3 object identity via single allocation; FF-T143-2 |
| AC-2 | FR-1, FR-3 — e2e active in live traffic | §4.4 pattern b e2e; FF-T143-3 |
| AC-3 | FR-2 — honest degrade at request-path | §4.1 absent resolverDeps → hash drops; FF-T143-4 |
| AC-4 | FR-4 — T-0118 unit suite non-regression | T-0118 core unchanged; FF-T143-6 |
| AC-5 | FR-4 — T-0033/T-0021 non-regression | Additive only on composition layer; FF-T143-6 |
| AC-6 | NF-1 — FF-DC9 purity invariant | No env/crypto in core; FF-T143-8 |
| AC-7 | FR-1, FR-5 — MainHandle.resolverDeps shape | §4.3 same object, type unchanged; FF-T143-2 |
| AC-8 | NF-1 — no env in core (grep fitness) | §4.5 server.ts only imports ResolverDeps type; FF-T143-5 |
| AC-9 | NF-3 — backward-compatible degrade | §4.1 optional params; FF-T143-7 |

---

## 7. Runtime / deploy target

**Silo container** (founder home-server `/srv/choros` docker-compose via Tailscale).
No new infrastructure, no new env vars, no migration. `CHOROS_MASK_DIGEST_KEY`
was already introduced by T-0118 and is provisioned in `.env.prod` by ops at the
existing T-0061 secret surface. T-0143 makes that already-provisioned key ACTIVE in
live HTTP traffic — no ops change required beyond what T-0118 called for.

---

## 8. Escalation

None. The seam design (additive optional parameter threading, object identity
guarantee, pattern-b e2e proof) is an implementation-custody question in the
architect's zone (founder-autonomy: composition/wiring is autonomous). No
cross-vendor / product-loop trigger. No new external resource.

---

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
