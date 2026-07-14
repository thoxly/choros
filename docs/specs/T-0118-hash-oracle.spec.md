# Spec · T-0118 — Hash-transform: close the equality-oracle (per-tenant keyed digest)

**Phase:** SPEC
**Status:** ready (no BLOCKING — one contract clause flagged for architect, mechanics autonomous)
**Product:** Choros · Epic E4.3-fu (follow-up to T-0033)
**Base:** dev `62f11a9` · branch `task/T-0118-hash-oracle`
**Born from:** TEST T-0033 finding `F-1-hash-equality-oracle`
(`docs/test-reports/T-0033.test-report.json`).

---

## 1. Problem (what TEST surfaced)

The T-0033 `hash` value-transform digests a classified field value with a
**keyless, salt-free djb2** (`digest()` in `src/core/data-classification.ts:94`)
that **never sees `tenant_id`**. Two consequences, both spec-silent in T-0033
(so a recorded gap, not an AC violation — TEST verdict was `pass`):

1. **Cross-tenant equality oracle.** Identical values masked under *different*
   tenants yield *identical* digests. An observer of masked-hashed output can
   detect when two tenants hold the same value (same SSN, same email) — a
   tenant-isolation leak that survives RLS, because it leaks through the digest
   *value*, not through row visibility.
2. **Brute-forceable / rainbow.** The 8-byte djb2 digest of a low-entropy value
   (SSN, phone, card) is dictionary-attackable: an observer recovers the
   plaintext from the masked digest.

`hash` is reached by `selectTransform` for the widest non-drop sensitivity gap
(`gap ≥ 3`, `data-classification.ts:321`) — the *least*-cleared reader who still
gets a present value. That is precisely the reader who must not be handed an
equality oracle.

## 2. What this task requires (the fix, at the WHAT level)

Make the `hash` transform a **per-tenant keyed digest** so that the digest is a
pure function of `(value, tenant_id, field-identity, key-material)` and the
equality oracle is confined to **within one tenant + one field** (the standard,
join-preserving compromise — see §4). The key material is supplied through an
**injected port**, never read from `env`/`fs`/`crypto` inside the pure
`data-classification.ts` core (the T-0033 purity invariant FF-DC9 must stay
green). No persisted hash data exists to migrate — masking is computed
on-read at projection time, nothing is written (see §5).

This task does **not** redesign masking, clearance, the class ladder, or any
other transform. It surgically replaces the *unkeyed* digest with a *keyed,
tenant-scoped* one and threads the necessary key/tenant context to the one
projection call.

## 3. Decided product semantics (resolved at SPEC, not BLOCKING)

These are settled here per the red-line "rule at doubt → fail closed" and the
task's standing guidance; they are NOT open questions.

- **D-1 — Equality is preserved ONLY within `(tenant, field-identity)`, killed
  across tenants and across fields.** Two equal values in the *same* tenant and
  *same* classified field still digest equally (so mask-on-mask joins / dedup
  within a tenant survive — the legitimate use of a deterministic token). Equal
  values in *different* tenants, or in *different* fields of the same tenant,
  digest *differently*. This is the minimal scoping that removes the
  cross-tenant oracle while keeping the deterministic-token property the
  transform exists for. Removing equality *entirely* (random per-call) would
  break the determinism contract AC-13 of T-0033 and is rejected (§7).
- **D-2 — `tenant_id` alone is NOT a sufficient key.** `tenant_id` is not a
  secret (it appears in handles, logs, RLS GUCs). A digest keyed only on a
  derivation of `tenant_id` still permits an offline brute-force/rainbow attack
  by anyone who knows the tenant_id (i.e. everyone). The keyed digest MUST mix
  in **secret key material** that an external observer of masked output does not
  hold. Pure-derivation-from-tenant_id is rejected (§7).
- **D-3 — Fail-closed on absent key.** If the keyed-digest port is present but
  cannot supply key material for the tenant (missing/erroring), the `hash`
  transform MUST fail closed to the maximal mask (`drop` — key omitted), never
  fall back to the unkeyed digest and never reveal raw. Doubt → more masking
  (T-0033 NF-3).
- **D-4 — Backward-compatible degrade.** When NO keyed-digest port is injected
  (the pre-T-0118 wiring), `hash` MUST NOT silently keep the keyless djb2 (that
  is the vulnerability). It MUST fail closed to `drop`. The keyless digest is
  removed as a reachable masking output. (A pure non-secret digest MAY remain
  ONLY for non-masking internal uses such as `deriveHandleId`; it must no longer
  be the `applyTransform(_, 'hash')` output.)

## 4. The keyed-digest contract (WHAT the port must guarantee)

The fix introduces a **keyed-digest capability**, injected like
`GrantSource`/`RecordSource`/`ClassificationSource` (the established
`ResolverDeps` port pattern). At the WHAT level it must guarantee:

