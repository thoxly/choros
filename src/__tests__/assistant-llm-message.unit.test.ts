/**
 * src/__tests__/assistant-llm-message.unit.test.ts — T-0573 (ADR-T0573 §2.2 B3,
 * FF-UX-7, AC-6/AC-7), extended by T-0595 (ADR-T0595, UX_REVIEW T-0573 F-1/F-2).
 *
 * Unit-level (no DB, no network) checks on the two honest "LLM unavailable"
 * messages (admin / non-admin, split by T-0595) and the core classifier that
 * routes both failure paths to them.
 */

import { describe, it, expect } from 'vitest';
import {
  ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN,
  ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN,
} from '../core/assistant-messages.js';
import {
  classifyLlmUnavailability,
  isProviderAuthFailure,
  canonicalizeLlmError,
  LlmDormantError,
  LlmUnavailableError,
} from '../core/llm-port.js';

const DENYLIST = ['LLM_NOT_CONFIGURED', 'OpenAILlmPort', 'endpoint', 'secretHandle', 'stack'];

describe('T-0595 — ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN (AC-4/AC-7, UX_REVIEW T-0573 F-2)', () => {
  it('AC-4/F-2: does NOT contain the bare /llm-connections path (replaced by a clickable deep-link)', () => {
    expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN).not.toContain('/llm-connections');
  });

  it('names the target page by its FACTUAL nav/h1 title «LLM-соединения» (UX_REVIEW T-0595 F-1)', () => {
    expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN).toContain('LLM-соединения');
  });

  it('AC-6 (carried over): states plainly that a key must be connected/checked', () => {
    expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN.toLowerCase()).toMatch(/ключ/);
  });

  it('AC-7: contains none of the dev-jargon denylist tokens', () => {
    for (const token of DENYLIST) {
      expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN, `must not contain '${token}'`).not.toContain(token);
    }
  });
});

describe('T-0595 — ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN (AC-3/AC-7)', () => {
  it('AC-3: does NOT contain /llm-connections (path unreachable via own nav — no dead door)', () => {
    expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN).not.toContain('/llm-connections');
  });

  it('AC-3: honestly directs the caller to their tenant admin', () => {
    expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN.toLowerCase()).toMatch(/администратор/);
  });

  it('states plainly that a key must be connected/checked', () => {
    expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN.toLowerCase()).toMatch(/ключ/);
  });

  it('AC-7: contains none of the dev-jargon denylist tokens', () => {
    for (const token of DENYLIST) {
      expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN, `must not contain '${token}'`).not.toContain(token);
    }
  });
});

describe('T-0573 — classifyLlmUnavailability (ADR §2.2 B1)', () => {
  it('classifies LlmDormantError as "unavailable"', () => {
    expect(classifyLlmUnavailability(new LlmDormantError())).toBe('unavailable');
  });

  it('classifies LlmUnavailableError as "unavailable"', () => {
    expect(classifyLlmUnavailability(new LlmUnavailableError('bad key'))).toBe('unavailable');
  });

  it('does NOT classify a plain Error as "unavailable" — real bugs are not masked', () => {
    expect(classifyLlmUnavailability(new Error('some unrelated bug'))).toBeNull();
  });

  it('does NOT classify a non-Error thrown value as "unavailable"', () => {
    expect(classifyLlmUnavailability('a string, not an Error')).toBeNull();
    expect(classifyLlmUnavailability(undefined)).toBeNull();
    expect(classifyLlmUnavailability(null)).toBeNull();
  });

  it('LlmUnavailableError preserves cause for logs (never surfaced to the user)', () => {
    const original = new Error('OpenAI API error 401: invalid api key');
    const wrapped = new LlmUnavailableError('OpenAILlmPort: invalid secret handle', { cause: original });
    expect(wrapped.cause).toBe(original);
    // The user-facing constant must remain jargon-free regardless of what the
    // underlying cause says (proven independently above) — this test only
    // proves the cause is preserved for operator-side logs, not egressed.
  });
});

// ---------------------------------------------------------------------------
// T-0600 (AC-5/AC-6): isProviderAuthFailure + canonicalizeLlmError.
//
// A live acceptance run showed the raw provider response body (e.g. a 401
// with the provider's own JSON error payload) leaking verbatim into the
// chat — two call sites (assistant-configurator.ts, process-gen-loop.ts)
// catch LlmUnavailableError LOCALLY (bypassing classifyLlmUnavailability /
// the honest-503 path entirely) and used to interpolate err.message
// straight into user-visible text. These two functions are the fix's core:
// classify by the ADAPTER's OWN message prefix (never by parsing the
// provider's arbitrary JSON body) and always return a fixed, safe sentence.
// ---------------------------------------------------------------------------

const PROVIDER_JSON_FIXTURE_401 =
  'OpenAI API error 401: {"error":{"message":"Incorrect API key provided: sk-***. ' +
  'You can find your API key at https://platform.openai.com/account/api-keys.",' +
  '"type":"invalid_request_error","param":null,"code":"invalid_api_key"}}';

