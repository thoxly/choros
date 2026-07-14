/**
 * useDirtyGuard — T-0533: Data-loss guard hook.
 *
 * Guard layer:
 *   beforeunload — browser-native dialog on tab-close / F5 / Ctrl-W when there
 *   are unsaved edits. Covers the primary data-loss vectors (closing/reloading).
 *
 * NOTE (T-0548 hotfix): react-router `useBlocker` (the internal SPA-navigation
 *   guard) was REMOVED here. `useBlocker` throws at runtime under `<BrowserRouter>`
 *   (it requires a data router created via `createBrowserRouter`). The app uses
 *   `<BrowserRouter>` (web/src/main.jsx), so calling it crashed EVERY screen that
 *   mounts this hook — modeler (screen-process-editor) and FormDesigner — to a
 *   white screen. Re-introducing the internal-navigation guard requires migrating
 *   routing to `createBrowserRouter`/`RouterProvider` — tracked as a follow-up.
 *
 * Usage (unchanged — API shape preserved):
 *   const guard = useDirtyGuard(isDirty);
 *   <ConfirmDialog open={guard.blockerState === 'blocked'} ...
 *     onConfirm={guard.proceed} onClose={guard.reset} />
 *
 * @param {boolean} isDirty  — if true, the beforeunload guard is active
 * @returns {{ blockerState: string, proceed: () => void, reset: () => void }}
 */

import { useEffect } from 'react';

export function useDirtyGuard(isDirty) {
  // beforeunload — browser-native guard (tab close / reload / Ctrl-W).
  // Modern browsers ignore returnValue text and show their own generic message.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Internal SPA-navigation guard intentionally disabled (see NOTE above) to avoid
  // the useBlocker/BrowserRouter runtime crash. blockerState stays 'unblocked' →
  // the consumer's guard ConfirmDialog never opens; proceed/reset are no-ops.
  return {
    blockerState: 'unblocked',
    proceed: () => {},
    reset: () => {},
  };
}
