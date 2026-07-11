/* ============================================================================
   CHOROS — timer-deadline-panel.jsx
   T-0458 [D8-R3]: Timer / deadline + escalation property panel.

   Shown when a bpmn:BoundaryEvent or bpmn:IntermediateCatchEvent carrying a
   TimerEventDefinition is selected in the modeler.

   Responsibility:
     - Lets the user configure the DEADLINE: a duration (ISO-8601, e.g. PT24H),
       a fixed date, or a date pulled from a record field.
     - Lets the user choose the ESCALATION TARGET on fire: руководитель (manager),
       владелец (owner), or a specific org role.
     - Persists this typed config on the event businessObject via the choros
       moddle extension (choros:timerDeadlineKind / choros:timerDeadline /
       choros:escalateTo) so it round-trips through saveXML/importXML.

   The publish-time mapper (src/core/timer-escalation-mapper.ts) reads this config
   and materialises the native <timerEventDefinition> body + the escalation target's
   flowable:candidateGroups, so Flowable schedules the timer and the firing
   projection (inbox engine-drive, T-0443/T-0456) surfaces the escalation task.

   Seam (Rule-9, mirrors gateway-condition-panel.jsx):
     This file is NEW. The ONLY edit to bpmn-properties-panel.jsx is one additive
     import + one conditional mount line — kept in a distinct region to minimise
     merge friction with the parallel T-0484 edit to the same file.

   Product language: Russian labels throughout (per D-062 OBLIK).
   ============================================================================ */

import React, { useState, useCallback, useEffect } from 'react';
import {
  INTERRUPT_MODES,
  isBoundaryEventBo,
  readInterruptMode,
  writeInterruptMode,
  canBuildEscalationBranch,
  applyEscalationBranch,
} from './escalation-branch-builder.js';

/* --------------------------------------------------------------------------
   Pure helpers — unit-testable without DOM or bpmn-js.
   -------------------------------------------------------------------------- */

/** Deadline kinds. */
export const DEADLINE_KINDS = [
  { value: 'duration', label: 'Длительность (через сколько)' },
  { value: 'date', label: 'Фиксированная дата' },
  { value: 'field', label: 'Дата из поля записи' },
];

/** Escalation targets. */
export const ESCALATION_TARGETS = [
  { value: 'manager', label: 'Руководитель' },
  { value: 'owner', label: 'Владелец процесса' },
  { value: 'role', label: 'Конкретная роль…' },
];

/** Placeholder + hint per deadline kind. */
export function deadlinePlaceholder(kind) {
  switch (kind) {
    case 'duration': return 'PT24H';
    case 'date': return '2026-07-01T14:00:00Z';
    case 'field': return 'dueDate';
    default: return '';
  }
}

export function deadlineHint(kind) {
  switch (kind) {
    case 'duration':
      return 'ISO-8601 длительность: PT24H = 24 часа, P1D = 1 день, PT30M = 30 минут.';
    case 'date':
      return 'Точная дата/время в формате ISO-8601 (например, 2026-07-01T14:00:00Z).';
    case 'field':
      return 'Имя поля записи с датой. Срок будет взят из этого поля во время выполнения.';
    default:
      return '';
  }
}

/**
 * Validate a deadline value for the chosen kind. Returns null when ok, or a
 * short Russian message when malformed (mirrors the publish-time linter so the
 * author sees the problem before publishing).
 */
export function validateDeadline(kind, value) {
  const v = (value || '').trim();
  if (!v) return 'Укажите срок.';
  if (kind === 'duration') {
    const ok = /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/.test(v) || /^\$\{[^}]+\}$/.test(v);
    return ok ? null : 'Неверный формат длительности (ожидается, например, PT24H).';
  }
  if (kind === 'date') {
    const ok = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) || /^\$\{[^}]+\}$/.test(v);
    return ok ? null : 'Неверный формат даты (ожидается, например, 2026-07-01T14:00:00Z).';
  }
  // field: any non-empty value is a candidate field key.
  return null;
}

/** Read a choros:* timer attribute (registered moddle property first, $attrs fallback). */
export function readTimerAttr(bo, propName, attrName, fallback = '') {
  if (!bo) return fallback;
  return bo[propName] ?? (bo.$attrs && bo.$attrs[attrName]) ?? fallback;
}

/** Dual-write a choros:* timer attribute (registered property + $attrs fallback). */
export function writeTimerAttr(bo, propName, attrName, value) {
  if (!bo) return;
  if (!bo.$attrs) bo.$attrs = {};
  if (value) {
    bo[propName] = value;
    bo.$attrs[attrName] = value;
  } else {
    delete bo[propName];
    delete bo.$attrs[attrName];
  }
}

