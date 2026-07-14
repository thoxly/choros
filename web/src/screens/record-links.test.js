/**
 * web/src/screens/record-links.test.js — T-0352 [E16]
 *
 * Unit tests for the pure display helpers in record-links.js.
 *
 * No DB, no fetch, no React. Pure functions only.
 *
 * Coverage:
 *   WRL-1  groupLinksByLabel — groups by label, same label → same bucket
 *   WRL-2  groupLinksByLabel — empty array → empty Map
 *   WRL-3  isHopAllowed — true for allowed, false for denied/null
 *   WRL-4  isHopDenied  — true for denied, false for allowed/null
 *   WRL-5  getRedactionReason — correct RU strings per reason
 *   WRL-6  getRedactionReason — unknown reason → 'Нет доступа'
 *   WRL-7  formatLinkedFields — filters internal keys, caps at maxFields
 *   WRL-8  formatLinkedFields — formats boolean/null/date/string values
 *   WRL-9  buildLinkSectionTitle — prefixes «Из » unless label already starts with it
 *   WRL-10 redacted projection has no `value` key (structural sentinel test)
 */

import { describe, it, expect } from 'vitest';
import {
  groupLinksByLabel,
  isHopAllowed,
  isHopDenied,
  getRedactionReason,
  formatLinkedFields,
  buildLinkSectionTitle,
} from './record-links.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAllowedHop(fields = { name: 'Acme' }) {
  return {
    allowed: true,
    targetRecordId: 'tgt-1',
    targetRegistryId: 'reg-1',
    fields,
    depth: 1,
  };
}

function makeDeniedHop(reason = 'no_grant', label = 'Counterparty', refField = 'counterparty_id') {
  return {
    allowed: false,
    reason,
    redactedProjection: { key: refField, visible: false, redacted: true, label },
  };
}

function makeLink(label, hop = makeAllowedHop()) {
  return { refId: 'ref-1', label, refField: 'some_id', hop };
}

// ---------------------------------------------------------------------------
// WRL-1: groupLinksByLabel
// ---------------------------------------------------------------------------

describe('WRL-1: groupLinksByLabel groups by label', () => {
  it('puts links with the same label into the same bucket', () => {
    const links = [
      makeLink('Договор', makeAllowedHop({ val: 1 })),
      makeLink('CRM',     makeAllowedHop({ val: 2 })),
      makeLink('Договор', makeAllowedHop({ val: 3 })),
    ];
    const groups = groupLinksByLabel(links);
    expect(groups.size).toBe(2);
    expect(groups.get('Договор')).toHaveLength(2);
    expect(groups.get('CRM')).toHaveLength(1);
  });

  it('preserves insertion order (Map is ordered)', () => {
    const links = [makeLink('B'), makeLink('A'), makeLink('C')];
    const keys = [...groupLinksByLabel(links).keys()];
    expect(keys).toEqual(['B', 'A', 'C']);
  });
});

// ---------------------------------------------------------------------------
// WRL-2: groupLinksByLabel empty
// ---------------------------------------------------------------------------

