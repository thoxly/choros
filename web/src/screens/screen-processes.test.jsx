/**
 * web/src/screens/screen-processes.test.jsx — T-0735 (T-0654-b)
 *
 * Source-presence wiring tests (project convention: vitest "node" env, no React
 * mount — see screen-app-records.test.jsx / screen-process-instance.test.jsx). The
 * grid's load-bearing PURE logic (query building, pagination, options) is tested
 * behaviorally in screen-processes.logic.test.js; here we assert the grid CONSUMES
 * it and wires the part-A contract + the anti-uuid / OBLIK invariants.
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');
const screenPath = path.default.resolve(new URL(import.meta.url).pathname, '../screen-processes.jsx');
const src = fs.default.readFileSync(screenPath, 'utf-8');

// Isolate the operator-grid component (ProcessesScreen) from the catalog section
// below it, so the assertions describe the grid, not the retained catalog.
const gridIdx = src.indexOf('function ProcessesScreen');
const gridSrc = src.slice(gridIdx);

describe('screen-processes grid — consumes the part-A query pipeline (T-0735)', () => {
  it('imports the pure grid logic module', () => {
    expect(src).toContain("from './screen-processes.logic.js'");
    expect(src).toContain('buildProcessesQuery');
    expect(src).toContain('PROCESSES_COLUMNS');
    expect(src).toContain('PROCESSES_PAGE_SIZE');
  });

  it('AC-B2: builds the GET /api/processes query from filter state (not a bare unfiltered read)', () => {
    expect(gridSrc).toMatch(/buildProcessesQuery\(\{[^}]*q,[^}]*definition,[^}]*status,[^}]*startedFrom,[^}]*startedTo,[^}]*mine/s);
    expect(gridSrc).toMatch(/fetch\(`\/api\/processes\?\$\{qs\.toString\(\)\}`/);
  });

  it('AC-B2: renders the five server controls (search / definition / status / date range / «мои»)', () => {
    expect(gridSrc).toContain('Поиск по процессам');
    expect(gridSrc).toContain('Любое определение');
    expect(gridSrc).toContain('Любой статус');
    expect(gridSrc).toMatch(/type="date"/);
    expect(gridSrc).toMatch(/setMine\(\(m\) => !m\)/);
  });

  it('AC-B2: the search input is debounced (250ms), non-text filters reload immediately', () => {
    expect(gridSrc).toMatch(/setTimeout\(\(\) => \{ load\(\); \}, 250\)/);
    expect(gridSrc).toMatch(/\}, \[definition, status, startedFrom, startedTo, mine\]\)/);
  });

  it('AC-B3: pagination reads {total,limit,offset} and offers «Показать ещё»', () => {
    expect(gridSrc).toMatch(/data\.total/);
    expect(gridSrc).toMatch(/data\.offset/);
    expect(gridSrc).toContain('Показано {list.length} из {total}');
    expect(gridSrc).toContain('Показать ещё');
    expect(gridSrc).toMatch(/const hasMore = list\.length < total/);
  });

  it('AC-B3: load-more appends the next page (offset += PAGE_SIZE), bound to the request token', () => {
    expect(gridSrc).toMatch(/offset \+ PROCESSES_PAGE_SIZE/);
    expect(gridSrc).toMatch(/setInstances\(\(prev\) => \[\.\.\.\(prev \|\| \[\]\)/);
  });

  it('AC-B4: the starter is rendered BY NAME via ActorChip (not just a type glyph)', () => {
    expect(gridSrc).toMatch(/<ActorChip type=\{inst\.starterType \|\| 'human'\} name=\{inst\.starterName\} id=\{inst\.starterId\} \/>/);
  });

  it('AC-B1: columns come from PROCESSES_COLUMNS + an always-present action column', () => {
    expect(gridSrc).toMatch(/PROCESSES_COLUMNS\.map\(\(c\) => <th key=\{c\.key\}>\{c\.label\}<\/th>\)/);
    expect(gridSrc).toContain('Действие');
  });

  it('AC-B1: density (comfortable|compact) toggles the table class + persists via user_pref', () => {
    expect(src).toContain("import { getAllUserPrefs, setUserPref } from '../app-shell/user-prefs-api.js'");
    expect(gridSrc).toMatch(/chs-itable\$\{view\.density === 'compact' \? ' chs-itable--compact' : ''\}/);
    expect(gridSrc).toMatch(/setUserPref\(PROCESSES_VIEW_PREF_KEY, next\)/);
  });

  it('AC-B5: honest Loading / Error / Empty states (kit primitives)', () => {
    expect(gridSrc).toContain('<LoadingState');
    expect(gridSrc).toContain('<ErrorState');
    expect(gridSrc).toContain('<EmptyState');
    // a filtered-to-nothing list gets a DIFFERENT empty state (with «Сбросить фильтры»)
    // than a genuinely empty tenant.
    expect(gridSrc).toContain('Ничего не найдено');
    expect(gridSrc).toContain('Сбросить фильтры');
    expect(gridSrc).toMatch(/hasActiveProcessFilter/);
  });
});

describe('screen-processes grid — anti-uuid / anti-case (D-064)', () => {
  it('the raw instance UUID is NOT rendered as a grid column (find-by-name journey)', () => {
    // The pre-T-0735 grid had a dedicated <td><MonoId>{inst.id}</MonoId></td> instance
    // column. The operator-grid must not surface the raw instance id at all.
    expect(gridSrc).not.toMatch(/<MonoId>\{inst\.id\}<\/MonoId>/);
  });

  it('the source record is a RecordRef (resolves a TITLE + link), never a bare id', () => {
    expect(gridSrc).toMatch(/<RecordRef recordId=\{inst\.recordId\}/);
  });

  it('anti-case: no process/domain slug literal leaked into the grid render', () => {
    // The grid must be generic over ANY process — no case constant (telLinear,
    // а specific process name/slug) baked into the component.
    expect(gridSrc).not.toMatch(/telLinear|purchaseApproval|novyy-protsess/);
  });
});

describe('screen-processes — Каталог section retained until T-0654-c (AC-B6 deferred)', () => {
  it('keeps ProcessCatalogSection mounted (removing it before its new home would orphan it)', () => {
    expect(src).toContain('<ProcessCatalogSection />');
    // documented as a deliberate deferral, not a silent miss.
    expect(src).toMatch(/T-0654-c/);
  });
});
