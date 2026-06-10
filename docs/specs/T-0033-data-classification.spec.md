# T-0033 — Data-classification + value-aware masking + typed facets + from→to guards

> **Phase:** SPEC (analyst). **Epic:** E4.3. **Stage:** day-1.
> **spec_ref:** `playbooks/rbac-backlog.md#E4.3`.
> **Authority:** GT-1-signed model `rbac-discovery-phase1-hypothesis.md` (§3 Q10, §5,
> §6-A #6; signed 2026-06-08). Nothing here introduces a new product decision; it is
> mechanical decomposition of the signed map. Status of this spec = **ready** (no
> BLOCKING founder questions; the open seams are *contract-blocking on sibling tasks*,
> not founder-blocking — recorded in §7).
> **Deps (done, in-worktree):** E2.5 grant_resolver/PDP (T-0021), E2.3 grant authority +
> closed lattice (T-0018), E2.2 registry_def (T-0014), E2.4 object_handle (T-0015),
> E2.8 audit floor (T-0016), E2.7 engine mutation guard (T-0028).

---

## 1. What we build (one screen)

The gateway today (T-0021 `grant-resolver.ts`) projects record fields with an
**all-or-nothing, fail-closed facet**: a covering grant's `resourceFacet.fields`
(or whole-resource if absent) decides which field *names* survive; masked fields
are physically absent. That is the floor. T-0033 raises it to the **signed §6-A #6
model**:

1. **Data-classification table** — `data_classification(resource_type, facet, class)`:
   a per-tenant, declarative mapping that assigns each object-model field (facet
   member) a **classification** along the signed axes. This is the table E4.5
   `role_criticality` (`sensitive_read`) and E4.8 `egress_policy(class, ...)` both
   read; it is built here once.
2. **Typed facets** — a facet stops being an opaque `unknown` narrowing token and
   becomes a **typed, schema-versioned descriptor** bound to a `registry_def`
   record-schema version. The gateway honors the facet *schema version*: a grant /
   handle carrying facet schema vN is resolved against the classification rows for
   vN, and a version mismatch is fail-closed, not silently widened.
3. **Value-aware masking** — masking is no longer only "field present / absent".
   The class + the reader's grant select a **value transform** (e.g. whole-redact,
   partial/last-4, hash/tokenize, pass-through). A reader with a lesser grant on a
   classified field sees a *masked value*, not the raw value and not a dropped key,
   when the class so dictates. (The exact transform vocabulary is `architect`/`coder`
   zone; SPEC fixes only that it is value-aware and grant-driven — see §4 AC-5/AC-6.)
4. **from→to transition guards** — a field's classification is **mutable**, and the
   mutation is a **guarded first-class transition** (`approve`/`transition` op-class,
   T-0018), not an ordinary write. A `from→to` guard governs *who* may reclassify and
   *how* (e.g. down-classification — making data *more* visible — is more privileged
   than up-classification). The transition emits a T-0016 audit obligation.

**Day-1 line:** schema (the `data_classification` table + typed-facet descriptor +
classification-transition guard) **and** the gateway masking mechanic. **Not day-1:**
any UI for managing classifications, and the *runtime* egress gate at agent call-time
(E5.10, Stage-2). The masking mechanic itself is day-1 because it is the read-path the
whole §6-A #6 thesis rests on — human form and agent payload must mask **identically**
(the T-0021 single-projection invariant extends to value-masking).

---

## 2. Where it lands (integration surface — for `architect`, not designed here)

- **`data_classification` migration** — next migration (`013_data_classification.sql`),
  same tenant-table contract as `008_grant.sql` / `004_registry_def.sql`: `tenant_id`
  leading, RLS `ENABLE`+`FORCE`, tenant-isolation policy, `choros_app` DML grant,
  listed in `ci/checks/known_tenant_tables.txt`. Columns at minimum:
  `(tenant_id, resource_type, facet_field, class, facet_schema_version, ...)`.
- **Gateway** — the masking + class-lookup extends the **existing** projection path in
  `src/core/grant-resolver.ts` (`grantFacetFields` / `visibleFields` / `projectFields`).
  It MUST remain a **single projection function** (T-0021 AC-5 / `ci/checks/single-resolver.sh`
  invariant): value-masking is folded into that one function, **not** a second
  handle→fields edge. Classification is read through an **injected port** (the
  static-now / `pg`-free discipline of `grant-resolver-isolation.sh` is preserved; the
  Postgres-backed port lands with T-0053, like `GrantSource`/`RecordSource`).
