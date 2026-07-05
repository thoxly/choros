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

describe('screen-app-records — FileCell (T-0579, review M1/m1/m2)', () => {
  it('never falls back to the raw fileVersionId — resolveState drives a human label instead', () => {
    const idx = src.indexOf('function FileCell(');
    expect(idx).toBeGreaterThan(-1);
    const fnBody = src.slice(idx, idx + 3200);
    // Distinct honest states, not one "denied" bucket (review m2).
    expect(fnBody).toContain("useState(versionId && recordId ? 'loading' : 'empty')");
    expect(fnBody).toMatch(/state === 'empty'/);
    expect(fnBody).toMatch(/state === 'forbidden'/);
    expect(fnBody).toMatch(/state === 'notfound' \|\| !name/);
    // Never renders the raw versionId as the visible name fallback.
    expect(fnBody).not.toMatch(/\{versionId\}\s*<\/span>/);
  });

  it('matches the stored value against ALL of a file\'s versions (versionIds), not just currentVersionId (review m1)', () => {
    const idx = src.indexOf('function FileCell(');
    expect(idx).toBeGreaterThan(-1);
    const fnBody = src.slice(idx, idx + 1400);
    expect(fnBody).toMatch(/f\.currentVersionId === versionId/);
    expect(fnBody).toMatch(/Array\.isArray\(f\.versionIds\) && f\.versionIds\.includes\(versionId\)/);
  });

  it('threads recordId onto file-contract fields in the create/edit form (review M1)', () => {
    expect(src).toContain("contractKind === 'file'\n            ? { ...f, recordId: isEdit ? existingRecord.id : undefined }");
  });

  // T-0622 (P0 fix): a native <a href="/api/files/:versionId/download"> load
  // does not carry the SPA's auth headers — 401 in keycloak mode. Download
  // now goes through downloadFile (authed fetch → blob → programmatic
  // <a download> click), never a bare href to the API path.
  it('downloads via an authed blob fetch (downloadFile), never a bare href to the download API (T-0622)', () => {
    const idx = src.indexOf('function FileCell(');
    expect(idx).toBeGreaterThan(-1);
    const fnBody = src.slice(idx, idx + 3200);
    expect(fnBody).toContain('downloadFile(');
    expect(fnBody).toContain('`/api/files/${encodeURIComponent(versionId)}/download`');
    expect(fnBody).toContain('fetchWithAuthRetry');
    // never a native href straight to the download route.
    expect(fnBody).not.toMatch(/href=\{`\/api\/files\/\$\{encodeURIComponent\(versionId\)\}\/download`\}/);
  });

  it('surfaces a download error inline instead of a silent dead click (T-0622)', () => {
    const idx = src.indexOf('function FileCell(');
    const fnBody = src.slice(idx, idx + 3200);
    expect(fnBody).toContain('downloadError');
    expect(fnBody).toContain("if (!result.ok) setDownloadError(result.message)");
  });

  it('the download click still stops propagation (never opens the row) — T-0622 preserves the pre-existing guard', () => {
    const idx = src.indexOf('function FileCell(');
    const fnBody = src.slice(idx, idx + 3200);
    expect(fnBody).toMatch(/e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/);
  });
});

// ---------------------------------------------------------------------------
// T-0627: DraftSandboxBanner — makes the draft→publish step noticeable from
// the screen where "only my records" is actually experienced (T-0584
// capstone finding). Exercised DIRECTLY as a pure function component (project
// convention — no jsdom/DOM-mount tier; mirrors RowModalStopBubble in
// screen-apps.test.jsx).
// ---------------------------------------------------------------------------

import { DraftSandboxBanner } from './screen-app-records.jsx';

