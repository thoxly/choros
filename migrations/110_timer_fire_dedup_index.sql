-- 109 · audit_event partial unique index для дедупа timer-fire (T-0541)
--
-- TOCTOU-гонка: loop(30с) + on-read оба читают проекцию (нет timer-fire строки),
-- оба вызывают appendNextTaskEvent → два INSERT с разными uuid-id, но одинаковыми
-- (tenant_id, inst, task_def_key) для via='timer-fire'. Второй INSERT нарушает
-- данный индекс → constraint-error → best-effort catch в reconcileInstanceTimers
-- поглощает ошибку → один ряд в таблице, не два.
--
-- Почему partial (WHERE via = 'timer-fire'):
--   - inbox-approve next_task (via='inbox-approve') одного defKey может появляться
--     честно несколько раз (разные ветки процесса, future feature). Ограничиваем
--     только timer-fire — единственный путь с TOCTOU-дублём.
--   - Не ломает существующие process.started / task.approved / instance.ended —
--     у них другой via (process-start, inbox-approve).
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS.
-- Нет RLS-правок: индекс на существующей таблице с BYPASSRLS-мигратором — ОК.
-- Нет блокировки данных: append-only таблица, INSERT-only права у choros_app.

CREATE UNIQUE INDEX IF NOT EXISTS audit_event_timer_fire_dedup
  ON choros.audit_event (
    tenant_id,
    (payload->>'inst'),
    (payload->>'task_def_key')
  )
  WHERE via = 'timer-fire';
