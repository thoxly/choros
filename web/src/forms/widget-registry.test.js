/**
 * widget-registry.test.js (T-0544)
 *
 * The registry is the new FOUNDATION: the renderer, palette and inspector all
 * read it. These tests pin the FF-REG-1 / FF-COERCE-1 invariants:
 *   - the 10 built-in node types are present 1-to-1;
 *   - PALETTE / WIDGET_COMPAT derived in form-document.js match the old shape
 *     (behavioral no-op — importers keep working byte-identically);
 *   - the registry is closed-by-default (unknown id → undefined; dup → throws).
 */
import { describe, it, expect } from 'vitest';
import {
  getWidget, hasWidget, listWidgets, byPaletteGroup, manifest,
  register, paletteFromRegistry, WIDGET_COMPAT_TABLE,
} from './widget-registry.js';
import { PALETTE, WIDGET_COMPAT, paletteByGroup, isPaletteType, isClassBType } from './form-document.js';

const BUILTIN_IDS = [
  'section', 'columns', 'tabs', 'divider', 'text',
  'field', 'table', 'readout', 'relation', 'custom',
];

describe('widget-registry — built-in descriptors', () => {
  it('registers all 10 existing node types 1-to-1', () => {
    for (const id of BUILTIN_IDS) {
      expect(hasWidget(id)).toBe(true);
      expect(getWidget(id)).toBeTruthy();
      expect(getWidget(id).id).toBe(id);
    }
    expect(listWidgets()).toHaveLength(BUILTIN_IDS.length);
  });

  it('closed-by-default: unknown id → undefined', () => {
    expect(getWidget('nonsense')).toBeUndefined();
    expect(hasWidget('nonsense')).toBe(false);
  });

  it('rejects duplicate registration', () => {
    expect(() => register({ id: 'section' })).toThrow(/duplicate/);
  });

  it('every descriptor carries the manifest metadata', () => {
    for (const d of listWidgets()) {
      expect(typeof d.class).toBe('string');
      expect([1, 2]).toContain(d.floor);
      expect(typeof d.dataSource).toBe('string');
      expect(typeof d.paletteGroup).toBe('string');
      expect(typeof d.icon).toBe('string');
      expect(typeof d.label).toBe('string');
      expect(Array.isArray(d.editorProps)).toBe(true);
    }
  });

  it('manifest() is render-free (serializable)', () => {
    for (const m of manifest()) {
      expect(m).not.toHaveProperty('render');
      expect(m).not.toHaveProperty('validate');
    }
  });

  it('floor + class are correct for known cases', () => {
    expect(getWidget('custom').floor).toBe(2);
    expect(getWidget('custom').class).toBe('custom');
    expect(getWidget('section').floor).toBe(1);
    expect(getWidget('field').dataSource).toBe('current-record');
    expect(getWidget('field').contractKinds).toContain('scalar');
  });

  it('byPaletteGroup groups by human label in declared order', () => {
    const groups = byPaletteGroup();
    expect(Object.keys(groups)[0]).toBe('Раскладка');
    expect(groups['Раскладка'].map((d) => d.id)).toEqual(
      expect.arrayContaining(['section', 'columns', 'tabs', 'divider', 'text']),
    );
    expect(groups['Данные'].map((d) => d.id)).toEqual(
      expect.arrayContaining(['field', 'table', 'readout', 'relation']),
    );
    expect(groups['Код'].map((d) => d.id)).toEqual(['custom']);
  });
});

describe('form-document compat exports are DERIVED from the registry (no-op)', () => {
  it('PALETTE keeps the old shape per entry', () => {
    for (const id of BUILTIN_IDS) {
      expect(PALETTE[id]).toBeTruthy();
      expect(PALETTE[id].type).toBe(id);
      expect(['a', 'b']).toContain(PALETTE[id].floorClass);
      expect(typeof PALETTE[id].data).toBe('boolean');
      expect(['layout', 'data', 'code']).toContain(PALETTE[id].paletteGroup);
      expect(typeof PALETTE[id].label).toBe('string');
    }
    expect(PALETTE.custom.floorClass).toBe('b');
    expect(PALETTE.field.data).toBe(true);
    expect(PALETTE.field.contract).toBe('scalar');
    expect(PALETTE.table.contract).toBe('collection');
    expect(PALETTE.section.data).toBe(false);
  });

  it('isPaletteType / isClassBType still work on derived PALETTE', () => {
    expect(isPaletteType('field')).toBe(true);
    expect(isPaletteType('nope')).toBe(false);
    expect(isClassBType('custom')).toBe(true);
    expect(isClassBType('field')).toBe(false);
  });

  it('paletteByGroup keeps the legacy {layout,data,code} keys', () => {
    const g = paletteByGroup();
    expect(Object.keys(g).sort()).toEqual(['code', 'data', 'layout']);
    expect(g.data.map((e) => e.type)).toEqual(
      expect.arrayContaining(['field', 'table', 'readout', 'relation']),
    );
    expect(g.code.map((e) => e.type)).toEqual(['custom']);
  });

  it('WIDGET_COMPAT matches the registry compat table', () => {
    expect(WIDGET_COMPAT).toEqual(WIDGET_COMPAT_TABLE);
    expect(WIDGET_COMPAT.string).toEqual(['text', 'textarea', 'select']);
    expect(WIDGET_COMPAT.collection).toEqual(['table']);
    expect(WIDGET_COMPAT.computed).toEqual(['readout']);
  });

  it('paletteFromRegistry is deterministic across calls', () => {
    expect(paletteFromRegistry()).toEqual(paletteFromRegistry());
  });
});
