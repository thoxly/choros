-- 130 · list_view.source + list_view.owner_actor (T-0653 · W5-UX/§4 view-primitive)
--
-- ADR: T-0653.spec.md (worktree root). UX-study 2026-07-05 §4: обобщить
-- list_view (T-0581) до VIEW-ПРИМИТИВА платформы — сегодня строка реестра
-- жёстко привязана к registry_def (source подразумевается 'records'); нужен
-- ОТКРЫТЫЙ дискриминатор источника (records|inbox|processes) + ЛИЧНЫЕ
-- сохранённые виды поверх общих тенантных. ADR T-0581 §2/§5 явно предусмотрел
-- «per-user приватные виды добавляются ПОВЕРХ той же таблицы позже (nullable
-- owner_actor)» — это и есть та миграция.
--
-- АДДИТИВНАЯ (NF-2 / обратная совместимость T-0581): существующие строки
-- получают source='records', owner_actor=NULL (общий тенантный records-вид —
-- ровно сегодняшняя семантика). GET /api/records без view-параметров не
-- меняется (records.ts не тронут; FF-VR-6 держится).
--
-- Idempotency (NF-1): ADD COLUMN IF NOT EXISTS; DO-guards на индексы. Runner
-- пропускает по schema_migrations; повтор безопасен.
--
-- Numbering: 129 занят T-0651 (user_pref). Берём 130. Параллельный T-0652
-- миграций НЕ добавляет — конфликта номера не будет. Файл НЕ называется
-- *_list_view_registry.sql (тот 123, читается view-registry-rls.sh) — контракт
-- T-0013 (PK/RLS/policy/GRANT/known_tenant_tables) уже несёт миграция 123, эта
-- лишь расширяет столбцами, RLS-политика list_view_tenant_isolation неизменна.

-- ---------------------------------------------------------------------------
-- source — ОТКРЫТЫЙ дискриминатор источника данных вида.
--   'records'   — вид набора полей приложения (T-0581, требует registry_def_id)
--   'inbox'     — вид рабочего инбокса задач (registry_def_id/application_id NULL)
--   'processes' — вид списка живых инстансов процессов (минимальный контракт)
-- НЕ CHECK-enum (как type в 123): новый источник добавляется валидатором в TS
-- (validateViewSourceConfig, src/core/view-config.ts) БЕЗ DDL-миграции.
-- ---------------------------------------------------------------------------
ALTER TABLE choros.list_view
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'records';

-- ---------------------------------------------------------------------------
-- owner_actor — ЛИЧНЫЙ вид актора (employee slug: human ИЛИ agent). NULL =
-- ОБЩИЙ тенантный вид (сегодняшняя семантика, конфигурация приложения общая).
-- Soft-ref (не FK на employee): stale-владелец безвреден (его личный вид
-- просто перестаёт резолвиться), тот же довод, что user_pref.actor / audit.actor.
-- ЧТЕНИЕ личного вида фильтруется в TS по (owner_actor IS NULL OR
-- owner_actor = <вызывающий>) поверх RLS — чужой личный вид не читается.
-- ---------------------------------------------------------------------------
ALTER TABLE choros.list_view
  ADD COLUMN IF NOT EXISTS owner_actor text NULL;

-- ---------------------------------------------------------------------------
-- registry_def_id/application_id → NULLABLE. inbox/processes-виды не привязаны
-- к набору полей приложения. records-виды по-прежнему НЕСУТ registry_def_id
-- (enforced в TS-валидаторе createView, не в БД — БД допускает NULL для
-- не-records источников). Составные FK (list_view_registry_fk / list_view_app_fk,
-- миграция 123) остаются: PostgreSQL MATCH SIMPLE (по умолчанию) НЕ проверяет
-- составной FK, если ЛЮБОЙ столбец ключа NULL — то есть NULL registry_def_id
-- освобождает строку от FK автоматически, existing non-NULL строки по-прежнему
-- под FK. DROP NOT NULL идемпотентен (повтор — no-op).
-- ---------------------------------------------------------------------------
ALTER TABLE choros.list_view ALTER COLUMN registry_def_id DROP NOT NULL;
ALTER TABLE choros.list_view ALTER COLUMN application_id  DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- Дефолт-уникальность переосмыслена под source + owner_actor.
--
-- Старый индекс list_view_one_default (123) сторожил ≤1 default на
-- (tenant, registry_def_id) WHERE is_default. Теперь дефолт скоупится ещё и по
-- источнику и по владельцу: ОБЩИЙ дефолт (owner_actor NULL) и ЛИЧНЫЙ дефолт
-- (owner_actor = актор) сосуществуют; разные источники не конфликтуют;
-- inbox-виды (registry_def_id NULL) не сваливаются в одну группу через NULL.
--
-- Реализация: заменяем на индекс по
-- (tenant_id, source, COALESCE(registry_def_id, '00..0'::uuid),
--  COALESCE(owner_actor, '')) WHERE is_default.
-- COALESCE на registry_def_id/owner_actor убирает NULL-«не-равно-самому-себе»
-- (иначе UNIQUE на NULL не сработал бы и допустил бы 2 inbox-дефолта).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros' AND tablename = 'list_view'
      AND indexname = 'list_view_one_default'
  ) THEN
    DROP INDEX choros.list_view_one_default;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros' AND tablename = 'list_view'
      AND indexname = 'list_view_one_default_scoped'
  ) THEN
    CREATE UNIQUE INDEX list_view_one_default_scoped
      ON choros.list_view (
        tenant_id,
        source,
        COALESCE(registry_def_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(owner_actor, '')
      )
      WHERE is_default;
  END IF;
END
$$;

-- Lookup index: «виды этого источника, видимые актору» (GET /api/list-views
-- ?source=inbox — общие + личные вызывающего). Дополняет существующий
-- list_view_registry_def_id_idx (records-путь).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'choros' AND tablename = 'list_view'
      AND indexname = 'list_view_source_owner_idx'
  ) THEN
    CREATE INDEX list_view_source_owner_idx
      ON choros.list_view (tenant_id, source, owner_actor);
  END IF;
END
$$;
