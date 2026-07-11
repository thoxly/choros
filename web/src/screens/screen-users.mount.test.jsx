// @vitest-environment jsdom
/**
 * web/src/screens/screen-users.mount.test.jsx  (T-0748)
 *
 * REAL DOM mount test — @testing-library/react + jsdom. See
 * web/src/forms/FormDesigner.mount.test.jsx for the full D-064 rationale (a
 * source-presence/grep-style test can pass green while the REAL render path
 * shows the wrong thing — only a real mount+interaction catches that).
 *
 * screen-users.test.jsx (sibling file, existing convention) asserts wiring
 * against the raw .jsx source text — it never actually renders
 * CreateUserModal or submits it, so it could not observe WHICH message ends
 * up on screen for a given server response. This file closes that gap for
 * the T-0748 fix specifically: mounts the REAL `<UsersScreen />` (no props —
 * it is a route component, screen-users.jsx has no router/toast dependency),
 * opens the real "Создать учётку" modal, fills the real form fields, submits,
 * and asserts on the REAL rendered DOM text after a mocked KC
 * NAME_INVALID_CHARACTERS 400 — proving mapUserError's field-anchor
 * (users-form.js) actually reaches the "Отображаемое имя" field's hint text
 * in the live component tree, and that the misleading pre-fix email message
 * is NOT what the owner sees.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, waitFor, screen, cleanup, fireEvent, within } from '@testing-library/react';
import UsersScreen from './screen-users.jsx';

function jsonOk(body) {
  return { ok: true, status: 200, json: async () => body };
}

function bootFetch(url) {
  const u = String(url);
  if (u.startsWith('/api/users/accounts')) return jsonOk({ accounts: [] });
  // 200 here is what flips canWrite=true and reveals the "Создать учётку" button.
  if (u.startsWith('/api/org/tenant-state')) return jsonOk({ positions: [] });
  return jsonOk({});
}

async function openCreateModal() {
  render(<UsersScreen />);
  await waitFor(() => {
    expect(screen.queryByText('Загрузка пользователей…')).toBeNull();
  });
  // Both the header action and the EmptyState action render "Создать учётку"
  // when the tenant genuinely has zero accounts (accounts=[]) — click either.
  const openButtons = screen.getAllByRole('button', { name: 'Создать учётку' });
  fireEvent.click(openButtons[0]);
  const dialog = await screen.findByRole('dialog');
  return dialog;
}

function fillCreateForm(dialog, { login, email, password, display_name }) {
  fireEvent.change(within(dialog).getByLabelText('Логин'), { target: { value: login } });
  fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(within(dialog).getByLabelText('Пароль'), { target: { value: password } });
  fireEvent.change(within(dialog).getByLabelText('Отображаемое имя'), { target: { value: display_name } });
}

describe('UsersScreen — CreateUserModal honest name-character attribution (T-0748)', () => {
  let originalFetch;
  let originalLocalStorage;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    globalThis.fetch = async (url) => bootFetch(url);
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });

  it('a KC NAME_INVALID_CHARACTERS 400 (display_name="Bot #1") shows the honest Russian "недопустимые символы" hint on Отображаемое имя — NOT the misleading email message', async () => {
    const dialog = await openCreateModal();
    fillCreateForm(dialog, {
      login: 'bot-one',
      email: 'bot-one@example.com', // a perfectly valid email — must NOT be blamed
      password: 'password12345',
      display_name: 'Bot #1', // the exact T-0748 anti-case
    });

    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'POST' && u === '/api/users') {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              code: 'NAME_INVALID_CHARACTERS',
              message: 'отображаемое имя содержит недопустимые символы — уберите спецсимволы (<, &, #, кавычки, скобки) и попробуйте снова',
            },
          }),
        };
      }
      return bootFetch(u);
    };

    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));

    await waitFor(() => {
      expect(within(dialog).getByText(/недопустимые символы/)).toBeTruthy();
    });
    // The hint is attached to the Отображаемое имя field, not a generic banner.
    const nameInput = within(dialog).getByLabelText('Отображаемое имя');
    expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    // The pre-fix bug: the SAME 400 used to surface as this misleading text.
    // It must be absent from the whole dialog.
    expect(within(dialog).queryByText(/email must be a valid email address/i)).toBeNull();
    // The email field itself must NOT be flagged invalid — the email was fine.
    const emailInput = within(dialog).getByLabelText('Email');
    expect(emailInput.getAttribute('aria-invalid')).not.toBe('true');
  }, 15000); // real jsdom mount + interaction; default 5000ms budget flakes under full-suite parallel load (observed elsewhere, e.g. screen-record-detail.mount.test.jsx) — not this test's own logic (reliably <3.2s solo).

  it('regression: an ordinary EMAIL_TAKEN 409 still anchors on Email (untouched by the T-0748 branch)', async () => {
    const dialog = await openCreateModal();
    fillCreateForm(dialog, {
      login: 'ivan-petrov',
      email: 'taken@example.com',
      password: 'password12345',
      display_name: 'Иван Петров',
    });

    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'POST' && u === '/api/users') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: { code: 'EMAIL_TAKEN', message: 'логин или email уже заняты — выберите другие значения' } }),
        };
      }
      return bootFetch(u);
    };

    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));

    await waitFor(() => {
      expect(within(dialog).getByText(/уже занят/)).toBeTruthy();
    });
    const emailInput = within(dialog).getByLabelText('Email');
    expect(emailInput.getAttribute('aria-invalid')).toBe('true');
    const nameInput = within(dialog).getByLabelText('Отображаемое имя');
    expect(nameInput.getAttribute('aria-invalid')).not.toBe('true');
  }, 15000);
});
