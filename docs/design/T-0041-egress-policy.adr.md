# ADR · T-0041 — BYO-LLM Data-Egress Policy Axis (`egress_policy`)

**Status:** ready · **Phase:** DESIGN · **Date:** 2026-06-11
**Spec:** `docs/specs/T-0041-egress-policy.spec.md` (commit d98ae75) · 16 AC
**Scope:** one new dormant tenant table. Thin ADR by design — proportionate to a
schema-only, runtime-dormant axis with no new TypeScript runtime module.

---

## 1. Decision

Add **`egress_policy`** — a per-tenant declarative allowlist expressing which
`DataClass` values MAY egress to which client-hosted LLM endpoint pattern — as a
single new tenant-isolated table in **migration 038**. The table is:

- **deny-by-default** — absence of a row for `(class, allowed_endpoint)` ⇒ egress
  NOT permitted; no catch-all row is ever seeded;
- **schema-dormant day-1** — no Choros runtime (`src/**/*.ts`) reads it; the
  call-time enforcement gate is **Stage-2 / T-0045** (parked), mirroring
  `agent_card`'s dormancy (T-0020);
- **joined on `DataClass`** — `class` is the closed axis imported from
  `src/core/data-classification.ts` (T-0033, S-2); the table does NOT redeclare
  `DataClass` and adds NO egress column to `data_classification`.

T-0041 ships **no new TS runtime module**. The only TS artifact is a compile-time
type-contract fixture (`src/__tests__/egress-policy.type-check.ts`) that pins
`egress_policy.class ↔ DataClass` under `tsc --noEmit` (AC-16).

This mirrors the established `data_classification` (017) tenant-table contract
exactly: `tenant_id`-leading PK, ENABLE+FORCE RLS, the standard
`current_setting('choros.tenant_id', true)::uuid` isolation policy, `choros_app`
DML-only grant, and an entry in `ci/checks/known_tenant_tables.txt` so the
existing cross-tenant CI suite iterates the new table without a test-source edit.

---

## 2. Object model — full DDL (the single field contract)

The ADR IS the field/type contract. `migrations/038_egress_policy.sql`:

```sql
CREATE TABLE IF NOT EXISTS choros.egress_policy (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL,
  class            text NOT NULL,    -- DataClass; CHECK enumerates the closed set
  allowed_endpoint text NOT NULL,    -- client-hosted LLM endpoint pattern (base URL); NO FK, NOT a secret handle
  description      text,             -- nullable rationale (informational)
  created_at       bigint NOT NULL,  -- epoch-ms
  updated_at       bigint NOT NULL,  -- epoch-ms
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT egress_policy_class_chk
    CHECK (class IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT egress_policy_class_endpoint_uniq
    UNIQUE (tenant_id, class, allowed_endpoint)
);

ALTER TABLE choros.egress_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.egress_policy FORCE ROW LEVEL SECURITY;

-- tenant-isolation policy (idempotent via pg_policies guard) —
CREATE POLICY egress_policy_tenant_isolation ON choros.egress_policy
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.egress_policy TO choros_app;
```

| Column | Type | Null | Notes |
|---|---|---|---|
| `tenant_id` | `uuid` | NO | leading PK component; tenant scope |
| `id` | `uuid` | NO | row identity; PK component |
| `class` | `text` | NO | a `DataClass`; CHECK over the closed set |
| `allowed_endpoint` | `text` | NO | endpoint pattern (text), NOT a secret handle |
| `description` | `text` | YES | optional rationale |
| `created_at` | `bigint` | NO | epoch-ms |
| `updated_at` | `bigint` | NO | epoch-ms |

- **PK** `(tenant_id, id)` · **UNIQUE** `(tenant_id, class, allowed_endpoint)`.
- **No cross-table FK** — `class` is a logical axis value (not a row id);
  `allowed_endpoint` is a policy-level text identifier. Mirrors
  `data_classification`'s deferred-FK discipline (T-0017 lesson: an impossible FK
  fails to apply = BUILD bounce).

---

## 3. Public surface (importers as contract)

T-0041 introduces no new TS export. The single public symbol it CONSUMES is the
existing `DataClass` from `src/core/data-classification.ts` (byte-unchanged, NF-6):

