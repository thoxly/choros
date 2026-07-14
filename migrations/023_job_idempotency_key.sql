-- 023 · job.idempotency_key (T-0062, E1.2) — идемпотентность enqueue.
--
-- ШОВ ПРОГОНА (ADR §ШОВ): номера 023+ для T-0062 (022 = T-0034, 019-021 = T-0022).
-- Раннер migrations/run.mjs применяет лексикографически только отсутствующие версии.
--
-- Аддитивная nullable-колонка choros.job.idempotency_key (≤255, CHECK) +
-- partial-unique (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL.
--   - Nullable: отсутствие ключа = текущее поведение (обратная совместимость, AC-3).
--   - Partial-unique → дубли по (tenant_id, idempotency_key) невозможны (AC-2, AC-4);
--     кросс-тенантно ключи независимы (tenant_id ведущий — FF-LEAD).
--   - КОЛОНКА, не таблица → known_tenant_tables.txt из-за неё НЕ трогается (NF-2).
--   - complete/fail НЕ затрагиваются (ownership-gate frozen, FF-9).

ALTER TABLE choros.job ADD COLUMN IF NOT EXISTS idempotency_key text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'job_idempotency_key_len'
  ) THEN
    ALTER TABLE choros.job ADD CONSTRAINT job_idempotency_key_len
      CHECK (idempotency_key IS NULL OR char_length(idempotency_key) <= 255);
  END IF;
END $$;

-- Partial-unique: tenant_id ведущий (FF-LEAD, T-0013 §3.1); предикат NOT NULL (AC-4).
CREATE UNIQUE INDEX IF NOT EXISTS job_idempotency_key_uq
  ON choros.job (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
