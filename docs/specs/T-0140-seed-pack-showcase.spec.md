# Spec · T-0140 — Seed-pack «showcase»: format + importer + CLI apply/reset

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-06-11
**Task:** SP-1 — Declarative seed-pack format, importer via public APIs, CLI `seed apply` / `seed reset`
**Authoritative source:** `playbooks/demo-stand.md` §SP-1 (rамка фаундера 2026-06-11)

**Foundation (do NOT contradict):**
- I-1 (invariant): pack is applied through **public REST APIs only** — no raw SQL, no direct DB access. A breaking API change MUST be caught at CI apply-time, not silently.
- I-2: `ORG_SEED` (`src/http/org.ts`), `PROCESSES_SEED` (`src/http/processes.ts`), and migration demo-INSERTs 013–019 (departments, positions, employees, roles) all move into the pack. Two copies of demo data MUST NOT coexist after this task.
- I-3: genesis-owner (`migrations/026_genesis_owner_seed.sql`) is system bootstrap — NOT demo data. It stays in migrations, out of scope for this task.
- I-4: `seed apply` is idempotent (re-running = no-op); `seed reset` restores the tenant to the pack's reference state.
- I-5: public demo stand is founder-gated (T-0142). This task targets dev environment only.
- T-0013 tenant isolation: every write goes through a tenant-scoped session (`X-Dev-User` header for dev auth-mode); no cross-tenant leakage.

---

## 0. Context — existing API surface and gaps

### Public APIs that already exist (write)

| API | Implemented in |
|---|---|
| `POST /api/grants` | `src/http/grants.ts` |
| `POST /api/grants/:id/revoke` | `src/http/grants.ts` |
| `POST /api/role-assignments` | `src/http/grants.ts` |
| `POST /api/role-assignments/:id/revoke` | `src/http/grants.ts` |

### Public APIs that exist (read)

`GET /api/org`, `GET /api/org/employee/:id`, `GET /api/users`, `GET /api/rights`, `GET /api/rights/:roleId`, `GET /api/rights/dictionaries`, `GET /api/processes`, `GET /api/processes/:id`, `GET /api/grant-trail`, `GET /api/audit`, `GET /api/inbox`

### APIs MISSING for seed-pack import (new endpoints required by this task)

The following write APIs do not exist today but are **required for the importer to satisfy I-1**. Their schemas are specified as acceptance criteria below; actual API design and implementation are `architect`/`coder` territory.

| Missing API | Purpose |
|---|---|
| `POST /api/tenants` | Create a named tenant (slug + display_name) |
| `POST /api/departments` | Create a department under a tenant |
| `POST /api/positions` | Create a position inside a department |
| `POST /api/employees` | Create a human or agent employee |
| `POST /api/roles` | Create a cross-cutting role |

> `POST /api/processes` (create process instance) is **not required** here: the
> `PROCESSES_SEED` data represents runtime state that cannot be reconstructed via
> a public BPMN API (Flowable engine manages instance state). The seed-pack format
> for process instances is **read-only / display-data only**, served from the pack
> file without write. This is the one exception to I-1 — the spec acknowledges it
> explicitly (see Out of Scope, item 6).

---

## 1. Summary

Build a declarative seed-pack format (`seed/` directory in repo), a Node.js importer
that applies the pack through public REST APIs, and a CLI (`seed apply` / `seed reset`).
The `showcase` pack consolidates all demo content currently scattered across
`ORG_SEED`, `PROCESSES_SEED`, and migration INSERT blocks 013–019. A minimal `blank`
pack template is produced as a parallel output for trial-tenant bootstrap.

---

## 2. Functional Requirements

### FR-1 — Pack format

- A pack is a directory `seed/<pack-name>/` (e.g. `seed/showcase/`) in the repository.
- Pack content is schema-validated at load time. The schema is defined in `seed/pack.schema.json` and enforced at both apply-time and in CI.
- A pack declares at minimum: `meta` (name, version, description), `tenant` (slug + display_name), `departments`, `positions`, `employees` (humans and agents), `roles`, `role_assignments`, `grants`, and optionally `process_instances` (display-only, read-only; see FR-6).
- Format is JSON or YAML (choice is implementation detail, must be consistent across one pack; schema must cover both).

### FR-2 — Importer (pack → API calls)

- Importer is a TypeScript module (not a migration script, not raw SQL).
- Applies entities in dependency order: tenant → departments → positions → employees → roles → role_assignments → grants → (optional) process_instances as display data.
- Each entity write goes through the corresponding public REST API. No `pg` calls, no direct DB access in the importer module.
- Importer is **idempotent**: for each entity, it first checks existence via a GET or detects a 409 conflict response and treats it as no-op. Repeated `seed apply` yields the same final state.
- API auth in dev mode: importer uses `X-Dev-User` header with the genesis-owner slug (`e-owner`) for privileged writes; this is the only actor with sufficient grants (migration 026).

