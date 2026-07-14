# T-0019 · Typed actor-event ledger per object Spec

**Title:** E4.1 · Typed actor-event ledger per object (request/prepare/submit/approve_Ln/release) — the SoD source of truth
**Status:** ready (no blocking questions)
**Authored:** 2026-06-10
**Type:** schema + contract · **REAL migration** (Postgres is live: migrations 001–016 applied on dev a90f78d; T-0053 done). This task emits **migration 018** for `actor_event` + the read/write contract the SoD layer (T-0032) and the guarded-transition writer (T-0021/E4.2) consume. It does **not** implement the writer or the SoD queries.
**spec_ref:** `playbooks/rbac-backlog.md#E4.1` · hypothesis §5 (`actor_event`), §3 Q4, §6-A #4 (GT-1 signed 2026-06-08)
**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — `actor_event` is an ordinary RLS-scoped tenant table: `tenant_id` NOT NULL leading PK, ENABLE+FORCE RLS, default-DENY policy on the `choros.tenant_id` GUC, `choros_app` NOBYPASSRLS, all access via `withTenant`.
- `docs/design/T-0017-org-structure.adr.md` — `actor_event.actor` references `employee.id` (employee exists; FK is buildable today). `kind ∈ {human,agent}` is **deliberately not** discriminated by the ledger (FR-2): a human and an agent are equal actors for SoD.
- `migrations/006_audit_event.sql` (T-0016 audit floor) — append-only **hash-chained** governance audit. The actor-event ledger is **not** the audit floor; §2 fixes the boundary between the two.
- `migrations/009_object_handle.sql` (T-0015) — the opaque per-object pointer pattern (denormalized ResourceRef components, no FK to undesigned tables); `object_ref` follows it.

---

## 1. Summary

Choros records, **per object**, the typed sequence of governance-significant actor
actions taken against that object — `request`, `prepare`, `submit`, `approve` (at a
distinguishable level `Ln`), and `release` — into one append-only **`actor_event`**
ledger. Each row names **who acted** (`actor` = an `employee.id`), **on whose behalf**
(`on_behalf_of`, kept distinct from the performer), **in what role at the moment of the
event** (`role_at_event`), **against which object** (`object_ref`), and **when** (`ts`).

