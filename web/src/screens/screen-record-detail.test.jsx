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
  //
  // T-0622 (P0 fix): download/preview no longer set a native href/src to the
  // bare API path directly (that load carries no auth headers — 401 in
  // keycloak mode). Both now go through fetchFileBlob/downloadFile
  // (lib/authed-file.js): authed fetch → blob → same-origin blob: object URL.

  it('downloads via an authed blob fetch to /api/files/:versionId/download (never a bare href, never a raw uuid)', () => {
    expect(src).toContain('const downloadHref = `/api/files/${encodeURIComponent(versionId)}/download`');
    expect(src).toContain('downloadFile(downloadHref, meta?.originalName, fetchWithAuthRetry)');
    expect(src).toContain('{meta.originalName || \'Скачать файл\'}');
  });

  it('requests the inline-disposition variant for preview (?disposition=inline)', () => {
    expect(src).toContain("const previewHref = `/api/files/${encodeURIComponent(versionId)}/download?disposition=inline`");
    expect(src).toContain('fetchFileBlob(previewHref, fetchWithAuthRetry)');
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
    // review B1-residual fix-forward: the local also strips any `;param`
    // suffix, so a parameterized safe mime (e.g. "image/png;charset=binary")
    // still renders the preview too.
    expect(precedingText).toMatch(/isImagePreview = previewSafe && normalizedMime\.startsWith\('image\/'\)/);
    expect(precedingText).toContain("normalizedMime = typeof meta?.mime === 'string' ? meta.mime.trim().toLowerCase().split(';')[0].trim() : ''");
    // T-0622: the <img> src is the BLOB object URL (previewUrl), resolved from
    // an authed fetch — never the bare API href (that would 401 in keycloak mode).
    expect(src.slice(idx, idx + 200)).toContain('src={previewUrl}');
  });

  it('inline <embed> preview (PDF) is gated on isPreviewSafeMime AND exactly application/pdf (normalized)', () => {
    const fnStart = src.indexOf('function FileFieldValue(');
    expect(fnStart).toBeGreaterThan(-1);
    const idx = src.indexOf('<embed', fnStart);
    expect(idx).toBeGreaterThan(-1);
    const precedingText = src.slice(fnStart, idx);
    expect(precedingText).toMatch(/isPdfPreview = previewSafe && normalizedMime === 'application\/pdf'/);
    expect(src.slice(idx, idx + 200)).toContain('src={previewUrl}');
  });

  it('never sets a native <img src>/<a href> directly to the bare download API path (that load carries no auth headers — the P0 bug)', () => {
    const fnStart = src.indexOf('function FileFieldValue(');
    const fnEnd = src.indexOf('\n// ---', fnStart);
    const fnSrc = src.slice(fnStart, fnEnd > -1 ? fnEnd : undefined);
    expect(fnSrc).not.toMatch(/<img\s+src=\{previewHref\}/);
    expect(fnSrc).not.toMatch(/<embed\s+src=\{previewHref\}/);
    expect(fnSrc).not.toMatch(/<a\s+href=\{downloadHref\}/);
  });

  it('isPreviewSafeMime excludes image/svg+xml (anti-XSS, mirrors the server allowlist)', () => {
    // eslint-disable-next-line no-new-func -- structural extraction of a pure
    // helper from the .jsx source (no DOM/React needed to exercise its logic;
    // mirrors the source-scan convention already used in this file).
    // The helper closes over PREVIEW_SAFE_IMAGE_SUBTYPES, so both const
    // declarations must be extracted together.
    const setMatch = src.match(/const PREVIEW_SAFE_IMAGE_SUBTYPES = new Set\(\[[^\]]*\]\);/);
    const fnMatch = src.match(/function isPreviewSafeMime\(mime\) \{[\s\S]*?\n\}/);
    expect(setMatch).not.toBeNull();
    expect(fnMatch).not.toBeNull();
    // eslint-disable-next-line no-new-func
    const isPreviewSafeMime = new Function(`${setMatch[0]}\n${fnMatch[0]}; return isPreviewSafeMime;`)();
    expect(isPreviewSafeMime('image/svg+xml')).toBe(false);
    expect(isPreviewSafeMime('image/png')).toBe(true);
    expect(isPreviewSafeMime('application/pdf')).toBe(true);
    expect(isPreviewSafeMime('text/html')).toBe(false);
    expect(isPreviewSafeMime('text/plain')).toBe(false);
    expect(isPreviewSafeMime(undefined)).toBe(false);
  });

  // review B1-residual (blocking, second round): trim+lowercase alone missed
  // two bypasses — (a) a mime carrying a parameter
  // (`image/svg+xml;charset=utf-8`) survives normalization as-is, fails the
  // exact `=== 'image/svg+xml'` compare, yet still passed a bare
  // `startsWith('image/')` check; (b) `image/svg` (no `+xml`) was never
  // excluded by that single negative check at all. Both are closed by
  // param-stripping at the compare boundary AND a POSITIVE allowlist of
  // concrete-safe image subtypes (mirrors src/http/files.ts's
  // INLINE_SAFE_IMAGE_SUBTYPES / isInlineSafeMime).
  it('isPreviewSafeMime strips mime parameters AND uses a positive image-subtype allowlist (review B1-residual)', () => {
    const setMatch = src.match(/const PREVIEW_SAFE_IMAGE_SUBTYPES = new Set\(\[[^\]]*\]\);/);
    const fnMatch = src.match(/function isPreviewSafeMime\(mime\) \{[\s\S]*?\n\}/);
    expect(setMatch).not.toBeNull();
    expect(fnMatch).not.toBeNull();
    // eslint-disable-next-line no-new-func
    const isPreviewSafeMime = new Function(`${setMatch[0]}\n${fnMatch[0]}; return isPreviewSafeMime;`)();

    // [A] parameterized svg variants must still be denied.
    expect(isPreviewSafeMime('image/svg+xml;charset=utf-8')).toBe(false);
    expect(isPreviewSafeMime('image/svg+xml;x=1')).toBe(false);
    expect(isPreviewSafeMime('image/SVG+xml;charset=utf-8')).toBe(false);

    // [B] image/svg (no +xml suffix) must be denied.
    expect(isPreviewSafeMime('image/svg')).toBe(false);
    expect(isPreviewSafeMime('IMAGE/SVG')).toBe(false);

    // Positive allowlist: concrete safe subtypes → true, including with a
    // parameter on a SAFE mime (proves stripping isn't over-broad).
    expect(isPreviewSafeMime('image/png;charset=binary')).toBe(true);
    expect(isPreviewSafeMime('image/jpeg')).toBe(true);
    expect(isPreviewSafeMime('image/gif')).toBe(true);
    expect(isPreviewSafeMime('image/webp')).toBe(true);
    expect(isPreviewSafeMime('application/pdf;charset=binary')).toBe(true);

    // Never-safe non-image types stay excluded.
    expect(isPreviewSafeMime('application/xhtml+xml')).toBe(false);
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
    const fnBody = src.slice(idx, idx + 3000);
    expect(fnBody).toMatch(/f\.currentVersionId === versionId/);
    expect(fnBody).toMatch(/Array\.isArray\(f\.versionIds\) && f\.versionIds\.includes\(versionId\)/);
  });

  it('revokes the preview blob object URL on versionId change/unmount (no memory leak)', () => {
    const idx = src.indexOf("useEffect(() => {\n    if (!isImagePreview && !isPdfPreview)");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 900);
    expect(block).toMatch(/URL\.createObjectURL\(result\.blob\)/);
    expect(block).toMatch(/if \(objectUrl\) URL\.revokeObjectURL\(objectUrl\)/);
  });

  it('honest preview error state (401/403/404/network) instead of a silently broken <img>', () => {
    expect(src).toContain("previewState === 'error'");
    expect(src).toContain("previewError || 'Не удалось загрузить превью'");
  });

  it('honest download error surfaces inline (never a silent dead click)', () => {
    const fnStart = src.indexOf('function FileFieldValue(');
    const idx = src.indexOf('handleDownload', fnStart);
    expect(idx).toBeGreaterThan(-1);
    expect(src).toContain('{downloadError && (');
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
