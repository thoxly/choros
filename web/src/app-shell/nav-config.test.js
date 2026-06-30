/**
 * web/src/app-shell/nav-config.test.js
 *
 * T-0538 (NAV-IA / Ф1): 4-zone nav rezoning.
 * Verifies invariants of the new nav-config structure:
 *   1. NAV_HOME exists and has no zone (above zones);
 *   2. ZONES has exactly 4 zones in correct order;
 *   3. All 19 original ids are present (FF-NAV-MAP);
 *   4. No duplicate item ids (including 'reference' as intentional addition);
 *   5. All items have required fields (id, label, icon, status, zone, audience, capability, frequency, order);
 *   6. All item status values are valid NavStatus;
 *   7. Capability is null for all items (задел под T-0539, filter not implemented);
 *   8. WORK zone has no sys/admin items (FF-NAV-NOSYS);
 *   9. Модельер has path override, not '/modeler';
 *  10. forms item exists but is hidden (T-0482);
 *  11. visibleItems filters hidden items;
 *  12. effectiveStatus falls back to 'soon' for legacy soon:true items;
 *  13. NAV (compat export) iterates all items for palette (no losses);
 *  14. paletteDestinations-compatible: screen items accessible via NAV;
 *  15. reference item has path=/rights/criticality (existing route);
 *  16. ZONES order: work(1) · constructor(2) · observability(3) · admin(4).
 */

import { describe, it, expect } from 'vitest';
import { NAV, NAV_HOME, ZONES, visibleItems, effectiveStatus } from './nav-config.js';

const VALID_STATUSES  = new Set(['live', 'demo', 'soon']);
const VALID_ZONES     = new Set(['work', 'constructor', 'observability', 'admin', null]);
const VALID_AUDIENCES = new Set(['end-user', 'builder', 'manager', 'admin']);
const VALID_FREQS     = new Set(['daily', 'weekly', 'rare']);

// All 19 original item ids (overview through assistant-prompt).
const ORIGINAL_IDS = new Set([
  'overview', 'apps', 'forms', 'modeler', 'assistant',
  'inbox', 'processes', 'org', 'agents', 'rights',
  'ops-overview', 'notifications', 'audit', 'spend', 'reports', 'process-analytics',
  'llm-connections', 'llm-config', 'assistant-prompt',
]);
// FF-NAV-MAP also accepts 'reference' as the intentional new grouping entry-point.
const ALLOWED_NEW_IDS = new Set(['reference']);

// Systems/admin ids that must NOT appear in zone='work' (FF-NAV-NOSYS).
const NOSYS_IDS = new Set([
  'org', 'agents', 'rights', 'reference',
  'llm-connections', 'llm-config', 'assistant-prompt',
  'audit', 'spend',
]);