### FR-3 — CLI: `seed apply`

- Entry point: `node seed/cli.js apply --tenant <slug> --pack <pack-name>` (or equivalent npm script).
- Applies the named pack to the tenant identified by `<slug>` (tenant must exist or be created by the pack itself).
- Exits 0 on success, non-zero on first error.
- Prints a structured summary: entities created / skipped (already-existing).

### FR-4 — CLI: `seed reset`

- Entry point: `node seed/cli.js reset --tenant <slug>`.
- Restores the tenant to the pack's reference state: removes entities present in the tenant that are NOT in the pack, upserts entities that differ.
- `seed reset` does NOT drop the tenant row or the genesis-owner employee (I-3 / I-4).
- Exits 0 on success, non-zero on first error.

### FR-5 — `showcase` pack content (consolidated from existing seeds)

The `showcase` pack MUST include all content currently in:
- `src/http/org.ts` — `ORG_SEED` (3 departments, 7 positions, 12 employees = 7 human + 5 agent)
- `src/http/processes.ts` — `PROCESSES_SEED` (8 process instances, display-only)
- `src/http/rights.ts` — `RIGHTS_SEED` (8 roles with grants and holders)
- `migrations/019_role.sql` — 2 roles (`tenant-owner`, `budget-approver`) are system roles; they remain in migrations AND are referenced (not re-created) in the showcase pack.
- `migrations/014–016` department/position/employee data is the authoritative source for IDs; the pack uses the same stable UUIDs/slugs.

After this task:
- `ORG_SEED` in `src/http/org.ts` may remain as in-memory fallback (no-DB path) until explicitly removed in a future task; it is NOT duplicated into the pack — the pack IS the single source. The fallback path must read from the pack file OR from the existing in-memory constant (not a second hardcoded copy).
- `PROCESSES_SEED` and `RIGHTS_SEED` remain as in-memory fallbacks; same rule applies.

### FR-6 — `blank` pack template

- A minimal `seed/blank/` pack is created alongside `seed/showcase/`.
- `blank` contains: one tenant placeholder, zero departments/employees/roles, zero demo data.
- Purpose: trial tenant bootstrap (T-0141+). Content is structural only.

### FR-7 — CI gate: smoke apply on clean DB

- CI MUST run `seed apply --tenant showcase --pack showcase` against a clean (post-migration) DB and verify that key entities are reachable via `GET /api/org` and `GET /api/rights`.
- CI step: `npm run seed:smoke` (or equivalent).

### FR-8 — e2e fixtures read from pack

- Existing e2e tests that hard-code org/employee/role IDs MUST be updated to read those IDs from the pack file. No separate hard-coded fixture maps.

---

## 3. Non-Functional Requirements

- NF-1: Pack schema (`seed/pack.schema.json`) must be JSON Schema draft-07 and validated in CI via the existing `validate.py` harness pattern or equivalent.
- NF-2: Importer has zero new direct `pg` imports — all writes go through HTTP. Verified by a fitness check (`no-direct-pg-in-importer.sh` or similar grep).
- NF-3: `seed apply` on an already-applied pack completes in under 10 seconds on dev (no unnecessary retry storms).
- NF-4: CLI error output is structured JSON to stderr, exit code non-zero.
- NF-5: Pack file must not contain any credentials, tokens, or secrets. CI fitness check (`no-committed-secret.sh` already covers this directory via glob expansion — verify coverage).

---

## 4. Out of Scope

1. Deployment of public demo stand (T-0142, stage 2 — depends on T-0060 Keycloak).
2. `seed reset` scheduling / cron (T-0142).
3. Genesis-owner employee and its grants — these stay in `migrations/026` (I-3).
4. Flowable BPMN process definition import/deploy (owned by T-0058 and related tasks).
5. Agent card (`agent_card` table, T-0020) — pack may reference agents by employee slug but does not create agent_card rows.
6. Creating live process instances via API — `PROCESSES_SEED` display data is served from the pack file as static JSON (no Flowable instance creation); full Flowable-backed process instances are post-MVP.
7. Multi-pack composition / inheritance.
8. Keycloak realm synchronization (T-0054).
9. Removal of in-memory `ORG_SEED`/`PROCESSES_SEED`/`RIGHTS_SEED` fallback constants — these stay for no-DB dev path; the goal is one authoritative source for pack content, not removal of fallbacks in this task.