- **Importer (T-0041):** `src/__tests__/egress-policy.type-check.ts` imports
  `type { DataClass }` and asserts `egress_policy.class` is exactly that closed
  set (AC-16). This is the only TS edge T-0041 adds, and it is a test-only,
  compile-time edge — it does NOT make the table runtime-live.
- **Downstream contract consumer (NOT in scope):** **T-0045** (Stage-2 runtime
  egress gate) will query `egress_policy(tenant_id, class, allowed_endpoint)` at
  the agent-call egress boundary; **T-0033** provides the `DataClass` join axis;
  `agent_card.llm_endpoint` (T-0020/T-0025) is the runtime source of the endpoint
  value T-0045 looks up. T-0041 freezes the table shape these consume.

---

## 4. Runtime target

- **Storage:** Postgres, schema `choros`, single-substrate (the ratified Choros
  stack). Applied by the zero-dep runner `migrations/run.mjs` under the
  `choros_migrator` role; queried (Stage-2) under `choros_app` (NOBYPASSRLS).
- **Runtime read day-1:** NONE. Dormant table (AC-11 / NF-7).
- **Live-DDL:** the design session has no DB reachable (no `DATABASE_URL`), so
  DDL application is a **CI obligation** — the migration runs in CI's db job, and
  the cross-tenant suite (`fitness:db`) + `egress-policy-isolation.sh` (in
  `npm run fitness`) + `tsc --noEmit` (in `npm run ci`) prove the ACs there.

---

## 5. Migration / file seam (rule 9)

- Adds ONLY `migrations/038_egress_policy.sql` (039 reserve, unused — empty table
  needs no seed file). No file numbered 032–037 or 040+ is added.
- **Idempotency (NF-3 / AC-10):** primary mechanism is the runner's
  `schema_migrations` version-skip (a recorded version is never re-executed);
  the DDL additionally uses `CREATE TABLE IF NOT EXISTS` + a `pg_policies` guard
  around `CREATE POLICY` as a belt-and-braces second line.
- **Frozen (byte-unchanged, NF-6):** `data-classification.ts`, `grant-lattice.ts`,
  `grant-resolver.ts`, `object-handle.ts`, and all pre-existing migrations.
  `tsc --noEmit` passes.
- **Additive edits (allowed, not frozen):** `ci/checks/known_tenant_tables.txt`
  (+`egress_policy`), `ci/checks/db/cross_tenant.test.ts` (+ a seed function and
  dispatcher case — the test iterates `KNOWN_TENANT_TABLES`, so the new table
  needs a seed path), and `package.json` `fitness` script (+ the new check).

---

## 6. Fitness functions

See the ADR contract `fitness_functions` array — FF-EP1..FF-EP7 (static, in
`ci/checks/egress-policy-isolation.sh`) plus the runtime cross-tenant ACs proven
by `ci/checks/db/cross_tenant.test.ts` (`fitness:db`) and the `tsc --noEmit`
type-contract gate. Every one of the 16 AC traces to a check (see `traceability`).

---

## 7. Rejected alternatives

1. **Add an `egress` column to `data_classification`** — rejected: T-0033 ADR
   §3.3 / S-1 explicitly excludes it. Egress is a SEPARATE axis (class×endpoint),
   not a property of a field's classification; conflating them couples two axes
   and breaks the signed seam.
2. **Reference the endpoint by a secret-handle FK** — rejected: BYO-LLM secret
   custody is T-0025 (out of scope). The endpoint is a policy-level text
   identifier, not a credential; an FK would create a phantom dependency and
   leak custody concerns into a policy table.
3. **Per-field `(field, endpoint)` granularity** — rejected: the founder-signed
   axis is `(class, endpoint)`. Field→class is already derivable via T-0033;
   per-field rows would duplicate the classification axis.
4. **Ship a runtime reader / enforcement now** — rejected: enforcement at
   agent-call time is the Stage-2 cut (E5.10 / T-0045), parked by the founder.
   Day-1 is schema + policy expressibility only; a runtime reader would violate
   the dormancy invariant (AC-11).
5. **A new `src/core/egress-policy.ts` module** — rejected: nothing reads the
   table day-1, so a module would be dead code. The only TS need (the
   class↔DataClass contract) is met by a compile-time test fixture.
