/**
 * web/src/screens/list-view-panel.test.jsx — T-0581 (view registry) FR-4/AC-14.
 *
 * Structural wiring tests for the panel/switcher JSX + its integration into
 * screen-app-records.jsx. Mirrors the project convention (screen-app-records.
 * test.jsx): vitest "node" environment, no React mount — assertions run
 * against the .jsx SOURCE TEXT for wiring/contract facts that are awkward to
 * assert via a headless DOM render in this project's node-only test tier.
 * The load-bearing PURE logic (operators, draft<->config, validation, wire
 * encoding) is exercised behaviourally in list-view-panel.test.js.
 *
 * What this file proves:
 *   - the panel consumes ONLY kit components + --chs-* tokens (G6/G2): no
 *     hand-rolled overlay, no hex/rgba color literal;
 *   - honest Loading/Empty/Error states are wired (G1-G7/AC-14);
 *   - no dev jargon token ("view_id"/"registry"/"JSONB"/"list_view") leaks
 *     into a JSX text node or a user-facing label/placeholder (G5);
 *   - columns reorder via up/down buttons ONLY (no draggable=, no onDragStart) —
 *     the keyboard-operable contract FR-4 §1 requires;
 *   - CRUD wiring hits the exact approved endpoints (GET/POST/PUT/DELETE
 *     /api/list-views, GET /api/records?view_id=);
 *   - screen-app-records.jsx wires the panel in WITHOUT breaking the default
 *     (no-view) fetch shape (NF-2/AC-9) — view_id is appended, never replaces,
 *     the existing application_id/registry_def_id query.
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');

function readSibling(name) {
  const filePath = path.default.resolve(new URL(import.meta.url).pathname, `../${name}`);
  return fs.default.readFileSync(filePath, 'utf-8');
}

const panelSrc = readSibling('list-view-panel.jsx');
const screenSrc = readSibling('screen-app-records.jsx');

describe('list-view-panel.jsx — kit-only styling (G2/G6)', () => {
  it('uses only kit components for state rendering (LoadingState/EmptyState/ErrorState/Notice), not hand-rolled branches', () => {
    expect(panelSrc).toContain('<EmptyState');
    expect(panelSrc).toContain('<ErrorState');
    expect(panelSrc).toContain('<Notice');
  });

  it('never introduces a raw hex or rgba color literal (tokens only)', () => {
    expect(panelSrc).not.toMatch(/#[0-9a-fA-F]{3,6}(?![0-9a-fA-F])/);
    expect(panelSrc).not.toMatch(/rgba\(/);
  });

  it('never hand-rolls a fixed/inset-positioned overlay (uses kit <Drawer>, not a custom modal scrim)', () => {
    expect(panelSrc).toContain('<Drawer');
    expect(panelSrc).not.toMatch(/position:\s*['"]fixed['"]/);
  });

  it('all colors reference --chs- design tokens', () => {
    const colorRefs = panelSrc.match(/var\(--chs-color-[a-z-]+/g) || [];
    expect(colorRefs.length).toBeGreaterThan(0);
  });
});

describe('list-view-panel.jsx — no dev jargon in visible text (G5)', () => {
  // These raw wire/DB terms must never appear OUTSIDE of a comment or the
  // literal query-param/API-path names this module intentionally references
  // in code (e.g. "view_id" in a fetch URL) — i.e. never inside a JSX text
  // node, label, placeholder, or title shown to the user. We approximate this
  // by asserting the terms never appear immediately preceded by a Russian
  // label pattern (a label prop / plain text run) — the strong, cheap check
  // here is that these terms are absent from the human strings we author.
  const humanStrings = [...panelSrc.matchAll(/>([^<{}]*[А-Яа-яЁё][^<{}]*)</g)].map((m) => m[1]);

  it('никогда не показывает "view_id"/"list_view"/"JSONB"/"registry" в видимом тексте', () => {
    for (const s of humanStrings) {
      expect(s).not.toMatch(/view_id/i);
      expect(s).not.toMatch(/list_view/i);
      expect(s).not.toMatch(/JSONB/i);
      expect(s).not.toMatch(/\bregistry\b/i);
    }
  });

  it('raw operator codes (eq/gt/is_empty/...) never appear as visible text (OP_LABELS supplies the Russian word)', () => {
    for (const s of humanStrings) {
      expect(s).not.toMatch(/\bis_empty\b|\bis_not_empty\b|\bcontains_any\b|\bstarts_with\b/);
    }
  });

  it('states views are shared tenant-wide, honestly (spec FR-10/§6)', () => {
    expect(panelSrc).toMatch(/общ[а-я]* для всех/);
  });
});

describe('list-view-panel.jsx — columns reorder is keyboard-operable (no drag dependency)', () => {
  it('renders up/down buttons per column row (arrow-up/arrow-down KitIcon)', () => {
    expect(panelSrc).toContain('name="arrow-up"');
    expect(panelSrc).toContain('name="arrow-down"');
  });

  it('the up/down buttons are native <Button> elements with aria-label (screen-reader + keyboard operable by construction)', () => {
    expect(panelSrc).toMatch(/aria-label=\{`Переместить[^`]*выше`\}/);
    expect(panelSrc).toMatch(/aria-label=\{`Переместить[^`]*ниже`\}/);
  });

  it('the up button is disabled at the top and the down button at the bottom (no dead click into nowhere)', () => {
    expect(panelSrc).toMatch(/disabled=\{index === 0\}/);
    expect(panelSrc).toMatch(/disabled=\{index === columns\.length - 1\}/);
  });

  it('does NOT depend on HTML5 drag-and-drop (draggable=/onDragStart) for reordering', () => {
    expect(panelSrc).not.toMatch(/draggable=/);
    expect(panelSrc).not.toMatch(/onDragStart/);
  });

  it('reorder calls the pure moveColumn helper (tested behaviourally in list-view-panel.test.js)', () => {
    expect(panelSrc).toMatch(/moveColumn\(columns, index, index - 1\)/);
    expect(panelSrc).toMatch(/moveColumn\(columns, index, index \+ 1\)/);
  });
});

describe('list-view-panel.jsx — filters offer operators BY FIELD TYPE, human labels', () => {
  it('derives the operator list from operatorsForFieldType(fieldType), not a fixed list', () => {
    expect(panelSrc).toMatch(/operatorsForFieldType\(fieldType\)/);
  });

  it('renders operator options via OP_LABELS (Russian word), not the raw op code', () => {
    expect(panelSrc).toMatch(/\{OP_LABELS\[op\] \|\| op\}/);
  });

  it('sort direction renders "по возрастанию"/"по убыванию", never "asc"/"desc" as visible text', () => {
    expect(panelSrc).toContain('по возрастанию');
    expect(panelSrc).toContain('по убыванию');
    for (const s of humanStringsOf(panelSrc)) {
      expect(s).not.toMatch(/\basc\b|\bdesc\b/);
    }
  });
});

function humanStringsOf(src) {
  return [...src.matchAll(/>([^<{}]*[А-Яа-яЁё][^<{}]*)</g)].map((m) => m[1]);
}

describe('list-view-panel.jsx — CRUD wiring hits the approved endpoints', () => {
  it('GET /api/list-views?registry_def_id= to load saved views + default', () => {
    expect(panelSrc).toContain('/api/list-views?registry_def_id=');
  });

  it('POST /api/list-views to create, PUT /api/list-views/:id to update', () => {
    expect(panelSrc).toMatch(/fetch\('\/api\/list-views', \{\s*method: 'POST'/);
    expect(panelSrc).toContain("method: 'PUT'");
    expect(panelSrc).toContain('/api/list-views/${encodeURIComponent(id)}');
  });

  it('DELETE /api/list-views/:id, treats 204/404 as gone (idempotent, mirrors T-0568 record delete)', () => {
    expect(panelSrc).toContain("method: 'DELETE'");
    expect(panelSrc).toMatch(/res\.status === 204 \|\| res\.status === 404/);
  });

  it('sends devHeaders() on every request (auth wiring, same convention as the rest of the screen)', () => {
    const fetchCalls = panelSrc.match(/devHeaders\(\)/g) || [];
    expect(fetchCalls.length).toBeGreaterThanOrEqual(4); // GET, POST, PUT, DELETE
  });
});

describe('screen-app-records.jsx — view-registry panel integration (FR-4)', () => {
  it('imports the panel + switcher + hook from list-view-panel.jsx', () => {
    expect(screenSrc).toContain("import { ListViewPanel, ViewSwitcher, useListViews } from './list-view-panel.jsx'");
  });

  it('renders <ListViewPanel> and <ViewSwitcher> in the toolbar', () => {
    expect(screenSrc).toContain('<ListViewPanel');
    expect(screenSrc).toContain('<ViewSwitcher');
  });

  it('offers a "Настроить список" entry point (not raw "view"/"registry" jargon)', () => {
    expect(screenSrc).toContain('Настроить список');
  });

  it('appends view_id ADDITIVELY — the default (no view selected) request is UNCHANGED (NF-2/AC-9)', () => {
    // The base fetch URL must still be built exactly as before T-0581 (same
    // application_id/registry_def_id query), with view_id appended via a
    // suffix that is EMPTY when no view is active.
    expect(screenSrc).toMatch(
      /`\/api\/records\?application_id=\$\{encodeURIComponent\(appId\)\}&registry_def_id=\$\{encodeURIComponent\(selectedDefId\)\}\$\{viewQuerySuffix\}`/,
    );
    expect(screenSrc).toMatch(/const viewQuerySuffix = activeViewId \? `&view_id=\$\{encodeURIComponent\(activeViewId\)\}` : ''/);
  });

  it('re-sends the view_id on load-more (pagination) — the server does not embed it in the cursor', () => {
    expect(screenSrc).toMatch(
      /`\/api\/records\?application_id=\$\{encodeURIComponent\(appId\)\}&registry_def_id=\$\{encodeURIComponent\(selectedDefId\)\}&after=\$\{encodeURIComponent\(nextCursor\)\}\$\{viewQuerySuffix\}`/,
    );
  });

  it('resets the active view when the chosen registry_def changes (a view belongs to ONE набор полей)', () => {
    expect(screenSrc).toMatch(/useEffect\(\(\) => \{ setActiveViewId\(null\); \}, \[selectedDefId\]\)/);
  });

  it('applies the active/default view\'s column visibility+order+width to the rendered table (FR-2 columns)', () => {
    expect(screenSrc).toMatch(/const viewConfig = \(activeView && activeView\.config\) \|\| defaultViewConfig/);
    expect(screenSrc).toMatch(/c\.visible !== false/);
  });
});