const PROVIDER_JSON_FIXTURE_403 =
  'OpenAI API error 403: {"error":{"message":"Country, region, or territory not supported",' +
  '"type":"request_forbidden","code":null}}';

describe('T-0600 — isProviderAuthFailure', () => {
  it('classifies a 401 LlmUnavailableError (adapter prefix) as a provider auth failure', () => {
    expect(isProviderAuthFailure(new LlmUnavailableError(PROVIDER_JSON_FIXTURE_401))).toBe(true);
  });

  it('classifies a 403 LlmUnavailableError (adapter prefix) as a provider auth failure', () => {
    expect(isProviderAuthFailure(new LlmUnavailableError(PROVIDER_JSON_FIXTURE_403))).toBe(true);
  });

  it('does NOT classify a non-auth LlmUnavailableError (e.g. timeout/network) as auth failure', () => {
    expect(isProviderAuthFailure(new LlmUnavailableError('timeout: OpenAI request exceeded 30000ms'))).toBe(false);
    expect(isProviderAuthFailure(new LlmUnavailableError('OpenAI API network error: ECONNRESET'))).toBe(false);
    expect(isProviderAuthFailure(new LlmUnavailableError('OpenAI API error 500: internal server error'))).toBe(false);
  });

  it('does NOT classify LlmDormantError or a plain Error as a provider auth failure', () => {
    expect(isProviderAuthFailure(new LlmDormantError())).toBe(false);
    expect(isProviderAuthFailure(new Error('OpenAI API error 401: something'))).toBe(false);
    expect(isProviderAuthFailure('a string')).toBe(false);
    expect(isProviderAuthFailure(undefined)).toBe(false);
  });
});

describe('T-0600 — canonicalizeLlmError (AC-5/AC-6/AC-7/AC-8: no raw provider body ever leaks)', () => {
  const DENYLIST = ['LLM_NOT_CONFIGURED', 'OpenAILlmPort', 'endpoint', 'secretHandle', 'stack', 'порт', 'port', 'adapter'];

  it('401 provider-auth-fail → canonical Russian text, NO fragment of the raw provider JSON', () => {
    const text = canonicalizeLlmError(new LlmUnavailableError(PROVIDER_JSON_FIXTURE_401));
    expect(text).not.toContain('invalid_request_error');
    expect(text).not.toContain('Incorrect API key');
    expect(text).not.toContain('invalid_api_key');
    expect(text).not.toContain('sk-***');
    expect(text.toLowerCase()).toMatch(/ключ/);
    expect(text.toLowerCase()).toMatch(/провайдер/);
  });

  it('403 provider-auth-fail → canonical Russian text, NO fragment of the raw provider JSON', () => {
    const text = canonicalizeLlmError(new LlmUnavailableError(PROVIDER_JSON_FIXTURE_403));
    expect(text).not.toContain('request_forbidden');
    expect(text).not.toContain('Country, region, or territory');
    expect(text.toLowerCase()).toMatch(/ключ/);
  });

  it('dormant error → canonical Russian text directing to LLM-connections setup', () => {
    const text = canonicalizeLlmError(new LlmDormantError('llm runtime dormant — configure agent_card.llm_* to enable'));
    expect(text).not.toContain('agent_card');
    expect(text).not.toContain('llm_*');
    expect(text.toLowerCase()).toMatch(/ключ/);
  });

  it('generic adapter failure (timeout/network/malformed) → canonical text, no status code, no raw body', () => {
    const timeoutErr = new LlmUnavailableError('timeout: OpenAI request exceeded 30000ms');
    const networkErr = new LlmUnavailableError('OpenAI API network error: getaddrinfo ENOTFOUND api.example.invalid');
    const malformedErr = new LlmUnavailableError('OpenAI API non-JSON response: <html>502 Bad Gateway</html>');
    for (const err of [timeoutErr, networkErr, malformedErr]) {
      const text = canonicalizeLlmError(err);
      expect(text).not.toContain('30000ms');
      expect(text).not.toContain('ENOTFOUND');
      expect(text).not.toContain('Bad Gateway');
      expect(text).not.toContain('OpenAI API');
    }
  });

  it('no output for any case contains a dev-jargon denylist token', () => {
    const cases = [
      new LlmUnavailableError(PROVIDER_JSON_FIXTURE_401),
      new LlmUnavailableError(PROVIDER_JSON_FIXTURE_403),
      new LlmDormantError(),
      new LlmUnavailableError('timeout: OpenAI request exceeded 30000ms'),
      new Error('some unrelated bug'),
    ];
    for (const err of cases) {
      const text = canonicalizeLlmError(err);
      for (const token of DENYLIST) {
        expect(text, `canonicalizeLlmError output must not contain '${token}'`).not.toContain(token);
      }
    }
  });
});
