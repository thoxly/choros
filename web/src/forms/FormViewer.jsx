/* ============================================================================
   CHOROS — FormViewer.jsx
   Компонент рендера формы из схемы (form-defs.js) в изолированном sandbox-iframe.

   Архитектура:
   - form-defs.js  → CHOROS_FORMS (HTML-строки) + CHOROS_SANDBOX_SCRIPT (рантайм)
   - form-theme.css → встраивается в srcdoc как инлайн <style> (iframe = опаковый
     origin, наследование снаружи не работает)
   - Высота iframe авто-подстраивается через postMessage { type: 'fjs-height', h }
     (см. SANDBOX_SCRIPT в form-defs.js, T-0101 acceptFrameHeight).
   - Submit: sandbox постит { type: 'fjs-submit', value } → acceptFrameSubmit →
     fetch POST /api/forms/:formId/submit → success | field errors (T-0250).

   Props:
   - formKey:  'purchase' | 'approval'  — ключ из CHOROS_FORMS
   - theme:    'dark' | 'light'         — data-theme на <html> внутри iframe;
               НЕОБЯЗАТЕЛЕН: если не передан, форма НАСЛЕДУЕТ активную тему
               приложения (data-theme на <html>), а при её отсутствии — светлую
               (основную). Это чинит корень бага аудита #1: раньше форма дефолтила
               в тёмное и при светлом приложении рендерила нечитаемый ввод.
   - onSubmit: optional callback(result) — вызывается после успешного ответа сервера
                 result = { ok: true, formId, value } | { ok: false, fields: FieldError[] }
   ============================================================================ */

import React, { useEffect, useRef, useState } from 'react';

// Импорт CSS-темы как строки (Vite: суффикс ?inline)
import { KitIcon } from '../components/components.jsx';
import formThemeCss from './form-theme.css?inline';

// Подключаем form-defs — регистрирует window.CHOROS_FORMS, window.CHOROS_SANDBOX_SCRIPT
import './form-defs.js';

// Чистые origin-валидирующие приёмники (T-0101 + T-0250):
//   acceptFrameHeight — высота (T-0101)
//   acceptFrameSubmit — поля формы для POST (T-0250)
// Оба принимают сообщения ТОЛЬКО от своего iframe-окна И опакового origin ('null')
// И корректной формы — и возвращают null при любом нарушении.
import { acceptFrameHeight, acceptFrameSubmit, FRAME_MIN_HEIGHT } from './frame-height.js';

// T-0258: auth headers come from the shared mode-aware helper (X-Dev-User in
// dev mode, Authorization: Bearer in keycloak mode) — no hardcoded dev stub.
import { authHeaders } from '../app-shell/dev-auth.js';

const MIN_HEIGHT = FRAME_MIN_HEIGHT;

/**
 * Активная тема приложения с <html data-theme> (фолбэк — светлая, ОСНОВНАЯ).
 * Источник истины для наследования темы формой, когда проп theme не передан.
 * @returns {'light' | 'dark'}
 */
function appTheme() {
  if (typeof document === 'undefined') return 'light';
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' ? 'dark' : 'light';
}

/**
 * Собирает полный srcdoc для sandbox-iframe одной формы.
 * @param {string} formHtml  — HTML-строка формы из CHOROS_FORMS
 * @param {string} theme     — 'dark' | 'light'; если невалиден — наследует тему
 *                             приложения (appTheme), а не дефолтит в тёмное.
 * @param {string} css       — содержимое form-theme.css (строка)
 * @param {string} script    — CHOROS_SANDBOX_SCRIPT (строка)
 */
