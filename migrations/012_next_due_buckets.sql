-- 012 · next_due_buckets (T-0116) — SECURITY DEFINER-агрегат для фазы-1 dispatcher.
--
-- Функция choros.next_due_buckets(p_due_before bigint) возвращает ТОЛЬКО
-- агрегат (tenant_id uuid, timer_count bigint) — никаких строк таймеров.
-- Работает как SECURITY DEFINER (видит все тенанты, обходит RLS).
-- Не требует GUC choros.tenant_id (AC-4, AC-5, FR-4, FF-T5).
--
-- Права: choros_app имеет только EXECUTE (не ALTER/DROP) — NF-5, FF-T10.
-- Owner: choros_migrator (наследуется от CURRENT_USER при применении миграции).

CREATE OR REPLACE FUNCTION choros.next_due_buckets(p_due_before bigint)
RETURNS TABLE(tenant_id uuid, timer_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = choros, pg_catalog
STABLE
AS $$
  SELECT tenant_id, COUNT(*)::bigint AS timer_count
  FROM choros.app_timer
  WHERE state = 'pending' AND due_at < p_due_before
  GROUP BY tenant_id;
$$;

-- Запрет PUBLIC; только явные грантополучатели.
REVOKE ALL ON FUNCTION choros.next_due_buckets(bigint) FROM PUBLIC;

-- choros_app: только EXECUTE (не DDL).
GRANT EXECUTE ON FUNCTION choros.next_due_buckets(bigint) TO choros_app;
