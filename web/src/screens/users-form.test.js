/**
 * web/src/screens/users-form.test.js (T-0583)
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
  it('rejects an empty form with all three field errors', () => {
    const { valid, errors } = validateCreateUser({});
    expect(valid).toBe(false);
    expect(errors.login).toBeTruthy();
    expect(errors.password).toBeTruthy();
    expect(errors.display_name).toBeTruthy();
  });

  it('rejects a password shorter than 8 characters', () => {
    const { valid, errors } = validateCreateUser({
      login: 'ivanov@company.ru', password: 'short1', display_name: 'Иванов Иван',
    });
    expect(valid).toBe(false);
    expect(errors.password).toMatch(/8/);
  });

  it('accepts a well-formed form', () => {
    const { valid, errors } = validateCreateUser({
      login: 'ivanov@company.ru', password: 'password123', display_name: 'Иванов Иван',
    });
    expect(valid).toBe(true);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('rejects an over-long display_name', () => {
    const { valid, errors } = validateCreateUser({
      login: 'a@b.ru', password: 'password123', display_name: 'x'.repeat(300),
    });
    expect(valid).toBe(false);
    expect(errors.display_name).toBeTruthy();
  });
});

describe('buildCreateUserPayload', () => {
  it('builds the exact POST /api/users body with tenant_id + trimmed fields', () => {
    const body = buildCreateUserPayload('tenant-1', {
      login: '  ivanov@company.ru  ', password: 'password123', display_name: '  Иванов Иван  ',
    });
    expect(body).toEqual({
      tenant_id: 'tenant-1',
      login: 'ivanov@company.ru',
      password: 'password123',
      display_name: 'Иванов Иван',
    });
  });

  it('omits position_id/role_id when empty (server typeof-guard fallback)', () => {
    const body = buildCreateUserPayload('tenant-1', {
      login: 'a@b.ru', password: 'password123', display_name: 'A B', position_id: '', role_id: '',
    });
    expect(body.position_id).toBeUndefined();
    expect(body.role_id).toBeUndefined();
  });

  it('includes position_id/role_id when present', () => {
    const body = buildCreateUserPayload('tenant-1', {
      login: 'a@b.ru', password: 'password123', display_name: 'A B',
      position_id: 'pos-1', role_id: 'role-1',
    });
    expect(body.position_id).toBe('pos-1');
    expect(body.role_id).toBe('role-1');
  });

  it('never includes the password anywhere but the password field itself', () => {
    const body = buildCreateUserPayload('tenant-1', {
      login: 'a@b.ru', password: 'super-secret-pw', display_name: 'A B',
    });
    const serialized = JSON.stringify(body);
    // The password appears exactly once (its own field value).
    expect(serialized.split('super-secret-pw')).toHaveLength(2);
    expect(body.password).toBe('super-secret-pw');
  });
});

describe('mapUserError', () => {
  it('maps 409 EMAIL_TAKEN to a login field error', () => {
    const r = mapUserError(409, { error: { code: 'EMAIL_TAKEN' } });
    expect(r.field).toBe('login');
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
