// @vitest-environment jsdom
/**
 * web/src/screens/screen-process-editor.errorpanel.mount.test.jsx  (T-0659)
 *
 * REAL DOM mount test — @testing-library/react + jsdom, scoped to the publish
 * error panel (StatusBanner + its ViolationItem list). See
 * web/src/forms/FormDesigner.mount.test.jsx for the general D-064 rationale:
 * a node-env "call the component as a function and tree-walk the returned
 * object" suite (screen-process-editor.test.jsx, the sibling convention file)
 * can stay green while a REAL DOM render throws — React DOM has stricter
 * rules about children shapes than the plain-object tree-walk does.
 *
 * Scoped to StatusBanner rather than the full <ProcessEditorScreen/> default
 * export: the screen embeds the real bpmn-js canvas (BpmnModelerWrapper),
 * which needs a browser-grade SVG/canvas environment out of scope for this
 * fix — T-0659 only touches how violations RENDER inside the already-mounted
 * error banner, not the editor shell around it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, screen } from '@testing-library/react';
import { StatusBanner } from './screen-process-editor.jsx';

afterEach(cleanup);

// Real shape/length of the timer_escalation_no_convergence message emitted by
// src/core/bpmn-linter.ts (see docs/design/ADR-T0612-purchase-escalation-convergence.md) —
// well past the old formatJsonReadable 120-char cap, with the actionable "Fix:"
// guidance at the tail.
const LONG_MESSAGE =
  '<boundaryEvent id="timer_esc_1"> is a NON-INTERRUPTING boundary timer (cancelActivity="false") ' +
  "whose escalation branch reaches its own endEvent WITHOUT reconnecting to the guarded task's own " +
  'downstream path. If the guarded task (attachedToRef="task_1") completes before the deadline fires, ' +
  "the escalation branch's token is never cancelled and never reaches an end either — the process " +
  'instance never completes (act_hi_procinst.end_time stays NULL forever), even though the main path ' +
  'finished. Fix: either route the escalation branch into a gateway that also receives the guarded ' +
  "task's normal completion flow (so both paths converge before ending), or set cancelActivity=\"true\" " +
  'if the escalation is meant to CANCEL the guarded task rather than merely remind';

describe('StatusBanner — REAL DOM mount, publish lint violations (T-0659)', () => {
  it('mounts without throwing and shows the full untruncated message + fix hint', () => {
    render(
      <StatusBanner
        message="Диаграмма не прошла проверку перед публикацией"
        isError={true}
        violations={[
          {
            type: 'timer_escalation_no_convergence',
            elementId: 'timer_esc_1',
            elementKind: 'boundaryEvent',
            message: LONG_MESSAGE,
          },
        ]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(LONG_MESSAGE)).toBeTruthy();
    expect(screen.getByText(/Fix: either route the escalation branch/)).toBeTruthy();
    expect(screen.getByText(/Ветка эскалации таймера не сходится с основным потоком/)).toBeTruthy();
  });

  it('mounts a mixed violation list (string + structured object + unknown shape) without crashing', () => {
    render(
      <StatusBanner
        message="Опубликован с предупреждениями (версия 4)"
        isError={false}
        violations={[
          'Роль «Согласующий» не назначена ни одному пользователю',
          {
            type: 'app_binding_unpublished',
            elementId: 'app_1',
            elementKind: 'serviceTask',
            message: 'Приложение ещё не опубликовано.',
          },
          { foo: 'bar' }, // no .message — exercises the formatJsonReadable fallback path
        ]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText('Роль «Согласующий» не назначена ни одному пользователю')).toBeTruthy();
    expect(screen.getByText('Приложение ещё не опубликовано.')).toBeTruthy();
  });

  it('renders nothing (no crash) when there is no active status message', () => {
    const { container } = render(
      <StatusBanner message={null} isError={false} violations={null} onDismiss={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders without crashing when isError but violations is an empty array', () => {
    render(
      <StatusBanner
        message="Ошибка публикации: неизвестная ошибка"
        isError={true}
        violations={[]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText('Ошибка публикации: неизвестная ошибка')).toBeTruthy();
  });
});
