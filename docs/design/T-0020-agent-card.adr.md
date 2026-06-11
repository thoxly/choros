# ADR · T-0020 — Agent Card Schema (dormant)

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-11
**Task:** E5.1 — `agent_card` table keyed to `employee(kind='agent')`; day-1 schema, runtime-dormant.
**Spec:** `docs/specs/T-0020-agent-card.spec.md` (status: ready, AC-1..AC-17)
**Foundation (do NOT contradict):**
- `docs/design/T-0013-tenant-isolation.adr.md` — tenant_id leading PK, ENABLE+FORCE RLS, default-DENY, `choros_app` NOBYPASSRLS, `SET LOCAL choros.tenant_id` contract.
- `docs/design/T-0017-org-structure.adr.md` + `migrations/016_employee.sql` — `employee(tenant_id, id)` PK, `kind IN ('human','agent')` CHECK, 5 agent rows seeded (a-recon, a-invoice, a-triage, s-ledger, s-ocr), plus genesis e-owner (human) from migration 026.
- `docs/design/T-0054-keycloak-compose.adr.md` §3.5 — agent service-account `clientId = agent-<tail>`; linkage anchor.
- `migrations/017_data_classification.sql` — "impossible FK = BUILD bounce" discipline (deferred-FK pattern).
**Siblings (NOT built here):** T-0042 (provisioning write-path), T-0024 (invoke-grant read), T-0025 (secret-handle custody), T-0043 (mcp_tool), T-0023 (budget; owns migrations 034-035), T-0123 (competence/prompt layer — additive columns later).

---

## 1. Decision

**Adopt `agent_card` as a separate tenant-isolated, FORCE-RLS table (migration 032), one row per `employee(kind='agent')`, schema-only and runtime-dormant on day-1.** Enforce the "card only for agents" invariant with a DB-native **composite FK into a redundant discriminator key** (no trigger). Defer the `budget_policy_id` and `escalation_rule_id` FKs (their target tables do not exist yet). Seed the 5 dev-silo agents idempotently inside migration 032.

### 1.1 Separate table, not columns on `employee`

`agent_card` is its own table (spec §0 Option B): the card exists only for `kind='agent'` rows, keeps 9 agent-only columns off every human row, and lets T-0123 (competence layer) / Stage-2 add columns by additive `ALTER TABLE ADD COLUMN` without touching `employee`. This matches the backlog's own `agent_card(employee_id, …)` signature and the D-C entity model.

### 1.2 FR-2 enforcement — card only for `kind='agent'` (the one real design choice)

A plain composite FK `(tenant_id, employee_id) → employee(tenant_id, id)` cannot constrain on `kind`. Chosen mechanism — **composite FK into a redundant discriminator key**:

1. Migration 032 adds `UNIQUE (tenant_id, id, kind)` on `choros.employee` (additive: a superset of the existing `(tenant_id, id)` PK; zero data change; idempotent because the migration is recorded once).
2. `agent_card` carries `employee_kind text NOT NULL DEFAULT 'agent'`, pinned by `CHECK (employee_kind = 'agent')`.
3. `agent_card` FK `(tenant_id, employee_id, employee_kind) → employee(tenant_id, id, kind)`.

Net effect: a card row can only reference an employee whose `kind='agent'`; pointing at a `kind='human'` row violates the FK (PG `23503`). No trigger, no procedural code — pure declarative DDL. **Live-verified** (§6): a card for `e-kravtsova` (human) → `23503`; a card for a fresh agent → succeeds.

> Rejected: a trigger that looks up `employee.kind` on INSERT/UPDATE. Procedural, slower, a second enforcement surface vs. the declarative FK. Rejected: store nothing and trust T-0042 — leaves the invariant unenforced at the schema layer, contradicting FR-2 ("rejected at the DB layer").

### 1.3 Deferred FKs (FR-8, FR-9)

`instance_budget` (T-0023) is **not applied** in the live DB (verified: no `instance_budget` migration). Per the 017 "impossible FK = BUILD bounce" lesson, migration 032 declares `budget_policy_id uuid NULL` with **NO FK**; T-0023 (or a follow-up) adds the FK additively once `instance_budget` exists. `escalation_rule_id uuid NULL` has **NO FK** at all (no target table exists). Both are documented seams, not escalations.

### 1.4 Dormancy (FR-6)

