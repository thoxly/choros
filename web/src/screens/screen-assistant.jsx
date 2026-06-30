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
  Button, EmptyState, LoadingState, ErrorState, Skeleton, ConfirmDialog, KitIcon,
} from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { useToastContext } from '../app-shell/toast-context.jsx';
import { ConsequenceSummary } from '../util/confirm-helpers.jsx';
// T-0545: AI-emit seam — SAME gate as human editor (FF-T0545-SAME-GATE).
import { emitSurfaceLocal, defaultEmitIntent } from '../forms/form-emit-seam.js';
import { parseRecordSchema } from './apps-schema.js';

/* ---------------------------------------------------------------------------
   TODO-SEAM T-0359/T-0360: заменить stub-вызовы реальными API-запросами.
   Структуры данных фиксируют контракт между shell (T-0358) и impl (T-0359+).
   --------------------------------------------------------------------------- */

// T-0359 / T-0384: threads hook — GET/POST/PATCH/DELETE /api/assistant/threads
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

  const createThread = useCallback(async ({ contextRef } = {}) => {
    // T-0384 lazy-create: title omitted — thread is invisible in list until first
    // message fires auto-title. We pass context_ref only.
    const r = await fetch('/api/assistant/threads', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ context_ref: contextRef || null }),
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => `HTTP ${r.status}`);
      throw new Error(msg);
    }
    const thread = await r.json();
    // Don't push to list yet — thread is hidden until first message (lazy-create).
    return thread;
  }, []);

  // T-0384: rename / pin a thread via PATCH
  const patchThread = useCallback(async (id, patch) => {
    const r = await fetch(`/api/assistant/threads/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => `HTTP ${r.status}`);
      throw new Error(msg);
    }
    // Refresh list to reflect updated title / pin state.
    load();
  }, [load]);

  // T-0384: delete a thread via DELETE
  const deleteThread = useCallback(async (id) => {
    const r = await fetch(`/api/assistant/threads/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => `HTTP ${r.status}`);
      throw new Error(msg);
    }
    // Remove from local state immediately; server tombstone takes care of the rest.
    setThreads((prev) => (prev ? prev.filter((t) => t.id !== id) : prev));
  }, []);

  return { threads, error, load, createThread, patchThread, deleteThread };
}

// T-0359 / T-0384: messages hook — GET/POST /api/assistant/threads/:id/messages
// onFirstMessage callback lets the parent reload the thread list to pick up
// the auto-title event appended on the first message (T-0384 lazy-create).
function useMessagesStub(threadId, onFirstMessage) {
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

    // T-0384: track whether this is the first message so we can fire onFirstMessage
    // callback after a successful send (triggers thread list reload for auto-title).
    const isFirst = messages.length === 0;

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
          intent: assistantMsg.intent,
          // T-0465 (D8-G4): REVIEW-IN-SECTIONS. Deep-links into the actual sections
          // (Приложения / Модельер) + a bundle-promote descriptor — present only when
          // the bot generated a solution bundle this turn. Rendered as clickable links
          // + a "publish whole solution" button, NOT a constructor inside the chat.
          deepLinks: assistantMsg.deepLinks ?? null,
          bundlePromote: assistantMsg.bundlePromote ?? null,
        },
      ]);
      // T-0384: after first message, reload thread list to surface auto-title.
      if (isFirst && onFirstMessage) onFirstMessage();
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
 * Встроенный инпут для переименования треда (T-0384).
 * Подтверждение: Enter или blur; отмена: Escape.
 */
function RenameInput({ initialTitle, onConfirm, onCancel }) {
  const [value, setValue] = useState(initialTitle);
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.select();
  }, []);

  const confirm = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initialTitle) onConfirm(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      className="chs-asst__rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={confirm}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirm(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      aria-label="Переименовать разговор"
      maxLength={120}
    />
  );
}

