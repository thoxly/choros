# ADR · T-0118 — Hash-transform keyed digest: close the equality-oracle

**Phase:** DESIGN
**Status:** ready (Q-arch resolved by architect — no founder blocker)
**Product:** Choros · Epic E4.3-fu (follow-up to T-0033)
**Base:** dev `62f11a9` · branch `task/T-0118-hash-oracle` · worktree HEAD `ef39cbb`
**Spec:** `docs/specs/T-0118-hash-oracle.spec.md` (13 AC, ready) +
`docs/specs/T-0118.spec.contract.json`
**Born from:** TEST T-0033 finding `F-1-hash-equality-oracle`.

---

## 1. Context (what the design must fix, against the REAL code)

`src/core/data-classification.ts:94` `digest()` is a keyless, salt-free djb2 that
never sees `tenant_id`. It is reached by `selectTransform(class, clearance)` for
the widest non-`drop` gap (`gap ≥ 3` → `hash`, line 321) — the *least*-cleared
reader who still gets a present value. Two leaks (spec §1):

1. **Cross-tenant equality oracle** — identical values under different tenants
   digest identically; survives RLS because it leaks through the digest *value*.
2. **Brute-forceable / rainbow** — an 8-byte keyless digest of a low-entropy
   value (SSN, phone, card) is dictionary-attackable.

The fix is surgical: replace the *unkeyed* digest reachable from
`applyTransform(_, 'hash')` with a *per-tenant keyed* digest threaded through the
established `ResolverDeps` injected-port pattern, while keeping the four
NON-NEGOTIABLE T-0033 invariants green (single projection, rights-derived-only,
purity, fail-closed). No persisted hash exists to migrate (masking is on-read in
`maskFields` inside `resolveFor` — spec §5).

The product semantics are pinned at SPEC and are NOT re-opened here:
- **D-1** equality preserved ONLY within `(tenant, field-identity)`, killed
  across tenants and across fields;
- **D-2** `tenant_id` alone is NOT a sufficient key (it is non-secret);
- **D-3** fail-closed on absent key → `drop`, never raw, never keyless;
- **D-4** no keyed port injected → `drop`, the keyless djb2 is removed as a
  reachable masking output.

## 2. Decision (the mechanism, one paragraph)

Introduce a **`KeyedDigest` capability** — a pure digest-*function provider* —
injected on `ResolverDeps` exactly like `GrantSource`/`RecordSource`/
`ClassificationSource`/`EffectSource`/`SodSource` (the established optional-port
pattern, `grant-resolver.ts:102`). The capability exposes one method,
`digest(input: KeyedDigestInput): string | undefined`, where the input carries
`(value, tenantId, resourceType, facetField)`; it returns a hex digest computed
as **HMAC-SHA256** over a canonical, length-prefixed preimage of
`(tenantId, resourceType, facetField, value)` keyed by a **secret silo key**, or
`undefined` when no key is available for the tenant (fail-closed signal — D-3).
The HMAC and the `node:crypto` import live **inside the port implementation**
(`src/core/keyed-digest.ts`), NOT in the pure `data-classification.ts` core
(C-4 / FF-DC9). The core's `maskFields` is extended with an **additive optional**
`keyedDigest` member on `MaskContext` plus the tenant/field identity it needs;
when a field resolves to the `hash` transform, `maskFields` calls
`ctx.keyedDigest(...)` instead of the local `digest()` — and if the call returns
`undefined` (no key) OR the member is absent (no port), the field **omits the
key** (`drop`), never emitting the keyless digest. `tenant_id` is already present
and validated at `buildMaskContext` (`grant-resolver.ts:460` checks
`handle.tenantId === subject.tenantId`); it is threaded into `MaskContext`, not
re-fetched. The local keyless `digest()` is retained ONLY as a private helper for
non-masking internal uses (e.g. `deriveHandleId` family) and is **no longer**
reachable as the `applyTransform(_, 'hash')` masking output (D-4).

### 2.1 Q-arch — key custody (the one recorded contract clause): **env_secret**

**Decision: (b) Ops-custodied silo-level secret — env → composition root → port.
No DB table, no migration 032.**