No day-1 runtime code path reads `agent_card`. The table is writable only by the future provisioning path (T-0042). `autonomy_threshold`, `budget_policy_id`, `llm_secret_handle` are stored, never enforced day-1. Enforced by FF-AC-6 (`grep` in `src/`).

### 1.5 No prompt/instruction column (product-audit 2026-06-11 seam)

The agent prompt/instruction (competence layer) is **out of scope** and owned by T-0123. The table is intentionally narrow so T-0123 adds its columns by additive migration. This ADR introduces no `instruction`/`prompt`/`system_prompt` column.

### 1.6 Three frozen-test seam breaks owned by coder (BUILD phase)

Adding a tenant table touches three existing CI assertions. These are **known BUILD-phase fixes, not design changes or escalations** (same discipline as T-0017 §1.5):

| File | Current | After T-0020 | Coder fix |
|---|---|---|---|
| `ci/checks/db/grant-editor.test.ts` ~L105 | `expect(lines.length).toBe(21)` ("no new tenant table from T-0030") | 22 entries | update `toBe(21)` → `toBe(22)` |
| `ci/checks/db/cross_tenant.test.ts` `seedRowForTable` | no `case 'agent_card'` → throws `unknown table agent_card` | needs a case | add a **self-sufficient** `case 'agent_card'` (§4.4) |
| `ci/checks/known_tenant_tables.txt` | 21 lines | `agent_card` added (line 1) | done in this ADR's deliverable; coder verifies |

`ci/checks/db/two_tenant.test.ts` needs **no** change — its migration-count assertion is dynamic (`>= filesOnDisk`), auto-adapting to 32 files.

---

## 2. Rejected alternatives

| Option | Why not |
|---|---|
| Columns on `employee` (no separate table) | 9 agent-only nullable columns on every human row; muddier intent; T-0123/Stage-2 additions pollute the org-core table. Backlog names a table. |
| Trigger to enforce `kind='agent'` | Procedural second enforcement surface; the composite-FK-into-redundant-key idiom enforces it declaratively with no code. |
| Plain FK `(tenant_id, employee_id) → employee(tenant_id, id)` only | Cannot restrict `kind`; would admit cards for humans, violating FR-2. |
| Declare `budget_policy_id` FK to `instance_budget` now | `instance_budget` does not exist yet (T-0023 unlanded) → migration fails to apply = BUILD bounce (017 lesson). FK deferred. |
| Declare `escalation_rule_id` FK now | No escalation-rule table exists at all. Impossible FK. Column nullable, no FK. |
| Add `prompt`/`instruction` column | Competence layer is T-0123's scope (product-audit seam). Keep table narrow + extensible. |
| Separate seed script (not in migration) | Violates T-0053 one-bring-up-path principle (NF-4). Seed stays in migration 032 behind `ON CONFLICT DO NOTHING`. |
| Reuse the human `empIdA/B` in the cross_tenant seed case | That employee is `kind='human'` (seedEmployeeRow L177) → FK reject. The agent_card case must seed its own agent employee inline. |

---

## 3. Object model

### 3.1 `agent_card` table (new — migration 032)

| Field | Type | Null | Constraints / meaning |
|---|---|---|---|
| `tenant_id` | `uuid` | No | Leading PK component; part of every FK (T-0013). |
| `employee_id` | `uuid` | No | Agent employee. Part of PK and of the FK to `employee`. |
| `employee_kind` | `text` | No | `DEFAULT 'agent'`; `CHECK (employee_kind = 'agent')`; FK discriminator (FR-2). |
| `kc_client_id` | `text` | No | Keycloak service-account `clientId` (e.g. `agent-recon`). UNIQUE per tenant. Frozen linkage seam (FR-7). |
| `llm_endpoint` | `text` | Yes | BYO-LLM base URL. NULL = not configured (dormant). |
| `llm_model` | `text` | Yes | Model id. NULL = not configured (dormant). |
| `llm_secret_handle` | `text` | Yes | RL-3 **opaque handle**, never a raw key (NF-3; T-0025 owns lifecycle). NULL = not bound. No length cap below 512 (AC-15). |
| `autonomy_threshold` | `numeric(5,4)` | Yes | `CHECK (… IS NULL OR (… >= 0 AND … <= 1))` (NF-4). NULL = dormant. |
| `budget_policy_id` | `uuid` | Yes | FK → `instance_budget` **deferred to T-0023** (FR-9). No FK in 032. |
| `escalation_rule_id` | `uuid` | Yes | **No FK** — target table absent (FR-8). |
| `created_at` | `bigint` | No | epoch-ms. |
| `updated_at` | `bigint` | No | epoch-ms. |

