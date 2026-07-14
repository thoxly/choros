/* ============================================================================
   CHOROS — toast-context.jsx  (T-0528)
   Глобальный провайдер тостов: один <ToastViewport> на всё authenticated-дерево.
   Любой экран получает { push, dismiss } через useToastContext() без локальной обвязки.

   Политика severity:
     error / warning → duration:0 (нет авто-гашения), role=alert, aria-live=assertive
     success / info  → duration:4000ms, role=status, aria-live=polite
   Pause-on-hover: таймеры авто-гашения ставятся здесь; pointerenter на viewport их
   отменяет; pointerleave возобновляет.
   ============================================================================ */

import React, { useContext, useRef, useCallback } from 'react';
import { useToasts, ToastViewport } from '../components/components.jsx';

const ToastContext = React.createContext(null);

/** Дефолтный duration по severity. 0 = нет авто-гашения. */
function defaultDuration(tone) {
  if (tone === 'error' || tone === 'warning') return 0;
  if (tone === 'info') return 5000;
  return 4000; // success
}

/**
 * ToastProvider — монтируется один раз в AppShell.
 * Вызывает kit useToasts один раз, управляет pause-on-hover таймерами,
 * предоставляет { push, dismiss } через ToastContext.
 */
export function ToastProvider({ children }) {
  // Kit hook — единственный вызов в дереве (кроме showcase.jsx стенда).
  // duration=0 здесь означает «не авто-гасить из kit» — провайдер сам управляет таймерами.
  const { toasts, push: kitPush, dismiss } = useToasts({ duration: 0 });

  // timersRef: id → timerId для pause-on-hover управления таймерами
  const timersRef = useRef({});
  // remainingRef: id → оставшиеся ms на момент pause
  const remainingRef = useRef({});
  // pausedRef: флаг «viewport захвачен ховером»
  const pausedRef = useRef(false);

  const scheduleAutoDismiss = useCallback((id, ms) => {
    if (ms <= 0) return;
    remainingRef.current[id] = ms;
    timersRef.current[id] = setTimeout(() => {
      delete timersRef.current[id];
      delete remainingRef.current[id];
      dismiss(id);
    }, ms);
  }, [dismiss]);

  /**
   * push(input: ToastInput): number
   * Ставит тост в очередь, возвращает id.
   * input: { tone, title, message?, duration?, action? }
   */
  const push = useCallback((input) => {
    const id = kitPush(input);
    const dur = input.duration != null ? input.duration : defaultDuration(input.tone);
    if (dur > 0 && !pausedRef.current) {
      scheduleAutoDismiss(id, dur);
    } else if (dur > 0 && pausedRef.current) {
      // Тост добавлен пока viewport захвачен ховером — запомним duration для resumeAll
      remainingRef.current[id] = dur;
    }
    return id;
  }, [kitPush, scheduleAutoDismiss]);

  /**
   * dismiss(id): немедленно убрать тост + очистить таймер.
   */
  const wrappedDismiss = useCallback((id) => {
    clearTimeout(timersRef.current[id]);
    delete timersRef.current[id];
    delete remainingRef.current[id];
    dismiss(id);
  }, [dismiss]);

  /** Пауза всех таймеров (pointerenter на viewport). */
  const pauseAll = useCallback(() => {
    pausedRef.current = true;
    Object.entries(timersRef.current).forEach(([id, timerId]) => {
      clearTimeout(timerId);
      delete timersRef.current[id];
      // remainingRef уже содержит изначальный duration;
      // точное оставшееся время здесь не отслеживается (упрощение),
      // при resumeAll даём полный оставшийся интервал.
    });
  }, []);

  /** Возобновление таймеров (pointerleave с viewport). */
  const resumeAll = useCallback(() => {
    pausedRef.current = false;
    Object.entries(remainingRef.current).forEach(([idStr, ms]) => {
      const id = Number(idStr);
      if (ms > 0 && !timersRef.current[id]) {
        scheduleAutoDismiss(id, ms);
      }
    });
  }, [scheduleAutoDismiss]);

  return (
    <ToastContext.Provider value={{ push, dismiss: wrappedDismiss }}>
      {children}
      <ToastViewport
        toasts={toasts}
        dismiss={wrappedDismiss}
        position="bottom-right"
        onPointerEnter={pauseAll}
        onPointerLeave={resumeAll}
      />
    </ToastContext.Provider>
  );
}

/**
 * useToastContext(): { push, dismiss }
 * Хук для любого потребителя внутри AppShell.
 * Бросает Error если вызван вне ToastProvider.
 */
export function useToastContext() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToastContext: нет ToastProvider в дереве');
  return ctx;
}
