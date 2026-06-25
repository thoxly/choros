/**
 * web/src/screens/screen-process-editor.test.jsx  (T-0484)
 *
 * Honesty tests for the modeler ValidationBanner: a failed validation must NEVER
 * render as the green "валидна" success state. Field walkthrough 2026-06-25:
 * "UI глотает ошибки" — surfacing failure-as-success is exactly that dishonesty.
 *
 * Approach (project convention, see field-renderer.test.jsx): React elements are
 * plain objects — call the component as a function and walk the returned tree.
 * No DOM / jsdom needed (vitest "node" environment).
 */

import { describe, it, expect } from 'vitest';
import { ValidationBanner } from './screen-process-editor.jsx';

// ---------------------------------------------------------------------------
// Tree-walk helpers
// ---------------------------------------------------------------------------

/** Recursively collect every string of text rendered in the tree. */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) collectText(c, out);
    return out;
  }
  if (typeof node === 'object' && node.props) {
    collectText(node.props.children, out);
  }
  return out;
}

/** Collect every className string present anywhere in the tree (incl. root). */
function collectClassNames(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const c of node) collectClassNames(c, out);
    return out;
  }
  if (node.props) {
    if (typeof node.props.className === 'string') out.push(node.props.className);
    collectClassNames(node.props.children, out);
  }
  return out;
}

const noop = () => {};

describe('ValidationBanner — never shows failure as green (T-0484)', () => {
  it('renders the green "валидна" state ONLY when valid === true', () => {
    const el = ValidationBanner({
      result: { valid: true, errors: [], warnings: [] },
      onDismiss: noop,
    });
    const classes = collectClassNames(el).join(' ');
    const text = collectText(el).join(' ');
    expect(classes).toContain('chs-banner--success');
    expect(text).toContain('Диаграмма валидна');
  });

  it('does NOT render green when errors+warnings are empty but valid !== true', () => {
    // Empty message arrays alone must not paint green — the previous behaviour.
    const el = ValidationBanner({
      result: { valid: false, errors: [], warnings: [] },
      onDismiss: noop,
    });
    const classes = collectClassNames(el).join(' ');
    const text = collectText(el).join(' ');
    // The green success banner must NOT appear.
    expect(classes).not.toContain('chs-banner--success');
    expect(text).not.toContain('Диаграмма валидна');
    // A failed validation with no listed messages is danger, not a soft warning.
    expect(classes).toContain('chs-banner--danger');
    expect(text).toContain('Диаграмма не валидна');
  });

  it('renders a DANGER banner (never success) when there are errors', () => {
    const el = ValidationBanner({
      result: { valid: false, errors: ['Нет начального события'], warnings: [] },
      onDismiss: noop,
    });
    const classes = collectClassNames(el).join(' ');
    const text = collectText(el).join(' ');
    expect(classes).toContain('chs-banner--danger');
    expect(classes).not.toContain('chs-banner--success');
    expect(text).toContain('Нет начального события');
  });

  it('renders a WARNING banner (not success) when valid but warnings exist', () => {
    const el = ValidationBanner({
      result: { valid: true, errors: [], warnings: ['Нет конечного события'] },
      onDismiss: noop,
    });
    const classes = collectClassNames(el).join(' ');
    expect(classes).toContain('chs-banner--warning');
    expect(classes).not.toContain('chs-banner--success');
  });

  it('returns null for no result', () => {
    expect(ValidationBanner({ result: null, onDismiss: noop })).toBeNull();
  });
});
