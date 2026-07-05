/**
 * web/src/screens/kanban-board.jsx.test.js — T-0582 (kanban view) structural
 * wiring tests.
 *
 * Mirrors the project convention (list-view-panel.test.jsx, screen-app-records.
 * test.jsx): vitest "node" environment, no React mount — assertions run
 * against the .jsx SOURCE TEXT for wiring/contract facts that are awkward to
 * assert via a headless DOM render in this project's node-only test tier. The
 * load-bearing PURE logic (column building, move payload, draft<->config) is
 * exercised behaviourally in kanban-board.test.js.
 *
 * What this file proves:
 *   FF-K-3 — the ONLY write path a move ever calls is PUT /api/records/:id
 *            (no new endpoint like /api/kanban/* or /api/records/:id/field).
 *   FF-K-4 — no direct SQL / new read endpoint; the board is fed `records`
 *            from the SAME GET /api/records the table view already uses
 *            (wired in screen-app-records.jsx, not re-fetched here).
 *   AC-7   — keyboard alternative: a focusable <select> "Колонка" control
 *            exists per-card (not drag-only).
 *   AC-6   — optimistic move + ROLLBACK on non-2xx (onLocalUpdate called with
 *            the PREVIOUS data on failure).
 *   AC-9   — empty columns render an explicit EmptyState (never omitted).
 *   NF-6   — kit Card/Badge/Button/EmptyState/LoadingState/ErrorState only,
 *            no drag-and-drop library import, native draggable/onDragStart.
 *   G6     — no raw hex/rgba color literal (--chs-* tokens only).
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');

function readSibling(name) {
  const filePath = path.default.resolve(new URL(import.meta.url).pathname, `../${name}`);
  return fs.default.readFileSync(filePath, 'utf-8');
}

const boardSrc = readSibling('kanban-board.jsx');
const screenSrc = readSibling('screen-app-records.jsx');
const panelSrc = readSibling('list-view-panel.jsx');

describe('FF-K-3: kanban-board.jsx never invents a new write path', () => {
  it('does not fetch any /api/kanban/* endpoint', () => {
    expect(boardSrc).not.toMatch(/\/api\/kanban/);
  });
  it('does not fetch a per-field write endpoint (/api/records/:id/field)', () => {
    expect(boardSrc).not.toMatch(/\/api\/records\/[^"'`]*\/field/);
  });
  it('kanban-board.jsx itself performs no fetch (move goes through the injected onMoveRecord prop)', () => {
    expect(boardSrc).not.toMatch(/\bfetch\(/);
  });
});

describe('FF-K-3: screen-app-records.jsx wires the move handler to the EXISTING record-write PUT', () => {
  it('handleMoveRecord PUTs /api/records/:id (the same path record edit uses)', () => {
    expect(screenSrc).toMatch(/PUT/);
    expect(screenSrc).toContain('/api/records/${encodeURIComponent(recordId)}');
  });
  it('does not introduce a second record-field write endpoint', () => {
    expect(screenSrc).not.toMatch(/\/api\/kanban/);
  });
});

describe('AC-7/FR-8: keyboard alternative to drag (WCAG 2.1.1)', () => {
  it('every card renders a focusable "Колонка" <select> that fires onMove on change', () => {
    expect(boardSrc).toMatch(/aria-label=\{`Переместить/);
    expect(boardSrc).toMatch(/onChange=\{handleMoveSelect\}/);
  });
  it('drag (draggable/onDragStart) IS present but is not the only path — a keyboard control exists alongside it', () => {
    expect(boardSrc).toMatch(/draggable/);
    expect(boardSrc).toMatch(/onDragStart/);
    expect(boardSrc).toMatch(/<select/); // the keyboard fallback control
  });
});

describe('AC-6: optimistic move + rollback on non-2xx', () => {
  it('applies the move locally BEFORE awaiting the server response (optimistic)', () => {
    expect(boardSrc).toMatch(/onLocalUpdate\(record\.id, payload\.data\)/);
  });
  it('rolls back to the PREVIOUS data when onMoveRecord resolves not-ok', () => {
    expect(boardSrc).toMatch(/if \(!result\.ok\)/);
    expect(boardSrc).toMatch(/onLocalUpdate\(record\.id, previousData\)/);
  });
  it('surfaces an honest error message on rollback (role="alert")', () => {
    expect(boardSrc).toMatch(/role="alert"/);
    expect(boardSrc).toMatch(/setMoveError/);
  });
});

describe('AC-8: required group_by_field cannot be cleared to "без значения"', () => {
  it('buildMovePayload is called with groupByRequired threaded through', () => {
    expect(boardSrc).toMatch(/buildMovePayload\(record, groupByField, newValue, groupByRequired\)/);
  });
});

describe('AC-9: empty columns render explicitly (never disappear)', () => {
  it('renders <EmptyState> when a column has zero cards', () => {
    expect(boardSrc).toMatch(/column\.cards\.length === 0/);
    expect(boardSrc).toMatch(/<EmptyState/);
  });
  it('column header always shows a count Badge regardless of card count', () => {
    expect(boardSrc).toMatch(/<Badge tone="neutral">\{column\.cards\.length\}<\/Badge>/);
  });
});

describe('ARIA: board/column/card roles (FR-8)', () => {
  it('the board root is role="list" with an aria-label', () => {
    expect(boardSrc).toMatch(/role="list"\s*\n\s*aria-label="Колонки доски"/);
  });
  it('each column carries role="group" with a name+count aria-label', () => {
    expect(boardSrc).toMatch(/role="group"[\s\S]{0,120}aria-label=\{`\$\{column\.label\} · \$\{column\.cards\.length\}`\}/);
  });
  it('cards render inside role="listitem"/"list" containers', () => {
    expect(boardSrc).toMatch(/role="listitem"/);
    expect(boardSrc).toMatch(/role="list"/);
  });
});

describe('NF-6: kit-only + no drag-and-drop LIBRARY (native HTML5 DnD only)', () => {
  it('imports only kit components from components.jsx', () => {
    expect(boardSrc).toMatch(/from '\.\.\/components\/components\.jsx'/);
  });
  it('does not import a third-party drag-and-drop library', () => {
    expect(boardSrc).not.toMatch(/react-dnd|dnd-kit|@hello-pangea/);
  });
  it('does not contain a raw hex/rgba color literal (tokens only, G2/G6)', () => {
    expect(boardSrc).not.toMatch(/rgba\(|#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([^0-9a-fA-F]|$)/);
  });
});

describe('T-0626: empty card_fields falls back to deriveRecordLabel, not a raw UUID', () => {
  it('imports deriveRecordLabel from records-form.js and resolveCardLabel from kanban-board.js (reuses the platform convention, no second implementation)', () => {
    expect(boardSrc).toMatch(/import \{ formatCellValue, computeComputedFieldValue, deriveRecordLabel \} from '\.\/records-form\.js';/);
    expect(boardSrc).toMatch(/resolveCardLabel/);
    expect(boardSrc).toMatch(/from '\.\/kanban-board\.js';/);
  });
  it('cardLabel is computed via resolveCardLabel, threading deriveRecordLabel through as the empty-card_fields fallback', () => {
    expect(boardSrc).toMatch(/const cardLabel = resolveCardLabel\(\s*\n\s*record, fields, fieldMetaByKey, formatCellValue, computeComputedFieldValue, deriveRecordLabel,\s*\n\s*\);/);
  });
});

describe("T-0626 FF-K: resolveCardLabel's fallback contract (source-level; behaviour proven in kanban-card-label.test.js)", () => {
  const boardJsSrc = readSibling('kanban-board.js');
  it('resolveCardLabel: empty card_fields returns deriveRecordLabelFn(record), never a raw id slice', () => {
    expect(boardJsSrc).toMatch(/if \(fields\.length === 0\) \{\s*\n\s*return deriveRecordLabelFn\(record\);/);
  });
  it('resolveCardLabel is exported (unit-testable pure function, no React/hooks)', () => {
    expect(boardJsSrc).toMatch(/export function resolveCardLabel\(/);
  });
});

describe("D-064 anti-case: kanban-board.jsx/.js carry no business-domain vocabulary", () => {
  const FORBIDDEN = [/сделк/i, /стади/i, /воронк/i, /\bdeal\b/i, /\bstage\b/i, /\bpipeline\b/i, /\bCRM\b/];
  it('kanban-board.jsx is generic', () => {
    for (const re of FORBIDDEN) expect(boardSrc).not.toMatch(re);
  });
});

describe('list-view-panel.jsx: kanban integration wiring', () => {
  it('sends type to saveView on create', () => {
    expect(panelSrc).toMatch(/type: activeView \? activeView\.type : viewType/);
  });
  it('offers a type picker with list/kanban options for a NEW view', () => {
    expect(panelSrc).toMatch(/<option value="kanban">Канбан-доска<\/option>/);
  });
  it('renders the kanban-specific editor only when viewType is kanban', () => {
    expect(panelSrc).toMatch(/viewType === 'kanban'/);
    expect(panelSrc).toMatch(/<KanbanConfigEditor/);
  });
  it('reuses the SAME FiltersEditor/SortEditor components for kanban mode (no duplicate editors)', () => {
    const kanbanBlockMatch = panelSrc.match(/\{viewType === 'kanban' \? \([\s\S]{0,1600}/);
    expect(kanbanBlockMatch).toBeTruthy();
    expect(kanbanBlockMatch[0]).toMatch(/<FiltersEditor/);
    expect(kanbanBlockMatch[0]).toMatch(/<SortEditor/);
    expect(kanbanBlockMatch[0]).toMatch(/<KanbanConfigEditor/);
  });
});

describe('screen-app-records.jsx: kanban display-mode branch', () => {
  it('branches to <KanbanBoard> when activeView.type === "kanban"', () => {
    expect(screenSrc).toMatch(/isKanban = Boolean\(activeView && activeView\.type === 'kanban'\)/);
    expect(screenSrc).toMatch(/<KanbanBoard/);
  });
  it('does NOT change the GET /api/records fetch shape based on view type (FF-K-4: same read path)', () => {
    // The records fetch (loadRecords) must not branch on isKanban.
    const loadRecordsBlock = screenSrc.match(/const loadRecords = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/);
    expect(loadRecordsBlock).toBeTruthy();
    expect(loadRecordsBlock[0]).not.toMatch(/isKanban/);
  });
});