describe('WRL-2: groupLinksByLabel empty input', () => {
  it('returns an empty Map for an empty array', () => {
    const groups = groupLinksByLabel([]);
    expect(groups.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WRL-3: isHopAllowed
// ---------------------------------------------------------------------------

describe('WRL-3: isHopAllowed', () => {
  it('returns true for an allowed hop', () => {
    expect(isHopAllowed(makeAllowedHop())).toBe(true);
  });
  it('returns false for a denied hop', () => {
    expect(isHopAllowed(makeDeniedHop())).toBe(false);
  });
  it('returns false for null', () => {
    expect(isHopAllowed(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WRL-4: isHopDenied
// ---------------------------------------------------------------------------

describe('WRL-4: isHopDenied', () => {
  it('returns true for a denied hop', () => {
    expect(isHopDenied(makeDeniedHop())).toBe(true);
  });
  it('returns false for an allowed hop', () => {
    expect(isHopDenied(makeAllowedHop())).toBe(false);
  });
  it('returns false for null', () => {
    expect(isHopDenied(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WRL-5: getRedactionReason per reason code
// ---------------------------------------------------------------------------

describe('WRL-5: getRedactionReason — correct RU strings', () => {
  it('no_grant → Нет доступа', () => {
    expect(getRedactionReason(makeDeniedHop('no_grant'))).toBe('Нет доступа');
  });
  it('not_found → Запись не найдена', () => {
    expect(getRedactionReason(makeDeniedHop('not_found'))).toBe('Запись не найдена');
  });
  it('hop_cap_exceeded → Превышена глубина ссылок', () => {
    expect(getRedactionReason(makeDeniedHop('hop_cap_exceeded'))).toBe('Превышена глубина ссылок');
  });
  it('dangling_ref → Ссылка не установлена', () => {
    expect(getRedactionReason(makeDeniedHop('dangling_ref'))).toBe('Ссылка не установлена');
  });
  it('cross_tenant → Доступ запрещён', () => {
    expect(getRedactionReason(makeDeniedHop('cross_tenant'))).toBe('Доступ запрещён');
  });
});

// ---------------------------------------------------------------------------
// WRL-6: getRedactionReason — unknown reason fallback
// ---------------------------------------------------------------------------

describe('WRL-6: getRedactionReason — unknown reason', () => {
  it('returns "Нет доступа" for unknown reason codes', () => {
    expect(getRedactionReason(makeDeniedHop('totally_unknown'))).toBe('Нет доступа');
  });
  it('returns empty string for allowed hop (guard)', () => {
    expect(getRedactionReason(makeAllowedHop())).toBe('');
  });
});

// ---------------------------------------------------------------------------
// WRL-7: formatLinkedFields — filters internal keys, caps at maxFields
// ---------------------------------------------------------------------------

describe('WRL-7: formatLinkedFields — filtering and capping', () => {
  it('filters out internal keys (id, tenant_id, registry_id, created_at, updated_at, created_by)', () => {
    const fields = {
      id: 'uuid-1',
      tenant_id: 'tenant-uuid',
      registry_id: 'reg-uuid',
      created_at: 1000000,
      updated_at: 2000000,
      created_by: 'alice',
      company_name: 'Acme Corp',
      inn: '7700000001',
    };
    const result = formatLinkedFields(fields);
    const keys = result.map((f) => f.key);
    expect(keys).not.toContain('id');
    expect(keys).not.toContain('tenant_id');
    expect(keys).not.toContain('registry_id');
    expect(keys).not.toContain('created_at');
    expect(keys).not.toContain('updated_at');
    expect(keys).not.toContain('created_by');
    expect(keys).toContain('company_name');
    expect(keys).toContain('inn');
  });

  it('caps at maxFields (default 8)', () => {
    const fields = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`field_${i}`, `val_${i}`]),
    );
    const result = formatLinkedFields(fields, 8);
    expect(result).toHaveLength(8);
  });

  it('returns [] for null or non-object fields', () => {
    expect(formatLinkedFields(null)).toEqual([]);
    expect(formatLinkedFields('string')).toEqual([]);
    expect(formatLinkedFields(42)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WRL-8: formatLinkedFields — value formatting
// ---------------------------------------------------------------------------

describe('WRL-8: formatLinkedFields — value formatting', () => {
  it('formats boolean true → "Да"', () => {
    const result = formatLinkedFields({ active: true });
    expect(result[0].displayValue).toBe('Да');
  });
  it('formats boolean false → "Нет"', () => {
    const result = formatLinkedFields({ active: false });
    expect(result[0].displayValue).toBe('Нет');
  });
  it('formats null → "—"', () => {
    const result = formatLinkedFields({ val: null });
    expect(result[0].displayValue).toBe('—');
  });
  it('formats undefined → "—"', () => {
    const result = formatLinkedFields({ val: undefined });
    expect(result[0].displayValue).toBe('—');
  });
  it('formats number → string of number', () => {
    const result = formatLinkedFields({ amount: 12345 });
    expect(result[0].displayValue).toBe('12345');
  });
  it('formats ISO date string → localized date', () => {
    const result = formatLinkedFields({ date: '2026-06-20' });
    // The localized date contains the year and month somehow
    expect(result[0].displayValue).toMatch(/2026/);
  });
  it('formats plain string as-is', () => {
    const result = formatLinkedFields({ name: 'Hello World' });
    expect(result[0].displayValue).toBe('Hello World');
  });
  it('formats object → JSON string', () => {
    const result = formatLinkedFields({ nested: { a: 1 } });
    expect(result[0].displayValue).toBe('{"a":1}');
  });
});

// ---------------------------------------------------------------------------
// WRL-9: buildLinkSectionTitle
// ---------------------------------------------------------------------------

describe('WRL-9: buildLinkSectionTitle', () => {
  it('prefixes «Из » when label does not start with «из »', () => {
    expect(buildLinkSectionTitle('Договор')).toBe('Из Договор');
    expect(buildLinkSectionTitle('CRM')).toBe('Из CRM');
  });
  it('does NOT double-prefix if label already starts with «из »', () => {
    expect(buildLinkSectionTitle('Из договора')).toBe('Из договора');
    expect(buildLinkSectionTitle('ИЗ CRM')).toBe('ИЗ CRM');
  });
  it('returns default label for empty/null input', () => {
    expect(buildLinkSectionTitle('')).toBe('Связанные данные');
    expect(buildLinkSectionTitle(null)).toBe('Связанные данные');
    expect(buildLinkSectionTitle(undefined)).toBe('Связанные данные');
  });
});

// ---------------------------------------------------------------------------
// WRL-10: redacted projection structural sentinel (no `value` key)
// ---------------------------------------------------------------------------

describe('WRL-10: redacted projection structural sentinel', () => {
  it('denied hop redactedProjection has no `value` key', () => {
    const hop = makeDeniedHop('no_grant');
    expect('value' in hop.redactedProjection).toBe(false);
  });
  it('denied hop redactedProjection.visible is false', () => {
    const hop = makeDeniedHop('no_grant');
    expect(hop.redactedProjection.visible).toBe(false);
  });
  it('denied hop redactedProjection.redacted is true', () => {
    const hop = makeDeniedHop('no_grant');
    expect(hop.redactedProjection.redacted).toBe(true);
  });
});
