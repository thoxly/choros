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
import { useLocation } from 'react-router-dom';
import FormDesigner from '../forms/FormDesigner.jsx';
import FormBuilder from '../forms/FormBuilder.jsx';

const TABS = [
  { key: 'designer', label: 'Конструктор (drag-n-drop)' },
  { key: 'binding', label: 'Привязка полей (запасное)' },
];

function FormsScreen() {
  const [tab, setTab] = useState('designer');
  const location = useLocation();

  // T-0545: AI-emit → канвас. Ассистент передаёт документ через location.state.aiDraft
  // (navigate('/forms', { state: { aiDraft: doc } })). FormDesigner принимает его как
  // initialDocument и открывает для правки человеком (человек — финальный редактор).
  const aiDraft = location.state?.aiDraft ?? null;
  const floor2Flag = location.state?.floor2Flag ?? false;

  return (
    <div className="chs-forms-screen">
      {/* T-0545: Floor-2 badge при кодовом выводе AI (FF-T0545-FLOOR2-FLAG). */}
      {floor2Flag && (
        <div
          className="chs-forms-screen__floor2-banner"
          role="alert"
          style={{
            background: 'var(--chs-color-warning-muted, #fff8e1)',
            borderBottom: '1px solid var(--chs-color-warning, #f59e0b)',
            padding: 'var(--chs-space-2) var(--chs-space-6)',
            fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text)',
          }}
        >
          Черновик от ассистента содержит кастомный код-виджет (Floor-2). Проверьте перед сохранением.
        </div>
      )}
      {/* T-0545: баннер «открыт черновик от ассистента» для прозрачности. */}
      {aiDraft && !floor2Flag && (
        <div
          className="chs-forms-screen__ai-banner"
          role="status"
          style={{
            background: 'var(--chs-color-accent-muted, #eff6ff)',
            borderBottom: '1px solid var(--chs-color-accent, #3b82f6)',
            padding: 'var(--chs-space-2) var(--chs-space-6)',
            fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text)',
          }}
        >
          Черновик от ассистента. Отредактируйте и сохраните.
        </div>
      )}
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
        {/* T-0545: если есть aiDraft, FormDesigner открывается с ним (initialDocument).
            Ключ {aiDraft ? 'ai' : 'clean'} гарантирует ремаунт при смене draft→clean. */}
        {tab === 'designer'
          ? <FormDesigner key={aiDraft ? 'ai-draft' : 'clean'} initialDocument={aiDraft ?? undefined} />
          : <FormBuilder />}
      </div>
    </div>
  );
}

export default FormsScreen;