- **PK:** `(tenant_id, employee_id)` — one card per agent employee.
- **UNIQUE:** `(tenant_id, kc_client_id)` — one KC client per card per tenant (AC-10).
- **FK:** `(tenant_id, employee_id, employee_kind) → employee(tenant_id, id, kind)` (FR-2 / AC-5/AC-6).
- **CHECK:** `agent_card_employee_kind_chk` (`employee_kind='agent'`); `agent_card_autonomy_threshold_chk` ([0,1] or NULL).
- **RLS:** ENABLE+FORCE; policy `USING/WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid)`.
- **GRANT:** `SELECT, INSERT, UPDATE, DELETE` to `choros_app`; no DDL.

### 3.2 `employee` table — additive change (migration 032)

`ADD CONSTRAINT employee_tenant_id_id_kind_key UNIQUE (tenant_id, id, kind)` — makes `(tenant_id, id, kind)` FK-targetable for FR-2. Superset of the existing PK; no row mutation; idempotent. DDL-only; no public-API/symbol/importer surface affected. No other employee field changes. No new TypeScript module (NF-6).

### 3.3 Dev seed (migration 032, idempotent)

5 agent cards in the dev silo (`DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001`):

| employee_id suffix | slug | kc_client_id | LLM / autonomy |
|---|---|---|---|
| `…0002` | a-recon | `agent-recon` | NULL |
| `…0003` | a-invoice | `agent-invoice` | NULL |
| `…0006` | a-triage | `agent-triage` | NULL |
| `…0011` | s-ledger | `s-ledger` (placeholder; no KC client yet — T-0042) | NULL |
| `…0012` | s-ocr | `s-ocr` (placeholder; no KC client yet — T-0042) | NULL |

`ON CONFLICT DO NOTHING`. All LLM fields and `autonomy_threshold` NULL (dormant).

---

## 4. Contracts

### 4.1 Migration 032 DDL (authoritative — `migrations/032_agent_card.sql`)

```
ALTER TABLE choros.employee
  ADD CONSTRAINT employee_tenant_id_id_kind_key UNIQUE (tenant_id, id, kind);

CREATE TABLE choros.agent_card (
  tenant_id uuid NOT NULL, employee_id uuid NOT NULL,
  employee_kind text NOT NULL DEFAULT 'agent',
  kc_client_id text NOT NULL,
  llm_endpoint text NULL, llm_model text NULL, llm_secret_handle text NULL,
  autonomy_threshold numeric(5,4) NULL,
  budget_policy_id uuid NULL, escalation_rule_id uuid NULL,
  created_at bigint NOT NULL, updated_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, employee_id),
  UNIQUE (tenant_id, kc_client_id),
  CONSTRAINT agent_card_employee_kind_chk CHECK (employee_kind = 'agent'),
  CONSTRAINT agent_card_autonomy_threshold_chk
    CHECK (autonomy_threshold IS NULL OR (autonomy_threshold >= 0 AND autonomy_threshold <= 1)),
  CONSTRAINT agent_card_employee_fk
    FOREIGN KEY (tenant_id, employee_id, employee_kind)
    REFERENCES choros.employee(tenant_id, id, kind)
);
ALTER TABLE choros.agent_card ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.agent_card FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_card_tenant_isolation ON choros.agent_card
  USING (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON choros.agent_card TO choros_app;
-- + 5-row dev seed, ON CONFLICT DO NOTHING.
```

### 4.2 `known_tenant_tables.txt`

`agent_card` added (one line). The schema.test.ts anti-decorative guard reads the file as a Set (order is cosmetic); placed at line 1 for readability.

### 4.3 Downstream frozen seams (consumed by siblings — BLOCKING for them)