/**
 * Левая панель: список тредов.
 * Пустое, загрузочное, ошибочное состояния — через kit-компоненты.
 * T-0384: каждый тред имеет кнопки «закрепить», «переименовать», «удалить».
 */
function ThreadList({ threads, activeId, onSelect, onCreate, loading, error, onRetry, onRename, onPin, onDelete }) {
  const [renamingId, setRenamingId] = useState(null);

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
            <li key={t.id} role="presentation" className={`chs-asst__thread-item${t.pinned ? ' chs-asst__thread-item--pinned' : ''}`}>
              {renamingId === t.id ? (
                <RenameInput
                  initialTitle={t.title}
                  onConfirm={(newTitle) => { setRenamingId(null); onRename(t.id, newTitle); }}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <button
                  type="button"
                  role="option"
                  aria-selected={t.id === activeId}
                  className={`chs-asst__thread ${t.id === activeId ? 'chs-asst__thread--active' : ''}`}
                  onClick={() => onSelect(t)}
                >
                  {t.pinned && (
                    <span className="chs-asst__thread-pin-mark" aria-label="Закреплён" title="Закреплён" />
                  )}
                  <span className="chs-asst__thread-title">{t.title}</span>
                  <span className="chs-asst__thread-meta">
                    {t.message_count > 0
                      ? `${t.message_count} сообщ.`
                      : 'пусто'}
                  </span>
                </button>
              )}
              {/* Thread action buttons: pin / rename / delete */}
              {renamingId !== t.id && (
                <div className="chs-asst__thread-actions" role="group" aria-label="Действия с разговором">
                  <button
                    type="button"
                    className={`chs-asst__thread-action${t.pinned ? ' chs-asst__thread-action--active' : ''}`}
                    aria-label={t.pinned ? 'Открепить разговор' : 'Закрепить разговор'}
                    title={t.pinned ? 'Открепить' : 'Закрепить'}
                    onClick={(e) => { e.stopPropagation(); onPin(t.id, !t.pinned); }}
                  >
                    <KitIcon name={t.pinned ? 'star' : 'star-outline'} />
                  </button>
                  <button
                    type="button"
                    className="chs-asst__thread-action"
                    aria-label="Переименовать разговор"
                    title="Переименовать"
                    onClick={(e) => { e.stopPropagation(); setRenamingId(t.id); }}
                  >
                    <KitIcon name="pencil" />
                  </button>
                  <button
                    type="button"
                    className="chs-asst__thread-action chs-asst__thread-action--danger"
                    aria-label="Удалить разговор"
                    title="Удалить"
                    onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
                  >
                    <KitIcon name="close" />
                  </button>
                </div>
              )}
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
  const navigate = useNavigate();
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [saveError, setSaveError] = React.useState(null);
  // T-0465 (D8-G4): bundle-promote UI state (publish whole solution as one unit).
  const [promoting, setPromoting] = React.useState(false);
  const [promoted, setPromoted] = React.useState(false);
  const [promoteError, setPromoteError] = React.useState(null);
  // T-0526: confirm dialog для bundle-promote (CONFIRM-DANGER, сайт 12)
  const [bundlePromoteConfirmOpen, setBundlePromoteConfirmOpen] = React.useState(false);

  // T-0465: deep-links + bundle-promote are present only on a bot reply that
  // generated a solution bundle this turn.
  const deepLinks = Array.isArray(msg.deepLinks) ? msg.deepLinks : [];
  const bundlePromote = msg.bundlePromote || null;

  const handleBundlePromote = async () => {
    if (!bundlePromote || promoting || promoted) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      const r = await fetch(bundlePromote.path, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      });
      if (!r.ok && r.status !== 207) {
        const txt = await r.text().catch(() => `HTTP ${r.status}`);
        throw new Error(txt);
      }
      const data = await r.json().catch(() => ({}));
      if (data.promoted) {
        setPromoted(true);
      } else {
        // 207 partial — surface honestly, don't claim success.
        const failed = (data.items || []).filter((i) => !i.ok).length;
        setPromoteError(`Опубликовано ${data.promotedCount}/${data.itemCount}; ${failed} с ошибкой. Откройте раздел и доведите вручную.`);
      }
    } catch (err) {
      setPromoteError(err.message ?? 'Не удалось опубликовать решение.');
    } finally {
      setPromoting(false);
    }
  };

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

      {/* T-0545: server emitted a surface document → show "Открыть в конструкторе" deep-link.
          This is the slot for T-0455 (server LLM routing): once the server calls emit_surface,
          the response message carries msg.surface. Until T-0455 ships, this block is inert.
          FF-T0545-FLOOR2-FLAG: floor2Flag renders a warning badge.
          The document is NEVER rendered inline — only a button to the canvas (G4 principle). */}
      {msg.surface && (
        <div className="chs-asst__msg-surface">
          {msg.surface.floor2Flag && (
            <div
              className="chs-asst__surface-floor2"
              role="alert"
              style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-warning)', marginBottom: 'var(--chs-space-2)' }}
            >
              Содержит кастомный код-виджет (Floor-2)
            </div>
          )}
          {!msg.surface.ok && msg.surface.brokenKeys && msg.surface.brokenKeys.length > 0 && (
            <div
              className="chs-asst__surface-warn"
              role="alert"
              style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-warning)', marginBottom: 'var(--chs-space-2)' }}
            >
              {msg.surface.brokenKeys.length} {msg.surface.brokenKeys.length === 1 ? 'поле' : 'поля/полей'} не найдено в схеме — откройте и исправьте.
            </div>
          )}
          {msg.surface.errorMessage && !msg.surface.doc && (
            <div
              className="chs-asst__surface-error"
              role="alert"
              style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-danger)', marginBottom: 'var(--chs-space-2)' }}
            >
              {msg.surface.errorMessage}
            </div>
          )}
          {msg.surface.canvasPath && (msg.surface.doc || msg.surface.brokenKeys?.length > 0) && (
            <Button
              variant={msg.surface.ok ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => navigate(msg.surface.canvasPath, {
                state: { aiDraft: msg.surface.doc, floor2Flag: msg.surface.floor2Flag ?? false },
              })}
              aria-label={msg.surface.ok ? 'Открыть черновик формы в конструкторе' : 'Открыть черновик с ошибками в конструкторе'}
            >
              {msg.surface.ok ? 'Открыть в конструкторе' : 'Открыть и исправить'}
            </Button>
          )}
        </div>
      )}

      {/* T-0465 (D8-G4): REVIEW-IN-SECTIONS. Deep-links into the actual sections
          (Приложения / Модельер) — the user reviews the generated DRAFT visually
          THERE, not via a constructor rendered in chat. */}
      {deepLinks.length > 0 && (
        <div className="chs-asst__msg-deeplinks">
          <div className="chs-asst__msg-deeplinks-title">Проверьте черновик в разделах:</div>
          {deepLinks.map((dl, i) => (
            <Button
              key={`${dl.path}-${i}`}
              variant="ghost"
              size="sm"
              onClick={() => navigate(dl.path)}
              aria-label={dl.label}
            >
              {dl.kind === 'process' ? <Icon name="process" /> : <Icon name="apps" />}
              {' '}{dl.label}
            </Button>
          ))}
        </div>
      )}

      {/* T-0465 (D8-G4): BUNDLE-PROMOTE. Publish the WHOLE solution (all DRAFT apps
          + the process) together as ONE unit. Human-gated; the bot never publishes. */}
      {bundlePromote && !promoted && (
        <div className="chs-asst__msg-actions">
          <Button
            variant="danger"
            size="sm"
            disabled={promoting}
            loading={promoting}
            onClick={() => setBundlePromoteConfirmOpen(true)}
            aria-label={`Опубликовать всё решение (${bundlePromote.itemCount} элементов) одним действием`}
          >
            Опубликовать решение ({bundlePromote.itemCount})
          </Button>
          {promoteError && (
            <span className="chs-asst__save-error" role="alert">{promoteError}</span>
          )}

          {/* T-0526: ConfirmDialog для bulk-publish (CONFIRM-DANGER, сайт 12) */}
          <ConfirmDialog
            open={bundlePromoteConfirmOpen}
            tone="danger"
            title="Опубликовать всё решение?"
            message={
              <ConsequenceSummary
                who={`${bundlePromote.itemCount} элементов решения (приложения + процесс)`}
                what="Все черновики публикуются одним действием. Пользователи сразу увидят изменения."
                reversibility="Необратимо. Откат — публикация предыдущих версий вручную."
              />
            }
            confirmLabel={`Опубликовать всё (${bundlePromote.itemCount})`}
            loading={promoting}
            onConfirm={() => { setBundlePromoteConfirmOpen(false); handleBundlePromote(); }}
            onClose={() => setBundlePromoteConfirmOpen(false)}
          />
        </div>
      )}
      {bundlePromote && promoted && (
        <div className="chs-asst__msg-actions">
          <span className="chs-asst__save-ok">Решение опубликовано</span>
        </div>
      )}

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

