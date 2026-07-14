/**
 * web/src/app-shell/sidebar-dnd.test.js — T-0651 (sidebar-workspace)
 *
 * Pure-logic tests for computeAppMove / computeArrowMove / computeSectionDrop —
 * no DOM, no React (mirrors kanban-board.js's test doctrine).
 */

import { describe, it, expect } from 'vitest';
import { computeAppMove, computeArrowMove, computeSectionArrowMove, computeSectionDrop } from './sidebar-dnd.js';

function group(sectionId, apps) {
  return { section_id: sectionId, apps };
}
function app(id, sortOrder) {
  return { id, sort_order: sortOrder };
}

describe('computeAppMove — reorder within the same group', () => {
  it('moves an app before another within its own section', () => {
    const groups = [group('s1', [app('a', 0), app('b', 1), app('c', 2)])];
    const patches = computeAppMove(groups, 'c', 's1', 'a');
    // c should now be first (sort_order 0), a becomes 1, b becomes 2
    const byId = Object.fromEntries(patches.map((p) => [p.id, p.sort_order]));
    expect(byId.c).toBe(0);
    expect(byId.a).toBe(1);
    expect(byId.b).toBe(2);
    // No section_id patch expected — same group.
    expect(patches.every((p) => !('section_id' in p))).toBe(true);
  });

  it('appending to the end (no beforeAppId) when unchanged is a no-op', () => {
    const groups = [group('s1', [app('a', 0), app('b', 1)])];
    const patches = computeAppMove(groups, 'b', 's1', null);
    expect(patches).toEqual([]);
  });
});

describe('computeAppMove — cross-group move', () => {
  it('moving an app to a different section sets section_id + fresh sort_order', () => {
    const groups = [
      group('s1', [app('a', 0), app('b', 1)]),
      group('s2', [app('c', 0)]),
    ];
    const patches = computeAppMove(groups, 'a', 's2', 'c');
    const forA = patches.find((p) => p.id === 'a');
    expect(forA.section_id).toBe('s2');
    expect(forA.sort_order).toBe(0);
    const forC = patches.find((p) => p.id === 'c');
    expect(forC.sort_order).toBe(1);
  });

  it('moving into «Без раздела» (section_id null) works', () => {
    const groups = [
      group('s1', [app('a', 0)]),
      group(null, [app('z', 0)]),
    ];
    const patches = computeAppMove(groups, 'a', null, null);
    const forA = patches.find((p) => p.id === 'a');
    expect(forA.section_id).toBe(null);
  });

  it('unknown target section → empty (no-op, never throws)', () => {
    const groups = [group('s1', [app('a', 0)])];
    expect(computeAppMove(groups, 'a', 'does-not-exist', null)).toEqual([]);
  });

  it('unknown dragged app id → empty', () => {
    const groups = [group('s1', [app('a', 0)])];
    expect(computeAppMove(groups, 'ghost', 's1', null)).toEqual([]);
  });
});

describe('computeArrowMove — ▲/▼ keyboard reorder', () => {
  it('swaps with the previous sibling (up)', () => {
    const apps = [app('a', 0), app('b', 1), app('c', 2)];
    const patches = computeArrowMove(apps, 'b', -1);
    expect(patches).toEqual([
      { id: 'b', sort_order: 0 },
      { id: 'a', sort_order: 1 },
    ]);
  });

  it('swaps with the next sibling (down)', () => {
    const apps = [app('a', 0), app('b', 1), app('c', 2)];
    const patches = computeArrowMove(apps, 'b', 1);
    expect(patches).toEqual([
      { id: 'b', sort_order: 2 },
      { id: 'c', sort_order: 1 },
    ]);
  });

  it('first item cannot move up (empty)', () => {
    const apps = [app('a', 0), app('b', 1)];
    expect(computeArrowMove(apps, 'a', -1)).toEqual([]);
  });

  it('last item cannot move down (empty)', () => {
    const apps = [app('a', 0), app('b', 1)];
    expect(computeArrowMove(apps, 'b', 1)).toEqual([]);
  });

  it('computeSectionArrowMove mirrors computeArrowMove exactly', () => {
    const sections = [app('s1', 0), app('s2', 1)];
    expect(computeSectionArrowMove(sections, 's1', 1)).toEqual(computeArrowMove(sections, 's1', 1));
  });
});

describe('computeSectionDrop — DnD reorder of sections', () => {
  it('moves a section before another, renumbering the range between', () => {
    const sections = [app('s1', 0), app('s2', 1), app('s3', 2)];
    const patches = computeSectionDrop(sections, 's3', 's1');
    const byId = Object.fromEntries(patches.map((p) => [p.id, p.sort_order]));
    expect(byId.s3).toBe(0);
    expect(byId.s1).toBe(1);
    expect(byId.s2).toBe(2);
  });

  it('dropping onto itself is a no-op', () => {
    const sections = [app('s1', 0), app('s2', 1)];
    expect(computeSectionDrop(sections, 's1', 's1')).toEqual([]);
  });

  it('unknown target → empty', () => {
    const sections = [app('s1', 0)];
    expect(computeSectionDrop(sections, 's1', 'ghost')).toEqual([]);
  });
});
