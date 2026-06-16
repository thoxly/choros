-- 065 · install-runbook projection (T-0213 · P-5 · docs-pipeline)
--
-- ADR: docs/design/T-0213-install-runbook.adr.md (§4.1 / §7)
-- Foundations: T-0238 (doc_page/doc_ref/doc_log DDL, migration 061),
--              T-0127 (genesis installer, docs/runbooks/install.md),
--              T-0209 (P-1 DocsAuthorAgent seed, migration 062).
--
-- Projects the product install-runbook as a scope='system' doc_page into the
-- day-1 dev-tenant, anchoring install-facts as typed config_key/rest_endpoint
-- doc_ref rows, and recording a doc_log('system_doc_projected') row.
--
-- Design discipline:
--   PURE DATA SEED: no CREATE TABLE, no DDL, no ALTER, no schema change.
--   known_tenant_tables.txt is NOT changed (doc_page/doc_ref/doc_log already
--   listed from migration 061).
--   ADDITIVE & IDEMPOTENT: INSERT-only, ON CONFLICT DO NOTHING on all 3 tables.
--   ONE-DIRECTIONAL: this file is data; it imports NOTHING from the docs pipeline
--   (doc-page-store.ts, doc-regen.ts, doc-ref-lint.ts, doc-live-snapshot.ts).
--   Genesis (install.sh/docker-entrypoint.sh/run.mjs/vendor/*) runs this file
--   via migrations/run.mjs without knowing its contents.
--   F-6 static guard (ci/checks/install-runbook-projection.sh) proves both
--   import directions absent.
--
-- Dev-tenant constants:
--   DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001
--   PAGE_ID         = a1000000-0000-0000-0000-000000000001  (a1 namespace, first doc_page seed)
--   REF1 (GET /health)             = a2000000-0000-0000-0000-000000000001
--   REF2 (GET /vendor/activation)  = a2000000-0000-0000-0000-000000000002
--   REF3 (config_key emit_form_code) = a2000000-0000-0000-0000-000000000003
--   LOG1            = a3000000-0000-0000-0000-000000000001  (a3 namespace, first doc_log seed)
--   slug            = 'system/install-runbook'   (stable idempotency key)
--   catalog_version = 'install-runbook.v1'
--   authored_by     = 'system'
--   scope           = 'system'   (provision-time projection, T-0134 §2.4)
--
-- Typed refs (verified against real router.register sites in src/):
--   rest_endpoint: GET /health     — router.register("GET","/health") in src/server.ts:146
--   rest_endpoint: GET /vendor/activation — router.register("GET","/vendor/activation")
--                                           in src/http/vendor-activation.ts:102
--   config_key: emit_form_code     — mcp_tool.name seeded in migration 044, present in
--                                    dev-tenant; resolves via collectConfigKeys(DB)
--
-- Authority: written by choros_migrator (bypasses FORCE-RLS at provision time).
-- Reads ride the single tenant_id RLS predicate (NF-1, migration 061, T-0134 §2.4).
-- No new grant, no new mcp_tool, no new role — provision-writer authority reuse (§4.1).

-- ============================================================
-- Step 1. doc_page — install-runbook (scope='system')
-- ============================================================

INSERT INTO choros.doc_page
  (tenant_id, id, slug, title, body, summary, scope, catalog_version, app_id,
   stale, authored_by, authored_at, updated_at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'system/install-runbook',
    'Установка и обновление (genesis-runbook)',
    $runbook_body$# Choros genesis install + upgrade runbook (T-0127)

> Scope: MVP — **online, linux/amd64**. Air-gapped (preloaded images) and ARM64
> are Stage-2 (ADR §7), not covered here.

## The one command (AC-1)

From a clean target host with **Docker Engine + `docker compose` v2** preinstalled,
in the repo root:

```sh
ops/install.sh
```

That single command:

1. **preflight** — asserts `docker` + `docker compose` v2, that the default host
   ports (55432 / 8180 / 9000 / 8082 / 3000) are free, and that there is enough
   disk. On any failure it exits non-zero, prints the failing precondition, and
   brings **nothing** up (fail-closed, AC-5).
2. **config** — if `.env.prod` is absent, generates it from `.env.prod.example`,
   filling every secret with `openssl rand` and wiring the generated Postgres
   password into `DATABASE_URL`. If `.env.prod` already exists it is left
   **untouched** — secrets are never regenerated (AC-3/AC-4).
3. **activation (optional)** — see below. No key ⇒ autonomous mode, **not** an error.
4. **bring-up** — `docker compose -f docker-compose.yml -f docker-compose.prod.yml
   --env-file .env.prod up -d --wait`. Migrations (including `026` genesis-owner)
   run via the existing `ops/docker-entrypoint.sh` → `migrations/run.mjs` **before**
   the app starts. The installer adds **no** second owner path.
5. **verify** — `GET /health` must return `200`, else fail-closed (AC-1).
6. **summary** — prints endpoint, first-owner login, image version, and activation
   status (`active` | `autonomous`) (AC-10).

Re-running is safe (idempotent): an existing `.env.prod` triggers upgrade
semantics, the genesis seed is never duplicated, and verify is the single source
of truth.

## Preconditions

- Docker Engine and the **`docker compose` v2 plugin** (`docker compose version`).
- `openssl` (only needed on a **fresh** install to generate `.env.prod` secrets).
- The default host ports free on a fresh install: `55432 8180 9000 8082 3000`
  (override with `POSTGRES_PORT` / `KEYCLOAK_PORT` / `KEYCLOAK_MGMT_PORT` /
  `FLOWABLE_PORT` / `APP_PORT` in `.env.prod`).
- ≥ 2 GiB free disk on the repo filesystem.

## Activation: active vs autonomous (the key is NOT a kill-switch)

The activation key **sells the vendor service layer** — updates (self-upgrade /
image pulls), agentic maintenance (fleet-ops), and support. It is **never** a
kill-switch: the founder red-lined any path where the circuit halts or degrades
because of billing.

- **active** — a key is present, its Ed25519 signature verifies against the shipped
  vendor public key (`config/activation/vendor-pub.ed25519`), and `now` is within
  `[not_before, not_after)`. Vendor-service calls are permitted per the
  entitlements in the key.
- **autonomous** — no key, an expired key, or a not-yet-valid key. **The circuit is
  fully functional**: genesis-owner login, processes, tasks, audit, RLS — all work.
  Only the vendor-service endpoints refuse (HTTP 402 on `src/http/vendor-*`).
- An **invalid** key (bad signature) is treated as autonomous for the core: the
  circuit stays up; vendor-service calls return 403 (key not trusted).

Provide a key one of two ways:

```sh
ops/install.sh --key /path/to/choros.key      # a path is read
ops/install.sh --key 'choros1.<payload>.<sig>' # or pass the wire string literally
# or set CHOROS_ACTIVATION_KEY in .env.prod
```

The key is written to `config/activation/activation.key` (**gitignored**). The
vendor **private** signing key never enters the client circuit — key issuance is
control-plane (OS-3).

Check the live verdict any time (always `200`, reporting is not gating):

```sh
curl -s http://localhost:3000/vendor/activation
```

## First-owner login

The genesis owner (an `e-owner` holding the `tenant-owner` role with its delegable
management grants) is seeded **exactly once** by migration `026`
(`source='genesis'`). There is no second owner-creation path. Sign in as that
genesis e-owner at the printed endpoint.

## Online self-upgrade

```sh
ops/install.sh --upgrade      # (an existing .env.prod also triggers upgrade semantics)
```

Runs `docker compose pull` (online) then `up -d --wait`; pending migrations catch
up idempotently via the entrypoint (silo-upgrade semantics). Air-gapped upgrade
(`docker save/load`) is Stage-2.

## Failure modes (all fail-closed)

| Step       | Symptom                                  | Action                                  |
|------------|------------------------------------------|-----------------------------------------|
| preflight  | `host port N is already in use`          | free the port or override the `*_PORT`  |
| preflight  | `'docker compose' v2 plugin not available` | install the Compose v2 plugin         |
| config     | `'openssl' not found`                    | install openssl (fresh install only)    |
| bring-up   | `docker compose up ... failed`           | `docker compose ... logs` to inspect    |
| verify     | `GET /health returned ... (expected 200)`| inspect app/db logs; nothing false-green|

The installer never leaves a half-green stack reporting success: a non-zero exit
always names the failing step.$runbook_body$,
    'Установка одной командой ops/install.sh; verify GET /health; статус активации GET /vendor/activation.',
    'system',
    'install-runbook.v1',
    NULL,
    false,
    'system',
    0,
    0
  )
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- ============================================================
-- Step 2. doc_ref × 3 — install-fact typed refs
--   REF1: rest_endpoint GET /health  (install verify step)
--   REF2: rest_endpoint GET /vendor/activation  (activation-status endpoint)
--   REF3: config_key emit_form_code  (live mcp_tool.name from migration 044)
--   UNIQUE(tenant_id, page_id, ref_kind, ref_target) → ON CONFLICT DO NOTHING
-- ============================================================

INSERT INTO choros.doc_ref
  (tenant_id, id, page_id, ref_kind, ref_target, broken, created_at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'rest_endpoint',
    '{"method":"GET","path":"/health"}'::jsonb,
    false,
    0
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000002',
    'a1000000-0000-0000-0000-000000000001',
    'rest_endpoint',
    '{"method":"GET","path":"/vendor/activation"}'::jsonb,
    false,
    0
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000003',
    'a1000000-0000-0000-0000-000000000001',
    'config_key',
    '{"key":"emit_form_code"}'::jsonb,
    false,
    0
  )
ON CONFLICT (tenant_id, page_id, ref_kind, ref_target) DO NOTHING;

-- ============================================================
-- Step 3. doc_log — system_doc_projected audit record
--   op='system_doc_projected' (T-0134 §2.4 open-vocab label)
--   agent_actor='system'  (provision-time migrator action)
--   diff_summary carries catalog_version — no secret (F-8)
--   ON CONFLICT DO NOTHING (stable UUID = idempotent re-apply)
-- ============================================================

INSERT INTO choros.doc_log
  (tenant_id, id, page_id, op, agent_actor, diff_summary, at)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'system_doc_projected',
    'system',
    'install-runbook.v1 projected at provision (T-0213 P-5)',
    0
  )
ON CONFLICT DO NOTHING;
