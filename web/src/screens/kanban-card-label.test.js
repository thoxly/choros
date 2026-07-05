/**
 * web/src/screens/kanban-card-label.test.js  (T-0626)
 *
 * Pure-logic coverage for the KanbanCard fallback-label bug (capstone T-0584
 * LIVE_PROOF finding): a kanban card with NO configured card_fields used to
 * surface a raw UUID ("Запись cf1e4523…") instead of a human-readable title.
 *
 * resolveCardLabel (kanban-board.js) is the extracted pure function backing
 * KanbanCard's cardLabel — extracted specifically so this fallback contract
 * is testable without a React/hook render harness (KanbanCard uses
 * useCallback, and this repo's vitest tier has no jsdom/react-test-renderer;
 * see kanban-board.jsx.test.js for the source-text/wiring proof that
 * KanbanCard actually calls this function).
 *
 * Acceptance criteria covered (T-0626.spec.md):
 *   AC-2 — cardFields=[] + a non-empty string field -> label is that field's
 *          value, not a UUID/"Запись <id>".
 *   AC-3 — cardFields configured -> unchanged behaviour (fields[0] wins, NOT
 *          deriveRecordLabel), including its own pre-existing point fallback.
 *   AC-4 — cardFields=[] + record.data={} (no textual field at all) -> a
 *          short id ref (deriveRecordLabel's own fallback format), never a
 *          bare full UUID and never the old "Запись <uuid>" template.
 */

import { describe, it, expect } from 'vitest';
import { resolveCardLabel } from './kanban-board.js';
import { deriveRecordLabel, formatCellValue, computeComputedFieldValue } from './records-form.js';

describe('T-0626 AC-2: empty card_fields falls back to the record title, not a raw UUID', () => {
  it('uses the first non-empty string field from record.data as the card label', () => {
    const record = { id: 'cf1e4523-aaaa-bbbb-cccc-000000000001', data: { name: 'Ромашка ООО' } };
    const label = resolveCardLabel(record, [], new Map(), formatCellValue, computeComputedFieldValue, deriveRecordLabel);
    expect(label).toBe('Ромашка ООО');
    expect(label).not.toMatch(/Запись/);
    expect(label).not.toMatch(/cf1e4523/);
  });

  it('does not surface the raw UUID even truncated ("Запись <id>") when a text field exists', () => {
    const record = { id: 'deadbeef-0000-0000-0000-000000000000', data: { title: 'Открытая задача' } };
    const label = resolveCardLabel(record, undefined, new Map(), formatCellValue, computeComputedFieldValue, deriveRecordLabel);
    expect(label).toBe('Открытая задача');
  });

  it('treats a missing/undefined cardFields the same as an empty array (defensive)', () => {
    const record = { id: 'aaaaaaaa-0000-0000-0000-000000000000', data: { name: 'Х' } };
    const label = resolveCardLabel(record, undefined, new Map(), formatCellValue, computeComputedFieldValue, deriveRecordLabel);
    expect(label).toBe('Х');
  });
});

describe('T-0626 AC-3: configured card_fields path is unchanged (fields[0] wins, not deriveRecordLabel)', () => {
  it('cardFields=["status"] uses the configured field value, ignoring other string fields', () => {
    const record = { id: 'cf1e4523-aaaa-bbbb-cccc-000000000001', data: { status: 'В работе', name: 'Ромашка ООО' } };
    const fieldMetaByKey = new Map([['status', { key: 'status', label: 'Статус', type: 'select' }]]);
    const label = resolveCardLabel(record, ['status'], fieldMetaByKey, formatCellValue, computeComputedFieldValue, deriveRecordLabel);
    expect(label).toBe('В работе');
    expect(label).not.toBe('Ромашка ООО');
  });

  it('preserves the existing point fallback when the configured field renders to a non-string for this record', () => {
    // The configured field is 'amount' (a number field) but this record has no
    // value for it at all -> formatCellValue(undefined, 'number') renders '—',
    // which IS a string, so the existing v1 behaviour (unchanged by T-0626)
    // surfaces '—' here, not the id-prefix fallback — verifying the configured
    // path's pre-existing logic is untouched.
    const record = { id: 'cf1e4523-aaaa-bbbb-cccc-000000000001', data: {} };
    const fieldMetaByKey = new Map([['amount', { key: 'amount', label: 'Сумма', type: 'number' }]]);
    const label = resolveCardLabel(record, ['amount'], fieldMetaByKey, formatCellValue, computeComputedFieldValue, deriveRecordLabel);
    expect(label).toBe('—');
  });
});

describe('T-0626 AC-4: no textual field at all -> a short id ref, never a bare UUID', () => {
  it("cardFields=[] + record.data={} yields deriveRecordLabel's short-id fallback format", () => {
    const record = { id: 'cf1e4523-aaaa-bbbb-cccc-000000000001', data: {} };
    const label = resolveCardLabel(record, [], new Map(), formatCellValue, computeComputedFieldValue, deriveRecordLabel);
    // deriveRecordLabel's own fallback: first 8 chars of id + an ellipsis —
    // short, unambiguous, never the FULL raw UUID and never "Запись <uuid>".
    expect(label).toBe('cf1e4523…');
    expect(label).not.toBe('cf1e4523-aaaa-bbbb-cccc-000000000001');
    expect(label).not.toMatch(/^Запись /);
  });

  it('same fallback format applies when data has only blank/whitespace strings', () => {
    const record = { id: 'bbbbbbbb-0000-0000-0000-000000000000', data: { name: '   ', note: '' } };
    const label = resolveCardLabel(record, [], new Map(), formatCellValue, computeComputedFieldValue, deriveRecordLabel);
    expect(label).toBe('bbbbbbbb…');
  });
});
