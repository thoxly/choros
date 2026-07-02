/**
 * src/__tests__/assistant-llm-message.unit.test.ts — T-0573 (ADR-T0573 §2.2 B3,
 * FF-UX-7, AC-6/AC-7).
 *
 * Unit-level (no DB, no network) checks on the shared honest "LLM unavailable"
 * message and the core classifier that routes both failure paths to it.
 */

import { describe, it, expect } from 'vitest';
import { ASSISTANT_LLM_UNAVAILABLE_MESSAGE } from '../core/assistant-messages.js';
import {
  classifyLlmUnavailability,
  LlmDormantError,
  LlmUnavailableError,
} from '../core/llm-port.js';

describe('T-0573 — ASSISTANT_LLM_UNAVAILABLE_MESSAGE (AC-6/AC-7)', () => {
  it('AC-6: contains the /llm-connections path', () => {
    expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE).toContain('/llm-connections');
  });

  it('AC-6: states plainly that a key must be connected/checked (not just a bare error code)', () => {
    // Human-language cue present — not just a machine code.
    expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE.toLowerCase()).toMatch(/ключ/);
  });

  it('AC-7: contains none of the dev-jargon denylist tokens', () => {
    const denylist = ['LLM_NOT_CONFIGURED', 'OpenAILlmPort', 'endpoint', 'secretHandle', 'stack'];
    for (const token of denylist) {
      expect(ASSISTANT_LLM_UNAVAILABLE_MESSAGE, `must not contain '${token}'`).not.toContain(token);
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
