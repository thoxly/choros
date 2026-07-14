/**
 * web/src/screens/screen-register.jsx — T-0342
 *
 * Registration screen (self-serve onboarding).
 * Fields: Название организации · Email · Пароль
 * On success (201) → kc.login() starts the PKCE redirect.
 *
 * Kit + tokens only (OBLIK FF-UX-3 / G2 / G5):
 *   - Field, Button, LoadingState, ErrorState from components.jsx
 *   - All layout via var(--chs-*) tokens; no inline colors, no raw hex/rgba.
 *
 * Props:
 *   onLogin(kcConfig) — call kc.login() with the current keycloak config.
 *   keycloakConfig    — the keycloak sub-object from authConfig (url/realm/clientId)
 */

import React, { useState } from 'react';
import { Button, Field, LoadingState, ErrorState } from '../components/components.jsx';
import {
  validateRegisterForm,
  mapRegisterError,
  postRegister,
} from './register-form.js';

function RegisterScreen({ onLogin, keycloakConfig = null }) {
  const [fields, setFields] = useState({ orgName: '', email: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const set = (key) => (e) => {
    setFields((f) => ({ ...f, [key]: e.target.value }));
    // Clear per-field error on change
    if (fieldErrors[key]) setFieldErrors((fe) => { const next = { ...fe }; delete next[key]; return next; });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitError(null);

    const { valid, errors } = validateRegisterForm(fields);
    if (!valid) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      const { ok, status, data } = await postRegister(fields);
      if (ok && status === 201) {
        // Registration succeeded: start PKCE redirect so the user signs in.
        if (onLogin) onLogin(keycloakConfig);
        return;
      }
      setSubmitError(mapRegisterError(status, data));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="chs-register-screen">
      <div className="chs-register-container">
        <div className="chs-register-header">
          <h1 className="chs-register-title">Demiurge · Choros</h1>
          <p className="chs-register-subtitle">регистрация</p>
          <p className="chs-register-hint">Создайте вашу организацию и начните работу.</p>
        </div>

        {submitting ? (
          <div className="chs-register-loading">
            <LoadingState label="Создание организации…" />
          </div>
        ) : (
          <form className="chs-register-form" onSubmit={handleSubmit} noValidate>
            {submitError && (
              <div className="chs-register-error" role="alert">
                <ErrorState title="Ошибка регистрации" message={submitError} />
              </div>
            )}

            <div className="chs-register-fields">
              <Field
                label="Название организации"
                type="text"
                value={fields.orgName}
                onChange={set('orgName')}
                invalid={!!fieldErrors.orgName}
                hint={fieldErrors.orgName || undefined}
                autoComplete="organization"
                placeholder="ООО «Ромашка»"
                disabled={submitting}
              />
              <Field
                label="Email"
                type="email"
                value={fields.email}
                onChange={set('email')}
                invalid={!!fieldErrors.email}
                hint={fieldErrors.email || undefined}
                autoComplete="email"
                placeholder="admin@company.ru"
                disabled={submitting}
              />
              <Field
                label="Пароль"
                type="password"
                value={fields.password}
                onChange={set('password')}
                invalid={!!fieldErrors.password}
                hint={fieldErrors.password || 'Не менее 8 символов'}
                autoComplete="new-password"
                disabled={submitting}
              />
            </div>

            <div className="chs-register-actions">
              <Button variant="primary" type="submit" loading={submitting} disabled={submitting}>
                Создать организацию
              </Button>
            </div>
          </form>
        )}

        <div className="chs-register-footer">
          <p className="chs-register-signin-prompt">
            Уже есть учётная запись?{' '}
            <a
              className="chs-register-signin-link"
              href="/"
              onClick={(e) => { e.preventDefault(); window.history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }}
            >
              Войти
            </a>
          </p>
        </div>
      </div>

      <style>{`
        .chs-register-screen {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          background: var(--chs-color-bg);
          font-family: var(--chs-font-sans);
          color: var(--chs-color-text);
        }

        .chs-register-container {
          width: 100%;
          max-width: 420px;
          padding: var(--chs-space-10) var(--chs-space-7);
        }

        .chs-register-header {
          text-align: center;
          margin-bottom: var(--chs-space-10);
        }

        .chs-register-title {
          margin: 0 0 var(--chs-space-4) 0;
          font-size: var(--chs-text-2xl);
          font-weight: var(--chs-weight-semibold);
          letter-spacing: var(--chs-tracking-tight);
          color: var(--chs-color-text);
        }

        .chs-register-subtitle {
          margin: 0 0 var(--chs-space-6) 0;
          font-size: var(--chs-text-md);
          color: var(--chs-color-text-muted);
        }

        .chs-register-hint {
          margin: 0;
          font-size: var(--chs-text-base);
          color: var(--chs-color-text-faint);
          line-height: var(--chs-leading-normal);
        }

        .chs-register-loading {
          padding: var(--chs-space-9) var(--chs-space-7);
        }

        .chs-register-form {
          display: flex;
          flex-direction: column;
          gap: var(--chs-space-7);
        }

        .chs-register-error {
          margin-bottom: var(--chs-space-2);
        }

        .chs-register-fields {
          display: flex;
          flex-direction: column;
          gap: var(--chs-space-5);
        }

        .chs-register-actions {
          display: flex;
          flex-direction: column;
        }

        .chs-register-actions .chs-btn {
          width: 100%;
        }

        .chs-register-footer {
          margin-top: var(--chs-space-7);
          text-align: center;
        }

        .chs-register-signin-prompt {
          margin: 0;
          font-size: var(--chs-text-sm);
          color: var(--chs-color-text-muted);
        }

        .chs-register-signin-link {
          color: var(--chs-color-accent);
          text-decoration: none;
          font-weight: var(--chs-weight-medium);
        }

        .chs-register-signin-link:hover {
          text-decoration: underline;
        }

        .chs-register-signin-link:focus-visible {
          outline: 2px solid var(--chs-color-focus-ring);
          outline-offset: 2px;
          border-radius: var(--chs-radius-1);
        }
      `}</style>
    </div>
  );
}

export default RegisterScreen;
