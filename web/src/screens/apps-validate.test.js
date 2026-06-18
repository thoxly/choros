/**
 * Unit tests for the pure create-application form validation + error mapping
 * (web/src/screens/apps-validate.js, T-0265).
 *
 * NOTE on harness reach: the repo-root vitest config EXCLUDES web/** (so the
 * default `npm test` does not run this). It is runnable directly with
 * `node_modules/.bin/vitest run web/src/screens/apps-validate.test.js` and was
 * verified green that way. The slug rule under test is the exact mirror of the
 * backend contract (src/http/applications.ts SLUG_RE), so this test also guards
 * against client/server drift.
 */

import { describe, it, expect } from 'vitest';
import { validateAppForm, mapCreateError, SLUG_RE } from './apps-validate.js';

describe('validateAppForm', () => {
  it('accepts a valid slug + display_name (description optional)', () => {
    const r = validateAppForm({ slug: 'my-app-1', display_name: 'Моё приложение' });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual({});
  });

  it('accepts an optional description string', () => {
    const r = validateAppForm({ slug: 'a', display_name: 'A', description: 'desc' });
    expect(r.valid).toBe(true);
  });

  it('requires a non-empty slug', () => {
    const r = validateAppForm({ slug: '', display_name: 'A' });
    expect(r.valid).toBe(false);
    expect(r.errors.slug).toBeTruthy();
  });

  it('rejects an uppercase / invalid slug (mirrors backend SLUG_RE)', () => {
    expect(validateAppForm({ slug: 'My-App', display_name: 'A' }).errors.slug).toBeTruthy();
    expect(validateAppForm({ slug: '-leading-dash', display_name: 'A' }).errors.slug).toBeTruthy();
    expect(validateAppForm({ slug: 'has space', display_name: 'A' }).errors.slug).toBeTruthy();
    expect(validateAppForm({ slug: 'a'.repeat(65), display_name: 'A' }).errors.slug).toBeTruthy();
  });

  it('requires a non-blank display_name', () => {
    const r = validateAppForm({ slug: 'ok', display_name: '   ' });
    expect(r.valid).toBe(false);
    expect(r.errors.display_name).toBeTruthy();
  });

  it('rejects display_name over 256 chars', () => {
    const r = validateAppForm({ slug: 'ok', display_name: 'x'.repeat(257) });
    expect(r.valid).toBe(false);
    expect(r.errors.display_name).toBeTruthy();
  });

  it('rejects a non-string description', () => {
    const r = validateAppForm({ slug: 'ok', display_name: 'A', description: 42 });
    expect(r.valid).toBe(false);
    expect(r.errors.description).toBeTruthy();
  });

  it('SLUG_RE matches the documented backend pattern', () => {
    expect(SLUG_RE.source).toBe('^[a-z0-9][a-z0-9-]{0,63}$');
  });
});

describe('mapCreateError', () => {
  it('maps 409 to a slug-field message', () => {
    const m = mapCreateError(409, { error: { code: 'CONFLICT' } });
    expect(m.field).toBe('slug');
    expect(m.message).toMatch(/занят/i);
  });

  it('maps 400 to the server VALIDATION message when present', () => {
    const m = mapCreateError(400, { error: { message: 'slug must be lowercase' } });
    expect(m.field).toBeUndefined();
    expect(m.message).toBe('slug must be lowercase');
  });

  it('maps 400 to a generic message when body lacks one', () => {
    const m = mapCreateError(400, null);
    expect(m.message).toBeTruthy();
  });

  it('maps 401 to a re-login hint', () => {
    const m = mapCreateError(401, null);
    expect(m.message).toMatch(/войд|авториз/i);
  });

  it('falls back for an unexpected status', () => {
    const m = mapCreateError(500, null);
    expect(m.message).toMatch(/HTTP 500/);
  });
});
