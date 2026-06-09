/**
 * web/src/app-shell/dev-auth.js
 *
 * Dev-session management: localStorage-backed user identity storage.
 * Plain JS, no JSX.
 */

const KEY = "chs-dev-user";

/**
 * Retrieve the currently logged-in dev user from localStorage.
 * Returns null if not logged in or on parse error.
 */
export function getDevUser() {
  try {
    const stored = localStorage.getItem(KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

/**
 * Store a dev user to localStorage.
 */
export function setDevUser(user) {
  localStorage.setItem(KEY, JSON.stringify(user));
}

/**
 * Clear the stored dev user.
 */
export function clearDevUser() {
  localStorage.removeItem(KEY);
}

/**
 * Return request headers for authenticated API calls.
 * If logged in, includes the X-Dev-User header with the user's ID.
 */
export function devHeaders() {
  const user = getDevUser();
  if (user && user.id) {
    return { "X-Dev-User": user.id };
  }
  return {};
}
