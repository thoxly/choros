-- 113 · section (T-0551 · E-NAV-IA) — раздел как первоклассная сущность (ELMA-папка).
--
-- ADR: docs/design/T-0551-sections-as-entity.adr.md (PD-24, founder-approved 2026-06-30).
-- РЕВЕРС T-0540 §2.1: раздел = свободный текст `application.section`. Здесь раздел
-- поднимается до управляемой tenant-сущности (создаётся, именуется, сортируется,
-- удаляется мягко). `application.section` (строка) НЕ дропается — помечена
-- deprecated, сносится отдельной миграцией следующей версии (обратимость).
--
-- Foundations: T-0013 (RLS-contract), migration 003_application.sql (verbatim pattern),
--              T-0017 (tenant-scoped composite FK discipline), T-0119 (migration discipline).
--
-- Tenant-table contract (T-0013, verbatim as in 003/112):
--   tenant_id leading PK, ENABLE+FORCE RLS, default-DENY policy on
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   choros_app DML GRANT (NOBYPASSRLS role), listed in ci/checks/known_tenant_tables.txt.
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; ADD COLUMN IF NOT EXISTS;
--   DO-guards on policy/constraint; backfill guarded by NOT EXISTS. Runner skips via
--   schema_migrations; repeating this file is safe.

-- ---------------------------------------------------------------------------
-- section — управляемая папка рабочего пространства (раздел нав РАБОТА)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS choros.section (
  tenant_id   uuid    NOT NULL,
  id          uuid    NOT NULL,
  name        text    NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  bigint  NOT NULL,
  updated_at  bigint  NOT NULL,

  PRIMARY KEY (tenant_id, id),
  -- scoped uniqueness: одно имя раздела на тенант (нет призраков-дублей; ADR §2)
  UNIQUE (tenant_id, name)
);

ALTER TABLE choros.section ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.section FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'section'
      AND policyname = 'section_tenant_isolation'
  ) THEN
    CREATE POLICY section_tenant_isolation ON choros.section
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.section TO choros_app;

-- ---------------------------------------------------------------------------
-- application.section_id — FK на раздел-сущность (NULL → «Без раздела»)
-- ---------------------------------------------------------------------------
-- Additive-safe: NULL-колонка, нет блокировки существующих строк. NULL — валидное
-- состояние «без раздела» (не fallback-авария; ADR §2). Составной FK с tenant_id
-- (T-0017) гарантирует, что раздел и приложение в ОДНОМ тенанте.

ALTER TABLE choros.application
  ADD COLUMN IF NOT EXISTS section_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'application_section_fk'
      AND conrelid = 'choros.application'::regclass
  ) THEN
    ALTER TABLE choros.application
      ADD CONSTRAINT application_section_fk
      FOREIGN KEY (tenant_id, section_id)
      REFERENCES choros.section (tenant_id, id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- Index for "apps in section" lookups + DELETE-section soft-detach reassign.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros'
      AND tablename  = 'application'
      AND indexname  = 'application_section_id_idx'
  ) THEN
    CREATE INDEX application_section_id_idx
      ON choros.application (tenant_id, section_id);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Idempotent backfill (generic, для всех тенантов) — строка → сущность.
-- ---------------------------------------------------------------------------
-- На текущем dev выполнится вхолостую (везде application.section IS NULL), но
-- защищает контуры с данными: каждый DISTINCT non-null section становится разделом,
-- приложения привязываются по section_id. Повторный прогон — ноль изменений
-- (NOT EXISTS на name + section_id IS NULL гард).

-- (нельзя гарантировать pgcrypto в search_path — gen_random_uuid() в Postgres ≥13
--  встроена в pg_catalog; choros использует её в migration 112-backfill идиоме.)
DO $$
DECLARE
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
BEGIN
  INSERT INTO choros.section (tenant_id, id, name, sort_order, created_at, updated_at)
  SELECT DISTINCT a.tenant_id, gen_random_uuid(), a.section, 0, now_ms, now_ms
  FROM choros.application a
  WHERE a.section IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM choros.section s
      WHERE s.tenant_id = a.tenant_id AND s.name = a.section
    );

  UPDATE choros.application a
     SET section_id = s.id
  FROM choros.section s
  WHERE s.tenant_id = a.tenant_id
    AND s.name = a.section
    AND a.section IS NOT NULL
    AND a.section_id IS NULL;
END
$$;

-- DEPRECATED: choros.application.section (text). Заменена на section_id (FK выше).
-- НЕ дропается в этой миграции (обратимость) — снести отдельной миграцией следующей
-- версии, когда все читатели перейдут на section_id. ADR §3 п.4.
COMMENT ON COLUMN choros.application.section IS
  'DEPRECATED (T-0551): заменена section_id FK на choros.section. Снести отдельной миграцией.';
