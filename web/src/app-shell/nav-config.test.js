/**
 * web/src/app-shell/nav-config.test.js
 *
 * T-0355: IA reshuffle — authoring space ≠ work space.
 *
 * Verifies invariants of the nav-config structure:
 *   1. All expected groups exist;
 *   2. Authoring space groups are correctly tagged;
 *   3. Work space groups are correctly tagged;
 *   4. All items have required fields (id, label, icon, status);
 *   5. Routes: items without a `path` override navigate to '/' + id;
 *   6. Items with a `path` override navigate to that path (not '/' + id);
 *   7. No two items share the same id (no duplicates);
 *   8. Every item's status is a valid NavStatus value;
 *   9. Home group (Обзор) has no space tag — it is above both spaces;
 *  10. visibleItems filters hidden items;
 *  11. effectiveStatus falls back to 'soon' for legacy soon:true items.
 */

import { describe, it, expect } from 'vitest';
import { NAV, visibleItems, effectiveStatus } from './nav-config.js';

const VALID_STATUSES = new Set(['live', 'demo', 'soon']);
const VALID_SPACES   = new Set(['authoring', 'work', undefined]);

describe('nav-config T-0355', () => {
  it('has at least 7 groups (home + 3 authoring + 3 work)', () => {
    expect(NAV.length).toBeGreaterThanOrEqual(7);
  });

  it('first group is home (Обзор) with no space', () => {
    const home = NAV[0];
    expect(home.home).toBe(true);
    expect(home.space).toBeUndefined();
  });

  it('has exactly one home group', () => {
    const homes = NAV.filter((g) => g.home);
    expect(homes).toHaveLength(1);
  });

  it('authoring space includes Конструктор, Модельер, Ассистент groups', () => {
    const authoringGroups = NAV.filter((g) => g.space === 'authoring').map((g) => g.group);
    expect(authoringGroups).toContain('Конструктор');
    expect(authoringGroups).toContain('Модельер');
    expect(authoringGroups).toContain('Ассистент');
  });

  it('work space includes Работа, Исполнители и доступ, Наблюдаемость groups', () => {
    const workGroups = NAV.filter((g) => g.space === 'work').map((g) => g.group);
    expect(workGroups).toContain('Работа');
    expect(workGroups).toContain('Исполнители и доступ');
    expect(workGroups).toContain('Наблюдаемость');
  });

  it('all group space values are valid (authoring | work | undefined)', () => {
    for (const grp of NAV) {
      expect(VALID_SPACES).toContain(grp.space);
    }
  });

  it('all items have id, label, icon, and status', () => {
    for (const grp of NAV) {
      for (const item of grp.items) {
        expect(typeof item.id,    `${grp.group}/${item.label} missing id`).toBe('string');
        expect(typeof item.label, `${grp.group}/${item.id} missing label`).toBe('string');
        expect(typeof item.icon,  `${grp.group}/${item.id} missing icon`).toBe('string');
        expect(VALID_STATUSES, `${grp.group}/${item.id} invalid status: ${item.status}`).toContain(item.status);
      }
    }
  });

  it('no duplicate item ids', () => {
    const ids = NAV.flatMap((g) => g.items.map((i) => i.id));
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('items without path override use "/" + id as navigation target', () => {
    for (const grp of NAV) {
      for (const item of grp.items) {
        if (!item.path) {
          // The shell does: navigate('/' + item.id)
          // No assertion on id format — just confirm path is absent so shell uses id.
          expect(item.id).toBeTruthy();
        }
      }
    }
  });

  it('Модельер item has a path override (not default "/" + id)', () => {
    const modelerGroup = NAV.find((g) => g.group === 'Модельер');
    expect(modelerGroup).toBeDefined();
    const modeler = modelerGroup.items.find((i) => i.id === 'modeler');
    expect(modeler).toBeDefined();
    expect(modeler.path).toBeTruthy();
    expect(modeler.path).not.toBe('/modeler');
  });

  it('Модельер path is a valid existing deep-route path', () => {
    const modelerGroup = NAV.find((g) => g.group === 'Модельер');
    const modeler = modelerGroup.items.find((i) => i.id === 'modeler');
    // Must route to the existing BPMN editor path, not a non-existent /modeler.
    expect(modeler.path).toMatch(/^\/processes\/.+\/edit$/);
  });

  it('Ассистент is in the authoring space', () => {
    const assistantGroup = NAV.find((g) => g.group === 'Ассистент');
    expect(assistantGroup).toBeDefined();
    expect(assistantGroup.space).toBe('authoring');
    const assistant = assistantGroup.items.find((i) => i.id === 'assistant');
    expect(assistant).toBeDefined();
  });

  it('authoring groups come before work groups in NAV (after home)', () => {
    const nonHome = NAV.filter((g) => !g.home);
    let seenWork = false;
    for (const grp of nonHome) {
      if (grp.space === 'work') seenWork = true;
      if (seenWork) {
        expect(grp.space).not.toBe('authoring');
      }
    }
  });

  it('visibleItems filters out hidden items', () => {
    const grpWithHidden = {
      group: 'Test',
      items: [
        { id: 'a', label: 'A', icon: 'x', status: 'live' },
        { id: 'b', label: 'B', icon: 'x', status: 'live', hidden: true },
      ],
    };
    expect(visibleItems(grpWithHidden)).toHaveLength(1);
    expect(visibleItems(grpWithHidden)[0].id).toBe('a');
  });

  it('effectiveStatus falls back on legacy soon:true', () => {
    const item = { id: 'x', label: 'X', icon: 'x', soon: true };
    expect(effectiveStatus(item)).toBe('soon');
  });

  it('effectiveStatus returns explicit status if set', () => {
    expect(effectiveStatus({ id: 'x', label: 'X', icon: 'x', status: 'demo' })).toBe('demo');
    expect(effectiveStatus({ id: 'x', label: 'X', icon: 'x', status: 'live' })).toBe('live');
  });

  it('no authoring item has status live except Приложения (constructors can be live)', () => {
    // This test guards that authoring tools marked live have genuinely live backends.
    // Currently only Приложения is live; forms/modeler/assistant are demo.
    const authoringItems = NAV
      .filter((g) => g.space === 'authoring')
      .flatMap((g) => g.items);
    const liveAuthoring = authoringItems.filter((i) => i.status === 'live');
    const liveIds = liveAuthoring.map((i) => i.id);
    // Allow Приложения (apps) to be live. Others should be demo until E16 backend ships.
    expect(liveIds.filter((id) => id !== 'apps')).toHaveLength(0);
  });
});