/* ---------------------------------------------------------------------------
   T-0545: AI-emit panel — «Собрать форму» (FF-T0545-SAME-GATE / FLOOR2-FLAG)

   Deterministic client-side emit seam. The user picks an app + registry def,
   the panel calls emitSurfaceLocal (which runs emitFormDocument → THE SAME
   validateDocument the human editor uses), then navigates to /forms with the
   result in location.state so FormDesigner opens the draft.

   LLM CONNECT POINT (T-0455 / D8): this panel uses a deterministic "all fields
   → flat layout" intent today. Once server LLM routing (T-0455) is live, the
   LLM will call emit_surface server-side with a natural-language-derived intent;
   the server response will carry msg.surface and the MessageBubble slot
   (above) will render the deep-link. This panel is the graceful fallback that
   stays useful without LLM (the "build by hand" escape per design §7).

   Degrade: on any error → toast (T-0528) + offer to open FormDesigner empty.
   --------------------------------------------------------------------------- */

/**
 * AiEmitPanel — ассистент «Собрать форму» (T-0545 шов).
 * Встраивается под Composer в ThreadView.
 * Показывается только когда contextRef указывает на app (kind='app') — нам
 * нужен applicationId для загрузки схемы. Для record/process-контекстов кнопка
 * недоступна (схема неизвестна без лишнего API-вызова).
 *
 * @param {{ contextRef: {kind:string, id:string, label:string} | null }} props
 */
