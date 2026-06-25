/* ============================================================================
   CHOROS — screen-forms.jsx
   T-0482 [F3]: Экран «Привязка форм к шагам».

   Показывает ТОЛЬКО FormBuilder (POST /api/forms/binding, T-0376):
   выбрать процесс + шаг userTask → выбрать набор полей registry_def →
   настроить метки/порядок/обязательность → сохранить привязку.

   Что УБРАНО (T-0482 cleanup):
     • Вкладка «Предпросмотр ТЭЛ-форм» + FormViewer (sandbox-iframe с hardcoded
       ТЭЛ-формами purchase/approval). Она была демо-mockup, не рабочим инструментом.
     • Переключатель форм (FORM_TABS: «Заявка на закупку» / «Согласование»).

   Что осталось и где живёт:
     • ЗАПИСЬ form — автогенерируется из registry_def через единый рендерер
       FieldControl (field-renderer.jsx, T-0480) в screen-app-records.jsx +
       screen-inbox.jsx. Авторинг: конструктор полей /app-schema/:appId.
     • ШАГ form — настраивается прямо в модельере через UserTaskFormBindingPanel
       (bpmn-properties-panel.jsx, T-0461): клик на userTask → вкладка «Форма».

   Nav: пункт «Формы задач» скрыт из сайдбара (nav-config.js hidden: true).
   Роутинг /forms остаётся — экран доступен прямой ссылкой для авторинга.
   ============================================================================ */

import React from 'react';
import FormBuilder from '../forms/FormBuilder.jsx';

function FormsScreen() {
  return (
    <div className="chs-forms-screen">
      <div className="chs-forms-screen__canvas" style={{ padding: 'var(--chs-space-6)' }}>
        <FormBuilder />
      </div>
    </div>
  );
}

export default FormsScreen;
