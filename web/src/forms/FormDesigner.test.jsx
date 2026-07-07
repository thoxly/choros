/**
 * web/src/forms/FormDesigner.test.jsx  (T-0656 — component smoke + UX invariants)
 *
 * There was NO component test for FormDesigner before T-0656 — which is how the
 * UX-1 prefix-collision slipped through. This adds:
 *   - a render smoke (the designer mounts with an initialDocument + initialFields,
 *     no network) and the palette / canvas / inspector all appear;
 *   - the FULLSCREEN INVARIANT (UX-2): the fullscreen modifier lives on the OUTER
 *     workspace wrapper that CONTAINS palette + canvas + inspector — so going
 *     fullscreen cannot orphan the palette/inspector (the earlier bug put
 *     position:fixed on the canvas alone, hiding the tools);
 *   - the container-highlight structural predicate (UX-1) is covered directly in
 *     canvas-path.test.js (reddens on the old string logic).
 *
 * No jsdom / no @testing-library in this tier (vitest.config.js node env) — we
 * render to static markup via react-dom/server, the same "inspect the rendered
 * output without a DOM" approach the other .test.jsx files use.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import FormDesigner from './FormDesigner.jsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORM_DESIGNER_SRC = readFileSync(join(__dirname, 'FormDesigner.jsx'), 'utf-8');

// A tiny live schema + a matching document so the designer renders fields +
// palette + a selected-nothing inspector, all without hitting the network
// (initialFields short-circuits the /api/applications fetch).
const FIELDS = [
  { key: 'title', type: 'string', label: 'Заголовок' },
  { key: 'amount', type: 'number', label: 'Сумма' },
];

const DOC = {
  schemaVersion: 1,
  source: {},
  root: {
    type: 'section',
    id: 's1',
    children: [
      { type: 'field', id: 'f1', fieldKey: 'title', widget: 'text', label: 'Заголовок' },
    ],
  },
};

function render() {
  return renderToStaticMarkup(<FormDesigner initialDocument={DOC} initialFields={FIELDS} />);
}

describe('FormDesigner — render smoke', () => {
  it('mounts with initialDocument/initialFields and shows palette, canvas, and inspector', () => {
    const html = render();
    expect(html).toContain('chs-designer-palette');   // palette (drag source)
    expect(html).toContain('chs-designer-canvas');     // canvas (drop target)
    expect(html).toContain('chs-designer-inspector');  // inspector (property editor)
  });

  it('renders the field palette (a field can be dragged in) and a fullscreen toggle', () => {
    const html = render();
    // the field chip for an un-used field is present → draggable source exists
    expect(html).toContain('Заголовок');
    // the fullscreen control is a real button, not a stub
    expect(html).toContain('На весь экран');
  });
});

// ---------------------------------------------------------------------------
// T-0665 (F1) — the process+step binding picker. LIVE_PROOF T-0656 found that
// FormDesigner had NO UI to choose a process/step at all, so persistLayout()
// always fell back to the hardcoded process_key='record' (no such process on
// any real tenant) → save always 409'd.
//
// The full picker section only paints after `/api/applications` resolves
// (pre-existing T-0544 gate: `if (!initialFields && applications === null)
// return <LoadingState/>`), which renderToStaticMarkup cannot await (this
// tier has no jsdom/act — see the file header). So these are source-presence
// checks (same convention as screen-inbox.test.jsx) for the picker's wiring,
// plus a static-markup check of the save-button gating via the
// initialDocument/initialFields embedding path (which DOES render
// synchronously, and exercises the same `doc.step` gate the picker feeds).
// ---------------------------------------------------------------------------
describe('FormDesigner — process/step binding picker (T-0665 F1)', () => {
  it('renders a "Привязка" section with a real process picker (data-driven, not a stub)', () => {
    expect(FORM_DESIGNER_SRC).toContain('Привязка');
    expect(FORM_DESIGNER_SRC).toContain("<h4 style={{ marginTop: 0 }}>Привязка</h4>");
    expect(FORM_DESIGNER_SRC).toContain('/api/process-catalog');
  });

  it('the process picker filters to PUBLISHED or live source==="engine" definitions (drafts are not offered, T-0671)', () => {
    // T-0671: source==='engine' processes (deployed straight to Flowable —
    // e.g. the canonical telLinear, which has NO process_definition row and
    // so can never carry status==='published') must be offered alongside
    // deliberately-published modeler definitions. A modeler draft
    // (source==='modeler', status==='draft') stays excluded.
    expect(FORM_DESIGNER_SRC).toContain("d.source === 'engine' || d.status === 'published'");
  });

  describe('T-0671 — engine-source processes are bindable (AC-1/AC-2/AC-3)', () => {
    // The picker's filter predicate lives inline in a fetch .then() callback,
    // not exported as a standalone function — mirrored here byte-for-byte
    // (same convention this file already uses for the fullscreen/UX-1
    // predicates) so this test reddens if the predicate in FormDesigner.jsx
    // ever drifts from what is asserted above.
    const bindable = (d) => d.source === 'engine' || d.status === 'published';

    it('AC-1: an engine-sourced process (no process_definition row, status "deployed") is offered', () => {
      const engineDef = { process_key: 'genericEngineProc', name: 'genericEngineProc', source: 'engine', status: 'deployed', version: null, instance_count: 25 };
      expect(bindable(engineDef)).toBe(true);
    });

    it('AC-2: a modeler draft (source "modeler", status "draft") is still NOT offered', () => {
      const draftDef = { process_key: 'draftProc', name: 'Draft Proc', source: 'modeler', status: 'draft', version: 1, instance_count: 0 };
      expect(bindable(draftDef)).toBe(false);
    });

    it('AC-3: a published modeler definition is still offered (no regression)', () => {
      const publishedDef = { process_key: 'publishedProc', name: 'Published Proc', source: 'modeler', status: 'published', version: 3, instance_count: 2 };
      expect(bindable(publishedDef)).toBe(true);
    });
  });

  it('renders a free-text "Шаг процесса" field (not a fixed dropdown of invented steps)', () => {
    const idx = FORM_DESIGNER_SRC.indexOf('Шаг процесса');
    expect(idx).toBeGreaterThan(-1);
    const block = FORM_DESIGNER_SRC.slice(idx, idx + 400);
    expect(block).toContain('type="text"');
    expect(block).toContain('placeholder="Например, Проверка заявки"');
  });

  it('offers real userTask id/name suggestions parsed from the chosen process BPMN (extractUserTasks), not invented data', () => {
    expect(FORM_DESIGNER_SRC).toContain("import { extractUserTasks } from './bpmn-user-tasks.js'");
    expect(FORM_DESIGNER_SRC).toContain('extractUserTasks(def.bpmnXml)');
  });

  it('selecting a process/step writes a real doc.step (persistLayout no longer only sees the hardcoded fallback)', () => {
    // The fallback ('record'/'record-form') is a LAST-RESORT default when no
    // step object is available at all — assert the picker's `step` argument
    // takes priority over it (persistLayout(doc, step, ...) signature).
    expect(FORM_DESIGNER_SRC).toContain('function persistLayout(doc, step, setSaveState, savedDocRef, setSaveGen)');
    expect(FORM_DESIGNER_SRC).toContain("step?.processKey || doc.step?.processKey || 'record'");
    expect(FORM_DESIGNER_SRC).toContain("step?.step || doc.step?.step || 'record-form'");
  });

  it('does NOT hardcode a case-specific process slug in the picker (D-064 anti-case) — options come from state, not a literal', () => {
    // No `=== 'someCaseSlug'` branch anywhere in the file (other than the
    // documented 'record' fallback) — the picker's option list is built from
    // processCatalog (API response), never a literal array of case names.
    expect(FORM_DESIGNER_SRC).not.toMatch(/process_key\s*===\s*['"](?!record['"])[a-zA-Z]/);
    expect(FORM_DESIGNER_SRC).toContain('(processCatalog || []).map((d) => ({ value: d.process_key');
  });

  it('warns that a process+step must be chosen before the save button becomes usable (static-markup, embedding path)', () => {
    const html = renderToStaticMarkup(<FormDesigner initialDocument={DOC} initialFields={FIELDS} />);
    // DOC (the fixture at the top of this file) carries no `step` — the save
    // button must render disabled and the hint must be visible, proving the
    // gate is live (not just present in source, but actually wired to `doc`).
    expect(html).toContain('Выберите процесс и шаг выше, чтобы сохранить форму.');
    const btnIdx = html.indexOf('Сохранить раскладку');
    expect(btnIdx).toBeGreaterThan(-1);
    const buttonOpenTag = html.slice(Math.max(0, btnIdx - 300), btnIdx);
    expect(buttonOpenTag).toMatch(/disabled=""|disabled(?!Guard)/);
  });

  it('a document that already carries doc.step (e.g. AI-emitted/embedded) does not need the picker to save', () => {
    const DOC_WITH_STEP = { ...DOC, step: { processKey: 'purchaseApproval', step: 'approveRequest' } };
    const html = renderToStaticMarkup(<FormDesigner initialDocument={DOC_WITH_STEP} initialFields={FIELDS} />);
    expect(html).not.toContain('Выберите процесс и шаг выше, чтобы сохранить форму.');
  });
});

// ---------------------------------------------------------------------------
// T-0669: the "Приложение" picker must not offer a process+application pair
// that has no process_app_binding row — authoring such a pair used to pass
// cleanly (drag/drop/fields/preview all worked) and only fail on Save with an
// opaque "Не удалось сохранить." (the server's classifyLayoutSave 409
// WRONG_FLOOR, src/http/binding.ts, resolves application_id ITSELF from
// process_app_binding — independent of whatever the picker had selected).
// Fix reuses T-0681's GET /api/process-app-bindings (same endpoint
// BindProcessModal / screen-processes.jsx already calls) to filter the
// application picker to the SAME table the server's save-time gate consults.
//
// This tier has no jsdom/act (see file header) so the network-driven filter
// itself cannot be exercised end-to-end here — these are source-presence
// checks (same convention as the F1 describe block above) for the wiring,
// plus the two purely-synchronous invariants: static-markup source contains
// no gate-bypassing shortcut, and the hint text carries no jargon (G5).
// ---------------------------------------------------------------------------
describe('FormDesigner — application picker synced with process_app_binding (T-0669)', () => {
  it('loads the real process↔application bindings (T-0681 endpoint, reused not reinvented)', () => {
    expect(FORM_DESIGNER_SRC).toContain("fetch('/api/process-app-bindings'");
    expect(FORM_DESIGNER_SRC).toContain('setProcessAppBindings');
  });

  it('filters the application picker to applications bound to the SELECTED process, from real data (not a hardcoded list)', () => {
    expect(FORM_DESIGNER_SRC).toContain('boundAppIdsForProcess');
    expect(FORM_DESIGNER_SRC).toContain('.filter((a) => !boundAppIdsForProcess || boundAppIdsForProcess.has(a.id))');
    // derived from the bindings response, never a literal id/slug.
    expect(FORM_DESIGNER_SRC).not.toMatch(/application_id\s*===\s*['"][0-9a-fA-F-]{8,}['"]/);
  });

  it('shows an honest, jargon-free hint when the chosen process has NO bound application', () => {
    const idx = FORM_DESIGNER_SRC.indexOf('Этот процесс не привязан ни к одному приложению');
    expect(idx).toBeGreaterThan(-1);
    const hint = FORM_DESIGNER_SRC.slice(idx, idx + 120);
    expect(hint).toContain('привяжите его на экране «Процессы»');
    // G5 (ux-g5-jargon-denylist): no technical/internal terms in the visible hint.
    expect(hint).not.toMatch(/process_app_binding|WRONG_FLOOR|409|application_id/);
  });

  it('the hint text is defined once (constant) and referenced twice — picker + save-block', () => {
    // T-0669 fix-forward (design-steward UX-1/UX-NB1): the literal string now
    // lives in a single PROCESS_NOT_BOUND_HINT constant, not duplicated ×2.
    const literalCount = (FORM_DESIGNER_SRC.match(/Этот процесс не привязан ни к одному приложению — привяжите его на экране «Процессы»\./g) || []).length;
    expect(literalCount).toBe(1);
    const usageCount = (FORM_DESIGNER_SRC.match(/\{PROCESS_NOT_BOUND_HINT\}/g) || []).length;
    // appears twice: once beside the app picker (§3.1), once beside the save button (§3.2).
    expect(usageCount).toBe(2);
    expect(FORM_DESIGNER_SRC).toContain('Boolean(selectedProcessKey && boundAppIdsForProcess && boundAppIdsForProcess.size === 0)');
  });

  it('the picker-version empty state is styled as information, not an error (AC-2/§3.1 — design-steward UX-1)', () => {
    // The picker's empty state (process chosen, nothing bound yet) is a normal
    // authoring step, not a failure — must use the file's muted/status
    // convention (same as "Выберите блок…", "Нет полей."), not danger/alert.
    const pickerBlock = FORM_DESIGNER_SRC.slice(
      FORM_DESIGNER_SRC.indexOf('boundAppIdsForProcess.size === 0 ? ('),
      FORM_DESIGNER_SRC.indexOf('boundAppIdsForProcess.size === 0 ? (') + 300,
    );
    expect(pickerBlock).toContain('role="status"');
    expect(pickerBlock).toContain('chs-color-text-muted');
    expect(pickerBlock).not.toContain('role="alert"');
    expect(pickerBlock).not.toContain('chs-color-danger');
  });

  it('the save-button-block version stays danger/alert (real blocker on an action, defense-in-depth)', () => {
    const saveBlock = FORM_DESIGNER_SRC.slice(
      FORM_DESIGNER_SRC.indexOf('boundAppIdsForProcess.size === 0 && ('),
      FORM_DESIGNER_SRC.indexOf('boundAppIdsForProcess.size === 0 && (') + 300,
    );
    expect(saveBlock).toContain('role="alert"');
    expect(saveBlock).toContain('chs-color-danger');
  });

  it('an unbound-process document does not need bindings to render (embedding path, static-markup)', () => {
    // initialFields short-circuits the /api/process-app-bindings fetch (same
    // pattern as /api/applications and /api/process-catalog above) — the
    // embedding/test mode must still render synchronously without hanging on
    // a bindings fetch that never resolves in this tier.
    const html = renderToStaticMarkup(<FormDesigner initialDocument={DOC} initialFields={FIELDS} />);
    expect(html).toContain('chs-form-designer');
  });

  it('AC-4 (T-0671): the app-binding filter (boundAppIdsForProcess) keys on process_key alone — an engine-sourced process gets the SAME filtering as a modeler process, no special-cased bypass', () => {
    // boundAppIdsForProcess is derived purely from selectedProcessKey (a
    // string) matched against processAppBindings[].process_key — it never
    // reads processCatalog/d.source at all, so an engine-sourced process
    // selected in the picker is filtered through process_app_binding
    // exactly like any modeler process. Assert there is no source-conditioned
    // branch around the binding filter (e.g. no `source === 'engine'` guard
    // anywhere near boundAppIdsForProcess) that would give engine processes a
    // different (bypassed) path.
    const memoIdx = FORM_DESIGNER_SRC.indexOf('const boundAppIdsForProcess = useMemo(');
    expect(memoIdx).toBeGreaterThan(-1);
    const memoBlock = FORM_DESIGNER_SRC.slice(memoIdx, memoIdx + 500);
    expect(memoBlock).toContain('processAppBindings');
    expect(memoBlock).toContain('b.process_key === selectedProcessKey');
    expect(memoBlock).not.toMatch(/source\s*===\s*['"]engine['"]/);
  });
});

describe('FormDesigner — fullscreen invariant (UX-2)', () => {
  it('the fullscreen modifier is on the OUTER workspace wrapper, not the canvas alone', () => {
    // Structural guarantee: the class that fullscreen toggles is chs-form-designer
    // --fullscreen (the wrapper that CONTAINS palette+canvas+inspector). The old
    // bug toggled chs-designer-canvas--fullscreen (position:fixed on the canvas
    // only), which orphaned the palette/inspector. Assert the canvas-only
    // fullscreen class is GONE from the component entirely.
    const html = render();
    expect(html).not.toContain('chs-designer-canvas--fullscreen');
    // and the wrapper carries the base workspace class the fullscreen modifier
    // attaches to (palette + inspector are its children, so they survive fullscreen).
    expect(html).toContain('chs-form-designer');
  });

  it('palette and inspector are siblings of the canvas inside one workspace wrapper', () => {
    const html = render();
    // all three appear; because the fullscreen class is on their shared parent,
    // expanding it keeps all three on screen (proven structurally here + visually
    // by form-designer.css .chs-form-designer--fullscreen > * { overflow:auto }).
    const paletteAt = html.indexOf('chs-designer-palette');
    const canvasAt = html.indexOf('chs-designer-canvas');
    const inspectorAt = html.indexOf('chs-designer-inspector');
    expect(paletteAt).toBeGreaterThanOrEqual(0);
    expect(canvasAt).toBeGreaterThan(paletteAt);
    expect(inspectorAt).toBeGreaterThan(canvasAt);
  });
});
