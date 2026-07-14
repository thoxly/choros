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
 *   6. deriveRecordRefDisplay (T-0735 live-proof anti-uuid fix) — RecordRef's
 *      pure render-decision on the NON-projection fetch path: a denied/
 *      unresolvable record NEVER surfaces the raw record UUID as the primary
 *      label (the honest RECORD_UNAVAILABLE_LABEL sentinel instead, id demoted
 *      to a tooltip-only field); a resolved record WITH a derivable title still
 *      yields the human label (link when an app id is known, plain otherwise).
 *      The T-0756 projection path is authoritative and bypasses this helper.
 */

import { describe, it, expect } from 'vitest';
import {
  ActorChip,
  ExecutorBadge,
  AuditEvent,
  ProcessRef,
  asRenderableText,
  deriveRecordRefLabel,
  deriveRecordRefDisplay,
  RECORD_UNAVAILABLE_LABEL,
  deriveProcessRefPrimary,
  isMachineInst,
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
// 3b. T-0685 — an UNRESOLVED actor whose name is itself a raw UUID must never
//     be surfaced as the PRIMARY text (capstone T-0647 /rights/trail defect):
//     the batch resolver missed, so the honest fallback carries name === id === a
//     UUID. ActorChip must demote it (tooltip only) and show the honest type
//     label instead — exactly like ProcessRef/RecordRef. A human-legible SLUG
//     fallback is NOT a machine key and stays primary (unchanged).
// ---------------------------------------------------------------------------

describe('ActorChip — T-0685: a raw-UUID name is demoted, never rendered primary', () => {
  const RAW_UUID = 'a1b2c3d4-0000-4000-8000-00000000abcd';

  it('name === id === UUID (resolver miss) → the UUID is NOT in the visible text', () => {
    const tree = ActorChip({ type: 'human', name: RAW_UUID, id: RAW_UUID });
    expect(textOf(tree)).not.toContain(RAW_UUID);
    // The honest generic type label stands in for the missing human name.
    expect(textOf(tree)).toContain('Человек');
  });

  it('the demoted UUID stays reachable in the tooltip (hidden, not erased)', () => {
    const tree = ActorChip({ type: 'human', name: RAW_UUID, id: RAW_UUID });
    expect(tree.props.title).toContain(RAW_UUID);
  });

  it('showId=true → the demoted UUID surfaces in a mono chip (auditability preserved)', () => {
    const tree = ActorChip({ type: 'human', name: RAW_UUID, id: RAW_UUID, showId: true });
    const monoids = findByType(tree, 'span').filter((el) =>
      (el.props.className || '').includes('chs-monoid'),
    );
    expect(monoids.length).toBeGreaterThan(0);
  });

  it('an `agent:`-shaped synthetic key is ALSO demoted (never primary)', () => {
    const key = 'agent:' + RAW_UUID;
    const tree = ActorChip({ type: 'agent', name: key, id: key });
    expect(textOf(tree)).not.toContain(key);
    expect(textOf(tree)).toContain('Агент');
  });

  it('a human-legible SLUG fallback (NOT a machine key) is STILL primary (no over-demotion)', () => {
    const tree = ActorChip({ type: 'service', id: 'policy-sync' });
    expect(textOf(tree)).toContain('policy-sync');
  });

  it('a resolved human name still renders primary (demotion fires only on machine keys)', () => {
    const tree = ActorChip({ type: 'human', name: 'Активный Пользователь', id: RAW_UUID });
    expect(textOf(tree)).toContain('Активный Пользователь');
    expect(textOf(tree)).not.toContain(RAW_UUID); // id still tooltip-only
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
// 5b. deriveRecordRefDisplay — T-0735 live-proof anti-uuid fix: RecordRef's
//     NON-projection fetch-path render decision. Regression coverage for the
//     exact defect: "the «Процессы» grid name cell showed a bare raw
//     record-source UUID (308eb628-2058-4a36-b04a-e10610dfad1a-shaped) when
//     GET /api/records/:id 404'd (source record unreadable under the viewing
//     actor's PDP)". T-0756 already closed the instance-DETAIL screen via a
//     server projection (no fetch); this closes the consumers that still fetch
//     (grid, inbox drawer, inbox row, ProcessRef) — see the projection-path
//     coverage in screen-process-instance.test.jsx (detail unchanged).
// ---------------------------------------------------------------------------

describe('T-0735 deriveRecordRefDisplay — RecordRef fetch-path denied-state anti-uuid fix', () => {
  const UUID = '308eb628-2058-4a36-b04a-e10610dfad1a';

  it('denied (404/403/network) + a recordId → the honest sentinel, NOT the raw UUID', () => {
    const display = deriveRecordRefDisplay({ state: 'denied', label: null, recordId: UUID });
    expect(display.kind).toBe('unavailable');
    // The raw id is reachable ONLY as tooltip metadata, never as rendered text.
    expect(display.tooltip).toBe(UUID);
    expect(display).not.toHaveProperty('label');
  });

  it('the sentinel label itself never contains/equals the raw record id', () => {
    expect(RECORD_UNAVAILABLE_LABEL).not.toContain(UUID);
    expect(RECORD_UNAVAILABLE_LABEL.trim().length).toBeGreaterThan(0);
    // Sanity: it reads as a sentence, not a machine key.
    expect(RECORD_UNAVAILABLE_LABEL).toMatch(/[а-яА-Я]/);
  });

  it('resolved with no derivable label (empty data record) → still the honest sentinel, never the id', () => {
    const display = deriveRecordRefDisplay({ state: 'resolved', label: null, recordId: UUID });
    expect(display.kind).toBe('unavailable');
    expect(display.tooltip).toBe(UUID);
  });

  it('denied + no recordId at all → the neutral empty dash, no sentinel needed', () => {
    const display = deriveRecordRefDisplay({ state: 'denied', label: null, recordId: undefined });
    expect(display.kind).toBe('empty');
  });

  it('loading → a distinct loading kind (not treated as unavailable)', () => {
    expect(deriveRecordRefDisplay({ state: 'loading', label: null, recordId: UUID }).kind).toBe('loading');
  });

  it('resolved WITH a derivable title + a known app id → a link carrying the human label', () => {
    const display = deriveRecordRefDisplay({
      state: 'resolved', label: 'Заявка на аренду офиса', recordId: UUID, targetAppId: 'app-1',
    });
    expect(display.kind).toBe('link');
    expect(display.label).toBe('Заявка на аренду офиса');
    expect(display.href).toBe(`/apps/app-1/records/${UUID}`);
  });

  it('resolved WITH a derivable title but NO known app id → plain human label (no link, still not the id)', () => {
    const display = deriveRecordRefDisplay({
      state: 'resolved', label: 'Заявка на аренду офиса', recordId: UUID, targetAppId: null, appId: null,
    });
    expect(display.kind).toBe('plain');
    expect(display.label).toBe('Заявка на аренду офиса');
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

// ---------------------------------------------------------------------------
// 8. T-0683 — ProcessRef: the inbox «ПРОЦЕСС» column must NEVER show a raw
//    instance-UUID (or a bare `agent:` key) as the PRIMARY identifier. Sibling
//    of ActorChip/RecordRef (T-0648). Mutational: revert the server enrichment
//    (processName absent) → the raw UUID must STILL not become the primary text.
// ---------------------------------------------------------------------------

const A_UUID = '5ec293d1-77d7-11f1-abdf-0242ac120002';

describe('T-0683 — isMachineInst (raw machine keys never primary)', () => {
  it('a raw instance-UUID IS a machine key', () => {
    expect(isMachineInst(A_UUID)).toBe(true);
  });
  it('an `agent:<id>` synthetic key IS a machine key', () => {
    expect(isMachineInst('agent:' + A_UUID)).toBe(true);
    expect(isMachineInst('instance:abc')).toBe(true);
  });
  it('a human fixture label like "INS-7731" is NOT a machine key', () => {
    expect(isMachineInst('INS-7731')).toBe(false);
  });
  it('empty / missing inst is treated as a machine key (no human value)', () => {
    expect(isMachineInst('')).toBe(true);
    expect(isMachineInst(undefined)).toBe(true);
  });
});

describe('T-0683 — deriveProcessRefPrimary (primary is always human)', () => {
  it('processName (human) always wins as the primary label', () => {
    const { label } = deriveProcessRefPrimary({ processName: 'Обработка заявки', inst: A_UUID });
    expect(label).toBe('Обработка заявки');
    expect(label).not.toBe(A_UUID);
  });
  it('MUTATION: no processName + UUID inst → primary is NEVER the raw UUID', () => {
    // This is the exact capstone T-0647 defect: reverting the server enrichment
    // (processName undefined) must still not surface the raw UUID as primary.
    const { label, showInst } = deriveProcessRefPrimary({ processName: undefined, inst: A_UUID });
    expect(label).not.toBe(A_UUID);
    expect(label).toBe('Процесс'); // honest generic — the task name fallback is empty here
    expect(showInst).toBe(false);  // UUID never surfaced as a bare secondary either
  });
  it('agent row: no processName + `agent:` key → uses the human task label, not the key', () => {
    const { label, showInst } = deriveProcessRefPrimary({
      processName: undefined,
      inst: 'agent:' + A_UUID,
      stepFallback: 'Классифицировать обращение',
    });
    expect(label).toBe('Классифицировать обращение');
    expect(label).not.toMatch(/^agent:/);
    expect(showInst).toBe(false);
  });
  it('human fixture inst (no processName) → uses the fixture label as primary', () => {
    const { label } = deriveProcessRefPrimary({ processName: undefined, inst: 'INS-7731' });
    expect(label).toBe('INS-7731');
  });
});

describe('T-0683 — ProcessRef component tree (no recordId → hook-free)', () => {
  // ProcessRef only renders the nested RecordRef (which uses hooks) when
  // recordId is present. Without recordId it is a pure function-component tree —
  // safe to call directly and tree-walk (same discipline as ActorChip above).
  it('with processName: the human name is in the rendered text, the UUID is NOT bare text', () => {
    const tree = ProcessRef({ processName: 'Возврат средств', inst: A_UUID });
    const text = flattenText(tree).join(' ');
    expect(text).toContain('Возврат средств');
    // The raw UUID must not appear as a bare text leaf (it lives only in title).
    expect(text).not.toContain(A_UUID);
  });
  it('MUTATION: no processName + UUID inst → the UUID is NOT the primary text', () => {
    const tree = ProcessRef({ processName: undefined, inst: A_UUID, stepFallback: '' });
    const text = flattenText(tree).join(' ');
    expect(text).toContain('Процесс');
    expect(text).not.toContain(A_UUID);
  });
  it('agent row: `agent:` key is never rendered as bare text', () => {
    const tree = ProcessRef({
      processName: undefined,
      inst: 'agent:' + A_UUID,
      stepFallback: 'Триаж обращения',
    });
    const text = flattenText(tree).join(' ');
    expect(text).toContain('Триаж обращения');
    expect(text).not.toMatch(/agent:/);
  });
});