This ledger is the **single source of truth for Separation-of-Duties (SoD)**: SoD is not
a stored flag, it is a **query over this ledger** (T-0032/E4.2 — *"the same actor cannot
both `submit` and `approve` object X"*, *"roles A and B are statically incompatible on
object X"*). T-0019 builds the ledger and freezes the **read contract** that T-0032
consumes and the **write contract** that the guarded-transition path (T-0021 gateway +
E4.2 guarded class) uses to append. It does **not** implement SoD queries or the writer.

The two seams that this spec exists to make unambiguous:

1. **Ledger vs audit floor (T-0016).** Both are append-only tenant tables, but they are
   different ledgers with different jobs (§2). The audit floor is the *tamper-evident
   governance record* (hash-chained, who-granted-what); the actor-event ledger is the
   *typed SoD substrate* (per-object ordered verbs, no hash chain). A guarded transition
   typically writes **both**: one `actor_event` row (the SoD fact) and one `audit_event`
   row (the tamper-evident fact). T-0019 fixes that they are distinct rows in distinct
   tables and that neither subsumes the other.
2. **The verb vocabulary** — closed-but-vocab-versioned, with `approve` carrying a numeric
   level so `approve_L1 … approve_Ln` are distinguishable without an open string (§4.2).

---

## 2. Scope boundary — actor-event ledger vs audit floor (T-0016)

| | `actor_event` (T-0019) | `audit_event` (T-0016) |
|---|---|---|
| **Purpose** | typed **SoD substrate**: ordered actor-verbs per object | tamper-evident **governance audit**: who granted/revoked/approved what |
| **Grain** | one row per *actor action on an object* | one row per *governance-significant event* |
| **Keyed by** | `object_ref` (the object the verbs accumulate on) | `tenant_seq` (the per-tenant monotonic chain position) |
| **Verbs** | closed set `{request, prepare, submit, approve, release}` (§4.2) | open `type` string |
| **Integrity** | append-only (no UPDATE/DELETE); **no hash chain** | append-only **+ per-tenant hash chain + head snapshot** |
| **Primary reader** | SoD queries (T-0032/E4.2) + dynamic-SoD at action-time | auditor/verifier; grant-trail (E3.6) |
| **`on_behalf_of`** | first-class column (SoD must see delegation) | expressed via `proposed_by`/`confirmed_by`/`subject` |

- The actor-event ledger is **append-only** (same DB-level posture as T-0016: app role
  granted `SELECT, INSERT` only; a no-mutate trigger bars UPDATE/DELETE for all roles).
  It is **NOT hash-chained** — SoD reasons over *content and order by `ts`/`seq`*, it does
  not need tamper-evidence; tamper-evidence of the governance act is the audit floor's job.
  (Hash-chaining the actor-event ledger would be gold-plating that duplicates T-0016.)
- A guarded transition (E4.2) is expected to write **one `actor_event` row** (the SoD
  fact: *e-mironov submitted record R*) **and** **one `audit_event` row** (the audit fact:
  *approve event on R, actor e-mironov, confirmed_by …*). T-0019 does not couple the two
  writes into one mechanism (that is the writer's design, T-0021/E4.2); it only fixes that
  both exist and are distinct. The linkage point: an `actor_event` row carries a stable
  `id`, so an `audit_event` row MAY reference it by that UUID — but T-0019 mandates **no
  FK** between the two ledgers (each is independently append-only).

This task is **schema + contract** in the same mold as the merged T-0017: it emits the
`actor_event` migration (018) and the seed-free DDL, and freezes the read/write contracts.
It does **not** implement: the guarded-transition writer, the SoD query layer (T-0032),
the dynamic-SoD action-time check, or any API surface (§6 enumerates the deferral).

---

## 3. Functional Requirements

### FR-1  `actor_event` is an append-only, per-tenant tenant table

- `actor_event` is a T-0013 tenant table: `tenant_id uuid NOT NULL` is the **leading PK
  column**; `ENABLE` + `FORCE ROW LEVEL SECURITY`; one default-DENY policy keyed on the
  `choros.tenant_id` GUC; all runtime access via `withTenant`. It is added to
  `ci/checks/known_tenant_tables.txt` (**additive**, the only mutation to a shared file).
- After a row is committed it MUST be **immutable and undeletable at the DB layer**, by the
  **same two-mechanism posture as T-0016**: (a) `choros_app` is granted **`SELECT, INSERT`
  only** (no UPDATE/DELETE); (b) a no-mutate trigger raises on any UPDATE/DELETE for **all**
  roles (defence in depth). Defeating append-only MUST require a CI-visible schema/privilege
  diff, never a runtime query. *Rationale:* the SoD substrate must be as un-rewritable as
  the audit floor — a silently edited `submit` row would let an actor approve their own work.
- The ledger has **no hash chain and no head snapshot** (§2) — that distinguishes it from
  T-0016 and is a deliberate non-requirement, not an omission.

### FR-2  Actor identity: `actor`, `on_behalf_of`, `role_at_event` — performer ≠ principal

- `actor` (`= performed_by`) is the `employee.id` of **who physically performed** the event;
  it is **NOT NULL** and is FK-scoped to `employee(tenant_id, id)` (T-0017 makes this FK
  buildable today; FK includes `tenant_id` on both sides).
- `on_behalf_of` is the `employee.id` of **the principal the action is attributed to** when
  it differs from the performer (delegation / substitution — E4.7 `on_behalf_of ≠
  performed_by`). It is **nullable**: `NULL` means *performed on the actor's own behalf*
  (`on_behalf_of` effectively = `actor`). When present it is FK-scoped to `employee`.
  SoD MUST be able to reason over the **principal** (`COALESCE(on_behalf_of, actor)`) so a
  delegated approval is still attributed to the principal for the same-person SoD check.
- `actor.kind ∈ {human, agent}` is **deliberately NOT a discriminator** in the ledger: a
  human and an agent are **equal actors** for SoD. The ledger records *which employee*, and
  human/agent is resolvable by joining `employee` — it is *distinguishable but not
  privileged*. SoD constraints (T-0032) never branch on `kind`; an agent that `submit`s and
  then `approve`s is a SoD violation exactly as a human would be.
- `role_at_event` records **the role under which the actor acted at the moment of the
  event** (point-in-time, not the actor's current roles). It is **NOT NULL** and is a
  denormalized role reference (a `role_id` UUID), carrying **no FK** to `role` (the `role`
  table is undesigned — T-0022/E3.2 — and a baseline FK to a non-existent table would fail
  to apply, mirroring `grant.role_id` in `008_grant.sql`). The FK is deferred to T-0022's
  migration. `role_at_event` is load-bearing for **static SoD**: incompatible-role checks
  query the role *as it was when the actor acted*, not the role the actor holds today.

### FR-3  `object_ref`: the per-object anchor (the verbs accumulate per object)

- Each row carries an `object_ref` identifying **the object the actor acted on** — the
  anchor that makes the ledger *"per object"*: all verbs for one object share one
  `object_ref` and are read back as that object's ordered actor-trail.
- `object_ref` follows the **T-0015 opaque-pointer pattern** (`009_object_handle.sql`): it
  is a **denormalized ResourceRef** — `object_kind text NOT NULL CHECK (object_kind IN
  ('application','registry','record'))` plus the nullable component UUIDs
  (`application_id`, `registry_id`, `record_id`) — **not FK-enforced** (the same nullable,
  non-FK posture T-0015 fixed, because handles/records may be referenced before/without a
  hard FK and across the gateway). The set of component fields actually populated is
  determined by `object_kind` (a `record`-kind ref populates `record_id`; an
  `application`-kind ref populates `application_id`; etc. — same shape as `object_handle`).
- The ledger MUST be **queryable by object**: *"all actor-events for object X, ordered"* is
  the primary SoD access path, so `(tenant_id, object_kind, record_id|registry_id|
  application_id)` is the indexed read path (the exact index columns are the architect's to
  pin; the *invariant* is: object-scoped lookup is the primary path, not a full scan).
- T-0019 does **not** require `object_ref` to resolve through the gateway (that is the
  gateway's job for *payloads*; the ledger stores only the *reference*, never object
  values — FR-6). The ledger names objects; it does not embed their data.

### FR-4  Typed, ordered verb trail per object

- Each row carries one `event` from the **closed verb set** (§4.2) plus, for `approve`, a
  level. Together with `ts`/`seq` (FR-5) this yields, per `object_ref`, a **typed, ordered
  actor-event trail**: e.g. for record R — `request`(e-orlov) → `prepare`(a-invoice) →
  `submit`(e-mironov) → `approve@L1`(e-larina) → `approve@L2`(e-cfo) → `release`(e-mironov).
- The trail is **append-only and order-stable**: order is established by a per-tenant
  monotonic `seq` (FR-5), with `ts` as the wall-clock attribute. Two events on the same
  object never collide on order. The trail is the substrate SoD queries fold over.

### FR-5  Ordering: per-tenant monotonic `seq` + `ts`

- Every row carries `ts bigint NOT NULL` (unix epoch ms — the wall-clock time of the event)
  and `seq bigint NOT NULL`, a **per-tenant monotonic** ordinal (`UNIQUE (tenant_id, seq)`,
  scoped never global) that gives a **total order independent of clock skew**. SoD order
  reasoning ("submit *before* approve") MUST rely on `seq`, not on `ts` (wall clocks can
  tie or skew).
- `seq` is assigned under a **per-tenant** serialization (per-tenant advisory lock or a
  per-tenant counter row — exact primitive is the architect's choice), **never a global
  sequence/lock** (a global lock would couple tenants' write throughput — same NF as
  T-0016's per-tenant chain). `seq` need not be *dense* here (unlike T-0016, no chain
  requires +1 density) — strictly-increasing-per-tenant is sufficient for total order; the
  architect MAY choose dense or sparse. The **invariant** is: per-tenant, strictly
  increasing, no global serialization point.

### FR-6  The ledger stores references and identities, never object payloads

- `actor_event` MUST NOT carry a record/object **payload** (no `data`/`snapshot`/`view`
  column) — it stores the `object_ref` (a pointer) and the actor/role identities, never the
  object's field values. This mirrors `object_handle` (T-0015 FF-1/FF-8: "names fields,
  never values") and keeps the gateway (T-0021) the sole place object *values* are resolved.
- A small structured `detail jsonb NULL` MAY carry verb-specific metadata (e.g. an approval
  comment reference, a transition `from→to` state id) **provided it contains no object field
  values** — it is metadata about the *event*, not a copy of the *object*.

### FR-7  Write contract (the guarded-transition writer's seam — frozen, not implemented)

- The **only** sanctioned writer is the **guarded-transition / gateway path** (T-0021 PDP +
  E4.2 guarded-transition class). An `actor_event` row is appended **at action-time** when a
  guarded transition fires — never speculatively at task-creation (TOCTOU posture: the SoD
  fact is recorded when the act happens). T-0019 freezes this as a contract; the writer is
  T-0021/E4.2's to build.
- The write contract (the shape a writer MUST satisfy) is fixed in §4.3 `appendActorEvent`:
  inside `withTenant`, append exactly one row with `actor` = the acting employee,
  `on_behalf_of` = the principal (or NULL), `role_at_event` = the role the gateway resolved
  the actor under, `object_ref` = the object acted on, `event`(+level), `ts`, and a
  per-tenant `seq`. The contract is **append-only** (INSERT; no read-modify-write of prior
  rows).
- T-0019 does **not** mandate that *every* object mutation writes an actor-event — only that
  **guarded transitions** (the E4.2 guarded class: request/prepare/submit/approve/release)
  do. Ordinary CRUD writes are not actor-events. *(Which transitions are "guarded" is E4.2's
  taxonomy, not T-0019's — T-0019 fixes the ledger shape, E4.2 fixes what fills it.)*

### FR-8  Read contract (the SoD layer's seam — frozen, not implemented)

- The ledger MUST support, under a tenant's RLS context, the read shapes T-0032/E4.2
  consume (frozen in §4.4):
  - **per-object trail:** all rows for one `object_ref`, ordered by `seq`.
  - **actor-on-object:** *did principal P (`COALESCE(on_behalf_of, actor)`) ever perform
    event E on object X?* — the substrate for **dynamic SoD** (e.g. *the submitter cannot be
    an approver of the same object*).
  - **role-pair-on-object:** *was object X acted on by role A and role B?* — the substrate
    for **static SoD** (incompatible roles), reading `role_at_event`.
- These are **read shapes**, not the SoD constraints themselves: `sod_constraint`
  evaluation, the static/dynamic decision, and the action-time block are **T-0032/E4.2**.
  T-0019 guarantees the columns and ordering exist to express them; it implements none.

---

## 4. Object model and contracts (the formalism `architect`/`coder` consume)

> Postgres types are authoritative; the TS-side mirror (camelCase, `string` for `uuid`,
> `number` for `bigint` epoch-ms) follows the T-0014/T-0017 convention. `actor_event`
> inherits T-0013 §3.1 (tenant_id NOT NULL leading PK, FORCE RLS, default-DENY,
> `withTenant`) verbatim — that convention is NOT restated per-field; only actor-event
> specific columns/constraints are pinned. The migration emits this model as **018**.

### 4.1 `actor_event`

| Field | Type | Constraints / Notes |
|---|---|---|
| `tenant_id` | `uuid` | `NOT NULL`, no default; **leading PK column**; RLS key (T-0013) |
| `seq` | `bigint` | `NOT NULL`; per-tenant strictly-increasing ordinal; **`UNIQUE (tenant_id, seq)`**; PK is `(tenant_id, seq)` |
| `id` | `uuid` | `NOT NULL`; stable row identity; `UNIQUE (tenant_id, id)` (so an audit row MAY reference it; no FK) |
| `object_kind` | `text` | `NOT NULL`; `CHECK (object_kind IN ('application','registry','record'))` (mirrors `object_handle.ref_kind`) |
| `application_id` | `uuid` | nullable; ResourceRef component, **not FK** (T-0015 pattern) |
| `registry_id` | `uuid` | nullable; ResourceRef component, **not FK** |
| `record_id` | `uuid` | nullable; ResourceRef component, **not FK** |
| `actor` | `uuid` | `NOT NULL`; **= performed_by**; FK `(tenant_id, actor) → employee(tenant_id, id)` |
| `on_behalf_of` | `uuid` | nullable; principal when ≠ performer; FK `(tenant_id, on_behalf_of) → employee(tenant_id, id)`; `NULL` ⇒ acted on own behalf |
| `role_at_event` | `uuid` | `NOT NULL`; point-in-time `role_id`; **no FK** (deferred to T-0022, mirrors `grant.role_id`) |
| `event` | `text` | `NOT NULL`; `CHECK (event IN ('request','prepare','submit','approve','release'))` (closed set, §4.2) |
| `approve_level` | `smallint` | nullable; the `Ln` of `approve` (≥1); **`CHECK ((event='approve') = (approve_level IS NOT NULL))`** — non-null **iff** `event='approve'` |
| `detail` | `jsonb` | nullable; verb metadata, **no object field values** (FR-6) |
| `ts` | `bigint` | `NOT NULL`; unix epoch ms (wall clock of the event) |
| `vocab_version` | `smallint` | `NOT NULL`; pins the verb set + level semantics (§4.2) |

- **PK:** `(tenant_id, seq)` (per-tenant order is the primary chronological access path).
- **Object read path:** an index leading with `tenant_id` then the object components
  (e.g. `(tenant_id, object_kind, record_id)`) so *all events for object X* is index-served.
- **No UPDATE/DELETE:** app role granted `SELECT, INSERT` only; no-mutate trigger bars
  UPDATE/DELETE for all roles (FR-1).
- **`actor`/`on_behalf_of` are `uuid` FKs to `employee`** (buildable today); `role_at_event`
  is a `uuid` with the FK deferred.

### 4.2 The verb vocabulary — closed, level-typed, vocab-versioned

- The verb set is **closed**: `{request, prepare, submit, approve, release}` (the GT-1-signed
  set, hypothesis §3 Q4 / §5). It is a `CHECK` constraint, **not** an open string. New verbs
  are **not** added by writing a new string at runtime — adding/removing a verb is a
  **`vocab_version` bump + migration** (deliberate, CI-visible), the same "extensible only by
  explicit version migration" posture T-0016 took for its preimage vocabulary.
- `approve_Ln` is modelled as **`event='approve'` + `approve_level smallint ≥ 1`**, not as N
  distinct verb strings. This keeps the verb set finite while making approval **levels
  distinguishable and orderable** (L1 < L2 < … — multi-step approval chains). The `CHECK`
  ties `approve_level` non-null **iff** `event='approve'`.
- `vocab_version` pins (the verb set, the level semantics) on every row so a future verb-set
  migration leaves old rows interpretable. **Why closed-not-open:** SoD queries (T-0032)
  reason over a known finite verb alphabet; an open verb string would let an un-reviewed verb
  silently escape SoD coverage. The closed set is the safe default and is what GT-1 signed;
  extension is possible but gated behind a version migration, never a runtime free string.

### 4.3 Write contract (`appendActorEvent`) — pseudocode; implementation is T-0021/E4.2

```ts
// The ONLY sanctioned way to append an actor-event. Runs inside withTenant (T-0013),
// called by the guarded-transition / gateway path at ACTION-TIME (FR-7). Append-only.
function appendActorEvent(tx, e: ActorEventInput): { seq, id } {
  // 1. Per-tenant serialization for the ordinal (per-tenant advisory lock or counter row;
  //    NOT a global sequence/lock — NF-2).
  const seq = nextPerTenantSeq(tx, TENANT);           // strictly increasing, per tenant
  // 2. Append (INSERT only). actor = performer; on_behalf_of = principal or NULL;
  //    role_at_event = the role the gateway resolved the actor under (point-in-time);
  //    object_ref = the object acted on; event(+approve_level); ts; vocab.
  const id = uuidv7();
  tx.insert("actor_event", {
    tenant_id: TENANT, seq, id,
    object_kind: e.objectKind, application_id: e.applicationId,
    registry_id: e.registryId, record_id: e.recordId,
    actor: e.actor, on_behalf_of: e.onBehalfOf ?? null,
    role_at_event: e.roleAtEvent,
    event: e.event,
    approve_level: e.event === "approve" ? e.approveLevel : null,
    detail: e.detail ?? null, ts: now(), vocab_version: VOCAB,
  });
  return { seq, id };
}
// INVARIANTS: app role has SELECT,INSERT only (no UPDATE/DELETE); no-mutate trigger bars
// UPDATE/DELETE for all roles; never a read-modify-write of prior rows (append-only).
```

### 4.4 Read contract (SoD substrate) — pseudocode; consumed by T-0032/E4.2

```ts
// All READ shapes run under the actor's tenant RLS context (withTenant). T-0019 guarantees
// these are expressible; the SoD CONSTRAINTS over them are T-0032/E4.2, not here.

// (a) per-object ordered trail
selectOrderedBySeq("actor_event", whereObject(ref));   // ORDER BY seq

// (b) dynamic-SoD substrate: did principal P perform event E on object X?
//     principal = COALESCE(on_behalf_of, actor) so delegated acts attribute to the principal.
existsActorEvent(whereObject(ref), { event: E,
  principal: P /* matches on COALESCE(on_behalf_of, actor) = P */ });

// (c) static-SoD substrate: which roles acted on object X? (reads role_at_event)
selectDistinct("role_at_event", whereObject(ref), { events: [...] });
```

> NOTE (analyst boundary): the **exact** index column list, the per-tenant `seq` primitive
> (advisory lock vs counter row), whether `seq` is dense or sparse, and the `uuid` generator
> (`uuidv7` vs `gen_random_uuid`) are pinned here only as the *target contract*. `architect`
> (DESIGN) MAY re-spell them in the ADR **provided** every invariant above is preserved
> (append-only; performer≠principal with the COALESCE rule; closed vocab-versioned verb set;
> per-tenant non-global order; references-not-values; FK to `employee`, no-FK to `role`) and
> re-pinned as the single source of truth for `coder`.

---

## 5. Non-Functional Requirements

### NF-1  Tenant isolation by the repo invariants (FORCE RLS, leading tenant_id, additive fixture)

`actor_event` is an ordinary T-0013 tenant table: `tenant_id` NOT NULL leading PK; ENABLE +
FORCE RLS; default-DENY policy on `choros.tenant_id`; `choros_app` NOBYPASSRLS; every FK
(`actor`, `on_behalf_of` → `employee`) tenant-scoped on both sides; `ci/checks/
known_tenant_tables.txt` gains `actor_event` (**additive** — the only shared-file mutation,
per the run seam). It introduces **no new tenant-isolation code-path**; it consumes T-0013's.

### NF-2  Append-only + per-tenant ordering, structural not discipline

Append-only (privilege revoke + no-mutate trigger) and per-tenant ordering (no global
sequence/lock) are **structural schema properties**, mirroring T-0016 NF-1/NF-2. Rewriting a
`submit`/`approve` row — which would let an actor evade SoD — MUST require a CI-visible
schema/privilege diff, never a forgotten guard. One tenant's actor-event writes MUST NOT
block another's.

### NF-3  Human/agent equality

The ledger MUST NOT privilege or branch on `actor.kind`. SoD treats a human and an agent as
equal actors (FR-2). `kind` is *resolvable* (join `employee`) but never a column of, or a
discriminator in, `actor_event` itself.

### NF-4  References, not values (gateway stays the sole value-resolver)

`actor_event` MUST hold **no object payload** (FR-6). The gateway (T-0021) remains the only
place object field *values* are resolved; the ledger names objects and identities only. A
`detail jsonb` is event-metadata, not an object copy.

### NF-5  Migration ordering (run seam, frozen)

The migration is **018** (`018_actor_event.sql`); **017 is reserved for the parallel T-0033**
and MUST NOT be used. The runner sorts lexicographically by the `NNN` prefix
(`migrations/run.mjs`), so 018 applies after 016 (employee) — the `employee` FK target
exists. `known_tenant_tables.txt` is appended **additively** (orchestrator merges parallel
additions).

---

## 6. Out of Scope (deferred + downstream consumers)

Explicitly NOT part of T-0019:

1. **SoD constraint evaluation** — `sod_constraint(kind ∈ {static,dynamic}, role_a,
   role_b|self_record, scope)`, the static/dynamic decision, and the **action-time SoD
   block** are **T-0032/E4.2**. T-0019 builds only the *substrate* they query.
2. **The guarded-transition writer / guarded-transition class** — *which* transitions are
   guarded and the code that appends actor-events at action-time are **T-0021 (gateway) +
   E4.2**. T-0019 freezes the *write contract* (§4.3), implements no writer.
3. **The `role` / `assignment` tables** — `role_at_event` is a forward `role_id` with the FK
   **deferred to T-0022/E3.2** (mirrors `grant.role_id`).
4. **Substitution / absence mechanics** (E4.7) — T-0019 only guarantees `on_behalf_of ≠
   performed_by` is *expressible*; the routing-stand-in / TTL'd-grant mechanics are E4.7.
5. **Hash-chaining / head-snapshot / tamper-evidence** — that is the **audit floor (T-0016)**;
   the actor-event ledger is intentionally un-chained (§2). A guarded transition writes both
   an `actor_event` row and an `audit_event` row, but coupling them is the writer's job.
6. **Any HTTP/API surface** for reading/writing actor-events — no `/api/...` endpoint is in
   scope; the contracts are internal (§4.3/§4.4).
7. **The object-ref → gateway resolution** — the ledger stores the *reference*; resolving it
   to object *values* is the gateway's job (T-0021), not T-0019's.
8. **Verb-set extension beyond the GT-1 set** — the closed set is final for day-1; any future
   verb is a `vocab_version` migration (§4.2), a deliberate later change, not in T-0019 scope.

---

## 7. Acceptance Criteria

All ACs are CI-checkable test or fitness assertions. **static-now** = runnable in today's
`npm run ci` (TS/lint/vitest + `ci/checks/*` lints; repo is zero-runtime-dep). **live-DB** =
a live-Postgres probe wired into the `db-isolation` / migration CI job (Postgres exists on
this base — T-0053 done, migrations applied). This mirrors the T-0016/T-0017 gating shape.

### Tenant isolation (NF-1)

**AC-1** — `actor_event` is a FORCE-RLS default-DENY tenant table; it is in the fixture
`static-now`: `ci/checks/known_tenant_tables.txt` contains `actor_event` (so it flows into
every T-0013 RLS/isolation probe). `live-DB`: `pg_class.relrowsecurity=true AND
relforcerowsecurity=true`; `choros_app` with **no** tenant GUC → `SELECT count = 0`.
`verifiable_as: fitness`

**AC-2** — Cross-tenant isolation holds
`live-DB`: seed `actor_event` rows for tenant-A and tenant-B (via migrator); in tenant-A
context, `SELECT … WHERE tenant_id = <B>` returns 0 rows; the shared `cross_tenant` probe
that iterates `KNOWN_TENANT_TABLES` passes for `actor_event`.
`verifiable_as: test`

**AC-3** — `tenant_id` is the leading column of the PK and every composite index/FK
`live-DB` (reuses T-0013 `tenant_id_leading.sql`): PK is `(tenant_id, seq)`; the object-read
index and both employee FKs lead with `tenant_id`. `static-now`: a `ci/checks` lint over
`018_actor_event.sql` asserts the same.
`verifiable_as: fitness`

### Append-only (FR-1, NF-2)

**AC-4** — App role cannot UPDATE an actor-event row
`live-DB`: as `choros_app` with tenant context, INSERT one row, then `UPDATE actor_event SET
event='approve' WHERE seq=<n>` MUST fail (privilege error OR trigger abort); row unchanged on
re-read.
`verifiable_as: test`

**AC-5** — App role cannot DELETE an actor-event row
`live-DB`: as `choros_app`, `DELETE FROM actor_event WHERE seq=<n>` MUST fail; row still
present.
`verifiable_as: test`

**AC-6** — UPDATE/DELETE barred even for a privileged role by the no-mutate trigger
`live-DB`: as `choros_migrator` (table owner), `UPDATE`/`DELETE` on `actor_event` are each
rejected by the trigger (defence in depth — append-only survives an app-role privilege
misconfiguration).
`verifiable_as: test`

**AC-7** — Append-only is structural (CI-visible diff required to defeat it)
`static-now`: a `ci/checks/actor_event_append_only.sh` asserts (a) no migration grants
`UPDATE`/`DELETE` on `actor_event` to `choros_app`, and (b) a no-mutate trigger on
`actor_event` exists in the migration SQL. CI fails if either the grant appears or the
trigger is absent.
`verifiable_as: fitness`

### Per-tenant ordering (FR-5, NF-2)

**AC-8** — `seq` is per-tenant strictly increasing and unique
`live-DB`: append K rows for tenant-A and M for tenant-B; tenant-A's `seq` values are
strictly increasing with no duplicate; `UNIQUE (tenant_id, seq)` rejects a manual
duplicate-seq insert; tenant-A and tenant-B order independently.
`verifiable_as: test`

**AC-9** — Ordering uses no global sequence/lock
`static-now`: `ci/checks/actor_event_no_global_seq.sh` asserts the ordinal uses a per-tenant
primitive (per-tenant advisory lock or per-tenant counter row), not a global `SEQUENCE` or
global advisory lock. `live-DB` (concurrency): N concurrent appends in tenant-A yield N
distinct `seq` values; concurrent appends in A and B do not block on a shared lock.
`verifiable_as: test`

### Actor identity: performer ≠ principal (FR-2)

**AC-10** — `actor` is NOT NULL and FK-scoped to `employee`
`live-DB`: INSERT with `actor` = a non-existent `employee.id` (same tenant) is rejected by
the FK; INSERT with `actor = NULL` is rejected by NOT NULL; INSERT with a valid `employee.id`
succeeds.
`verifiable_as: test`

**AC-11** — `on_behalf_of` is nullable, FK-scoped, and distinct from `actor`
`live-DB`: a row with `on_behalf_of = NULL` is valid (acted on own behalf); a row with
`on_behalf_of` = a different valid `employee.id` is valid and `on_behalf_of ≠ actor` is
preserved on read; `on_behalf_of` = a non-existent employee is rejected by the FK.
`verifiable_as: test`

**AC-12** — Principal SoD attribution uses `COALESCE(on_behalf_of, actor)`
`static-now` (unit): the frozen read-contract helper for "did principal P do event E on X"
matches on `COALESCE(on_behalf_of, actor) = P` — a delegated approval (`actor=X,
on_behalf_of=P`) is attributed to P, and a self-act (`on_behalf_of=NULL`) is attributed to
`actor`. Fixture rows assert both.
`verifiable_as: test`

**AC-13** — Human and agent are equal actors (no `kind` discrimination)
`static-now` (fitness): a lint over `018_actor_event.sql` asserts `actor_event` has **no**
`kind` column and the table does not branch on `employee.kind`; a unit fixture shows an
agent `employee.id` and a human `employee.id` are stored and read identically (same code
path, no kind-conditional).
`verifiable_as: fitness`

**AC-14** — `role_at_event` is NOT NULL, point-in-time, no role FK
`live-DB`: `role_at_event = NULL` is rejected by NOT NULL; a `role_at_event` UUID that does
not exist in any (future) `role` table is **accepted** (no FK — the role table is undesigned,
mirroring `grant.role_id`). `static-now`: a lint asserts `018_actor_event.sql` declares no FK
from `role_at_event` to `role`.
`verifiable_as: test`

### Object anchor (FR-3, FR-6)

**AC-15** — `object_ref` is a denormalized, non-FK ResourceRef with a `CHECK`ed kind
`live-DB`: `object_kind='robot'` (any value ∉ {application,registry,record}) is rejected by
the CHECK; a `record`-kind row populating `record_id` is accepted; the component id columns
have **no** FK (a `record_id` not present in `record` is accepted — opaque-pointer posture).
`verifiable_as: test`

**AC-16** — Per-object trail is index-served, ordered, and complete
`live-DB`: append a `request→prepare→submit→approve@L1→approve@L2→release` sequence for one
`object_ref`; reading all rows for that `object_ref` ordered by `seq` returns exactly those 6
events in that order; the read uses the object index (EXPLAIN shows index scan, not seq
scan), and events for a *different* object are absent.
`verifiable_as: test`

**AC-17** — The ledger stores no object payload
`static-now` (fitness): a lint over `018_actor_event.sql` asserts `actor_event` has no
`data`/`snapshot`/`view`/`payload` column; the only `jsonb` is `detail` (event metadata).
A unit fixture asserts `detail` carries no record field values in the contract examples.
`verifiable_as: fitness`

### Verb vocabulary (FR-4, §4.2)

**AC-18** — The verb set is closed and CHECK-enforced
`live-DB`: INSERT with `event='escalate'` (any verb ∉ {request,prepare,submit,approve,
release}) is rejected by the CHECK; each of the five valid verbs is accepted.
`verifiable_as: test`

**AC-19** — `approve_Ln` is level-typed: `approve_level` non-null **iff** `event='approve'`
`live-DB`: `event='approve'` with `approve_level=NULL` is rejected; `event='submit'` with
`approve_level=2` is rejected; `event='approve', approve_level=1` and `event='approve',
approve_level=2` are both accepted and distinguishable on read (L1 < L2 orderable).
`verifiable_as: test`

**AC-20** — Verb vocabulary is pinned to `vocab_version`; extension is a migration
`static-now` (fitness): every `actor_event` row carries `vocab_version NOT NULL`; a
`ci/checks/actor_event_vocab_pinned.sh` (or unit golden) asserts the day-1 verb set is
`{request,prepare,submit,approve,release}` and that changing the set requires editing the
CHECK + bumping `vocab_version` (a golden test of the verb set fails CI if the set changes
without a vocab bump), forcing an explicit, reviewed extension.
`verifiable_as: fitness`

### Ledger ≠ audit floor boundary (§2)

**AC-21** — `actor_event` is a separate ledger from `audit_event` (no chain, no FK coupling)
`static-now` (fitness): a lint asserts `actor_event` has **no** `prev_hash`/`row_hash`/
`vocab`-chain columns and no `audit_head`-style head table, and that there is **no FK**
between `actor_event` and `audit_event` (each independently append-only). The two tables
co-exist; neither subsumes the other.
`verifiable_as: fitness`

**AC-22** — A guarded transition can produce both an actor-event and an audit-event row
`static-now` (unit): the frozen write-contract fixture shows one guarded `submit` mapping to
**one** `actor_event` row (the SoD fact) and being *referable* by an `audit_event` row (via
the `actor_event.id` UUID) **without** an enforced FK — confirming §2's "both rows, distinct
tables, optional reference" boundary. (The actual coupling is the writer's, T-0021/E4.2 —
this AC only fixes that the shapes permit it.)
`verifiable_as: fitness`

---

## 8. Open Items (non-blocking)

Tracked for `architect`/implementer awareness; none change product scope or require a founder
decision before DESIGN.

- **Per-tenant `seq` primitive** (per-tenant advisory lock vs per-tenant counter row) and
  **dense vs sparse** `seq`: §4.1/FR-5 fix only the *invariant* (per-tenant, strictly
  increasing, no global serialization); the primitive is a DESIGN choice constrained by NF-2.
- **Object-read index column list** (`(tenant_id, object_kind, record_id)` vs a broader
  covering index): FR-3 fixes that object-scoped lookup is the primary path; the exact index
  is the architect's to pin.
- **`uuid` generator for `id`** (`uuidv7` time-ordered vs `gen_random_uuid`): §4.3 suggests a
  time-ordered id to make `id` order roughly track `seq`; not load-bearing (order is `seq`).
- **`detail jsonb` schema**: open `jsonb` here (no object values — FR-6); per-verb metadata
  schema is each emitting domain's concern (E4.2), not a T-0019 ambiguity. New metadata adds
  keys, never columns.
- **`role_at_event` FK activation**: AC-14 keeps it FK-less today; T-0022's migration adds the
  `(tenant_id, role_at_event) → role(tenant_id, id)` FK (the same deferral `grant.role_id`
  took). An implementation convention, not a design ambiguity.
- **Known-tenant-tables fixture**: AC-1 requires appending `actor_event` to
  `known_tenant_tables.txt` (additive, every new tenant table appends) — convention, not a
  design ambiguity.
