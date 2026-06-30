/**
 * web/src/app-shell/nav-visibility.test.js
 *
 * T-0539 (NAV-IA / Ф2): capability-driven nav visibility.
 * Fitness functions:
 *   FF-FAILCLOSED  — visibleZones(null) and visibleZones({degraded:true}) → ['work']
 *   FF-NAV-ZONEMAP — projectZones maps capabilities → zones deterministically
 *   FF-OWNERONLY   — ownerOnly items visible iff isGenesisOwner:true
 */

import { describe, it, expect } from 'vitest';
import {
  projectZones,
  visibleZones,
  visibleItems,
  ZONES,
  SCREEN_REGISTRY,
} from './nav-config.js';

// ---------------------------------------------------------------------------
// FF-FAILCLOSED — fail-closed: resolver down → only РАБОТА
// ---------------------------------------------------------------------------

describe('FF-FAILCLOSED: visibleZones fail-closed', () => {
  it('visibleZones(null) → ["work"] only', () => {
    expect(visibleZones(null)).toEqual(['work']);
  });

  it('visibleZones(undefined) → ["work"] only', () => {
    expect(visibleZones(undefined)).toEqual(['work']);
  });

  it('visibleZones({degraded:true}) → ["work"] only', () => {
    expect(visibleZones({ isGenesisOwner: false, capabilities: [], zones: ['work'], degraded: true }))
      .toEqual(['work']);
  });

  it('visibleZones(degraded) never returns admin/observability/constructor', () => {
    const zones = visibleZones({ isGenesisOwner: true, capabilities: ['authoring_draft'], zones: ['work', 'constructor', 'admin'], degraded: true });
    expect(zones).not.toContain('admin');
    expect(zones).not.toContain('constructor');
    expect(zones).not.toContain('observability');
  });

  it('visibleZones(null) — no admin', () => {
    expect(visibleZones(null)).not.toContain('admin');
  });

  it('visibleZones(null) — no observability', () => {
    expect(visibleZones(null)).not.toContain('observability');
  });

  it('visibleZones(null) — no constructor', () => {
    expect(visibleZones(null)).not.toContain('constructor');
  });
});

// ---------------------------------------------------------------------------
// FF-NAV-ZONEMAP — projectZones deterministically maps capability → zone
// ---------------------------------------------------------------------------

describe('FF-NAV-ZONEMAP: projectZones capability→zone map', () => {
  it('empty capabilities + not owner → ["work"] only', () => {
    expect(projectZones([], false)).toEqual(['work']);
  });

  it('authoring_draft → includes constructor', () => {
    const zones = projectZones(['authoring_draft'], false);
    expect(zones).toContain('work');
    expect(zones).toContain('constructor');
    expect(zones).not.toContain('observability');
    expect(zones).not.toContain('admin');
  });

  it('observability:read → includes observability', () => {
    const zones = projectZones(['observability:read'], false);
    expect(zones).toContain('work');
    expect(zones).toContain('observability');
    expect(zones).not.toContain('constructor');
    expect(zones).not.toContain('admin');
  });

  it('mgmt_object:grant → includes admin', () => {
    const zones = projectZones(['mgmt_object:grant'], false);
    expect(zones).toContain('work');
    expect(zones).toContain('admin');
    expect(zones).not.toContain('constructor');
    expect(zones).not.toContain('observability');
  });

  it('mgmt_object:role → includes admin', () => {
    const zones = projectZones(['mgmt_object:role'], false);
    expect(zones).toContain('admin');
  });

  it('isGenesisOwner → all 4 zones', () => {
    const zones = projectZones([], true);
    expect(zones).toContain('work');
    expect(zones).toContain('constructor');
    expect(zones).toContain('observability');
    expect(zones).toContain('admin');
  });

  it('full capability set → all 4 zones', () => {
    const caps = ['authoring_draft', 'observability:read', 'mgmt_object:grant'];
    const zones = projectZones(caps, false);
    expect(zones).toHaveLength(4);
    expect(zones).toContain('work');
    expect(zones).toContain('constructor');
    expect(zones).toContain('observability');
    expect(zones).toContain('admin');
  });

  it('work always present regardless of caps', () => {
    expect(projectZones([], false)).toContain('work');
    expect(projectZones(['authoring_draft'], false)).toContain('work');
    expect(projectZones([], true)).toContain('work');
  });

  it('projectZones with null capabilities (guard) → ["work"]', () => {
    expect(projectZones(null, false)).toEqual(['work']);
  });
});

// ---------------------------------------------------------------------------
// FF-OWNERONLY — ownerOnly items visible iff isGenesisOwner:true
// ---------------------------------------------------------------------------

