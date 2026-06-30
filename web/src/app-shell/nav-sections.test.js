/**
 * web/src/app-shell/nav-sections.test.js — T-0540
 *
 * Fitness-функции:
 *   FF-SECTIONS-FALLBACK:     null/missing section → попадает в fallback, не теряется.
 *   FF-SECTIONS-EMPTY-HIDDEN: groupAppsBySection([]) === []; нет секций-пустышек.
 *   FF-SECTIONS-FROM-DATA:    секции строятся из данных, не хардкода.
 *   Инвариант сохранности:   sum(result[].apps.length) === apps.length.
 */

import { describe, it, expect } from 'vitest';
import { groupAppsBySection, FALLBACK_SECTION_LABEL } from './nav-sections.js';

function makeApp(id, section) {
  return { id, slug: id, display_name: `App ${id}`, section: section ?? null };
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

describe('groupAppsBySection — FF-SECTIONS-FALLBACK', () => {
  it('приложение с section=null → попадает в fallback, не теряется', () => {
    const result = groupAppsBySection([makeApp('a', null)]);
    expect(result).toHaveLength(1);
    expect(result[0].fallback).toBe(true);
    expect(result[0].section).toBe(FALLBACK_SECTION_LABEL);
    expect(result[0].apps).toHaveLength(1);
    expect(result[0].apps[0].id).toBe('a');
  });

  it('приложение с section=undefined → попадает в fallback, не теряется', () => {
    const app = { id: 'u', slug: 'u', display_name: 'U' }; // нет поля section
    const result = groupAppsBySection([app]);
    expect(result[0].fallback).toBe(true);
    expect(result[0].apps[0].id).toBe('u');
  });

  it('приложение с section="" → попадает в fallback (пустая строка = не задан)', () => {
    const result = groupAppsBySection([makeApp('e', '')]);
    expect(result[0].fallback).toBe(true);
  });

  it('все приложения null → одна fallback-секция со всеми', () => {
    const apps = [makeApp('a', null), makeApp('b', null), makeApp('c', null)];
    const result = groupAppsBySection(apps);
    expect(result).toHaveLength(1);
    expect(result[0].fallback).toBe(true);
    expect(result[0].apps).toHaveLength(3);
  });
});

describe('groupAppsBySection — FF-SECTIONS-FROM-DATA', () => {
  it('именованные секции строятся из данных app.section', () => {
    const apps = [makeApp('a', 'Финансы'), makeApp('b', 'HR')];
    const result = groupAppsBySection(apps);
    const sections = result.map((s) => s.section);
    expect(sections).toContain('Финансы');
    expect(sections).toContain('HR');
  });

  it('именованные секции — алфавитный порядок (ru)', () => {
    const apps = [
      makeApp('1', 'Продажи'),
      makeApp('2', 'Финансы'),
      makeApp('3', 'HR'),
    ];
    const result = groupAppsBySection(apps);
    const named = result.filter((s) => !s.fallback).map((s) => s.section);
    // Алфавитный порядок ru: HR < Продажи < Финансы (латиница раньше кириллицы)
    expect(named).toEqual([...named].sort((a, b) => a.localeCompare(b, 'ru')));
  });

  it('fallback-секция — всегда последняя', () => {
    const apps = [makeApp('a', 'Финансы'), makeApp('b', null)];
    const result = groupAppsBySection(apps);
    expect(result[result.length - 1].fallback).toBe(true);
  });

  it('именованная секция с одним приложением рендерится (нет правила ≥2)', () => {
    const result = groupAppsBySection([makeApp('a', 'Закупки')]);
    expect(result).toHaveLength(1);
    expect(result[0].fallback).toBe(false);
    expect(result[0].apps).toHaveLength(1);
  });
});

describe('groupAppsBySection — инвариант сохранности', () => {
  it('sum(result[].apps.length) === apps.length (нет потерь, нет дублей)', () => {
    const apps = [
      makeApp('a', 'Финансы'),
      makeApp('b', null),
      makeApp('c', 'HR'),
      makeApp('d', null),
      makeApp('e', 'Финансы'),
    ];
    const result = groupAppsBySection(apps);
    const total = result.reduce((acc, s) => acc + s.apps.length, 0);
    expect(total).toBe(apps.length);
  });

  it('каждое приложение встречается ровно один раз', () => {
    const apps = [
      makeApp('a', 'Финансы'),
      makeApp('b', null),
      makeApp('c', 'HR'),
    ];
    const result = groupAppsBySection(apps);
    const allIds = result.flatMap((s) => s.apps.map((a) => a.id));
    expect(allIds).toHaveLength(apps.length);
    expect(new Set(allIds).size).toBe(apps.length);
  });

  it('fallback=false для именованных секций', () => {
    const result = groupAppsBySection([makeApp('a', 'Финансы')]);
    expect(result[0].fallback).toBe(false);
  });
});
