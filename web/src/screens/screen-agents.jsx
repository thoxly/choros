/* ============================================================================
   CHOROS — screen-agents.jsx  (T-0271)
   Экран «Агенты»: список агентов тенанта + подключение нового агента +
   привязка LLM через СЕКРЕТ-ХЭНДЛ (ссылку на секрет, не сырой ключ).

   ЖИВЫЕ контракты (никаких мёртвых кнопок):
     GET  /api/agents                          — список (метаданные, БЕЗ секретов)
     POST /api/agents/hire                      — «Подключить агента»
     POST /api/agents/:id/secret-handle         — «Привязать LLM» (хэндл секрета)
     GET  /api/org/tenant-state?tenant_id=…     — UUID должностей для формы hire

   БЕЗОПАСНОСТЬ: поле ключа LLM — type="password"; отправляется ССЫЛКА-ХЭНДЛ на
   секрет (vault://… / env://…), НЕ сырой ключ. Сервер хранит только хэндл и
   никогда не возвращает значение обратно (список отдаёт лишь llm_bound:bool).

   Привязка агента к процессу/задаче: ОТДЕЛЬНОГО бэкенд-эндпойнта нет — агент
   подключается к работе через ДОЛЖНОСТЬ в оргструктуре (выбирается при hire).
   Поэтому здесь нет самостоятельной «привязать к процессу» (была бы мёртвая
   кнопка); связь с работой показана честно через должность агента.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, MonoId, Modal, StatusChip, EmptyState, LoadingState, ErrorState, Tooltip, Field, Select } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { getActiveTenantId } from '../app-shell/active-tenant.js';
import {
  validateHire, buildHirePayload,
  validateBind, buildBindPayload,
  mapAgentError, statusLabel, positionOptions, displayAgentName, agentTypeLabel,
  connectionOptions, buildLlmConnectionPayload, mapLlmConnectionError,
  outcomeMeta, formatActivityTime, activityContext, mapActivityError,
  mapAgentInstructionError, mapAgentInstructionPromoteError,
} from './agents-form.js';

// Tenant id resolved at runtime from the caller's identity (see active-tenant.js).

const LLM_PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure-openai', label: 'Azure OpenAI' },
  { value: 'self-hosted', label: 'Свой эндпойнт (self-hosted)' },
];

// ---- Token-only styles (OBLIK: consume --chs-* only, no hardcoded color) -----
// Form fields use the kit <Field>/<Select> primitives (label↔control binding,
// invalid state, hint, both-theme color) — no hand-rolled label/input styling.
const bannerErrStyle = {
  marginBottom: 'var(--chs-space-5)', padding: 'var(--chs-space-4) var(--chs-space-5)',
  background: 'var(--chs-color-danger-soft)', border: '1px solid var(--chs-color-danger)',
  borderRadius: 'var(--chs-radius-3)', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)',
};
const cardStyle = {
  display: 'flex', alignItems: 'center', gap: 'var(--chs-space-5)',
  padding: 'var(--chs-space-4) var(--chs-space-5)',
  background: 'var(--chs-color-surface)', border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)', color: 'var(--chs-color-text)',
};
// Stack spacing between kit fields inside a modal form (layout only, no color).
const fieldGap = { display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-6)' };
// Agent-type badge — token-only pill (no hardcoded color), neutral surface.
const typeBadgeStyle = {
  display: 'inline-block', padding: 'var(--chs-space-1) var(--chs-space-3)',
  borderRadius: 'var(--chs-radius-2)', fontSize: 'var(--chs-text-xs)',
  fontWeight: 'var(--chs-weight-medium)',
  background: 'var(--chs-color-surface-sunken, var(--chs-color-surface))',
  border: '1px solid var(--chs-color-border)', color: 'var(--chs-color-text-muted)',
};

// Soft hint linking to the LLM-connections registry (no dead button — navigates).
const hintLinkStyle = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--chs-color-accent, var(--chs-color-text))', textDecoration: 'underline',
  font: 'inherit', fontSize: 'var(--chs-text-xs)',
};

// Activity timeline row — token-only, both-theme readable.
const activityItemStyle = {
  display: 'flex', alignItems: 'flex-start', gap: 'var(--chs-space-4)',
  padding: 'var(--chs-space-3) 0',
  borderTop: '1px solid var(--chs-color-border)',
};

// T-0637 — Instruction editor tokens (mirrors screen-assistant-prompt.jsx's
// PromptEditor tierBadgeStyle/textareaStyle/bannerErrStyle/bannerOkStyle).
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
function instructionTierLabel(tier) {
  if (tier === 'published') return 'опубликовано';
  if (tier === 'draft') return 'черновик';
  return 'не задано';
}
const instructionTextareaStyle = {
  width: '100%', minHeight: 140,
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
const instructionBannerErrStyle = {
  marginTop: 'var(--chs-space-4)',
  padding: 'var(--chs-space-4) var(--chs-space-5)',
  background: 'var(--chs-color-danger-soft)',
  border: '1px solid var(--chs-color-danger)',
  borderRadius: 'var(--chs-radius-3)',
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text)',
};
const instructionBannerOkStyle = {
  marginTop: 'var(--chs-space-4)',
  padding: 'var(--chs-space-4) var(--chs-space-5)',
  background: 'var(--chs-color-success-soft)',
  border: '1px solid var(--chs-color-success)',
  borderRadius: 'var(--chs-radius-3)',
  fontSize: 'var(--chs-text-sm)',
  color: 'var(--chs-color-text)',
};

/* ---------------------------------------------------------------------------
   T-0499 — Панель «Активность агента». Лента исходов из РЕАЛЬНОГО журнала
   (audit_log): GET /api/agents/:id/activity. Сервер уже редактирует payload —
   приходят только безопасные поля (исход/время/процесс/шаг/краткое пояснение).
   Честные состояния: загрузка / ошибка(401→человеческий) / пусто. «Загрузить
   ещё» через курсор. Без мёртвых кнопок.
   --------------------------------------------------------------------------- */