- **T-0042 (write):** on hire, INSERT an `agent_card` row for the `employee(kind='agent')` with `kc_client_id` = the newly created KC clientId. LLM fields / `autonomy_threshold` MAY be NULL. T-0042 provisions KC clients for `s-ledger`/`s-ocr` (their seed `kc_client_id` is a slug placeholder today).
- **T-0024 (read):** agent identity = `agent_card.employee_id` (tenant-scoped) or `employee WHERE kind='agent'`; `kc_client_id` is the KC anchor.
- **T-0025 (column):** `llm_secret_handle text NULL` holds the opaque handle; T-0025 owns create/rotate/revoke and the never-a-raw-key business rule (not DB-enforced here).
- **T-0043 (read):** `agent_card.employee_id` is the toolset-from-grants identity key.
- **T-0023 (FK):** adds `budget_policy_id → instance_budget(tenant_id, id)` additively once `instance_budget` lands.
- **T-0123 (extension):** adds competence/prompt columns by additive `ALTER TABLE ADD COLUMN`.

### 4.4 Coder BUILD-phase test-seam fixes (exact)

1. `ci/checks/db/grant-editor.test.ts`: `expect(lines.length …).toBe(21)` → `toBe(22)` (and the "no new tenant table" comment is now stale — T-0020 adds one).
2. `ci/checks/db/cross_tenant.test.ts` `seedRowForTable`: add a **self-sufficient** case. The file iterates in `known_tenant_tables.txt` order (`agent_card` precedes `employee`), and the shared `empIdA/B` is `kind='human'` (FK-incompatible) — so the case must seed its own agent employee inline, mirroring the `role` case (L104):
   ```
   case 'agent_card': {
     // self-sufficient: seed a dedicated kind='agent' employee + its card.
     // Does NOT depend on KNOWN_TENANT_TABLES order or on the shared human empId.
     const id = uuid();
     const slug = `ct-agent-${id.slice(0,8)}`;
     await c.query(
       `INSERT INTO choros.employee (tenant_id,id,position_id,kind,slug,display_name,created_at,updated_at)
        VALUES ($1,$2,NULL,'agent',$3,$3,0,0) ON CONFLICT DO NOTHING`, [tenantId, id, slug]);
     await c.query(
       `INSERT INTO choros.agent_card (tenant_id,employee_id,kc_client_id,created_at,updated_at)
        VALUES ($1,$2,$3,0,0) ON CONFLICT DO NOTHING`, [tenantId, id, `ct-kc-${id.slice(0,8)}`]);
     break;
   }
   ```

---

## 5. Runtime target

Postgres in the silo docker-compose stack (T-0053, already running; verified live on port 55432, migrations 001-031 applied before this task). `agent_card` DML executes under `choros_app` (NOBYPASSRLS, non-owner) via `SET LOCAL choros.tenant_id` inside transactions. Migration 032 applied by `choros_migrator` (owner) through `migrations/run.mjs` (BEGIN/SQL/INSERT schema_migrations/COMMIT per file). **No new infrastructure, no new runtime module, no HTTP endpoint** — schema + seed + CI-fixture line only.

---

## 6. Live DDL verification (this DESIGN run)

Migration 032 was applied against the running silo Postgres and re-run for idempotency; the AC battery ran live, then all probe rows rolled back (DB left pristine, genesis `e-owner` intact, `agent_card` = 5 seeded rows):

| Check | Result |
|---|---|
| `node migrations/run.mjs` ×2 | run 1 applied `032_agent_card`; run 2 "nothing to apply" (idempotent) — AC-11 |
| Columns / PK / UNIQUE / RLS forced / policy / grants | all present as designed — AC-1, AC-2, AC-13 |
| Seed | 5 cards (agent-recon/agent-invoice/agent-triage/s-ledger/s-ocr) — AC-9 |
| Card for human (e-kravtsova) | rejected, FK `23503` — AC-5 |
| Card for fresh agent | inserted (5→6) — AC-6 |
| `autonomy_threshold = 1.5` | rejected, CHECK `23514`; `0.5` accepted — AC-7 |
| Duplicate `(tenant, kc_client_id)` | rejected, UNIQUE `23505` — AC-10 |
| 512-char `llm_secret_handle` | accepted (length 512) — AC-15 |
| Cross-tenant read (B sees A) | 0 rows; A sees its 5 — AC-3 |
| Cross-tenant write (B writes A) | rejected, RLS `42501` — AC-4 |
| `grep -r agent_card src/` | 0 matches — AC-12 |

---

## 7. Fitness functions

See `docs/design/T-0020.adr.contract.json` `fitness_functions[]`.

---

## 8. Blocking questions

**None.** All design forks (separate-table, kind-FK idiom, deferred FKs) resolved by the founder-signed backlog and the spec; the three test-seam breaks are autonomous BUILD-phase coder fixes. Status: **ready** — no founder escalation.
