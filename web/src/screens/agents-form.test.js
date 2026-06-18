/**
 * web/src/screens/agents-form.test.js — T-0271
 *
 * Unit tests for the agents-screen pure logic (agents-form.js):
 *   - validateHire / buildHirePayload — exact POST /api/agents/hire body shape;
 *   - classifyHandle — mirrors the backend secret-handle reject heuristics so a
 *     RAW vendor key is rejected client-side (no secret leaves the browser);
 *   - validateBind / buildBindPayload — { handle_value } only (narrow secret path);
 *   - NO-SECRET-ECHO: buildBindPayload never carries provider/model/raw key beyond
 *     the handle field, and the secret never appears in any returned metadata;
 *   - mapAgentError — honest surfacing of the agents + secret-handle contracts;
 *   - positionOptions — defensive tenant-state → dropdown mapping.
 */

import { describe, it, expect } from 'vitest';
import {
  SLUG_RE,
  validateHire, buildHirePayload,
  classifyHandle, handleRejectMessage, validateBind, buildBindPayload,
  mapAgentError, statusLabel, positionOptions,
} from './agents-form.js';

describe('validateHire', () => {
  it('requires slug, display_name, position_id', () => {
    const { valid, errors } = validateHire({});
    expect(valid).toBe(false);
    expect(errors.slug).toBeTruthy();
    expect(errors.display_name).toBeTruthy();
    expect(errors.position_id).toBeTruthy();
  });

  it('rejects a bad slug shape', () => {
    const { valid, errors } = validateHire({ slug: 'Bad Slug', display_name: 'X', position_id: 'p1' });
    expect(valid).toBe(false);
    expect(errors.slug).toBeTruthy();
  });

  it('accepts a well-formed hire form', () => {
    const { valid, errors } = validateHire({ slug: 'recon-bot', display_name: 'Сверка', position_id: 'c0000000-0000-0000-0000-000000000001' });
    expect(valid).toBe(true);
    expect(errors).toEqual({});
  });

  it('SLUG_RE mirrors the constructor grammar', () => {
    expect(SLUG_RE.test('recon-bot')).toBe(true);
    expect(SLUG_RE.test('-bad')).toBe(false);
    expect(SLUG_RE.test('Bad')).toBe(false);
  });
});

describe('buildHirePayload', () => {
  it('produces exactly { position_id, slug, display_name } and never an LLM key', () => {
    const body = buildHirePayload({ slug: 'recon-bot', display_name: '  Сверка  ', position_id: 'pid', handle: 'sk-leak', provider: 'openai' });
    expect(body).toEqual({ position_id: 'pid', slug: 'recon-bot', display_name: 'Сверка' });
    // The hire payload must NOT carry any secret/LLM field — binding is separate.
    const json = JSON.stringify(body);
    expect(json).not.toContain('sk-leak');
    expect(json).not.toContain('handle');
    expect(json).not.toContain('provider');
  });
});

describe('classifyHandle — mirrors backend secret-handle reject heuristics', () => {
  it('rejects too-short', () => {
    expect(classifyHandle('short')).toBe('too_short');
  });
  it('rejects raw vendor keys (sk-/xai-/AIza)', () => {
    expect(classifyHandle('sk-proj-abcdefghijklmnop')).toBe('vendor_key_prefix');
    expect(classifyHandle('xai-abcdefghijkl')).toBe('vendor_key_prefix');
    expect(classifyHandle('AIzaSyABCDEFGHIJ')).toBe('vendor_key_prefix');
  });
  it('rejects a bare 32+ hex token', () => {
    expect(classifyHandle('a'.repeat(40))).toBe('bare_hex_token');
  });
  it('rejects a JWT-shaped token', () => {
    expect(classifyHandle('eyJabc.eyJdef.sigGHI')).toBe('jwt_shape');
  });
  it('accepts a proper opaque handle reference', () => {
    expect(classifyHandle('vault://secret/llm/recon')).toBeNull();
    expect(classifyHandle('env://LLM_KEY')).toBeNull();
  });
  it('every reject reason has a human message', () => {
    for (const r of ['too_short', 'vendor_key_prefix', 'bare_hex_token', 'jwt_shape']) {
      expect(handleRejectMessage(r)).toBeTruthy();
    }
  });
});

