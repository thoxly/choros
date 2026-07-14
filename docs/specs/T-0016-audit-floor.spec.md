# T-0016 · Append-only per-tenant hash-chained audit floor Spec

**Title:** E2.8 · Append-only per-tenant hash-chained audit floor (monotonic seq, DB no-UPDATE/DELETE, head snapshot)
**Status:** ready (no blocking questions)
**Authored:** 2026-06-10
**Type:** architecture · **DESIGN-ONLY** (invariants/object-model/contracts/fitness-functions; SQL DDL/triggers/migrations/runtime land in T-0053 + dependent build tasks)
**spec_ref:** `playbooks/rbac-backlog.md#E2.8` · hypothesis §5 (`audit_event`), §3 Q9; §6-A #8
**Foundation (do NOT contradict):** `docs/design/T-0013-tenant-isolation.adr.md` (audit floor is an ordinary RLS-scoped tenant table → chain is **per tenant**, `tenant_id` leading, FORCE RLS), `docs/design/T-0014-registry-model.adr.md` (object/event model conventions, design-only discipline, `ci_check`+`gating` fitness shape).

---

## 1. Summary

Choros records every governance-significant action (grant create/revoke, role
assignment, approval/transition, agent invocation, budget reservation — and, per E3.6,
every grant-issuance event is a *first-class audit row*, not a separate log) into a
single **append-only, per-tenant, hash-chained audit floor**. The floor is one ordinary
T-0013 tenant table (`audit_event`) plus a per-tenant head snapshot (`audit_head`). It
gives three structural guarantees that together make tampering require a CI-visible
schema/privilege change rather than a silent row mutation:

1. **Append-only at the DB layer** — `UPDATE` and `DELETE` on `audit_event` are
   forbidden structurally (privilege revoke on the app role *and* a rule/trigger), so a
   single privilege misconfiguration still fails closed.
2. **Per-tenant hash chain** — each row carries `prev_hash` linking the previous row's
   `row_hash` within the same tenant, and `row_hash = H(canonical_preimage)`. A stateless
   verifier replaying a tenant's chain detects tamper, reorder, insert, delete, gap, dup,
   and fork.
3. **Per-tenant monotonic `seq`** — a dense, gap- and duplicate-checkable sequence per
   tenant, appended under a per-tenant serialization (never a global lock), so two
   tenants never contend.

A per-tenant **head snapshot** (`audit_head`: latest `seq` + `row_hash`) is maintained
forward-only and atomically with the append, so the head never names a non-durable row
and can be externally anchored (e.g. periodically copied to versioned object storage) as
a cheap tamper tripwire.

This task is **design-only**: it fixes the invariants, object model, contracts, the
canonical-preimage formalism, the seven verifier defect classes, and the fitness
functions (each with a concrete `ci_check` + `gating` note). The SQL DDL, the no-UPDATE/
no-DELETE rule/trigger, the privilege grants, the append/head-update transaction, the
verifier implementation, and the snapshot job land in **T-0053** and dependent build
tasks — **not here**.

---

## 2. Scope boundary

T-0016 is a **design-deliverable** task in the same mold as the merged T-0013/T-0014. It
defines what any correct implementation MUST satisfy. It does NOT write migration code,
triggers, the verifier, or the snapshot job today — those are T-0053 + dependent build
tasks (§5 Out of Scope enumerates the deferral). `audit_event` is an ordinary tenant
table: it inherits the entire T-0013 §3.1 convention (tenant_id NOT NULL leading PK,
FORCE RLS, default-DENY, scoped uniqueness, `withTenant` access) verbatim. T-0016 adds
**append-only + chain + monotonic seq + head snapshot** on top of that convention; it
introduces **no new tenant-isolation code-path**.

---

## 3. Functional Requirements

### FR-1  `audit_event` is an append-only, per-tenant tenant table

- `audit_event` is a T-0013 tenant table: `tenant_id uuid NOT NULL` is the leading PK
  column; `ENABLE` + `FORCE ROW LEVEL SECURITY`; one default-DENY policy keyed on the
  `choros.tenant_id` GUC; all access via `withTenant` (T-0013 §3.1, §4.1, §4.3).
- After a row is committed, it MUST be **immutable and undeletable at the DB layer**.
  `UPDATE` and `DELETE` on `audit_event` MUST be forbidden by **two independent
  mechanisms held simultaneously**: (a) the app role (`choros_app`) is **not** granted
  `UPDATE`/`DELETE` on `audit_event`; (b) a DB rule/trigger raises on any `UPDATE`/
  `DELETE` regardless of role. Either mechanism alone fails closed; both are kept so a
  privilege misconfiguration still cannot mutate history.
