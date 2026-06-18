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
import { Button, MonoId } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import {
  validateHire, buildHirePayload,
  validateBind, buildBindPayload,
  mapAgentError, statusLabel, positionOptions,
} from './agents-form.js';

// Dev tenant UUID — the silo the hire/list endpoints scope to (server DEV_TENANT_ID).
const DEV_TENANT_ID = 'a0000000-0000-0000-0000-000000000001';

const LLM_PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure-openai', label: 'Azure OpenAI' },
  { value: 'self-hosted', label: 'Свой эндпойнт (self-hosted)' },
];

// ---- Inline styles (mirror screen-org.jsx — no custom CSS classes) ----------
const inputStyle = (invalid) => ({
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', marginTop: '4px',
  background: 'var(--chs-bg-primary, #14151a)',
  border: `1px solid ${invalid ? 'var(--chs-color-danger, #e53e3e)' : 'var(--chs-border, #30333d)'}`,
  borderRadius: '6px', color: 'inherit', fontSize: 'var(--chs-text-sm, 13px)', fontFamily: 'inherit',
});
const errStyle = { display: 'block', marginTop: '4px', fontSize: 'var(--chs-text-xs, 12px)', color: 'var(--chs-color-danger, #e53e3e)' };
const hintStyle = { ...errStyle, color: 'var(--chs-color-text-faint, #666)' };
const labelStyle = { display: 'block', marginBottom: '14px' };
const labelSpan = { fontSize: 'var(--chs-text-sm, 13px)', fontWeight: 500 };
const bannerErrStyle = {
  marginBottom: '16px', padding: '10px 14px',
  background: 'var(--chs-bg-danger-subtle, rgba(229,62,62,0.12))',
  border: '1px solid var(--chs-color-danger, #e53e3e)', borderRadius: '6px',
  fontSize: 'var(--chs-text-sm, 13px)',
};
const cardStyle = {
  display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px',
  background: 'var(--chs-bg-secondary, #1e2028)', border: '1px solid var(--chs-border, #30333d)',
  borderRadius: '8px',
};
const emptyStyle = {
  padding: '32px', textAlign: 'center', color: 'var(--chs-color-text-muted, #888)',
  border: '1px dashed var(--chs-border, #30333d)', borderRadius: '8px',
};
const badgeStyle = (ok) => ({
  fontSize: '12px', padding: '2px 8px', borderRadius: '10px',
  background: ok ? 'var(--chs-bg-ok-subtle, rgba(56,178,107,0.16))' : 'var(--chs-bg-warn-subtle, rgba(214,158,46,0.16))',
  color: ok ? 'var(--chs-color-ok, #38b26b)' : 'var(--chs-color-warn, #d69e2e)',
});

function ModalShell({ title, onClose, children }) {
  return (
    <div
      role="dialog" aria-modal="true" aria-label={title}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {children}
    </div>
  );
}

const formStyle = {
  background: 'var(--chs-bg-secondary, #1e2028)', border: '1px solid var(--chs-border, #30333d)',
  borderRadius: '8px', padding: '28px 32px', minWidth: '400px', maxWidth: '520px',
  boxShadow: '0 8px 32px rgba(0,0,0,0.4)', maxHeight: '88vh', overflowY: 'auto',
};

/* ---------------------------------------------------------------------------
   Список агентов
   --------------------------------------------------------------------------- */