describe('validateBind', () => {
  it('requires a provider and a non-raw-key handle', () => {
    const { valid, errors } = validateBind({});
    expect(valid).toBe(false);
    expect(errors.provider).toBeTruthy();
    expect(errors.handle).toBeTruthy();
  });

  it('rejects a raw vendor key with a clear hint (do not leak the key)', () => {
    const { valid, errors } = validateBind({ provider: 'openai', handle: 'sk-proj-superSecretKey123' });
    expect(valid).toBe(false);
    expect(errors.handle).toMatch(/хэндл/i);
  });

  it('accepts a provider + opaque handle', () => {
    const { valid, errors } = validateBind({ provider: 'anthropic', handle: 'vault://secret/llm/recon' });
    expect(valid).toBe(true);
    expect(errors).toEqual({});
  });
});

describe('buildBindPayload — narrow secret path', () => {
  it('sends ONLY { handle_value } (no provider/model), matching the backend contract', () => {
    const body = buildBindPayload({ provider: 'openai', model: 'gpt-4', handle: 'vault://secret/llm/x' });
    expect(body).toEqual({ handle_value: 'vault://secret/llm/x' });
    // provider/model are metadata — they must NOT ride the secret-handle POST.
    const json = JSON.stringify(body);
    expect(json).not.toContain('provider');
    expect(json).not.toContain('model');
  });
});

describe('mapAgentError — honest contract surfacing', () => {
  it('maps INVALID_HANDLE (400) onto the handle field with a key-vs-handle hint', () => {
    const m = mapAgentError(400, { error: { code: 'INVALID_HANDLE', message: 'vendor_key_prefix' } });
    expect(m.field).toBe('handle');
    expect(m.message).toMatch(/хэндл/i);
  });
  it('maps 409 to a slug-taken message on the slug field', () => {
    const m = mapAgentError(409, {});
    expect(m.field).toBe('slug');
    expect(m.message).toMatch(/занят/i);
  });
  it('maps 403 to an authority message', () => {
    expect(mapAgentError(403, {}).message).toMatch(/прав/i);
  });
  it('maps 401 to a re-login message', () => {
    expect(mapAgentError(401, {}).message).toMatch(/авторизован/i);
  });
  it('maps 404 honestly', () => {
    expect(mapAgentError(404, {}).message).toMatch(/не найден/i);
  });
  it('maps 503 to a transient message', () => {
    expect(mapAgentError(503, {}).message).toBeTruthy();
  });
  it('falls back with the HTTP status for unknown codes', () => {
    expect(mapAgentError(500, {}).message).toMatch(/500/);
  });
});

describe('statusLabel', () => {
  it('labels configured vs needs_llm', () => {
    expect(statusLabel('configured')).toMatch(/привязана/i);
    expect(statusLabel('needs_llm')).toMatch(/Нужна/i);
  });
});

describe('positionOptions', () => {
  it('maps tenant-state positions to {id,label}, preferring title then slug', () => {
    const opts = positionOptions([
      { id: 'p1', slug: 'fin-ctrl', title: 'Контролёр' },
      { id: 'p2', slug: 'cs-l1' },
      { id: '', slug: 'skip-me' },
      null,
    ]);
    expect(opts).toEqual([
      { id: 'p1', label: 'Контролёр' },
      { id: 'p2', label: 'cs-l1' },
    ]);
  });
  it('is defensive against non-arrays', () => {
    expect(positionOptions(undefined)).toEqual([]);
    expect(positionOptions(null)).toEqual([]);
  });
});