- **Typed facet descriptor** — a typed shape replaces/extends the `Facet =
  {fields: string[]}` of T-0015 and the `Grant.resourceFacet?: unknown` of T-0018.
  Whether this is an additive new type or an edit to the frozen modules is an
  `architect` call; SPEC requires only that the resolver-isolation "frozen modules
  unmodified" check is satisfied by whatever boundary `architect` chooses (additive
  preferred).
- **Transition guard** — classification mutation routes through the same op-class the
  mutation guard (T-0028) already polices: a reclassification is a `transition`/`approve`
  op resolved via `resolveFor(deps, handle, subject, op)`, never a raw record write.
- **Audit** — both a masking *decision that suppressed a value* and a *reclassification*
  emit a T-0016 audit-obligation shape (`via=grant_resolver` / `via=classification`);
  durable append is deferred to T-0053, consistent with T-0021 FR-8.

---

## 3. Requirements

### 3.1 Functional

- **FR-1** A per-tenant `data_classification(resource_type, facet_field, class,
  facet_schema_version)` table exists; a field of a registry record-schema can be
  assigned a class; the table is queryable by `(resource_type, facet_field,
  facet_schema_version)`.
- **FR-2** Field visibility at the gateway depends on **(field class × reader's grant)**:
  the same record yields different surviving fields for two subjects whose grants differ
  on a classified field.
- **FR-3** Masking is **value-aware**: for at least one class, a lesser-granted reader
  receives a **transformed value** (masked, e.g. redacted/partial/hashed) rather than
  the raw value or a dropped key. The transform is selected by class + grant, not
  hard-coded per field name.
- **FR-4** **Typed facets**: a facet is a typed descriptor carrying its
  `facet_schema_version`; the gateway resolves classification rows for the *matching*
  version. A facet whose schema version has no classification rows (or mismatches the
  record's registry version) is **fail-closed** (treated as maximally-masked), never
  silently widened to whole-resource.
- **FR-5** Classification is **mutable via a guarded `from→to` transition**: changing a
  field's class is a `transition`/`approve` op-class action routed through the gateway
  (`resolveFor`), not an ordinary record write; an unguarded direct mutation path does
  not exist.
- **FR-6** The `from→to` guard distinguishes **direction**: a down-classification
  (widening visibility) requires at least the authority of an up-classification, and the
  two cases are distinguishable in the guard decision (the floor for E4.6 dual-control).
- **FR-7** Single-projection preserved: human-form and agent-payload read paths produce
  **byte-identical masked output** for the same (grant-set, record, classification,
  now) — value-masking goes through the one `projectFields`/projection function, with no
  second handle→fields export.
- **FR-8** Rights-derived-only preserved: the masking decision derives solely from
  T-0018 grant rows + the `data_classification` table; **no parallel field-ACL /
  field-visibility store** is introduced (the `grant-resolver-isolation.sh` token ban
  holds).
- **FR-9** A masking decision that suppresses/transforms a classified value, and a
  reclassification transition, each MAY emit a T-0016 audit-obligation shape
  (`via=grant_resolver`/`via=classification`); durable append deferred to T-0053.
- **FR-10 (contract seam, not implemented here)** The `class` value space is the
  **shared axis** that E4.8 `egress_policy(class, allowed_endpoint)` (T-0041) and E4.5
  `role_criticality(...sensitive_read)` (T-0040) consume. T-0033 defines `class` as a
  first-class, stable, enumerable value; it does **not** implement egress or criticality.

### 3.2 Non-functional

- **NF-1** Gateway masking core stays **pure / static-now**: classification read through
  an injected port; no `pg`/`fs`/`net`/`http` import in `grant-resolver.ts`
  (`grant-resolver-isolation.sh` Check 1 stays green). DB-backed port → T-0053.
- **NF-2** **Additive** to the frozen authority core where possible: the
  resolver-isolation "frozen modules unmodified" check is satisfied; lattice math stays
  in T-0018 (no second authority subsystem).
- **NF-3** **Fail-closed by construction**: absent classification rows, an unknown
  class, or a facet-schema-version mismatch all resolve to *more* masking, never less.
  Doubt resolves to zero visibility (red-lines "rule at doubt").
- **NF-4** **Tenant-isolated**: `data_classification` carries `tenant_id` leading + RLS
  (`force_rls.sql` / `tenant_id_leading.sql` / `cross-tenant-fitness.sh` cover it);
  cross-tenant classification read is impossible.
- **NF-5** **Determinism**: same (grants, record, classification rows, now) ⇒ deeply-equal
  masked output (extends T-0021 NF-1 purity to the masking path).

### 3.3 Out of scope (explicit non-goals)

- UI / admin screens for managing classifications or facet schemas (not day-1).
- The **runtime** BYO-LLM egress gate at agent call-time — `egress_policy` *enforcement*
  is E5.10 / Stage-2; only the shared `class` axis is contracted here (FR-10).
- E4.8 `egress_policy` **table** itself (T-0041) — separate task; T-0033 only fixes that
  `class` is the join key.
- E4.5 `role_criticality` computation (T-0040) — consumes this table; not built here.
- E4.4 external-effect resources (T-0034) — parallel E4 task; the gateway facet/masking
  **interface points** are declared as seams (§7), not implemented.
- The Postgres-backed classification DAO + RLS DAO wiring → T-0053 (same deferral as
  T-0021's `GrantSource`/`RecordSource`).
- Encryption / tokenization key management for hash/tokenize transforms — the masking
  *transform contract* is in scope; cryptographic custody is not (gold-plating per §6-A #12).

---

## 4. Acceptance criteria (machine-checkable)

> Verifiable as `fitness` (`fitness:db` for schema/SQL invariants; pure-TS fitness for
> the gateway masking core), `test` (TS unit), or `manual` (DB-permission invariants that
> activate with T-0053).

- **AC-1** *(fitness:db)* A `013_data_classification` migration applies; the table is a
  tenant table — `ci/checks/db/tenant_id_leading.sql` and `force_rls.sql` pass with the
  new table present, and it appears in `known_tenant_tables.txt`.
- **AC-2** *(fitness:db)* Cross-tenant isolation: a classification row written under
  tenant A is invisible to a session bound to tenant B (`cross-tenant-fitness.sh` /
  two-tenant DB test red without RLS, green with it).
- **AC-3** *(fitness)* Class-driven divergence: given a record with a classified field
  and two subjects whose grants differ on that field, the gateway returns the field
  (raw or masked) for the higher-granted subject and masks/omits it for the lower — same
  record, same `now`, divergent output keyed only by grant × class.
- **AC-4** *(fitness)* Fail-closed on missing/mismatched classification: a classified
  facet whose `facet_schema_version` has no matching `data_classification` rows yields
  **maximal masking** (no widening to whole-resource); the field does not leak raw.
- **AC-5** *(fitness)* Value-aware: for a class whose transform is non-dropping, a
  lesser-granted reader receives a **transformed value** (deeply-different from raw,
  e.g. redacted/partial), not the raw value and not silently absent — proving masking is
  value-level, not only key-presence.
- **AC-6** *(fitness)* The transform is selected by **(class, grant)**, not field name:
  two differently-named fields sharing a class + reader-grant get the *same* transform;
  one field re-classified to a different class gets a *different* transform.
- **AC-7** *(fitness)* Human==agent masking equivalence: the human-form call-site and the
  agent-payload call-site produce **deep-equal** masked output for the same (grant-set,
  record, classification, now); exactly one projection function is invoked
  (`single-resolver.sh` stays green; no second handle→fields export).
- **AC-8** *(fitness)* Rights-derived-only: masking decision computed solely from T-0018
  grant rows + `data_classification`; `grant-resolver-isolation.sh` Check 2
  (no `_acl`/`field_visibility`/`record_rights` token) stays green and a sibling
  `data-classification-isolation.sh` asserts no parallel field-ACL store in the new code.
- **AC-9** *(fitness)* Purity/isolation preserved: the classification-aware gateway code
  imports no `pg`/`fs`/`net`/`http` (classification via injected port);
  `grant-resolver-isolation.sh` Check 1 + Check 3 (frozen modules unmodified) stay green.
- **AC-10** *(fitness)* Guarded reclassification: changing a field's class routes through
  `resolveFor(.., op∈{transition,approve})` and is rejected for a subject lacking that
  op-grant; there is **no** direct-write path to `data_classification.class` that
  bypasses the gateway op-check (structural — analogous to `mutation-gateway-isolation.sh`).
- **AC-11** *(fitness)* Direction-aware guard: a **down-classification** (widening
  visibility) is rejected for a subject who is permitted only **up-classification**; the
  guard decision exposes the `from→to` direction so E4.6 can key dual-control on it.
- **AC-12** *(test)* Typed facet honors schema version: a facet descriptor carrying
  version vN resolves against vN classification rows; bumping the registry record-schema
  version without classification rows for the new version fails closed (AC-4 at the
  version boundary).
- **AC-13** *(fitness)* Determinism: two invocations with deeply-equal (grants, record,
  classification, now) return deeply-equal masked output (no IO outside injected ports).
- **AC-14** *(fitness)* Shared-axis contract: the `class` value is a stable enumerable
  type referenced by name; a fitness assertion proves the same `class` symbol is the join
  column shape E4.8/E4.5 will read (a typed contract test that does not implement either).
- **AC-15** *(manual, activates with T-0053)* DB-permission floor: the Postgres
  classification DAO is reachable only via the gateway path — no direct `choros_app`
  read of a *raw* classified field value that bypasses masking (enforced by role-grants +
  RLS once the DB port lands; same deferral as T-0021 AC-14).
- **AC-16** *(fitness)* Audit obligation shape: a value-suppressing masking decision and a
  reclassification each produce a well-formed T-0016 audit-obligation object
  (`via` set, actor/subject present); durable append asserted under T-0053 (matches
  T-0021 FR-8 deferral).

---

## 5. Contract for downstream phases

- **DESIGN (`architect`)** owns: the typed-facet descriptor shape + where it lives
  (additive vs. frozen-module edit), the masking **transform vocabulary** (the closed set
  of class→transform mappings) and how a grant selects within it, the `data_classification`
  column set + indexes, the injected classification **port** signature (mirroring
  `GrantSource`), and the `from→to` guard's direction model. The single-projection and
  rights-derived-only invariants are **non-negotiable design constraints**, not design
  choices.
- **CODE (`coder`)** delivers: the migration, the gateway masking extension (one
  projection function), the injected classification port (in-memory static-now), the
  reclassification transition guard, and the new fitness checks
  (`data-classification-isolation.sh` + the `fitness:db` SQL/tests) realizing §4.

---

## 6. BLOCKING (founder, GT-1)

**None.** The signed map (§3 Q10, §5, §6-A #6) fully fixes the *what*: value-aware
masking + typed facets + data-classification + `from→to` guards + schema-versioned
facets, all day-1. The day-1÷Stage-2 line is signed (D-B/D-C). The open items below are
**sibling-task contract seams**, not product-direction questions — they do not gate
GT-1; they are recorded so DESIGN aligns the interfaces.

## 7. Contract seams (sibling tasks — declare, do not implement)

- **S-1 (T-0041 / E4.8 egress_policy).** `data_classification.class` is the **shared axis**
  `egress_policy(class, allowed_endpoint)` joins on. T-0033 defines `class` as a stable,
  enumerable, named value (AC-14). T-0041 implements the egress table + its day-1 schema;
  T-0033 must not pre-bake an egress column into `data_classification`.
- **S-2 (T-0034 / E4.4 external-effect resources).** T-0034 is a parallel E4 task touching
  the same gateway. The masking/typed-facet path and the effect-resource verification path
  share the gateway module; T-0033 declares its **interface points** (the projection
  function and the injected-port pattern) so T-0034 stacks additively without a second
  resolver edge. No effect-resource logic is implemented here.
- **S-3 (T-0040 / E4.5 role_criticality).** Consumes `data_classification` to derive the
  `sensitive_read` criticality bit. T-0033 owns the table; T-0040 owns the computation.
- **S-4 (T-0053 Postgres).** The Postgres-backed classification port + RLS DAO + the
  DB-permission "no raw classified read bypasses masking" floor (AC-15) land with T-0053,
  exactly as `GrantSource`/`RecordSource` did for T-0021.
