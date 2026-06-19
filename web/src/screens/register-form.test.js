/**
 * web/src/screens/register-form.test.js — T-0342
 *
 * Unit tests for register-form.js pure logic:
 *   - validateRegisterForm: 3 fields rendered + submit gate
 *   - postRegister: calls /api/register with correct shape; handles 201 → data
 *   - mapRegisterError: 409 EMAIL_TAKEN / ORG_TAKEN + 503 + 500 + 400
 *
 * No DOM / React — pure vitest in Node.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isValidEmail,
  validateRegisterForm,
  mapRegisterError,
  postRegister,
} from './register-form.js';

// ---------------------------------------------------------------------------
// isValidEmail
// ---------------------------------------------------------------------------
describe('isValidEmail', () => {
  it('accepts a well-formed email', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
  });
  it('rejects an address without @', () => {
    expect(isValidEmail('userexample.com')).toBe(false);
  });
  it('rejects a blank string', () => {
    expect(isValidEmail('')).toBe(false);
  });
  it('rejects an address with no dot in domain', () => {
    expect(isValidEmail('user@localhost')).toBe(false);
  });
  it('rejects non-string values', () => {
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateRegisterForm — renders all 3 fields + submit gate
// ---------------------------------------------------------------------------
describe('validateRegisterForm', () => {
  it('is valid with correct orgName + email + password', () => {
    const { valid, errors } = validateRegisterForm({
      orgName: 'Acme Corp',
      email: 'admin@acme.ru',
      password: 'secret99',
    });
    expect(valid).toBe(true);
    expect(errors).toEqual({});
  });

  it('flags all three fields when empty', () => {
    const { valid, errors } = validateRegisterForm({});
    expect(valid).toBe(false);
    expect(errors.orgName).toBeTruthy();
    expect(errors.email).toBeTruthy();
    expect(errors.password).toBeTruthy();
  });

  it('flags missing orgName alone', () => {
    const { valid, errors } = validateRegisterForm({ orgName: '', email: 'a@b.ru', password: '12345678' });
    expect(valid).toBe(false);
    expect(errors.orgName).toBeTruthy();
    expect(errors.email).toBeUndefined();
    expect(errors.password).toBeUndefined();
  });

  it('flags orgName longer than 120 chars', () => {
    const { valid, errors } = validateRegisterForm({
      orgName: 'X'.repeat(121),
      email: 'a@b.ru',
      password: '12345678',
    });
    expect(valid).toBe(false);
    expect(errors.orgName).toBeTruthy();
  });

  it('flags invalid email', () => {
    const { valid, errors } = validateRegisterForm({ orgName: 'Org', email: 'not-an-email', password: '12345678' });
    expect(valid).toBe(false);
    expect(errors.email).toBeTruthy();
  });

  it('flags password shorter than 8 chars', () => {
    const { valid, errors } = validateRegisterForm({ orgName: 'Org', email: 'a@b.ru', password: 'short' });
    expect(valid).toBe(false);
    expect(errors.password).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// mapRegisterError
// ---------------------------------------------------------------------------
describe('mapRegisterError', () => {
  it('maps 409 EMAIL_TAKEN to an email-conflict message', () => {
    const msg = mapRegisterError(409, { error: { code: 'EMAIL_TAKEN' } });
    expect(msg).toMatch(/email/i);
    expect(msg.length).toBeGreaterThan(0);
  });

  it('maps 409 ORG_TAKEN to an org-conflict message', () => {
    const msg = mapRegisterError(409, { error: { code: 'ORG_TAKEN' } });
    expect(msg).toMatch(/организац/i);
  });

  it('maps 503 to a service-unavailable message', () => {
    const msg = mapRegisterError(503, {});
    expect(msg).toMatch(/недоступ/i);
  });

  it('maps 400 to a validation message', () => {
    const msg = mapRegisterError(400, {});
    expect(msg.length).toBeGreaterThan(0);
  });

  it('maps unknown 500 to a generic error message', () => {
    const msg = mapRegisterError(500, {});
    expect(msg.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// postRegister — calls /api/register; handles 201 success; 409 EMAIL_TAKEN
// ---------------------------------------------------------------------------
describe('postRegister', () => {
  it('calls /api/register with JSON body containing orgName/email/password', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ tenantId: 'tid', tenantSlug: 'acme', userId: 'uid', email: 'a@b.ru' }),
    });

    const result = await postRegister(
      { orgName: 'Acme', email: 'a@b.ru', password: 'password1' },
      mockFetch,
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/register');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.orgName).toBe('Acme');
    expect(body.email).toBe('a@b.ru');
    expect(body.password).toBe('password1');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(201);
    expect(result.data.tenantId).toBe('tid');
  });

  it('trims orgName and email before sending', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({}),
    });
    await postRegister({ orgName: '  Acme  ', email: '  a@b.ru  ', password: 'pass1234' }, mockFetch);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.orgName).toBe('Acme');
    expect(body.email).toBe('a@b.ru');
  });

  it('returns ok=false + status=409 on EMAIL_TAKEN response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'EMAIL_TAKEN', message: 'Email already registered' } }),
    });
    const result = await postRegister({ orgName: 'Org', email: 'a@b.ru', password: 'pass1234' }, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.data.error.code).toBe('EMAIL_TAKEN');
  });

  it('returns ok=false + status=409 on ORG_TAKEN response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'ORG_TAKEN', message: 'Org slug taken' } }),
    });
    const result = await postRegister({ orgName: 'Acme', email: 'new@b.ru', password: 'pass1234' }, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.data.error.code).toBe('ORG_TAKEN');
  });

  it('returns ok=false + status=503 on auth-unavailable response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: 'AUTH_UNAVAILABLE', message: 'KC down' } }),
    });
    const result = await postRegister({ orgName: 'Org', email: 'a@b.ru', password: 'pass1234' }, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it('returns ok=false + status=0 on network error (never throws)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network failure'));
    const result = await postRegister({ orgName: 'Org', email: 'a@b.ru', password: 'pass1234' }, mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });
});
