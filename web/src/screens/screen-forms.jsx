/* ============================================================================
   CHOROS — screen-forms.jsx
   Экран «Формы задач» — демо-раздел рендера form-js из схемы.
   Показывает две формы (Заявка на закупку / Согласование) через FormViewer.
   Тема формы синхронизирована с глобальной темой приложения (prop `theme`).
   ============================================================================ */

import React, { useState } from 'react';
import FormViewer from '../forms/FormViewer.jsx';

const FORM_TABS = [
  { id: 'purchase', label: 'Заявка на закупку' },
  { id: 'approval', label: 'Согласование' },
];

function FormsScreen({ theme }) {
  const [activeForm, setActiveForm] = useState('purchase');

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
              onClick={() => setActiveForm(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="chs-forms-screen__hint">
          Форма исполняется в изолированном sandbox-iframe
        </span>
      </div>

      {/* Рендер формы из схемы */}
      <div className="chs-forms-screen__canvas">
        <FormViewer formKey={activeForm} theme={theme} />
      </div>
    </div>
  );
}

export default FormsScreen;
