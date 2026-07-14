// @vitest-environment jsdom
/**
 * web/src/screens/screen-users.mount.test.jsx  (T-0748, extended by T-0762)
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
 *
 * T-0762 (R-2 follow-up from T-0748's own review) adds the sibling
 * NAME_TOO_LONG case (KC's length validator, distinct messageKey from the
 * character validator above) to the SAME real-DOM proof.
 *
 * T-0775 adds a third block below: the «Деактивировать» ConfirmDialog gate
 * (live-audit T-0693 HIGH — it used to fire the PATCH instantly, no confirm,
 * no undo, no toast). Since the screen now calls useToastContext(), every
 * render in this file is wrapped in the real <ToastProvider> (same pattern as
 * screen-record-detail.mount.test.jsx) — a bare <UsersScreen/> would throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, waitFor, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { ToastProvider } from '../app-shell/toast-context.jsx';
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

function renderUsersScreen() {
  return render(
    <ToastProvider>
      <UsersScreen />
    </ToastProvider>,
  );
}

async function openCreateModal() {
  renderUsersScreen();
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

  it('T-0762: a KC NAME_TOO_LONG 400 (single-token 256-char display_name) shows the honest Russian "слишком длинное" hint on Отображаемое имя — NOT the misleading email message', async () => {
    const dialog = await openCreateModal();
    fillCreateForm(dialog, {
      login: 'too-long-name',
      email: 'too-long-name@example.com', // a perfectly valid email — must NOT be blamed
      password: 'password12345',
      display_name: 'A'.repeat(256), // single token, near DISPLAY_NAME_MAX — the T-0762 anti-case
    });

    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'POST' && u === '/api/users') {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              code: 'NAME_TOO_LONG',
              message: 'отображаемое имя слишком длинное — Keycloak допускает не более 255 символов на имя или фамилию; сократите имя и попробуйте снова',
            },
          }),
        };
      }
      return bootFetch(u);
    };

    fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));

    await waitFor(() => {
      expect(within(dialog).getByText(/слишком длинное/)).toBeTruthy();
    });
    // The hint is attached to the Отображаемое имя field, not a generic banner.
    const nameInput = within(dialog).getByLabelText('Отображаемое имя');
    expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    // The pre-fix bug (before T-0748/T-0762): the SAME class of 400 used to
    // surface as this misleading text. It must be absent from the whole dialog.
    expect(within(dialog).queryByText(/email must be a valid email address/i)).toBeNull();
    // The email field itself must NOT be flagged invalid — the email was fine.
    const emailInput = within(dialog).getByLabelText('Email');
    expect(emailInput.getAttribute('aria-invalid')).not.toBe('true');
  }, 15000); // real jsdom mount + interaction; matches the 15000ms budget precedent set by the T-0748 test above (R-1: solo <3.2s, full-suite-parallel contention observed elsewhere).

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

/* =============================================================================
   T-0775 — «Деактивировать» ConfirmDialog gate (live-audit T-0693 HIGH).
   Before this fix the button fired PATCH /api/users/:id instantly — no
   confirm, no undo, no success toast — the only unconfirmed consequential
   action on this screen (inconsistent with «Уволить» in
   rights/ra-intents.jsx). These tests mount the REAL screen with one active
   account and prove: click opens ConfirmDialog BEFORE any PATCH fires;
   Cancel closes it with zero PATCH calls; Confirm fires exactly one PATCH
   and shows a real success toast.
   ============================================================================= */
const ONE_ACCOUNT = {
  employee_id: 'emp-generic-1',
  display_name: 'Иван Петров',
  login: 'ivan.petrov',
  login_missing: false,
  active: true,
  position: null,
  department: null,
};

function bootFetchOneAccount(url) {
  const u = String(url);
  if (u.startsWith('/api/users/accounts')) return jsonOk({ accounts: [ONE_ACCOUNT] });
  if (u.startsWith('/api/org/tenant-state')) return jsonOk({ positions: [] });
  return jsonOk({});
}

describe('UsersScreen — «Деактивировать» is gated behind ConfirmDialog (T-0775)', () => {
  let originalFetch;
  let originalLocalStorage;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
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

  async function mountWithOneAccount() {
    globalThis.fetch = async (url) => bootFetchOneAccount(url);
    renderUsersScreen();
    await waitFor(() => {
      expect(screen.queryByText('Загрузка пользователей…')).toBeNull();
    });
    return screen.getByRole('button', { name: 'Деактивировать' });
  }

  it('clicking «Деактивировать» opens ConfirmDialog and does NOT call the PATCH API yet', async () => {
    const deactivateBtn = await mountWithOneAccount();
    const patchCalls = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'PATCH') patchCalls.push([u, opts]);
      return bootFetchOneAccount(u);
    };

    fireEvent.click(deactivateBtn);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Деактивировать учётку?')).toBeTruthy();
    // ConsequenceSummary — human name, not a raw UUID/employee_id.
    expect(within(dialog).getByText('Иван Петров')).toBeTruthy();
    expect(within(dialog).queryByText(ONE_ACCOUNT.employee_id)).toBeNull();
    expect(patchCalls.length).toBe(0);
  }, 15000);

  it('Cancel closes the dialog and calls the PATCH API zero times', async () => {
    const deactivateBtn = await mountWithOneAccount();
    const patchCalls = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'PATCH') patchCalls.push([u, opts]);
      return bootFetchOneAccount(u);
    };

    fireEvent.click(deactivateBtn);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(patchCalls.length).toBe(0);
    // Account is untouched — still shows the "Деактивировать" affordance.
    expect(screen.getByRole('button', { name: 'Деактивировать' })).toBeTruthy();
  }, 15000);

  it('Confirm calls PATCH /api/users/:id with {active:false} exactly once and shows a success toast', async () => {
    const deactivateBtn = await mountWithOneAccount();
    const patchCalls = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'PATCH') {
        patchCalls.push([u, JSON.parse(opts.body)]);
        return jsonOk({ ok: true });
      }
      // After the PATCH, loadAccounts() refetches — return the now-inactive account.
      if (u.startsWith('/api/users/accounts')) {
        return jsonOk({ accounts: [{ ...ONE_ACCOUNT, active: false }] });
      }
      return bootFetchOneAccount(u);
    };

    fireEvent.click(deactivateBtn);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Деактивировать' }));

    await waitFor(() => {
      expect(patchCalls.length).toBe(1);
    });
    expect(patchCalls[0][0]).toBe(`/api/users/${ONE_ACCOUNT.employee_id}`);
    expect(patchCalls[0][1]).toEqual({ active: false });

    // Real success toast (ToastProvider → ToastViewport → role=status), not a fake banner.
    await waitFor(() => {
      expect(screen.getByText(/Учётка «Иван Петров» деактивирована/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  }, 15000);
});
