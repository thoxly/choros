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

describe('screen-record-detail — author display name (T-0608 пункт г)', () => {
  it('resolves created_by (a slug) to a display name via fetchEmployees, not raw', () => {
    expect(src).toContain("import { fetchEmployees } from '../forms/field-renderer.jsx'");
    expect(src).toContain('fetchEmployees()');
  });
  it('renders the resolved name through formatPersonName, falling back to the raw slug (never blank)', () => {
    expect(src).toContain('formatPersonName(authorNames.get(record.created_by)) || record.created_by');
  });
  it('a failed /api/org lookup degrades non-fatally (record still renders)', () => {
    const idx = src.indexOf('fetchEmployees()');
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/\.catch\(/);
  });
});

describe('screen-record-detail — FileFieldValue (T-0579, AC-9)', () => {
  // FileFieldValue is a local (non-exported) component; per this file's own
  // convention (see header docstring) behaviour is asserted structurally
  // against the source, mirroring RelationFieldValue's existing test pattern.

  it('renders the resolved file name as a download link to /api/files/:versionId/download (never a raw uuid)', () => {
    expect(src).toContain('const downloadHref = `/api/files/${encodeURIComponent(versionId)}/download`');
    expect(src).toContain('{meta.originalName || \'Скачать файл\'}');
  });

  it('requests the inline-disposition variant for preview (?disposition=inline)', () => {
    expect(src).toContain('const previewHref = `${downloadHref}?disposition=inline`');
  });

  it('inline <img> preview is gated on isPreviewSafeMime AND a normalized image/* mime (review B1: registro-safe)', () => {
    // Anchor AFTER the FileFieldValue function's own definition (not the file's
    // header docstring at line ~412, which also mentions "<img>" in prose).
    const fnStart = src.indexOf('function FileFieldValue(');
    expect(fnStart).toBeGreaterThan(-1);
    const idx = src.indexOf('<img', fnStart);
    expect(idx).toBeGreaterThan(-1);
    const precedingText = src.slice(fnStart, idx);
    // review B1 fix-forward: the img/embed gate now reads from a normalized
    // (trim+lowercase) local, not the raw meta.mime — so a registro-variant
    // safe mime (e.g. "Image/PNG") still renders the preview.
    expect(precedingText).toMatch(/previewSafe\s*&&\s*normalizedMime\.startsWith\('image\/'\)/);
    expect(precedingText).toContain("normalizedMime = typeof meta.mime === 'string' ? meta.mime.trim().toLowerCase() : ''");
    expect(src.slice(idx, idx + 200)).toContain('src={previewHref}');
  });

  it('inline <embed> preview (PDF) is gated on isPreviewSafeMime AND exactly application/pdf (normalized)', () => {
    const fnStart = src.indexOf('function FileFieldValue(');
    expect(fnStart).toBeGreaterThan(-1);
    const idx = src.indexOf('<embed', fnStart);
    expect(idx).toBeGreaterThan(-1);
    const precedingText = src.slice(fnStart, idx);
    expect(precedingText).toMatch(/previewSafe\s*&&\s*normalizedMime\s*===\s*'application\/pdf'/);
    expect(src.slice(idx, idx + 200)).toContain('src={previewHref}');
  });

  it('isPreviewSafeMime excludes image/svg+xml (anti-XSS, mirrors the server allowlist)', () => {
    // eslint-disable-next-line no-new-func -- structural extraction of a pure
    // helper from the .jsx source (no DOM/React needed to exercise its logic;
    // mirrors the source-scan convention already used in this file).
    const match = src.match(/function isPreviewSafeMime\(mime\) \{[\s\S]*?\n\}/);
    expect(match).not.toBeNull();
    // eslint-disable-next-line no-new-func
    const isPreviewSafeMime = new Function(`${match[0]}; return isPreviewSafeMime;`)();
    expect(isPreviewSafeMime('image/svg+xml')).toBe(false);
    expect(isPreviewSafeMime('image/png')).toBe(true);
    expect(isPreviewSafeMime('application/pdf')).toBe(true);
    expect(isPreviewSafeMime('text/html')).toBe(false);
    expect(isPreviewSafeMime('text/plain')).toBe(false);
    expect(isPreviewSafeMime(undefined)).toBe(false);
  });

  it('has an honest loading state (not a silently blank/frozen render)', () => {
    expect(src).toMatch(/state === 'loading'/);
  });

  it('has honest, DISTINCT non-resolved states — empty / forbidden / notfound — never one conflated "denied" bucket (review m2)', () => {
    // review m2: the original single 'denied' state conflated "no file
    // attached" (not an access problem), "listing fetch failed" (403/network),
    // and "listing loaded but this versionId isn't in it" (stale/foreign
    // value) into one "— / Нет доступа" label. Each is now a distinct state
    // with its own honest label.
    expect(src).toContain("useState(versionId && recordId ? 'loading' : 'empty')");
    expect(src).toMatch(/state === 'empty'/);
    expect(src).toMatch(/state === 'forbidden'/);
    expect(src).toMatch(/state === 'notfound' \|\| !meta/);
    expect(src).toContain('Файл не загружен');
    expect(src).toContain('Нет доступа');
    expect(src).toContain('Файл не найден');
  });

  it('is wired into the detail card ONLY for file fields with an async-resolved value (formatCellValue sentinel), never eagerly for every value', () => {
    expect(src).toContain("const isFile = f.type === 'file'");
    expect(src).toContain('formatCellValue(val, f.type) === FILE_CELL_ASYNC');
    expect(src).toContain('<FileFieldValue');
  });

  it('matches the stored value against ALL of a file\'s versions (versionIds), not just currentVersionId (review m1)', () => {
    // A field's stored value is whatever fileVersionId was captured at upload
    // time; a LATER "Заменить" re-upload on the same file advances
    // currentVersionId but the old value is still a legitimate historical
    // version. Matching only currentVersionId would falsely resolve it as
    // not-found.
    const idx = src.indexOf('function FileFieldValue(');
    expect(idx).toBeGreaterThan(-1);
    const fnBody = src.slice(idx, idx + 2000);
    expect(fnBody).toMatch(/f\.currentVersionId === versionId/);
    expect(fnBody).toMatch(/Array\.isArray\(f\.versionIds\) && f\.versionIds\.includes\(versionId\)/);
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