function ActivityPanel({ agentId }) {
  const [items, setItems] = useState(null); // null = ещё не грузили / загрузка
  const [cursor, setCursor] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (after) => {
    setError(null);
    setLoading(true);
    try {
      const qs = after ? `?cursor=${encodeURIComponent(after)}` : '';
      const res = await fetch(`/api/agents/${agentId}/activity${qs}`, { headers: authHeaders() });
      if (!res.ok) {
        let parsed = null;
        try { parsed = await res.json(); } catch { /* non-JSON */ }
        setError(mapActivityError(res.status, parsed));
        if (!after) setItems([]); // first page failed → honest empty + error
        return;
      }
      const data = await res.json();
      const next = Array.isArray(data.items) ? data.items : [];
      setItems((prev) => (after && Array.isArray(prev) ? [...prev, ...next] : next));
      setCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
    } catch {
      setError('Сетевая ошибка — не удалось загрузить активность агента.');
      if (!after) setItems([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  // Lazy: load the first page when the panel is mounted (opened).
  useEffect(() => { load(null); }, [load]);

  if (items === null && loading) {
    return <LoadingState label="Загрузка активности…" />;
  }
  if (error && (items === null || items.length === 0)) {
    return (
      <ErrorState
        title="Не удалось загрузить активность"
        message={error}
        onRetry={() => load(null)}
      />
    );
  }
  if (Array.isArray(items) && items.length === 0) {
    return (
      <EmptyState
        title="Агент ещё ничего не делал"
        description="Запустите процесс с шагом этого агента — здесь появятся его решения (выполнил сам / отложил человеку / заблокирован)."
      />
    );
  }

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {(items || []).map((it) => {
          const meta = outcomeMeta(it.outcome);
          const ctx = activityContext(it);
          return (
            <div key={it.id} style={activityItemStyle}>
              <StatusChip status={meta.chip} label={meta.label} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)' }}>
                  {it.summary || meta.label}
                </div>
                <div style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginTop: 'var(--chs-space-1)' }}>
                  {formatActivityTime(it.ts)}
                  {ctx ? ` · ${ctx}` : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {error && items && items.length > 0 && (
        <div style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)', marginTop: 'var(--chs-space-3)' }}>
          {error}
        </div>
      )}

      {cursor && (
        <div style={{ marginTop: 'var(--chs-space-4)' }}>
          <Button variant="ghost" size="sm" disabled={loading} loading={loading} onClick={() => load(cursor)}>
            {loading ? 'Загружаю…' : 'Загрузить ещё'}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   T-0637 — «Инструкция агента»: компетентностная инструкция, задаваемая владель-
   цем/админом из UI (не кейс-литерал — данные тенанта). Читает/пишет ЧЕРНОВИК
   через GET/PUT /api/agents/:id/instruction; публикация — через уже существующий
   маршрут POST /api/artifacts/:id/promote (никакого нового promote-механизма).
   Lazy: загружается по клику на тогл (та же collapsible-механика, что «Активность»).
   --------------------------------------------------------------------------- */
function AgentInstructionEditor({ agentId }) {
  const [state, setState] = useState(null);    // null = загрузка; false = ошибка загрузки
  const [loadErr, setLoadErr] = useState(null);
  const [text, setText] = useState('');
  const [saveErr, setSaveErr] = useState(null);
  const [saveOk, setSaveOk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishErr, setPublishErr] = useState(null);
  const [publishOk, setPublishOk] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(null);
    setState(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/instruction`, { headers: authHeaders() });
      if (!res.ok) {
        let parsed = null;
        try { parsed = await res.json(); } catch { /* non-JSON */ }
        setLoadErr(mapAgentInstructionError(res.status, parsed));
        setState(false);
        return;
      }
      const data = await res.json();
      setState(data);
      setText(data.text ?? '');
    } catch {
      setLoadErr('Сетевая ошибка — не удалось загрузить инструкцию агента.');
      setState(false);
    }
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const handleSaveDraft = async (e) => {
    e.preventDefault();
    setSaveOk(false);
    setSaveErr(null);
    setPublishOk(false);
    setPublishErr(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/instruction`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        setSaveOk(true);
        await load();
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON */ }
      setSaveErr(mapAgentInstructionError(res.status, parsed));
    } catch {
      setSaveErr('Сетевая ошибка — не удалось сохранить черновик инструкции.');
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!state || !state.instruction_id || state.tier !== 'draft') return;
    setPublishOk(false);
    setPublishErr(null);
    setPublishing(true);
    try {
      const res = await fetch(`/api/artifacts/${state.instruction_id}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ artifact_table: 'agent_instruction' }),
      });
      if (res.ok) {
        setPublishOk(true);
        await load();
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON */ }
      setPublishErr(mapAgentInstructionPromoteError(res.status, parsed));
    } catch {
      setPublishErr('Сетевая ошибка — не удалось опубликовать инструкцию.');
    } finally {
      setPublishing(false);
    }
  };

  if (state === null) {
    return <LoadingState label="Загрузка инструкции…" />;
  }
  if (state === false) {
    return (
      <ErrorState
        title="Не удалось загрузить инструкцию агента"
        message={loadErr ?? 'Неизвестная ошибка.'}
        onRetry={load}
      />
    );
  }

  const canPublish = state.tier === 'draft' && !!state.instruction_id;
  const publishDisabledReason = !state.instruction_id
    ? 'Сначала сохраните черновик инструкции.'
    : state.tier === 'published'
      ? 'Инструкция уже опубликована.'
      : undefined;

  return (
    <div>
      <div style={{ marginBottom: 'var(--chs-space-3)' }}>
        <span style={tierBadgeStyle(state.tier)}>{instructionTierLabel(state.tier)}</span>
        {state.tier === null && (
          <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginLeft: 'var(--chs-space-3)' }}>
            — без инструкции агент откладывает шаги человеку (гейт «нет опубликованной инструкции»).
          </span>
        )}
      </div>

      <form onSubmit={handleSaveDraft}>
        <label style={{ display: 'block', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)', fontWeight: 'var(--chs-weight-medium)', marginBottom: 'var(--chs-space-3)' }}>
          Что умеет делать агент (компетенция)
        </label>
        <textarea
          style={instructionTextareaStyle}
          value={text}
          onChange={(e) => { setText(e.target.value); setSaveOk(false); setSaveErr(null); }}
          placeholder="Опишите, что агент умеет делать в целом — например: «Проверяй заявки на закупку и считай итоговую сумму по позициям»."
          aria-label="Инструкция агента (черновик)"
          spellCheck={false}
        />
        <p style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', margin: 'var(--chs-space-2) 0 var(--chs-space-4) 0' }}>
          Изменения сохраняются как черновик и вступают в силу только после публикации.
        </p>

        {saveErr && <div style={instructionBannerErrStyle}>{saveErr}</div>}
        {saveOk && <div style={instructionBannerOkStyle}>Черновик сохранён.</div>}
        {publishErr && <div style={instructionBannerErrStyle}>{publishErr}</div>}
        {publishOk && <div style={instructionBannerOkStyle}>Инструкция опубликована — агент будет использовать её на следующем шаге.</div>}

        <div style={{ display: 'flex', gap: 'var(--chs-space-5)', marginTop: 'var(--chs-space-5)', flexWrap: 'wrap' }}>
          <Button type="submit" variant="primary" size="sm" disabled={saving} loading={saving}>
            {saving ? 'Сохраняю…' : 'Сохранить черновик'}
          </Button>
          <Tooltip label={publishDisabledReason || 'Опубликовать текущий черновик'}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canPublish || publishing}
              loading={publishing}
              onClick={handlePublish}
            >
              {publishing ? 'Публикую…' : 'Опубликовать'}
            </Button>
          </Tooltip>
        </div>
      </form>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Список агентов — карточка читаема в ОБЕИХ темах (токены surface/text/muted).
   T-0498: на карточке — селектор LLM-подключения (именованный профиль). Текущее
   значение показано; при выборе → PUT /api/agents/:id/llm-connection. Подключения
   приходят из GET /api/llm-connections (родительский экран). Без мёртвых кнопок.
   --------------------------------------------------------------------------- */
function AgentRow({ agent, onBind, connections, connectionsAvailable, onConnectionSaved, onGoToConnections }) {
  const name = displayAgentName(agent.display_name);
  // Org-place line: workforce agents sit on a position; system/assistant agents
  // live in the registry WITHOUT an org-place (migration 093 / T-0473).
  const orgPlace = agent.has_org_place
    ? `${agent.position || 'должность не назначена'}${agent.department ? ` · ${agent.department}` : ''}`
    : 'вне оргструктуры';

  // Current binding (controlled): null/'' = «не задано (по умолчанию)».
  const [connId, setConnId] = useState(agent.llm_connection_id || '');
  const [saving, setSaving] = useState(false);
  const [connErr, setConnErr] = useState(null);
  const [connOk, setConnOk] = useState(false);
  // T-0499: «Активность» — лента исходов из реального журнала (lazy, по клику).
  const [activityOpen, setActivityOpen] = useState(false);
  // T-0637: «Инструкция агента» — компетентностная инструкция (lazy, по клику).
  const [instructionOpen, setInstructionOpen] = useState(false);

  const options = connectionOptions(connections);

  const saveConnection = async (e) => {
    const next = e.target.value;
    const prev = connId;
    setConnId(next);
    setConnErr(null);
    setConnOk(false);
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}/llm-connection`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(buildLlmConnectionPayload(next)),
      });
      if (res.ok) {
        setConnOk(true);
        onConnectionSaved?.();
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON */ }
      setConnErr(mapLlmConnectionError(res.status, parsed));
      setConnId(prev); // revert on failure — honest state
    } catch {
      setConnErr('Сетевая ошибка — не удалось сохранить LLM-подключение.');
      setConnId(prev);
    } finally {
      setSaving(false);
    }
  };

  // Connection-id no longer in the (possibly 403-empty) list — show it honestly.
  const currentMissingFromList =
    connId && !options.some((o) => o.id === connId);

  return (
    <div style={{ ...cardStyle, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-5)', width: '100%' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)' }}>
            <span style={{ fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>{name}</span>
            <span style={typeBadgeStyle} title="Тип агента">{agentTypeLabel(agent.agent_type)}</span>
          </div>
          <div style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginTop: 'var(--chs-space-2)' }}>
            <MonoId>{agent.slug}</MonoId>
            {` · ${orgPlace}`}
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 'var(--chs-text-xs)' }}>
          <Tooltip label={agent.llm_bound ? 'Секрет-хэндл привязан' : 'LLM не привязана'}>
            <StatusChip status={agent.llm_bound ? 'done' : 'waiting'} label={statusLabel(agent.status)} />
          </Tooltip>
          <div style={{ color: 'var(--chs-color-text-muted)', marginTop: 'var(--chs-space-3)' }}>
            {agent.llm_provider ? agent.llm_provider : 'провайдер не задан'}
            {agent.llm_model ? ` · ${agent.llm_model}` : ''}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onBind(agent)} title="Привязать LLM к агенту">
          Привязать LLM
        </Button>
        <Button
          variant="ghost" size="sm"
          aria-expanded={instructionOpen}
          onClick={() => setInstructionOpen((v) => !v)}
          title="Инструкция агента — что он умеет делать"
        >
          {instructionOpen ? 'Скрыть инструкцию' : 'Инструкция агента'}
        </Button>
        <Button
          variant="ghost" size="sm"
          aria-expanded={activityOpen}
          onClick={() => setActivityOpen((v) => !v)}
          title="Активность агента — что он делал"
        >
          {activityOpen ? 'Скрыть активность' : 'Активность'}
        </Button>
      </div>

      {/* LLM-подключение (именованный профиль) — селектор на всю ширину карточки. */}
      <div style={{ width: '100%', marginTop: 'var(--chs-space-4)' }}>
        <Select
          label="LLM-подключение"
          value={connId}
          onChange={saveConnection}
          disabled={saving || !connectionsAvailable}
          hint={
            connErr
              ? connErr
              : connOk
                ? 'Сохранено.'
                : saving
                  ? 'Сохраняю…'
                  : undefined
          }
          invalid={!!connErr}
        >
          <option value="">— Не задано (по умолчанию) —</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          {currentMissingFromList && (
            <option value={connId}>{`Текущее подключение (${connId.slice(0, 8)}…)`}</option>
          )}
        </Select>

        {/* Связка-подсказка: нет подключения → как сделать, чтобы агент заработал. */}
        {!connId && (
          <div style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginTop: 'var(--chs-space-2)' }}>
            {connectionsAvailable && options.length === 0
              ? 'Подключений пока нет. '
              : 'Без подключения агент не работает на вашем ключе. '}
            <button type="button" style={hintLinkStyle} onClick={onGoToConnections}>
              Создайте подключение и привяжите его здесь
            </button>
            {' — чтобы агент работал на вашем ключе.'}
          </div>
        )}
        {!connectionsAvailable && (
          <div style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginTop: 'var(--chs-space-2)' }}>
            Список LLM-подключений недоступен (нужны права настройки подключений).
          </div>
        )}
      </div>

      {/* T-0637 — «Инструкция агента»: компетентностная инструкция (черновик/публикация). */}
      {instructionOpen && (
        <div style={{ width: '100%', marginTop: 'var(--chs-space-4)', paddingTop: 'var(--chs-space-4)', borderTop: '1px solid var(--chs-color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)', marginBottom: 'var(--chs-space-3)' }}>
            <Icon name="assistant" />
            <span style={{ fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>
              Инструкция агента
            </span>
          </div>
          <AgentInstructionEditor agentId={agent.id} />
        </div>
      )}

      {/* T-0499 — «Активность»: лента исходов агента из реального журнала. */}
      {activityOpen && (
        <div style={{ width: '100%', marginTop: 'var(--chs-space-4)', paddingTop: 'var(--chs-space-4)', borderTop: '1px solid var(--chs-color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)', marginBottom: 'var(--chs-space-3)' }}>
            <Icon name="audit" />
            <span style={{ fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>
              Активность
            </span>
          </div>
          <ActivityPanel agentId={agent.id} />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Модал: подключить агента (hire)
   --------------------------------------------------------------------------- */
function HireModal({ positions, onClose, onDone }) {
  const [values, setValues] = useState({ slug: '', display_name: '', position_id: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitErr, setSubmitErr] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setSubmitErr(null);
    const { valid, errors } = validateHire(values);
    setFieldErrors(errors);
    if (!valid) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/agents/hire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(buildHirePayload(values)),
      });
      if (res.status === 201) { onDone(); return; }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON */ }
      const mapped = mapAgentError(res.status, parsed, 'подключение агента');
      if (mapped.field) setFieldErrors((fe) => ({ ...fe, [mapped.field]: mapped.message }));
      else setSubmitErr(mapped.message);
    } catch {
      setSubmitErr('Сетевая ошибка — не удалось подключить агента.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open title="Подключить агента" onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <p style={{ margin: '0 0 var(--chs-space-7) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Агент — штатная единица: подключается к должности в оргструктуре и оттуда берёт задачи.
          LLM привязывается отдельным шагом после создания.
        </p>

        <div style={fieldGap}>
          <Field
            label="Слаг"
            value={values.slug}
            onChange={set('slug')}
            placeholder="recon-bot"
            invalid={!!fieldErrors.slug}
            hint={fieldErrors.slug || 'строчные латинские, цифры, дефис · 1–64'}
            autoFocus
          />

          <Field
            label="Отображаемое имя"
            value={values.display_name}
            onChange={set('display_name')}
            placeholder="Сверка-агент"
            invalid={!!fieldErrors.display_name}
            hint={fieldErrors.display_name || undefined}
          />

          <Select
            label="Должность"
            value={values.position_id}
            onChange={set('position_id')}
            invalid={!!fieldErrors.position_id}
            hint={
              fieldErrors.position_id
                ? fieldErrors.position_id
                : positions.length === 0
                  ? 'Должности не загружены (нужны права владельца тенанта). Создайте должность в «Оргструктуре».'
                  : undefined
            }
          >
            <option value="">— выберите должность —</option>
            {positions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </div>

        {submitErr && <div style={bannerErrStyle}>{submitErr}</div>}

        <div style={{ display: 'flex', gap: 'var(--chs-space-5)', justifyContent: 'flex-end', marginTop: 'var(--chs-space-7)' }}>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" size="sm" disabled={submitting} loading={submitting}>
            {submitting ? 'Подключаю…' : 'Подключить'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   Модал: привязать LLM (secret-handle)
   --------------------------------------------------------------------------- */
function BindModal({ agent, onClose, onDone }) {
  const [values, setValues] = useState({ provider: '', model: '', handle: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitErr, setSubmitErr] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setSubmitErr(null);
    const { valid, errors } = validateBind(values);
    setFieldErrors(errors);
    if (!valid) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}/secret-handle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(buildBindPayload(values)),
      });
      if (res.ok) { onDone(); return; } // server returns only { ok:true } — never echoes the handle
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON */ }
      const mapped = mapAgentError(res.status, parsed, 'привязку LLM');
      if (mapped.field) setFieldErrors((fe) => ({ ...fe, [mapped.field]: mapped.message }));
      else setSubmitErr(mapped.message);
    } catch {
      setSubmitErr('Сетевая ошибка — не удалось привязать LLM.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open title={`Привязать LLM · ${displayAgentName(agent.display_name)}`} onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <p style={{ margin: '0 0 var(--chs-space-7) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Ключ LLM — секрет. Вставьте <strong>ссылку-хэндл</strong> на секрет
          (например <code>vault://secret/llm/recon</code> или <code>env://LLM_KEY</code>),
          <strong> а не сам ключ</strong>. Сервер хранит только хэндл и никогда не показывает значение обратно.
        </p>

        <div style={fieldGap}>
          <Select
            label="Провайдер"
            value={values.provider}
            onChange={set('provider')}
            invalid={!!fieldErrors.provider}
            hint={fieldErrors.provider || undefined}
            autoFocus
          >
            <option value="">— выберите провайдера —</option>
            {LLM_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>

          <Field
            label="Модель (опц.)"
            value={values.model}
            onChange={set('model')}
            placeholder="claude-sonnet-4"
          />

          <Field
            label="Ссылка-хэндл на секрет ключа"
            type="password"
            autoComplete="off"
            value={values.handle}
            onChange={set('handle')}
            placeholder="vault://secret/llm/recon"
            invalid={!!fieldErrors.handle}
            hint={fieldErrors.handle || undefined}
          />
        </div>

        {submitErr && <div style={bannerErrStyle}>{submitErr}</div>}

        <div style={{ display: 'flex', gap: 'var(--chs-space-5)', justifyContent: 'flex-end', marginTop: 'var(--chs-space-7)' }}>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" size="sm" disabled={submitting} loading={submitting}>
            {submitting ? 'Привязываю…' : 'Привязать'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   Экран
   --------------------------------------------------------------------------- */
export default function AgentsScreen() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState(null); // null=loading
  const [error, setError] = useState(null);
  const [positions, setPositions] = useState([]);
  const [hireOpen, setHireOpen] = useState(false);
  const [bindAgent, setBindAgent] = useState(null);
  // T-0498: named LLM connection profiles for the per-agent selector.
  const [connections, setConnections] = useState([]);
  // false when GET /api/llm-connections is 403 (no configure right) — the selector
  // is then disabled with an honest hint rather than offering an empty dropdown.
  const [connectionsAvailable, setConnectionsAvailable] = useState(true);

  const loadAgents = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/agents', { headers: authHeaders() });
      if (res.status === 401) { setError('Войдите в систему, чтобы увидеть агентов.'); setAgents([]); return; }
      if (!res.ok) { setError(`Ошибка загрузки агентов (HTTP ${res.status}).`); setAgents([]); return; }
      const data = await res.json();
      setAgents(Array.isArray(data.agents) ? data.agents : []);
    } catch {
      setError('Сетевая ошибка — не удалось загрузить агентов.');
      setAgents([]);
    }
  }, []);

  // Position UUIDs for the hire form come from tenant-state (genesis-owner gated;
  // a 403 just means the dropdown stays empty — the form shows an honest hint).
  const loadPositions = useCallback(async () => {
    try {
      const res = await fetch(`/api/org/tenant-state?tenant_id=${getActiveTenantId()}`, { headers: authHeaders() });
      if (!res.ok) { setPositions([]); return; }
      const data = await res.json();
      setPositions(positionOptions(data.positions));
    } catch {
      setPositions([]);
    }
  }, []);

  // Named LLM connection profiles (GET /api/llm-connections). A 403 (no configure
  // right) is NOT an error here — it just means the per-agent selector is disabled
  // with an honest hint. Any other failure → empty list (selector still shows the
  // agent's current binding via the "current connection" fallback option).
  const loadConnections = useCallback(async () => {
    try {
      const res = await fetch('/api/llm-connections', { headers: authHeaders() });
      if (res.status === 403) { setConnections([]); setConnectionsAvailable(false); return; }
      if (!res.ok) { setConnections([]); setConnectionsAvailable(true); return; }
      const data = await res.json();
      setConnections(Array.isArray(data.connections) ? data.connections : []);
      setConnectionsAvailable(true);
    } catch {
      setConnections([]);
      setConnectionsAvailable(true);
    }
  }, []);

  useEffect(() => { loadAgents(); loadPositions(); loadConnections(); }, [loadAgents, loadPositions, loadConnections]);

  const hasAgents = Array.isArray(agents) && agents.length > 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--chs-space-6)', gap: 'var(--chs-space-6)' }}>
        <p style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', margin: 0, maxWidth: '88ch' }}>
          Агенты тенанта. Каждый подключён к должности в оргструктуре и оттуда берёт задачи.
          LLM привязывается через ссылку-хэндл на секрет — сырой ключ в системе не хранится.
        </p>
        <Button
          variant="primary" size="sm"
          glyph={<Icon name="plus" className="chs-btn__glyph" />}
          onClick={() => setHireOpen(true)}
        >
          Подключить агента
        </Button>
      </div>

      {agents === null ? (
        <LoadingState label="Загрузка агентов…" />
      ) : error ? (
        <ErrorState
          title="Не удалось загрузить агентов"
          message={error}
          onRetry={loadAgents}
        />
      ) : !hasAgents ? (
        <EmptyState
          title="Агентов пока нет"
          description="Подключите первого агента — он встанет на должность в оргструктуре и начнёт брать задачи."
          action={
            <Button variant="primary" size="sm" onClick={() => setHireOpen(true)}>
              Подключить агента
            </Button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-4)' }}>
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              onBind={setBindAgent}
              connections={connections}
              connectionsAvailable={connectionsAvailable}
              onConnectionSaved={loadAgents}
              onGoToConnections={() => navigate('/llm-connections')}
            />
          ))}
        </div>
      )}

      {hireOpen && (
        <HireModal
          positions={positions}
          onClose={() => setHireOpen(false)}
          onDone={() => { setHireOpen(false); loadAgents(); }}
        />
      )}
      {bindAgent && (
        <BindModal
          agent={bindAgent}
          onClose={() => setBindAgent(null)}
          onDone={() => { setBindAgent(null); loadAgents(); }}
        />
      )}
    </div>
  );
}
