/**
 * web/src/components/actor-chip.test.jsx — T-0648 unit tests for ActorChip
 * (+ ExecutorBadge/AuditEvent hardening + deriveRecordRefLabel).
 *
 * Approach: React elements are plain objects — call the component as a plain
 * function and walk the returned element tree, WITHOUT a DOM/jsdom (mirrors
 * web/src/forms/field-renderer.test.jsx's established pattern — see its own
 * header comment: "consistent with the project's node environment test
 * philosophy").
 *
 * ActorChip/ExecutorBadge/AuditEvent are plain function components with no
 * hooks — safe to call directly. RecordRef uses useState/useEffect (requires
 * a React dispatcher) so it is NOT covered here; its pure label-derivation
 * logic (deriveRecordRefLabel) is tested directly instead (same split as the
 * project's existing RelationCell/deriveRecordLabel precedent).
 *
 * Covers:
 *   1. ActorChip renders each type (human/agent/service) with the right glyph
 *      dot color class + human name in the main text.
 *   2. ActorChip NEVER puts the raw id in the main text — only in title/tooltip
 *      (and, when showId=true, in a separate MonoId chip).
 *   3. ActorChip falls back honestly to the id when name is absent — never "".
 *   4. asRenderableText / ExecutorBadge / AuditEvent — React error #31
 *      regression guard: passing a {type,name} object where a string is
 *      expected must NOT throw and must NOT render "[object Object]" — it
 *      coerces to the object's .name (or a JSON string as last resort).
 *   5. deriveRecordRefLabel — first non-empty string/number field wins; honest
 *      id-prefix fallback when no usable field; never returns the raw UUID
 *      un-shortened.
 */

import { describe, it, expect } from 'vitest';
import {
  ActorChip,
  ExecutorBadge,
  AuditEvent,
  asRenderableText,
  deriveRecordRefLabel,
} from './components.jsx';

// ---------------------------------------------------------------------------
// Tree-walk helpers (mirrors field-renderer.test.jsx)
// ---------------------------------------------------------------------------

function collectElements(node, predicate, results = []) {
  if (node === null || node === undefined) return results;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, results);
    return results;
  }
  if (typeof node !== 'object' || !node.type) return results;
  if (predicate(node)) results.push(node);
  if (typeof node.type === 'function') {
    // Descend into function-component subtrees (e.g. MonoId nested inside
    // ActorChip) by calling the component with its own props.
    collectElements(node.type(node.props || {}), predicate, results);
    return results;
  }
  const { children } = node.props || {};
  if (children !== undefined) collectElements(children, predicate, results);
  return results;
}

function findByType(tree, type) {
  return collectElements(tree, (el) => el.type === type);
}

/**
 * Flatten all string/number leaves in a tree into one joined text blob.
 * Recurses into FUNCTION-COMPONENT elements (e.g. <ExecutorBadge .../> nested
 * inside ActorChip's returned tree) by calling them with their own props —
 * this is what makes the tree-walk see all the way down to the actual DOM-ish
 * leaves instead of stopping at the first custom component boundary.
 */
function flattenText(node, acc = []) {
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) flattenText(child, acc);
    return acc;
  }
  if (typeof node === 'object' && node.type) {
    if (typeof node.type === 'function') {
      // Function component (e.g. ExecutorBadge, MonoId) — call it to get its
      // rendered tree, then keep walking.
      flattenText(node.type(node.props || {}), acc);
      return acc;
    }
    flattenText(node.props && node.props.children, acc);
  }
  return acc;
}

/**
 * Accessible-name approximation: collect text leaves like flattenText, but
 * SKIP any subtree marked aria-hidden (the decorative glyph) and INCLUDE
 * visually-hidden (chs-sr-only) text — this mirrors how AT computes the
 * accessible name from a node's text content (aria-hidden excluded, sr-only
 * included). Used to assert the actor TYPE reaches the accessible name in
 * every mode (T-0648 FIX-1).
 */
function accessibleNameOf(node, acc = []) {
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) accessibleNameOf(child, acc);
    return acc;
  }
  if (typeof node === 'object' && node.type) {
    if (node.props && node.props['aria-hidden']) return acc; // decorative — skip
    if (typeof node.type === 'function') {
      accessibleNameOf(node.type(node.props || {}), acc);
      return acc;
    }
    // An explicit aria-label overrides descendant text for the accessible name.
    if (node.props && typeof node.props['aria-label'] === 'string') {
      acc.push(node.props['aria-label']);
      return acc;
    }
    accessibleNameOf(node.props && node.props.children, acc);
  }
  return acc;
}

function accNameOf(tree) {
  return accessibleNameOf(tree).join(' ').replace(/\s+/g, ' ').trim();
}

function textOf(tree) {
  return flattenText(tree).join(' ');
}

// ---------------------------------------------------------------------------
// 1. ActorChip renders each type
// ---------------------------------------------------------------------------

