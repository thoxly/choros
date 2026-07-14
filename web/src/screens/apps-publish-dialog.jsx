/* ============================================================================
   CHOROS — apps-publish-dialog.jsx  (T-0563 · «Опубликовать решение»)

   Диалог публикации связанного решения. Поток (ADR T-0561, PD-26):
     open → GET publish-preview (loading/empty/error)
          → confirm-список «Будет опубликовано: приложение X · процесс Z · форма
            шага Y» (уже боевые пункты — де-эмфазированы «уже опубликовано»)
          → confirm → POST publish-solution
          → per-item результат ✓/✗ причина + тост (all-ok / partial-fail).

   Паттерн CONFIRM-DANGER взят из screen-assistant.jsx bundlePromote (ConfirmDialog +
   ConsequenceSummary). Здесь развёрнут в собственный <Modal>, т.к. нужен
   трёхфазный экран (preview → confirm → results) со списком.

   KIT-компоненты, токены (0 хардкода hex), состояния loading/empty/error,
   ни одной мёртвой кнопки.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Modal, Button, Badge, LoadingState, ErrorState, KitIcon } from '../components/components.jsx';
import { ConsequenceSummary } from '../util/confirm-helpers.jsx';
import {
  fetchPublishPreview, publishSolution,
  previewItemLabel, summarizeResults, KIND_LABEL,
} from './apps-publish-api.js';

/* Список пунктов превью. Публикуемые — обычным весом; уже боевые — де-эмфаза.
   Экспортируется для юнит-тестов (tree-walk без DOM, конвенция проекта). */
