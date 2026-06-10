-- 029 · job_locked_expired_buckets + outbox idempotency_key UNIQUE (T-0063, E1.3)
--
-- Part A: Partial UNIQUE constraint on choros.outbox (tenant_id, idempotency_key)
--   WHERE idempotency_key IS NOT NULL — required for enqueueInTx ON CONFLICT DO NOTHING
--   idempotency (ADR §6, AC-5). This is an additive schema extension that doesn't
--   affect existing rows (idempotency_key was NOT NULL but without a uniqueness guard
--   prior to this migration). IF NOT EXISTS makes the constraint idempotent.
--
-- Part B: SECURITY DEFINER-агрегат фазы-1 (образец 1:1 — choros.outbox_pending_buckets 025).
--
-- Функция choros.job_locked_expired_buckets(p_before bigint) возвращает ТОЛЬКО
-- агрегат (tenant_id uuid, expired_count bigint) — ровно 2 колонки,
-- никаких строк данных (ни payload, ни id). Работает как SECURITY DEFINER
-- (видит все тенанты, обходит RLS), НЕ требует GUC choros.tenant_id.
-- search_path захардкожен (защита от перехвата через search_path).
--
-- Использует существующий индекс idx_job_fetchable_locked (migration 010):
--   WHERE state='LOCKED' — попадает в частичный индекс.
--
-- Права: choros_app имеет только EXECUTE (не ALTER/DROP) — NF-4.
-- Owner: choros_migrator (наследуется от CURRENT_USER при применении миграции).
-- Идемпотентность: CREATE OR REPLACE FUNCTION + CREATE INDEX IF NOT EXISTS (AC-14, FF-12).

-- Part A: Partial UNIQUE index on outbox (tenant_id, idempotency_key) WHERE NOT NULL.
-- Provides the constraint target for ON CONFLICT (tenant_id, idempotency_key)
-- WHERE idempotency_key IS NOT NULL DO NOTHING in enqueueInTx.
-- CREATE INDEX IF NOT EXISTS = idempotent (second run is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS outbox_idempotency_key_uq
  ON choros.outbox (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Part B: SECURITY DEFINER aggregate for cross-tenant lock-expiry bucket discovery.

CREATE OR REPLACE FUNCTION choros.job_locked_expired_buckets(p_before bigint)
RETURNS TABLE(tenant_id uuid, expired_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = choros, pg_catalog
STABLE
AS $$
  SELECT tenant_id, COUNT(*)::bigint AS expired_count
  FROM choros.job
  WHERE state = 'LOCKED' AND lock_expiry <= p_before
  GROUP BY tenant_id;
$$;

-- Запрет PUBLIC; только явные грантополучатели.
REVOKE ALL ON FUNCTION choros.job_locked_expired_buckets(bigint) FROM PUBLIC;

-- choros_app: только EXECUTE (не DDL).
GRANT EXECUTE ON FUNCTION choros.job_locked_expired_buckets(bigint) TO choros_app;
