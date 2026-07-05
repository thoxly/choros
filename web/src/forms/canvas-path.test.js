/**
 * web/src/forms/canvas-path.test.js  (T-0656 — UX-1 regression)
 *
 * The prefix-collision the design-steward found: a container at index 1 lit up
 * while the drag was really inside container 10 (or nested [0,1] vs [0,10]),
 * because the highlight used String.prototype.startsWith on concatenated path
 * strings — "10:0".startsWith("1") === true. These tests pin the STRUCTURAL
 * (segment-array) compare that replaced it. The last two tests reproduce the
 * exact false-positive: they FAIL under the old string logic and PASS here.
 */

import { describe, it, expect } from 'vitest';
import { segmentsEqual, isPrefixPath, containerIsDropTarget } from './canvas-path.js';

// The old buggy predicate, kept here ONLY to prove the tests below actually
// catch the regression it produced (string.startsWith on joined path keys).
function oldContainerHighlighted(myContainerPath, hoverContainerPath) {
  const key = (p) => p.map((s) => (typeof s === 'number' ? s : `t${s.tab}.${s.index}`)).join('/');
  const hoverKey = `${key(hoverContainerPath)}:0`;
  return hoverKey.startsWith(key(myContainerPath));
}

describe('segmentsEqual', () => {
  it('compares numeric segments', () => {
    expect(segmentsEqual(1, 1)).toBe(true);
    expect(segmentsEqual(1, 10)).toBe(false);
  });
  it('compares tab segments', () => {
    expect(segmentsEqual({ tab: 0, index: 2 }, { tab: 0, index: 2 })).toBe(true);
    expect(segmentsEqual({ tab: 0, index: 2 }, { tab: 1, index: 2 })).toBe(false);
  });
});

describe('isPrefixPath (segment-wise)', () => {
  it('root [] is a prefix of everything', () => {
    expect(isPrefixPath([], [0])).toBe(true);
    expect(isPrefixPath([], [10, 3])).toBe(true);
  });
  it('exact path is a prefix of itself', () => {
    expect(isPrefixPath([1], [1])).toBe(true);
  });
  it('a longer container is NOT a prefix of a shorter hover', () => {
    expect(isPrefixPath([1, 2], [1])).toBe(false);
  });
  it('does NOT treat [1] as a prefix of [10] (the collision)', () => {
    expect(isPrefixPath([1], [10])).toBe(false);
  });
  it('does NOT treat [0,1] as a prefix of [0,10]', () => {
    expect(isPrefixPath([0, 1], [0, 10])).toBe(false);
  });
});

describe('containerIsDropTarget', () => {
  it('null hover → not a target', () => {
    expect(containerIsDropTarget([1], null)).toBe(false);
  });
  it('root hover ([]) highlights no specific container', () => {
    expect(containerIsDropTarget([1], [])).toBe(false);
  });
  it('container highlights when the drag is inside it (exact)', () => {
    expect(containerIsDropTarget([2], [2])).toBe(true);
  });
  it('container highlights when the drag is in a nested descendant', () => {
    expect(containerIsDropTarget([2], [2, 0])).toBe(true);
  });

  // ── the UX-1 regression proof ──────────────────────────────────────────────
  it('container 1 does NOT highlight when dragging inside container 10 (10+ siblings)', () => {
    // OLD string logic false-matches here; structural compare is correct.
    expect(oldContainerHighlighted([1], [10])).toBe(true);   // demonstrates the bug
    expect(containerIsDropTarget([1], [10])).toBe(false);    // the fix
  });
  it('nested [0,1] does NOT highlight when dragging inside [0,10]', () => {
    expect(oldContainerHighlighted([0, 1], [0, 10])).toBe(true); // bug
    expect(containerIsDropTarget([0, 1], [0, 10])).toBe(false);  // fix
  });
});
