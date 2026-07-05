/**
 * web/src/app-shell/sidebar-app-menu.test.js — T-0651
 */

import { describe, it, expect, vi } from 'vitest';
import { buildSidebarAppMenuItems } from './sidebar-app-menu.js';

describe('buildSidebarAppMenuItems', () => {
  const app = { id: 'app-1', display_name: 'Заявки' };

  it('exposes exactly 3 items in the documented order (no delete/publish in the sidebar)', () => {
    const items = buildSidebarAppMenuItems(app, { openRename: vi.fn(), openSection: vi.fn(), navigate: vi.fn() });
    expect(items.map((i) => i.key)).toEqual(['rename', 'section', 'schema']);
    expect(items.map((i) => i.label)).toEqual(['Переименовать', 'В раздел →', 'Настроить поля']);
  });

  it('rename item calls actions.openRename', () => {
    const openRename = vi.fn();
    const items = buildSidebarAppMenuItems(app, { openRename, openSection: vi.fn(), navigate: vi.fn() });
    items.find((i) => i.key === 'rename').run();
    expect(openRename).toHaveBeenCalledTimes(1);
  });

  it('section item calls actions.openSection', () => {
    const openSection = vi.fn();
    const items = buildSidebarAppMenuItems(app, { openRename: vi.fn(), openSection, navigate: vi.fn() });
    items.find((i) => i.key === 'section').run();
    expect(openSection).toHaveBeenCalledTimes(1);
  });

  it('schema item navigates to /app-schema/:id', () => {
    const navigate = vi.fn();
    const items = buildSidebarAppMenuItems(app, { openRename: vi.fn(), openSection: vi.fn(), navigate });
    items.find((i) => i.key === 'schema').run();
    expect(navigate).toHaveBeenCalledWith('/app-schema/app-1');
  });
});
