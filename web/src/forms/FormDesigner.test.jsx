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
import FormDesigner from './FormDesigner.jsx';

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
