/* ============================================================================
   CHOROS — screen-llm-config.jsx  (T-0382, D5)
   LLM-подключение: настройка BYO LLM для тенанта.

   ЖИВЫЕ контракты:
     GET  /api/llm-config   — текущий провайдер/эндпойнт/модель (без ключа).
     PUT  /api/llm-config   — сохранить эндпойнт + модель в agent_card.
     POST /api/agents/:id/secret-handle  — привязать секрет-хэндл (существующий
          маршрут из screen-agents.jsx / T-0025). Ссылка на экран «Агенты».

   БЕЗОПАСНОСТЬ:
     - llm_secret_handle НИКОГДА не возвращается на клиент (только secret_bound:bool).
     - Ключ LLM НЕ принимается этим экраном — только ссылка-хэндл через отдельный
       маршрут (POST /api/agents/:id/secret-handle, T-0025).
     - Поля endpoint + model — не секреты, сохраняются открыто в agent_card.

   ДИЗАЙН: строго OBLIK — только --chs-* токены, kit-компоненты.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, LoadingState, ErrorState, EmptyState, Field, Select } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';

// ---------------------------------------------------------------------------
// Provider presets (endpoint + model defaults) — helps users fill the form quickly.
// ---------------------------------------------------------------------------
const PROVIDER_PRESETS = [
  {
    value: 'deepseek',
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    handleHint: 'env://DEEPSEEK_API_KEY',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    handleHint: 'env://OPENAI_API_KEY',
  },
  {
    value: 'anthropic-proxy',
    label: 'Anthropic (через OpenAI-совместимый прокси)',
    endpoint: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-20241022',
    handleHint: 'env://ANTHROPIC_API_KEY',
  },
  {
    value: 'self-hosted',
    label: 'Свой эндпойнт (self-hosted / Ollama / vLLM)',
    endpoint: '',
    model: '',
    handleHint: 'env://MY_LLM_KEY',
  },
];

// ---------------------------------------------------------------------------
// Token-only styles (OBLIK: --chs-* only)
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
const fieldGap = {
  display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-6)',
};
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
const statusRowStyle = {
  display: 'flex', alignItems: 'center', gap: 'var(--chs-space-4)',
  fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)',
  marginBottom: 'var(--chs-space-5)',
};
const dotStyle = (active) => ({
  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
  background: active ? 'var(--chs-color-success)' : 'var(--chs-color-text-muted)',
});
const monoStyle = {
  fontFamily: 'var(--chs-font-mono, monospace)',
  fontSize: 'var(--chs-text-xs)',
  background: 'var(--chs-color-surface-raised)',
  padding: '2px 6px',
  borderRadius: 'var(--chs-radius-2)',
  color: 'var(--chs-color-text)',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function LlmConfigScreen() {
  const [config, setConfig] = useState(null);   // null = loading, false = error
  const [loadErr, setLoadErr] = useState(null);

  // Form state
  const [preset, setPreset] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitErr, setSubmitErr] = useState(null);
  const [saveOk, setSaveOk] = useState(false);
  const [saving, setSaving] = useState(false);

  // ---------------------------------------------------------------------------
  // Load current config
  // ---------------------------------------------------------------------------
  const loadConfig = useCallback(async () => {
    setLoadErr(null);
    setConfig(null);
    try {
      const res = await fetch('/api/llm-config', { headers: authHeaders() });
      if (res.status === 401) {
        setLoadErr('Войдите в систему для доступа к настройкам LLM.');
        setConfig(false);
        return;
      }
      if (!res.ok) {
        setLoadErr(`Ошибка загрузки конфигурации (HTTP ${res.status}).`);
        setConfig(false);
        return;
      }
      const data = await res.json();
      setConfig(data);
      // Pre-fill form from current config.
      setEndpoint(data.llm_endpoint ?? '');
      setModel(data.llm_model ?? '');
      // Try to identify preset from endpoint.
      const matched = PROVIDER_PRESETS.find(
        (p) => p.endpoint && data.llm_endpoint?.startsWith(p.endpoint)
      );
      setPreset(matched ? matched.value : (data.llm_endpoint ? 'self-hosted' : ''));
    } catch {
      setLoadErr('Сетевая ошибка — не удалось загрузить конфигурацию.');
      setConfig(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // ---------------------------------------------------------------------------
  // Preset change: auto-fill endpoint + model
  // ---------------------------------------------------------------------------
  const onPresetChange = (e) => {
    const val = e.target.value;
    setPreset(val);
    const found = PROVIDER_PRESETS.find((p) => p.value === val);
    if (found) {
      if (found.endpoint) setEndpoint(found.endpoint);
      if (found.model)    setModel(found.model);
    }
    setFieldErrors({});
    setSaveOk(false);
    setSubmitErr(null);
  };

  // ---------------------------------------------------------------------------
  // Save (PUT /api/llm-config)
  // ---------------------------------------------------------------------------
  const handleSave = async (e) => {
    e.preventDefault();
    setSaveOk(false);
    setSubmitErr(null);

    // Client-side validation
    const errs = {};
    if (!endpoint.trim()) errs.endpoint = 'Эндпойнт обязателен';
    else {
      try { new URL(endpoint.trim()); }
      catch { errs.endpoint = 'Введите корректный URL (https://…)'; }
    }
    if (!model.trim()) errs.model = 'Укажите модель';
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    try {
      const res = await fetch('/api/llm-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ llm_endpoint: endpoint.trim(), llm_model: model.trim() }),
      });
      if (res.ok) {
        setSaveOk(true);
        await loadConfig(); // refresh status badge
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON */ }
      if (res.status === 403) {
        setSubmitErr('Недостаточно прав. Нужны права управления агентами (genesis-owner или делегированная роль).');
      } else if (res.status === 404) {
        setSubmitErr(
          parsed?.message ?? 'Агент не найден. Подключите агента на экране «Агенты» перед настройкой LLM.'
        );
      } else {
        setSubmitErr(parsed?.message ?? `Ошибка сохранения (HTTP ${res.status}).`);
      }
    } catch {
      setSubmitErr('Сетевая ошибка — не удалось сохранить настройки.');
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------
  if (config === null) return <LoadingState label="Загрузка конфигурации LLM…" />;

  if (config === false) {
    return (
      <ErrorState
        title="Не удалось загрузить конфигурацию"
        message={loadErr ?? 'Неизвестная ошибка.'}
        onRetry={loadConfig}
      />
    );
  }

  const isLive = config.secret_bound && !!config.llm_endpoint && !!config.llm_model;
  const agentId = config.agent_id;

  // Hint for the handle preset field
  const currentPreset = PROVIDER_PRESETS.find((p) => p.value === preset);
  const handleHint = currentPreset?.handleHint ?? 'env://YOUR_LLM_KEY';

  return (
    <div>
      {/* ── Статус подключения ─────────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={headingStyle}>Статус LLM-подключения</h2>
        <div style={statusRowStyle}>
          <div style={dotStyle(isLive)} aria-hidden="true" />
          {isLive
            ? 'Активно — провайдер настроен и ключ привязан'
            : config.secret_bound
              ? 'Ключ привязан, но не указан эндпойнт или модель'
              : config.llm_endpoint
                ? 'Эндпойнт задан, ключ не привязан'
                : 'Не настроено — ассистент спит (503)'}
        </div>
        {config.llm_endpoint && (
          <div style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', marginBottom: 'var(--chs-space-3)' }}>
            Эндпойнт: <span style={monoStyle}>{config.llm_endpoint}</span>
          </div>
        )}
        {config.llm_model && (
          <div style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', marginBottom: 'var(--chs-space-3)' }}>
            Модель: <span style={monoStyle}>{config.llm_model}</span>
          </div>
        )}
        {config.agent_id && (
          <div style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
            Агент: <span style={monoStyle}>{config.agent_slug ?? config.agent_id}</span>
            {' · '}
            Ключ: {config.secret_bound ? 'привязан' : 'не привязан'}
          </div>
        )}
        {!config.agent_id && (
          <p style={{ ...descStyle, margin: 0 }}>
            Агент не найден. Перейдите на экран{' '}
            <a href="/agents" style={{ color: 'var(--chs-color-accent)' }}>«Агенты»</a>{' '}
            и подключите агента перед настройкой LLM.
          </p>
        )}
      </section>

      {/* ── Настройка эндпойнта и модели ──────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={headingStyle}>Провайдер и модель</h2>
        <p style={descStyle}>
          Укажите OpenAI-совместимый эндпойнт и название модели.
          Это НЕ секреты — они хранятся открыто в конфигурации агента.
          Ключ API привязывается отдельным шагом ниже.
        </p>
        <form onSubmit={handleSave} noValidate>
          <div style={fieldGap}>
            <Select
              label="Провайдер (пресет)"
              value={preset}
              onChange={onPresetChange}
              hint="Выберите провайдера для автозаполнения или задайте вручную"
            >
              <option value="">— выберите провайдера —</option>
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </Select>

            <Field
              label="Base URL эндпойнта"
              value={endpoint}
              onChange={(e) => { setEndpoint(e.target.value); setSaveOk(false); setSubmitErr(null); }}
              placeholder="https://api.deepseek.com"
              invalid={!!fieldErrors.endpoint}
              hint={fieldErrors.endpoint || 'OpenAI-совместимый base URL (без /chat/completions)'}
              type="url"
            />

            <Field
              label="Модель"
              value={model}
              onChange={(e) => { setModel(e.target.value); setSaveOk(false); setSubmitErr(null); }}
              placeholder="deepseek-chat"
              invalid={!!fieldErrors.model}
              hint={fieldErrors.model || 'Например: deepseek-chat, gpt-4o-mini, claude-3-5-sonnet-20241022'}
            />
          </div>

          {submitErr && <div style={bannerErrStyle}>{submitErr}</div>}
          {saveOk && <div style={bannerOkStyle}>Настройки сохранены. Эндпойнт и модель обновлены в конфигурации агента.</div>}

          <div style={{ display: 'flex', gap: 'var(--chs-space-5)', marginTop: 'var(--chs-space-7)' }}>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={saving || !config.agent_id}
              loading={saving}
            >
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={loadConfig}>
              Обновить статус
            </Button>
          </div>
        </form>
      </section>

      {/* ── Привязка ключа (секрет-хэндл) ─────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={headingStyle}>Ключ API (секрет-хэндл)</h2>
        <p style={descStyle}>
          Ключ LLM — секрет. Вставьте <strong>ссылку-хэндл</strong> на секрет
          (например{' '}
          <code style={monoStyle}>{handleHint}</code>
          ), а не сам ключ. Сервер хранит только хэндл и никогда не показывает значение.
        </p>
        <p style={descStyle}>
          Статус: <strong>{config.secret_bound ? 'ключ привязан' : 'ключ не привязан'}</strong>.
          {config.secret_bound ? ' Чтобы сменить — используйте «Привязать LLM» на экране «Агенты».' : ''}
        </p>
        {agentId ? (
          <a href="/agents" style={{ textDecoration: 'none' }}>
            <Button variant="secondary" size="sm" type="button">
              <Icon name="org" className="chs-btn__glyph" />
              Перейти на экран «Агенты» для привязки ключа
            </Button>
          </a>
        ) : (
          <p style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
            Сначала подключите агента на экране{' '}
            <a href="/agents" style={{ color: 'var(--chs-color-accent)' }}>«Агенты»</a>.
          </p>
        )}
      </section>

      {/* ── Справка ──────────────────────────────────────────────────────────── */}
      <section style={sectionStyle}>
        <h2 style={headingStyle}>Как это работает</h2>
        <ol style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', paddingLeft: 'var(--chs-space-6)', lineHeight: 1.7 }}>
          <li>Задайте <strong>эндпойнт</strong> и <strong>модель</strong> на этом экране и сохраните.</li>
          <li>На экране{' '}
            <a href="/agents" style={{ color: 'var(--chs-color-accent)' }}>«Агенты»</a>
            {' '}нажмите «Привязать LLM» и вставьте ссылку-хэндл на секрет API-ключа
            (например <code style={monoStyle}>env://DEEPSEEK_API_KEY</code>).
          </li>
          <li>После обоих шагов ассистент активируется — чат в разделе{' '}
            <a href="/assistant" style={{ color: 'var(--chs-color-accent)' }}>«Ассистент»</a>
            {' '}перейдёт из режима 503 в рабочий.
          </li>
        </ol>
        <p style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginTop: 'var(--chs-space-4)' }}>
          Конфигурация хранится в поле <code style={monoStyle}>agent_card</code> и изолирована по тенанту.
          При смене провайдера: сохраните новый эндпойнт, затем обновите хэндл на экране «Агенты».
        </p>
      </section>
    </div>
  );
}