The per-silo secret is provisioned outside the DB as
`CHOROS_MASK_DIGEST_KEY` (32+ bytes, base64/hex), read **once** at the
composition root (`src/main.ts`, the T-0068 entry — the only `process.env`
boundary), bound into a `KeyedDigest` instance, and injected into `ResolverDeps`.
The `.env.prod.example` (T-0061) gains a `REPLACE_WITH_*` required-form line so
the existing `compose-prod-config.sh` secret-shape fitness covers it. The digest
mixes `tenant_id + resourceType + facetField` *inside* the port (per-tenant +
per-field domain separation, C-1), so one silo secret yields per-tenant,
per-field separation without a per-tenant row.

**Rationale (decisive, trade-off recorded):**

- **Circular custody (the security argument).** A DB key table (option a) lives
  in the *same* Postgres instance the masking defends. The masked-hash value is
  the very thing whose plaintext we deny to an under-cleared reader; if that
  reader's threat model includes DB read (the rainbow attack assumes the observer
  holds masked DB output), custodying the key in a sibling RLS table means the
  same DB compromise that exposes the masked column can expose the key, collapsing
  the keyed property back to keyless. The secret an *external observer of masked
  output does not hold* (D-2/C-2) must live OUTSIDE that observable substrate. An
  ops-provisioned env secret is not in the DB and not in masked output.
- **Simplicity / proportionality (rubric axis 5).** The silo model is one secret
  per silo (memory `choros-runtime-target`, `choros-tenancy-decision`:
  silo-only delivery now). One env var beats a migration + RLS table + per-tenant
  key-generation + key-lifecycle. The composition root already reads
  `process.env` and *degrades honestly* (`main.ts:60-73` `buildLifecycleDepsFromEnv`);
  the same shape applies (key absent → no `KeyedDigest` injected → `hash` fields
  fail closed to `drop`, AC-6 — honest degrade, never raw).
- **No migration churn.** Migration head is `030`; `031` is held by T-0044 in
  flight. Option (a) would consume `032`. Option (b) consumes none (spec §5 M-2).
- **AC-13 disposition.** AC-13 is explicitly *conditional on custody = DB*. Under
  this decision it is **not applicable / skipped** (recorded as such in the test
  contract). No `known_tenant_tables.txt` change, no leading-PK/FORCE-RLS probe.