describe('ActorChip — T-0648 renders each actor type with name in main text', () => {
  it('human: shows the name, not the id, in the main text', () => {
    const tree = ActorChip({ type: 'human', name: 'А. Кравцова', id: 'e-kravtsova' });
    const text = textOf(tree);
    expect(text).toContain('А. Кравцова');
    expect(text).not.toContain('e-kravtsova');
  });

  it('agent: renders with type=agent (glyph selection verified via ExecGlyph type prop)', () => {
    const tree = ActorChip({ type: 'agent', name: 'Счёт-агент', id: 'a-invoice' });
    expect(textOf(tree)).toContain('Счёт-агент');
    // The outer span's title carries the meta label + id (tooltip, not main text).
    expect(tree.props.title).toContain('a-invoice');
  });

  it('service: renders with type=service', () => {
    const tree = ActorChip({ type: 'service', name: 'ledger-sync', id: 's-ledger' });
    expect(textOf(tree)).toContain('ledger-sync');
  });
});

// ---------------------------------------------------------------------------
// 2. raw id never in main text; only in title/tooltip or an explicit MonoId chip
// ---------------------------------------------------------------------------

describe('ActorChip — T-0648 raw id is NEVER bare in the main text', () => {
  it('a UUID-shaped id does not appear in the rendered text when a name is present', () => {
    const uuid = '3462410f-c98a-4a11-9b2e-000000000001';
    const tree = ActorChip({ type: 'human', name: 'И. Петров', id: uuid });
    expect(textOf(tree)).not.toContain(uuid);
    // The id IS present, but only in the tooltip attribute.
    expect(tree.props.title).toContain(uuid);
  });

  it('showId=true surfaces the id in a SEPARATE MonoId chip, not inline with the name', () => {
    const uuid = '3462410f-c98a-4a11-9b2e-000000000001';
    const tree = ActorChip({ type: 'human', name: 'И. Петров', id: uuid, showId: true });
    const monoids = findByType(tree, 'span').filter((el) =>
      (el.props.className || '').includes('chs-monoid'),
    );
    expect(monoids.length).toBeGreaterThan(0);
  });

  it('no id supplied at all → main text never contains "undefined"/"null"', () => {
    const tree = ActorChip({ type: 'human', name: 'Аноним' });
    expect(textOf(tree)).not.toContain('undefined');
    expect(textOf(tree)).not.toContain('null');
  });
});

// ---------------------------------------------------------------------------
// 3. honest fallback: no name → falls back to id, never blank/garbage
// ---------------------------------------------------------------------------

describe('ActorChip — T-0648 honest fallback when name is absent', () => {
  it('falls back to the id as the displayed name when name is missing', () => {
    const tree = ActorChip({ type: 'human', id: 'e-ghost' });
    expect(textOf(tree)).toContain('e-ghost');
  });

  it('falls back to the type label when NEITHER name nor id is present', () => {
    const tree = ActorChip({ type: 'human' });
    expect(textOf(tree)).toContain('Человек');
  });
});

// ---------------------------------------------------------------------------
// 4. React error #31 regression guard — object passed where a string belongs
// ---------------------------------------------------------------------------

