/* ============================================================================
   CHOROS — screen-llm-connections.jsx  (T-0474, E-AGENTS L2)
   LLM-соединения: реестр именованных профилей подключения LLM.

   ЖИВЫЕ контракты:
     GET  /api/llm-connections   — список профилей тенанта (без ключа).
     POST /api/llm-connections   — создать профиль (имя/провайдер/эндпойнт/модель/
          цены; опц. secret_handle — ТОЛЬКО ссылка-хэндл, не сырой ключ).

   БЕЗОПАСНОСТЬ (RL-3):
     - Сырой API-ключ НЕ принимается и НЕ хранится. Поле «секрет-хэндл» — это
       ССЫЛКА (env://ИМЯ / vault://путь / app://id), shape-guard на сервере
       отклоняет сырой ключ (sk-…, JWT, hex). Сырой ключ → 400.
     - Хэндл НИКОГДА не возвращается на клиент: список отдаёт secret_bound:bool +
       схему-сокращение (env://...).

   ДИЗАЙН: строго OBLIK — только --chs-* токены, kit-компоненты.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, LoadingState, ErrorState, EmptyState, Field, Select, ConfirmDialog } from '../components/components.jsx';
import { ConsequenceSummary, useDestructiveConfirm } from '../util/confirm-helpers.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';

// ---------------------------------------------------------------------------
// Provider presets (auto-fill endpoint/model + price hints; all editable)
// T-0477 [E-AGENTS L5]: added priceIn/priceOut defaults per provider.
// Prices are approximate public list rates (USD/1k tokens, 2024-2025 vintage).
// Users can always override these — they are just convenient defaults.
// ---------------------------------------------------------------------------
const PROVIDER_PRESETS = [
  // DeepSeek: deepseek-chat  input $0.14/1k  output $0.28/1k  (2025 pricing)
  { value: 'deepseek',    label: 'DeepSeek',    endpoint: 'https://api.deepseek.com/v1',   model: 'deepseek-chat',       priceIn: '0.14', priceOut: '0.28', currency: 'USD' },
  // OpenAI: gpt-4o-mini  input $0.15/1k  output $0.60/1k
  { value: 'openai',      label: 'OpenAI',      endpoint: 'https://api.openai.com/v1',     model: 'gpt-4o-mini',         priceIn: '0.15', priceOut: '0.60', currency: 'USD' },
  // Anthropic: claude-3-5-sonnet  input $3.00/1k  output $15.00/1k
  { value: 'anthropic',   label: 'Anthropic',   endpoint: 'https://api.anthropic.com/v1',  model: 'claude-3-5-sonnet',   priceIn: '3.00', priceOut: '15.00', currency: 'USD' },
  // Self-hosted: no price defaults (pricing varies per setup)
  { value: 'self-hosted', label: 'Self-hosted', endpoint: '',                              model: '',                    priceIn: '', priceOut: '', currency: 'USD' },
  { value: 'other',       label: 'Другой',      endpoint: '',                              model: '',                    priceIn: '', priceOut: '', currency: 'USD' },
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
const fieldGap = { display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-6)' };
const rowGap = { display: 'flex', gap: 'var(--chs-space-6)', flexWrap: 'wrap' };
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
const cardStyle = {
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
  gap: 'var(--chs-space-5)',
  padding: 'var(--chs-space-5) var(--chs-space-6)',
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)',
  marginBottom: 'var(--chs-space-4)',
  background: 'var(--chs-color-surface)',
};
const nameStyle = {
  fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text)',
};
const metaStyle = {
  fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)',
  marginTop: 'var(--chs-space-2)',
};
const monoStyle = {
  fontFamily: 'var(--chs-font-mono, monospace)', fontSize: 'var(--chs-text-xs)',
  background: 'var(--chs-color-surface-raised)', padding: '2px 6px',
  borderRadius: 'var(--chs-radius-2)', color: 'var(--chs-color-text)',
};
const chipStyle = (ok) => ({
  display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)',
  fontSize: 'var(--chs-text-xs)', fontWeight: 'var(--chs-weight-medium)',
  padding: '2px 8px', borderRadius: 'var(--chs-radius-pill, 999px)',
  background: ok ? 'var(--chs-color-success-soft)' : 'var(--chs-color-surface-raised)',
  color: ok ? 'var(--chs-color-success)' : 'var(--chs-color-text-muted)',
  border: `1px solid ${ok ? 'var(--chs-color-success)' : 'var(--chs-color-border)'}`,
});

/* ===========================================================================
   T-0496 — "Проверить подключение": server-side LLM connection probe.

   LIVE contract:
     POST /api/llm-connections/:id/test
       → 200 { ok:true,  model, latency_ms, tokens? }   — подключение работает
       → 200 { ok:false, error:"<человеческое сообщение>" } — ошибка ключа/сети
       → 401 / 403 / 404  — auth / прав / профиль не найден

   Сырой ключ НИКОГДА не возвращается: на сервере он резолвится в памяти, в ответ
   приходит только результат теста (ok + модель/латентность ИЛИ санитизированная
   ошибка). Кнопка честна: idle → проверка (спиннер/disabled) → ✓ / ✗.
   =========================================================================== */

