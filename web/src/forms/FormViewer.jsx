/* ============================================================================
   CHOROS — FormViewer.jsx
   Компонент рендера формы из схемы (form-defs.js) в изолированном sandbox-iframe.

   Архитектура:
   - form-defs.js  → CHOROS_FORMS (HTML-строки) + CHOROS_SANDBOX_SCRIPT (рантайм)
   - form-theme.css → встраивается в srcdoc как инлайн <style> (iframe = опаковый
     origin, наследование снаружи не работает)
   - Высота iframe авто-подстраивается через postMessage { type: 'fjs-height', h }
     (см. SANDBOX_SCRIPT в form-defs.js).

   Props:
   - formKey: 'purchase' | 'approval'  — ключ из CHOROS_FORMS
   - theme:   'dark' | 'light'         — data-theme на <html> внутри iframe
   ============================================================================ */

import React, { useEffect, useRef, useState } from 'react';

// Импорт CSS-темы как строки (Vite: суффикс ?inline)
import formThemeCss from './form-theme.css?inline';

// Подключаем form-defs — регистрирует window.CHOROS_FORMS, window.CHOROS_SANDBOX_SCRIPT
import './form-defs.js';

// Чистый origin-валидирующий приёмник авто-высоты (T-0101). Принимает height ТОЛЬКО
// от своего iframe-окна И опакового origin ('null') И корректной формы сообщения,
// и клампит её — а не доверяет любому postMessage.
import { acceptFrameHeight, FRAME_MIN_HEIGHT } from './frame-height.js';

const MIN_HEIGHT = FRAME_MIN_HEIGHT;

/**
 * Собирает полный srcdoc для sandbox-iframe одной формы.
 * @param {string} formHtml  — HTML-строка формы из CHOROS_FORMS
 * @param {string} theme     — 'dark' | 'light'
 * @param {string} css       — содержимое form-theme.css (строка)
 * @param {string} script    — CHOROS_SANDBOX_SCRIPT (строка)
 */
function buildSrcdoc(formHtml, theme, css, script) {
  const safeTheme = ['dark', 'light'].includes(theme) ? theme : 'dark';
  return `<!DOCTYPE html>
<html lang="ru" data-theme="${safeTheme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
</head>
<body>${formHtml}<script>${script}<\/script></body>
</html>`;
}

function FormViewer({ formKey, theme }) {
  const iframeRef = useRef(null);
  const [height, setHeight] = useState(MIN_HEIGHT);

  // Слушаем fjs-height от sandbox. Вся валидация (source + опаковый origin 'null'
  // + форма сообщения + клампинг) — в чистой acceptFrameHeight (T-0101): любое
  // сообщение от чужого окна/origin/неверной формы возвращает null и игнорируется.
  useEffect(() => {
    function onMessage(e) {
      const win = iframeRef.current && iframeRef.current.contentWindow;
      if (!win) return;
      const h = acceptFrameHeight(e, win);
      if (h !== null) setHeight(h);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Строим srcdoc при смене формы или темы
  const srcdoc = React.useMemo(() => {
    const forms = window.CHOROS_FORMS;
    const script = window.CHOROS_SANDBOX_SCRIPT;
    if (!forms || !forms[formKey]) return '';
    return buildSrcdoc(forms[formKey], theme || 'dark', formThemeCss, script || '');
  }, [formKey, theme]);

  // Сброс высоты при смене формы
  useEffect(() => {
    setHeight(MIN_HEIGHT);
  }, [formKey]);

  return (
    <iframe
      ref={iframeRef}
      className="chs-form-viewer"
      title={formKey === 'purchase' ? 'Заявка на закупку' : 'Согласование закупки'}
      srcDoc={srcdoc}
      sandbox="allow-scripts"
      style={{ height: height + 'px' }}
      aria-label={formKey === 'purchase' ? 'Форма заявки на закупку' : 'Форма согласования закупки'}
    />
  );
}

export default FormViewer;
