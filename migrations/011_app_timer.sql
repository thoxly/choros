-- 011 · app_timer (T-0116) — durable-планировщик прикладных таймеров.
--
-- Подложка-3: таблица choros.app_timer с FORCE RLS + partial-индекс.
-- Владелец номеров 011_+: T-0116.
--
-- RLS-изоляция: аналог choros.job (T-0053):
--   - ENABLE + FORCE ROW LEVEL SECURITY (AC-14, FF-T3).
--   - Permissive политика на current_setting('choros.tenant_id', true)::uuid.
--   - Без GUC — fail-closed: 0 строк видно, INSERT падает (AC-1, FR-3).
--   - choros_app имеет SELECT/INSERT/UPDATE/DELETE, но не DDL (NF-5).
--
-- Partial-индекс idx_app_timer_pending (tenant_id, due_at) WHERE state='pending'
-- покрывает основной путь fetchAndFire + next_due_buckets (AC-12, NF-2, FF-T2).

CREATE TABLE choros.app_timer (
  tenant_id     uuid   NOT NULL,
  id            uuid   NOT NULL,
  due_at        bigint NOT NULL,
  state         text   NOT NULL CHECK (state IN ('pending', 'firing', 'done', 'cancelled')),
  kind          text   NOT NULL,
  payload       jsonb  NOT NULL,
  created_at    bigint NOT NULL,
  fired_at      bigint NULL,
  cancel_reason text   NULL,
  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE choros.app_timer ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.app_timer FORCE ROW LEVEL SECURITY;

-- Default-DENY: без GUC current_setting(..., true) → NULL → предикат false → 0 строк.
CREATE POLICY app_timer_tenant_isolation ON choros.app_timer
  USING      (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.app_timer TO choros_app;

-- Partial-индекс: tenant_id ведущий (T-0013 §3.1, NF-2); WHERE state='pending'.
-- Имя содержит 'app_timer' и 'pending' (AC-12, FF-T2).
CREATE INDEX idx_app_timer_pending
  ON choros.app_timer (tenant_id, due_at)
  WHERE state = 'pending';