/**
 * Pure mapping from the probe HTTP response → button-state result. Exported for
 * unit-testing (project convention: logic lives in testable helpers, the "node"
 * vitest env does not mount React). Returns the normalized result object the
 * ConnectionTester renders.
 *
 *   { ok:true,  model, latencyMs, tokens } | { ok:false, error }
 *
 * NOTE: this only shapes the SERVER's already-sanitized result — the raw key never
 * reaches the client, so there is nothing to redact here.
 */
export function mapTestResponse(status, data) {
  if (status === 401) return { ok: false, error: 'Войдите в систему для проверки подключения.' };
  if (status === 403) return { ok: false, error: 'Недостаточно прав (требуется владелец/админ).' };
  if (status === 404) return { ok: false, error: 'Профиль подключения не найден.' };
  if (status !== 200 || !data || typeof data !== 'object') {
    return { ok: false, error: `Не удалось проверить (HTTP ${status}).` };
  }
  if (data.ok === true) {
    return { ok: true, model: data.model ?? null, latencyMs: data.latency_ms, tokens: data.tokens };
  }
  return { ok: false, error: data.error || 'Подключение не работает.' };
}

/* ===========================================================================
   T-0574 — «Назначить ассистенту»: замыкает BYO-цепочку до места.

   LIVE contract (существующие маршруты, НИКАКИХ новых эндпоинтов):
     GET /api/agents                         — резолвит id ассистента тенанта
                                                 (agent_type==='assistant').
     PUT /api/agents/:id/llm-connection       — привязывает профиль к нему
                                                 (тот же контракт, что уже
                                                 использует /agents-экран).
   =========================================================================== */

/**
 * Pure: из списка GET /api/agents достаёт адрес и текущую привязку ассистента
 * тенанта. Возвращает { assistantEmployeeId, assistantConnectionId } | null
 * (null пока список не загружен / ассистент почему-то отсутствует — до
 * бэкфилла T-0574 на старых тенантах или сетевой ошибки).
 * Экспортирована для unit-теста (project convention: логика — в чистых
 * функциях, тестируемых без mount).
 */
export function resolveAssistantBinding(agents) {
  if (!Array.isArray(agents)) return null;
  const assistant = agents.find((a) => a && a.agent_type === 'assistant');
  if (!assistant) return null;
  return {
    assistantEmployeeId: assistant.id,
    assistantConnectionId: assistant.llm_connection_id ?? null,
  };
}

/**
 * «Назначить ассистенту» — резолвит id ассистента через GET /api/agents (передан
 * родителем, загружен один раз для всего экрана — незачем бить эндпоинт на
 * каждую карточку), затем PUT /api/agents/:id/llm-connection. Честные исходы:
 * 200 → чип «использует профиль» + рефетч; 403 → «недостаточно прав»; сеть → ошибка.
 * Кнопка скрыта, если этот профиль УЖЕ назначен (нет мёртвого enabled-аффорданса).
 */