describe('nav-config T-0538: 4-zone IA', () => {

  // ── NAV_HOME ──────────────────────────────────────────────────────────────

  it('NAV_HOME exists and has no zone (above zones)', () => {
    expect(NAV_HOME).toBeDefined();
    expect(NAV_HOME.id).toBe('overview');
    expect(NAV_HOME.zone).toBeNull();
  });

  it('NAV_HOME has all required fields', () => {
    expect(typeof NAV_HOME.label).toBe('string');
    expect(typeof NAV_HOME.icon).toBe('string');
    expect(VALID_STATUSES).toContain(NAV_HOME.status);
    expect(NAV_HOME.capability).toBeNull();
  });

  // ── ZONES ─────────────────────────────────────────────────────────────────

  it('ZONES has exactly 4 zones', () => {
    expect(ZONES).toHaveLength(4);
  });

  it('ZONES are in correct order (work·constructor·observability·admin)', () => {
    expect(ZONES.map((z) => z.id)).toEqual(['work', 'constructor', 'observability', 'admin']);
    expect(ZONES.map((z) => z.order)).toEqual([1, 2, 3, 4]);
  });

  it('ZONES have correct human-readable labels', () => {
    const labels = ZONES.map((z) => z.label);
    expect(labels).toContain('Работа');
    expect(labels).toContain('Конструктор');
    expect(labels).toContain('Наблюдаемость');
    expect(labels).toContain('Администрирование');
  });

  // ── All items ─────────────────────────────────────────────────────────────

  function allItems() {
    return [NAV_HOME, ...ZONES.flatMap((z) => z.items)];
  }

  it('all items have required fields (id, label, icon, status, zone, audience, capability, frequency, order)', () => {
    for (const item of allItems()) {
      expect(typeof item.id,        `${item.id} missing id`).toBe('string');
      expect(typeof item.label,     `${item.id} missing label`).toBe('string');
      expect(typeof item.icon,      `${item.id} missing icon`).toBe('string');
      expect(VALID_STATUSES,        `${item.id} invalid status: ${item.status}`).toContain(item.status);
      expect(VALID_ZONES,           `${item.id} invalid zone: ${item.zone}`).toContain(item.zone);
      expect(VALID_AUDIENCES,       `${item.id} invalid audience: ${item.audience}`).toContain(item.audience);
      expect(VALID_FREQS,           `${item.id} invalid frequency: ${item.frequency}`).toContain(item.frequency);
      expect(typeof item.order,     `${item.id} missing order`).toBe('number');
    }
  });

  it('FF-NAV-MAP: all 19 original ids present, no unexpected new ids', () => {
    const ids = new Set(allItems().map((i) => i.id));
    for (const expected of ORIGINAL_IDS) {
      expect(ids, `Missing original id: ${expected}`).toContain(expected);
    }
    const unexpected = [...ids].filter((id) => !ORIGINAL_IDS.has(id) && !ALLOWED_NEW_IDS.has(id));
    expect(unexpected, `Unexpected new ids: ${unexpected}`).toHaveLength(0);
  });

  it('no duplicate item ids', () => {
    const ids = allItems().map((i) => i.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  // T-0539: capability values are now SET (not null for non-work/non-home zones).
  // ADR §4.2: null ONLY allowed for zone:'work' and home (zone:null).
  it('T-0539: work/home items have capability:null; non-work zones have non-null capability', () => {
    for (const item of allItems()) {
      if (item.zone === null || item.zone === 'work') {
        expect(item.capability, `${item.id} (zone:${item.zone}) must have capability:null`).toBeNull();
      } else {
        expect(item.capability, `${item.id} (zone:${item.zone}) must have non-null capability`).not.toBeNull();
        expect(typeof item.capability, `${item.id} capability must be string`).toBe('string');
      }
    }
  });

  it('all zone items have zone matching their parent zone id', () => {
    for (const zone of ZONES) {
      for (const item of zone.items) {
        expect(item.zone, `${item.id} zone mismatch`).toBe(zone.id);
      }
    }
  });

  // ── FF-NAV-NOSYS ──────────────────────────────────────────────────────────

  it('FF-NAV-NOSYS: WORK zone has no system/admin items', () => {
    const workZone = ZONES.find((z) => z.id === 'work');
    expect(workZone).toBeDefined();
    for (const item of workZone.items) {
      expect(NOSYS_IDS, `System item ${item.id} must not be in WORK zone`).not.toContain(item.id);
    }
  });

  // ── Zone-specific checks ──────────────────────────────────────────────────

  it('WORK zone contains inbox and processes', () => {
    const workZone = ZONES.find((z) => z.id === 'work');
    const ids = workZone.items.map((i) => i.id);
    expect(ids).toContain('inbox');
    expect(ids).toContain('processes');
  });

  it('CONSTRUCTOR zone contains apps, forms(hidden), modeler, assistant', () => {
    const cz = ZONES.find((z) => z.id === 'constructor');
    const ids = cz.items.map((i) => i.id);
    expect(ids).toContain('apps');
    expect(ids).toContain('forms');
    expect(ids).toContain('modeler');
    expect(ids).toContain('assistant');
  });

  it('OBSERVABILITY zone contains ops-overview, reports, process-analytics, audit, spend, notifications', () => {
    const oz = ZONES.find((z) => z.id === 'observability');
    const ids = oz.items.map((i) => i.id);
    for (const id of ['ops-overview', 'reports', 'process-analytics', 'audit', 'spend', 'notifications']) {
      expect(ids, `Missing ${id} in observability zone`).toContain(id);
    }
  });

  it('ADMIN zone contains org, agents, rights, reference, llm-connections, llm-config, assistant-prompt', () => {
    const az = ZONES.find((z) => z.id === 'admin');
    const ids = az.items.map((i) => i.id);
    for (const id of ['org', 'agents', 'rights', 'reference', 'llm-connections', 'llm-config', 'assistant-prompt']) {
      expect(ids, `Missing ${id} in admin zone`).toContain(id);
    }
  });

  it('ADMIN items have subgroup field', () => {
    const az = ZONES.find((z) => z.id === 'admin');
    for (const item of az.items) {
      expect(typeof item.subgroup, `${item.id} missing subgroup`).toBe('string');
    }
  });

  // ── Конкретные инварианты пунктов ─────────────────────────────────────────

  it('forms item is hidden (T-0482)', () => {
    const cz = ZONES.find((z) => z.id === 'constructor');
    const formsItem = cz.items.find((i) => i.id === 'forms');
    expect(formsItem).toBeDefined();
    expect(formsItem.hidden).toBe(true);
  });

  it('forms is filtered by visibleItems', () => {
    const cz = ZONES.find((z) => z.id === 'constructor');
    const visible = visibleItems(cz);
    expect(visible.map((i) => i.id)).not.toContain('forms');
  });

  it('modeler has path override (not /modeler)', () => {
    const cz = ZONES.find((z) => z.id === 'constructor');
    const modeler = cz.items.find((i) => i.id === 'modeler');
    expect(modeler).toBeDefined();
    expect(modeler.path).toBeTruthy();
    expect(modeler.path).not.toBe('/modeler');
    expect(modeler.path).toMatch(/^\/processes\/.+\/edit$/);
  });

  it('reference item has path=/rights/criticality (existing route)', () => {
    const az = ZONES.find((z) => z.id === 'admin');
    const ref = az.items.find((i) => i.id === 'reference');
    expect(ref).toBeDefined();
    expect(ref.path).toBe('/rights/criticality');
  });

  it('rights item (Доступ) has no path override (navigates to /rights)', () => {
    const az = ZONES.find((z) => z.id === 'admin');
    const rights = az.items.find((i) => i.id === 'rights');
    expect(rights).toBeDefined();
    expect(rights.path).toBeUndefined();
    expect(rights.label).toBe('Доступ');
  });

  // ── Utility functions ─────────────────────────────────────────────────────

  it('visibleItems filters hidden items', () => {
    const fake = {
      items: [
        { id: 'a', label: 'A', icon: 'x', status: 'live' },
        { id: 'b', label: 'B', icon: 'x', status: 'live', hidden: true },
      ],
    };
    expect(visibleItems(fake)).toHaveLength(1);
    expect(visibleItems(fake)[0].id).toBe('a');
  });

  it('effectiveStatus falls back on legacy soon:true', () => {
    expect(effectiveStatus({ id: 'x', label: 'X', icon: 'x', soon: true })).toBe('soon');
  });

  it('effectiveStatus returns explicit status if set', () => {
    expect(effectiveStatus({ id: 'x', label: 'X', icon: 'x', status: 'demo' })).toBe('demo');
    expect(effectiveStatus({ id: 'x', label: 'X', icon: 'x', status: 'live' })).toBe('live');
  });

  // ── NAV compat export (CommandPalette) ────────────────────────────────────

  it('NAV compat export has home group first + 4 zone groups = 5 total', () => {
    expect(NAV).toHaveLength(5);
    expect(NAV[0].home).toBe(true);
    expect(NAV[0].group).toBe('Обзор');
  });

  it('NAV compat: all ZONES items reachable via NAV.flatMap(g => g.items)', () => {
    const navIds = new Set(NAV.flatMap((g) => g.items.map((i) => i.id)));
    for (const zone of ZONES) {
      for (const item of zone.items) {
        expect(navIds, `${item.id} not in NAV compat export`).toContain(item.id);
      }
    }
    expect(navIds).toContain('overview');
  });
});
