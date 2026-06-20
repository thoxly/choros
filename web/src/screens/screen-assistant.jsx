/* ============================================================================
   CHOROS — screen-assistant.jsx  (T-0358, E17 shell)
   Раздел «Ассистент»: треды-чаты с AI-агентом в пространстве авторинга.

   SHELL-ONLY: LLM-роутинг, инструменты КОНФИГУРАТОРА и АНАЛИТИКА — задачи
   T-0359/T-0360/T-0361. Чистый шов (TODO-SEAM) явно помечен в коде.

   КОНТРАКТЫ (будущие, не вызываются пока):
     GET  /api/assistant/threads               — список тредов
     POST /api/assistant/threads               — создать тред
     GET  /api/assistant/threads/:id/messages  — сообщения треда
     POST /api/assistant/threads/:id/messages  — отправить (LLM вызывается здесь)
     GET  /api/assistant/threads/:id/budget    — бюджет треда (токены/деньги)

   КОНТЕКСТ-AWARE ВХОД (T-0358 §scope):
     Пропс `contextRef` { kind: 'record'|'app'|'process', id, label } позволяет
     открыть ассистента с предзаполненным контекстом из любой карточки/раздела.
     Пример: <Button onClick={() => navigate('/assistant', { state: { contextRef: { kind:'record', id, label } } })}>
       Спросить ассистента
     </Button>
     В этом файле мы читаем location.state.contextRef (если есть) и показываем
     контекст-баннер в форме нового сообщения.

   ПРАВА-ГЕЙТ (TODO-SEAM):
     Реальная проверка прав будет в T-0359 (конфигуратор) / T-0360 (аналитик).
     Пока любой залогинённый пользователь видит раздел (honesty: демо-статус в nav).

   ДИЗАЙН: строго OBLIK — только --chs-* токены, kit-компоненты, светлая основная,
   пустые/загрузочные/ошибочные состояния, нет hardcode-цветов/эмодзи.
   ============================================================================ */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Button, EmptyState, LoadingState, ErrorState, Skeleton,
} from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';

/* ---------------------------------------------------------------------------
   TODO-SEAM T-0359/T-0360: заменить stub-вызовы реальными API-запросами.
   Структуры данных фиксируют контракт между shell (T-0358) и impl (T-0359+).
   --------------------------------------------------------------------------- */

// T-0359: REAL threads hook — GET/POST /api/assistant/threads
function useThreadsStub() {
  const [threads, setThreads] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    fetch('/api/assistant/threads', { headers: authHeaders() })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setThreads(d.threads ?? []))
      .catch((err) => setError(err.message ?? 'Не удалось загрузить разговоры.'));
  }, []);

  useEffect(() => { load(); }, [load]);

  const createThread = useCallback(async ({ title, contextRef }) => {
    const r = await fetch('/api/assistant/threads', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title || 'Новый разговор', context_ref: contextRef || null }),
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => `HTTP ${r.status}`);
      throw new Error(msg);
    }
    const thread = await r.json();
    setThreads((prev) => [thread, ...(prev || [])]);
    return thread;
  }, []);

  return { threads, error, load, createThread };
}

