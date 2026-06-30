/* ============================================================================
   T-0526 — confirm-helpers.jsx
   Утилиты для гейтирования деструктивных действий через ConfirmDialog.

   Экспорты:
     ConsequenceSummary  — именованный блок кто/что/обратимость (§3 дизайна).
     useDestructiveConfirm — хук двух-фазного open/confirm паттерна.
   ============================================================================ */

import React, { useState, useCallback } from 'react';

/* ---------------------------------------------------------------------------
   ConsequenceSummary — описывает последствия деструктивного действия.
   Передаётся в message-prop ConfirmDialog.

   Props:
     who          — кто затронут (строка или React-элемент)
     what         — что произойдёт
     reversibility — обратимость (строка)
   --------------------------------------------------------------------------- */
export function ConsequenceSummary({ who, what, reversibility }) {
  return (
    <div className="chs-consequence">
      <dl className="chs-consequence__dl">
        <dt className="chs-consequence__dt">Затронуто</dt>
        <dd className="chs-consequence__dd">{who}</dd>
        <dt className="chs-consequence__dt">Действие</dt>
        <dd className="chs-consequence__dd">{what}</dd>
        <dt className="chs-consequence__dt">Обратимость</dt>
        <dd className="chs-consequence__dd chs-consequence__dd--rev">{reversibility}</dd>
      </dl>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   useDestructiveConfirm — инкапсулирует двух-фазный паттерн открытия/подтверждения.

   Использование:
     const dc = useDestructiveConfirm();
     // При клике на кнопку:
     dc.request(targetId);          // открывает диалог с целевым объектом
     // В ConfirmDialog:
     open={dc.open}
     onConfirm={() => dc.confirm(() => performDelete(dc.target))}
     onClose={dc.cancel}

   Возвращает: { open, target, loading, request, confirm, cancel }
   --------------------------------------------------------------------------- */
export function useDestructiveConfirm() {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(null);
  const [loading, setLoading] = useState(false);

  const request = useCallback((t) => {
    setTarget(t);
    setOpen(true);
  }, []);

  const confirm = useCallback(async (fn) => {
    if (loading) return;
    setLoading(true);
    try {
      await fn(target);
    } finally {
      setLoading(false);
      setOpen(false);
      setTarget(null);
    }
  }, [loading, target]);

  const cancel = useCallback(() => {
    if (loading) return;
    setOpen(false);
    setTarget(null);
  }, [loading]);

  return { open, target, loading, request, confirm, cancel };
}
