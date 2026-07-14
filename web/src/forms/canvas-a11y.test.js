/**
 * web/src/forms/canvas-a11y.test.js  (T-0656)
 */

import { describe, it, expect } from 'vitest';
import { announceMove, announceCut, announcePaste, cloneForClipboard } from './canvas-a11y.js';

describe('announceMove', () => {
  it('names the block, container, and 1-based position in human Russian', () => {
    const msg = announceMove({ label: 'Сумма', containerLabel: 'Оплата', position: 2, total: 4 });
    expect(msg).toBe('Блок «Сумма» перемещён в «Оплата», позиция 2 из 4.');
  });

  it('falls back to "в форме" when there is no container label (root)', () => {
    const msg = announceMove({ label: 'Заголовок', position: 1, total: 3 });
    expect(msg).toContain('в форме');
    expect(msg).toContain('позиция 1 из 3');
  });

  it('says "блок" when the label is empty', () => {
    const msg = announceMove({ label: '', containerLabel: 'X', position: 1, total: 1 });
    expect(msg.startsWith('Блок блок перемещён')).toBe(true);
  });
});

describe('announceCut / announcePaste', () => {
  it('cut mentions the paste shortcut', () => {
    expect(announceCut('Дата')).toContain('Cmd/Ctrl+V');
  });
  it('paste names the block', () => {
    expect(announcePaste('Дата')).toContain('«Дата»');
  });
});

describe('cloneForClipboard', () => {
  it('deep-copies and strips the editor-local id but keeps the binding', () => {
    const node = { id: 'f7', type: 'field', fieldKey: 'amount', widget: 'money', label: 'Сумма' };
    const copy = cloneForClipboard(node);
    expect(copy.id).toBeUndefined();
    expect(copy.fieldKey).toBe('amount');
    expect(copy.widget).toBe('money');
    // independent object
    copy.label = 'changed';
    expect(node.label).toBe('Сумма');
  });

  it('returns null for a non-object', () => {
    expect(cloneForClipboard(null)).toBeNull();
    expect(cloneForClipboard(42)).toBeNull();
  });
});
