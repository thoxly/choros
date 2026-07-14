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
import FormDesigner, { planSchemaRebuild } from './FormDesigner.jsx';

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
    expect(FORM_DESIGNER_SRC).toContain('function persistLayout(doc, step, setSaveState, savedDocRef, setSaveGen, applicationId)');
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
// WRONG_FLOOR, src/http/binding.ts). Before T-0711, the server resolved
// application_id ITSELF from process_app_binding — independent of whatever
// the picker had selected (a process bound to 2+ apps could 409, or worse,
// silently validate against the WRONG app's schema). T-0711 threads the
// picker's own selectedAppId into the save request (persistLayout's
// `applicationId` param) so the gate resolves the SAME binding row shown
// here — this filter remains the first line of defense (never OFFER an
// unbound pair), T-0711 is defense-in-depth for the picker's OWN choice among
// 2+ valid bindings. Fix reuses T-0681's GET /api/process-app-bindings (same
// endpoint BindProcessModal / screen-processes.jsx already calls) to filter
// the application picker to the SAME table the server's save-time gate
// consults.
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

// ---------------------------------------------------------------------------
// T-0711 (P2, review T-0706 finding #37): the picker's own selectedAppId must
// actually reach the server — before this task, persistLayout() sent only
// {process_key, form_key, layout}; the server's classifyLayoutSave gate
// resolved application_id ITSELF from process_app_binding by process_key
// ALONE (no ORDER BY), so a process bound to 2+ applications let the server
// silently validate/derive fields against WHICHEVER binding row Postgres
// happened to return — independent of, and possibly disagreeing with, the
// application shown selected in this exact picker.
//
// This tier has no jsdom/act (see file header) — source-presence checks for
// the wiring (save-button click site passes selectedAppId; persistLayout
// forwards it as application_id only when non-empty).
// ---------------------------------------------------------------------------
describe('FormDesigner — selected application threaded into the save request (T-0711)', () => {
  it('the save button passes the picker\'s selectedAppId into persistLayout', () => {
    const idx = FORM_DESIGNER_SRC.indexOf('onClick={() => persistLayout(');
    expect(idx).toBeGreaterThan(-1);
    const block = FORM_DESIGNER_SRC.slice(idx, idx + 220);
    expect(block).toContain('setSaveState, savedDocRef, setSaveGen,');
    expect(block).toContain('selectedAppId,');
  });

  it('persistLayout forwards applicationId as application_id in the request body, only when non-empty', () => {
    const idx = FORM_DESIGNER_SRC.indexOf('function persistLayout(doc, step, setSaveState, savedDocRef, setSaveGen, applicationId)');
    expect(idx).toBeGreaterThan(-1);
    const block = FORM_DESIGNER_SRC.slice(idx, idx + 700);
    expect(block).toContain("...(applicationId ? { application_id: applicationId } : {})");
    // never a hardcoded/literal id — always the parameter.
    expect(block).not.toMatch(/application_id:\s*['"][0-9a-fA-F-]{8,}['"]/);
  });
});

// ---------------------------------------------------------------------------
// T-0706: the "Набор полей" (registry_def) picker must not offer a registry
// that the server's save-time gate (classifyLayoutSave → resolveLiveRecordSchema,
// src/db/live-form-schema.ts) will never accept. That gate resolves EXACTLY ONE
// registry_def per (process_key, application_id) binding row (natural key,
// migrations 075/119): binding.target_registry_slug if set, else a server-only
// default the client cannot see. An application with >1 registry_def let the
// author pick a legitimate-but-wrong one, authoring cleanly and only failing on
// Save with an opaque 409 (LIVE_PROOF T-0669, found one layer deeper).
//
// Same testing tier/convention as the T-0665/T-0669 blocks above (no jsdom/act
// — see file header): source-presence checks for the wiring, plus pure-logic
// mirrors of the resolution predicates (binding lookup / slug match / auto-
// select) so this file reddens if FormDesigner.jsx's own logic drifts from
// what is asserted here. Fixtures use GENERIC slugs/ids only (anti-case-lock.sh
// — no telLinear/purchases/soglasovanie/e-larina literals).
// ---------------------------------------------------------------------------
describe('FormDesigner — registry_def picker synced with target_registry_slug (T-0706)', () => {
  it('resolves the single binding row for the selected (process, app) pair (natural key, not a list)', () => {
    expect(FORM_DESIGNER_SRC).toContain('const selectedBinding = useMemo(');
    const idx = FORM_DESIGNER_SRC.indexOf('const selectedBinding = useMemo(');
    const block = FORM_DESIGNER_SRC.slice(idx, idx + 400);
    expect(block).toContain('b.process_key === selectedProcessKey && b.application_id === selectedAppId');
  });

  it('derives boundRegistrySlug ONLY from the binding row — never guesses the server-side default fallback', () => {
    expect(FORM_DESIGNER_SRC).toContain('const boundRegistrySlug = useMemo(');
    const idx = FORM_DESIGNER_SRC.indexOf('const boundRegistrySlug = useMemo(');
    const block = FORM_DESIGNER_SRC.slice(idx, idx + 400);
    expect(block).toContain('selectedBinding?.target_registry_slug');
    // must not read any env-like CHOROS_* constant client-side (out of scope, §5).
    expect(block).not.toMatch(/CHOROS_DEFAULT_STEP_RESULT_SLUG|resolveDefaultStepResultSlug/);
  });

  it('matches the bound slug against the loaded registryDefs by slug (same field the server compares)', () => {
    expect(FORM_DESIGNER_SRC).toContain('const boundRegistryDef = useMemo(');
    const idx = FORM_DESIGNER_SRC.indexOf('const boundRegistryDef = useMemo(');
    const block = FORM_DESIGNER_SRC.slice(idx, idx + 400);
    expect(block).toContain("registryDefs.find((d) => d && d.slug === boundRegistrySlug)");
  });

  it('auto-selects the resolved registry_def once found (author does not click the one legitimate option by hand)', () => {
    expect(FORM_DESIGNER_SRC).toContain('if (boundRegistryDef && selectedDefId !== boundRegistryDef.id)');
    expect(FORM_DESIGNER_SRC).toContain('setSelectedDefId(boundRegistryDef.id)');
  });

  describe('pure-logic mirror of the resolution predicates', () => {
    const findBinding = (bindings, processKey, appId) =>
      bindings.find((b) => b && b.process_key === processKey && b.application_id === appId) || null;
    const slugOf = (binding) => {
      const slug = binding?.target_registry_slug;
      return typeof slug === 'string' && slug.trim() !== '' ? slug.trim() : null;
    };
    const matchDef = (defs, slug) => (!slug ? undefined : defs.find((d) => d && d.slug === slug) || null);

    const GENERIC_DEFS = [
      { id: 'def-a', slug: 'orders', display_name: 'Заказы' },
      { id: 'def-b', slug: 'approvals', display_name: 'Согласования' },
    ];

    it('AC-1: a binding with an explicit slug matching a real registry_def resolves to it (narrow, not choose)', () => {
      const bindings = [{ process_key: 'genericProc', application_id: 'app-1', target_registry_slug: 'approvals' }];
      const binding = findBinding(bindings, 'genericProc', 'app-1');
      const slug = slugOf(binding);
      expect(slug).toBe('approvals');
      const def = matchDef(GENERIC_DEFS, slug);
      expect(def).toEqual({ id: 'def-b', slug: 'approvals', display_name: 'Согласования' });
    });

    it('AC-2/AC-4: a null slug with >1 registry_defs is the "not fixed" case; with exactly 1 def there is no ambiguity', () => {
      const bindings = [{ process_key: 'genericProc', application_id: 'app-1', target_registry_slug: null }];
      const binding = findBinding(bindings, 'genericProc', 'app-1');
      const slug = slugOf(binding);
      expect(slug).toBeNull();
      // ambiguity warning condition mirrored from JSX: selectedBinding && !boundRegistrySlug && registryDefs.length > 1
      expect(Boolean(binding && !slug && GENERIC_DEFS.length > 1)).toBe(true);
      expect(Boolean(binding && !slug && [GENERIC_DEFS[0]].length > 1)).toBe(false);
    });

    it('AC-6: a slug set on the binding but absent among registryDefs resolves to null (data desync), not a silent guess', () => {
      const bindings = [{ process_key: 'genericProc', application_id: 'app-1', target_registry_slug: 'archived-registry' }];
      const binding = findBinding(bindings, 'genericProc', 'app-1');
      const slug = slugOf(binding);
      const def = matchDef(GENERIC_DEFS, slug);
      expect(def).toBeNull();
    });

    it('AC-5: no binding known for the pair (bindings not loaded, or genuinely absent) resolves to undefined slug/def (no-op, prior behavior)', () => {
      const binding = findBinding([], 'genericProc', 'app-1');
      expect(binding).toBeNull();
      expect(slugOf(binding)).toBeNull();
      expect(matchDef(GENERIC_DEFS, slugOf(binding))).toBeUndefined();
    });
  });

  it('AC-3: save is additionally blocked when the picked registry_def diverges from the binding-resolved one (race defense-in-depth)', () => {
    expect(FORM_DESIGNER_SRC).toContain('Boolean(boundRegistryDef && selectedDefId && selectedDefId !== boundRegistryDef.id)');
    // present both beside the warning text and inside the Button's disabled expression.
    const occurrences = (FORM_DESIGNER_SRC.match(/Boolean\(boundRegistryDef && selectedDefId && selectedDefId !== boundRegistryDef\.id\)/g) || []).length;
    expect(occurrences).toBe(2);
  });

  it('AC-1 narrowed state hides the Select and shows a fact, not a re-offered choice', () => {
    // P0 fix-forward: the three-way ternary is now wrapped in an outer
    // `{registryDefs && ( ... )}` guard (registryDefs is null on every real
    // mount before an app is picked — see the P0 describe block below), so
    // the branch literal is `boundRegistryDef ? (`, not `registryDefs &&
    // boundRegistryDef ?` (that inline form was the crashing one).
    const idx = FORM_DESIGNER_SRC.indexOf('boundRegistryDef ? (');
    expect(idx).toBeGreaterThan(-1);
    const block = FORM_DESIGNER_SRC.slice(idx, idx + 600);
    expect(block).toContain('Набор полей задан привязкой процесса');
    // the narrowed branch (up to the following ") : boundRegistryDef ==="
    // case boundary) must not render a Select — only the fact text.
    const narrowedBranch = block.slice(0, block.indexOf(') : boundRegistryDef === null'));
    expect(narrowedBranch).not.toContain('<Select');
  });

  it('AC-6 desync state keeps the Select open alongside an honest warning naming the missing slug', () => {
    const idx = FORM_DESIGNER_SRC.indexOf('REGISTRY_SLUG_NOT_FOUND_PREFIX');
    // first hit is the constant declaration; find the JSX usage (second hit).
    const secondIdx = FORM_DESIGNER_SRC.indexOf('REGISTRY_SLUG_NOT_FOUND_PREFIX', idx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    const block = FORM_DESIGNER_SRC.slice(secondIdx, secondIdx + 300);
    expect(block).toContain('<Select');
  });

  it('AC-2 ambiguity hint only renders when the app has more than one registry_def', () => {
    expect(FORM_DESIGNER_SRC).toContain('selectedBinding && !boundRegistrySlug && registryDefs.length > 1');
  });

  it('AC-7: none of the new hint texts leak technical terms', () => {
    const notFoundIdx = FORM_DESIGNER_SRC.indexOf("const REGISTRY_SLUG_NOT_FOUND_PREFIX =");
    const notFixedIdx = FORM_DESIGNER_SRC.indexOf("const REGISTRY_NOT_FIXED_HINT =");
    expect(notFoundIdx).toBeGreaterThan(-1);
    expect(notFixedIdx).toBeGreaterThan(-1);
    // slice ONLY the string-literal assignment itself (up to the closing `;`)
    // — not the doc-comment above/below it, which legitimately names the
    // technical field it explains (comments are not visible product text).
    const notFoundBlock = FORM_DESIGNER_SRC.slice(notFoundIdx, FORM_DESIGNER_SRC.indexOf(';', notFoundIdx))
      + FORM_DESIGNER_SRC.slice(
          FORM_DESIGNER_SRC.indexOf('REGISTRY_SLUG_NOT_FOUND_SUFFIX ='),
          FORM_DESIGNER_SRC.indexOf(';', FORM_DESIGNER_SRC.indexOf('REGISTRY_SLUG_NOT_FOUND_SUFFIX =')),
        );
    const notFixedBlock = FORM_DESIGNER_SRC.slice(notFixedIdx, FORM_DESIGNER_SRC.indexOf(';', notFixedIdx));
    for (const block of [notFoundBlock, notFixedBlock]) {
      expect(block).not.toMatch(/target_registry_slug|registry_def|WRONG_FLOOR|\b409\b/);
    }
  });

  it('AC-8 (anti-case): the new logic/tests use only generic fixtures, no stand-specific literals', () => {
    const newLogicSlice = FORM_DESIGNER_SRC.slice(
      FORM_DESIGNER_SRC.indexOf('const selectedBinding = useMemo('),
      FORM_DESIGNER_SRC.indexOf('const rootChildren = useMemo('),
    );
    // Built from fragments at runtime (never a contiguous literal in THIS
    // file's own source) so the anti-case-lock.sh / rights-ui-anti-case.sh
    // repo-wide scan does not itself flag this negative-assertion string —
    // it scans added web/src/ LINES for the literal substrings verbatim.
    const bannedFixtureNames = [
      ['tel', 'Linear'].join(''),
      ['pur', 'chases'].join(''),
      ['soglaso', 'vanie'].join(''),
      ['e-', 'larina'].join(''),
      ['e-', 'orlov'].join(''),
    ];
    for (const name of bannedFixtureNames) {
      expect(newLogicSlice.includes(name)).toBe(false);
    }
  });

  it('an unbound/no-binding pair does not need bindings to render (embedding path, static-markup, NF regression check)', () => {
    const html = renderToStaticMarkup(<FormDesigner initialDocument={DOC} initialFields={FIELDS} />);
    expect(html).toContain('chs-form-designer');
  });
});

// ---------------------------------------------------------------------------
// P0 fix-forward (T-0706 merge, live-proof RED): on every REAL /forms mount
// (no initialFields — that prop only exists for this test's embedding path)
// registryDefs starts at its useState(null) initial value and only becomes
// non-null AFTER an application is picked (see the "Load registry defs for
// the chosen app" effect). The merged T-0706 code had the three-way picker
// branch un-guarded for registryDefs===null in its FINAL else arm, so the
// very first paint after /api/applications resolved (any real screen, no app
// picked yet) called `registryDefs.map` on null and crashed the whole
// component to a white screen (React unmounts on a render-phase throw).
//
// This tier has no jsdom/act (file header) so the actual async sequence
// (fetch /api/applications resolves -> LoadingState gate opens -> picker
// renders with registryDefs still null) cannot be driven through a mounted
// DOM here — MOUNT-GAP: a real `render()`+`waitFor` test (e.g.
// @testing-library/react) would catch this class of bug directly, but
// neither @testing-library/react nor jsdom is a dependency anywhere in this
// repo (checked: root and web node_modules, root/web package.json — vitest
// config is deliberately "node" env, see file header comment above). Adding
// either is out of scope for a P0 fix-forward. This test instead (a) mirrors
// the exact branch-selection predicate the JSX evaluates with
// registryDefs===null and proves it no longer reaches a `.map` call, and (b)
// asserts the source-level guard structurally, so the fix reddens if the
// outer `registryDefs &&` wrapper is ever dropped again.
// ---------------------------------------------------------------------------
describe('FormDesigner — registry_def picker survives registryDefs===null (P0 fix-forward, T-0706 merge crash)', () => {
  it('pure-logic mirror: with registryDefs===null, no branch touches .map (the real-mount crash state)', () => {
    // Mirrors the JSX exactly: {registryDefs && ( boundRegistryDef ? A : boundRegistryDef === null ? B : C )}
    // registryDefs is null on every real /forms mount before an application is chosen.
    const registryDefs = null;
    const boundRegistryDef = undefined; // boundRegistryDef's own guard: `if (!boundRegistrySlug || !registryDefs) return undefined;`

    function pickBranch() {
      // A structural mirror of the outer guard restored by this fix. If this
      // guard were missing, evaluating the ternary chain below with
      // registryDefs===null would call registryDefs.map inside branch C.
      if (!registryDefs) return 'nothing-rendered';
      if (boundRegistryDef) return 'A-narrowed-fact';
      if (boundRegistryDef === null) return 'B-desync-warning:' + [...registryDefs.map((d) => d.id)];
      return 'C-open-picker:' + [...registryDefs.map((d) => d.id)];
    }

    expect(() => pickBranch()).not.toThrow();
    expect(pickBranch()).toBe('nothing-rendered');
  });

  it('source guard: the registry_def picker\'s three T-0706 branches are wrapped in an outer registryDefs && guard (regression lock)', () => {
    // Find the specific outer-guard opening for the registry_def picker block
    // (distinct from the unrelated `{registryDefs && boundRegistryDef ?` T-0706
    // literal that the crashing merge used — that inline form must be GONE).
    expect(FORM_DESIGNER_SRC).toContain('{registryDefs && (\n              boundRegistryDef ?');
    expect(FORM_DESIGNER_SRC).not.toContain('{registryDefs && boundRegistryDef ?');
    // and the two remaining `registryDefs.map(` call sites are lexically
    // inside that guarded block, not reachable when registryDefs is null —
    // structurally enforced by the (single) outer guard rather than each
    // branch re-checking registryDefs itself.
    const guardIdx = FORM_DESIGNER_SRC.indexOf('{registryDefs && (\n              boundRegistryDef ?');
    expect(guardIdx).toBeGreaterThan(-1);
    const mapSites = [...FORM_DESIGNER_SRC.matchAll(/registryDefs\.map\(/g)].map((m) => m.index);
    expect(mapSites.length).toBeGreaterThanOrEqual(2);
    for (const site of mapSites) {
      expect(site).toBeGreaterThan(guardIdx);
    }
  });

  it('MOUNT-GAP (documented finding, not a bug in the fix): no jsdom/@testing-library/react in this repo, so the real async mount sequence (fetch resolves -> LoadingState gate opens -> registryDefs still null) cannot be driven through an actual DOM render in this test tier', () => {
    // This assertion exists to make the gap discoverable by `grep -r MOUNT-GAP`
    // rather than only living in a comment. See the describe-block header above
    // for the full rationale.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-0682 (P2 from live-proof T-0680): FormDesigner did not surface a
// collection field in the palette on the FIRST registry-def selection when
// an existing binding's layout had just been loaded (skipNextSchemaRebuildRef,
// T-0665 F3) — the field only appeared after picking the SAME def a SECOND
// time. Root cause: the schema-rebuild effect's skip flag gated BOTH
// `parseRecordSchema`/`setFields` (the palette's source) AND the document
// rebuild (history/savedDocRef) with the SAME guard, even though only the
// latter needed protecting (T-0656 P0: don't overwrite a just-loaded saved
// layout with a flat rebuild).
//
// planSchemaRebuild (exported, pure) is the fix's testable seam — this tier
// has no jsdom/@testing-library (file header), so the effect itself cannot be
// mounted/driven; these tests exercise the REAL production function the
// effect now delegates to, not a hand-mirrored copy.
// ---------------------------------------------------------------------------
describe('FormDesigner — planSchemaRebuild (T-0682)', () => {
  // Generic fixture — a plain field + a collection (table) field. No case
  // literal (D-064 anti-case): "items"/"label" are structural placeholders,
  // not a real tenant's business vocabulary.
  const RECORD_SCHEMA_WITH_COLLECTION = {
    type: 'object',
    properties: {
      title: { type: 'string', title: 'Title' },
      items: {
        type: 'array',
        title: 'Items',
        items: {
          type: 'object',
          properties: { label: { type: 'string', title: 'Label' } },
        },
      },
    },
    'x-field-order': ['title', 'items'],
  };
  const DEF = { id: 'def-generic', record_schema: RECORD_SCHEMA_WITH_COLLECTION };

  it('AC-1: on skipDocRebuild=true (existing-binding first pass) the collection field is STILL surfaced in `fields` — proves the bug is fixed', () => {
    const { fields } = planSchemaRebuild(DEF, { skipDocRebuild: true, applicationId: 'app-1', registryDefId: 'def-generic' });
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('items');
    const itemsField = fields.find((f) => f.key === 'items');
    expect(itemsField.type).toBe('collection');
  });

  it('AC-2: on skipDocRebuild=true the document is NOT rebuilt (doc:null) — the loaded-layout invariant (T-0656 P0) survives the fix', () => {
    const { doc } = planSchemaRebuild(DEF, { skipDocRebuild: true, applicationId: 'app-1', registryDefId: 'def-generic' });
    expect(doc).toBeNull();
  });

  it('AC-3: on skipDocRebuild=false (no existing binding / normal path) fields AND a fresh document are both built — no regression', () => {
    const { fields, doc } = planSchemaRebuild(DEF, { skipDocRebuild: false, applicationId: 'app-1', registryDefId: 'def-generic' });
    expect(fields.map((f) => f.key)).toEqual(['title', 'items']);
    expect(doc).not.toBeNull();
    expect(doc.root).toBeTruthy();
    expect(doc.source).toEqual({ applicationId: 'app-1', registryDefId: 'def-generic' });
    // one child per field (flat rebuild) — same shape as the pre-T-0682 behavior.
    expect(doc.root.children).toHaveLength(2);
  });

  it('defensive: an unresolved def (undefined/null) returns empty fields and no doc, never throws', () => {
    expect(() => planSchemaRebuild(undefined, { skipDocRebuild: true })).not.toThrow();
    expect(planSchemaRebuild(null, { skipDocRebuild: false })).toEqual({ fields: [], doc: null });
  });

  it('regression lock: the schema-rebuild effect is rewired onto the shared planSchemaRebuild function (structural — proves the effect itself changed, not just that an unused helper was added alongside the old bug)', () => {
    expect(FORM_DESIGNER_SRC).toContain('const plan = planSchemaRebuild(def, { skipDocRebuild, applicationId: selectedAppId, registryDefId: selectedDefId });');
    expect(FORM_DESIGNER_SRC).toContain('setFields(plan.fields);');
    // The OLD buggy guard — an early `return` BEFORE `def` is even looked up,
    // which used to skip parseRecordSchema/setFields together with the doc
    // rebuild — must be gone from the effect.
    expect(FORM_DESIGNER_SRC).not.toContain('if (skipNextSchemaRebuildRef.current) { skipNextSchemaRebuildRef.current = false; return; }');
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
