-- @demo-seed (T-0732): движковые имена для DEV-тенанта; skip при CHOROS_SEED_DEMO=off (clean prod).
-- 132 · engine_process_name seed — человеко-имена движковых процессов из их BPMN.
--
-- CONTEXT:
--   Таблица 131 (engine_process_name) — оверлей человеко-имён для движковых
--   (source=engine, без строки process_definition) процессов. На стенде такие
--   процессы деплоятся прямо в Flowable из config/flowable/processes/*.bpmn20.xml
--   (bootstrap-tel.ts / ci/checks/flowable/*-smoke.sh) — server-side deploy-путь,
--   который писал бы имя автоматически, отсутствует (config/ не в Docker-образе).
--   Поэтому надёжная доставка имени на живой стенд — @demo-seed миграция
--   (мигратор всегда исполняется; миграции ЕСТЬ в образе, в отличие от config/).
--
-- WHAT THIS ADDS (pure INSERT, zero DDL, zero new tables):
--   Имена для DEV-тенанта двух движковых процессов, дословно из их BPMN
--   <process name="…"> (DATA, не платформенный литерал — фикстура; anti-case-lock
--   сканирует src/ + web/src/, НЕ migrations/):
--     telLinear    → «Канонический линейный ТЭЛ»  (tel-linear.bpmn20.xml)
--     chorosSmoke  → «Choros Smoke Process»        (choros-smoke.bpmn20.xml)
--   После этого resolveDefinitionNames резолвит их СРЕДНИМ ярусом → deriveInstanceTitle
--   (web) показывает человеко-имя вместо демотированного ключа. Общий примитив
--   parseBpmnProcessMeta + registerEngineProcessName (src/) — переиспользуемый
--   deploy-time механизм «парс <process name> при deploy» (тесты + будущий
--   server-side deploy-путь); эта миграция — конкретная идемпотентная доставка.
--
-- IDEMPOTENT: ON CONFLICT (tenant_id, process_key) DO NOTHING. Безопасно повторять.
--   DO NOTHING (не DO UPDATE): если поверх уже легло имя из настоящего deploy-parse
--   (registerEngineProcessName), сид не затирает его — сид лишь гарантирует, что
--   имя ЕСТЬ, а не навязывает своё поверх более свежего.
--
-- DEV_TENANT_UUID = a0000000-0000-0000-0000-000000000001 (как в 085).

INSERT INTO choros.engine_process_name
  (tenant_id, process_key, name, created_at, updated_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'telLinear',   'Канонический линейный ТЭЛ', 0, 0),
  ('a0000000-0000-0000-0000-000000000001', 'chorosSmoke', 'Choros Smoke Process',      0, 0)
ON CONFLICT (tenant_id, process_key) DO NOTHING;