function AiEmitPanel({ contextRef }) {
  const navigate = useNavigate();
  const { push: pushToast } = useToastContext();

  const [building, setBuilding] = useState(false);

  // Only available when contextRef is an 'app' (gives us the applicationId).
  const appId = contextRef?.kind === 'app' ? contextRef.id : null;

  if (!appId) return null;

  const handleBuildForm = useCallback(async () => {
    if (building) return;
    setBuilding(true);
    try {
      // Fetch registry defs for the app to get the live schema.
      const r = await fetch(`/api/registry-defs?application_id=${encodeURIComponent(appId)}`, {
        headers: authHeaders(),
      });
      if (!r.ok) {
        throw new Error(`HTTP ${r.status} — не удалось загрузить схему приложения`);
      }
      const data = await r.json();
      const defs = data.registry_defs || [];
      if (defs.length === 0) {
        pushToast({ tone: 'error', title: 'Нет наборов полей', message: 'Приложение не имеет наборов полей. Добавьте поля в конструкторе.', duration: 7000 });
        return;
      }
      // Use the first registry def (the default schema for the app).
      const def = defs[0];
      const fields = parseRecordSchema(def.record_schema);

      // T-0545: build a default flat-layout intent from all fields.
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // LLM CONNECT POINT (T-0455): replace this defaultEmitIntent with
      // the LLM-derived intent when T-0455 server routing is live.
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const intent = defaultEmitIntent(
        { applicationId: appId, registryDefId: def.id },
        fields,
      );

      // FF-T0545-SAME-GATE: runs emitFormDocument → validateDocument (same gate as human).
      const result = emitSurfaceLocal(intent, fields);

      if (!result.doc) {
        // Full failure — no document at all.
        pushToast({
          tone: 'error',
          title: 'Ассистент не смог собрать форму',
          message: result.errorMessage ?? 'Попробуйте снова или соберите вручную.',
          duration: 0,
        });
        // Offer empty canvas.
        navigate('/forms');
        return;
      }

      if (!result.ok && result.validationErrors.some((e) => e.code === 'V-NODE')) {
        // FF-T0545-NO-BYPASS: unknown node type → full reject, open empty canvas.
        pushToast({
          tone: 'error',
          title: 'Тип блока вне реестра',
          message: result.errorMessage ?? 'Неизвестный тип узла. Соберите форму вручную.',
          duration: 0,
        });
        navigate('/forms');
        return;
      }

      if (!result.ok || result.floor2Flag) {
        // Partial result or Floor-2 — open with warning.
        pushToast({
          tone: 'warn',
          title: result.floor2Flag ? 'Черновик содержит код-виджет (Floor-2)' : 'Форма с ошибками привязки',
          message: result.errorMessage ?? 'Откройте черновик в конструкторе и исправьте.',
          duration: 7000,
        });
      }

      // Navigate to /forms with the emitted document in location state.
      // FormDesigner will open it as initialDocument.
      navigate('/forms', {
        state: { aiDraft: result.doc, floor2Flag: result.floor2Flag },
      });
    } catch (err) {
      // FF-T0545-HONEST-DEGRADE: честная ошибка + путь к ручной сборке.
      pushToast({
        tone: 'error',
        title: 'Не удалось собрать форму',
        message: err?.message ?? 'Попробуйте снова или соберите форму вручную в конструкторе.',
        duration: 0,
      });
    } finally {
      setBuilding(false);
    }
  }, [appId, building, navigate, pushToast]);

  return (
    <div
      className="chs-asst__emit-panel"
      style={{
        borderTop: '1px solid var(--chs-color-border)',
        padding: 'var(--chs-space-3) var(--chs-space-4)',
        background: 'var(--chs-color-surface-muted, transparent)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--chs-space-3)',
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', flex: '1 1 auto' }}
      >
        Приложение «{contextRef.label}» — собрать форму из схемы
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={building}
        loading={building}
        onClick={handleBuildForm}
        aria-label="Собрать черновик формы из схемы приложения и открыть в конструкторе"
        title="Ассистент соберёт черновик формы из всех полей схемы. Черновик откроется в конструкторе для вашей правки."
      >
        {building ? 'Сборка…' : 'Собрать форму'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate('/forms')}
        aria-label="Открыть конструктор форм"
        title="Открыть конструктор и собрать форму вручную"
      >
        Открыть конструктор
      </Button>
    </div>
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

      {/* T-0545: AI-emit panel — «Собрать форму» (только при app-контексте).
          FF-T0545-SAME-GATE: вызывает emitSurfaceLocal → тот же validateDocument.
          FF-T0545-HONEST-DEGRADE: любая ошибка → тост + открыть конструктор пустым. */}
      <AiEmitPanel contextRef={contextRef} />
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

  const { push: pushToast } = useToastContext();
  const { threads, error: threadsError, load: loadThreads, createThread, patchThread, deleteThread } = useThreadsStub();
  const loading = threads === null;

  // Активный тред — из URL-параметра или стейта
  const [activeThread, setActiveThread] = useState(null);

  // Синхронизация активного треда с URL.
  // ВАЖНО: если paramThreadId совпадает с уже активным тредом (который мог быть
  // lazy-create-hidden — 0 сообщений, поэтому не попал в список), НЕ обнуляем
  // activeThread. Это предотвращает race, при котором handleCreate ставит
  // activeThread сразу после navigate(`/assistant/<id>`), а useEffect сбрасывает
  // его в null, потому что новый тред ещё скрыт (нет сообщений → не в списке).
  useEffect(() => {
    if (!threads) return;
    if (paramThreadId) {
      const found = threads.find((t) => t.id === paramThreadId);
      // If the thread isn't in the visible list but matches the current activeThread,
      // keep the current activeThread (e.g. lazy-create: 0 messages, not yet visible).
      setActiveThread((prev) => found ?? (prev?.id === paramThreadId ? prev : null));
    } else {
      setActiveThread(null);
    }
  }, [paramThreadId, threads]);

  // T-0384: after first message is sent, reload thread list to surface auto-title.
  const handleFirstMessage = useCallback(() => { loadThreads(); }, [loadThreads]);

  const { messages, streaming, error: msgError, send } = useMessagesStub(activeThread?.id || null, handleFirstMessage);
  const budget = useBudgetStub(activeThread?.id || null);

  const handleSelectThread = (thread) => {
    setActiveThread(thread);
    navigate(`/assistant/${thread.id}`);
  };

  // T-0384 lazy-create: create thread without title; thread stays hidden in list
  // until first message is sent (auto-title fires, thread becomes visible).
  const handleCreate = useCallback(async () => {
    try {
      const thread = await createThread({ contextRef });
      setActiveThread(thread);
      navigate(`/assistant/${thread.id}`);
      // Контекст-ref используется в composer; очищать будем после первого send.
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to create thread:', err);
      // T-0528: поверх console.error — тост для пользователя
      pushToast({ tone: 'error', title: 'Не удалось создать тред', message: err?.message, duration: 0 });
    }
  }, [createThread, contextRef, navigate, pushToast]);

  // T-0384: rename thread
  // T-0533: optimistic update with rollback on error.
  const handleRename = useCallback((id, newTitle) => {
    // Snapshot previous title for rollback.
    const prevTitle = threads?.find((t) => t.id === id)?.title;
    // Optimistically update active thread title in local state if it's active.
    setActiveThread((prev) => (prev && prev.id === id ? { ...prev, title: newTitle } : prev));
    patchThread(id, { title: newTitle }).catch(() => {
      // T-0533: rollback optimistic update on network/server error.
      setActiveThread((prev) => (prev && prev.id === id ? { ...prev, title: prevTitle } : prev));
      pushToast({ tone: 'error', title: 'Не удалось переименовать тред', duration: 5000 });
    });
  }, [patchThread, threads, pushToast]);

  // T-0384: pin/unpin thread
  const handlePin = useCallback((id, pinned) => {
    patchThread(id, { pinned });
  }, [patchThread]);

  // T-0384: delete confirmation state.
  // Stores the thread id pending deletion (null = dialog closed).
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const pendingDeleteThread = threads?.find((t) => t.id === pendingDeleteId) || null;

  // Called when the user clicks ✕ — opens the confirmation dialog.
  const handleDeleteRequest = useCallback((id) => {
    setPendingDeleteId(id);
  }, []);

  // Called when the user confirms deletion in the dialog.
  const handleDeleteConfirm = useCallback(() => {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    deleteThread(id);
    if (activeThread?.id === id) {
      setActiveThread(null);
      navigate('/assistant');
    }
  }, [pendingDeleteId, deleteThread, activeThread, navigate]);

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
          onRename={handleRename}
          onPin={handlePin}
          onDelete={handleDeleteRequest}
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

      {/* T-0384: подтверждение удаления разговора */}
      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Удалить разговор?"
        message={
          pendingDeleteThread
            ? `Разговор «${pendingDeleteThread.title}» будет удалён. Это действие нельзя отменить.`
            : 'Разговор будет удалён. Это действие нельзя отменить.'
        }
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        tone="danger"
        onConfirm={handleDeleteConfirm}
        onClose={() => setPendingDeleteId(null)}
      />
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