// T-0359: REAL messages hook — GET/POST /api/assistant/threads/:id/messages
function useMessagesStub(threadId) {
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!threadId) { setMessages([]); return; }
    setError(null);
    fetch(`/api/assistant/threads/${threadId}/messages`, { headers: authHeaders() })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setMessages(d.messages ?? []))
      .catch((err) => setError(err.message ?? 'Не удалось загрузить сообщения.'));
  }, [threadId]);

  const send = useCallback(async (text, contextRef) => {
    if (!text.trim()) return;

    // Optimistic: добавляем сообщение пользователя сразу в UI.
    const userMsg = {
      id: `msg-u-${Date.now()}`,
      role: 'user',
      text,
      ts: new Date().toISOString(),
      context_ref: contextRef || null,
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    setError(null);

    try {
      const r = await fetch(`/api/assistant/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, context_ref: contextRef || null }),
      });

      if (r.status === 503) {
        // LLM не настроен — честный 503.
        const d = await r.json().catch(() => ({}));
        const assistantMsg = {
          id: `msg-dormant-${Date.now()}`,
          role: 'assistant',
          text: d.message ?? 'LLM не настроен — настройте BYO-ключ для активации ассистента.',
          ts: new Date().toISOString(),
          streaming_done: true,
        };
        setMessages((prev) => [...prev, assistantMsg]);
        return;
      }

      if (!r.ok) {
        const msg = await r.text().catch(() => `HTTP ${r.status}`);
        throw new Error(msg);
      }

      const assistantMsg = await r.json();
      // Normalize to expected shape.
      setMessages((prev) => [
        ...prev,
        {
          id: assistantMsg.id,
          role: 'assistant',
          text: assistantMsg.text,
          ts: assistantMsg.ts || new Date().toISOString(),
          streaming_done: assistantMsg.streaming_done ?? true,
        },
      ]);
    } catch (err) {
      setError(err.message ?? 'Не удалось отправить сообщение. Проверьте подключение.');
    } finally {
      setStreaming(false);
    }
  }, [threadId]);

  return { messages, streaming, error, send };
}

// T-0359: REAL budget hook — GET /api/assistant/threads/:id/budget
function useBudgetStub(threadId) {
  const [budget, setBudget] = useState(null);

  useEffect(() => {
    if (!threadId) { setBudget(null); return; }
    fetch(`/api/assistant/threads/${threadId}/budget`, { headers: authHeaders() })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setBudget(d))
      .catch(() => setBudget(null));
  }, [threadId]);

  return budget;
}

/* ---------------------------------------------------------------------------
   КОМПОНЕНТЫ
   --------------------------------------------------------------------------- */

/**
 * Левая панель: список тредов.
 * Пустое, загрузочное, ошибочное состояния — через kit-компоненты.
 */
function ThreadList({ threads, activeId, onSelect, onCreate, loading, error, onRetry }) {
  if (loading) {
    return (
      <div className="chs-asst__list-body">
        <LoadingState label="Загрузка разговоров…" compact />
      </div>
    );
  }
  if (error) {
    return (
      <div className="chs-asst__list-body">
        <ErrorState title="Не удалось загрузить" message={error} onRetry={onRetry} compact />
      </div>
    );
  }
  return (
    <div className="chs-asst__list-body">
      {(!threads || threads.length === 0) ? (
        <EmptyState
          title="Разговоров пока нет"
          description="Начните новый разговор с ассистентом."
          compact
        />
      ) : (
        <ul className="chs-asst__threads" role="listbox" aria-label="Разговоры">
          {threads.map((t) => (
            <li key={t.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={t.id === activeId}
                className={`chs-asst__thread ${t.id === activeId ? 'chs-asst__thread--active' : ''}`}
                onClick={() => onSelect(t)}
              >
                <span className="chs-asst__thread-title">{t.title}</span>
                <span className="chs-asst__thread-meta">
                  {t.message_count > 0
                    ? `${t.message_count} сообщ.`
                    : 'пусто'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Индикатор бюджета треда в хедере.
 * Показывает токены + стоимость из бюджет-контракта (CONCEPT §3).
 * TODO-SEAM T-0359: заменить stub useBudgetStub реальным GET /api/assistant/threads/:id/budget.
 */
function BudgetIndicator({ budget }) {
  if (!budget) return null;
  const pct = budget.tokens_limit > 0
    ? Math.min(100, (budget.tokens_used / budget.tokens_limit) * 100)
    : 0;
  const state = pct >= 90 ? 'over' : pct >= 70 ? 'warn' : 'ok';
  return (
    <div className="chs-asst__budget" title={`Токенов использовано: ${budget.tokens_used.toLocaleString('ru-RU')} / ${budget.tokens_limit.toLocaleString('ru-RU')}`}>
      <span className="chs-asst__budget-label">
        {budget.tokens_used.toLocaleString('ru-RU')} / {budget.tokens_limit.toLocaleString('ru-RU')} токенов
      </span>
      <div className="chs-asst__budget-track">
        <div
          className={`chs-asst__budget-fill chs-asst__budget-fill--${state}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Пузырь сообщения.
 * T-0360 (АНАЛИТИК): для ответов аналитика (intent="analyst") рядом с текстом
 * показывается кнопка «Сохранить как отчёт», вызывающая POST /api/report-pages
 * с tier=draft. Это НЕ новый маршрут — существующий report-pages API (T-0121).
 */
function MessageBubble({ msg, activeThreadId }) {
  const isUser = msg.role === 'user';
  const isAnalyst = !isUser && msg.intent === 'analyst';
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [saveError, setSaveError] = React.useState(null);

  // Derive app_id from the message context: only an 'app' context carries a real
  // app UUID. Records and processes belong to apps indirectly and we don't have
  // the FK here, so we cannot derive a valid app_id from them.
  // report_page has FK (tenant_id, app_id) → choros.application, so we must
  // never POST a nil/fake UUID — disable the button when no app context exists.
  const contextAppId =
    msg.context_ref?.kind === 'app' ? msg.context_ref.id : null;
  const canSaveReport = Boolean(contextAppId);
  const saveDisabledReason = canSaveReport
    ? null
    : 'Откройте ассистента из приложения, чтобы сохранить отчёт';

  const handleSaveReport = async () => {
    if (!canSaveReport) return; // guard: should not be reachable due to disabled state
    setSaving(true);
    setSaveError(null);
    try {
      // POST /api/report-pages — существующий маршрут (T-0121).
      // Saves a Floor-2 report draft with the analyst reply text as page_code.
      // app_id comes from the message context_ref (kind='app') — a real FK-safe UUID.
      const r = await fetch('/api/report-pages', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // slug derived from thread + message id for uniqueness
          app_id: contextAppId,
          slug: `analyst-${(activeThreadId || 'x').slice(0, 8)}-${msg.id.slice(0, 8)}`,
          title: 'Отчёт от ассистента',
          floor: '2',
          page_code: msg.text,
        }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => `HTTP ${r.status}`);
        throw new Error(txt);
      }
      setSaved(true);
    } catch (err) {
      setSaveError(err.message ?? 'Не удалось сохранить отчёт.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`chs-asst__msg ${isUser ? 'chs-asst__msg--user' : 'chs-asst__msg--asst'}`}>
      <div className="chs-asst__msg-role">
        {isUser ? 'Вы' : 'Ассистент'}
        {isAnalyst && (
          <span className="chs-asst__msg-badge" aria-label="Режим аналитика">
            {' '}анализ
          </span>
        )}
      </div>
      {msg.context_ref && (
        <div className="chs-asst__msg-ctx">
          Контекст: {msg.context_ref.kind === 'record' ? 'Запись' : msg.context_ref.kind === 'app' ? 'Приложение' : 'Процесс'} «{msg.context_ref.label}»
        </div>
      )}
      <div className="chs-asst__msg-text">{msg.text}</div>
      {/* T-0360: Сохранить как отчёт — только для ответов аналитика.
          Button is disabled (with tooltip) when no app context is present to
          avoid an FK violation on report_page(tenant_id, app_id) → application. */}
      {isAnalyst && !saved && (
        <div className="chs-asst__msg-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={saving || !canSaveReport}
            loading={saving}
            onClick={handleSaveReport}
            aria-label={saveDisabledReason ?? 'Сохранить этот анализ как именованный отчёт'}
            title={saveDisabledReason ?? undefined}
          >
            Сохранить как отчёт
          </Button>
          {saveError && (
            <span className="chs-asst__save-error" role="alert">{saveError}</span>
          )}
        </div>
      )}
      {isAnalyst && saved && (
        <div className="chs-asst__msg-actions">
          <span className="chs-asst__save-ok">Отчёт сохранён</span>
        </div>
      )}
    </div>
  );
}

/**
 * Заглушка «стриминг в процессе».
 */
function StreamingBubble() {
  return (
    <div className="chs-asst__msg chs-asst__msg--asst chs-asst__msg--streaming">
      <div className="chs-asst__msg-role">Ассистент</div>
      <div className="chs-asst__msg-text chs-asst__streaming-dots" aria-live="polite" aria-label="Ассистент печатает…">
        <span /><span /><span />
      </div>
    </div>
  );
}

/**
 * Форма ввода сообщения. Отправка по Enter (без Shift) или кнопке.
 * Disabled пока streaming=true.
 */
function Composer({ onSend, streaming, contextRef, onClearContext }) {
  const [text, setText] = useState('');
  const textareaRef = useRef(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!text.trim() || streaming) return;
    onSend(text, contextRef || null);
    setText('');
    textareaRef.current && textareaRef.current.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form className="chs-asst__composer" onSubmit={handleSubmit} aria-label="Форма сообщения">
      {contextRef && (
        <div className="chs-asst__ctx-banner">
          <span className="chs-asst__ctx-label">
            Контекст:
            {' '}
            {contextRef.kind === 'record' ? 'Запись' : contextRef.kind === 'app' ? 'Приложение' : 'Процесс'}
            {' «'}{contextRef.label}{'»'}
          </span>
          <button
            type="button"
            className="chs-asst__ctx-clear"
            aria-label="Убрать контекст"
            onClick={onClearContext}
          >
            убрать
          </button>
        </div>
      )}
      <div className="chs-asst__composer-inner">
        <textarea
          ref={textareaRef}
          className="chs-asst__textarea"
          placeholder={streaming ? 'Ожидание ответа…' : 'Напишите ассистенту… (Enter — отправить, Shift+Enter — перенос строки)'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={streaming}
          rows={3}
          aria-label="Сообщение ассистенту"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!text.trim() || streaming}
          loading={streaming}
          aria-label="Отправить сообщение"
        >
          Отправить
        </Button>
      </div>
    </form>
  );
}

/**
 * Область сообщений треда.
 */
function ThreadView({ thread, messages, streaming, msgError, onSend, contextRef, onClearContext, budget, threadId }) {
  const bottomRef = useRef(null);

  // Прокрутка к последнему сообщению при добавлении нового
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streaming]);

  return (
    <div className="chs-asst__thread-view">
      {/* Хедер треда */}
      <div className="chs-asst__thread-head">
        <span className="chs-asst__thread-head-title">{thread.title}</span>
        <BudgetIndicator budget={budget} />
      </div>

      {/* Список сообщений */}
      <div className="chs-asst__messages" role="log" aria-label="Сообщения разговора" aria-live="polite">
        {messages.length === 0 && !streaming && (
          <EmptyState
            title="Начните разговор"
            description="Опишите, что нужно настроить или проанализировать — ассистент ответит."
            compact
          />
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} activeThreadId={threadId} />
        ))}
        {streaming && <StreamingBubble />}
        {msgError && (
          <div className="chs-asst__msg-error" role="alert">{msgError}</div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Форма отправки */}
      <Composer
        onSend={onSend}
        streaming={streaming}
        contextRef={contextRef}
        onClearContext={onClearContext}
      />
    </div>
  );
}

/**
 * Заглушка «ни один тред не выбран» — правая панель пустая.
 */
function NothingSelected({ onCreate }) {
  return (
    <div className="chs-asst__empty-pane">
      <EmptyState
        title="Выберите разговор"
        description="Выберите разговор из списка слева или начните новый."
        action={
          <Button variant="primary" size="sm" onClick={onCreate}>
            Новый разговор
          </Button>
        }
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   ЭКРАН
   --------------------------------------------------------------------------- */

export default function AssistantScreen() {
  const { threadId: paramThreadId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  // Контекст-aware вход: location.state может содержать { contextRef: {...} }
  // (передаётся через navigate('/assistant', { state: { contextRef: ... } }))
  const [contextRef, setContextRef] = useState(
    () => location.state?.contextRef || null,
  );

  const { threads, error: threadsError, load: loadThreads, createThread } = useThreadsStub();
  const loading = threads === null;

  // Активный тред — из URL-параметра или стейта
  const [activeThread, setActiveThread] = useState(null);

  // Синхронизация активного треда с URL
  useEffect(() => {
    if (!threads) return;
    if (paramThreadId) {
      const found = threads.find((t) => t.id === paramThreadId);
      setActiveThread(found || null);
    } else {
      setActiveThread(null);
    }
  }, [paramThreadId, threads]);

  const { messages, streaming, error: msgError, send } = useMessagesStub(activeThread?.id || null);
  const budget = useBudgetStub(activeThread?.id || null);

  const handleSelectThread = (thread) => {
    setActiveThread(thread);
    navigate(`/assistant/${thread.id}`);
  };

  const handleCreate = useCallback(() => {
    const thread = createThread({ title: 'Новый разговор', contextRef });
    setActiveThread(thread);
    navigate(`/assistant/${thread.id}`);
    // Сбрасываем контекст-ref после открытия треда (он будет в первом сообщении)
  }, [createThread, contextRef, navigate]);

  const handleSend = useCallback((text, ctxRef) => {
    send(text, ctxRef);
    // После первого сообщения контекст-ref «использован» — убираем из формы
    setContextRef(null);
  }, [send]);

  return (
    <div className="chs-asst">
      {/* Левая панель: список тредов */}
      <aside className="chs-asst__sidebar">
        <div className="chs-asst__sidebar-head">
          <span className="chs-asst__sidebar-title">Разговоры</span>
          {/* TODO-SEAM T-0359: кнопка «Новый разговор» инициирует POST /api/assistant/threads,
              после чего навигирует в тред. Пока — stub createThread(). */}
          <Button
            variant="primary"
            size="sm"
            glyph={<Icon name="plus" className="chs-btn__glyph" />}
            onClick={handleCreate}
            title="Начать новый разговор с ассистентом"
          >
            Новый
          </Button>
        </div>

        <ThreadList
          threads={threads}
          activeId={activeThread?.id}
          onSelect={handleSelectThread}
          onCreate={handleCreate}
          loading={loading}
          error={threadsError}
          onRetry={loadThreads}
        />

        {/* Контекст-aware вход: если есть contextRef в state, показываем баннер */}
        {contextRef && !activeThread && (
          <div className="chs-asst__ctx-hint">
            <div className="chs-asst__ctx-hint-label">
              Контекст для нового разговора:
            </div>
            <div className="chs-asst__ctx-hint-ref">
              {contextRef.kind === 'record' ? 'Запись' : contextRef.kind === 'app' ? 'Приложение' : 'Процесс'}
              {' «'}{contextRef.label}{'»'}
            </div>
            <div className="chs-asst__ctx-hint-actions">
              <Button
                variant="primary"
                size="sm"
                onClick={handleCreate}
                title="Начать разговор с этим контекстом"
              >
                Начать разговор
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setContextRef(null)}
              >
                Убрать контекст
              </Button>
            </div>
          </div>
        )}
      </aside>

      {/* Правая панель: тред или пустышка */}
      <section className="chs-asst__main" aria-label="Разговор с ассистентом">
        {activeThread ? (
          <ThreadView
            thread={activeThread}
            messages={messages}
            streaming={streaming}
            msgError={msgError}
            onSend={handleSend}
            contextRef={contextRef}
            onClearContext={() => setContextRef(null)}
            budget={budget}
            threadId={activeThread?.id}
          />
        ) : (
          <NothingSelected onCreate={handleCreate} />
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   CONTEXT-AWARE ENTRY POINT HELPER (экспорт для других экранов)
   ---------------------------------------------------------------------------
   Другие экраны импортируют `openAssistantWithContext` и вызывают его
   (передавая navigate из react-router) чтобы открыть ассистента с контекстом.

   Пример использования в screen-app-records.jsx:
     import { openAssistantWithContext } from './screen-assistant.jsx';
     ...
     <Button onClick={() => openAssistantWithContext(navigate, { kind:'app', id: appId, label: appName })}>
       Спросить ассистента
     </Button>

   TODO-SEAM T-0359: когда будет бэкенд, можно сразу создавать тред через API
   здесь и передавать threadId как state, а экран откроет его напрямую.
   --------------------------------------------------------------------------- */
export function openAssistantWithContext(navigate, contextRef) {
  navigate('/assistant', { state: { contextRef } });
}
