-- 131 · engine_process_name (T-0732 · E16 T-0349, O-1 из ревью T-0717) —
-- tenant-scoped человеко-имя для ДВИЖКОВЫХ (source=engine) процессов.
--
-- CONTEXT:
--   Движковые процессы (задеплоенные прямо в Flowable из config/flowable/
--   processes/*.bpmn20.xml, БЕЗ строки в choros.process_definition) различимы в
--   UI лишь по camelCase-ключу (telLinear) — machine-leak. resolveDefinitionNames
--   (src/http/process-projection.ts) для таких ключей отдаёт fallbackDefinitionName
--   (= сам ключ), поэтому deriveInstanceTitle (web) демотирует их до generic
--   «Процесс». Настоящее человеко-имя живёт в BPMN <process name="…">, но:
--     (1) config/* НЕ копируется в Docker runtime-образ → чтение файла в рантайме
--         вернёт null на живом стенде (T-0717 §1a);
--     (2) Flowable process_key НЕ tenant-partitioned → резолв имени по голому
--         ключу через живой Flowable REST рискует межтенантной утечкой (T-0616 §F-1).
--   Решение (ADR docs/tasks/T-0732.adr.md, вариант a′): хранить имя в СВОЕЙ
--   tenant-scoped таблице-оверлее — пишем на deploy (когда BPMN доступен),
--   читаем в рантайме из БД под RLS. НЕ строка в process_definition: там
--   «движковый = ОТСУТСТВИЕ строки» — несущий инвариант (sandbox-гейт
--   process-start.ts, draft-скрытие inbox.ts, source-классификация каталога).
--
-- WHAT THIS ADDS: одна таблица-оверлей (tenant_id, process_key) → name. НОЛЬ
--   изменений в process_definition/authz/видимости. Резолвится СРЕДНИМ ярусом:
--   modeler-строка → engine-оверлей → голый ключ (фолбэк keyDemoted).
--
-- Tenant-table contract (T-0013, verbatim as in 074/129): tenant_id-leading PK,
--   ENABLE+FORCE ROW LEVEL SECURITY, exactly ONE isolation predicate
--   current_setting('choros.tenant_id', true)::uuid (USING + WITH CHECK),
--   GRANT SELECT,INSERT,UPDATE,DELETE ... TO choros_app (NOBYPASSRLS role),
--   listed in ci/checks/known_tenant_tables.txt.
--
-- Idempotency (NF-1): CREATE TABLE IF NOT EXISTS; DO-guard on policy; runner
--   skips via schema_migrations; repeating this file is safe.
--
-- Migration slot: 131 (130 is the highest occupied slot on this branch).

CREATE TABLE IF NOT EXISTS choros.engine_process_name (
  tenant_id    uuid   NOT NULL,
  process_key  text   NOT NULL,
  name         text   NOT NULL,
  created_at   bigint NOT NULL,
  updated_at   bigint NOT NULL,

  -- Одна запись на (тенант, ключ) — upsert-семантика (ON CONFLICT DO UPDATE),
  -- не append-log. tenant_id ведущий в PK (T-0013).
  PRIMARY KEY (tenant_id, process_key)
);

ALTER TABLE choros.engine_process_name ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.engine_process_name FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'choros'
      AND tablename  = 'engine_process_name'
      AND policyname = 'engine_process_name_tenant_isolation'
  ) THEN
    CREATE POLICY engine_process_name_tenant_isolation ON choros.engine_process_name
      USING     (tenant_id = current_setting('choros.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.engine_process_name TO choros_app;