---

## 5. Missing APIs (new endpoints required)

The following five endpoints must be added as part of this task (or as a dependency resolved before this task's coder phase). They are called by the importer in order.

### POST /api/tenants
- Body: `{ slug: string, display_name: string }`
- Success: 201 `{ id: uuid, slug: string }`
- Idempotency: 409 if slug already exists (importer treats as no-op)
- Auth: `X-Dev-User` header required (genesis-owner acts as caller)

### POST /api/departments
- Body: `{ tenant_id: uuid, slug: string, display_name: string, parent_id?: uuid }`
- Success: 201 `{ id: uuid, slug: string }`
- Idempotency: 409 if `(tenant_id, slug)` already exists

### POST /api/positions
- Body: `{ tenant_id: uuid, department_id: uuid, slug: string, title: string }`
- Success: 201 `{ id: uuid, slug: string }`
- Idempotency: 409 if `(tenant_id, department_id, slug)` already exists

### POST /api/employees
- Body: `{ tenant_id: uuid, position_id?: uuid, kind: "human"|"agent", slug: string, display_name: string }`
- Success: 201 `{ id: uuid, slug: string }`
- Idempotency: 409 if `(tenant_id, slug)` already exists

### POST /api/roles
- Body: `{ tenant_id: uuid, slug: string, display_name: string, description?: string }`
- Success: 201 `{ id: uuid, slug: string }`
- Idempotency: 409 if `(tenant_id, slug)` already exists

---

## 6. Acceptance Criteria

| ID | Text | Verifiable as |
|---|---|---|
| AC-1 | `POST /api/tenants` with `{ slug: "showcase", display_name: "..." }` → 201 and a row in `choros.tenant` with that slug | test |
| AC-2 | `POST /api/departments` with valid body → 201 and a row in `choros.department` with the slug; re-POST same slug → 409 | test |
| AC-3 | `POST /api/positions` with valid body → 201 and a row in `choros.position`; re-POST same `(department_id, slug)` → 409 | test |
| AC-4 | `POST /api/employees` with `kind="human"` → 201 and a row in `choros.employee` with `kind='human'`; re-POST same slug → 409 | test |
| AC-5 | `POST /api/employees` with `kind="agent"` → 201 and a row in `choros.employee` with `kind='agent'`; re-POST same slug → 409 | test |
| AC-6 | `POST /api/roles` with valid body → 201 and a row in `choros.role`; re-POST same slug → 409 | test |
| AC-7 | `seed apply --tenant showcase --pack showcase` on a clean (post-migration) DB exits 0 and `GET /api/org` returns all 3 departments + 7 positions + 12 employees from `ORG_SEED` | test |
| AC-8 | `seed apply --tenant showcase --pack showcase` run twice on the same DB exits 0 both times and yields identical `GET /api/org` responses (no duplicates, no errors) | test |
| AC-9 | `seed reset --tenant showcase` removes an extra department manually inserted, then `GET /api/org` returns only the pack-defined departments | test |
| AC-10 | `seed reset --tenant showcase` does NOT delete the genesis-owner employee (`slug = 'e-owner'`, migration 026) | test |
| AC-11 | `GET /api/rights` after `seed apply` returns the 8 roles defined in `RIGHTS_SEED` | test |
| AC-12 | `seed/pack.schema.json` exists and validates `seed/showcase/pack.json` (or equivalent) with zero errors via `validate.py` or equivalent JSON Schema validator | fitness |
| AC-13 | A new fitness check confirms that `seed/*.ts` (importer) contains no direct `pg` imports — all writes go through HTTP | fitness |
| AC-14 | The showcase pack file does not contain any credentials or secrets (covered by CI secret-scan check) | fitness |
| AC-15 | `seed apply` prints a structured summary listing entities created and entities skipped (already existing) | manual |
| AC-16 | `PROCESSES_SEED` from `src/http/processes.ts` (8 process instances) is present in the pack file and `GET /api/processes` after `seed apply` returns those instances | test |
| AC-17 | e2e tests that previously hard-coded employee/department/role IDs now read those IDs from the pack file (no duplicate ID lists) | fitness |
| AC-18 | `seed apply` uses `X-Dev-User: e-owner` (genesis-owner) for all privileged writes; a non-owner dev-user attempting `seed apply` on write-APIs that require admin rights returns 403 | test |

---

## 7. Blocking Questions

None. All design decisions (pack format location `seed/`, CLI shape, missing API list, in-memory fallback retention, genesis-owner exclusion) are derivable from the invariants in `playbooks/demo-stand.md` and the existing codebase. Status: **ready**.