- **C-1 Tenant + field domain separation.** The digest is a function of
  `(value, tenant_id, field-identity, secret-key)`. Changing `tenant_id` OR the
  field-identity (e.g. `resourceType + facetField`) changes the digest for the
  same value. The field-identity that scopes the digest MUST be the same
  `(resourceType, facetField)` the classification row is keyed on, so the
  "equal within tenant+field" property of D-1 is exactly expressible.
- **C-2 Keyed, not keyless.** A secret key participates such that an observer
  who holds masked output but not the key cannot reconstruct the digest for a
  guessed value (defeats offline rainbow/dictionary). Construction is an
  architect choice (HMAC-family is the obvious one — `node:crypto` already used
  in `audit-preimage.ts`), but it lives **behind the port**, not in the pure
  core.
- **C-3 Determinism within scope (T-0033 AC-13 preserved).** Same
  `(value, tenant, field, key)` ⇒ same digest, every call. The keyed digest is
  still a *deterministic token*, not a random nonce.
- **C-4 Purity of core preserved.** `data-classification.ts` gains NO
  `pg`/`fs`/`net`/`http`/`node:crypto`/`process.env` import. The key-bearing
  digest is performed by the injected capability (or `applyTransform` receives
  an already-bound digest function as a parameter). FF-DC9 / the
  `data-classification-isolation.sh` import ban stays green.
- **C-5 Single-projection preserved.** The keyed digest is threaded into the
  ONE `maskFields`/`projectFields` call inside the ONE `resolveFor` core (it
  rides the existing `MaskContext`/`buildMaskContext` path). No second
  `handle→fields` export; `single-resolver.sh` / FF-DC7 / FF-DC17 stay green.
  `tenant_id` is already available at `buildMaskContext`
  (`grant-resolver.ts:460` validates `handle.tenantId === subject.tenantId`) —
  it is threaded into the mask context, not re-fetched.

## 5. Migration semantics (the "transform migration" question — resolved)

**There is nothing to migrate in data.** Masking is computed **on-read** at
projection time (`maskFields` runs inside `resolveFor`); the `hash` output is
returned in the projection, never persisted. No `data_classification` column,
no `record` column, and no other migration table stores a digest of a masked
value (verified: only `audit_event`/`audit_head`/`actor_event` carry hashes,
and those are audit-chain preimages, unrelated to masking). Therefore:

- **M-1 No data backfill / rewrite is required.** The "migration of transform
  semantics" is a **contract + behaviour** change at the projection layer, not a
  stored-value migration.
- **M-2 A schema migration is required ONLY IF the architect chooses to custody
  per-tenant key material in a table** (e.g. a per-tenant salt/secret row). IF
  so, the migration MUST use number **032** (031 is held by T-0044 in flight;
  030 is the current head) and MUST satisfy the tenant-table contract
  (`tenant_id` leading PK, ENABLE+FORCE RLS, isolation policy, `choros_app`
  grant, appended to `known_tenant_tables.txt`). IF the architect custodies the
  key outside the DB (ops-provisioned secret per silo), no migration is needed.
  Which custody model is the **one architect contract clause** (§9 Q-arch).

## 6. Acceptance criteria (machine-checkable)

All `test`/`fitness` criteria are pure-TS or shell unless marked. The two
*adversarial* criteria (AC-1, AC-2) are the direct inversion of the TEST
finding.

| ID | Criterion | verifiable_as |
|----|-----------|---------------|
| AC-1 | **Cross-tenant oracle killed (adversarial).** For the same classified value `V` and same field, masking under tenant `A` and tenant `B` (`A ≠ B`) via the `hash` path produces **different** digests: `maskFields(...,tenantA) !== maskFields(...,tenantB)` for the hashed field. | test |
| AC-2 | **Within-tenant+field determinism preserved (adversarial).** For the same tenant, same field, same value `V`, two independent mask calls produce the **same** digest (D-1 join-preserving property; T-0033 AC-13 not regressed). | test |
| AC-3 | **Cross-field separation.** Within one tenant, the same value `V` classified into two different fields (different `facetField`) produces **different** `hash` digests. | test |
| AC-4 | **Keyed, not keyless (anti-rainbow).** The `hash` digest of `V` depends on secret key material: with two different injected keys (all else equal) the digest differs; a test reproducing the old keyless djb2 of `V` does **not** equal the new digest. | test |
| AC-5 | **Fail-closed on absent key (D-3).** When the keyed-digest port is injected but yields no key for the tenant (missing/throws), a field that would otherwise be `hash` is **dropped** (key omitted), raw never present. | test |
| AC-6 | **No-port degrade is fail-closed (D-4).** With NO keyed-digest capability injected, a field whose `selectTransform` returns `hash` is **dropped** (key omitted) — the keyless djb2 is NOT emitted as masked output. Raw never present. | test |
| AC-7 | **Core purity preserved (C-4).** `src/core/data-classification.ts` imports no `pg`/`fs`/`net`/`http`/`node:crypto`/`process.env`; `data-classification-isolation.sh` import ban green (extended to include the crypto/env tokens). | fitness |
| AC-8 | **Single projection preserved (C-5).** `single-resolver.sh` green; human-path and agent-path projections remain byte-identical on a record containing a `hash`-masked field; no new `handle→fields` export. | fitness |
| AC-9 | **Import surface preserved (FE-W23-0008).** `resolveFor`/`makeGrantResolver`/`projectFields`/`visibleFields`/`grantFacetFields` still exported; T-0118 adds only additive optional params/ports. `grant-resolver.test.ts` compiles & passes unchanged. | fitness |
| AC-10 | **Determinism overall (T-0033 AC-13 regression guard).** Deeply-equal full inputs (record, grants, classification rows, tenant, key, now) ⇒ deeply-equal masked output; double-invoke `maskFields` deep-equal. | test |
| AC-11 | **Tenant binding is real, not cosmetic.** The digest changes if `tenant_id` changes even when the (resourceType, facetField, value, key) are held fixed — i.e. tenant is an actual input to the digest, not appended decoratively (asserted by varying only tenant_id between two calls). | test |
| AC-12 | **No regression in the rest of T-0033.** The full T-0033 deterministic suite (vitest data-classification + grant-resolver, and the fitness shell checks) stays green; only the `hash` output semantics change. | test |
| AC-13 | **(IF custody = DB) Tenant-isolation of key store.** IF a per-tenant key/salt table is added (migration 032), a key row under tenant `A` is invisible to a session bound to tenant `B` (FORCE RLS two-tenant probe); table listed in `known_tenant_tables.txt`, `tenant_id` leading PK. Conditional on the §9 architect decision; `manual`/skipped if custody is non-DB. | test |

