-- 123 · list_view (T-0581 · view registry) — сохраняемые представления списка
-- записей + фундамент реестра представлений для T-0582 (канбан).
--
-- ADR: docs/design/T-0581-view-registry.adr.md. Столп 2 (интерфейс из блоков на
-- данных), кейс-доказательство К1 (CRM «список сделок под себя», тест-материал,
-- НЕ платформенная константа).
--
-- Tenant-table contract (T-0013, verbatim as in 003/108/113): tenant_id leading
-- PK, ENABLE+FORCE RLS, default-DENY policy on
-- current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
-- choros_app DML GRANT (NOBYPASSRLS role), listed in
-- ci/checks/known_tenant_tables.txt.
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guards on policy/constraint/
-- index. Runner skips via schema_migrations; repeating this file is safe.
--
-- Numbering note (ADR §3.1 "known grabля"): T-0579/T-0580 run in parallel and may
-- also claim slot 123 on their own worktrees. If a merge collides on the number,
-- renumber the slot — this DDL is idempotent (CREATE TABLE IF NOT EXISTS, DO-guards
-- on policy/constraint/index), so re-running under a different filename is safe.

-- ---------------------------------------------------------------------------
-- list_view — сохранённое представление списка (реестр представлений)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS choros.list_view (
  tenant_id        uuid    NOT NULL,
  id               uuid    NOT NULL,
  registry_def_id  uuid    NOT NULL,
  application_id   uuid    NOT NULL,
  -- ОТКРЫТЫЙ дискриминатор вида (FF-VR-4 / AC-11): v1 принимает только 'list'
  -- в TS-валидаторе (validateViewConfig), НЕ в CHECK-констрейнте — T-0582
  -- добавляет 'kanban' без DDL-миграции.
  type             text    NOT NULL DEFAULT 'list',
  name             text    NOT NULL,
  is_default       boolean NOT NULL DEFAULT false,
  -- Семантика config валидируется в TS (src/core/view-config.ts); здесь только
  -- структурный CHECK (jsonb object), см. ADR "отвергнутые альтернативы" §CHECK.
  config           jsonb   NOT NULL,
  created_at       bigint  NOT NULL,
  updated_at       bigint  NOT NULL,
  created_by       text    NOT NULL,

  PRIMARY KEY (tenant_id, id),
  -- Одно имя представления на набор полей в тенанте (нет дублей-призраков).
  UNIQUE (tenant_id, registry_def_id, name),

  CONSTRAINT list_view_config_obj CHECK (jsonb_typeof(config) = 'object')
);

ALTER TABLE choros.list_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.list_view FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'list_view'
      AND policyname = 'list_view_tenant_isolation'
  ) THEN
    CREATE POLICY list_view_tenant_isolation ON choros.list_view
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.list_view TO choros_app;

-- Composite FK → registry_def (owner набор полей). ON DELETE CASCADE:
-- представление без набора полей бессмысленно (ADR §3.1).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'list_view_registry_fk'
  ) THEN
    ALTER TABLE choros.list_view
      ADD CONSTRAINT list_view_registry_fk
      FOREIGN KEY (tenant_id, registry_def_id)
      REFERENCES choros.registry_def (tenant_id, id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- Composite FK → application (денормализованный владелец-приложение, для
-- быстрых «представлений приложения» без join через registry_def). Без
-- ON DELETE — registry_def CASCADE снимает строки раньше (ADR §3.1).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'list_view_app_fk'
  ) THEN
    ALTER TABLE choros.list_view
      ADD CONSTRAINT list_view_app_fk
      FOREIGN KEY (tenant_id, application_id)
      REFERENCES choros.application (tenant_id, id);
  END IF;
END
$$;

-- Частичный уникальный индекс: ≤1 is_default=true на (tenant, registry_def_id)
-- (AC-10 — два default одновременно невозможны на уровне БД).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros'
      AND tablename  = 'list_view'
      AND indexname  = 'list_view_one_default'
  ) THEN
    CREATE UNIQUE INDEX list_view_one_default
      ON choros.list_view (tenant_id, registry_def_id)
      WHERE is_default;
  END IF;
END
$$;

-- Lookup index: «представления набора полей» (GET /api/list-views?registry_def_id=).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros'
      AND tablename  = 'list_view'
      AND indexname  = 'list_view_registry_def_id_idx'
  ) THEN
    CREATE INDEX list_view_registry_def_id_idx
      ON choros.list_view (tenant_id, registry_def_id);
  END IF;
END
$$;
