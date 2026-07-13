/**
 * web/src/screens/users-form.test.js (T-0583, updated T-0628)
 *
 * Unit tests for the pure logic backing screen-users.jsx — validation,
 * payload assembly, error mapping, display helpers. Mirrors agents-form.test.js.
 */

import { describe, it, expect } from 'vitest';
import {
  validateCreateUser, buildCreateUserPayload,
  mapUserError, accountStatusMeta, positionOptions,
} from './users-form.js';

describe('validateCreateUser', () => {
  it('rejects an empty form with all four field errors', () => {
    const { valid, errors } = validateCreateUser({});
    expect(valid).toBe(false);
    expect(errors.login).toBeTruthy();
    expect(errors.email).toBeTruthy();
    expect(errors.password).toBeTruthy();
    expect(errors.display_name).toBeTruthy();
  });

  it('rejects a password shorter than 8 characters', () => {
    const { valid, errors } = validateCreateUser({
      login: 'ivanov', email: 'ivanov@company.ru', password: 'short1', display_name: 'Иванов Иван',
    });
    expect(valid).toBe(false);
    expect(errors.password).toMatch(/8/);
  });

  it('accepts a well-formed form', () => {
    const { valid, errors } = validateCreateUser({
      login: 'ivanov', email: 'ivanov@company.ru', password: 'password123', display_name: 'Иванов Иван',
    });
    expect(valid).toBe(true);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('rejects an over-long display_name', () => {
    const { valid, errors } = validateCreateUser({
      login: 'a', email: 'a@b.ru', password: 'password123', display_name: 'x'.repeat(300),
    });
    expect(valid).toBe(false);
    expect(errors.display_name).toBeTruthy();
  });

  // T-0628 fix (narrows T-0625): an "ordinary" (non-email) login is now a
  // LEGITIMATE value — T-0625 had briefly required login to be email-shaped
  // to fix the 503-on-create bug; T-0628 closes that same bug from the email
  // side instead (email is its own required field, checked below), so login
  // must stay free-form.
  it('accepts a non-email login (e.g. a bare username) as long as email is well-formed', () => {
    const { valid, errors } = validateCreateUser({
      login: 'liveproof-835201', email: 'liveproof-835201@example.com', password: 'password123', display_name: 'Ordinary Login',
    });
    expect(valid).toBe(true);
    expect(errors.login).toBeUndefined();
  });

  it('rejects a missing email even when login is present', () => {
    const { valid, errors } = validateCreateUser({
      login: 'ivan.petrov', password: 'password123', display_name: 'Ivan Petrov',
    });
    expect(valid).toBe(false);
    expect(errors.email).toBeTruthy();
    expect(errors.login).toBeUndefined();
  });

  it('rejects an email with no @ or no domain part', () => {
    expect(validateCreateUser({ login: 'x', email: 'no-at-sign', password: 'password123', display_name: 'X' }).valid).toBe(false);
    expect(validateCreateUser({ login: 'x', email: 'no-domain@', password: 'password123', display_name: 'X' }).valid).toBe(false);
  });

  it('rejects an empty login even when email is well-formed', () => {
    const { valid, errors } = validateCreateUser({
      email: 'a@b.ru', password: 'password123', display_name: 'X',
    });
    expect(valid).toBe(false);
    expect(errors.login).toBeTruthy();
    expect(errors.email).toBeUndefined();
  });
});

describe('buildCreateUserPayload', () => {
  it('builds the exact POST /api/users body with tenant_id + trimmed fields', () => {
    const body = buildCreateUserPayload('tenant-1', {
      login: '  ivan.petrov  ', email: '  ivanov@company.ru  ', password: 'password123', display_name: '  Иванов Иван  ',
    });
    expect(body).toEqual({
      tenant_id: 'tenant-1',
      login: 'ivan.petrov',
      email: 'ivanov@company.ru',
      password: 'password123',
      display_name: 'Иванов Иван',
    });
  });

  it('omits position_id/role_id when empty (server typeof-guard fallback)', () => {
    const body = buildCreateUserPayload('tenant-1', {
      login: 'a', email: 'a@b.ru', password: 'password123', display_name: 'A B', position_id: '', role_id: '',
    });
    expect(body.position_id).toBeUndefined();
    expect(body.role_id).toBeUndefined();
  });

  it('includes position_id/role_id when present', () => {
    const body = buildCreateUserPayload('tenant-1', {
      login: 'a', email: 'a@b.ru', password: 'password123', display_name: 'A B',
      position_id: 'pos-1', role_id: 'role-1',
    });
    expect(body.position_id).toBe('pos-1');
    expect(body.role_id).toBe('role-1');
  });

  it('never includes the password anywhere but the password field itself', () => {
    const body = buildCreateUserPayload('tenant-1', {
      login: 'a', email: 'a@b.ru', password: 'super-secret-pw', display_name: 'A B',
    });
    const serialized = JSON.stringify(body);
    // The password appears exactly once (its own field value).
    expect(serialized.split('super-secret-pw')).toHaveLength(2);
    expect(body.password).toBe('super-secret-pw');
  });
});

describe('mapUserError', () => {
  it('maps 409 EMAIL_TAKEN to an email field error', () => {
    const r = mapUserError(409, { error: { code: 'EMAIL_TAKEN' } });
    expect(r.field).toBe('email');
  });
  it('maps a generic 409 to a login field error', () => {
    const r = mapUserError(409, {});
    expect(r.field).toBe('login');
  });
  it('maps 403 to an insufficient-rights message (no field anchor)', () => {
    const r = mapUserError(403, {});
    expect(r.field).toBeUndefined();
    expect(r.message).toMatch(/прав/);
  });
  it('maps 503 to a service-unavailable message', () => {
    const r = mapUserError(503, {});
    expect(r.message).toMatch(/недоступен/);
  });
  it('maps 401 to a re-login message', () => {
    const r = mapUserError(401, {});
    expect(r.message).toMatch(/войдите/i);
  });
  it('falls back to a generic HTTP-status message for unknown codes', () => {
    const r = mapUserError(418, {}, 'создание учётки');
    expect(r.message).toMatch(/создание учётки/);
    expect(r.message).toMatch(/418/);
  });

  // T-0748 (NF-1 from T-0741's own review): a display_name with characters
  // Keycloak's person-name validator forbids (e.g. "Bot #1", "A&B") used to
  // fall through to the generic 400 branch below with the server's raw
  // EMAIL_INVALID text — misdirecting the owner to "fix" a perfectly valid
  // email. This must now anchor on display_name with the server's own
  // honest Russian message, NOT the email text.
  it('T-0748: maps 400 NAME_INVALID_CHARACTERS to a display_name field error with the server\'s Russian message', () => {
    const r = mapUserError(400, {
      error: {
        code: 'NAME_INVALID_CHARACTERS',
        message: 'отображаемое имя содержит недопустимые символы — уберите спецсимволы (<, &, #, кавычки, скобки) и попробуйте снова',
      },
    });
    expect(r.field).toBe('display_name');
    expect(r.message).toContain('недопустимые символы');
    expect(r.message).not.toMatch(/email/i);
  });

  it('T-0748: NAME_INVALID_CHARACTERS with no server message falls back to an honest Russian default (still anchored on display_name)', () => {
    const r = mapUserError(400, { error: { code: 'NAME_INVALID_CHARACTERS' } });
    expect(r.field).toBe('display_name');
    expect(r.message).toMatch(/символ/);
  });

  it('T-0748 regression: a plain 400 (e.g. EMAIL_INVALID) still falls to the generic field-less fallback, unaffected by the new NAME_INVALID_CHARACTERS case', () => {
    const r = mapUserError(400, { error: { code: 'VALIDATION', message: 'email must be a valid email address (e.g. name@company.ru)' } });
    expect(r.field).toBeUndefined();
    expect(r.message).toBe('email must be a valid email address (e.g. name@company.ru)');
  });

  // T-0762 (R-2 follow-up from T-0748's own review): a single-token
  // display_name near DISPLAY_NAME_MAX (no spaces, ~256 chars) trips
  // Keycloak's independent 255-char-per-field firstName/lastName LENGTH
  // cap — a DIFFERENT KC validator than T-0748's character one, previously
  // falling through to the generic 400 branch with the misleading email
  // text. Must anchor on display_name with the server's own honest message.
  it("T-0762: maps 400 NAME_TOO_LONG to a display_name field error with the server's Russian message", () => {
    const r = mapUserError(400, {
      error: {
        code: 'NAME_TOO_LONG',
        message: 'отображаемое имя слишком длинное — Keycloak допускает не более 255 символов на имя или фамилию; сократите имя и попробуйте снова',
      },
    });
    expect(r.field).toBe('display_name');
    expect(r.message).toContain('слишком длинное');
    expect(r.message).not.toMatch(/email/i);
  });

  it('T-0762: NAME_TOO_LONG with no server message falls back to an honest Russian default (still anchored on display_name)', () => {
    const r = mapUserError(400, { error: { code: 'NAME_TOO_LONG' } });
    expect(r.field).toBe('display_name');
    expect(r.message).toMatch(/длин/);
  });

  it('T-0762 regression: NAME_INVALID_CHARACTERS (T-0748\'s own class) is unaffected by the new NAME_TOO_LONG case — the two do not cross-map', () => {
    const r = mapUserError(400, {
      error: {
        code: 'NAME_INVALID_CHARACTERS',
        message: 'отображаемое имя содержит недопустимые символы — уберите спецсимволы (<, &, #, кавычки, скобки) и попробуйте снова',
      },
    });
    expect(r.field).toBe('display_name');
    expect(r.message).toContain('недопустимые символы');
    expect(r.message).not.toMatch(/слишком длинное/);
  });
});

describe('accountStatusMeta', () => {
  it('maps active=true to a "done" chip labeled Активна', () => {
    expect(accountStatusMeta(true)).toEqual({ chip: 'done', label: 'Активна' });
  });
  it('maps active=false to a "paused" chip labeled Деактивирована', () => {
    expect(accountStatusMeta(false)).toEqual({ chip: 'paused', label: 'Деактивирована' });
  });
});

describe('positionOptions', () => {
  it('returns [] for non-array input', () => {
    expect(positionOptions(null)).toEqual([]);
    expect(positionOptions(undefined)).toEqual([]);
  });
  it('filters out rows without a valid id and maps title/slug/id fallback', () => {
    const rows = [
      { id: 'p1', title: 'Менеджер' },
      { id: 'p2', slug: 'analyst' },
      { id: 'p3' },
      { id: '' },
      { title: 'No id' },
    ];
    expect(positionOptions(rows)).toEqual([
      { id: 'p1', label: 'Менеджер' },
      { id: 'p2', label: 'analyst' },
      { id: 'p3', label: 'p3' },
    ]);
  });
});