- Defeating append-only MUST require a **deliberate, CI-visible schema/privilege diff**
  (dropping the trigger or granting UPDATE/DELETE), never a forgotten guard or a runtime
  query. This is the structural-not-discipline posture of T-0013 NF-2, applied to
  history.

### FR-2  Per-tenant monotonic sequence `seq`

- Every `audit_event` row carries `seq bigint NOT NULL`, a **per-tenant** sequence that
  is **monotonic and dense** (strictly increasing by exactly 1 within a tenant, first
  row `seq = GENESIS_SEQ`).
- `seq` MUST be unique within a tenant: `UNIQUE (tenant_id, seq)` (scoped, never global).
- The next `seq` for a tenant MUST be assigned under a **per-tenant append
  serialization** (e.g. a per-tenant advisory lock or a `SELECT … FOR UPDATE` on that
  tenant's `audit_head` row) so two concurrent appends within one tenant cannot receive
  the same or a reordered `seq`. The serialization MUST be **per tenant**, NOT a global
  sequence/lock — global serialization is a defect (it makes every tenant's writes
  contend, violating tenant independence).
- `seq` density makes gaps (a deleted row) and duplicates structurally detectable by the
  verifier (FR-5 defect classes *delete*, *gap*, *dup*).

### FR-3  Per-tenant hash chain

- Every `audit_event` row carries `prev_hash bytea NOT NULL` and `row_hash bytea NOT
  NULL`.
- The chain is **per tenant**: for a row with `seq = n > GENESIS_SEQ`, `prev_hash` MUST
  equal the `row_hash` of that tenant's row at `seq = n − 1`. The first row of a tenant
  (`seq = GENESIS_SEQ`) MUST carry `prev_hash = GENESIS_PREV_HASH` (a fixed,
  vocab-pinned constant — e.g. 32 zero bytes — that anchors the chain genesis).
- `row_hash = H(canonical_preimage)` where `H` is a fixed cryptographic hash (SHA-256;
  exact algorithm pinned by `vocab_version`, FR-6) and `canonical_preimage` is the
  deterministic byte serialization defined in §4.
- `row_hash` and `prev_hash` link the chain so that any alteration to a row's content, or
  any change to ordering/membership, breaks the recomputed-hash equality at or after the
  affected row (FR-5).
- Both `prev_hash` and `row_hash` are written by the **append path** (app layer computes
  them inside the `withTenant` transaction); they are content of the immutable row, not
  recomputed lazily.

### FR-4  Per-tenant head snapshot `audit_head`

- `audit_head` is a T-0013 tenant table holding **exactly one row per tenant**
  (PK `(tenant_id)`), recording that tenant's **latest** `seq` and the corresponding
  `row_hash` (the chain head).
- The head MUST be updated **forward-only**: an append for `seq = n` updates the head
  from `(n−1, hash_{n−1})` to `(n, hash_n)`; the head's `seq` MUST never decrease and
  MUST advance by exactly 1 per append. A non-advancing or backward head update is a
  defect.
- The append (insert into `audit_event`) and the head update MUST be **atomic together**:
  they occur in the same transaction such that the head **never names a non-durable
  row** — i.e. there is no committed state in which `audit_head` points at a `seq`/hash
  whose `audit_event` row is not itself committed (and vice-versa, no committed
  `audit_event` row beyond the head). The serialization of FR-2 (per-tenant) is what
  makes the (read-head → compute → insert row → advance head) step race-free.
- The head MUST be **externally anchorable**: its `(tenant_id, seq, row_hash)` is a small,
  copyable tuple that a periodic job MAY snapshot to versioned object storage (hypothesis
  §5: "head snapshot → versioned object storage"). Comparing a later live head against an
  anchored snapshot detects history rewrites that a same-transaction attacker might
  otherwise hide. (The snapshot *job* is T-0053; T-0016 only fixes that the head is
  shaped to be anchored.)

### FR-5  Stateless verifier and the seven defect classes

- A **stateless verifier** MUST be specifiable that, given a tenant's `audit_event` rows
  (as returned under that tenant's RLS context) ordered by `seq`, plus the genesis
  constants and `vocab_version`, recomputes the chain and **detects each of the following
  seven defect classes**. ("Stateless" = it needs no external state beyond the rows, the
  pinned constants, and — for the *anchor* cross-check — an anchored head snapshot.)

  | # | Defect class | Detection rule |
  |---|---|---|
  | 1 | **tamper** (a row's content was altered in place) | recomputed `H(canonical_preimage)` ≠ stored `row_hash` for that row |
  | 2 | **reorder** (rows resequenced) | `seq` not strictly +1 dense, OR `prev_hash[n] ≠ row_hash[n−1]` after sorting by `seq` |
  | 3 | **insert** (a forged row spliced in) | the inserted row breaks `prev_hash` linkage of the following row and/or duplicates/【shifts】`seq`; recomputed chain diverges from stored `row_hash` chain |
  | 4 | **delete** (a row removed) | `seq` gap (missing `n`): `seq[i+1] ≠ seq[i] + 1`, and `prev_hash[i+1] ≠ row_hash[i]` |
  | 5 | **gap** (non-dense sequence) | any `seq[i+1] − seq[i] ≠ 1` within a tenant (superset signal of delete/insert) |
  | 6 | **dup** (duplicate seq) | two rows with the same `(tenant_id, seq)` — structurally barred by `UNIQUE(tenant_id, seq)`; the verifier flags it if the constraint is ever absent |
  | 7 | **fork** (two valid-looking successors of the same row → branch) | two rows whose `prev_hash` equals the same `row_hash` (two children of one parent), or live head `row_hash` ≠ anchored-snapshot `row_hash` at the same `seq` |

- The verifier MUST also verify the **genesis**: the tenant's `seq = GENESIS_SEQ` row has
  `prev_hash = GENESIS_PREV_HASH`.
- The verifier runs **per tenant** (it operates on one tenant's rows under that tenant's
  RLS context); cross-tenant verification is N independent per-tenant runs.

### FR-6  Canonical serialization pinned to `vocab_version`

- The `canonical_preimage` (which fields, in which order, with which encoding — §4), the
  hash algorithm `H`, and the genesis constants (`GENESIS_SEQ`, `GENESIS_PREV_HASH`)
  together form the **chain vocabulary**, pinned by a `vocab_version` value carried on
  every row (`vocab_version smallint NOT NULL`, or stored once per chain segment — exact
  placement is T-0014-style object-model detail fixed in §4).
- Because the preimage is **load-bearing** (a verifier on a different serialization would
  compute different hashes and falsely report tamper), **any change to the preimage,
  `H`, field set/order, or encoding is a `vocab_version` bump and a chain-format
  migration** — never a silent edit. The verifier selects the preimage rules by the row's
  `vocab_version` so chains written under different versions remain verifiable.

### FR-7  Event payload carries the governance fields (E2.8 / hypothesis §5)

- `audit_event` MUST be able to express the hypothesis §5 `audit_event` fields as
  first-class, queryable columns: `type` (event type), `actor` (who performed it),
  `subject` (affected principal/object), `scope`, `via` (path/channel/tool), `proposed_by`
  (LLM, nullable), `confirmed_by` (human, nullable) — plus `occurred_at`. Grant-issuance
  events (E3.6) are ordinary rows here, queryable by `actor`/`subject`/`scope`, NOT a
  separate log.
- These payload fields are **part of the `canonical_preimage`** (§4) so they are covered
  by the hash chain — a silent edit of `actor` or `confirmed_by` is a *tamper* defect.

---

## 4. Object model and canonical preimage (the formalism `architect`/`coder` consume)

> Postgres types are authoritative; TS-side mirror (camelCase, `string` for `uuid`,
> `number` for `bigint` epoch-ms, `Buffer`/hex for `bytea`) follows the T-0014 convention.
> `audit_event` and `audit_head` inherit T-0013 §3.1 (tenant_id NOT NULL leading PK,
> FORCE RLS, default-DENY, `withTenant`) — that convention is NOT restated per-field; only
> audit-specific columns/constraints are pinned. Exact DDL/types are T-0053's to emit
> from this model.

### 4.1 `audit_event`

| Field | Type | Constraints / Notes |
|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL`, no default; **leading PK column**; RLS key (T-0013 §3.1) |
| `seq` | `bigint` | `NOT NULL`; per-tenant monotonic dense sequence; **`UNIQUE (tenant_id, seq)`**; PK is `(tenant_id, seq)` |
| `id` | `uuid` | `NOT NULL`; stable row identity (for references); `UNIQUE (tenant_id, id)` |
| `type` | `text` | `NOT NULL`; event type (e.g. `grant.create`, `grant.revoke`, `role.assign`, `approve`, `agent.invoke`) |
| `actor` | `text` | `NOT NULL`; subject who performed the event (user/agent/worker id) |
| `subject` | `text` | nullable; affected principal/object reference |
| `scope` | `jsonb` | nullable; scope of the event (org-scope set / resource ref) |
| `via` | `text` | nullable; path/channel/tool the event came through |
| `proposed_by` | `text` | nullable; LLM proposer identity (hypothesis §5) |
| `confirmed_by` | `text` | nullable; human confirmer identity (hypothesis §5) |
| `payload` | `jsonb` | `NOT NULL`; structured event detail (canonicalized in preimage) |
| `occurred_at` | `bigint` | `NOT NULL`; unix epoch ms |
| `prev_hash` | `bytea` | `NOT NULL`; `row_hash` of `(tenant_id, seq−1)`, or `GENESIS_PREV_HASH` at genesis (FR-3) |
| `row_hash` | `bytea` | `NOT NULL`; `= H(canonical_preimage)` (§4.3) |
| `vocab_version` | `smallint` | `NOT NULL`; pins preimage rules + `H` + genesis constants (FR-6) |

- **PK:** `(tenant_id, seq)` (dense per-tenant order is the primary access path).
- **No UPDATE/DELETE:** app role granted only `SELECT, INSERT` (FR-1a); rule/trigger bars
  `UPDATE`/`DELETE` (FR-1b).
- `id` exists so other tables (e.g. a confirmation flag) can reference an audit row by a
  stable UUID without depending on `seq` ordering.

### 4.2 `audit_head`

| Field | Type | Constraints / Notes |
|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL`; **PK `(tenant_id)`** — exactly one head row per tenant; RLS key |
| `seq` | `bigint` | `NOT NULL`; the latest committed `seq` for this tenant (`= GENESIS_SEQ − 1` before the first append, or the first append initializes it) |
| `row_hash` | `bytea` | `NOT NULL`; `row_hash` of the row at `(tenant_id, seq)` — the chain head |
| `updated_at` | `bigint` | `NOT NULL`; unix epoch ms of the last forward advance |
| `vocab_version` | `smallint` | `NOT NULL`; vocab of the head row |

- **Forward-only:** an append sets `seq := seq + 1`, `row_hash := H(...)` for the new row,
  in the **same transaction** as the `audit_event` INSERT (FR-4). The head's `seq` MUST
  never decrease.
- `UPDATE` on `audit_head` is restricted to the forward-advance path (the append
  transaction); the trigger/rule enforces `NEW.seq = OLD.seq + 1` and
  `NEW.prev = OLD.row_hash`-linkage (i.e. no head rewrite that skips or rewinds).

### 4.3 Canonical preimage (`canonical_preimage`) — the load-bearing serialization

The `canonical_preimage` for a row is a **deterministic byte string** built from a fixed
field set in a fixed order with a fixed encoding. It MUST be defined so that two correct
implementations (TS append path, verifier) produce **byte-identical** output for the same
logical row. The pinned definition (for `vocab_version = 1`) is:

1. **Field set & order** (exactly, in this order):
   `tenant_id`, `seq`, `id`, `type`, `actor`, `subject`, `scope`, `via`, `proposed_by`,
   `confirmed_by`, `payload`, `occurred_at`, `prev_hash`, `vocab_version`.
   (`row_hash` is the OUTPUT, never part of its own preimage.)
2. **Encoding** (each field, in order, length-prefixed to make the concatenation
   unambiguous — no field-boundary ambiguity / canonicalization-collision):
   - `uuid` → 16 raw bytes (canonical big-endian), prefixed by its byte length.
   - `bigint`/`smallint` → fixed-width big-endian (8 / 2 bytes), length-prefixed.
   - `text` → UTF-8 bytes, length-prefixed; `NULL` encoded as a distinct
     **null marker** (length-prefix sentinel) so `NULL` ≠ empty string.
   - `jsonb` (`scope`, `payload`) → **canonical JSON** (RFC 8785 / JCS: lexicographic key
     ordering, no insignificant whitespace, canonical number form), then UTF-8 bytes,
     length-prefixed. (JSON canonicalization is mandatory — raw `jsonb` text ordering is
     not stable across writes.)
   - `bytea` (`prev_hash`) → raw bytes, length-prefixed.
3. **Hash:** `row_hash = SHA-256(canonical_preimage)` (32 bytes). `GENESIS_PREV_HASH` =
   32 zero bytes; `GENESIS_SEQ` = `1`. All three constants are part of `vocab_version = 1`.
4. Any change to (1)–(3) ⇒ new `vocab_version` ⇒ chain-format migration (FR-6). The
   verifier dispatches on the row's `vocab_version` to pick the preimage rules.

> NOTE (analyst boundary): the **exact** wire details above (length-prefix width, the JCS
> profile, whether `vocab_version` is per-row or per-segment) are pinned here as the
> *target contract* the way T-0013 pinned `choros.tenant_id`. `architect` (DESIGN) MAY
> refine the byte-level encoding **provided** it preserves the invariants (deterministic,
> length-unambiguous, NULL-distinct, JSON-canonical, vocab-pinned) and re-pins them in the
> ADR as the single source of truth for `coder`. No invariant above is negotiable; only
> the encoding's concrete spelling is.

### 4.4 Append contract (pseudocode — implementation is `coder`'s zone, T-0053)

```ts
// The ONLY sanctioned way to write an audit row. Runs inside withTenant (T-0013 §4.1),
// so tenant context (choros.tenant_id GUC) is already set and RLS scopes every statement.
function appendAuditEvent(tx, e: AuditEventInput): { seq, rowHash } {
  // 1. Per-tenant serialization: lock THIS tenant's head row (FOR UPDATE) or per-tenant
  //    advisory lock — NOT a global lock.
  const head = tx.selectForUpdate("audit_head", { tenant_id: TENANT });   // one row
  const seq      = head ? head.seq + 1 : GENESIS_SEQ;                      // dense +1
  const prevHash = head ? head.row_hash : GENESIS_PREV_HASH;              // chain link
  // 2. Build canonical preimage (§4.3) over the fixed field set + prevHash + vocab.
  const preimage = canonicalPreimage({ ...e, tenant_id: TENANT, seq, prev_hash: prevHash,
                                       vocab_version: VOCAB });
  const rowHash  = sha256(preimage);
  // 3. Append (INSERT only) + advance head — SAME transaction (FR-4 atomicity).
  tx.insert("audit_event", { ...e, tenant_id: TENANT, seq, prev_hash: prevHash,
                             row_hash: rowHash, vocab_version: VOCAB });
  tx.upsertHead("audit_head", { tenant_id: TENANT, seq, row_hash: rowHash,
                                vocab_version: VOCAB });   // forward-only advance
  return { seq, rowHash };
}
// INVARIANTS: app role has SELECT,INSERT on audit_event (no UPDATE/DELETE); the
// no-mutate trigger bars UPDATE/DELETE for ALL roles; head advance is +1 forward-only.
```

### 4.5 Verifier contract (pseudocode — T-0053)

```ts
// Stateless per-tenant verifier (FR-5). Reads this tenant's rows under its RLS context.
// Optionally cross-checks the live head against an anchored snapshot (fork/rewrite).
function verifyAuditChain(rows: AuditEventRow[], anchoredHead?: HeadSnapshot): VerifyResult {
  // rows = SELECT * FROM audit_event ORDER BY seq  (RLS-scoped to this tenant)
  let prev = GENESIS_PREV_HASH, expectSeq = GENESIS_SEQ;
  for (const r of rows) {
    if (r.seq !== expectSeq)          return defect("gap|delete|insert", r.seq);     // 4,5,3
    if (r.prev_hash !== prev)         return defect("reorder|delete|insert", r.seq); // 2,4,3
    if (sha256(preimage(r, r.vocab_version)) !== r.row_hash)
                                       return defect("tamper", r.seq);                // 1
    prev = r.row_hash; expectSeq += 1;
  }
  // dup (6): structurally barred by UNIQUE(tenant_id,seq); flag if constraint absent.
  // fork (7): if anchoredHead present and live head row_hash != anchoredHead.row_hash
  //           at the same seq -> fork/rewrite.
  if (anchoredHead && headOf(rows).row_hash !== anchoredHead.row_hash)
                                       return defect("fork", anchoredHead.seq);       // 7
  return ok;
}
```

---

## 5. Non-Functional Requirements

### NF-1  Structural, not discipline-enforced

Append-only and chain integrity MUST be **structural properties of the schema** (privilege
revoke + no-mutate trigger + `UNIQUE(tenant_id,seq)` + NOT NULL hash columns), mirroring
T-0013 NF-2. Tampering MUST require a deliberate, CI-visible schema/privilege diff, never
a missing guard.

### NF-2  Per-tenant, zero cross-tenant contention

The append serialization, the chain, the sequence, and the head are **all per tenant**.
No global sequence, global lock, or global head may exist (it would couple tenants'
write throughput and is a defect). One tenant's audit activity MUST NOT block another's
(consistent with T-0013's per-tenant isolation and the §5 reservation/per-tenant
discipline).

### NF-3  One audit narrative (silo = pooled)

Because the floor is the same one table+head+chain in silo (N=1) and future pooled
(N>1), the 152-ФЗ/GDPR audit narrative is identical across modes — no "relaxed silo audit
path" (consistent with T-0013 NF-3).

### NF-4  Verifiability is cheap and offline

Chain verification MUST be performable by a stateless replay over a tenant's rows (plus
the pinned constants and an optional anchored head) — no online DB-internal trust, no
special privilege. A reviewer/auditor with read access to a tenant's audit rows can
independently confirm integrity.

### NF-5  Canonicalization stability

The `canonical_preimage` MUST be deterministic and stable across writes, reads, and
re-serialization (JSON canonicalization, length-prefixing, NULL-distinctness). An
unstable preimage would make the verifier report false tampers; this is a correctness NF,
not a nicety.

---

## 6. Out of Scope (deferred implementation + tier-gated gold-plating)

The following are explicitly NOT part of T-0016:

1. **SQL DDL / migrations / RLS policy bodies** for `audit_event` and `audit_head` —
   delivered by **T-0053** (Postgres-in-compose), alongside T-0013/T-0014's. T-0016
   defines the model + invariants; T-0053 implements them.
2. **The no-UPDATE/no-DELETE rule/trigger + privilege grants** (the DB-level append-only
   mechanism) — authored as the contract here (FR-1), **implemented** in T-0053.
3. **The append path (`appendAuditEvent`) + per-tenant serialization implementation** —
   contract here (§4.4); code in T-0053 + dependent build tasks.
4. **The verifier implementation** (`verifyAuditChain`) and its CI wiring as a live probe
   — contract + defect classes here (FR-5, §4.5); code activated in T-0053.
5. **The head-snapshot-to-versioned-object-storage job** — T-0016 fixes only that the
   head is shaped to be externally anchored (FR-4); the periodic snapshot job + object
   storage wiring are T-0053 / dependent infra tasks.
6. **External hash-anchoring** (anchoring head digests to an external/third-party ledger
   or timestamping authority) — tier-gated gold-plating, NOT day-1 (hypothesis §6-A #12;
   backlog E2.8 note).
7. **HSM custody / hardware key management** for the hash/signing material — tier-gated,
   NOT day-1 (§6-A #12).
8. **Signed audit bundles / signed policy bundles** (cryptographically signed export
   packages) — tier-gated, NOT day-1 (§6-A #12).
9. **Tenant isolation apparatus itself** (RLS, FORCE RLS, app role, `withTenant`,
   default-DENY) — owned by T-0013; T-0016 *consumes* it, does not redefine it.
10. **Which events get audited / the event taxonomy semantics** — `type` is an open
    string column here; the per-domain "what is a grant-issuance event, what fields"
    is E3.x's concern (E3.6 makes grant events first-class *rows* in THIS floor, but the
    grant model is T-0018/E3, not T-0016).
11. **152-ФЗ legal validation** — requires a lawyer, not an engineering guard
    (consistent with T-0013 §5).

---

## 7. Acceptance Criteria

All ACs are CI-checkable test or fitness-function assertions. **static-now** = runnable in
today's `npm run ci` (TS/lint/vitest + `ci/checks/*` lints; repo is zero-runtime-dep).
**live-T-0053** = live-DB probe authored now, wired into the `db-isolation` CI job when
Postgres exists. This mirrors the T-0013/T-0014 `gating` discipline.

---

### Append-only (FR-1)

**AC-1** — App role cannot UPDATE an audit row
```
live-T-0053: as choros_app with tenant context, INSERT one audit_event row, then
  UPDATE audit_event SET actor='x' WHERE seq=<that seq>;
MUST fail (privilege error OR trigger abort). Row content unchanged when re-read.
```
`verifiable_as: test`

**AC-2** — App role cannot DELETE an audit row
```
live-T-0053: as choros_app with tenant context, DELETE FROM audit_event WHERE seq=<n>;
MUST fail (privilege error OR trigger abort). Row still present.
```
`verifiable_as: test`

**AC-3** — UPDATE/DELETE barred even for a privileged role by the trigger/rule (defense in depth)
```
live-T-0053: as choros_migrator (table owner, may hold UPDATE/DELETE privilege),
  UPDATE audit_event SET actor='x' WHERE seq=<n>;  -- and DELETE …
Each MUST be rejected by the no-mutate rule/trigger. Demonstrates FR-1b survives a
privilege misconfiguration on the app role.
```
`verifiable_as: test`

**AC-4** — Append-only is structural: defeating it requires a CI-visible schema/privilege diff
```
static-now: ci/checks/audit_append_only.sh asserts (a) no migration grants UPDATE or
  DELETE on audit_event to choros_app, and (b) a no-mutate rule/trigger on audit_event
  exists in the migration SQL. CI fails if either the grant appears or the trigger is
  absent.
```
`verifiable_as: fitness`

---

### Per-tenant monotonic sequence (FR-2)

**AC-5** — `seq` is per-tenant dense and unique
```
live-T-0053: append K rows for tenant-A and M for tenant-B. Assert tenant-A's seq values
  are exactly GENESIS_SEQ..GENESIS_SEQ+K-1 (dense, no gap, no dup); same for tenant-B
  independently. UNIQUE(tenant_id,seq) rejects a manual duplicate-seq insert.
```
`verifiable_as: test`

**AC-6** — Append serialization is per-tenant, not global
```
live-T-0053 (concurrency): N concurrent appends within tenant-A yield N distinct dense
  seq values (no duplicate/skipped seq under contention). And: concurrent appends in
  tenant-A and tenant-B do not block each other on a shared/global lock (a global lock or
  global sequence object MUST NOT exist).
static-now: ci/checks/audit_no_global_seq.sh asserts no global SEQUENCE/global advisory
  lock is used for audit ordering (per-tenant head FOR UPDATE / per-tenant advisory key only).
```
`verifiable_as: test`

---

### Per-tenant hash chain (FR-3, FR-6, §4.3)

**AC-7** — Genesis: first row carries `GENESIS_PREV_HASH`
```
live-T-0053: the tenant's seq=GENESIS_SEQ row has prev_hash = GENESIS_PREV_HASH
  (32 zero bytes for vocab_version=1).
```
`verifiable_as: test`

**AC-8** — Chain linkage: each row's `prev_hash` equals the previous row's `row_hash`
```
live-T-0053: for every tenant-A row with seq=n>GENESIS_SEQ, prev_hash equals row_hash of
  the row at seq=n-1. Any mismatch is a failure.
```
`verifiable_as: test`

**AC-9** — `row_hash` equals `H(canonical_preimage)` recomputed independently
```
static-now (unit): src/.../auditPreimage.test.ts builds canonical_preimage for a fixture
  row per §4.3 and asserts sha256(preimage) equals a pinned expected digest; asserts the
  preimage is deterministic (same input → same bytes) and length-unambiguous (NULL ≠ empty,
  reordered jsonb keys → identical preimage via JCS).
live-T-0053: for each persisted row, recomputed sha256(preimage(row)) == stored row_hash.
```
`verifiable_as: fitness`

**AC-10** — Preimage/hash vocabulary is pinned to `vocab_version`; a change is a migration
```
static-now: ci/checks/audit_vocab_pinned.sh asserts (a) every audit_event row carries
  vocab_version, (b) the preimage builder dispatches on vocab_version, and (c) a snapshot
  test of the vocab=1 preimage rules (golden digest fixture) — changing field set/order/
  encoding/H flips the golden digest and fails CI, forcing an explicit vocab bump.
```
`verifiable_as: fitness`

---

### Verifier: the seven defect classes (FR-5)

**AC-11** — Verifier detects all seven defect classes
```
static-now (unit): src/.../auditVerify.test.ts feeds the stateless verifier seven crafted
  row-sets and asserts each is reported with the right class:
   (1) tamper  — one row's content altered, stored row_hash unchanged;
   (2) reorder — rows resequenced;
   (3) insert  — a forged row spliced in;
   (4) delete  — a row removed (seq gap + broken linkage);
   (5) gap     — non-dense seq;
   (6) dup     — duplicate (tenant_id,seq) when the constraint is hypothetically absent;
   (7) fork    — two rows sharing a prev_hash, OR live-head ≠ anchored-head at same seq.
A clean chain MUST verify ok.
```
`verifiable_as: test`

**AC-12** — Verifier is stateless and per-tenant
```
static-now (unit): the verifier takes only (rows, genesis constants, vocab, optional
  anchored head) — no DB/network/global state — and runs independently per tenant
  (tenant-A rows verify ok while tenant-B rows are tampered, and vice-versa).
```
`verifiable_as: test`

---

### Head snapshot (FR-4)

**AC-13** — Exactly one head row per tenant; head names the latest seq + hash
```
live-T-0053: audit_head has PK(tenant_id) (one row/tenant). After appending up to seq=n,
  audit_head.(seq,row_hash) for that tenant equals (n, row_hash of the seq=n row).
```
`verifiable_as: test`

**AC-14** — Head advances forward-only; backward/skip update is rejected
```
live-T-0053: an UPDATE that sets audit_head.seq to a value ≤ current, or that skips
  (new.seq ≠ old.seq+1), is rejected by the head-advance rule/trigger. Append advances
  head by exactly +1.
```
`verifiable_as: test`

**AC-15** — Append + head update are atomic; head never names a non-durable row
```
live-T-0053: after a ROLLBACK of an append transaction, neither the audit_event row nor
  the head advance is visible (both gone). After COMMIT, both are visible and consistent:
  there is no committed state where audit_head.seq points at a seq whose audit_event row
  is absent, nor a committed audit_event row beyond the head.
```
`verifiable_as: test`

**AC-16** — Head is externally anchorable and the anchor cross-check detects rewrite
```
static-now (unit): the head (tenant_id,seq,row_hash) is a copyable tuple; the verifier's
  fork/rewrite check (defect 7) flags when a later live head's row_hash differs from an
  anchored snapshot's row_hash at the same seq.
(The snapshot JOB to object storage is out of scope — §6.5 — this AC only fixes that the
 head shape + verifier support anchoring.)
```
`verifiable_as: fitness`

---

### Tenant-scoping inheritance (FR-1, NF-2, NF-3)

**AC-17** — `audit_event` and `audit_head` are FORCE-RLS default-DENY tenant tables in the fixture
```
static-now: ci/checks/known_tenant_tables.txt contains 'audit_event' and 'audit_head'
  (so both flow into every T-0013 RLS/isolation probe — FF-2/FF-3/FF-6/FF-7).
live-T-0053 (reuses T-0013 probes): no tenant context ⇒ count 0 on both; context=A ⇒
  SELECT … WHERE tenant_id=B returns 0; both have relrowsecurity AND relforcerowsecurity.
```
`verifiable_as: fitness`

**AC-18** — `tenant_id` is the leading column of every composite index/FK/PK on both tables
```
live-T-0053 (reuses T-0013 tenant_id_leading.sql): PK (tenant_id,seq) on audit_event,
  PK (tenant_id) on audit_head, and any composite index lead with tenant_id (column 1).
static-now: ci/checks lint over the migration DDL asserts the same on both tables.
```
`verifiable_as: fitness`

---

### Event payload coverage (FR-7)

**AC-19** — Governance fields are first-class queryable columns and are hash-covered
```
static-now (unit): the object-model fixture for audit_event includes columns type, actor,
  subject, scope, via, proposed_by, confirmed_by, payload, occurred_at; the preimage
  builder (§4.3) includes type/actor/subject/scope/via/proposed_by/confirmed_by/payload/
  occurred_at — so editing any of them changes row_hash (tamper-detectable). A unit test
  alters `confirmed_by` in a fixture and asserts the recomputed row_hash differs.
```
`verifiable_as: test`

**AC-20** — A grant-issuance event is an ordinary audit row, not a separate log (E3.6 seam)
```
static-now (unit): a grant.create / grant.revoke event maps onto audit_event columns
  (type='grant.create', actor, subject, scope, via, proposed_by, confirmed_by) with no
  audit_event schema change — confirming E3.6 grant events are rows in THIS floor.
```
`verifiable_as: fitness`

---

## 8. Open Items (non-blocking)

Tracked for implementer/`architect` awareness; none change product scope or require a
founder decision before DESIGN begins.

- **Exact byte-encoding of the preimage** (length-prefix width, the precise JCS profile,
  whether `vocab_version` is stored per-row or per-chain-segment): pinned in §4.3 as the
  target contract; `architect` MAY re-spell the encoding in the ADR provided every §4.3
  invariant (deterministic, length-unambiguous, NULL-distinct, JSON-canonical,
  vocab-pinned) is preserved and re-pinned as the single source of truth for `coder`
  (same latitude T-0013 took with the `choros.tenant_id` GUC spelling).
- **Per-tenant serialization primitive** (per-tenant advisory lock vs `audit_head … FOR
  UPDATE`): §4.4 fixes the *invariant* (per-tenant, race-free, +1 dense); the exact
  primitive is a T-0053 implementation choice, constrained only by NF-2 (no global lock).
- **`type` taxonomy:** `type` is an open `text` column here; the enumerated event
  vocabulary is each emitting domain's concern (E3.x for grants), not a T-0016 design
  ambiguity. New event types add rows, never schema.
- **Known-tenant-tables fixture:** AC-17 requires adding `audit_event` and `audit_head`
  to the T-0013 `known_tenant_tables` fixture — an implementation convention (every new
  tenant table appends to it), not a design ambiguity.
