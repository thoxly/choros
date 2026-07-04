/**
 * T-0634 [W3/столп4/P0-3] — properties-panel section RAISE test.
 *
 * Live-proof finding (T-0586): every <PanelGroup> section in the bpmn-js
 * properties panel NEVER visibly expanded, because editor.css keys section
 * visibility off a literal `.open` class —
 *
 *   .bio-properties-panel-group-entries        { display: none; }
 *   .bio-properties-panel-group-entries.open   { display: flex; }
 *
 * — but PanelGroup only conditionally MOUNTED the entries <div> when its
 * `open` state was true (`{open && (<div className="bio-properties-panel-
 * group-entries">…)}`), never adding the `.open` class the stylesheet
 * actually requires. So the div was in the DOM but still display:none by the
 * base rule — every control inside (executor-type selector, agent picker,
 * role assignment, form binding, …) was unreachable by click, even though the
 * arrow icon visibly rotated (a different, unrelated toggle) and React state
 * (`open`) was correctly true.
 *
 * This test renders REAL markup via react-dom/server (no DOM/jsdom needed —
 * matches this project's node-env test philosophy, see vitest.config.js) and
 * asserts the class name the CSS keys off is actually present/absent on the
 * entries container in both states.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PanelGroup, OutcomesPanel } from './bpmn-properties-panel.jsx';

/** Pull out the entries-container's class attribute from rendered HTML. */
function entriesClassFromHtml(html) {
  const m = html.match(/class="([^"]*bio-properties-panel-group-entries[^"]*)"/);
  return m ? m[1] : null;
}

describe('PanelGroup — entries container carries the CSS-required .open class', () => {
  it('defaultOpen=true → entries container has the "open" class', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        PanelGroup,
        { title: 'Тестовая секция', defaultOpen: true },
        React.createElement('div', { key: 'x' }, 'содержимое'),
      ),
    );
    const cls = entriesClassFromHtml(html);
    expect(cls).not.toBeNull();
    expect(cls.split(/\s+/)).toContain('open');
    // The content must actually be present in the markup (not just the class).
    expect(html).toContain('содержимое');
  });

  it('defaultOpen=false → entries container is present WITHOUT the "open" class (collapsed)', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        PanelGroup,
        { title: 'Тестовая секция', defaultOpen: false },
        React.createElement('div', { key: 'x' }, 'содержимое'),
      ),
    );
    const cls = entriesClassFromHtml(html);
    expect(cls).not.toBeNull();
    expect(cls.split(/\s+/)).not.toContain('open');
  });

  it('base class name is exactly "bio-properties-panel-group-entries" (matches editor.css selector)', () => {
    const html = renderToStaticMarkup(
      React.createElement(PanelGroup, { title: 'T', defaultOpen: true }, 'x'),
    );
    expect(html).toContain('bio-properties-panel-group-entries');
  });

  it('regression: a real typed panel (OutcomesPanel, defaultOpen) renders its section expanded', () => {
    // OutcomesPanel mounts a PanelGroup with defaultOpen — exercising the
    // fix through an actual product panel, not just the bare primitive.
    const bo = { $type: 'bpmn:UserTask', id: 'Task_1' };
    const html = renderToStaticMarkup(
      React.createElement(OutcomesPanel, { bo, modeler: null, element: null }),
    );
    const cls = entriesClassFromHtml(html);
    expect(cls).not.toBeNull();
    expect(cls.split(/\s+/)).toContain('open');
    // The preset picker (a control inside the section) must be in the markup.
    expect(html).toContain('Пресет исходов');
  });
});
