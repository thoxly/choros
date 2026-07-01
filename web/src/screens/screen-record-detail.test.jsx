/**
 * web/src/screens/screen-record-detail.test.jsx  (T-0568)
 *
 * Wiring tests for the record-detail edit + delete affordances.
 * Convention (project): vitest "node" environment, no React mount — behaviour is
 * asserted structurally against the .jsx source (see screen-agents.test.jsx).
 *
 * Edit REUSES the create drawer (CreateRecordDrawer, imported from
 * screen-app-records.jsx) in edit mode → PUT /api/records/:id. Delete is
 * confirm-gated → DELETE /api/records/:id → navigate back to the list.
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');
const filePath = path.default.resolve(
  new URL(import.meta.url).pathname,
  '../screen-record-detail.jsx',
);
const src = fs.default.readFileSync(filePath, 'utf-8');

describe('screen-record-detail — edit (T-0568)', () => {
  it('reuses the create drawer for edit (no duplicated form code)', () => {
    expect(src).toContain("import { CreateRecordDrawer } from './screen-app-records.jsx'");
    expect(src).toContain('<CreateRecordDrawer');
    expect(src).toContain('existingRecord={record}');
  });

  it('offers a «Редактировать» affordance that opens the drawer', () => {
    expect(src).toContain('Редактировать');
    expect(src).toContain('setEditOpen(true)');
  });

  it('refreshes the record + toasts on a saved edit', () => {
    expect(src).toContain('setEditOpen(false)');
    expect(src).toContain("push({ tone: 'success', message: 'Запись сохранена' })");
  });
});

describe('screen-record-detail — delete (T-0568)', () => {
  it('DELETEs /api/records/:id (frozen contract), 204/404 both "gone"', () => {
    expect(src).toContain('/api/records/${encodeURIComponent(id)}');
    expect(src).toMatch(/method:\s*'DELETE'/);
    expect(src).toMatch(/res\.status === 204 \|\| res\.status === 404/);
  });

  it('is confirm-gated (kit ConfirmDialog, no window.confirm)', () => {
    expect(src).toContain('<ConfirmDialog');
    expect(src).toContain('onConfirm={confirmDelete}');
    expect(src).not.toContain('window.confirm');
  });

  it('navigates back to the record list after a successful delete', () => {
    expect(src).toMatch(/navigate\(appId \? `\/app-records\/\$\{appId\}` : '\/apps'\)/);
    expect(src).toContain("push({ tone: 'success', message: 'Запись удалена' })");
  });
});