export function PreviewList({ items }) {
  return (
    <ul style={{ listStyle: 'none', margin: '0 0 var(--chs-space-5) 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
      {items.map((item) => (
        <li
          key={`${item.kind}:${item.id}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)',
            fontSize: 'var(--chs-text-sm)',
            color: item.will_publish ? 'var(--chs-color-text)' : 'var(--chs-color-text-muted)',
          }}
        >
          <span style={{ flex: 1 }}>{previewItemLabel(item)}</span>
          {item.will_publish ? (
            <Badge tone="warning">будет опубликовано</Badge>
          ) : (
            <Badge tone="neutral">уже опубликовано</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

/* Список результатов ✓/✗ с причиной. Честно: видно что доехало и что нет.
   Экспортируется для юнит-тестов (tree-walk без DOM). */
export function ResultList({ results }) {
  return (
    <ul style={{ listStyle: 'none', margin: '0 0 var(--chs-space-5) 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-3)' }}>
      {results.map((r) => (
        <li key={`${r.kind}:${r.id}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--chs-space-3)', fontSize: 'var(--chs-text-sm)' }}>
          <span
            aria-hidden="true"
            style={{ color: r.ok ? 'var(--chs-color-success)' : 'var(--chs-color-danger)', flexShrink: 0, marginTop: '2px', display: 'inline-flex' }}
          >
            <KitIcon name={r.ok ? 'check' : 'close'} />
          </span>
          <span style={{ flex: 1 }}>
            <span style={{ color: 'var(--chs-color-text)' }}>
              {KIND_LABEL[r.kind] || r.kind} «{r.name}»
            </span>
            {!r.ok && r.error && (
              <span style={{ display: 'block', marginTop: 'var(--chs-space-1)', color: 'var(--chs-color-danger)', fontSize: 'var(--chs-text-xs)' }}>
                {r.error}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * PublishSolutionDialog — трёхфазный диалог публикации.
 *
 * Props:
 *   open       — открыт ли
 *   app        — { id, display_name, tier }
 *   onClose    — закрыть
 *   onDone     — (summary) => void, вызывается после публикации (обновить строку/бейдж)
 *   pushToast  — из useToastContext(): ({ tone, title, message, duration }) => void
 */
export function PublishSolutionDialog({ open, app, onClose, onDone, pushToast }) {
  const [preview, setPreview] = useState(null); // null=loading, обьект=loaded
  const [previewErr, setPreviewErr] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [results, setResults] = useState(null); // null=не публиковали, обьект=готово

  const loadPreview = useCallback(async () => {
    if (!app?.id) return;
    setPreview(null); setPreviewErr(null); setResults(null);
    try {
      const data = await fetchPublishPreview(app.id);
      setPreview(data);
    } catch (err) {
      setPreviewErr(err?.message || String(err));
    }
  }, [app?.id]);

  // При каждом открытии — свежее превью.
  useEffect(() => {
    if (open) loadPreview();
  }, [open, loadPreview]);

  const handleConfirm = useCallback(async () => {
    if (!app?.id || publishing) return;
    setPublishing(true);
    try {
      const data = await publishSolution(app.id);
      setResults(data);
      const s = summarizeResults(data.results);
      if (pushToast) {
        pushToast(
          s.allOk
            ? { tone: 'success', title: 'Решение опубликовано', message: `Опубликовано ${s.ok} из ${s.total}.` }
            : { tone: 'error', title: 'Опубликовано частично', message: `${s.ok} из ${s.total} · ${s.failed} с ошибкой — см. список.`, duration: 0 },
        );
      }
      if (onDone) onDone(s);
    } catch (err) {
      // Транспортная/серверная ошибка — ничего не опубликовано.
      if (pushToast) pushToast({ tone: 'error', title: 'Публикация не выполнена', message: err?.message || String(err), duration: 0 });
      setPreviewErr(err?.message || String(err));
    } finally {
      setPublishing(false);
    }
  }, [app?.id, publishing, pushToast, onDone]);

  const handleClose = useCallback(() => {
    if (publishing) return;
    onClose();
  }, [publishing, onClose]);

  // ---- footer по фазе ----
  const toPublishCount = preview?.counts?.to_publish ?? 0;
  const isResultPhase = results !== null;
  const footer = isResultPhase ? (
    <Button variant="primary" size="sm" onClick={handleClose}>Готово</Button>
  ) : (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={publishing}>Отмена</Button>
      <Button
        type="button" variant="danger" size="sm"
        loading={publishing}
        disabled={publishing || previewErr != null || preview == null || toPublishCount === 0}
        onClick={handleConfirm}
      >
        {publishing ? 'Публикация…' : `Опубликовать${toPublishCount > 0 ? ` (${toPublishCount})` : ''}`}
      </Button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={isResultPhase ? 'Результат публикации' : `Опубликовать решение · ${app?.display_name ?? ''}`}
      footer={footer}
    >
      {previewErr && !isResultPhase ? (
        <ErrorState message={previewErr} onRetry={loadPreview} />
      ) : preview === null && !isResultPhase ? (
        <LoadingState label="Собираем связанное решение…" />
      ) : isResultPhase ? (
        <>
          <p style={{ margin: '0 0 var(--chs-space-5) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
            {results.all_ok
              ? 'Все части решения опубликованы.'
              : 'Часть решения не опубликована — исправьте отмеченное и опубликуйте заново.'}
          </p>
          <ResultList results={results.results} />
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 var(--chs-space-5) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
            Будет опубликовано связанное решение — само приложение и напрямую связанные с ним части.
            Граница видна ниже перед действием.
          </p>
          {preview.items.length === 0 ? (
            <p style={{ margin: '0 0 var(--chs-space-5) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
              Публиковать нечего — связанных черновиков не найдено.
            </p>
          ) : (
            <PreviewList items={preview.items} />
          )}
          {toPublishCount > 0 && (
            <ConsequenceSummary
              who={`${toPublishCount} ${toPublishCount === 1 ? 'элемент' : 'элемент(ов)'} решения`}
              what="Черновики публикуются вместе. Команда сразу увидит изменения, процессы начнут работать."
              reversibility="Откат — повторная публикация предыдущих версий вручную."
            />
          )}
        </>
      )}
    </Modal>
  );
}

export default PublishSolutionDialog;