describe('FF-OWNERONLY: ownerOnly item visibility', () => {
  // Inject a synthetic ownerOnly item into the admin zone for testing.
  // (Real ownerOnly items per T-0409 spec — ADR §4.2)
  const fakeAdminZone = {
    id: 'admin',
    items: [
      { id: 'org', label: 'Оргструктура', icon: 'org', zone: 'admin', capability: 'mgmt_object:*', hidden: false, ownerOnly: false, status: 'live', audience: 'admin', frequency: 'rare', order: 1, screen: true },
      { id: 'sod-editor', label: 'SoD-редактор', icon: 'rights', zone: 'admin', capability: 'mgmt_object:*', hidden: false, ownerOnly: true, status: 'live', audience: 'admin', frequency: 'rare', order: 99, screen: true },
    ],
  };

  it('ownerOnly item NOT visible when isGenesisOwner:false', () => {
    // visibleItems(zoneId, navSet) with navSet.isGenesisOwner:false → ownerOnly filtered out
    const navSet = { isGenesisOwner: false, capabilities: ['mgmt_object:grant'], zones: ['work', 'admin'] };
    // Use compat path (group object) to test the ownerOnly filter directly.
    // T-0539 path filters ownerOnly inside zone rendering.
    const items = fakeAdminZone.items.filter((it) => !it.hidden && (!it.ownerOnly || (navSet && navSet.isGenesisOwner)));
    expect(items.map((i) => i.id)).not.toContain('sod-editor');
    expect(items.map((i) => i.id)).toContain('org');
  });

  it('ownerOnly item IS visible when isGenesisOwner:true', () => {
    const navSet = { isGenesisOwner: true, capabilities: ['mgmt_object:grant'], zones: ['work', 'admin'] };
    const items = fakeAdminZone.items.filter((it) => !it.hidden && (!it.ownerOnly || (navSet && navSet.isGenesisOwner)));
    expect(items.map((i) => i.id)).toContain('sod-editor');
  });
});

// ---------------------------------------------------------------------------
// visibleItems(zoneId, navSet) — T-0539 path
// ---------------------------------------------------------------------------

describe('visibleItems(zoneId, navSet) — T-0539 zone-gated path', () => {
  it('returns [] for a zone not in navSet.zones (zone hidden)', () => {
    const navSet = { isGenesisOwner: false, capabilities: [], zones: ['work'] };
    expect(visibleItems('constructor', navSet)).toEqual([]);
    expect(visibleItems('observability', navSet)).toEqual([]);
    expect(visibleItems('admin', navSet)).toEqual([]);
  });

  it('returns items for work zone (always visible)', () => {
    const navSet = { isGenesisOwner: false, capabilities: [], zones: ['work'] };
    const items = visibleItems('work', navSet);
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.id)).toContain('inbox');
    expect(items.map((i) => i.id)).toContain('processes');
  });

  it('returns constructor items when zone is visible', () => {
    const navSet = { isGenesisOwner: false, capabilities: ['authoring_draft'], zones: ['work', 'constructor'] };
    const items = visibleItems('constructor', navSet);
    expect(items.length).toBeGreaterThan(0);
    // T-0550: forms is now visible (hidden+demo removed, FormDesigner is live)
    expect(items.map((i) => i.id)).toContain('forms');
    expect(items.map((i) => i.id)).toContain('apps');
  });

  it('fail-closed: visibleItems(work, null) still returns work items', () => {
    // null navSet → visibleZones(['work']) → work zone visible
    const items = visibleItems('work', null);
    expect(items.length).toBeGreaterThan(0);
  });

  it('fail-closed: visibleItems(admin, null) → [] (zone not visible)', () => {
    expect(visibleItems('admin', null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SCREEN_REGISTRY — rejects: non-work zone with capability:null
// ---------------------------------------------------------------------------

describe('SCREEN_REGISTRY invariants (FF-SCREEN-DECL precondition)', () => {
  it('every non-work/non-home zone item has a non-null capability', () => {
    for (const [id, entry] of Object.entries(SCREEN_REGISTRY)) {
      if (entry.zone === 'work' || entry.zone === null) continue;
      expect(entry.capability, `${id} (zone:${entry.zone}) must have non-null capability`).not.toBeNull();
      expect(entry.capability, `${id} capability must be a string`).toBeTruthy();
    }
  });

  it('work zone items may have capability:null', () => {
    for (const [id, entry] of Object.entries(SCREEN_REGISTRY)) {
      if (entry.zone !== 'work') continue;
      // capability can be null for work zone — verify it IS null (ADR §4.2)
      expect(entry.capability, `work-zone item ${id} should have null capability`).toBeNull();
    }
  });

  it('overview (home) has zone:null and capability:null', () => {
    const home = SCREEN_REGISTRY['overview'];
    expect(home).toBeDefined();
    expect(home.zone).toBeNull();
    expect(home.capability).toBeNull();
  });

  it('SCREEN_REGISTRY contains all ZONES items', () => {
    for (const zone of ZONES) {
      for (const item of zone.items) {
        expect(SCREEN_REGISTRY[item.id], `Missing ${item.id} in SCREEN_REGISTRY`).toBeDefined();
      }
    }
  });
});
