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
