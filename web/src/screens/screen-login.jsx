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
import { Button } from '../components/components.jsx';

function LoginScreen({ onLogin, keycloak = false, error: externalError = null }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(!keycloak);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (keycloak) return; // keycloak mode: no user list to fetch
    const fetchUsers = async () => {
      try {
        const response = await fetch('/api/users');
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
        const response = await fetch('/api/users');
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
              <p>{externalError}</p>
            </div>
          )}

          <div className="chs-login-users">
            <Button variant="primary" onClick={() => onLogin()}>
              Войти
            </Button>
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
            <p>Загрузка…</p>
          </div>
        )}

        {error && !loading && (
          <div className="chs-login-error">
            <p>{error}</p>
            <Button variant="secondary" size="sm" onClick={handleRetry}>
              Повторить
            </Button>
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
            <p>Нет доступных пользователей</p>
          </div>
        )}
      </div>

      <style>{`
        .chs-login-screen {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          background: var(--chs-bg-primary);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: var(--chs-text-primary);
        }

        .chs-login-container {
          width: 100%;
          max-width: 400px;
          padding: 40px 20px;
        }

        .chs-login-header {
          text-align: center;
          margin-bottom: 40px;
        }

        .chs-login-title {
          margin: 0 0 8px 0;
          font-size: 28px;
          font-weight: 600;
          letter-spacing: -0.5px;
        }

        .chs-login-subtitle {
          margin: 0 0 16px 0;
          font-size: 14px;
          color: var(--chs-text-secondary);
        }

        .chs-login-hint {
          margin: 0;
          font-size: 13px;
          color: var(--chs-text-tertiary);
          line-height: 1.5;
        }

        .chs-login-loading {
          text-align: center;
          padding: 40px 20px;
          color: var(--chs-text-secondary);
        }

        .chs-login-error {
          text-align: center;
          padding: 20px;
          background: var(--chs-bg-warning, rgba(255, 193, 7, 0.1));
          border-radius: 4px;
          margin-bottom: 20px;
        }

        .chs-login-error p {
          margin: 0 0 12px 0;
          font-size: 14px;
        }

        .chs-login-empty {
          text-align: center;
          padding: 40px 20px;
          color: var(--chs-text-secondary);
        }

        .chs-login-users {
          margin-bottom: 20px;
        }

        .chs-login-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .chs-login-item {
          margin: 0;
          padding: 0;
        }

        .chs-login-user-btn {
          width: 100%;
          padding: 12px 16px;
          background: var(--chs-bg-secondary);
          border: 1px solid var(--chs-border);
          border-radius: 4px;
          cursor: pointer;
          text-align: left;
          transition: all 0.15s ease;
          font-family: inherit;
          color: inherit;
        }

        .chs-login-user-btn:hover {
          background: var(--chs-bg-tertiary);
          border-color: var(--chs-primary);
        }

        .chs-login-user-btn:active {
          background: var(--chs-primary);
          color: var(--chs-bg-primary);
        }

        .chs-login-user-name {
          font-weight: 500;
          font-size: 14px;
          margin-bottom: 4px;
        }

        .chs-login-user-position {
          font-size: 12px;
          color: var(--chs-text-secondary);
        }
      `}</style>
    </div>
  );
}

export default LoginScreen;
