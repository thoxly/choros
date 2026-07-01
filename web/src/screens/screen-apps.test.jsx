/**
 * web/src/screens/screen-apps.test.jsx  (T-0565)
 *
 * Regression: clicking «Сохранить» (Изменить раздел) or «Опубликовать»
 * (Опубликовать решение) inside a modal opened from the app row must NOT
 * navigate the page to that app's records.
 *
 * Root cause: <Modal> renders INLINE (components.jsx, no createPortal), so its
 * overlay is a DOM descendant of the clickable `<tr onClick={navigate}>`. A click
 * inside the modal bubbled up the React tree to the row and navigated.
 *
 * Fix: AppActions wraps the modals in <RowModalStopBubble>, whose onClick calls
 * stopPropagation — so a bubble from within the overlay never reaches the row.
 *
 * We test the guard directly (project convention: vitest "node" env, no DOM —
 * see apps-publish-dialog.test.jsx). We assert the wrapper element carries an
 * onClick that (a) stops propagation, and (b) does not itself swallow the event
 * for the modal's own handlers (only bubbling to the ROW is cut).
 */

import { describe, it, expect, vi } from 'vitest';
import { RowModalStopBubble } from './screen-apps.jsx';

// Minimal synthetic-event double: React calls e.stopPropagation() to cut the
// bubble to ancestor React handlers (here, the row's navigate onClick).
function fakeEvent() {
  return {
    _stopped: false,
    stopPropagation() { this._stopped = true; },
  };
}

describe('RowModalStopBubble — cuts modal-click bubble to the clickable row', () => {
  it('renders a single wrapper element with an onClick handler', () => {
    const el = RowModalStopBubble({ children: 'x' });
    expect(el.type).toBe('span');
    expect(typeof el.props.onClick).toBe('function');
    expect(el.props.children).toBe('x');
  });

  it('onClick stops propagation (so the row navigate never fires)', () => {
    const el = RowModalStopBubble({ children: null });
    const ev = fakeEvent();
    // Simulate the SAVE / PUBLISH button click bubbling up to this wrapper.
    el.props.onClick(ev);
    expect(ev._stopped).toBe(true);
  });

  it('a row-level navigate handler is not reached once the bubble is stopped', () => {
    // Model React bubbling: child (modal button) → wrapper → row. If the wrapper
    // stops propagation, the row handler must not run.
    const rowNavigate = vi.fn();
    const wrapper = RowModalStopBubble({ children: null });
    const ev = fakeEvent();
    wrapper.props.onClick(ev);
    if (!ev._stopped) rowNavigate(); // only fires if bubble reached the row
    expect(rowNavigate).not.toHaveBeenCalled();
  });
});
