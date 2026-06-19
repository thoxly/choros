/* ============================================================================
   CHOROS — screen-forms.jsx
   Экран «Формы задач» — демо-раздел рендера form-js из схемы.
   Показывает две формы (Заявка на закупку / Согласование) через FormViewer.
   Тема формы синхронизирована с глобальной темой приложения (prop `theme`).

   T-0250: onSubmit callback получает результат POST /api/forms/:formId/submit
   (success | validation errors) и отображает сводку последнего submit в хинт-баре.
   ============================================================================ */

import React, { useState, useCallback } from 'react';
import { KitIcon } from '../components/components.jsx';
import FormViewer from '../forms/FormViewer.jsx';

const FORM_TABS = [
  { id: 'purchase', label: 'Заявка на закупку' },
  { id: 'approval', label: 'Согласование' },
];

function FormsScreen({ theme }) {
  const [activeForm, setActiveForm] = useState('purchase');
  // Last submit outcome — displayed in the hint bar for quick orientation.
  // null = no submit yet; { ok, label } = last result.
  const [lastSubmit, setLastSubmit] = useState(null);

  const handleSubmit = useCallback((result) => {
    if (result.ok) {
      setLastSubmit({ ok: true, label: 'Отправлено' });
    } else if (result.fields) {
      const count = result.fields.length;
      setLastSubmit({ ok: false, label: `Ошибки: ${count} поле(й)` });
    } else {
      setLastSubmit({ ok: false, label: result.error || 'Ошибка сервера' });
    }
  }, []);

  return (
    <div className="chs-forms-screen">
      {/* Переключатель форм */}
      <div className="chs-forms-screen__bar">
        <div className="chs-tabs">
          {FORM_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="chs-tab"
              aria-selected={activeForm === t.id ? 'true' : undefined}
              onClick={() => { setActiveForm(t.id); setLastSubmit(null); }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="chs-forms-screen__hint">
          {lastSubmit ? (
            <span className={lastSubmit.ok ? 'chs-forms-screen__hint--ok' : 'chs-forms-screen__hint--err'}>
              {lastSubmit.ok && <KitIcon name="success" />}{lastSubmit.ok ? ' ' : ''}{lastSubmit.label}
            </span>
          ) : (
            'Форма исполняется в изолированном sandbox-iframe'
          )}
        </span>
      </div>

      {/* Рендер формы из схемы — onSubmit получает result POST /api/forms/:id/submit */}
      <div className="chs-forms-screen__canvas">
        <FormViewer formKey={activeForm} theme={theme} onSubmit={handleSubmit} />
      </div>
    </div>
  );
}

export default FormsScreen;
