/**
 * web/src/app-shell/nav-sections.test.js — T-0551 (РЕВЕРС T-0540)
 *
 * Fitness-функции:
 *   FF-SECTIONS-NOSECTION:    section_id=null/missing → группа «Без раздела», не теряется.
 *   FF-SECTIONS-EMPTY-HIDDEN: groupAppsBySection([]) === []; нет групп-пустышек.
 *   FF-SECTIONS-FROM-ENTITY:  группы строятся из section_id + section_name (сущность).
 *   FF-SECTIONS-ORDER:        порядок из sort_order разделов (ties → name).
 *   Инвариант сохранности:   sum(result[].apps.length) === apps.length.
 */

import { describe, it, expect } from 'vitest';
import { groupAppsBySection, NO_SECTION_LABEL } from './nav-sections.js';

function makeApp(id, sectionId, sectionName) {
  return {
    id, slug: id, display_name: `App ${id}`,
    section_id: sectionId ?? null,
    section_name: sectionName ?? null,
  };
}

describe('groupAppsBySection — FF-SECTIONS-EMPTY-HIDDEN', () => {
  it('пустой массив → пустой результат', () => {
    expect(groupAppsBySection([])).toEqual([]);
  });
  it('null → пустой результат', () => {
    expect(groupAppsBySection(null)).toEqual([]);
  });
  it('undefined → пустой результат', () => {
    expect(groupAppsBySection(undefined)).toEqual([]);
  });
});

describe('groupAppsBySection — FF-SECTIONS-NOSECTION', () => {
  it('приложение с section_id=null → «Без раздела», не теряется', () => {
    const result = groupAppsBySection([makeApp('a', null)]);
    expect(result).toHaveLength(1);
    expect(result[0].fallback).toBe(true);
    expect(result[0].section).toBe(NO_SECTION_LABEL);
    expect(result[0].section_id).toBe(null);
    expect(result[0].apps).toHaveLength(1);
    expect(result[0].apps[0].id).toBe('a');
  });

  it('приложение без поля section_id → «Без раздела», не теряется', () => {
    const app = { id: 'u', slug: 'u', display_name: 'U' };
    const result = groupAppsBySection([app]);
    expect(result[0].fallback).toBe(true);
    expect(result[0].apps[0].id).toBe('u');
  });

  it('все приложения без раздела → одна группа «Без раздела»', () => {
    const apps = [makeApp('a', null), makeApp('b', null), makeApp('c', null)];
    const result = groupAppsBySection(apps);
    expect(result).toHaveLength(1);
    expect(result[0].fallback).toBe(true);
    expect(result[0].apps).toHaveLength(3);
  });
});

describe('groupAppsBySection — FF-SECTIONS-FROM-ENTITY', () => {
  it('группы строятся из section_id; заголовок из section_name', () => {
    const apps = [
      makeApp('a', 's-fin', 'Финансы'),
      makeApp('b', 's-hr', 'HR'),
    ];
    const result = groupAppsBySection(apps);
    const names = result.map((s) => s.section);
    expect(names).toContain('Финансы');
    expect(names).toContain('HR');
    const fin = result.find((s) => s.section === 'Финансы');
    expect(fin.section_id).toBe('s-fin');
  });

  it('два приложения одного раздела → одна группа', () => {
    const apps = [makeApp('a', 's-fin', 'Финансы'), makeApp('b', 's-fin', 'Финансы')];
    const result = groupAppsBySection(apps);
    const named = result.filter((s) => !s.fallback);
    expect(named).toHaveLength(1);
    expect(named[0].apps).toHaveLength(2);
  });

  it('«Без раздела» — всегда последняя', () => {
    const apps = [makeApp('a', 's-fin', 'Финансы'), makeApp('b', null)];
    const result = groupAppsBySection(apps);
    expect(result[result.length - 1].fallback).toBe(true);
  });
});

describe('groupAppsBySection — FF-SECTIONS-ORDER', () => {
  it('порядок групп из sort_order разделов', () => {
    const apps = [
      makeApp('a', 's-1', 'Альфа'),
      makeApp('b', 's-2', 'Бета'),
      makeApp('c', 's-3', 'Гамма'),
    ];
    const sections = [
      { id: 's-1', name: 'Альфа', sort_order: 30 },
      { id: 's-2', name: 'Бета', sort_order: 10 },
      { id: 's-3', name: 'Гамма', sort_order: 20 },
    ];
    const result = groupAppsBySection(apps, sections).filter((s) => !s.fallback);
    expect(result.map((s) => s.section)).toEqual(['Бета', 'Гамма', 'Альфа']);
  });

  it('ties в sort_order → по name (ru)', () => {
    const apps = [makeApp('a', 's-1', 'Продажи'), makeApp('b', 's-2', 'Финансы')];
    const sections = [
      { id: 's-1', name: 'Продажи', sort_order: 0 },
      { id: 's-2', name: 'Финансы', sort_order: 0 },
    ];
    const result = groupAppsBySection(apps, sections).filter((s) => !s.fallback);
    expect(result.map((s) => s.section)).toEqual(['Продажи', 'Финансы']);
  });

  it('без переданных разделов → порядок по name (ru-локаль)', () => {
    const apps = [makeApp('a', 's-1', 'Бета'), makeApp('b', 's-2', 'Альфа')];
    const result = groupAppsBySection(apps).filter((s) => !s.fallback);
    expect(result.map((s) => s.section)).toEqual(['Альфа', 'Бета']);
  });
});

describe('groupAppsBySection — инвариант сохранности', () => {
  it('sum(result[].apps.length) === apps.length', () => {
    const apps = [
      makeApp('a', 's-fin', 'Финансы'),
      makeApp('b', null),
      makeApp('c', 's-hr', 'HR'),
      makeApp('d', null),
      makeApp('e', 's-fin', 'Финансы'),
    ];
    const result = groupAppsBySection(apps);
    const total = result.reduce((acc, s) => acc + s.apps.length, 0);
    expect(total).toBe(apps.length);
  });

  it('каждое приложение встречается ровно один раз', () => {
    const apps = [
      makeApp('a', 's-fin', 'Финансы'),
      makeApp('b', null),
      makeApp('c', 's-hr', 'HR'),
    ];
    const result = groupAppsBySection(apps);
    const allIds = result.flatMap((s) => s.apps.map((a) => a.id));
    expect(allIds).toHaveLength(apps.length);
    expect(new Set(allIds).size).toBe(apps.length);
  });
});
