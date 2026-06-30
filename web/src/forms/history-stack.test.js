/**
 * history-stack.test.js (T-0544) — pure undo/redo invariants.
 */
import { describe, it, expect } from 'vitest';
import {
  initHistory, pushHistory, undo, redo, canUndo, canRedo, MAX_HISTORY,
} from './history-stack.js';

const A = { v: 'a' }; const B = { v: 'b' }; const C = { v: 'c' };

describe('history-stack', () => {
  it('init starts with present and empty past/future', () => {
    const h = initHistory(A);
    expect(h.present).toBe(A);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('push moves present to past and sets new present', () => {
    let h = initHistory(A);
    h = pushHistory(h, B);
    expect(h.present).toBe(B);
    expect(h.past).toEqual([A]);
    expect(canUndo(h)).toBe(true);
    expect(h.future).toEqual([]);
  });

  it('undo restores the previous present; redo re-applies', () => {
    let h = pushHistory(initHistory(A), B);
    h = pushHistory(h, C);
    expect(h.present).toBe(C);
    h = undo(h);
    expect(h.present).toBe(B);
    expect(canRedo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe(A);
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    expect(h.present).toBe(B);
    h = redo(h);
    expect(h.present).toBe(C);
    expect(canRedo(h)).toBe(false);
  });

  it('a new edit after undo clears the redo branch', () => {
    let h = pushHistory(initHistory(A), B);
    h = undo(h); // present=A, future=[B]
    expect(canRedo(h)).toBe(true);
    h = pushHistory(h, C); // forks
    expect(h.present).toBe(C);
    expect(canRedo(h)).toBe(false);
  });

  it('undo/redo on empty side return null', () => {
    const h = initHistory(A);
    expect(undo(h)).toBeNull();
    expect(redo(h)).toBeNull();
  });

  it('push of the same present is a no-op', () => {
    const h = initHistory(A);
    expect(pushHistory(h, A)).toBe(h);
  });

  it('past is capped at MAX_HISTORY', () => {
    let h = initHistory({ n: 0 });
    for (let i = 1; i <= MAX_HISTORY + 10; i += 1) h = pushHistory(h, { n: i });
    expect(h.past.length).toBeLessThanOrEqual(MAX_HISTORY);
  });
});
