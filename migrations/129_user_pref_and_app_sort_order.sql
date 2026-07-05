-- 129 · user_pref + application.sort_order (T-0651 · E-NAV-IA/sidebar-workspace)
--
-- ADR: docs/design/ADR-T0651-sidebar-workspace.md. UX-study 2026-07-05 §1/§4:
-- сайдбар нуждается в PER-USER состоянии (свёрнутые группы) — «никакого
-- user-prefs хранилища в продукте нет вообще» (диагноз №2). Этот же примитив
-- переиспользуется §4 (личные сохранённые представления списков, view-
-- примитив source=inbox|processes, owner_actor) — здесь только ОБЩИЙ ключ-
-- значение store, не специфика представлений.
--
-- Tenant-table contract (T-0013, verbatim as in 003/108/113/123): tenant_id
-- leading PK, ENABLE+FORCE RLS, default-DENY policy on
-- current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
-- choros_app DML GRANT (NOBYPASSRLS role), listed in
-- ci/checks/known_tenant_tables.txt.
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; ADD COLUMN IF NOT EXISTS;
-- DO-guards on policy/constraint/index. Runner skips via schema_migrations;
-- repeating this file is safe.

-- ---------------------------------------------------------------------------
-- user_pref — generic per-actor key/value store (tenant + actor + key unique)
-- ---------------------------------------------------------------------------
--
-- actor — the employee slug (human OR agent; same identity space as every
-- other actor-scoped table in this repo, e.g. list_view.created_by,
-- section's implicit actor via audit). NOT a FK to employee: employee rows
-- can be hard-deleted in some legacy paths and a stale pref key is harmless
-- (it simply never resolves again) — same "soft ref, not enforced FK"
-- reasoning as audit_event.actor.
--
-- value — jsonb (open-ended: bool for a collapse flag, array of ids, or a
-- structured object for a future saved-view). No CHECK on shape beyond
-- "valid JSON scalar/object/array" — the value's semantics are 100% owned by
-- the reading feature (sidebar collapse today; view-registry-owner_actor /
-- table density tomorrow), never this table.
--
-- ONE ROW per (tenant, actor, key) — PUT is upsert (ON CONFLICT DO UPDATE),
-- so "toggle a collapsed group" is a single idempotent write, not an
-- append-only log (a preference has no history value; T-0013 audit_event
-- already covers who-changed-what if that is ever needed).

CREATE TABLE IF NOT EXISTS choros.user_pref (
  tenant_id   uuid    NOT NULL,
  id          uuid    NOT NULL,
  actor       text    NOT NULL,
  key         text    NOT NULL,
  value       jsonb   NOT NULL,
  created_at  bigint  NOT NULL,
  updated_at  bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),
  -- Одна запись на (актор, ключ) в тенанте — upsert-семантика, не лог.
  UNIQUE (tenant_id, actor, key)
);

ALTER TABLE choros.user_pref ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.user_pref FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'user_pref'
      AND policyname = 'user_pref_tenant_isolation'
  ) THEN
    CREATE POLICY user_pref_tenant_isolation ON choros.user_pref
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.user_pref TO choros_app;

-- Lookup index: "все настройки этого актора" (GET /api/user-prefs).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros'
      AND tablename  = 'user_pref'
      AND indexname  = 'user_pref_actor_idx'
  ) THEN
    CREATE INDEX user_pref_actor_idx
      ON choros.user_pref (tenant_id, actor);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- application.sort_order — manual order of apps WITHIN a section (T-0651).
-- ---------------------------------------------------------------------------
--
-- FINDING (UX-study §1, mirrored on §6 "оргструктура НЕТ move-API"): sections
-- themselves already carry sort_order (migration 113), but applications did
-- NOT — the sidebar's "apps in a section" list has always been ordered by
-- created_at DESC, slug ASC (applications.ts APP_READ_SELECT/listApplications),
-- with no manual reorder handle. DnD (this task) needs a persisted position,
-- so this is the minimal additive column + PATCH support (src/http/
-- applications.ts) rather than inventing a parallel ordering table.
--
-- Additive-safe: NULL-less DEFAULT 0 column — every existing row gets 0
-- (ties then fall back to the existing created_at/slug order, unchanged
-- behaviour for tenants that never reorder).

ALTER TABLE choros.application
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
