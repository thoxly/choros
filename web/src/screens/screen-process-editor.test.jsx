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
import { ValidationBanner, ViolationItem } from './screen-process-editor.jsx';

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

// ---------------------------------------------------------------------------
// T-0684 [capstone T-0647 P1]: the editor now REQUIRES a human process name.
// The editor's full mount pulls in bpmn-js (not available in the node test tier),
// so we lock the wiring structurally on the source (project idiom: screen source
// presence — see screen-process-instance.test.jsx). The behavioural guarantees of
// the guard itself are pin-tested in process-name-policy.test.js.
// ---------------------------------------------------------------------------
describe('screen-process-editor — human process-name enforcement (T-0684)', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const src = fs.default.readFileSync(
    path.default.resolve(new URL(import.meta.url).pathname, '../screen-process-editor.jsx'),
    'utf-8',
  );

  it('imports the shared name policy (predicate + message + placeholder)', () => {
    expect(src).toContain("from './process-name-policy.js'");
    expect(src).toContain('isRejectedProcessName');
    expect(src).toContain('PROCESS_NAME_REQUIRED_MESSAGE');
    expect(src).toContain('UNNAMED_PROCESS_PLACEHOLDER');
  });

  it('renders an editable name INPUT (not derived static text) in the toolbar', () => {
    expect(src).toContain('chs-edtoolbar__name-input');
    expect(src).toContain('onNameChange');
    expect(src).toContain('Название процесса');
  });

  it('guards BOTH save and publish with the name policy before the network call', () => {
    // The guard must appear at least twice (handleSave + handlePublish).
    const guardHits = src.match(/if \(isRejectedProcessName\(name\)\)/g) || [];
    expect(guardHits.length).toBeGreaterThanOrEqual(2);
  });

  it('no longer silently defaults a save to the placeholder name', async () => {
    // Regression lock: the pre-fix code shipped the placeholder to the backend via
    // `const name = processName || <placeholder>`. That literal default must be gone.
    // The placeholder literal is pulled from the policy module (not hardcoded here).
    const { UNNAMED_PROCESS_PLACEHOLDER } = await import('./process-name-policy.js');
    const badDefault = new RegExp(
      `processName \\|\\| ['"]${UNNAMED_PROCESS_PLACEHOLDER}['"]`,
    );
    expect(src).not.toMatch(badDefault);
  });
});

// ---------------------------------------------------------------------------
// T-0659: formatJsonReadable() was hard-capping publish-time lint violations at
// 120 characters. A LintViolation from the server is a structured object —
// { type, elementId, elementKind, message } — and the pre-fix code JSON.stringified
// the WHOLE object then truncated. The {type,elementId,elementKind} prefix alone
// eats ~108 of the 120 chars, so a long .message (e.g. timer_escalation_no_convergence,
// which carries a "Fix: ..." hint at its tail — see
// docs/design/ADR-T0612-purchase-escalation-convergence.md and
// src/core/bpmn-linter.ts) survives as ~12 unreadable characters. StatusBanner's
// violation list now renders each entry through ViolationItem (hook-free, so it fits
// this file's plain-object tree-walk convention — StatusBanner itself uses useEffect
// and is covered by the REAL DOM mount test instead, see
// screen-process-editor.errorpanel.mount.test.jsx): a translated rule title + the
// FULL .message, never truncated. These tests pin that: RED before T-0659 (the old
// `formatJsonReadable(v)` call would have cut LONG_MESSAGE to 120 chars + '…').
// ---------------------------------------------------------------------------
describe('ViolationItem — publish lint violations render in FULL, never truncated (T-0659)', () => {
  // Real shape of the timer_escalation_no_convergence message (src/core/bpmn-linter.ts) —
  // 550+ chars, well past the old 120-char cap, with the actionable "Fix:" guidance
  // at the very end (exactly the part the old truncation ate).
  const LONG_MESSAGE =
    '<boundaryEvent id="timer_esc_1"> is a NON-INTERRUPTING boundary timer (cancelActivity="false") ' +
    "whose escalation branch reaches its own endEvent WITHOUT reconnecting to the guarded task's own " +
    'downstream path. If the guarded task (attachedToRef="task_1") completes before the deadline fires, ' +
    "the escalation branch's token is never cancelled and never reaches an end either — the process " +
    'instance never completes (act_hi_procinst.end_time stays NULL forever), even though the main path ' +
    'finished. Fix: either route the escalation branch into a gateway that also receives the guarded ' +
    "task's normal completion flow (so both paths converge before ending), or set cancelActivity=\"true\" " +
    'if the escalation is meant to CANCEL the guarded task rather than merely remind';

  it('renders the message in FULL, including the trailing "Fix:" hint — no 120-char cutoff', () => {
    const el = ViolationItem({
      v: {
        type: 'timer_escalation_no_convergence',
        elementId: 'timer_esc_1',
        elementKind: 'boundaryEvent',
        message: LONG_MESSAGE,
      },
    });
    const text = collectText(el).join(' ');
    expect(LONG_MESSAGE.length).toBeGreaterThan(120); // sanity: this message DOES exceed the old cap
    expect(text).toContain(LONG_MESSAGE);
    expect(text).toContain('Fix: either route the escalation branch');
    // The old cap always appended an ellipsis when it clipped — assert that failure
    // signature is gone from the rendered item.
    expect(text).not.toContain('…');
  });

  it('translates the violation .type into a Russian rule title and shows element context', () => {
    const el = ViolationItem({
      v: {
        type: 'timer_escalation_no_convergence',
        elementId: 'timer_esc_1',
        elementKind: 'boundaryEvent',
        message: 'краткое сообщение',
      },
    });
    const text = collectText(el).join(' ');
    expect(text).toContain('Ветка эскалации таймера не сходится с основным потоком');
    expect(text).toContain('boundaryEvent');
    expect(text).toContain('timer_esc_1');
    expect(text).toContain('краткое сообщение');
  });

  it('falls back to the raw .type string for an unmapped/future violation type (additive)', () => {
    const el = ViolationItem({
      v: { type: 'some_future_violation_type', elementId: '', elementKind: '', message: 'сообщение будущего правила' },
    });
    const text = collectText(el).join(' ');
    expect(text).toContain('some_future_violation_type');
    expect(text).toContain('сообщение будущего правила');
  });

  it('still renders plain-string violations (legacy role-warning shape) as-is', () => {
    const el = ViolationItem({ v: 'Роль «Согласующий» не назначена ни одному пользователю' });
    const text = collectText(el).join(' ');
    expect(text).toContain('Роль «Согласующий» не назначена ни одному пользователю');
  });

  it('falls back to formatJsonReadable for an object violation with no .message (unknown shape)', () => {
    const el = ViolationItem({ v: { foo: 'bar' } });
    const text = collectText(el).join(' ');
    expect(text).toContain('"foo"');
    expect(text).toContain('"bar"');
  });
});
