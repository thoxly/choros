/* ============================================================================
   web/src/app-shell/user-prefs-api.js — T-0651 (E-NAV-IA/sidebar-workspace)

   Thin fetch client for the generic per-actor user_pref store
   (src/http/user-prefs.ts, migration 129). This task's own consumer is
   sidebar collapsed-group state (key SIDEBAR_COLLAPSED_GROUPS_KEY below), but
   the client is generic — any future "remember this for me" feature (personal
   saved views, table density) reads/writes through the SAME two functions
   with a different key, no new file.

   Honest-degrade: every function resolves (never throws) — a failed network
   call or a 401/500 from the server just means "no persisted preference yet"
   (getUserPref returns the caller-supplied default; setUserPref silently
   no-ops). The sidebar therefore always renders something sensible even when
   the API is unreachable (mirrors the existing best-effort GET pattern for
   navApps/navSections in shell.jsx) — a preference is a nice-to-have, never a
   blocking dependency.
   ============================================================================ */

import { devHeaders } from './dev-auth.js';

/** Key this task writes: array of zone ids the actor has collapsed in the sidebar. */
export const SIDEBAR_COLLAPSED_GROUPS_KEY = 'sidebar.collapsed_groups';

/**
 * Fetch ALL prefs for the current actor as a flat { key: value } map.
 * Returns {} on any failure (network, auth, server error) — never throws.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getAllUserPrefs() {
  try {
    const res = await fetch('/api/user-prefs', { headers: devHeaders() });
    if (!res.ok) return {};
    const data = await res.json();
    return (data && typeof data.prefs === 'object' && data.prefs !== null) ? data.prefs : {};
  } catch {
    return {};
  }
}

/**
 * Upsert one pref value. Fire-and-forget from the caller's perspective — resolves
 * to true/false for callers that want to know, but never rejects.
 * @param {string} key
 * @param {unknown} value  any JSON-serializable value
 * @returns {Promise<boolean>} true on a 2xx write, false otherwise (non-fatal)
 */
export async function setUserPref(key, value) {
  try {
    const res = await fetch(`/api/user-prefs/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...devHeaders() },
      body: JSON.stringify({ value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