function buildSrcdoc(formHtml, theme, css, script) {
  // НЕ дефолтим в 'dark': непереданная/невалидная тема → активная тема приложения
  // (светлая основная при отсутствии атрибута). Корень бага аудита #1.
  const safeTheme = ['dark', 'light'].includes(theme) ? theme : appTheme();
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

/**
 * FormViewer — sandbox-iframe для одной формы с submit-каналом.
 *
 * @param {{ formKey: string, theme?: string, onSubmit?: (result: object) => void }} props
 */
function FormViewer({ formKey, theme, onSubmit }) {
  const iframeRef = useRef(null);
  const [height, setHeight] = useState(MIN_HEIGHT);

  // Тема, которую реально отдаём форме: явный проп → иначе наследуем активную
  // тему приложения (<html data-theme>, светлая основная по умолчанию).
  // appThemeState следит за сменой темы приложения, пока форма открыта, чтобы
  // iframe пере-рендерился в новую тему (а не застрял в стартовой).
  const [appThemeState, setAppThemeState] = useState(() => appTheme());
  useEffect(() => {
    if (theme || typeof MutationObserver === 'undefined') return undefined;
    const obs = new MutationObserver(() => setAppThemeState(appTheme()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => obs.disconnect();
  }, [theme]);
  const effectiveTheme = theme || appThemeState;

  // Submit state: idle | pending | success | validation_error | network_error
  const [submitState, setSubmitState] = useState('idle');
  // Success payload from server (sanitized value + recordId)
  const [submitResult, setSubmitResult] = useState(null);
  // Field-level validation errors from server: { [fieldKey]: string }
  const [fieldErrors, setFieldErrors] = useState(null);

  // Слушаем fjs-height + fjs-submit от sandbox. Вся валидация (source + опаковый
  // origin 'null' + форма сообщения) — в чистых acceptFrame* (T-0101/T-0250).
  useEffect(() => {
    function onMessage(e) {
      const win = iframeRef.current && iframeRef.current.contentWindow;
      if (!win) return;

      // fjs-height channel (T-0101)
      const h = acceptFrameHeight(e, win);
      if (h !== null) { setHeight(h); return; }

      // fjs-submit channel (T-0250)
      const value = acceptFrameSubmit(e, win);
      if (value !== null) {
        handleSubmit(value);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey]);

  /**
   * POST the form field values to /api/forms/:formId/submit.
   * Renders success (sanitized value / recordId) or field-level errors.
   * @param {Record<string,unknown>} value
   */
  async function handleSubmit(value) {
    setSubmitState('pending');
    setSubmitResult(null);
    setFieldErrors(null);

    try {
      const res = await fetch(`/api/forms/${encodeURIComponent(formKey)}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify(value),
      });

      const json = await res.json().catch(() => null);

      if (res.ok && json && json.ok) {
        // 200 — sanitized value returned by server
        setSubmitState('success');
        setSubmitResult(json);
        if (onSubmit) onSubmit({ ok: true, formId: json.formId, value: json.value });
      } else if (res.status === 400 && json && json.error && json.error.code === 'VALIDATION') {
        // 400 VALIDATION — field-level errors
        const errs = {};
        (json.error.fields || []).forEach((f) => { errs[f.key] = f.message; });
        setSubmitState('validation_error');
        setFieldErrors(errs);
        if (onSubmit) onSubmit({ ok: false, fields: json.error.fields });
      } else {
        // Other server error (404 UNKNOWN_FORM, 401, etc.)
        setSubmitState('network_error');
        const msg = json && json.error ? json.error.message : `HTTP ${res.status}`;
        setFieldErrors({ _server: msg });
        if (onSubmit) onSubmit({ ok: false, error: msg });
      }
    } catch (err) {
      setSubmitState('network_error');
      setFieldErrors({ _server: err.message || 'Network error' });
      if (onSubmit) onSubmit({ ok: false, error: err.message || 'Network error' });
    }
  }

  // Строим srcdoc при смене формы или темы. Тема НАСЛЕДУЕТСЯ от приложения
  // (effectiveTheme), а не дефолтит в 'dark' — корень бага аудита #1.
  const srcdoc = React.useMemo(() => {
    const forms = window.CHOROS_FORMS;
    const script = window.CHOROS_SANDBOX_SCRIPT;
    if (!forms || !forms[formKey]) return '';
    return buildSrcdoc(forms[formKey], effectiveTheme, formThemeCss, script || '');
  }, [formKey, effectiveTheme]);

  // Сброс высоты + submit state при смене формы
  useEffect(() => {
    setHeight(MIN_HEIGHT);
    setSubmitState('idle');
    setSubmitResult(null);
    setFieldErrors(null);
  }, [formKey]);

  return (
    <div className="chs-form-viewer-wrap">
      <iframe
        ref={iframeRef}
        className="chs-form-viewer"
        title={formKey === 'purchase' ? 'Заявка на закупку' : 'Согласование закупки'}
        srcDoc={srcdoc}
        sandbox="allow-scripts allow-forms"
        style={{ height: height + 'px' }}
        aria-label={formKey === 'purchase' ? 'Форма заявки на закупку' : 'Форма согласования закупки'}
      />
      {/* Submit result panel — shown below the iframe */}
      {submitState === 'pending' && (
        <div className="chs-form-result chs-form-result--pending" role="status" aria-live="polite">
          Отправка…
        </div>
      )}
      {submitState === 'success' && submitResult && (
        <div className="chs-form-result chs-form-result--success" role="status" aria-live="polite">
          <span className="chs-form-result__icon" aria-hidden="true"><KitIcon name="success" /></span>
          <span>
            Форма отправлена.
            {submitResult.value && submitResult.value.recordId
              ? ` Запись: ${submitResult.value.recordId}.`
              : ''}
          </span>
        </div>
      )}
      {submitState === 'validation_error' && fieldErrors && (
        <div className="chs-form-result chs-form-result--error" role="alert">
          <strong>Ошибки валидации:</strong>
          <ul className="chs-form-result__errors">
            {Object.entries(fieldErrors).map(([key, msg]) => (
              <li key={key}>
                <span className="chs-form-result__field">{key}</span>: {msg}
              </li>
            ))}
          </ul>
        </div>
      )}
      {submitState === 'network_error' && fieldErrors && fieldErrors._server && (
        <div className="chs-form-result chs-form-result--error" role="alert">
          Ошибка сервера: {fieldErrors._server}
        </div>
      )}
    </div>
  );
}

export default FormViewer;
