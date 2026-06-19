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
import { Button, MonoId, Modal, StatusChip, EmptyState, LoadingState, ErrorState, Tooltip } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import {
  validateHire, buildHirePayload,
  validateBind, buildBindPayload,
  mapAgentError, statusLabel, positionOptions, displayAgentName,
} from './agents-form.js';

// Dev tenant UUID — the silo the hire/list endpoints scope to (server DEV_TENANT_ID).
const DEV_TENANT_ID = 'a0000000-0000-0000-0000-000000000001';

const LLM_PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure-openai', label: 'Azure OpenAI' },
  { value: 'self-hosted', label: 'Свой эндпойнт (self-hosted)' },
];

// ---- Token-only styles (OBLIK: consume --chs-* only, no hardcoded color) -----
// The <select> elements reuse the kit .chs-input class for theming; these inline
// rules carry only layout (spacing/size), never raw color literals.
const errStyle = { display: 'block', marginTop: 'var(--chs-space-3)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' };
const hintStyle = { ...errStyle, color: 'var(--chs-color-text-faint)' };
const labelStyle = { display: 'block', marginBottom: 'var(--chs-space-5)' };
const labelSpan = { fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-medium)' };
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
// Kit input/select theming: .chs-input owns all color (both themes, WCAG AA);
// .chs-input--invalid adds the danger border. width:100% via inline layout.
const selectCls = (invalid) => `chs-input ${invalid ? 'chs-input--invalid' : ''}`;
const fieldInputStyle = { width: '100%', boxSizing: 'border-box', marginTop: 'var(--chs-space-2)' };

/* ---------------------------------------------------------------------------
   Список агентов — карточка читаема в ОБЕИХ темах (токены surface/text/muted).
   --------------------------------------------------------------------------- */
function AgentRow({ agent, onBind }) {
  const name = displayAgentName(agent.display_name);
  return (
    <div style={cardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>{name}</div>
        <div style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginTop: 'var(--chs-space-2)' }}>
          <MonoId>{agent.slug}</MonoId>
          {agent.position ? ` · ${agent.position}` : ' · должность не назначена'}
          {agent.department ? ` · ${agent.department}` : ''}
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

        <label style={labelStyle}>
          <span style={labelSpan}>Слаг</span>
          <input className={selectCls(fieldErrors.slug)} style={fieldInputStyle} value={values.slug} onChange={set('slug')} placeholder="recon-bot" aria-invalid={!!fieldErrors.slug} autoFocus />
          {fieldErrors.slug ? <span style={errStyle}>{fieldErrors.slug}</span>
            : <span style={hintStyle}>строчные латинские, цифры, дефис · 1–64</span>}
        </label>

        <label style={labelStyle}>
          <span style={labelSpan}>Отображаемое имя</span>
          <input className={selectCls(fieldErrors.display_name)} style={fieldInputStyle} value={values.display_name} onChange={set('display_name')} placeholder="Сверка-агент" aria-invalid={!!fieldErrors.display_name} />
          {fieldErrors.display_name && <span style={errStyle}>{fieldErrors.display_name}</span>}
        </label>

        <label style={labelStyle}>
          <span style={labelSpan}>Должность</span>
          <select className={selectCls(fieldErrors.position_id)} style={fieldInputStyle} value={values.position_id} onChange={set('position_id')} aria-invalid={!!fieldErrors.position_id}>
            <option value="">— выберите должность —</option>
            {positions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {fieldErrors.position_id ? <span style={errStyle}>{fieldErrors.position_id}</span>
            : positions.length === 0
              ? <span style={hintStyle}>Должности не загружены (нужны права владельца тенанта). Создайте должность в «Оргструктуре».</span>
              : null}
        </label>

        {submitErr && <div style={bannerErrStyle}>{submitErr}</div>}

        <div style={{ display: 'flex', gap: 'var(--chs-space-5)', justifyContent: 'flex-end' }}>
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

        <label style={labelStyle}>
          <span style={labelSpan}>Провайдер</span>
          <select className={selectCls(fieldErrors.provider)} style={fieldInputStyle} value={values.provider} onChange={set('provider')} aria-invalid={!!fieldErrors.provider} autoFocus>
            <option value="">— выберите провайдера —</option>
            {LLM_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          {fieldErrors.provider && <span style={errStyle}>{fieldErrors.provider}</span>}
        </label>

        <label style={labelStyle}>
          <span style={labelSpan}>Модель <span style={{ color: 'var(--chs-color-text-faint)' }}>(опц.)</span></span>
          <input className={selectCls(false)} style={fieldInputStyle} value={values.model} onChange={set('model')} placeholder="claude-sonnet-4" />
        </label>

        <label style={labelStyle}>
          <span style={labelSpan}>Ссылка-хэндл на секрет ключа</span>
          <input
            type="password" autoComplete="off"
            className={selectCls(fieldErrors.handle)} style={fieldInputStyle}
            value={values.handle} onChange={set('handle')}
            placeholder="vault://secret/llm/recon" aria-invalid={!!fieldErrors.handle}
          />
          {fieldErrors.handle && <span style={errStyle}>{fieldErrors.handle}</span>}
        </label>

        {submitErr && <div style={bannerErrStyle}>{submitErr}</div>}

        <div style={{ display: 'flex', gap: 'var(--chs-space-5)', justifyContent: 'flex-end' }}>
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
  const [agents, setAgents] = useState(null); // null=loading
  const [error, setError] = useState(null);
  const [positions, setPositions] = useState([]);
  const [hireOpen, setHireOpen] = useState(false);
  const [bindAgent, setBindAgent] = useState(null);

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
      const res = await fetch(`/api/org/tenant-state?tenant_id=${DEV_TENANT_ID}`, { headers: authHeaders() });
      if (!res.ok) { setPositions([]); return; }
      const data = await res.json();
      setPositions(positionOptions(data.positions));
    } catch {
      setPositions([]);
    }
  }, []);

  useEffect(() => { loadAgents(); loadPositions(); }, [loadAgents, loadPositions]);

  const hasAgents = Array.isArray(agents) && agents.length > 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--chs-space-6)', gap: 'var(--chs-space-6)' }}>
        <p style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', margin: 0, maxWidth: 640 }}>
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
          {agents.map((a) => <AgentRow key={a.id} agent={a} onBind={setBindAgent} />)}
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