## 7. Out of scope

- Reversible encryption / tokenization with reversible key custody (T-0033 §6-A
  #12 — explicitly gold-plating; `hash` stays non-reversible).
- Removing equality *entirely* (random per-call nonce) — breaks the
  deterministic-token property (T-0033 AC-13) and the legitimate within-tenant
  mask-join use; rejected per D-1.
- Keying the digest on `tenant_id` alone with no secret — rejected per D-2
  (offline brute-force survives).
- Changing any other transform (`reveal`/`partial`/`redact`/`drop`), the class
  ladder, `selectTransform` gap rules, clearance derivation, or the
  reclassification guard.
- The Postgres `ClassificationSource` DAO (T-0053) — unchanged; this task only
  adds the keyed-digest capability to the same injected-port pattern.
- Key rotation / re-keying mechanics and the operational secret-distribution
  story for the silo (a follow-up ops concern; this task fixes the
  oracle/contract, not rotation).
- Any UI surface (no web change — projection-core only).

## 8. Non-functional

- **NF-1** Fail-closed bias throughout (D-3/D-4): every ambiguity in key
  availability resolves to `drop`, never to raw or to the keyless digest.
- **NF-2** No new authority subsystem: the keyed-digest capability is a digest
  *function provider*, not a second clearance/visibility algebra
  (rights-derived-only invariant of T-0033 untouched).
- **NF-3** Determinism & purity of `data-classification.ts` preserved (C-3/C-4).
- **NF-4** Tenant isolation: the digest of tenant A's value cannot be produced
  by, equal, or aid an attack against tenant B's value (the core fix).
- **NF-5** Backward-compatible import surface (FE-W23-0008): additive optional
  params/ports only.

## 9. Architect contract clause (one decision to record, NOT a blocker)

The mechanics are autonomous; one decision must be **recorded** by the architect
(DESIGN), per the task's "BLOCKING → into contract" rule — it is a contract
clause, not a founder GT-1 blocker, because either resolution satisfies every AC
above and the security property is fixed regardless:

- **Q-arch (key custody in the silo model).** Where does the per-tenant secret
  key material live, and how is it supplied to the injected digest port?
  - (a) **DB-custodied** per-tenant salt/secret row in a new tenant-isolated
    table (migration 032, RLS-scoped) — the source reads it in the same
    RLS-scoped path as classification rows; OR
  - (b) **Ops-custodied** silo-level secret (provisioned outside the DB,
    injected at process boundary, mixed with `tenant_id` + field-identity inside
    the port) — no migration.
  Both satisfy C-1..C-5 and AC-1..AC-12; (a) additionally exercises AC-13. The
  architect picks one and records it; the SPEC does not pre-empt it because the
  product-observable behaviour (oracle closed, within-tenant determinism kept)
  is identical either way. **This is why the task is `ready`, not
  `needs_founder`:** no product/red-line question is open — only an
  implementation-custody choice that the founder-autonomy rule places squarely
  in the architect's zone.

## 10. Traceability

- TEST finding `F-1-hash-equality-oracle` → §1, §2, AC-1/AC-2/AC-4.
- TEST robustness note `F-2-fail-closed-by-exception` is **not** in scope (a
  separate throwing-source contract concern for T-0053); recorded here only to
  state it is intentionally excluded.
- T-0033 invariants kept: AC-13 (determinism) → AC-2/AC-10; FF-DC7/FF-DC9/FF-DC17
  → AC-8/AC-7/AC-9; NF-3 fail-closed → D-3/D-4/NF-1.
