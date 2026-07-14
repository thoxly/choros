/**
 * web/src/screens/screen-login.jsx
 *
 * Login screen, mode-aware (T-0258):
 *   - keycloak mode → a single "Sign in" button that starts the real OIDC
 *     redirect login (onLogin() with no argument kicks off the redirect).
 *   - dev mode (default) → the legacy dev-user picker: fetch /api/users and
 *     let the user pick an identity (no password). Unchanged behaviour.
 *
 * Props:
 *   onLogin(user?) — dev mode passes the picked user; keycloak mode calls with
 *                    no argument to start the redirect.
 *   keycloak       — true when the server is in keycloak auth mode.
 *   error          — optional login-error message to surface (keycloak).
 */

import React, { useState, useEffect } from 'react';
import { Button, ErrorState, LoadingState, EmptyState } from '../components/components.jsx';
// T-0668: even the pre-login dev user-list must go through the shared mode-aware
// header helper. authHeaders() returns {} before an identity is picked (dev) — so
// behaviour is unchanged here — but routing through it (a) removes a bare-fetch
// pattern a future dev could copy onto a protected route, and (b) keeps every
// /api call uniform so the web-fetch-auth gate has one convention to enforce.
import { authHeaders } from '../app-shell/dev-auth.js';

function LoginScreen({ onLogin, keycloak = false, error: externalError = null }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(!keycloak);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (keycloak) return; // keycloak mode: no user list to fetch
    const fetchUsers = async () => {
      try {
        const response = await fetch('/api/users', { headers: { ...authHeaders() } });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        setUsers(data.users || []);
        setError(null);
      } catch (err) {
        setError(err.message || 'Ошибка загрузки пользователей');
        setUsers([]);
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, []);

  const handleRetry = () => {
    setLoading(true);
    setError(null);
    const fetchUsers = async () => {
      try {
        const response = await fetch('/api/users', { headers: { ...authHeaders() } });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        setUsers(data.users || []);
        setError(null);
      } catch (err) {
        setError(err.message || 'Ошибка загрузки пользователей');
        setUsers([]);
      } finally {
        setLoading(false);
      }
    };
    fetchUsers();
  };

  const handleSelectUser = (user) => {
    onLogin(user);
  };

  // ----- Keycloak mode: a single sign-in button that starts the OIDC redirect.
  if (keycloak) {
    return (
      <div className="chs-login-screen">
        <div className="chs-login-container">
          <div className="chs-login-header">
            <h1 className="chs-login-title">Demiurge · Choros</h1>
            <p className="chs-login-subtitle">вход</p>
            <p className="chs-login-hint">Вход через корпоративную учётную запись (Keycloak).</p>
          </div>

          {externalError && (
            <div className="chs-login-error">
              <ErrorState title="Ошибка входа" message={externalError} />
            </div>
          )}

          <div className="chs-login-users">
            <Button variant="primary" onClick={() => onLogin()}>
              Войти
            </Button>
          </div>

          <div className="chs-login-register">
            <p className="chs-login-register-prompt">
              Нет учётной записи?{' '}
              <a
                className="chs-login-register-link"
                href="/register"
                onClick={(e) => { e.preventDefault(); window.history.pushState({}, '', '/register'); window.dispatchEvent(new PopStateEvent('popstate')); }}
              >
                Создать организацию
              </a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chs-login-screen">
      <div className="chs-login-container">
        <div className="chs-login-header">
          <h1 className="chs-login-title">Demiurge · Choros</h1>
          <p className="chs-login-subtitle">вход (dev)</p>
          <p className="chs-login-hint">Выберите пользователя для входа. Пароль не требуется.</p>
        </div>

        {loading && (
          <div className="chs-login-loading">
            <LoadingState label="Загрузка…" />
          </div>
        )}

        {error && !loading && (
          <div className="chs-login-error">
            <ErrorState
              title="Не удалось загрузить пользователей"
              message={error}
              onRetry={handleRetry}
            />
          </div>
        )}

        {!loading && !error && users.length > 0 && (
          <div className="chs-login-users">
            <ul className="chs-login-list">
              {users.map((user) => (
                <li key={user.id} className="chs-login-item">
                  <button
                    className="chs-login-user-btn"
                    onClick={() => handleSelectUser(user)}
                  >
                    <div className="chs-login-user-name">{user.name}</div>
                    <div className="chs-login-user-position">{user.position}</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!loading && !error && users.length === 0 && (
          <div className="chs-login-empty">
            <EmptyState title="Нет доступных пользователей" />
          </div>
        )}
      </div>

      <style>{`
        .chs-login-screen {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          background: var(--chs-color-bg);
          font-family: var(--chs-font-sans);
          color: var(--chs-color-text);
        }

        .chs-login-container {
          width: 100%;
          max-width: 400px;
          padding: var(--chs-space-10) var(--chs-space-7);
        }

        .chs-login-header {
          text-align: center;
          margin-bottom: var(--chs-space-10);
        }

        .chs-login-title {
          margin: 0 0 var(--chs-space-4) 0;
          font-size: var(--chs-text-2xl);
          font-weight: var(--chs-weight-semibold);
          letter-spacing: var(--chs-tracking-tight);
          color: var(--chs-color-text);
        }

        .chs-login-subtitle {
          margin: 0 0 var(--chs-space-6) 0;
          font-size: var(--chs-text-md);
          color: var(--chs-color-text-muted);
        }

        .chs-login-hint {
          margin: 0;
          font-size: var(--chs-text-base);
          color: var(--chs-color-text-faint);
          line-height: var(--chs-leading-normal);
        }

        .chs-login-loading {
          padding: var(--chs-space-9) var(--chs-space-7);
        }

        .chs-login-error {
          margin-bottom: var(--chs-space-7);
        }

        .chs-login-empty {
          padding: var(--chs-space-9) var(--chs-space-7);
        }

        .chs-login-users {
          margin-bottom: var(--chs-space-7);
        }

        .chs-login-register {
          margin-top: var(--chs-space-6);
          text-align: center;
        }

        .chs-login-register-prompt {
          margin: 0;
          font-size: var(--chs-text-sm);
          color: var(--chs-color-text-muted);
        }

        .chs-login-register-link {
          color: var(--chs-color-accent);
          text-decoration: none;
          font-weight: var(--chs-weight-medium);
        }

        .chs-login-register-link:hover {
          text-decoration: underline;
        }

        .chs-login-register-link:focus-visible {
          outline: 2px solid var(--chs-color-focus-ring);
          outline-offset: 2px;
          border-radius: var(--chs-radius-1);
        }

        .chs-login-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: var(--chs-space-4);
        }

        .chs-login-item {
          margin: 0;
          padding: 0;
        }

        .chs-login-user-btn {
          width: 100%;
          padding: var(--chs-space-5) var(--chs-space-6);
          background: var(--chs-color-surface);
          border: 1px solid var(--chs-color-border);
          border-radius: var(--chs-radius-2);
          cursor: pointer;
          text-align: left;
          transition: all 0.15s ease;
          font-family: inherit;
          color: var(--chs-color-text);
        }

        .chs-login-user-btn:hover {
          background: var(--chs-color-surface-2);
          border-color: var(--chs-color-accent);
        }

        .chs-login-user-btn:active {
          background: var(--chs-color-accent);
          color: var(--chs-color-accent-fg);
        }

        .chs-login-user-name {
          font-weight: var(--chs-weight-medium);
          font-size: var(--chs-text-md);
          margin-bottom: var(--chs-space-2);
        }

        .chs-login-user-position {
          font-size: var(--chs-text-sm);
          color: var(--chs-color-text-muted);
        }
      `}</style>
    </div>
  );
}

export default LoginScreen;