This is an *implementation-custody* choice (founder-autonomy: DB/compose/wiring is
the architect's zone, memory `founder-autonomy-impl`), not a product/red-line
question — both options satisfy AC-1..AC-12 and the product-observable behaviour
(oracle closed, within-tenant determinism kept) is identical. Hence `ready`, not
`needs_founder`.

## 3. Rejected alternatives

| Option | Why not |
|--------|---------|
| **DB-custodied per-tenant key table (migration 032, RLS)** | Circular custody — key lives in the same Postgres the masking defends; a DB read that exposes masked output can expose the key, collapsing keyed→keyless. Adds a migration + RLS table + key-lifecycle for no security gain over a silo env secret (silo-only delivery). Rejected on §2.1. |
| **Keep `digest()` keyless but salt with `tenant_id`** | D-2: `tenant_id` is non-secret (handles, logs, RLS GUCs). Offline rainbow survives — anyone who knows the tenant_id (everyone) brute-forces low-entropy values. Spec §7. |
| **Random per-call nonce (kill equality entirely)** | Breaks the deterministic-token property (T-0033 AC-13) and the legitimate within-tenant mask-join/dedup use (D-1). Spec §7. |
| **HMAC inside `data-classification.ts` core** | Violates C-4/FF-DC9 — the pure core must import no `node:crypto`/`process.env`. The keyed digest is a *capability behind a port*, not core code. |
| **Reversible encryption / tokenization with reversible custody** | Out of scope (T-0033 §6-A #12 gold-plating); `hash` stays non-reversible. |
| **A second `handle→fields` export carrying the digest** | Violates C-5 / single-resolver (FF-DC7/DC17). The keyed digest rides the existing ONE `maskFields`/`projectFields` path via `MaskContext`. |
| **Reuse `audit-preimage.ts` `createHash('sha256')` directly** | That is an *unkeyed* SHA-256 audit-chain preimage (no secret) — using it for masking re-introduces the rainbow attack (C-2). The masking port needs a *keyed* HMAC. `node:crypto` precedent is borrowed; the construction is not. |

## 4. Object model / contracts (the field-level source of truth for `coder`/`tester`)

### 4.1 New port — `src/core/keyed-digest.ts` (NEW module; impure boundary)

```ts
/** Identity a keyed digest is scoped to (domain separation, C-1). */
export interface KeyedDigestInput {
  value: unknown;        // the raw field value to digest (stringified canonically)
  tenantId: string;      // per-tenant separation (D-1, C-1) — already validated upstream
  resourceType: string;  // field-identity part 1 (matches classification-row key)
  facetField: string;    // field-identity part 2 (matches classification-row key)
}

/**
 * Injected keyed-digest capability (ResolverDeps port pattern). PURE in the
 * functional sense (same input + same bound key ⇒ same output, C-3) but it is an
 * IMPURE module (imports node:crypto) — which is why it lives OUTSIDE the pure
 * data-classification core (C-4). Returns `undefined` when no key is available
 * for the tenant ⇒ the caller fails closed to `drop` (D-3, AC-5). It NEVER throws
 * for "no key": absence is a value (undefined), not an exception.
 */
export interface KeyedDigest {
  digest(input: KeyedDigestInput): string | undefined;
}

/**
 * Bind a silo secret into a KeyedDigest. HMAC-SHA256 over a canonical,
 * length-prefixed preimage of (tenantId, resourceType, facetField, valueStr) so
 * that no field-boundary ambiguity collides two distinct inputs (C-1, AC-3/AC-11).
 * `key` is the raw secret bytes (>= 32). If `key` is empty/undefined the factory
 * returns a KeyedDigest whose digest() always yields `undefined` (fail-closed —
 * a present-but-keyless port is indistinguishable from no key, AC-5/AC-6).
 */
export function makeKeyedDigest(key: Buffer | undefined): KeyedDigest;
```

- **Preimage canonicalization:** length-prefixed concatenation (same family as
  `audit-preimage.ts` `canonicalPreimage`) so `(a="x", b="yz")` and `(a="xy",
  b="z")` never collide. `value` is stringified the SAME way the old core did
  (`typeof value === "string" ? value : JSON.stringify(value)`) so the determinism
  contract (C-3/AC-2/AC-10) holds across types.
- **Construction:** `createHmac("sha256", key).update(preimage).digest("hex")`.
- **`undefined` semantics:** no-key ⇒ `undefined` (a *value*, fail-closed), not a
  throw. (TEST F-2 throwing-source robustness is explicitly out of scope, spec §10.)

### 4.2 Core edits — `src/core/data-classification.ts` (ADDITIVE, stays pure)

`MaskContext` gains additive optional members (no `node:crypto`/`process.env`
import added — FF-DC9 stays green; the digest *function* is passed in):

```ts
export interface MaskContext {
  governed: boolean;
  rows: ClassificationRow[];
  clearance: Clearance;
  facetSchemaVersion: number;
  // T-0118 — additive: identity + injected keyed-digest fn for the `hash` path.
  resourceType?: string;                 // for KeyedDigestInput (C-1)
  tenantId?: string;                     // for KeyedDigestInput (D-1)
  keyedDigest?: (input: {               // the bound port method, threaded in
    value: unknown; tenantId: string;
    resourceType: string; facetField: string;
  }) => string | undefined;
}
```

`maskFields` `hash` branch changes (the ONLY behavioural change in the core):

```
when transform === "hash":
  if ctx.keyedDigest === undefined        → omit key (drop)        // D-4 / AC-6
  else:
    const d = ctx.keyedDigest({ value: raw, tenantId: ctx.tenantId!,
                                resourceType: ctx.resourceType!, facetField: key })
    if d === undefined                    → omit key (drop)        // D-3 / AC-5
    else                                  → out[key] = d
```

`applyTransform(value, "hash")` is **no longer** the masking digest path. The
local `digest()` helper stays (private) for non-masking internal use only; the
`case "hash"` in `applyTransform` MUST NOT be the reachable masking output. The
cleanest expression (coder's call, both satisfy AC): either (i) `maskFields`
handles `hash` inline (above) and `applyTransform` keeps `digest()` only for
direct non-mask callers, or (ii) `applyTransform` gains an optional bound-digest
parameter. **(i) is preferred** — it keeps `applyTransform` a pure 2-arg function
(no signature widening, FE-W23-0008) and confines the keyed path to `maskFields`,
which already owns the `MaskContext`.

### 4.3 Resolver edits — `src/core/grant-resolver.ts` (ADDITIVE)

`ResolverDeps` gains one optional port (mirrors `classifications?`):

```ts
export interface ResolverDeps {
  /* ...existing... */
  classifications?: ClassificationSource;
  effects?: EffectSource;
  sod?: SodSource;
  keyedDigest?: KeyedDigest;   // T-0118 — additive optional port
  now?: () => number;
}
```

`buildMaskContext` threads identity + bound fn into the returned `MaskContext`
(only when BOTH a `ClassificationSource` AND a `KeyedDigest` are present — but the
`hash` fail-closed must hold even if `keyedDigest` is absent while
`classifications` is present, so always pass `keyedDigest` through, absent → the
field drops):

```
return {
  governed, rows, clearance, facetSchemaVersion,
  resourceType: refToResourceType(handle.ref),
  tenantId: handle.tenantId,                    // already validated === subject.tenantId
  keyedDigest: deps.keyedDigest
      ? (i) => deps.keyedDigest!.digest(i)
      : undefined,
};
```

No change to `resolveFor`/`makeGrantResolver`/`projectFields`/`visibleFields`/
`grantFacetFields` signatures or exports (FE-W23-0008, AC-9). `tenant_id` is read
from the already-validated `handle.tenantId` — no re-fetch (C-5).

### 4.4 Composition root — `src/main.ts` (the ONE env boundary)

The composition root reads `CHOROS_MASK_DIGEST_KEY` from `env`, decodes it to a
`Buffer`, builds `makeKeyedDigest(key)`, and injects it where `ResolverDeps` is
assembled. Honest degrade (mirrors `buildLifecycleDepsFromEnv`): key absent/empty
⇒ inject a `KeyedDigest` that always returns `undefined` (or inject nothing) ⇒
every `hash` field drops (AC-6), the server still starts, NO keyless digest is
ever emitted, raw is never revealed. The key is read at the `process.env`
boundary ONLY — never in core (FF-DC9), never logged.

> NOTE for `coder`: the resolver `ResolverDeps` is not yet assembled inside the
> shipped `main.ts` lifecycle path (only `buildLifecycleDepsFromEnv` is). Wire the
> `KeyedDigest` at whichever composition seam constructs `makeGrantResolver` for
> the request path; if that seam does not yet exist in `main.ts`, add the env read
> + `makeKeyedDigest` next to `buildLifecycleDepsFromEnv` and expose it on the
> resolver-deps builder. Do NOT read `process.env` anywhere under `src/core/`.

### 4.5 Env template — `.env.prod.example` (T-0061 pattern)

Add under a new `# --- Masking digest key ---` block:
```
# Per-silo secret keying the data-classification `hash` transform (T-0118).
# 32+ random bytes (e.g. `openssl rand -hex 32`). If unset, fields that would be
# `hash`-masked are DROPPED (fail-closed) — never revealed, never keyless.
CHOROS_MASK_DIGEST_KEY=REPLACE_WITH_SECURE_HEX_KEY
```
The `REPLACE_WITH_*` form is required so `compose-prod-config.sh` FF-T61-5 (secrets
are placeholders) covers it; `.env.prod` stays git-ignored (RL-3).

## 5. Fitness functions (architecture as CI — one per breakable boundary + per AC)

See `T-0118.adr.contract.json.fitness_functions`. Summary:

- **FF-T118-1 (AC-7, extends FF-DC9):** `data-classification-isolation.sh` DC9
  forbidden-import list EXTENDED with `node:crypto`, `crypto`, `process.env`,
  `process\.env` over `data-classification.ts`. Green ⇒ core purity preserved.
- **FF-T118-2 (AC-1, adversarial):** vitest — same value `V`, same field, masked
  under tenant A vs tenant B ⇒ digests DIFFER.
- **FF-T118-3 (AC-2, adversarial):** vitest — same tenant+field+value, two calls
  ⇒ digests EQUAL (determinism / join-preserving).
- **FF-T118-4 (AC-3):** vitest — same tenant+value, two different `facetField` ⇒
  digests DIFFER (cross-field separation).
- **FF-T118-5 (AC-4, adversarial):** vitest — two different injected keys ⇒
  different digests; and the new digest ≠ the old keyless djb2 of `V`.
- **FF-T118-6 (AC-5):** vitest — port present but `digest()` returns `undefined`
  (no key) ⇒ the `hash` field is DROPPED (absent from output), raw never present.
- **FF-T118-7 (AC-6, negative — "port absent → drop"):** vitest — NO `keyedDigest`
  injected, a field whose `selectTransform` ⇒ `hash` is DROPPED; the keyless djb2
  string is NOT present anywhere in the output.
- **FF-T118-8 (AC-11):** vitest — vary ONLY `tenantId` (resourceType, facetField,
  value, key fixed) ⇒ digest changes (tenant is a real input, not cosmetic).
- **FF-T118-9 (AC-8):** `single-resolver.sh` green; human-path == agent-path
  projection byte-identical on a record with a `hash`-masked field; no new export.
- **FF-T118-10 (AC-9, FE-W23-0008):** `data-classification-isolation.sh` DC17
  green — `resolveFor`/`makeGrantResolver`/`projectFields`/`visibleFields`/
  `grantFacetFields` still present; only additive optional members added;
  `grant-resolver.test.ts` compiles & passes unchanged.
- **FF-T118-11 (AC-10):** vitest — deeply-equal full inputs (record, grants, rows,
  tenant, key, now) ⇒ deeply-equal masked output; double-invoke deep-equal.
- **FF-T118-12 (AC-12):** the full T-0033 suite (`src/__tests__/data-classification.test.ts`
  + `src/__tests__/grant-resolver.test.ts` + the four shell fitness checks) stays
  green; only `hash` output semantics change.
- **FF-T118-13 (AC-7 / secret hygiene, env-variant):** `no-committed-secret.sh` /
  `compose-prod-config.sh` stay green with the new `CHOROS_MASK_DIGEST_KEY`
  `REPLACE_WITH_*` placeholder in `.env.prod.example`; no real key committed.

## 6. Traceability (every AC → place in design)

| AC | Covered by |
|----|-----------|
| AC-1 | §2 keyed digest mixes `tenantId`; FF-T118-2 |
| AC-2 | §4.1 deterministic HMAC; FF-T118-3 |
| AC-3 | §4.1 preimage includes `facetField`; FF-T118-4 |
| AC-4 | §2 secret-keyed HMAC ≠ keyless djb2; FF-T118-5 |
| AC-5 | §4.2 `keyedDigest(...)===undefined ⇒ drop`; FF-T118-6 |
| AC-6 | §4.2 `keyedDigest===undefined ⇒ drop`; D-4; FF-T118-7 |
| AC-7 | §4.2 no crypto/env in core; §5 FF-T118-1 (DC9 extended); FF-T118-13 |
| AC-8 | §4.2/§4.3 single `maskFields` path; FF-T118-9 |
| AC-9 | §4.2/§4.3 additive optional only; FF-T118-10 |
| AC-10 | §4.1 deterministic; FF-T118-11 |
| AC-11 | §2 tenant is a digest input; FF-T118-8 |
| AC-12 | §4 surgical change; FF-T118-12 |
| AC-13 | §2.1 N/A under env_secret custody (conditional; skipped) |

## 7. Runtime / deploy target

**Silo container** (memory `choros-runtime-target`: founder home-server
`/srv/choros` docker-compose via Tailscale). The new secret
`CHOROS_MASK_DIGEST_KEY` is provisioned into `.env.prod` by the founder/ops at the
silo, alongside the other `REPLACE_WITH_*` secrets — this is the **existing
secret-provisioning surface** (T-0061), NOT a new external resource and NOT a GT-4
founder-provision gate (no new server, DB host, or service). No migration, no new
table, no infra change. The masking core runs in the same process as today.

## 8. Escalation

None. Q-arch is an implementation-custody choice in the architect's zone
(founder-autonomy: DB/compose/wiring is autonomous); both resolutions satisfy
every AC and the product-observable behaviour is identical. No cross-vendor /
product-loop trigger.

---

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
