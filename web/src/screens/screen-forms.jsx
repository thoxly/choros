/* ============================================================================
   CHOROS — screen-forms.jsx
   Экран «Формы задач» — два режима:
     1. Предпросмотр  — демо-рендер ТЭЛ-форм через FormViewer (sandbox-iframe).
     2. Конструктор   — FormBuilder: вывод полей из registry_def + привязка к шагу
                        процесса (userTask) через POST /api/forms/binding (T-0376).

   T-0250: onSubmit callback получает результат POST /api/forms/:formId/submit
   (success | validation errors) и отображает сводку последнего submit в хинт-баре.
   T-0376: FormBuilder tab — derive fields from real app registry_def (PD-9),
   configure labels/order/required, bind to a process step.
   ============================================================================ */

import React, { useState, useCallback } from 'react';
import { KitIcon } from '../components/components.jsx';
import FormViewer from '../forms/FormViewer.jsx';
import FormBuilder from '../forms/FormBuilder.jsx';

const TOP_TABS = [
  { id: 'preview', label: 'Предпросмотр ТЭЛ-форм' },
  { id: 'builder', label: 'Конструктор форм' },
];

const FORM_TABS = [
  { id: 'purchase', label: 'Заявка на закупку' },
  { id: 'approval', label: 'Согласование' },
];

function FormsScreen({ theme }) {
  const [topTab, setTopTab] = useState('preview');
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
      {/* Top tab switcher: preview vs builder */}
      <div className="chs-forms-screen__bar" style={{ borderBottom: '1px solid var(--chs-color-border)' }}>
        <div className="chs-tabs">
          {TOP_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="chs-tab"
              aria-selected={topTab === t.id ? 'true' : undefined}
              onClick={() => { setTopTab(t.id); setLastSubmit(null); }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {topTab === 'preview' && (
        <>
          {/* Form switcher for preview */}
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

          {/* Form render via sandbox iframe */}
          <div className="chs-forms-screen__canvas">
            <FormViewer formKey={activeForm} theme={theme} onSubmit={handleSubmit} />
          </div>
        </>
      )}

      {topTab === 'builder' && (
        <div className="chs-forms-screen__canvas" style={{ padding: 'var(--chs-space-6)' }}>
          <FormBuilder />
        </div>
      )}
    </div>
  );
}

export default FormsScreen;
