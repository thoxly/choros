/* ============================================================================
   CHOROS — screen-assistant-prompt.jsx  (T-0383, D5/PD-6/B10)
   Редактор системного промпта ассистента (аналитик / конфигуратор).

   ЖИВЫЕ контракты:
     GET  /api/assistant/prompt/:role  — текущий черновик (или published) промпт.
     PUT  /api/assistant/prompt/:role  — сохранить черновик промпта.
     POST /api/artifacts/promote       — продвинуть черновик в production
                                         (через существующий маршрут T-0087).

   РОЛИ:
     analyst      — промпт аналитика (read-only по данным, структурированный анализ)
     configurator — промпт конфигуратора (DRAFT-only, tool-dispatch)

   СЕМАНТИКА ТИРОВ:
     draft     — черновик (редактируется здесь)
     published — живой (активен в runtime)
     null      — не настроен (тенант получает встроенный дефолт)

   ДИЗАЙН: строго OBLIK — только --chs-* токены, kit-компоненты.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, LoadingState, ErrorState, Field } from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';

// ---------------------------------------------------------------------------
// Token-only styles (OBLIK: consume --chs-* only, no hardcoded color)
// ---------------------------------------------------------------------------
const sectionStyle = {
  background: 'var(--chs-color-surface)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  padding: 'var(--chs-space-7)',
  marginBottom: 'var(--chs-space-7)',
};
const headingStyle = {
  fontSize: 'var(--chs-text-base)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text)',
  margin: '0 0 var(--chs-space-4) 0',
};
const descStyle = {
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text-muted)',
  margin: '0 0 var(--chs-space-6) 0',
};
const tierBadgeStyle = (tier) => ({
  display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)',
  padding: '2px 8px', borderRadius: 'var(--chs-radius-2)',
  fontSize: 'var(--chs-text-xs)', fontWeight: 'var(--chs-weight-medium)',
  background: tier === 'published'
    ? 'var(--chs-color-success-soft)'
    : tier === 'draft'
      ? 'var(--chs-color-warning-soft)'
      : 'var(--chs-color-surface-raised)',
  color: tier === 'published'
    ? 'var(--chs-color-success)'
    : tier === 'draft'
      ? 'var(--chs-color-warning)'
      : 'var(--chs-color-text-muted)',
  border: `1px solid ${tier === 'published'
    ? 'var(--chs-color-success)'
    : tier === 'draft'
      ? 'var(--chs-color-warning)'
      : 'var(--chs-color-border)'}`,
});
const bannerErrStyle = {
  marginTop: 'var(--chs-space-5)',
  padding: 'var(--chs-space-4) var(--chs-space-5)',
  background: 'var(--chs-color-danger-soft)',
  border: '1px solid var(--chs-color-danger)',
  borderRadius: 'var(--chs-radius-3)',
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text)',
};
const bannerOkStyle = {
  marginTop: 'var(--chs-space-5)',
  padding: 'var(--chs-space-4) var(--chs-space-5)',
  background: 'var(--chs-color-success-soft)',
  border: '1px solid var(--chs-color-success)',
  borderRadius: 'var(--chs-radius-3)',
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text)',
};
const textareaStyle = {
  width: '100%', minHeight: 180,
  fontFamily: 'var(--chs-font-mono, monospace)',
  fontSize: 'var(--chs-text-sm)',
  background: 'var(--chs-color-surface-raised)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-2)',
  color: 'var(--chs-color-text)',
  padding: 'var(--chs-space-4)',
  resize: 'vertical',
  boxSizing: 'border-box',
  lineHeight: '1.6',
  outline: 'none',
};
const metaRowStyle = {
  display: 'flex', alignItems: 'center', gap: 'var(--chs-space-4)',
  marginBottom: 'var(--chs-space-5)',
  fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)',
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function tierLabel(tier) {
  if (tier === 'published') return 'опубликован';
  if (tier === 'draft') return 'черновик (не активен)';
  return 'не задан (используется дефолт)';
}

// ---------------------------------------------------------------------------
// PromptEditor — один редактор для одной роли
// ---------------------------------------------------------------------------
function PromptEditor({ role, roleLabel, roleDesc }) {
  const [state, setState] = useState(null);   // null = loading
  const [loadErr, setLoadErr] = useState(null);
  const [text, setText] = useState('');
  const [saveOk, setSaveOk] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showDefault, setShowDefault] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(null);
    setState(null);
    try {
      const res = await fetch(`/api/assistant/prompt/${role}`, { headers: authHeaders() });
      if (res.status === 401) {
        setLoadErr('Войдите в систему для доступа к настройкам ассистента.');
        setState(false);
        return;
      }
      if (!res.ok) {
        setLoadErr(`Ошибка загрузки (HTTP ${res.status}).`);
        setState(false);
        return;
      }
      const data = await res.json();
      setState(data);
      setText(data.text ?? '');
    } catch {
      setLoadErr('Сетевая ошибка — не удалось загрузить промпт.');
      setState(false);
    }
  }, [role]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaveOk(false);
    setSaveErr(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/assistant/prompt/${role}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ text: text.trim() }),
      });
      if (res.ok) {
        setSaveOk(true);
        await load();
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON */ }
      if (res.status === 409) {
        setSaveErr(
          'Промпт опубликован и заблокирован для редактирования. ' +
          'Создайте новую версию через стандартный маршрут продвижения артефактов.'
        );
      } else {
        setSaveErr(parsed?.message ?? `Ошибка сохранения (HTTP ${res.status}).`);
      }
    } catch {
      setSaveErr('Сетевая ошибка — не удалось сохранить промпт.');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setText('');
    setSaveOk(false);
    setSaveErr(null);
  };

  if (state === null) {
    return <LoadingState label={`Загрузка промпта «${roleLabel}»…`} />;
  }

  if (state === false) {
    return (
      <ErrorState
        title={`Не удалось загрузить промпт «${roleLabel}»`}
        message={loadErr ?? 'Неизвестная ошибка.'}
        onRetry={load}
      />
    );
  }

  const effectiveText = state.text ?? '';
  const isUsingDefault = !state.text || state.text.trim() === '';

  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>{roleLabel}</h2>
      <p style={descStyle}>{roleDesc}</p>

      {/* Статус тира */}
      <div style={metaRowStyle}>
        <span style={tierBadgeStyle(state.tier)}>
          {state.tier === 'published' ? '● ' : state.tier === 'draft' ? '◐ ' : '○ '}
          {tierLabel(state.tier)}
        </span>
        {isUsingDefault && (
          <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
            — применяется встроенный промпт (см. ниже)
          </span>
        )}
      </div>

      {/* Форма редактирования */}
      <form onSubmit={handleSave}>
        <div style={{ marginBottom: 'var(--chs-space-3)' }}>
          <label style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)', fontWeight: 'var(--chs-weight-medium)' }}>
            Системный промпт (черновик)
          </label>
        </div>
        <textarea
          style={textareaStyle}
          value={text}
          onChange={(e) => { setText(e.target.value); setSaveOk(false); setSaveErr(null); }}
          placeholder={state.default_text}
          aria-label={`Системный промпт для роли ${roleLabel}`}
          spellCheck={false}
        />
        <p style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', margin: 'var(--chs-space-2) 0 var(--chs-space-5) 0' }}>
          Оставьте пустым, чтобы использовать встроенный дефолтный промпт.
          Изменения сохраняются как черновик и вступают в силу только после продвижения (promote).
        </p>

        {saveErr && <div style={bannerErrStyle}>{saveErr}</div>}
        {saveOk && <div style={bannerOkStyle}>Черновик сохранён. Промпт будет активен после продвижения через /api/artifacts/promote.</div>}

        <div style={{ display: 'flex', gap: 'var(--chs-space-5)', marginTop: 'var(--chs-space-6)', flexWrap: 'wrap' }}>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={saving}
            loading={saving}
          >
            {saving ? 'Сохраняю…' : 'Сохранить черновик'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={handleReset}>
            Очистить (сбросить к дефолту)
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={load}>
            Обновить
          </Button>
        </div>
      </form>

      {/* Дефолтный промпт — раскрываемый */}
      <div style={{ marginTop: 'var(--chs-space-6)' }}>
        <button
          type="button"
          onClick={() => setShowDefault((v) => !v)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--chs-color-accent)', fontSize: 'var(--chs-text-sm)',
            padding: 0, textDecoration: 'underline',
          }}
        >
          {showDefault ? '▲ Скрыть дефолтный промпт' : '▼ Показать дефолтный промпт'}
        </button>
        {showDefault && (
          <pre style={{
            marginTop: 'var(--chs-space-4)',
            padding: 'var(--chs-space-4)',
            background: 'var(--chs-color-surface-raised)',
            border: '1px solid var(--chs-color-border)',
            borderRadius: 'var(--chs-radius-2)',
            fontSize: 'var(--chs-text-xs)',
            color: 'var(--chs-color-text-muted)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6,
            margin: 'var(--chs-space-4) 0 0 0',
          }}>
            {state.default_text}
          </pre>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Экран
// ---------------------------------------------------------------------------
export default function AssistantPromptScreen() {
  return (
    <div>
      <p style={{ ...descStyle, marginBottom: 'var(--chs-space-7)' }}>
        Настройте системный промпт ассистента для вашего тенанта. Изменения сохраняются как
        черновик и вступают в силу только после продвижения (promote) через стандартный маршрут
        артефактов. Оставьте поле пустым, чтобы использовать встроенный дефолт.
      </p>

      <PromptEditor
        role="analyst"
        roleLabel="Аналитик"
        roleDesc="Промпт роли «аналитик» — только чтение и анализ данных. Не должен содержать инструкций по созданию или изменению записей."
      />

      <PromptEditor
        role="configurator"
        roleLabel="Конфигуратор"
        roleDesc="Промпт роли «конфигуратор» — настройка системы через инструменты. Все изменения вносятся в DRAFT; продвижение выполняет человек."
      />

      {/* Справка о тирах */}
      <section style={sectionStyle}>
        <h2 style={headingStyle}>Тиры и продвижение</h2>
        <p style={descStyle}>
          Промпт проходит через стандартный жизненный цикл артефактов Choros:
        </p>
        <ol style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', paddingLeft: 'var(--chs-space-6)', lineHeight: 1.7, margin: 0 }}>
          <li>Сохраните черновик на этом экране.</li>
          <li>
            Продвиньте черновик через{' '}
            <code style={{ fontFamily: 'var(--chs-font-mono, monospace)', fontSize: 'var(--chs-text-xs)', background: 'var(--chs-color-surface-raised)', padding: '1px 4px', borderRadius: 'var(--chs-radius-2)' }}>
              POST /api/artifacts/promote
            </code>
            {' '}(тип: <code style={{ fontFamily: 'var(--chs-font-mono, monospace)', fontSize: 'var(--chs-text-xs)', background: 'var(--chs-color-surface-raised)', padding: '1px 4px', borderRadius: 'var(--chs-radius-2)' }}>agent_instruction</code>).
          </li>
          <li>После продвижения промпт становится активным в runtime.</li>
        </ol>
        <p style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginTop: 'var(--chs-space-4)', marginBottom: 0 }}>
          Черновик отображается в редакторе с меткой «черновик (не активен)» — он не применяется
          в рантайме до продвижения. Это гарантирует, что случайное редактирование не влияет на
          работающий ассистент.
        </p>
      </section>
    </div>
  );
}