function AssistantBinder({ connectionId, assistantBinding, onAssigned }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind:'ok'|'err', text }

  const assign = useCallback(async () => {
    if (!assistantBinding || !assistantBinding.assistantEmployeeId) {
      setMsg({ kind: 'err', text: 'Ассистент тенанта пока недоступен — обновите страницу.' });
      return;
    }
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${assistantBinding.assistantEmployeeId}/llm-connection`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ llm_connection_id: connectionId }),
      });
      if (res.status === 200) {
        setMsg({ kind: 'ok', text: 'Профиль назначен ассистенту.' });
        if (onAssigned) onAssigned();
        return;
      }
      if (res.status === 403) {
        setMsg({ kind: 'err', text: 'Недостаточно прав (требуется владелец/админ).' });
        return;
      }
      if (res.status === 404) {
        // Anti-regression sentinel (ADR §2.3): after 3f-bis/migration 115 this
        // must not happen — surfaced honestly if it ever does.
        setMsg({ kind: 'err', text: 'Ассистент тенанта не найден. Обратитесь к оператору.' });
        return;
      }
      setMsg({ kind: 'err', text: `Не удалось назначить профиль (HTTP ${res.status}).` });
    } catch {
      setMsg({ kind: 'err', text: 'Сетевая ошибка — профиль не назначен.' });
    } finally {
      setBusy(false);
    }
  }, [assistantBinding, connectionId, onAssigned]);

  const isAssigned = !!assistantBinding && assistantBinding.assistantConnectionId === connectionId;

  const msgStyle = (kind) => ({
    marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)',
    color: kind === 'ok' ? 'var(--chs-color-success)' : 'var(--chs-color-danger)',
  });

  return (
    <div style={{ marginTop: 'var(--chs-space-3)', width: '100%' }}>
      {isAssigned ? (
        <span style={chipStyle(true)}>
          <Icon name="assistant" />
          ассистент использует этот профиль
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={assign}
          loading={busy}
          disabled={busy || !assistantBinding}
        >
          Назначить ассистенту
        </Button>
      )}
      {msg && <div style={msgStyle(msg.kind)}>{msg.text}</div>}
    </div>
  );
}

function ConnectionTester({ connectionId, secretBound }) {
  const [busy, setBusy] = useState(false);
  // result: null | { ok:true, model, latencyMs, tokens } | { ok:false, error }
  const [result, setResult] = useState(null);

  const runTest = useCallback(async () => {
    setResult(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/llm-connections/${connectionId}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
      let data = null;
      try { data = await res.json(); } catch { /* fallthrough — mapTestResponse handles null */ }
      setResult(mapTestResponse(res.status, data));
    } catch {
      setResult({ ok: false, error: 'Сетевая ошибка — проверка не выполнена.' });
    } finally {
      setBusy(false);
    }
  }, [connectionId]);

  const resultStyle = (ok) => ({
    marginTop: 'var(--chs-space-3)',
    padding: 'var(--chs-space-3) var(--chs-space-4)',
    borderRadius: 'var(--chs-radius-3)',
    fontSize: 'var(--chs-text-xs)',
    background: ok ? 'var(--chs-color-success-soft)' : 'var(--chs-color-danger-soft)',
    border: `1px solid ${ok ? 'var(--chs-color-success)' : 'var(--chs-color-danger)'}`,
    color: 'var(--chs-color-text)',
    display: 'flex', alignItems: 'center', gap: 'var(--chs-space-2)',
  });
  const hintStyle = {
    marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)',
    color: 'var(--chs-color-text-muted)',
  };

  return (
    <div style={{ marginTop: 'var(--chs-space-3)', width: '100%' }}>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        onClick={runTest}
        loading={busy}
        disabled={busy}
      >
        {busy ? 'Проверка…' : 'Проверить подключение'}
      </Button>
      {!secretBound && !result && (
        <div style={hintStyle}>Ключ ещё не привязан — проверка вернёт «ключ не задан».</div>
      )}
      {result && result.ok && (
        <div style={resultStyle(true)}>
          <Icon name="check" />
          <span>
            Подключение работает
            {result.model ? <> · <strong>{result.model}</strong></> : null}
            {typeof result.latencyMs === 'number' ? <> · {result.latencyMs} мс</> : null}
            {result.tokens ? <> · {result.tokens.total} токенов</> : null}
          </span>
        </div>
      )}
      {result && !result.ok && (
        <div style={resultStyle(false)}>
          <span aria-hidden="true">✗</span>
          <span>{result.error}</span>
        </div>
      )}
    </div>
  );
}

/* ===========================================================================
   T-0476 [E-AGENTS L3] — app:// encrypted secret store: "вставить API-ключ".
   SELF-CONTAINED BLOCK (kept distinct to minimize conflict with T-0477).

   Write-only key binding on a connection. The raw key is POSTed once, encrypted
   server-side (AES-256-GCM) into app_secret, and the connection's secret_handle is
   set to app://<id>. The key is NEVER read back: GET status returns only
   secret_bound + redacted scheme. Live contracts:
     POST   /api/llm-connections/:id/key         { api_key }  → 200 { secret_bound }
     GET    /api/llm-connections/:id/key/status  → { secret_bound, scheme }
     DELETE /api/llm-connections/:id/key         → 200 { secret_bound:false }
   503 "secret store not configured" when APP_SECRET_MASTER_KEY is unset (dormant).
   =========================================================================== */
function ConnectionKeyBinder({ connectionId, connectionName, secretBound, onChanged }) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);    // { kind: 'ok'|'err', text }
  const [open, setOpen] = useState(false);
  // T-0526: confirm dialog для отвязки ключа (CONFIRM-DANGER)
  const dc = useDestructiveConfirm();

  const submitKey = useCallback(async (e) => {
    e.preventDefault();
    setMsg(null);
    const raw = apiKey;
    if (!raw || raw.length === 0) {
      setMsg({ kind: 'err', text: 'Вставьте API-ключ.' });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/llm-connections/${connectionId}/key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ api_key: raw }),
      });
      // Clear the raw key from state IMMEDIATELY (write-only — never keep it around).
      setApiKey('');
      if (res.status === 200) {
        setMsg({ kind: 'ok', text: 'Ключ зашифрован и привязан (app://). Сырой ключ не хранится.' });
        setOpen(false);
        if (onChanged) onChanged();
        return;
      }
      if (res.status === 503) {
        setMsg({ kind: 'err', text: 'Хранилище ключей не настроено на сервере (APP_SECRET_MASTER_KEY). Обратитесь к оператору.' });
        return;
      }
      if (res.status === 403) {
        setMsg({ kind: 'err', text: 'Недостаточно прав (требуется владелец/админ).' });
        return;
      }
      setMsg({ kind: 'err', text: `Не удалось привязать ключ (HTTP ${res.status}).` });
    } catch {
      setApiKey('');
      setMsg({ kind: 'err', text: 'Сетевая ошибка — ключ не привязан.' });
    } finally {
      setBusy(false);
    }
  }, [apiKey, connectionId, onChanged]);

  const clearKey = useCallback(async () => {
    setMsg(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/llm-connections/${connectionId}/key`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (res.status === 200) {
        setMsg({ kind: 'ok', text: 'Ключ отвязан.' });
        if (onChanged) onChanged();
        return;
      }
      setMsg({ kind: 'err', text: `Не удалось отвязать ключ (HTTP ${res.status}).` });
    } catch {
      setMsg({ kind: 'err', text: 'Сетевая ошибка — ключ не отвязан.' });
    } finally {
      setBusy(false);
    }
  }, [connectionId, onChanged]);

  const noteStyle = {
    fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)',
    marginTop: 'var(--chs-space-2)',
  };
  const msgStyle = (kind) => ({
    marginTop: 'var(--chs-space-3)', fontSize: 'var(--chs-text-xs)',
    color: kind === 'ok' ? 'var(--chs-color-success)' : 'var(--chs-color-danger)',
  });

  return (
    <div style={{ marginTop: 'var(--chs-space-4)', width: '100%' }}>
      {!open && (
        <div style={{ display: 'flex', gap: 'var(--chs-space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="ghost" size="sm" type="button" onClick={() => { setOpen(true); setMsg(null); }}>
            {secretBound ? 'Заменить API-ключ' : 'Вставить API-ключ'}
          </Button>
          {secretBound && (
            <Button variant="danger" size="sm" type="button" onClick={() => dc.request(connectionId)} loading={dc.loading} disabled={dc.loading || busy}>
              Отвязать
            </Button>
          )}
        </div>
      )}
      {open && (
        <form onSubmit={submitKey} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-3)' }}>
          <Field
            label="API-ключ (вставить)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            type="password"
            autoComplete="off"
            mono
          />
          <div style={noteStyle}>
            Ключ шифруется на сервере и хранится зашифрованным. Обратно он не читается —
            видно только статус «ключ привязан».
          </div>
          <div style={{ display: 'flex', gap: 'var(--chs-space-3)' }}>
            <Button variant="primary" size="sm" type="submit" loading={busy} disabled={busy}>
              Зашифровать и привязать
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => { setApiKey(''); setOpen(false); setMsg(null); }}>
              Отмена
            </Button>
          </div>
        </form>
      )}
      {msg && <div style={msgStyle(msg.kind)}>{msg.text}</div>}

      {/* T-0526: ConfirmDialog для отвязки API-ключа (CONFIRM-DANGER, сайт 11) */}
      <ConfirmDialog
        open={dc.open}
        tone="danger"
        title="Отвязать API-ключ?"
        message={
          <ConsequenceSummary
            who={`LLM-соединение «${connectionName || connectionId}» и все агенты, использующие его`}
            what="Зашифрованный ключ удаляется. Агенты теряют доступ к LLM."
            reversibility="Необратимо. Новый ключ нужно ввести повторно."
          />
        }
        confirmLabel="Отвязать ключ"
        loading={dc.loading}
        onConfirm={() => dc.confirm(clearKey)}
        onClose={dc.cancel}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function LlmConnectionsScreen() {
  const [connections, setConnections] = useState(null); // null = loading, false = error
  const [loadErr, setLoadErr] = useState(null);
  // T-0574: assistant binding (GET /api/agents) — loaded once for the whole
  // screen (one request feeds every card's «Назначить ассистенту» affordance).
  // null while unloaded/unresolvable — AssistantBinder degrades to disabled.
  const [assistantBinding, setAssistantBinding] = useState(null);

  // Create form state
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('deepseek');
  const [endpoint, setEndpoint] = useState('https://api.deepseek.com/v1');
  const [model, setModel] = useState('deepseek-chat');
  const [secretHandle, setSecretHandle] = useState('');
  // T-0477 [E-AGENTS L5]: pre-fill with DeepSeek price presets (initial provider).
  const [priceIn, setPriceIn] = useState('0.14');
  const [priceOut, setPriceOut] = useState('0.28');
  const [currency, setCurrency] = useState('USD');
  const [isDefault, setIsDefault] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitErr, setSubmitErr] = useState(null);
  const [createOk, setCreateOk] = useState(false);
  const [saving, setSaving] = useState(false);

  // -------------------------------------------------------------------------
  // Load connection list
  // -------------------------------------------------------------------------
  const loadConnections = useCallback(async () => {
    setLoadErr(null);
    setConnections(null);
    try {
      const res = await fetch('/api/llm-connections', { headers: authHeaders() });
      if (res.status === 401) {
        setLoadErr('Войдите в систему для доступа к LLM-соединениям.');
        setConnections(false);
        return;
      }
      if (res.status === 403) {
        setLoadErr('Недостаточно прав: настройка LLM-соединений доступна владельцу/админу.');
        setConnections(false);
        return;
      }
      if (!res.ok) {
        setLoadErr(`Ошибка загрузки списка (HTTP ${res.status}).`);
        setConnections(false);
        return;
      }
      const data = await res.json();
      setConnections(Array.isArray(data.connections) ? data.connections : []);
    } catch {
      setLoadErr('Сетевая ошибка — не удалось загрузить список соединений.');
      setConnections(false);
    }
  }, []);

  useEffect(() => { loadConnections(); }, [loadConnections]);

  // -------------------------------------------------------------------------
  // T-0574: load the assistant binding (best-effort — a failure here degrades
  // the «Назначить ассистенту» affordance to disabled, it does NOT block the
  // rest of the screen: creating/testing/binding a key is independent of it).
  // -------------------------------------------------------------------------
  const loadAssistantBinding = useCallback(async () => {
    try {
      const res = await fetch('/api/agents', { headers: authHeaders() });
      if (!res.ok) return; // honest degrade — button stays disabled
      const data = await res.json();
      setAssistantBinding(resolveAssistantBinding(data.agents));
    } catch {
      // Network error — degrade silently (the connections list already shows
      // its own ErrorState for the primary load failure).
    }
  }, []);

  useEffect(() => { loadAssistantBinding(); }, [loadAssistantBinding]);

  // -------------------------------------------------------------------------
  // Provider preset change → auto-fill endpoint + model
  // -------------------------------------------------------------------------
  // T-0477 [E-AGENTS L5]: onProviderChange also auto-fills price presets.
  // Prices are user-editable — the preset is just a convenient starting point.
  const onProviderChange = (e) => {
    const val = e.target.value;
    setProvider(val);
    const found = PROVIDER_PRESETS.find((p) => p.value === val);
    if (found) {
      setEndpoint(found.endpoint);
      setModel(found.model);
      // Fill prices only if currently blank (don't override user edits).
      if (found.priceIn) setPriceIn(found.priceIn);
      if (found.priceOut) setPriceOut(found.priceOut);
      if (found.currency) setCurrency(found.currency);
    }
    setFieldErrors({});
    setCreateOk(false);
    setSubmitErr(null);
  };

  // -------------------------------------------------------------------------
  // Client-side validation (server is the authority; this is a UX pre-check)
  // -------------------------------------------------------------------------
  function validate() {
    const errs = {};
    if (!name.trim()) errs.name = 'Укажите имя профиля.';
    if (endpoint.trim()) {
      try {
        const u = new URL(endpoint.trim());
        if (u.protocol !== 'https:') errs.endpoint = 'Эндпойнт должен использовать https.';
        else if (u.username) errs.endpoint = 'Эндпойнт не должен содержать user@host.';
      } catch {
        errs.endpoint = 'Некорректный URL.';
      }
    }
    // Secret handle is OPTIONAL but, if present, must look like a reference, not a raw key.
    const sh = secretHandle.trim();
    if (sh) {
      if (/^sk-|^xai-|^AIza/.test(sh) || /^eyJ[A-Za-z0-9_-]+\./.test(sh) || /^[0-9a-fA-F]{32,}$/.test(sh)) {
        errs.secretHandle = 'Это похоже на СЫРОЙ ключ. Укажите ССЫЛКУ-хэндл (env://ИМЯ, vault://путь).';
      } else if (sh.length < 8) {
        errs.secretHandle = 'Слишком короткий хэндл.';
      }
    }
    for (const [k, label] of [['priceIn', priceIn], ['priceOut', priceOut]]) {
      const v = (k === 'priceIn' ? priceIn : priceOut).trim();
      if (v && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
        errs[k] = 'Цена должна быть неотрицательным числом.';
      }
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  // -------------------------------------------------------------------------
  // Create (POST /api/llm-connections)
  // -------------------------------------------------------------------------
  const onCreate = useCallback(async (e) => {
    e.preventDefault();
    setSubmitErr(null);
    setCreateOk(false);
    if (!validate()) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        provider,
        is_default: isDefault,
        currency: currency.trim() || 'USD',
      };
      if (endpoint.trim()) body.endpoint = endpoint.trim();
      if (model.trim()) body.model = model.trim();
      if (secretHandle.trim()) body.secret_handle = secretHandle.trim();
      if (priceIn.trim()) body.price_input_per_1k = Number(priceIn.trim());
      if (priceOut.trim()) body.price_output_per_1k = Number(priceOut.trim());

      const res = await fetch('/api/llm-connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        setCreateOk(true);
        // Reset only the per-profile fields; keep provider/currency for the next one.
        setName('');
        setSecretHandle('');
        await loadConnections();
        return;
      }
      let detail = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.message) detail = data.message;
      } catch { /* keep status */ }
      if (res.status === 403) detail = 'Недостаточно прав (требуется владелец/админ).';
      setSubmitErr(detail);
    } catch {
      setSubmitErr('Сетевая ошибка — соединение не создано.');
    } finally {
      setSaving(false);
    }
  }, [name, provider, endpoint, model, secretHandle, priceIn, priceOut, currency, isDefault, loadConnections]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: 'var(--chs-space-7)' }}>
      <h1 style={{ fontSize: 'var(--chs-text-lg)', fontWeight: 'var(--chs-weight-bold)', color: 'var(--chs-color-text)', margin: '0 0 var(--chs-space-6) 0' }}>
        LLM-соединения
      </h1>

      {/* T-0574 (F6/AC-11): статическая инструкция, без дев-жаргона — где
          взять ключ Anthropic и что с ним делать на этой странице. */}
      <div style={{ ...sectionStyle, background: 'var(--chs-color-surface-raised)' }}>
        <h2 style={headingStyle}>Откуда взять ключ и что с ним сделать</h2>
        <p style={{ ...descStyle, margin: 0 }}>
          Зайдите на <span style={monoStyle}>console.anthropic.com</span>, откройте
          раздел «API Keys» и нажмите «Create Key» — сервис покажет ключ один раз,
          скопируйте его. Ниже создайте профиль с провайдером «Anthropic», нажмите
          «Вставить API-ключ» и вставьте скопированное значение в открывшееся поле.
          После сохранения нажмите «Проверить подключение» — если всё в порядке,
          назначьте профиль ассистенту одной кнопкой на его карточке, и ассистент
          компании начнёт отвечать на ваших сообщениях этим ключом.
        </p>
      </div>

      {/* ── Create form ──────────────────────────────────────────────── */}
      <form style={sectionStyle} onSubmit={onCreate}>
        <h2 style={headingStyle}>Новый профиль</h2>
        <p style={descStyle}>
          Именованное подключение к LLM (провайдер, эндпойнт, модель, цены). Профиль
          можно переиспользовать для разных агентов. Сырой ключ здесь не хранится — в
          поле «секрет-хэндл» укажите ССЫЛКУ (например <span style={monoStyle}>env://DEEPSEEK_API_KEY</span>).
        </p>

        <div style={fieldGap}>
          <Field
            label="Имя профиля"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="DeepSeek (прод)"
            invalid={!!fieldErrors.name}
            hint={fieldErrors.name || undefined}
          />

          <div style={rowGap}>
            <div style={{ flex: '1 1 200px' }}>
              <Select label="Провайдер" value={provider} onChange={onProviderChange}>
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </Select>
            </div>
            <div style={{ flex: '2 1 320px' }}>
              <Field
                label="Эндпойнт (base URL)"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://api.deepseek.com/v1"
                invalid={!!fieldErrors.endpoint}
                hint={fieldErrors.endpoint || 'OpenAI-совместимый https base URL'}
                type="url"
              />
            </div>
          </div>

          <Field
            label="Модель"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="deepseek-chat"
            mono
          />

          <Field
            label="Секрет-хэндл (ссылка, не ключ)"
            value={secretHandle}
            onChange={(e) => setSecretHandle(e.target.value)}
            placeholder="env://DEEPSEEK_API_KEY"
            invalid={!!fieldErrors.secretHandle}
            hint={fieldErrors.secretHandle || 'Опционально. ССЫЛКА на секрет (env:// / vault:// / app://). Сырой ключ будет отклонён.'}
            mono
          />

          <div style={rowGap}>
            <div style={{ flex: '1 1 160px' }}>
              <Field
                label="Цена вход / 1k токенов"
                value={priceIn}
                onChange={(e) => setPriceIn(e.target.value)}
                placeholder="0.14"
                invalid={!!fieldErrors.priceIn}
                hint={fieldErrors.priceIn || undefined}
                inputMode="decimal"
              />
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <Field
                label="Цена выход / 1k токенов"
                value={priceOut}
                onChange={(e) => setPriceOut(e.target.value)}
                placeholder="0.28"
                invalid={!!fieldErrors.priceOut}
                hint={fieldErrors.priceOut || undefined}
                inputMode="decimal"
              />
            </div>
            <div style={{ flex: '0 1 120px' }}>
              <Field
                label="Валюта"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                placeholder="USD"
                mono
              />
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)' }}>
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Использовать как профиль по умолчанию (для ассистента)
          </label>

          <div>
            <Button variant="primary" size="sm" type="submit" loading={saving} disabled={saving}>
              Создать соединение
            </Button>
          </div>

          {submitErr && <div style={bannerErrStyle}>{submitErr}</div>}
          {createOk && <div style={bannerOkStyle}>Профиль создан.</div>}
        </div>
      </form>

      {/* ── Connection list ──────────────────────────────────────────── */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--chs-space-5)' }}>
          <h2 style={{ ...headingStyle, margin: 0 }}>Профили подключений</h2>
          <Button variant="ghost" size="sm" type="button" onClick={loadConnections}>Обновить</Button>
        </div>

        {connections === null && <LoadingState label="Загрузка соединений…" />}

        {connections === false && (
          <ErrorState
            title="Не удалось загрузить соединения"
            message={loadErr ?? 'Неизвестная ошибка.'}
            onRetry={loadConnections}
          />
        )}

        {Array.isArray(connections) && connections.length === 0 && (
          <EmptyState
            title="Пока нет профилей"
            description="Создайте первое LLM-соединение выше."
          />
        )}

        {Array.isArray(connections) && connections.length > 0 && (
          <div>
            {connections.map((c) => (
              <div key={c.id} style={{ ...cardStyle, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={nameStyle}>
                    {c.name}
                    {c.is_default && (
                      <span style={{ ...chipStyle(true), marginLeft: 'var(--chs-space-3)' }}>по умолчанию</span>
                    )}
                  </div>
                  <div style={metaStyle}>
                    {c.provider}
                    {c.model && <> · <span style={monoStyle}>{c.model}</span></>}
                  </div>
                  {c.endpoint && (
                    <div style={metaStyle}><span style={monoStyle}>{c.endpoint}</span></div>
                  )}
                  {(c.price_input_per_1k != null || c.price_output_per_1k != null) && (
                    <div style={metaStyle}>
                      Цена: вход {c.price_input_per_1k ?? '—'} / выход {c.price_output_per_1k ?? '—'} {c.currency}/1k
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 'var(--chs-space-2)' }}>
                  <span style={chipStyle(c.secret_bound)}>
                    {c.secret_bound && <Icon name="check" />}
                    {c.secret_bound ? 'ключ привязан' : 'ключ не привязан'}
                  </span>
                  {c.secret_handle_redacted && (
                    <span style={monoStyle}>{c.secret_handle_redacted}</span>
                  )}
                </div>
                {/* T-0476 [E-AGENTS L3]: write-only app:// key binder (self-contained). */}
                <ConnectionKeyBinder
                  connectionId={c.id}
                  connectionName={c.name}
                  secretBound={!!c.secret_bound}
                  onChanged={loadConnections}
                />
                {/* T-0496: server-side "Проверить подключение" probe (self-contained). */}
                <ConnectionTester
                  connectionId={c.id}
                  secretBound={!!c.secret_bound}
                />
                {/* T-0574 (F4/AC-4): «Назначить ассистенту» — closes the BYO-LLM
                    chain in-place, no navigation to the agents screen. */}
                <AssistantBinder
                  connectionId={c.id}
                  assistantBinding={assistantBinding}
                  onAssigned={() => { loadAssistantBinding(); loadConnections(); }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
