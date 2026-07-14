-- 108 · application.section — бизнес-функция/раздел для группировки в нав РАБОТА (T-0540)
--
-- Additive-safe: добавляем NULL-колонку → нет блокировки существующих строк.
-- Нет NOT NULL, нет DEFAULT (кроме NULL): NULL = «раздел не задан» → fallback-секция «Другое».
-- Нет отдельной таблицы sections — см. ADR T-0540 §3.
-- Нет индекса на section по умолчанию: нав тянет все приложения тенанта (список маленький),
-- SELECT DISTINCT делается по уже загруженным данным. Если нужен индекс → additive позже.

ALTER TABLE choros.application
  ADD COLUMN IF NOT EXISTS section text NULL;
