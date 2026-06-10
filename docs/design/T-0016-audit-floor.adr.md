# ADR · T-0016 — Append-only per-tenant hash-chained audit floor

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-10
**Spec:** `docs/specs/T-0016-audit-floor.spec.md` (status: ready, AC-1..AC-20) · `docs/specs/T-0016.spec.contract.json`
**Foundation (do NOT contradict):** `docs/design/T-0013-tenant-isolation.adr.md` (GT-1 tenancy model: `audit_event`/`audit_head` are ordinary FORCE-RLS default-DENY tenant tables accessed via `withTenant` + the `choros.tenant_id` GUC; chain & seq are **per tenant**) · `docs/design/T-0014-registry-model.adr.md` (object/event-model conventions, design-only discipline, `ci_check`+`gating` fitness shape).
**Backlog/hypothesis:** `playbooks/rbac-backlog.md#E2.8` · hypothesis §5 (`audit_event`), §3 Q9, §6-A #8 (audit-as-floor), §6-A #12 (external anchoring / HSM / signed bundles are tier-gated gold-plating, excluded).

> This ADR is **design-only**. Choros has no Postgres today (T-0013/T-0014 are likewise
> design-only; `jobStore` is an in-memory `Map`, no `pg`, no docker-compose). T-0016 fixes
> the *invariants, object model, contracts, canonical-preimage formalism, the seven
> verifier defect classes, and the fitness functions* any correct implementation MUST
> satisfy. The SQL DDL, the no-`UPDATE`/no-`DELETE` rule/trigger, the privilege grants, the
> append/head-advance transaction, the verifier code, and the head-snapshot job land in
> **T-0053** (Postgres-in-compose) and dependent build tasks — **an infra dependency of
> this design, not built here**. Each fitness function is declared with a concrete
> `ci_check` *and* a `gating` note (**static-now** = runs in today's `npm run ci` as a
> source/lint/unit check; **live-T-0053** = a live-DB probe authored now, wired into the
> `db-isolation` CI job when Postgres exists) so none can be silently forgotten.
>
> T-0016 does **not** redefine tenant isolation. `audit_event` and `audit_head` are
> ordinary T-0013 tenant tables (§3.1: `tenant_id uuid NOT NULL` leading PK, `FORCE` RLS,
> default-DENY, scoped uniqueness, `withTenant` access) **verbatim**. This floor adds only
> append-only + per-tenant chain + per-tenant dense `seq` + a forward-only head on top of
> that convention. No new tenant-isolation code-path is introduced.
>
> **Supersession (binding on T-0053): T-0016 SUPERSEDES T-0013 §3.3's `audit_log`
> placeholder.** T-0013 §3.3 sketched a stub `audit_log` (`actor/action/target/payload/
> occurred_at`) purely to exercise the tenant-table convention; the **real, day-1 audit
> table is `audit_event`** (this ADR §3.1) plus `audit_head`. The T-0053 coder **MUST create
> `audit_event` + `audit_head` and MUST NOT create `audit_log`** — there is exactly one
> audit table family. T-0013 §3.3's columns map onto `audit_event` (`action`→`type`,
> `target`→`subject`, `actor`/`payload`/`occurred_at` carry over) plus the chain/governance
> columns; T-0013's FF-9 (`audit_log` tenant-scoped) is satisfied by this floor's `audit_event`
> via FF-12 (both tables in the `known_tenant_tables` fixture). The `known_tenant_tables`
> fixture lists `audit_event`/`audit_head` and **does not** list `audit_log`.

---

## 1. Decision

Choros records every governance-significant action into a single **append-only,
per-tenant, hash-chained audit floor**: one ordinary T-0013 tenant table `audit_event`
plus a per-tenant head snapshot `audit_head`. The floor delivers four structural
guarantees, each a property of the schema (not of code-review discipline), so that
tampering with history requires a **deliberate, CI-visible schema/privilege diff**, never a
forgotten guard or a runtime query:

1. **Append-only at the DB layer, doubly enforced.** `UPDATE` and `DELETE` on
   `audit_event` are forbidden by **two independent mechanisms held simultaneously**:
   (a) the runtime app role `choros_app` is granted only `SELECT, INSERT` on `audit_event`
   (no `UPDATE`/`DELETE`); and (b) a no-mutate rule/trigger on `audit_event` raises on any
   `UPDATE`/`DELETE` regardless of role. **Both are kept** so a privilege misconfiguration
   (e.g. someone grants `UPDATE` to the app role) still fails closed at the trigger, and a
   dropped trigger still fails closed at the missing privilege. Defeating append-only
   therefore requires changing *both* in a reviewable migration diff.

2. **Per-tenant dense monotonic `seq`.** Every row carries `seq bigint`, strictly
   increasing by exactly `+1` within a tenant, first row `seq = GENESIS_SEQ = 1`, unique
   as `UNIQUE (tenant_id, seq)`. The next `seq` is assigned under a **per-tenant** append
   serialization — **pinned here to `SELECT … FROM audit_head WHERE tenant_id = … FOR
   UPDATE`** (see §5) — never a global sequence or global lock. Density makes deletes/gaps/
   dups structurally detectable.

3. **Per-tenant hash chain.** Every row carries `prev_hash bytea` and `row_hash bytea`.
   For `seq = n > 1`, `prev_hash` equals the `row_hash` of `(tenant_id, n−1)`; the genesis
   row carries `prev_hash = GENESIS_PREV_HASH = 32 zero bytes`. `row_hash =
   SHA-256(canonical_preimage)` over the **pinned, length-prefixed, NULL-distinct,
   JCS-canonical, `vocab_version`-pinned** preimage of §4. Any alteration of content,
   ordering, or membership breaks recomputed-hash equality at or after the affected row.

4. **Per-tenant forward-only head, atomic with the append.** `audit_head` holds exactly
   one row per tenant (`PK (tenant_id)`) naming that tenant's latest `(seq, row_hash)`. The
   append (`INSERT` into `audit_event`) and the head advance occur in the **same
   transaction**, so the head never names a non-durable row and no committed `audit_event`
   row exists beyond the head. The head's `seq` advances by exactly `+1` and never
   decreases. Its `(tenant_id, seq, row_hash)` tuple is shaped to be **externally
   anchorable** (a periodic snapshot to versioned object storage — the *job* is T-0053);
   the verifier's fork/rewrite check cross-references a live head against an anchored one.

A **stateless per-tenant verifier** replays a tenant's rows (plus the pinned genesis
constants, `vocab_version`, and an optional anchored head) and detects all **seven defect
classes** — tamper, reorder, insert, delete, gap, dup, fork — with no DB-internal trust and
no special privilege (NF-4).

