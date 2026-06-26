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
  mapAgentError, statusLabel, positionOptions, displayAgentName, agentTypeLabel,
  connectionOptions, buildLlmConnectionPayload, mapLlmConnectionError,
  outcomeMeta, formatActivityTime, activityContext, mapActivityError,
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

describe('agentTypeLabel — registry shows the function taxonomy (T-0473)', () => {
  it('labels each known agent_type distinctly', () => {
    expect(agentTypeLabel('workforce')).toBe('Рабочий');
    expect(agentTypeLabel('system')).toBe('Системный');
    expect(agentTypeLabel('assistant')).toBe('Ассистент');
  });
  it('falls back to a neutral label for unknown/missing types (never throws)', () => {
    expect(agentTypeLabel(undefined)).toBe('Агент');
    expect(agentTypeLabel('something-new')).toBe('Агент');
  });
});

describe('displayAgentName — strips the (seed) provisioning marker (audit #6)', () => {
  it('drops a trailing "(seed)" so dev-jargon never reaches product text', () => {
    expect(displayAgentName('Config-агент (seed)')).toBe('Config-агент');
    expect(displayAgentName('Агент-документатор (seed)')).toBe('Агент-документатор');
  });
  it('is case-insensitive and tolerates the Cyrillic "(сид)" spelling + trailing space', () => {
    expect(displayAgentName('Recon (SEED) ')).toBe('Recon');
    expect(displayAgentName('Сверка (сид)')).toBe('Сверка');
  });
  it('leaves a clean human name untouched (and trims)', () => {
    expect(displayAgentName('Сверка-агент')).toBe('Сверка-агент');
    expect(displayAgentName('  Контролёр  ')).toBe('Контролёр');
  });
  it('does not strip "(seed)" mid-string — only the trailing marker', () => {
    expect(displayAgentName('seed-станция (prod)')).toBe('seed-станция (prod)');
  });
  it('is defensive against non-strings / empties', () => {
    expect(displayAgentName(undefined)).toBe('');
    expect(displayAgentName(null)).toBe('');
    expect(displayAgentName('(seed)')).toBe('(seed)'); // nothing left → keep the trimmed input
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

// ---------------------------------------------------------------------------
// T-0498 — LLM-connection selector helpers.
// ---------------------------------------------------------------------------

describe('connectionOptions — GET /api/llm-connections → dropdown', () => {
  it('maps {id,name,provider,model} to {id, "Имя · провайдер · модель"}', () => {
    const opts = connectionOptions([
      { id: 'c1', name: 'DeepSeek prod', provider: 'deepseek', model: 'deepseek-chat' },
      { id: 'c2', name: 'OpenAI', provider: 'openai' },
      { id: 'c3', name: 'Bare' },
    ]);
    expect(opts).toEqual([
      { id: 'c1', label: 'DeepSeek prod · deepseek · deepseek-chat' },
      { id: 'c2', label: 'OpenAI · openai' },
      { id: 'c3', label: 'Bare' },
    ]);
  });
  it('skips rows without an id and is defensive against non-arrays', () => {
    expect(connectionOptions([{ name: 'no-id' }, null, { id: '', name: 'empty' }])).toEqual([]);
    expect(connectionOptions(undefined)).toEqual([]);
    expect(connectionOptions(null)).toEqual([]);
  });
  it('falls back to the id as the label when name is missing', () => {
    expect(connectionOptions([{ id: 'c9' }])).toEqual([{ id: 'c9', label: 'c9' }]);
  });
});

describe('buildLlmConnectionPayload — UUID | null contract', () => {
  it('sends the selected connection id', () => {
    expect(buildLlmConnectionPayload('ffffffff-0000-0000-0000-000000000006'))
      .toEqual({ llm_connection_id: 'ffffffff-0000-0000-0000-000000000006' });
  });
  it('maps an empty selection to null (detach)', () => {
    expect(buildLlmConnectionPayload('')).toEqual({ llm_connection_id: null });
    expect(buildLlmConnectionPayload(undefined)).toEqual({ llm_connection_id: null });
    expect(buildLlmConnectionPayload(null)).toEqual({ llm_connection_id: null });
  });
});

describe('mapLlmConnectionError — honest surfacing of the PUT contract', () => {
  it('maps 400 LLM_CONNECTION_NOT_FOUND to a tenant-scoped hint', () => {
    const m = mapLlmConnectionError(400, { error: { code: 'LLM_CONNECTION_NOT_FOUND' } });
    expect(m).toMatch(/не найдено в вашем тенанте/i);
  });
  it('maps 403 to an authority message', () => {
    expect(mapLlmConnectionError(403, {})).toMatch(/прав/i);
  });
  it('maps 401 to a re-login message', () => {
    expect(mapLlmConnectionError(401, {})).toMatch(/авторизован/i);
  });
  it('maps 404 to agent-not-found', () => {
    expect(mapLlmConnectionError(404, {})).toMatch(/не найден/i);
  });
  it('falls back with the HTTP status for unknown codes', () => {
    expect(mapLlmConnectionError(500, {})).toMatch(/500/);
  });
});

// ---------------------------------------------------------------------------
// T-0499 — agent activity helpers (GET /api/agents/:id/activity)
// ---------------------------------------------------------------------------

describe('outcomeMeta — outcome → human chip + label', () => {
  it('maps proceeded → done «Выполнил сам»', () => {
    expect(outcomeMeta('proceeded')).toEqual({ chip: 'done', label: 'Выполнил сам' });
  });
  it('maps deferred → waiting «Отложил человеку»', () => {
    expect(outcomeMeta('deferred')).toEqual({ chip: 'waiting', label: 'Отложил человеку' });
  });
  it('maps blocked → failed «Заблокирован»', () => {
    expect(outcomeMeta('blocked')).toEqual({ chip: 'failed', label: 'Заблокирован' });
  });
  it('falls back to a neutral chip for unknown outcomes (no raw jargon)', () => {
    const m = outcomeMeta('agent.weird');
    expect(m.chip).toBe('paused');
    // never echoes the raw value
    expect(m.label).not.toContain('agent.');
  });
});

describe('formatActivityTime — human time, honest blank', () => {
  it('formats a finite ts to a ru-RU locale string', () => {
    const s = formatActivityTime(1700000000000);
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toMatch(/Invalid/i);
  });
  it('returns an empty string for a missing / non-finite ts (no "Invalid Date")', () => {
    expect(formatActivityTime(undefined)).toBe('');
    expect(formatActivityTime(NaN)).toBe('');
    expect(formatActivityTime('nope')).toBe('');
  });
});

describe('activityContext — safe «процесс · шаг» line', () => {
  it('joins process_key + step when both present', () => {
    expect(activityContext({ process_key: 'purchase', step: 'triage' })).toBe('purchase · triage');
  });
  it('shows only what is present', () => {
    expect(activityContext({ process_key: 'purchase' })).toBe('purchase');
    expect(activityContext({ step: 'triage' })).toBe('triage');
  });
  it('returns empty when neither is known', () => {
    expect(activityContext({})).toBe('');
    expect(activityContext(null)).toBe('');
  });
});

describe('mapActivityError — honest surfacing of the GET contract', () => {
  it('maps 401 to a human re-login message (not a raw code)', () => {
    const m = mapActivityError(401, {});
    expect(m).toMatch(/авторизован/i);
    expect(m).not.toContain('401');
  });
  it('maps 403 to an authority message', () => {
    expect(mapActivityError(403, {})).toMatch(/прав/i);
  });
  it('maps 404 to agent-not-found', () => {
    expect(mapActivityError(404, {})).toMatch(/не найден/i);
  });
  it('falls back with the HTTP status for unknown codes', () => {
    expect(mapActivityError(500, {})).toMatch(/500/);
  });
});
