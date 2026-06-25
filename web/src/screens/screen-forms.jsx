/* ============================================================================
   CHOROS — screen-forms.jsx
   T-0482 [F3] → T-0481 [F2]: Экран «Конструктор форм».

   ОСНОВНАЯ поверхность авторинга — drag-n-drop конструктор форм (FormDesigner,
   T-0481): собери форму из ВЕТТЕД-ПАЛИТРЫ (поле / таблица-позиции / итог /
   разделитель / связь / секции-колонки-вкладки + код-виджет в песочнице).
   Раскладка = декларативный форма-документ; ИИ эмитит ТОТ ЖЕ документ
   (form-document-emit.js). Рендерит один рендерер (FormDocumentRenderer).

   ЗАПАСНАЯ поверхность — FormBuilder (T-0376): кнопочная привязка полей к шагу
   (вырожденный fallback per forms-data-contract-foundation.spec §6 — не
   самостоятельный продукт). Доступна вкладкой.

   Nav: пункт «Формы задач» в сайдбаре (nav-config.js). Роутинг /forms.
   ============================================================================ */

import React, { useState } from 'react';
import FormDesigner from '../forms/FormDesigner.jsx';
import FormBuilder from '../forms/FormBuilder.jsx';

const TABS = [
  { key: 'designer', label: 'Конструктор (drag-n-drop)' },
  { key: 'binding', label: 'Привязка полей (запасное)' },
];

function FormsScreen() {
  const [tab, setTab] = useState('designer');
  return (
    <div className="chs-forms-screen">
      <div className="chs-forms-screen__tabs" role="tablist" style={{ display: 'flex', gap: 'var(--chs-space-2)', padding: 'var(--chs-space-4) var(--chs-space-6) 0' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`chs-btn chs-btn--ghost${tab === t.key ? ' chs-btn--active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="chs-forms-screen__canvas" style={{ padding: 'var(--chs-space-6)' }}>
        {tab === 'designer' ? <FormDesigner /> : <FormBuilder />}
      </div>
    </div>
  );
}

export default FormsScreen;
