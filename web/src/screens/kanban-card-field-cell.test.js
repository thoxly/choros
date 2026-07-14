/**
 * web/src/screens/kanban-card-field-cell.test.js  (T-0728)
 *
 * Pure-logic coverage for the kanban person-field bug (N2 from T-0698's
 * review, столп 2 anti-UUID): a kanban card with a person-typed card field
 * always showed "—", never the executor's name — kanban-board.jsx's card-field
 * loop only understood formatCellValue's STRING return; the PERSON_CELL_ASYNC
 * sentinel (records-form.js, T-0673) fell through the generic
 * "not a string -> —" cast, same as it still does for relation/file (out of
 * this task's scope).
 *
 * resolveCardFieldCell (kanban-board.js) is the extracted pure function
 * backing KanbanCard's per-field dispatch decision — extracted specifically
 * so the person-vs-text branch is testable without a React/hook render
 * harness (KanbanCard uses useCallback; this repo's vitest tier has no
 * jsdom/react-test-renderer — mirrors resolveCardLabel's precedent,
 * kanban-card-label.test.js). Uses the REAL formatCellValue/
 * computeComputedFieldValue/PERSON_CELL_ASYNC from records-form.js (not a
 * fake mock) so the dispatch is proven against the actual sentinel contract,
 * not a test-local stand-in that could silently diverge from it.
 *
 * See kanban-board.jsx.test.js for the source-text/wiring proof that
 * KanbanCard actually calls this function and routes isPerson through
 * <PersonCell>. PersonCell's own name/deactivated/fallback resolution
 * contract is proven directly in screen-app-records.test.jsx (T-0673/T-0698) —
 * this file proves ONLY the dispatch decision, not PersonCell's rendering
 * (the SAME component, reused verbatim, not re-tested here).
 */

import { describe, it, expect } from 'vitest';
import { resolveCardFieldCell } from './kanban-board.js';
import { formatCellValue, computeComputedFieldValue, PERSON_CELL_ASYNC } from './records-form.js';

const META_PERSON = { key: 'executor', label: 'Исполнитель', type: 'person' };
const META_STRING = { key: 'name', label: 'Название', type: 'string' };
const META_COMPUTED = { key: 'total', label: 'Итого', type: 'computed' };

describe('T-0728 resolveCardFieldCell: person-type dispatch', () => {
  it('a non-empty person value dispatches isPerson:true with the raw id as personId (never "—")', () => {
    const cell = resolveCardFieldCell(
      'executor', META_PERSON, { executor: 'emp-slug-1' },
      formatCellValue, computeComputedFieldValue, PERSON_CELL_ASYNC,
    );
    expect(cell).toEqual({ isPerson: true, personId: 'emp-slug-1' });
  });

  it('an empty/absent person value degrades honestly to "—" (isPerson:false) — never a person dispatch with no id', () => {
    const missing = resolveCardFieldCell(
      'executor', META_PERSON, {},
      formatCellValue, computeComputedFieldValue, PERSON_CELL_ASYNC,
    );
    expect(missing).toEqual({ isPerson: false, displayVal: '—' });

    const blank = resolveCardFieldCell(
      'executor', META_PERSON, { executor: '' },
      formatCellValue, computeComputedFieldValue, PERSON_CELL_ASYNC,
    );
    expect(blank).toEqual({ isPerson: false, displayVal: '—' });
  });

  it('personId is always a string (defensive String() coercion)', () => {
    const cell = resolveCardFieldCell(
      'executor', META_PERSON, { executor: 'emp-slug-2' },
      formatCellValue, computeComputedFieldValue, PERSON_CELL_ASYNC,
    );
    expect(typeof cell.personId).toBe('string');
  });
});

describe('T-0728 resolveCardFieldCell: non-person fields unchanged (v1 behaviour preserved)', () => {
  it('a plain string field renders as text (isPerson:false)', () => {
    const cell = resolveCardFieldCell(
      'name', META_STRING, { name: 'Ромашка ООО' },
      formatCellValue, computeComputedFieldValue, PERSON_CELL_ASYNC,
    );
    expect(cell).toEqual({ isPerson: false, displayVal: 'Ромашка ООО' });
  });

  it('a computed field reads via computeComputedFieldValueFn, not data[key] directly', () => {
    const meta = { ...META_COMPUTED, formula: 'a + b' };
    const computeFn = (m, data) => (m === meta ? data.a + data.b : undefined);
    const cell = resolveCardFieldCell('total', meta, { a: 2, b: 3 }, formatCellValue, computeFn, PERSON_CELL_ASYNC);
    expect(cell).toEqual({ isPerson: false, displayVal: '5' });
  });

  it('a missing field meta defaults to string type, not a crash', () => {
    const cell = resolveCardFieldCell(
      'unknown_key', undefined, { unknown_key: 'raw text' },
      formatCellValue, computeComputedFieldValue, PERSON_CELL_ASYNC,
    );
    expect(cell).toEqual({ isPerson: false, displayVal: 'raw text' });
  });

  it('relation/file sentinels (out of T-0728 scope) still degrade to "—", not a crash or a leaked symbol', () => {
    const metaRelation = { key: 'target', label: 'Связь', type: 'relation' };
    const cell = resolveCardFieldCell(
      'target', metaRelation, { target: 'some-uuid' },
      formatCellValue, computeComputedFieldValue, PERSON_CELL_ASYNC,
    );
    expect(cell).toEqual({ isPerson: false, displayVal: '—' });
  });
});
