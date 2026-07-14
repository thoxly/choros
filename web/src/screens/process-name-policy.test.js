/**
 * web/src/screens/process-name-policy.test.js — T-0684 (capstone T-0647 P1).
 *
 * Pin tests for the client-side process-name guard the editor uses to block a
 * save/publish before the network call. Mirrors the server policy's intent; the
 * placeholder literal is imported from the module (anti-case-lock: neutral values only).
 */

import { describe, it, expect } from 'vitest';
import {
  isRejectedProcessName,
  UNNAMED_PROCESS_PLACEHOLDER,
  PROCESS_NAME_REQUIRED_MESSAGE,
} from './process-name-policy.js';

describe('process-name-policy (web) — isRejectedProcessName', () => {
  it('rejects the modeler placeholder default', () => {
    expect(isRejectedProcessName(UNNAMED_PROCESS_PLACEHOLDER)).toBe(true);
  });

  it('rejects the placeholder regardless of whitespace/case', () => {
    expect(isRejectedProcessName(`  ${UNNAMED_PROCESS_PLACEHOLDER.toUpperCase()}  `)).toBe(true);
  });

  it('rejects empty / whitespace / nullish', () => {
    expect(isRejectedProcessName('')).toBe(true);
    expect(isRejectedProcessName('   ')).toBe(true);
    expect(isRejectedProcessName(undefined)).toBe(true);
    expect(isRejectedProcessName(null)).toBe(true);
  });

  it('accepts a real human name', () => {
    expect(isRejectedProcessName('Widget Intake Review')).toBe(false);
    expect(isRejectedProcessName('Обработка виджета')).toBe(false);
  });

  it('exposes a non-empty user-facing message', () => {
    expect(typeof PROCESS_NAME_REQUIRED_MESSAGE).toBe('string');
    expect(PROCESS_NAME_REQUIRED_MESSAGE.length).toBeGreaterThan(0);
  });
});