/* --------------------------------------------------------------------------
   TimerDeadlinePanel — main export.

   Props:
     bo       — the event businessObject (BoundaryEvent / IntermediateCatchEvent)
     modeler  — BpmnModeler instance
     element  — the selected bpmn-js element (shape)

   Sub-components (PanelGroup/PPEntry) are passed in from the parent so this file
   does not duplicate the bio-properties-panel chrome.
   -------------------------------------------------------------------------- */
export function TimerDeadlinePanel({ bo, modeler, element, PanelGroup, PPEntry, roles, rolesLoading }) {
  const [kind, setKind] = useState(() => readTimerAttr(bo, 'timerDeadlineKind', 'choros:timerDeadlineKind', 'duration'));
  const [deadline, setDeadline] = useState(() => readTimerAttr(bo, 'timerDeadline', 'choros:timerDeadline', ''));
  // escalateTo can be "manager" | "owner" | a role slug. We split the UI into a
  // target SELECT and (when "role") a role picker; the stored value is the slug.
  const [escalateRaw, setEscalateRaw] = useState(() => readTimerAttr(bo, 'escalateTo', 'choros:escalateTo', 'manager'));
  // T-0660: interrupting vs non-interrupting (cancelActivity). Only meaningful for a
  // BOUNDARY timer (a timer attached to a step). BPMN default = interrupting.
  const [interruptMode, setInterruptMode] = useState(() => readInterruptMode(bo));
  // T-0660: feedback for the «собрать ветку эскалации» affordance.
  const [buildNote, setBuildNote] = useState('');

  // Re-sync when a different timer event is selected.
  useEffect(() => {
    setKind(readTimerAttr(bo, 'timerDeadlineKind', 'choros:timerDeadlineKind', 'duration'));
    setDeadline(readTimerAttr(bo, 'timerDeadline', 'choros:timerDeadline', ''));
    setEscalateRaw(readTimerAttr(bo, 'escalateTo', 'choros:escalateTo', 'manager'));
    setInterruptMode(readInterruptMode(bo));
    setBuildNote('');
  }, [bo && bo.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fireChanged = useCallback(() => {
    try {
      if (modeler && element) {
        modeler.get('eventBus').fire('element.changed', { element });
      }
    } catch (_) { /* non-fatal */ }
  }, [modeler, element]);

  const commitKind = useCallback((newKind) => {
    setKind(newKind);
    writeTimerAttr(bo, 'timerDeadlineKind', 'choros:timerDeadlineKind', newKind);
    fireChanged();
  }, [bo, fireChanged]);

  const commitDeadline = useCallback((val) => {
    setDeadline(val);
    writeTimerAttr(bo, 'timerDeadline', 'choros:timerDeadline', val);
    fireChanged();
  }, [bo, fireChanged]);

  const commitEscalate = useCallback((val) => {
    setEscalateRaw(val);
    writeTimerAttr(bo, 'escalateTo', 'choros:escalateTo', val);
    fireChanged();
  }, [bo, fireChanged]);

  // T-0660: commit interrupting/non-interrupting via the native cancelActivity
  // attribute (modeling.updateProperties → undo/redo + border re-render).
  const commitInterruptMode = useCallback((mode) => {
    setInterruptMode(mode);
    writeInterruptMode({ bo, modeler, element }, mode);
  }, [bo, modeler, element]);

  // T-0660: one-click «собрать ветку эскалации» — builds the converging shape on
  // the canvas (timer→Эскалация→шлюз and шаг→шлюз→следующий), sets the timer to
  // non-interrupting. Idempotent-guarded; leaves a human note on the outcome.
  const handleBuildEscalation = useCallback(() => {
    const res = applyEscalationBranch({ modeler, boundaryElement: element });
    if (res.applied) {
      setInterruptMode('non-interrupting');
      setBuildNote('Готово: добавлены шаг «Эскалация» и шлюз «Продолжить» — ветки сходятся.');
    } else {
      setBuildNote(res.reason || 'Не удалось собрать ветку эскалации.');
    }
  }, [modeler, element]);

  // Which top-level escalation option is selected: manager / owner / role.
  const escalateSelect =
    escalateRaw === 'manager' || escalateRaw === 'owner' ? escalateRaw : 'role';

  const handleEscalateSelect = (sel) => {
    if (sel === 'manager' || sel === 'owner') {
      commitEscalate(sel);
    } else {
      // "role" chosen — keep any existing role slug, else clear to force a pick.
      const existingRole = escalateSelect === 'role' ? escalateRaw : '';
      commitEscalate(existingRole);
    }
  };

  const deadlineErr = validateDeadline(kind, deadline);
  const roleOptions = [
    { value: '', label: '— выберите роль —' },
    ...(roles || []).map((r) => ({ value: r.label, label: r.label })),
  ];

  // T-0660: the interrupt-mode control + the escalation-branch affordance are only
  // meaningful for a BOUNDARY timer (a timer attached to a step). A free-floating
  // intermediate timer has no cancelActivity concept and no step to escalate from.
  const isBoundary = isBoundaryEventBo(bo);
  const buildGuard = isBoundary ? canBuildEscalationBranch(element) : { ok: false };

  return (
    <PanelGroup title="Срок и эскалация" defaultOpen>
      {/* Deadline kind */}
      <PPEntry label="Тип срока">
        <div className="bio-properties-panel-select">
          <select value={kind} onChange={(e) => commitKind(e.target.value)}>
            {DEADLINE_KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </div>
      </PPEntry>

      {/* Deadline value */}
      <PPEntry label="Срок">
        <div className="bio-properties-panel-textfield">
          <input
            className="bio-properties-panel-input"
            value={deadline}
            placeholder={deadlinePlaceholder(kind)}
            onChange={(e) => commitDeadline(e.target.value)}
          />
        </div>
        <p className="bio-properties-panel-description" style={{ marginTop: 'var(--chs-space-2)' }}>
          {deadlineHint(kind)}
        </p>
        {deadlineErr && deadline.trim() !== '' && (
          <p
            className="bio-properties-panel-description"
            style={{ marginTop: 'var(--chs-space-1)', color: 'var(--chs-color-danger)' }}
          >
            {deadlineErr}
          </p>
        )}
      </PPEntry>

      {/* T-0660: interrupting vs non-interrupting — only for a boundary timer. */}
      {isBoundary && (
        <PPEntry label="Что делать с текущим шагом">
          <div className="bio-properties-panel-select">
            <select
              value={interruptMode}
              aria-label="Что делать с текущим шагом при срабатывании таймера"
              onChange={(e) => commitInterruptMode(e.target.value)}
            >
              {INTERRUPT_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <p className="bio-properties-panel-description" style={{ marginTop: 'var(--chs-space-2)' }}>
            {(INTERRUPT_MODES.find((m) => m.value === interruptMode) || {}).hint || ''}
          </p>
        </PPEntry>
      )}

      {/* Escalation target */}
      <PPEntry label="Кому эскалация при срабатывании">
        <div className="bio-properties-panel-select">
          <select value={escalateSelect} onChange={(e) => handleEscalateSelect(e.target.value)}>
            {ESCALATION_TARGETS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
      </PPEntry>

      {/* Role picker — only when "role" is the chosen target */}
      {escalateSelect === 'role' && (
        <PPEntry label="Роль для эскалации">
          {rolesLoading ? (
            <p className="bio-properties-panel-description">Загрузка ролей…</p>
          ) : (
            <div className="bio-properties-panel-select">
              <select value={escalateRaw} onChange={(e) => commitEscalate(e.target.value)}>
                {roleOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
          {(roles || []).length === 0 && !rolesLoading && (
            <p className="bio-properties-panel-description" style={{ marginTop: 'var(--chs-space-2)' }}>
              Роли недоступны — создайте их в Оргструктуре или выберите «Руководитель»/«Владелец».
            </p>
          )}
        </PPEntry>
      )}

      {/* Explanation */}
      <PPEntry>
        <p className="bio-properties-panel-description">
          Когда срок истечёт, шаг эскалируется: выбранному адресату придёт задача
          с предзаполненной формой. Соедините таймер стрелкой с шагом эскалации.
        </p>
      </PPEntry>

      {/* T-0660: one-click «собрать ветку эскалации» — only for a boundary timer. */}
      {isBoundary && (
        <PPEntry label="Собрать ветку эскалации">
          <button
            type="button"
            disabled={!buildGuard.ok}
            aria-disabled={!buildGuard.ok}
            aria-label="Собрать ветку эскалации на схеме"
            onClick={handleBuildEscalation}
            style={{
              fontSize: 'var(--chs-text-sm)',
              color: buildGuard.ok ? 'var(--chs-color-accent-fg)' : 'var(--chs-color-text-muted)',
              background: buildGuard.ok ? 'var(--chs-color-accent)' : 'var(--chs-color-surface-raised)',
              border: '1px solid var(--chs-color-border-strong)',
              borderRadius: 'var(--chs-radius-sm)',
              padding: 'var(--chs-space-2) var(--chs-space-4)',
              cursor: buildGuard.ok ? 'pointer' : 'not-allowed',
              textAlign: 'left',
            }}
          >
            Собрать напоминание с эскалацией
          </button>
          <p className="bio-properties-panel-description" style={{ marginTop: 'var(--chs-space-2)' }}>
            {buildGuard.ok
              ? 'Добавит шаг «Эскалация» и шлюз «Продолжить»: обе ветки — обычная и эскалация — сойдутся в один поток, чтобы процесс корректно завершался.'
              : (buildGuard.reason || '')}
          </p>
          {buildNote && (
            <p
              className="bio-properties-panel-description"
              role="status"
              style={{ marginTop: 'var(--chs-space-1)', color: 'var(--chs-color-success)' }}
            >
              {buildNote}
            </p>
          )}
        </PPEntry>
      )}
    </PanelGroup>
  );
}

export default TimerDeadlinePanel;