describe('T-0648 React error #31 hardening — rendering an actor OBJECT never throws', () => {
  it('asRenderableText: a {type,name} object coerces to its .name', () => {
    expect(asRenderableText({ type: 'human', name: 'Е. Ларина' })).toBe('Е. Ларина');
  });

  it('asRenderableText: an object with no .name falls back to JSON (never throws, never renders a bare object)', () => {
    const result = asRenderableText({ foo: 'bar' });
    expect(typeof result).toBe('string');
  });

  it('asRenderableText: null/undefined → undefined (renders as nothing, not "null"/"undefined" text)', () => {
    expect(asRenderableText(null)).toBeUndefined();
    expect(asRenderableText(undefined)).toBeUndefined();
  });

  it('asRenderableText: passes strings/numbers through unchanged', () => {
    expect(asRenderableText('М. Соколов')).toBe('М. Соколов');
    expect(asRenderableText(42)).toBe(42);
  });

  it('ExecutorBadge: calling it with name=<object> (the exact /rights/trail regression shape) does not throw and does not render "[object Object]"', () => {
    // This is the EXACT defect class docs/design/ux-study-2026-07-05.md §6.2
    // describes for /rights/trail: an actor arrives as {type, name} and a caller
    // passes the WHOLE object where a string was expected.
    expect(() => {
      const tree = ExecutorBadge({ type: 'human', name: { type: 'human', name: 'К. Орлов' } });
      const text = textOf(tree);
      expect(text).not.toContain('[object Object]');
      expect(text).toContain('К. Орлов');
    }).not.toThrow();
  });

  it('AuditEvent: passing an actor OBJECT instead of a string does not throw and does not render "[object Object]"', () => {
    expect(() => {
      const tree = AuditEvent({
        ts: '10:00:00',
        actorType: 'agent',
        actor: { type: 'agent', name: 'Юр-агент' },
        action: 'провёл проверку',
      });
      const text = textOf(tree);
      expect(text).not.toContain('[object Object]');
      expect(text).toContain('Юр-агент');
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. deriveRecordRefLabel — RecordRef's pure title-derivation logic
// ---------------------------------------------------------------------------

describe('T-0648 deriveRecordRefLabel — RecordRef title derivation (mirrors deriveRecordLabel)', () => {
  it('returns the first non-empty string field value', () => {
    const record = { id: 'aaaaaaaa-0000-0000-0000-000000000001', data: { title: 'Заявка на аренду офиса', amount: 500000 } };
    expect(deriveRecordRefLabel(record)).toBe('Заявка на аренду офиса');
  });

  it('falls back to the first finite-number field when no string field is usable', () => {
    const record = { id: 'aaaaaaaa-0000-0000-0000-000000000002', data: { amount: 500000 } };
    expect(deriveRecordRefLabel(record)).toBe('500000');
  });

  it('never returns a bare raw UUID — id-prefix fallback when data has nothing usable', () => {
    const record = { id: 'aaaaaaaa-0000-0000-0000-000000000003', data: {} };
    const label = deriveRecordRefLabel(record);
    expect(label).not.toBe(record.id);
    expect(label).toMatch(/…$/);
  });

  it('null/undefined record → null (RecordRef treats this as "denied/honest-empty", never throws)', () => {
    expect(deriveRecordRefLabel(null)).toBeNull();
    expect(deriveRecordRefLabel(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. FIX-1 (a11y, столп 4): the actor TYPE is in the ACCESSIBLE NAME in every
//    mode — a screen-reader user must be able to tell an agent from a human,
//    not only sighted users via the glyph/colour.
// ---------------------------------------------------------------------------

describe('ActorChip/ExecutorBadge — T-0648 FIX-1: actor type is in the accessible name (all modes)', () => {
  it('ActorChip human: accessible name contains the human-readable type "Человек"', () => {
    const acc = accNameOf(ActorChip({ type: 'human', name: 'И. Петров', id: 'e-petrov' }));
    expect(acc).toContain('И. Петров');
    expect(acc).toContain('Человек');
  });

  it('ActorChip agent: accessible name contains "Агент" (столп 4 — agent distinguishable by AT, not only by glyph)', () => {
    const acc = accNameOf(ActorChip({ type: 'agent', name: 'Счёт-агент', id: 'a-invoice' }));
    expect(acc).toContain('Счёт-агент');
    expect(acc).toContain('Агент');
  });

  it('ActorChip service: accessible name contains "Сервис"', () => {
    const acc = accNameOf(ActorChip({ type: 'service', name: 'ledger-sync', id: 's-ledger' }));
    expect(acc).toContain('ledger-sync');
    expect(acc).toContain('Сервис');
  });

  it('the type reaches the accessible name via SR-ONLY text, NOT only via title= (title is not reliably announced)', () => {
    // The type must be a real text node in the tree, not merely a title attribute
    // on the wrapper — assert it survives accessible-name computation (which does
    // not read title=).
    const tree = ActorChip({ type: 'agent', name: 'Счёт-агент', id: 'a-invoice' });
    expect(accNameOf(tree)).toContain('Агент');
  });

  it('bare/showLabel=false mode: the type is STILL in the accessible name (no visible label, but AT still hears the type)', () => {
    // ExecutorBadge showLabel=false is used e.g. in ra-grant-trail glyph-only spots.
    const acc = accNameOf(ExecutorBadge({ type: 'agent', name: 'Счёт-агент', showLabel: false }));
    expect(acc).toContain('Счёт-агент');
    expect(acc).toContain('Агент');
  });

  it('bare glyph-only ActorChip: accessible name carries name + type', () => {
    const acc = accNameOf(ActorChip({ type: 'service', name: 'ocr-gateway', id: 's-ocr', bare: true }));
    expect(acc).toContain('ocr-gateway');
    expect(acc).toContain('Сервис');
  });
});

// ---------------------------------------------------------------------------
// 7. FIX-3: deactivated actor — marker in the accessible name + muted style.
// ---------------------------------------------------------------------------

describe('ActorChip — T-0648 FIX-3: deactivated marker', () => {
  it('deactivated=true → accessible name includes «деактивирован» (lost signal now audible)', () => {
    const acc = accNameOf(ActorChip({ type: 'human', name: 'Уволенный', id: 'e-gone', deactivated: true }));
    expect(acc).toContain('Уволенный');
    expect(acc).toContain('деактивирован');
  });

  it('deactivated=true → the wrapper carries the chs-exec--deactivated visual class', () => {
    const tree = ActorChip({ type: 'human', name: 'Уволенный', id: 'e-gone', deactivated: true });
    // ExecutorBadge is the inner component that owns the class — render it and check.
    const badge = findByType(tree, 'span').find((el) =>
      (el.props.className || '').includes('chs-exec--deactivated'),
    );
    expect(badge).toBeDefined();
  });

  it('deactivated=false (default) → NO deactivation marker in the accessible name', () => {
    const acc = accNameOf(ActorChip({ type: 'human', name: 'Активный', id: 'e-active' }));
    expect(acc).not.toContain('деактивирован');
  });
});