function AgentRow({ agent, onBind }) {
  return (
    <div style={cardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{agent.display_name}</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
          <MonoId>{agent.slug}</MonoId>
          {agent.position ? ` · ${agent.position}` : ' · должность не назначена'}
          {agent.department ? ` · ${agent.department}` : ''}
        </div>
      </div>
      <div style={{ textAlign: 'right', fontSize: 12 }}>
        <span style={badgeStyle(agent.llm_bound)} title={agent.llm_bound ? 'Секрет-хэндл привязан' : 'LLM не привязана'}>
          {statusLabel(agent.status)}
        </span>
        <div style={{ opacity: 0.7, marginTop: 4 }}>
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
    <ModalShell title="Подключить агента" onClose={onClose}>
      <form style={formStyle} onSubmit={submit}>
        <h2 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 600 }}>Подключить агента</h2>
        <p style={{ margin: '0 0 20px 0', fontSize: '13px', color: 'var(--chs-color-text-muted, #888)' }}>
          Агент — штатная единица: подключается к должности в оргструктуре и оттуда берёт задачи.
          LLM привязывается отдельным шагом после создания.
        </p>

        <label style={labelStyle}>
          <span style={labelSpan}>Слаг</span>
          <input style={inputStyle(!!fieldErrors.slug)} value={values.slug} onChange={set('slug')} placeholder="recon-bot" autoFocus />
          {fieldErrors.slug ? <span style={errStyle}>{fieldErrors.slug}</span>
            : <span style={hintStyle}>строчные латинские, цифры, дефис · 1–64</span>}
        </label>

        <label style={labelStyle}>
          <span style={labelSpan}>Отображаемое имя</span>
          <input style={inputStyle(!!fieldErrors.display_name)} value={values.display_name} onChange={set('display_name')} placeholder="Сверка-агент" />
          {fieldErrors.display_name && <span style={errStyle}>{fieldErrors.display_name}</span>}
        </label>

        <label style={labelStyle}>
          <span style={labelSpan}>Должность</span>
          <select style={inputStyle(!!fieldErrors.position_id)} value={values.position_id} onChange={set('position_id')}>
            <option value="">— выберите должность —</option>
            {positions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {fieldErrors.position_id ? <span style={errStyle}>{fieldErrors.position_id}</span>
            : positions.length === 0
              ? <span style={hintStyle}>Должности не загружены (нужны права владельца тенанта). Создайте должность в «Оргструктуре».</span>
              : null}
        </label>

        {submitErr && <div style={bannerErrStyle}>{submitErr}</div>}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" size="sm" disabled={submitting}>
            {submitting ? 'Подключаю…' : 'Подключить'}
          </Button>
        </div>
      </form>
    </ModalShell>
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
    <ModalShell title="Привязать LLM" onClose={onClose}>
      <form style={formStyle} onSubmit={submit}>
        <h2 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 600 }}>Привязать LLM · {agent.display_name}</h2>
        <p style={{ margin: '0 0 20px 0', fontSize: '13px', color: 'var(--chs-color-text-muted, #888)' }}>
          Ключ LLM — секрет. Вставьте <strong>ссылку-хэндл</strong> на секрет
          (например <code>vault://secret/llm/recon</code> или <code>env://LLM_KEY</code>),
          <strong> а не сам ключ</strong>. Сервер хранит только хэндл и никогда не показывает значение обратно.
        </p>

        <label style={labelStyle}>
          <span style={labelSpan}>Провайдер</span>
          <select style={inputStyle(!!fieldErrors.provider)} value={values.provider} onChange={set('provider')} autoFocus>
            <option value="">— выберите провайдера —</option>
            {LLM_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          {fieldErrors.provider && <span style={errStyle}>{fieldErrors.provider}</span>}
        </label>

        <label style={labelStyle}>
          <span style={labelSpan}>Модель <span style={{ color: 'var(--chs-color-text-faint, #666)' }}>(опц.)</span></span>
          <input style={inputStyle(false)} value={values.model} onChange={set('model')} placeholder="claude-sonnet-4" />
        </label>

        <label style={labelStyle}>
          <span style={labelSpan}>Ссылка-хэндл на секрет ключа</span>
          <input
            type="password" autoComplete="off"
            style={inputStyle(!!fieldErrors.handle)}
            value={values.handle} onChange={set('handle')}
            placeholder="vault://secret/llm/recon"
          />
          {fieldErrors.handle && <span style={errStyle}>{fieldErrors.handle}</span>}
        </label>

        {submitErr && <div style={bannerErrStyle}>{submitErr}</div>}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" size="sm" disabled={submitting}>
            {submitting ? 'Привязываю…' : 'Привязать'}
          </Button>
        </div>
      </form>
    </ModalShell>
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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 16 }}>
        <p style={{ fontSize: 13, opacity: 0.75, margin: 0, maxWidth: 640 }}>
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

      {error && <div style={{ ...bannerErrStyle, marginBottom: 12 }}>{error}</div>}

      {agents === null ? (
        <div style={emptyStyle}>Загрузка агентов…</div>
      ) : agents.length === 0 ? (
        <div style={emptyStyle}>
          {error ? 'Список недоступен.' : 'Агентов пока нет. Нажмите «Подключить агента», чтобы создать первого.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