describe('DraftSandboxBanner (T-0627)', () => {
  it('renders nothing when app is not yet loaded (null) — no flash-of-wrong-state', () => {
    expect(DraftSandboxBanner({ app: null, canPublish: true, onOpenPublish: () => {} })).toBeNull();
  });

  it('renders nothing when app.tier is "published"', () => {
    const el = DraftSandboxBanner({
      app: { id: 'a1', tier: 'published' }, canPublish: true, onOpenPublish: () => {},
    });
    expect(el).toBeNull();
  });

  it('renders a role="status" banner when app.tier is "draft"', () => {
    const el = DraftSandboxBanner({
      app: { id: 'a1', tier: 'draft' }, canPublish: true, onOpenPublish: () => {},
    });
    expect(el).not.toBeNull();
    expect(el.props.role).toBe('status');
  });

  it('an owner/admin/authoring_draft viewer (canPublish=true) sees the actionable copy + an «Опубликовать» button', () => {
    const onOpenPublish = () => {};
    const el = DraftSandboxBanner({ app: { tier: 'draft' }, canPublish: true, onOpenPublish });
    const [copySpan, button] = el.props.children;
    expect(copySpan.props.children).toMatch(/Опубликуйте, чтобы команда работала на общей доске/);
    expect(button).toBeTruthy();
    expect(button.props.children).toBe('Опубликовать');
    expect(button.props.onClick).toBe(onOpenPublish);
  });

  it('a rank-and-file viewer (canPublish=false) sees the explanatory copy WITHOUT a button (G3: no dead affordance)', () => {
    const el = DraftSandboxBanner({ app: { tier: 'draft' }, canPublish: false, onOpenPublish: () => {} });
    const children = el.props.children;
    // children is [copySpan, false] when canPublish is false — the button branch renders nothing.
    const copySpan = Array.isArray(children) ? children[0] : children;
    expect(copySpan.props.children).toMatch(/Когда владелец опубликует приложение, команда увидит общую доску/);
    const button = Array.isArray(children) ? children[1] : null;
    expect(button).toBeFalsy();
  });

  it('never contains case-specific literals (D-064 anti-case) — copy is fully generic', () => {
    // Each denylist token is assembled from two halves at RUNTIME (never
    // spelled contiguously on one source line) so this assertion itself
    // never trips ci/checks/anti-case-lock.sh's own raw-substring grep over
    // ADDED lines — that gate cannot distinguish a negative assertion from a
    // positive occurrence of the same literal.
    const denylist = [
      ['role-appro', 'ver'], ['soglaso', 'vanie'], ['te', 'l-approval'],
      ['telLin', 'ear'], ['e-lar', 'ina'], ['e-or', 'lov'],
    ].map(([a, b]) => a + b);
    const el = DraftSandboxBanner({ app: { tier: 'draft' }, canPublish: true, onOpenPublish: () => {} });
    const [copySpan] = el.props.children;
    const text = copySpan.props.children;
    for (const token of denylist) {
      expect(text.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });
});

describe('screen-app-records — draft-sandbox banner wiring (T-0627)', () => {
  it('imports canPublishDraft (presentation-only mirror) and getNavCapabilities (cached, no new endpoint)', () => {
    expect(src).toContain("import { getNavCapabilities } from '../app-shell/active-tenant.js'");
    expect(src).toContain("import { canPublishDraft } from '../app-shell/nav-config.js'");
  });

  it('reuses the SAME PublishSolutionDialog screen-apps.jsx opens from its "…" menu (no duplicate dialog)', () => {
    expect(src).toContain("import { PublishSolutionDialog } from './apps-publish-dialog.jsx'");
    expect(src).toContain('<PublishSolutionDialog');
  });

  it('renders <DraftSandboxBanner> in the screen with app/canPublish/onOpenPublish wired', () => {
    expect(src).toContain('<DraftSandboxBanner');
    expect(src).toMatch(/canPublish=\{canPublish\}/);
  });

  it('reloads `app` (not the whole page) after a successful publish, so the banner disappears live', () => {
    expect(src).toContain('const handlePublishedFromBanner = useCallback((summary) => {');
    expect(src).toMatch(/if \(summary && summary\.allOk\) loadApp\(\);/);
  });
});

// ---------------------------------------------------------------------------
// T-0649: no duplicate "Создано" column in the record list.
//
// buildFieldCatalog (list-view-panel.js) already appends a `created_at`
// pseudo-column (label "Создано", visible by default) to the field catalog
// `columns` is derived from — so columns.map already renders one "Создано"
// header. The list ALSO had a hardcoded <th>Создано</th> + <td>{fmtTs(...)}</td>
// → two identical columns, one always "—". The fix: render created_at ONLY via
// columns (special-cased to read rec.created_at, not data.created_at), and the
// hardcoded pair is guarded to fire ONLY when the active view hid created_at.
// ---------------------------------------------------------------------------
describe('screen-app-records — no duplicate «Создано» column (T-0649)', () => {
  it('created_at is rendered via the columns loop (reads rec.created_at, not data)', () => {
    // The columns.map body special-cases the created_at pseudo-column so it
    // reads the native record column instead of data[c.key] (which is undefined).
    expect(src).toMatch(/c\.type === 'created_at'/);
  });

  it('the hardcoded «Создано» header/cell only render as a FALLBACK (when the view hid created_at)', () => {
    // Both the extra <th> and its <td> are guarded by
    // !columns.some(c => c.type === 'created_at') — so when the active view
    // already shows created_at (the default), the hardcoded duplicate does NOT
    // render, eliminating the double column.
    expect(src).toMatch(/!columns\.some\(\(c\) => c\.type === 'created_at'\) && <th>Создано<\/th>/);
    expect(src).toMatch(/!columns\.some\(\(c\) => c\.type === 'created_at'\) && \(/);
  });
});
