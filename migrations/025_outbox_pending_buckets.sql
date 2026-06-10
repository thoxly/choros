-- 025 · outbox_pending_buckets (T-0062, E1.2) — SECURITY DEFINER-агрегат фазы-1.
--
-- Образец 1:1 — choros.next_due_buckets (012, T-0116).
--
-- Функция choros.outbox_pending_buckets(p_before bigint) возвращает ТОЛЬКО
-- агрегат (tenant_id uuid, pending_count bigint) — ровно 2 колонки (AC-10),
-- никаких строк данных (ни payload, ни id). Работает как SECURITY DEFINER
-- (видит все тенанты, обходит RLS), НЕ требует GUC choros.tenant_id (AC-9, FF-6).
-- search_path захардкожен (защита от перехвата через search_path).
--
-- Права: choros_app имеет только EXECUTE (не ALTER/DROP) — NF-4.
-- Owner: choros_migrator (наследуется от CURRENT_USER при применении миграции).

CREATE OR REPLACE FUNCTION choros.outbox_pending_buckets(p_before bigint)
RETURNS TABLE(tenant_id uuid, pending_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = choros, pg_catalog
STABLE
AS $$
  SELECT tenant_id, COUNT(*)::bigint AS pending_count
  FROM choros.outbox
  WHERE state = 'pending' AND available_at <= p_before
  GROUP BY tenant_id;
$$;

-- Запрет PUBLIC; только явные грантополучатели.
REVOKE ALL ON FUNCTION choros.outbox_pending_buckets(bigint) FROM PUBLIC;

-- choros_app: только EXECUTE (не DDL).
GRANT EXECUTE ON FUNCTION choros.outbox_pending_buckets(bigint) TO choros_app;