The mechanism is deliberately **proportional**: standard Postgres primitives only — column
constraints, one `UNIQUE`, two trigger functions, a per-tenant `FOR UPDATE`, SHA-256, and
JCS — no custom ledger engine, no external timestamping authority, no HSM, no signed
bundles. The thin core is the canonical preimage + the append/head contract; everything
else is convention enforced by the fitness functions.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| **Separate `grant_log` (or per-domain audit tables) instead of one floor** | E3.6 / hypothesis §6-A #8 fixes that grant-issuance events are *first-class rows in this floor*, queryable by `actor`/`subject`/`scope`, not a parallel log (AC-20). A second log = a second isolation/append-only/chain code-path to keep correct, and a second 152-ФЗ/GDPR narrative — exactly the drift T-0013 NF-3 forbids. New event *types* add rows, never tables. |
| **Keeping (or creating) T-0013 §3.3's `audit_log` alongside `audit_event`** | T-0013 §3.3 `audit_log` is a *placeholder stub* to demonstrate the tenant-table convention; it is **superseded** by `audit_event` (see §1 Supersession). Materializing both would create two audit tables — a second append-only/chain/isolation code-path and a duplicate 152-ФЗ/GDPR narrative (the exact drift forbidden above). T-0053 builds `audit_event` + `audit_head` **only**; `audit_log` is never created. |
| **`seq` from a global Postgres `SEQUENCE` (or one global advisory lock for ordering)** | Couples every tenant's write throughput onto one contention point and one ordering authority — violates NF-2 (per-tenant, zero cross-tenant contention) and tenant independence. Also a global sequence is *sparse* under rollback (gap-by-design), defeating the dense-`seq` delete/gap signal (FR-2, defect classes 4/5). Defeated by AC-6 (`audit_no_global_seq` lint + concurrency probe). |
| **`MAX(seq)+1` without per-tenant serialization** | Two concurrent appends in one tenant read the same `MAX`, both compute the same `seq` and the same `prev_hash` → either a `UNIQUE(tenant_id,seq)` abort (lost write) or, absent the constraint, a *fork* (two children of one parent). Race-unsafe; rejected for the explicit serialization of §5. |
| **Per-tenant advisory lock (`pg_advisory_xact_lock(hashtextextended(tenant_id))`) as the serialization primitive** | A *viable* alternative that satisfies the invariant, but: (a) it is a second source of truth for "the latest head" separate from the `audit_head` row we must read anyway, inviting skew; (b) advisory-lock keys are global `int8` space → hash collisions across tenants reintroduce cross-tenant contention (a soft NF-2 violation that is invisible until it bites); (c) it adds a lock-acquire round-trip on top of the head read. We **must** read `audit_head` for `prev_hash` and the prior `seq` regardless, so locking *that row* `FOR UPDATE` makes the serialization point and the chain-state read the *same* operation. Recorded as rejected-but-acceptable; §5 pins `FOR UPDATE` as the single source of truth. |
| **No DB trigger — rely only on revoking `UPDATE`/`DELETE` from the app role** | A single privilege misconfiguration (a future migration grants `UPDATE` to `choros_app`, or runtime connects as a more-privileged role) silently re-opens mutation of history. The spec analyst's handoff is explicit: keep **both** mechanisms so a privilege misconfig still fails closed (FR-1, AC-3). |
| **No privilege revoke — rely only on the trigger** | A dropped/`DISABLE`d trigger (or `ALTER TABLE … DISABLE TRIGGER`) silently re-opens mutation. Defense-in-depth requires the orthogonal privilege guard too. Both kept (FR-1). |
| **Recompute `row_hash` lazily at read/verify time instead of storing it** | Then there is nothing immutable to tamper-detect *against* — the hash would always match whatever the (possibly mutated) row currently says. `row_hash`/`prev_hash` are stored content of the immutable row so an in-place edit makes the recomputed hash diverge from the stored one (defect class *tamper*). |
| **Raw `jsonb` text (or `row_to_json`) as the preimage for `scope`/`payload`** | Postgres `jsonb` does not preserve key order and may re-serialize numbers/whitespace across writes; two byte-equal logical rows could hash differently → false *tamper* reports (NF-5). Canonical JSON (RFC 8785 / JCS) is mandatory. |
| **Unframed concatenation of fields for the preimage** | Field-boundary ambiguity: `actor="ab",subject="c"` and `actor="a",subject="bc"` would share a preimage (canonicalization collision). Length-prefixing every field + a distinct NULL marker removes the ambiguity (NF-5). |
| **External hash-anchoring to a third-party ledger / RFC-3161 timestamping authority now** | Tier-gated gold-plating, explicitly NOT day-1 (hypothesis §6-A #12, spec §6.6). The head is *shaped* to be anchorable (a copyable `(tenant_id, seq, row_hash)` tuple) and the verifier *supports* an anchored cross-check, but the anchoring *job/authority* is out of scope. |
| **HSM custody / hardware key management; signed audit or policy bundles** | Tier-gated, NOT day-1 (§6-A #12, spec §6.7/§6.8). SHA-256 over a canonical preimage needs no key material; signing/HSM is a later tier, not a foundation invariant. |

None of these reopen a founder-ratified decision. The tenancy fork (RLS-everywhere, silo
now / pooled later, one artifact) is fixed by GT-1 and inherited unchanged; the audit-floor
shape (one floor, hash-chained, head-snapshotted, anchoring deferred) is the hypothesis
§5/§6-A backlog hypothesis this ADR pins, not a new product fork (see §8).

---

## 3. Object model

Postgres types are authoritative; the TS-side mirror follows the T-0014 convention
(camelCase; `string` for `uuid`; `number` for `bigint` epoch-ms / `seq`; `Buffer`/hex for
`bytea`; canonical JSON value for `jsonb`). Both tables inherit the **entire T-0013 §3.1
tenant-table convention** (`tenant_id uuid NOT NULL` no default, leading PK column, leading
column of every composite index/FK; `ENABLE` + `FORCE ROW LEVEL SECURITY`; one default-DENY
permissive policy keyed on `current_setting('choros.tenant_id', true)`; access only via
`withTenant`). That convention is **not** restated per field below — only audit-specific
columns and constraints are pinned. Exact DDL is T-0053's to emit from this model.

### 3.1 `audit_event` (append-only, per-tenant, hash-chained)

| Field | Type | Constraints / Notes |
|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL`, no default; **leading PK column**; RLS key (T-0013 §3.1) |
| `seq` | `bigint` | `NOT NULL`; per-tenant **dense monotonic** sequence (`+1` within a tenant, first = `GENESIS_SEQ = 1`); **`UNIQUE (tenant_id, seq)`** |
| `id` | `uuid` | `NOT NULL`; stable row identity for external references; **`UNIQUE (tenant_id, id)`** |
| `type` | `text` | `NOT NULL`; event type (open vocabulary, e.g. `grant.create`, `grant.revoke`, `role.assign`, `approve`, `agent.invoke`, `budget.reserve`) |
| `actor` | `text` | `NOT NULL`; who performed the event (user/agent/worker id) |
| `subject` | `text` | nullable; affected principal/object reference |
| `scope` | `jsonb` | nullable; scope of the event (org-scope set / resource ref); **JCS-canonicalized in the preimage** |
| `via` | `text` | nullable; path/channel/tool the event came through |
| `proposed_by` | `text` | nullable; LLM proposer identity (hypothesis §5) |
| `confirmed_by` | `text` | nullable; human confirmer identity (hypothesis §5) |
| `payload` | `jsonb` | `NOT NULL`; structured event detail; **JCS-canonicalized in the preimage** |
| `occurred_at` | `bigint` | `NOT NULL`; unix epoch ms |
| `prev_hash` | `bytea` | `NOT NULL`; `row_hash` of `(tenant_id, seq−1)`, or `GENESIS_PREV_HASH` (32 zero bytes) at `seq = GENESIS_SEQ` |
| `row_hash` | `bytea` | `NOT NULL`; `= SHA-256(canonical_preimage)` (§4); the chain link; never part of its own preimage |
| `vocab_version` | `smallint` | `NOT NULL`; pins preimage rules + `H` + genesis constants (§4, FR-6); per-row so chains of mixed versions remain verifiable |

- **Primary key:** `(tenant_id, seq)` — dense per-tenant order is the primary access path.
- **Privilege posture:** `choros_app` granted only `SELECT, INSERT` on `audit_event` (no
  `UPDATE`/`DELETE`); the no-mutate trigger (`§4.6`) bars `UPDATE`/`DELETE` for **all**
  roles. Both held simultaneously (FR-1, AC-1/2/3/4).
- `id` lets other tables reference an audit row by a stable UUID without coupling to `seq`
  ordering (e.g. an E3 confirmation pointer).

### 3.2 `audit_head` (per-tenant forward-only chain head)

| Field | Type | Constraints / Notes |
|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL`; **PK `(tenant_id)`** — exactly one head row per tenant; RLS key |
| `seq` | `bigint` | `NOT NULL`; the latest committed `seq` for this tenant (the chain head's `seq`) |
| `row_hash` | `bytea` | `NOT NULL`; `row_hash` of the row at `(tenant_id, seq)` — the chain head |
| `updated_at` | `bigint` | `NOT NULL`; unix epoch ms of the last forward advance |
| `vocab_version` | `smallint` | `NOT NULL`; `vocab_version` of the head row |

- **Head lifecycle.** A tenant's first append (`seq = GENESIS_SEQ = 1`) is the operation
  that **creates** the head row (`INSERT … ON CONFLICT` upsert in the append transaction);
  there is no pre-existing "empty head". This avoids a sentinel `seq = 0`/`GENESIS_SEQ − 1`
  state and keeps `seq bigint NOT NULL` honest. (Re-pins the spec §4.2 "before the first
  append" note: rather than a pre-seeded head at `seq = 0`, the head springs into existence
  with the genesis row, atomically — strictly simpler and still forward-only.)
- **Forward-only.** Each append sets the head to `(OLD.seq + 1, new row_hash)` in the
  **same transaction** as the `audit_event` `INSERT`. The head-advance trigger (`§4.6`)
  enforces **only `seq` monotonicity** — `NEW.seq = OLD.seq + 1` (no skip, no rewind), so the
  head `seq` can never decrease or jump (FR-4, AC-13/14/15). The trigger deliberately does
  **not** re-derive or validate `NEW.row_hash` against the just-inserted `audit_event` row:
  the head's `row_hash` correctness (that it equals `row_hash` of the row at `(tenant_id,
  NEW.seq)`) is a property of the **append path** (§4.3 writes both from the same computed
  `rowHash` in one transaction) and is **verified offline** by the stateless verifier's
  fork/tamper check (§4.4, defect classes 1/7), not asserted inside the trigger. The DB
  guarantees forward-only `seq`; the chain-linkage guarantee is owned by the append path +
  verifier. (See §4.6(B2).)
- **Anchorable.** `(tenant_id, seq, row_hash)` is a small copyable tuple a periodic job MAY
  snapshot to versioned object storage; comparing a later live head to an anchored one
  detects a same-transaction history rewrite (FR-4, AC-16). The job is T-0053; T-0016 fixes
  only that the head is *shaped* to be anchored.

### 3.3 Chain vocabulary (`vocab_version = 1`) — pinned constants

| Entity | Value (pinned) |
|---|---|
| `H` (hash) | `SHA-256` (32-byte digest) |
| `GENESIS_SEQ` | `1` |
| `GENESIS_PREV_HASH` | 32 zero bytes (`\x00` × 32) |
| Preimage rules | §4.3 field set/order + length-prefixed encoding + JCS for `jsonb` |

All four are bound to `vocab_version = 1`. Any change to **any** of them is a
`vocab_version` bump and a chain-format migration (FR-6); the verifier dispatches on the
row's `vocab_version` to select the rule set (§4.5).

### 3.4 Database roles (inherited from T-0013 §3.4; audit-specific grant noted)

| Entity | Audit-specific attribute |
|---|---|
| `choros_app` (runtime role) | On `audit_event`: granted **`SELECT, INSERT` only** (NOT `UPDATE`/`DELETE`). On `audit_head`: granted `SELECT, INSERT, UPDATE` but the forward-advance trigger constrains every `UPDATE` to `NEW.seq = OLD.seq + 1`. Otherwise as T-0013: `NOSUPERUSER`, `NOBYPASSRLS`, not table owner. |
| `choros_migrator` (owner/DDL role) | Owns `audit_event`/`audit_head`, holds DDL. Even the owner cannot `UPDATE`/`DELETE` `audit_event` (no-mutate trigger, AC-3) **nor `DELETE` an `audit_head` row** (no-delete trigger §4.6(B3)), because the triggers fire regardless of role — only a `DISABLE TRIGGER` / `DROP TRIGGER` migration diff (CI-visible) could lift either. |

---

## 4. Canonical preimage, append, verifier (contracts — implementation is `coder`'s zone, T-0053)

### 4.1 Canonical preimage `canonical_preimage` — the load-bearing serialization (PINNED)

The `canonical_preimage` for a row is a **deterministic byte string** such that two correct
implementations (the TS append path and the verifier) produce **byte-identical** output for
the same logical row. This is the single source of truth for `coder`; it re-pins spec §4.3,
preserving every invariant (deterministic · length-unambiguous · NULL-distinct ·
JSON-canonical · `vocab_version`-pinned) and fixing the concrete spelling.

**(1) Field set & order (for `vocab_version = 1`), exactly, in this order:**

```
tenant_id, seq, id, type, actor, subject, scope, via,
proposed_by, confirmed_by, payload, occurred_at, prev_hash, vocab_version
```

`row_hash` is the OUTPUT and is **never** part of its own preimage.

**(2) Per-field encoding — every field is emitted as a length-prefixed, type-tagged frame**
so the concatenation is unambiguous (no field-boundary collision) and `NULL` is distinct
from any present value:

```
frame(field) := TAG(1 byte) || LEN(4 bytes, big-endian uint32) || BODY(LEN bytes)
canonical_preimage := frame(f₁) || frame(f₂) || … || frame(f₁₄)   -- in the §4.1(1) order
```

| Logical type | TAG | BODY (when present) | NULL |
|---|---|---|---|
| `uuid` (`tenant_id`, `id`) | `0x01` | 16 raw bytes, canonical big-endian | n/a (these are `NOT NULL`) |
| `bigint` (`seq`, `occurred_at`) | `0x02` | 8 bytes, two's-complement **big-endian** | n/a (`NOT NULL`) |
| `smallint` (`vocab_version`) | `0x03` | 2 bytes, big-endian | n/a (`NOT NULL`) |
| `text` (`type`, `actor`, `subject`, `via`, `proposed_by`, `confirmed_by`) | `0x04` | UTF-8 bytes (no BOM, no normalization beyond raw UTF-8) | **TAG `0x00`, LEN `0x00000000`, no body** |
| `jsonb` (`scope`, `payload`) | `0x05` | RFC 8785 / JCS canonical JSON (lexicographic key order by UTF-16 code unit, no insignificant whitespace, canonical number form), then UTF-8 bytes | **TAG `0x00`, LEN `0x00000000`, no body** (for nullable `scope`) |
| `bytea` (`prev_hash`) | `0x06` | raw bytes (32 for a hash / genesis) | n/a (`NOT NULL`) |

Rules:
- The **NULL marker** is `TAG 0x00, LEN 0`, applied to a NULL value of a nullable field
  (`subject`, `scope`, `via`, `proposed_by`, `confirmed_by`). It is distinct from a present
  empty `text` (`TAG 0x04, LEN 0`) and from a present empty/`null` JSON (`TAG 0x05` with the
  JCS bytes of the JSON value) — so `NULL ≠ "" ≠ JSON null`.
- `LEN` is a **fixed 4-byte big-endian** prefix (max body 4 GiB; far beyond any audit field).
- All multi-byte integers are **big-endian**; this is fixed, not platform-dependent.
- The frame `TAG` is part of the bytes hashed, so a type change to a field (e.g. `text`→`jsonb`)
  also perturbs the digest — caught by the golden-digest snapshot (AC-10).

**(3) Hash & genesis:** `row_hash = SHA-256(canonical_preimage)` (32 bytes).
`GENESIS_PREV_HASH = ` 32 zero bytes; `GENESIS_SEQ = 1`. All bound to `vocab_version = 1`.

**(4) Versioning:** any change to (1)–(3) — field set, order, a TAG, the LEN width, the JCS
profile, endianness, or `H` — is a `vocab_version` bump and a chain-format migration (FR-6).
The verifier dispatches on the row's `vocab_version` to pick the rule set (§4.5); rows of
different versions remain independently verifiable.

> This re-pins the spec §4.3 latitude: the spec allowed `architect` to re-spell the
> byte-level encoding provided the five invariants hold. The §4.1 framing (1-byte TAG +
> 4-byte BE LEN + body, distinct NULL marker, JCS for `jsonb`, big-endian fixed-width ints)
> is now the **single normative encoding** for `vocab_version = 1`. `coder` implements
> exactly this; the golden-digest fixture (AC-9/AC-10) freezes it.

### 4.2 Per-tenant append serialization primitive (PINNED): `audit_head … FOR UPDATE`

The per-tenant append serialization is **pinned to `SELECT … FROM audit_head WHERE
tenant_id = current_setting('choros.tenant_id', true)::uuid FOR UPDATE`** — a row-level lock
on **this tenant's** `audit_head` row. Rationale (vs the rejected advisory-lock alternative,
§2):

- The append path **must read `audit_head` anyway** to obtain `prev_hash` and the prior
  `seq`. Locking that row `FOR UPDATE` makes the serialization point and the chain-state
  read the *same* operation — one round-trip, one source of truth, no skew between "the lock"
  and "the head".
- It is **inherently per-tenant** (the lock is on one tenant's head row), so two tenants
  never contend — NF-2 with no hash-collision caveat.
- For a tenant's **first** append the head row does not yet exist, so the `FOR UPDATE` lock
  has no row to take. Two concurrent genesis appends therefore both read "no head", both
  compute `seq = GENESIS_SEQ = 1` and `prev_hash = GENESIS_PREV_HASH`, and both attempt the
  `audit_event` `INSERT`; the `UNIQUE (tenant_id, seq)` (= PK) **aborts the losing
  transaction** — never two genesis rows. The genesis `seq = 2` outcome is **not automatic**:
  the loser MUST **retry `appendAuditEvent` from step 1**, on retry it now finds the winner's
  committed head (created by the winner's `INSERT … ON CONFLICT (tenant_id)` upsert), takes
  the `FOR UPDATE` lock on it, and recomputes `seq = 2` / `prev_hash = row_hash(seq=1)`.
  After the genesis row exists, every subsequent appender is serialized by the per-tenant
  `audit_head … FOR UPDATE` lock (one in-flight appender per tenant at a time), reads the
  current head, and computes a dense `+1` `seq` with no `UNIQUE` race; only the
  head-creating genesis pair can collide, and that collision is resolved by abort + retry.

**Caller retry contract (non-negotiable):** an append that aborts on the
`UNIQUE (tenant_id, seq)` constraint (only possible for the genesis race above, or under a
serialization failure) is **retried by re-running `appendAuditEvent` from step 1** — re-read
the head under `FOR UPDATE`, recompute `seq`/`prev_hash`/`row_hash`, re-insert — so the dense
`+1` invariant always holds. The retry re-reads committed state; it never reuses a stale
`seq` or `prev_hash`.

**Invariant (non-negotiable, from the spec handoff):** per-tenant, race-free, `+1` dense
`seq`, **no global lock or global sequence**. The *primitive* (`FOR UPDATE` here) is pinned
as the single source of truth for `coder`; the invariant — not the spelling — is what the
fitness functions enforce (FF-2/AC-6), so `coder` MUST NOT substitute a global lock.

### 4.3 Append contract (pseudocode — code is T-0053)

```ts
// The ONLY sanctioned way to write an audit row. Runs inside withTenant (T-0013 §4.1):
// tenant context (choros.tenant_id GUC) is already SET LOCAL, RLS scopes every statement.
function appendAuditEvent(tx, e: AuditEventInput): { seq: bigint; rowHash: Buffer } {
  // 1. Per-tenant serialization + chain-state read in ONE op (§4.2): lock THIS tenant's
  //    head row. Missing head => this is the tenant's genesis append.
  const head = tx.selectForUpdate("audit_head", { tenant_id: TENANT });   // 0 or 1 row
  const seq      = head ? head.seq + 1n   : GENESIS_SEQ;                   // dense +1
  const prevHash = head ? head.row_hash    : GENESIS_PREV_HASH;           // 32 zero bytes
  // 2. Build the canonical preimage (§4.1) over the fixed field set + prevHash + vocab.
  const preimage = canonicalPreimage({ ...e, tenant_id: TENANT, seq,
                                       prev_hash: prevHash, vocab_version: VOCAB });
  const rowHash  = sha256(preimage);                                      // 32 bytes
  // 3. Append (INSERT ONLY) + advance head — SAME transaction (FR-4 atomicity).
  tx.insert("audit_event", { ...e, tenant_id: TENANT, seq,
                             prev_hash: prevHash, row_hash: rowHash, vocab_version: VOCAB });
  tx.upsertHead("audit_head",                                            // forward-only
    { tenant_id: TENANT, seq, row_hash: rowHash, updated_at: now(), vocab_version: VOCAB });
  return { seq, rowHash };
}
// RETRY CONTRACT (§4.2): if step 3's audit_event INSERT aborts on UNIQUE(tenant_id,seq) —
//   possible only for the genesis race (no head row yet ⇒ two appenders both compute seq=1)
//   or a serialization failure — the CALLER MUST re-run appendAuditEvent FROM STEP 1. On
//   retry the winner's head now exists, the FOR UPDATE lock is taken, and seq/prev_hash/
//   row_hash are recomputed against committed state (e.g. seq=2). NEVER reuse a stale seq.
// INVARIANTS held by schema + triggers (NOT by this code being correct):
//  - choros_app has SELECT,INSERT on audit_event, NO UPDATE/DELETE (FR-1a);
//  - no-mutate trigger bars UPDATE/DELETE on audit_event for ALL roles (FR-1b);
//  - head-advance trigger enforces NEW.seq = OLD.seq + 1, forward-only (FR-4);
//  - UNIQUE(tenant_id,seq) + the FOR UPDATE lock make seq dense & race-free (FR-2).
```

### 4.4 Verifier contract — the seven defect classes (pseudocode — code is T-0053)

```ts
// Stateless per-tenant verifier (FR-5). Reads ONLY: this tenant's rows (RLS-scoped,
// ORDER BY seq), the pinned genesis constants, the row's vocab_version, and OPTIONALLY an
// anchored head snapshot. No DB-internal trust, no network, no global state (NF-4).
function verifyAuditChain(rows: AuditEventRow[], anchoredHead?: HeadSnapshot): VerifyResult {
  let prev = GENESIS_PREV_HASH, expectSeq = GENESIS_SEQ;
  const seen = new Set<bigint>();
  for (const r of rows) {                       // rows already ORDER BY seq
    if (seen.has(r.seq))            return defect("dup", r.seq);                  // 6
    seen.add(r.seq);
    if (r.seq !== expectSeq)        return defect(r.seq > expectSeq ? "gap|delete" : "reorder", r.seq); // 5,4 / 2
    if (!eq(r.prev_hash, prev))     return defect("reorder|delete|insert", r.seq);// 2,4,3
    if (!eq(sha256(preimage(r, r.vocab_version)), r.row_hash))
                                    return defect("tamper", r.seq);              // 1
    prev = r.row_hash; expectSeq += 1n;
  }
  // fork (7): the live head must equal the anchored head at the same seq; divergence =
  //   a rewritten chain (two valid-looking successors / branch).
  if (anchoredHead) {
    const liveHead = rows[rows.length - 1];
    if (anchoredHead.seq <= liveHead.seq && !eq(headRowHashAt(rows, anchoredHead.seq),
                                                anchoredHead.row_hash))
                                    return defect("fork", anchoredHead.seq);     // 7
  }
  return ok;
}
// dup (6) is also structurally barred by UNIQUE(tenant_id,seq); the verifier still flags it
//   so a chain exported from a DB where the constraint was (mis)dropped is caught offline.
```

**Defect-class → detection map (each is a fitness-checked case, AC-11):**

| # | Defect | Detection rule in the verifier |
|---|---|---|
| 1 | **tamper** (content altered in place) | `SHA-256(preimage(r)) ≠ r.row_hash` |
| 2 | **reorder** (rows resequenced) | `r.seq ≠ expectSeq` (out of order) OR `r.prev_hash ≠ row_hash[n−1]` after sort-by-`seq` |
| 3 | **insert** (forged row spliced in) | breaks the following row's `prev_hash` linkage and/or perturbs dense `seq`; recomputed chain diverges from stored `row_hash` |
| 4 | **delete** (row removed) | `seq` gap (`seq[i+1] ≠ seq[i]+1`) **and** `prev_hash[i+1] ≠ row_hash[i]` |
| 5 | **gap** (non-dense sequence) | any `seq[i+1] − seq[i] ≠ 1` within a tenant (superset signal of delete/insert) |
| 6 | **dup** (duplicate `seq`) | two rows with the same `(tenant_id, seq)` — structurally barred by `UNIQUE(tenant_id, seq)`; verifier flags it if the constraint is ever absent |
| 7 | **fork** (two successors of one parent / rewrite) | two rows whose `prev_hash` equals the same `row_hash`, OR live head `row_hash` ≠ anchored-snapshot `row_hash` at the same `seq` |

The verifier also checks **genesis**: the `seq = GENESIS_SEQ` row has `prev_hash =
GENESIS_PREV_HASH`. It runs **per tenant** (one tenant's RLS-scoped rows); cross-tenant
verification is N independent runs (FR-5, AC-12).

### 4.5 `vocab_version` dispatch

`preimage(row, vocab_version)` selects the §4.1 rule set by the row's `vocab_version`. For
`vocab_version = 1` it applies §4.1 exactly. A future `vocab_version = 2` registers a second
rule set; a chain may contain a contiguous prefix of v1 rows then v2 rows (a format
migration appends, it does not rewrite history), and each row verifies under its own
version. The golden-digest fixture (AC-10) freezes v1; changing v1's rules without bumping
the version flips the golden digest and fails CI.

### 4.6 Structural enforcement — both append-only mechanisms + head-advance (contracts; SQL is T-0053)

```sql
-- (A) PRIVILEGE GUARD (FR-1a): app role gets append+read only on audit_event.
GRANT SELECT, INSERT ON audit_event TO choros_app;   -- NO UPDATE, NO DELETE
-- audit_head: app role may advance the head, constrained by the trigger (B2).
GRANT SELECT, INSERT, UPDATE ON audit_head TO choros_app;   -- NO DELETE

-- (B1) NO-MUTATE TRIGGER (FR-1b): bars UPDATE/DELETE on audit_event for EVERY role
--      (owner included, because the trigger fires regardless of privilege).
CREATE FUNCTION audit_event_no_mutate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN  RAISE EXCEPTION 'audit_event is append-only (T-0016 FR-1)';  END $$;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_no_mutate();
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_no_mutate();

-- (B2) HEAD-ADVANCE TRIGGER (FR-4): every audit_head UPDATE must be forward-only +1.
--      SCOPE: this trigger enforces ONLY seq monotonicity (NEW.seq = OLD.seq + 1). It does
--      NOT validate NEW.row_hash against the audit_event row at (tenant_id, NEW.seq): head
--      row_hash correctness is owned by the append path (§4.3 writes both from one computed
--      rowHash in one txn) and verified offline by the verifier's fork/tamper check (§4.4,
--      classes 1/7). Prose (§3.2) and this SQL agree: DB ⇒ forward-only seq; append path +
--      verifier ⇒ chain linkage. (Adding a row_hash cross-check here is a rejected T-0053
--      option: a SELECT-in-trigger that duplicates the append path's invariant.)
CREATE FUNCTION audit_head_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.seq <> OLD.seq + 1 THEN
    RAISE EXCEPTION 'audit_head advances by exactly +1 (T-0016 FR-4): % -> %', OLD.seq, NEW.seq;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_head_advance BEFORE UPDATE ON audit_head
  FOR EACH ROW EXECUTE FUNCTION audit_head_forward_only();

-- (B3) NO-DELETE TRIGGER on audit_head (FR-4, MUST — symmetric with audit_event's B1):
--      bars DELETE of a head row for EVERY role, so the forward-only invariant cannot be
--      bypassed by deleting the head and letting the next append re-genesis (silent
--      truncate/fork). Held alongside the privilege guard (audit_head DELETE not granted to
--      choros_app, A above) — dual mechanism, defeating it needs a CI-visible diff.
CREATE FUNCTION audit_head_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN  RAISE EXCEPTION 'audit_head is forward-only; head rows cannot be deleted (T-0016 FR-4)';  END $$;
CREATE TRIGGER audit_head_no_delete_trg BEFORE DELETE ON audit_head
  FOR EACH ROW EXECUTE FUNCTION audit_head_no_delete();
```

Both `audit_event` mechanisms are held **simultaneously**: revoking the privilege does not
remove the trigger and vice-versa, so a misconfiguration of either alone still fails closed
(AC-1/2/3/4). Defeating append-only requires a CI-visible diff that *both* grants
`UPDATE`/`DELETE` to the app role *and* drops/disables the trigger — caught by the
`audit_append_only` lint (FF-1).

`audit_head` is protected by the same dual-mechanism, fail-closed posture (FR-1b symmetry):
(i) `choros_app` is **not** granted `DELETE` on `audit_head` (privilege guard, §4.6(A)), and
(ii) the no-delete trigger (B3) bars head-row deletion for **every** role including the
owner. Both are held simultaneously, so deleting a head row — which would let the next append
silently re-genesis and truncate/fork the chain — requires a CI-visible diff that *both*
grants `DELETE` to the app role *and* drops/disables the no-delete trigger. The
`audit_append_only` lint (FF-1) asserts the `audit_head` `BEFORE DELETE` trigger is present
and that no `GRANT … DELETE … ON audit_head TO choros_app` appears, exactly as it does for
`audit_event`'s no-mutate guard.

---

## 5. Fitness functions

Each invariant becomes an executable CI rule. `gating`: **static-now** = a source/lint/unit
check runnable in today's `npm run ci` (the repo is zero-runtime-dep: TS + vitest +
`ci/checks/*` lints, scanning the migration SQL / object-model fixtures / TS); **live-T-0053**
= a live-DB probe authored now (as `ci/checks/*.sql` or `*.test.ts`), wired into the
`db-isolation` CI job once Postgres exists in T-0053. All are authored now so none can be
silently dropped. Three **new lints** are introduced — `audit_append_only`,
`audit_no_global_seq`, `audit_vocab_pinned` — alongside reuse of T-0013's RLS probes.

| ID | Rule | ci_check | gating |
|---|---|---|---|
| **FF-1** | Append-only is structural: app role never holds `UPDATE`/`DELETE` on `audit_event`, AND a no-mutate trigger exists; **`audit_head` is delete-protected by the same dual mechanism** (no `DELETE` grant to `choros_app` AND a `BEFORE DELETE` no-delete trigger) | `ci/checks/audit_append_only.sh` over the migration SQL: FAIL if any `GRANT … (UPDATE\|DELETE) … ON audit_event TO choros_app` appears, OR if no `BEFORE UPDATE`/`BEFORE DELETE` trigger on `audit_event` is present, **OR if any `GRANT … DELETE … ON audit_head TO choros_app` appears, OR if no `BEFORE DELETE` trigger on `audit_head` is present**. Live: app-role `UPDATE`/`DELETE` on a seeded `audit_event` row fails (privilege OR trigger); owner `UPDATE`/`DELETE` fails (trigger); **app-role and owner `DELETE` of an `audit_head` row both fail (privilege / trigger)**. | static-now (lint) + live-T-0053 (AC-1/2/3/4) |
| **FF-2** | Per-tenant append serialization is `audit_head … FOR UPDATE`; no global sequence / global advisory lock for audit ordering | `ci/checks/audit_no_global_seq.sh`: FAIL if a global `CREATE SEQUENCE` feeds `audit_event.seq`, or if `pg_advisory*lock` with a non-tenant-derived key is used for audit ordering; assert the append path locks `audit_head` `FOR UPDATE` keyed on the tenant. Live (concurrency): N concurrent appends in tenant-A yield N distinct dense `seq`; concurrent appends in A and B do not block on a shared lock. | static-now (lint) + live-T-0053 (AC-6) |
| **FF-3** | `seq` is per-tenant dense & unique; `UNIQUE (tenant_id, seq)` present | Static-now: lint asserts `UNIQUE (tenant_id, seq)` and PK `(tenant_id, seq)` on `audit_event` in the migration DDL. Live: append K rows for A, M for B; A's `seq` = `1..K` dense (no gap/dup), B independent; a manual duplicate-`seq` insert is rejected. | static-now (lint) + live-T-0053 (AC-5) |
| **FF-4** | Genesis + chain linkage: `seq=1` row has `prev_hash=GENESIS_PREV_HASH`; every `seq=n>1` has `prev_hash = row_hash[n−1]` | Live: assert the genesis row's `prev_hash` = 32 zero bytes; for every `n>1`, `prev_hash` = `row_hash` of `(tenant_id, n−1)`; any mismatch fails. Static-now (unit): a built fixture chain satisfies the linkage. | static-now (unit) + live-T-0053 (AC-7/8) |
| **FF-5** | `row_hash = SHA-256(canonical_preimage)`; preimage is deterministic, length-unambiguous, NULL-distinct, JCS-canonical | Static-now (unit) `auditPreimage.test.ts`: build the §4.1 preimage for a fixture row, assert `sha256(preimage)` equals a **pinned golden digest**; assert determinism (same input → same bytes), `NULL ≠ "" ≠ JSON null`, and that reordered `jsonb` keys yield an identical preimage (JCS). Live: for each persisted row, recomputed `sha256(preimage(row))` = stored `row_hash`. | static-now (unit) + live-T-0053 (AC-9) |
| **FF-6** | Preimage/hash/genesis vocabulary is pinned to `vocab_version`; a change forces an explicit bump | `ci/checks/audit_vocab_pinned.sh` + `auditPreimage.test.ts`: assert (a) every `audit_event` row carries `vocab_version`, (b) the preimage builder dispatches on `vocab_version`, (c) a **golden-digest snapshot** of the `vocab=1` rules — changing field set/order/TAG/LEN/encoding/`H`/genesis flips the golden digest and FAILs CI until `vocab_version` is bumped. | static-now (lint + unit) (AC-10) |
| **FF-7** | Stateless per-tenant verifier detects all 7 defect classes; a clean chain verifies ok | Static-now (unit) `auditVerify.test.ts`: feed the verifier seven crafted row-sets (tamper/reorder/insert/delete/gap/dup/fork) + one clean chain; assert each defect is reported with the right class and the clean chain verifies ok; assert the genesis check fires when `prev_hash` ≠ `GENESIS_PREV_HASH`. | static-now (unit) (AC-11) |
| **FF-8** | Verifier is stateless & per-tenant (inputs only: rows, constants, vocab, optional anchored head; no DB/network/global) | Static-now (unit): the verifier signature takes only those inputs; tenant-A rows verify ok while tenant-B rows are tampered (and vice-versa) in independent runs; no import of DB/network modules in the verifier unit. | static-now (unit) (AC-12) |
| **FF-9** | Exactly one head row per tenant; head names the latest `(seq, row_hash)`; append + head advance are atomic | Live: `audit_head` has PK `(tenant_id)` (one row/tenant); after appending to `seq=n`, `audit_head.(seq,row_hash)` = `(n, row_hash of seq=n)`; after `ROLLBACK` of an append, neither the row nor the head advance is visible; after `COMMIT` both are. Static-now: lint asserts PK `(tenant_id)` on `audit_head` and that the append path writes both in one transaction. | static-now (lint) + live-T-0053 (AC-13/15) |
| **FF-10** | Head advances forward-only; backward/skip `UPDATE` rejected | Static-now: lint asserts a `BEFORE UPDATE` head-advance trigger on `audit_head` exists. Live: an `UPDATE` setting `audit_head.seq` ≤ current, or `≠ old+1`, is rejected by the trigger; a normal append advances by exactly `+1`. | static-now (lint) + live-T-0053 (AC-14) |
| **FF-11** | Head is externally anchorable; verifier fork-check flags live-head ≠ anchored-head at same `seq` | Static-now (unit): the head `(tenant_id, seq, row_hash)` is a copyable tuple; `auditVerify.test.ts` feeds an anchored snapshot that diverges from the live head at the same `seq` and asserts a `fork` defect; identical anchored head verifies ok. (The snapshot *job* is out of scope, §6.) | static-now (unit) (AC-16) |
| **FF-12** | `audit_event` & `audit_head` are FORCE-RLS default-DENY tenant tables in the known-tenant-tables fixture (reuses T-0013 probes) | Static-now: `ci/checks/known_tenant_tables.txt` contains `audit_event` and `audit_head` (so both flow into T-0013 FF-2/FF-3/FF-6/FF-7). Live (reuse T-0013 probes): no context ⇒ count 0 on both; context=A ⇒ `WHERE tenant_id=B` = 0; both have `relrowsecurity` AND `relforcerowsecurity`. | static-now (fixture) + live-T-0053 (AC-17) |
| **FF-13** | `tenant_id` is the leading column of every PK/composite index/FK on both tables (reuses T-0013 `tenant_id_leading.sql`) | Static-now: lint over the migration DDL asserts PK `(tenant_id, seq)` on `audit_event`, PK `(tenant_id)` on `audit_head`, and `tenant_id` first on any composite index/FK. Live: reuse T-0013 `tenant_id_leading.sql` over both tables. | static-now (lint) + live-T-0053 (AC-18) |
| **FF-14** | Governance fields are first-class columns AND in the preimage (editing any is tamper-detectable); grant events are ordinary rows | Static-now (unit): the `audit_event` object-model fixture includes `type/actor/subject/scope/via/proposed_by/confirmed_by/payload/occurred_at`; the §4.1 preimage includes all of them; a unit alters `confirmed_by` in a fixture and asserts the recomputed `row_hash` differs. A `grant.create`/`grant.revoke` event maps onto the columns with **no schema change** (AC-20 = grant events are rows in this floor). | static-now (unit) (AC-19/20) |

**CI wiring.** The three new lints (`audit_append_only`, `audit_no_global_seq`,
`audit_vocab_pinned`) and the new unit suites (`auditPreimage.test.ts`,
`auditVerify.test.ts`) join the existing `npm run ci` today (static-now), operating over the
object-model fixtures and the migration SQL that T-0053 will author. The live-T-0053 halves
are authored now as `ci/checks/*.sql` / `*.test.ts` fixtures and activated by the
`db-isolation` CI job (Postgres service container) introduced in T-0053. `audit_event` and
`audit_head` are appended to the T-0013 `known_tenant_tables` fixture so every existing
isolation probe (FF-2/3/6/7) covers them automatically (FF-12).

---

## 6. Traceability (AC-1..AC-20 → design)

| AC | Covered by |
|---|---|
| AC-1 (app role cannot UPDATE) | §3.4 grant `SELECT,INSERT` only · §4.6(A)/(B1) · **FF-1** |
| AC-2 (app role cannot DELETE) | §3.4 no DELETE grant · §4.6(A)/(B1) · **FF-1** |
| AC-3 (trigger bars UPDATE/DELETE even for owner) | §4.6(B1) no-mutate trigger (fires regardless of role) · **FF-1** |
| AC-4 (append-only structural; CI-visible diff to defeat) | §1.1 dual mechanism · §4.6 · **FF-1** |
| AC-5 (`seq` per-tenant dense & unique) | §3.1 `UNIQUE(tenant_id,seq)` / PK · §4.3 dense `+1` · **FF-3** |
| AC-6 (serialization per-tenant, not global) | §4.2 `audit_head … FOR UPDATE` (pinned) · **FF-2** |
| AC-7 (genesis `prev_hash`) | §3.3 `GENESIS_PREV_HASH` · §4.1(3) · **FF-4** |
| AC-8 (chain linkage `prev_hash[n]=row_hash[n−1]`) | §1.3 chain · §4.3 append · **FF-4** |
| AC-9 (`row_hash=H(preimage)`, deterministic/length-unambiguous) | §4.1 canonical preimage (pinned) · **FF-5** |
| AC-10 (vocab pinned; golden-digest forces bump) | §3.3 vocab constants · §4.1(4)/§4.5 dispatch · **FF-6** |
| AC-11 (verifier detects all 7 defect classes) | §4.4 verifier + defect map · **FF-7** |
| AC-12 (verifier stateless & per-tenant) | §4.4 inputs-only signature · **FF-8** |
| AC-13 (one head/tenant; names latest `(seq,row_hash)`) | §3.2 `audit_head` PK · §4.3 advance · **FF-9** |
| AC-14 (head forward-only; backward/skip rejected) | §3.2 forward-only · §4.6(B2) trigger · **FF-10** |
| AC-15 (append+head atomic; head never names non-durable row) | §1.4 / §4.3 same-transaction · **FF-9** |
| AC-16 (head anchorable; fork-check flags live≠anchored) | §3.2 anchorable tuple · §4.4 fork branch (7) · **FF-11** |
| AC-17 (`audit_event`+`audit_head` FORCE-RLS default-DENY in fixture) | §3.1 T-0013 inheritance · **FF-12** |
| AC-18 (`tenant_id` leading on every PK/index/FK) | §3.1 / §3.2 PKs · **FF-13** |
| AC-19 (governance fields first-class AND hash-covered) | §3.1 columns · §4.1(1) preimage field set · **FF-14** |
| AC-20 (grant event = ordinary row, not separate log) | §2 (rejected separate `grant_log`) · §3.1 `type` open vocab · **FF-14** |

Every AC-1..AC-20 maps to at least one fitness function. The seven verifier defect classes
each map to a checked case under **FF-7** (AC-11).

---

## 7. Runtime target

**Postgres in the silo `docker-compose` stack** (one tenant per instance), on the founder's
home server (`/srv/choros`, deploy founder-gated) — the same target as T-0013/T-0014. The
app connects as the non-owner / non-superuser / `NOBYPASSRLS` role `choros_app` (granted
`SELECT,INSERT` on `audit_event`, `SELECT,INSERT,UPDATE` on `audit_head`); migrations run as
`choros_migrator`. The floor runs at N=1 (one code-path, pooled-ready; silo = pooled audit
narrative, NF-3).

**Infra dependency — NOT built in T-0016:** the SQL DDL/migrations for `audit_event` and
`audit_head`, the no-mutate and head-advance triggers, the privilege grants, the
`appendAuditEvent` path + the `FOR UPDATE` serialization, the `verifyAuditChain`
implementation + its `db-isolation` CI wiring, and the head-snapshot-to-object-storage job
are all delivered by **T-0053** and dependent build tasks (spec §6.1–§6.5). T-0016 is
design-only: it authors the invariants, the object model, the canonical-preimage formalism,
the seven defect classes, and the fitness functions (with `ci_check` commands/fixtures) so
they wire the moment Postgres exists. External anchoring, HSM custody, and signed bundles
are tier-gated and **excluded** day-1 (§6-A #12). Server/DB provisioning is a founder gate
(GT-4), not an autonomous system action.

---

## 8. Escalation

None. The audit-floor shape — one append-only per-tenant hash-chained floor, head snapshot,
SHA-256 over a canonical preimage, external anchoring/HSM/signed-bundles deferred as
tier-gated — is the hypothesis §5 / §6-A #8/#12 backlog hypothesis (E2.8), built directly on
the founder-approved GT-1 tenancy model (T-0013) which this ADR consumes unchanged. No new
high-leverage product fork is opened. The two latitude points the spec delegated to
`architect` are resolved here as the single source of truth for `coder`, both
implementation-detail conventions, not product-direction forks:

1. **Per-tenant serialization primitive** → pinned to `audit_head … FOR UPDATE` (§4.2),
   because the append must read the head for `prev_hash`/`seq` anyway, collapsing the lock
   and the chain-state read into one per-tenant operation (advisory lock rejected for hash
   collisions + state skew, §2).
2. **Canonical-preimage byte encoding** → pinned to a 1-byte TAG + 4-byte big-endian LEN +
   body framing, a distinct `TAG 0x00, LEN 0` NULL marker, big-endian fixed-width integers,
   and RFC 8785 / JCS for `jsonb` (§4.1), preserving every spec §4.3 invariant
   (deterministic, length-unambiguous, NULL-distinct, JSON-canonical, `vocab_version`-pinned).
