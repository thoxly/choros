/**
 * useDirtyGuard — T-0533: Data-loss guard hook.
 *
 * Combines two guard layers:
 *   1. beforeunload — browser native dialog on tab-close / F5 / Ctrl-W
 *   2. useBlocker   — react-router route-guard for internal navigation
 *
 * Usage:
 *   const guard = useDirtyGuard(isDirty);
 *   // In JSX:
 *   <ConfirmDialog
 *     open={guard.blockerState === 'blocked'}
 *     title="Несохранённые правки"
 *     message={...}
 *     confirmLabel="Уйти без сохранения"
 *     cancelLabel="Остаться"
 *     tone="danger"
 *     onConfirm={guard.proceed}
 *     onClose={guard.reset}
 *   />
 *
 * @param {boolean} isDirty  — if true, both guards are active
 * @returns {{ blockerState: string, proceed: () => void, reset: () => void }}
 */

import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';

export function useDirtyGuard(isDirty) {
  // 1) beforeunload — last-resort browser-native guard (tab close / reload / Ctrl-W).
  //    Modern browsers ignore the returnValue text and show their own generic message.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e) => {
      e.preventDefault();
      // returnValue is required for the browser dialog to appear in legacy browsers.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // 2) react-router useBlocker — intercepts internal SPA navigation (Link, navigate()).
  //    Available as a stable API from react-router-dom v6.4+.
  const blocker = useBlocker(isDirty);

  return {
    // 'unblocked' | 'blocked' | 'proceeding'
    blockerState: blocker.state,
    // Call to let the blocked navigation proceed (user chose "Уйти без сохранения").
    proceed: () => blocker.proceed?.(),
    // Call to cancel the blocked navigation (user chose "Остаться").
    reset: () => blocker.reset?.(),
  };
}
