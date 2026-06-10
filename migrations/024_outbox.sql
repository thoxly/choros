-- 024 · choros.outbox (T-0062, E1.2) — транзакционная целостность «данные+сигнал».
--
-- Образец 1:1 — choros.app_timer (011, T-0116): FORCE RLS + default-DENY + partial-индекс.
--
-- Outbox-строка фиксируется в ОДНОЙ Postgres-транзакции с доменной мутацией
-- (атомарность данные+сигнал, CONCEPT §6, AC-8). Доставка — двухфазным
-- диспетчером (см. 025 + src/core/outboxDispatcher.ts).
--
-- RLS-изоляция (аналог app_timer/job, T-0053):
--   - ENABLE + FORCE ROW LEVEL SECURITY (AC-5, AC-6, FF-3).
--   - default-DENY политика на current_setting('choros.tenant_id', true)::uuid.
--   - Без GUC — fail-closed: 0 строк видно, INSERT падает (NF-1).
--   - choros_app: SELECT/INSERT/UPDATE/DELETE, но не DDL (NF-4, owner=choros_migrator).
--
-- Состояние-машина (монотонна вперёд, урок T-0019 no-decrement):
--   pending → dispatching → dispatched   (успех)
--   dispatching → pending                (ретрай, attempts+1, available_at=now+backoff)
--   pending/dispatching → dead           (исчерпание maxAttempts)
-- CHECK outbox_dispatched_at_iff: (state='dispatched') = (dispatched_at IS NOT NULL).
--
-- tenant_id — ведущая колонка PK и ВСЕХ составных индексов (NF-1, FF-LEAD).
-- aggregate_id — opaque-ссылка, НЕ FK (полиморфизм aggregate_kind; ADR §2).

CREATE TABLE choros.outbox (
  tenant_id       uuid    NOT NULL,
  id              uuid    NOT NULL,
  aggregate_kind  text    NOT NULL,
  aggregate_id    uuid    NOT NULL,
  event_type      text    NOT NULL,
  payload         jsonb   NOT NULL,
  state           text    NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'dispatching', 'dispatched', 'dead')),
  idempotency_key text    NOT NULL,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at      bigint  NOT NULL,
  available_at    bigint  NOT NULL,
  dispatched_at   bigint  NULL,
  last_error      text    NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT outbox_dispatched_at_iff
    CHECK ((state = 'dispatched') = (dispatched_at IS NOT NULL))
);

ALTER TABLE choros.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE choros.outbox FORCE ROW LEVEL SECURITY;

-- Default-DENY: без GUC current_setting(..., true) → NULL → предикат false → 0 строк.
CREATE POLICY outbox_tenant_isolation ON choros.outbox
  USING      (tenant_id = current_setting('choros.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('choros.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON choros.outbox TO choros_app;

-- Partial-индекс горячего пути диспетчера: tenant_id ведущий (FF-LEAD, NF-6);
-- WHERE state='pending' (AC-15). Имя содержит 'outbox' и 'pending'.
CREATE INDEX idx_outbox_pending
  ON choros.outbox (tenant_id, available_at)
  WHERE state = 'pending';
