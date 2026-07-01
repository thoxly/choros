/**
 * web/src/screens/screen-app-records.test.jsx  (T-0568)
 *
 * Wiring tests for the record-list DELETE affordance + edit-drawer reuse.
 * Convention (project): vitest "node" environment, no React mount — screen
 * behaviour is asserted structurally against the .jsx source; the load-bearing
 * pure logic (recordDataToValues, serialize/validate) is tested behaviorally in
 * records-form.test.js.
 *
 * The delete control must:
 *   - hit DELETE /api/records/:id (the T-0566 frozen contract, → 204/404);
 *   - be confirm-gated (kit ConfirmDialog) before the request fires;
 *   - stopPropagation so it never triggers the row's navigate-on-click;
 *   - remove the row locally on success + a success toast.
 * The create drawer is REUSED for edit (PUT) when `existingRecord` is passed.
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');
const filePath = path.default.resolve(
  new URL(import.meta.url).pathname,
  '../screen-app-records.jsx',
);
const src = fs.default.readFileSync(filePath, 'utf-8');

describe('screen-app-records — record delete (T-0568)', () => {
  it('DELETEs /api/records/:id per the frozen contract', () => {
    expect(src).toContain('/api/records/${encodeURIComponent(toDelete.id)}');
    expect(src).toMatch(/method:\s*'DELETE'/);
  });

  it('accepts 204 and 404 as "gone" (idempotent delete)', () => {
    expect(src).toMatch(/res\.status === 204 \|\| res\.status === 404/);
  });

  it('removes the deleted row from local state on success', () => {
    expect(src).toMatch(/setRecords\(\(prev\) => \(prev \|\| \[\]\)\.filter\(\(r\) => r\.id !== toDelete\.id\)\)/);
  });

  it('is confirm-gated via the kit ConfirmDialog (no window.confirm)', () => {
    expect(src).toContain('<ConfirmDialog');
    expect(src).toContain('onConfirm={confirmDelete}');
    expect(src).not.toContain('window.confirm');
  });

  it('surfaces the outcome with a toast (success + error)', () => {
    expect(src).toContain("push({ tone: 'success', message: 'Запись удалена' })");
    expect(src).toMatch(/tone: 'error', title: 'Не удалось удалить запись'/);
  });

  it('stops propagation on the delete button so it never opens the row', () => {
    // The delete Button lives in the same clickable <tr onClick={navigate}> — its
    // onClick MUST call e.stopPropagation() before setToDelete.
    expect(src).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); setToDelete\(rec\); \}\}/);
  });
});

describe('screen-app-records — create drawer reused for edit (T-0568)', () => {
  it('exports CreateRecordDrawer so the detail screen can reuse it', () => {
    expect(src).toMatch(/export function CreateRecordDrawer/);
  });

  it('branches CREATE (POST 201) vs EDIT (PUT 200) on existingRecord', () => {
    expect(src).toMatch(/const isEdit = Boolean\(existingRecord && existingRecord\.id\)/);
    expect(src).toContain('/api/records/${encodeURIComponent(existingRecord.id)}');
    expect(src).toMatch(/method:\s*'PUT'/);
    expect(src).toMatch(/const okStatus = isEdit \? 200 : 201/);
  });

  it('prefills the form from the existing record in edit mode', () => {
    expect(src).toContain('recordDataToValues(formFields, existingRecord.data)');
  });
});
