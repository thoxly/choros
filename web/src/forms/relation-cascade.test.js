/**
 * web/src/forms/relation-cascade.test.js  (T-0463 · D8-G2)
 *
 * Unit tests for the client-side relation-cascade mirror. Verifies the SECOND
 * driver (visual relation-picker) decides identically to the core primitive:
 * link / create / ask / hop-cap. Pure — no React, no fetch.
 *
 * Run: cd web && npx vitest run src/forms/relation-cascade.test.js
 */

import { describe, it, expect } from 'vitest';
import { resolveRelationTarget, slugFromName, HOP_CAP } from './relation-cascade.js';

const CONTRACTORS = { id: 'c1', slug: 'contractors', displayName: 'Контрагенты' };
const PURCHASES = { id: 'c2', slug: 'purchases', displayName: 'Заявки на закупку' };

describe('relation-cascade mirror (web picker driver, T-0463)', () => {
  it('non-existent target → create', () => {
    const d = resolveRelationTarget({ targetDisplayName: 'Поставщики' }, [CONTRACTORS, PURCHASES], 1);
    expect(d.decision).toBe('create');
    expect(d.appSlug).toBe('postavschiki');
    expect(d.appDisplayName).toBe('Поставщики');
  });

  it('exact slug → link (dedup, no duplicate)', () => {
    const d = resolveRelationTarget({ targetSlug: 'contractors' }, [CONTRACTORS, PURCHASES], 1);
    expect(d.decision).toBe('link');
    expect(d.targetRegistryId).toBe('c1');
    expect(d.matchReason).toBe('exact_slug');
  });

  it('exact name (case/space-insensitive) → link', () => {
    const d = resolveRelationTarget({ targetDisplayName: '  контрагенты ' }, [CONTRACTORS], 1);
    expect(d.decision).toBe('link');
    expect(d.targetRegistryId).toBe('c1');
  });

  it('ambiguous (two same-name apps) → ask, no guess', () => {
    const dup1 = { id: 'd1', slug: 'a', displayName: 'Контрагенты' };
    const dup2 = { id: 'd2', slug: 'b', displayName: 'контрагенты' };
    const d = resolveRelationTarget({ targetDisplayName: 'Контрагенты' }, [dup1, dup2], 1);
    expect(d.decision).toBe('ask');
    expect(d.candidates).toHaveLength(2);
  });

  it('hop-cap: depth > HOP_CAP → stop', () => {
    const d = resolveRelationTarget({ targetDisplayName: 'Глубоко' }, [], HOP_CAP + 1);
    expect(d.decision).toBe('hop_cap_exceeded');
    expect(d.cap).toBe(HOP_CAP);
  });

  it('explicit id → link', () => {
    const d = resolveRelationTarget({ explicitTargetRegistryId: 'c2' }, [CONTRACTORS], 1);
    expect(d.decision).toBe('link');
    expect(d.targetRegistryId).toBe('c2');
    expect(d.matchReason).toBe('explicit_id');
  });

  it('slugFromName is Cyrillic-aware', () => {
    expect(slugFromName('Контрагенты')).toBe('kontragenty');
    expect(slugFromName('')).toBe('app');
  });

  it('HOP_CAP === 3 (shared with core)', () => {
    expect(HOP_CAP).toBe(3);
  });
});
