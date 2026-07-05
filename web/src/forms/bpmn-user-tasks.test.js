/**
 * web/src/forms/bpmn-user-tasks.test.js  (T-0665)
 *
 * Pure unit tests for extractUserTasks — the FormDesigner step-picker's
 * best-effort BPMN userTask suggestion source (F1). No DOM/DOMParser
 * involved (this module is regex-based specifically so it works in the
 * jsdom-less "node" vitest environment AND in the browser identically).
 */

import { describe, it, expect } from 'vitest';
import { extractUserTasks } from './bpmn-user-tasks.js';

const UNPREFIXED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="genericProcess" name="Пример процесса" isExecutable="true">
    <startEvent id="start" name="Начало"/>
    <userTask id="task-submit"
              name="Подача заявки"
              flowable:candidateGroups="role-example-1">
      <documentation>irrelevant</documentation>
    </userTask>
    <userTask id="task-review" name="Проверка заявки" flowable:candidateGroups="role-example-2">
    </userTask>
  </process>
</definitions>`;

const NAMESPACED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="proc1">
    <bpmn:userTask id="task1" name="Review Task"/>
    <bpmn:userTask name="No Id Order Swap" id="task2"/>
  </bpmn:process>
</definitions>`;

const NO_NAME_XML = `<definitions><process id="p"><userTask id="task-x"/></process></definitions>`;

const NO_ID_XML = `<definitions><process id="p"><userTask name="orphan"/></process></definitions>`;

const ENTITY_XML = `<definitions><process id="p"><userTask id="t1" name="Rock &amp; Roll &quot;quoted&quot;"/></process></definitions>`;

describe('extractUserTasks', () => {
  it('extracts id+name for unprefixed <userTask> elements, in document order', () => {
    const tasks = extractUserTasks(UNPREFIXED_XML);
    expect(tasks).toEqual([
      { id: 'task-submit', name: 'Подача заявки' },
      { id: 'task-review', name: 'Проверка заявки' },
    ]);
  });

  it('extracts id+name for namespaced <bpmn:userTask> elements, id/name in either order', () => {
    const tasks = extractUserTasks(NAMESPACED_XML);
    expect(tasks).toEqual([
      { id: 'task1', name: 'Review Task' },
      { id: 'task2', name: 'No Id Order Swap' },
    ]);
  });

  it('falls back to id as the name when name is absent (BPMN allows unnamed tasks)', () => {
    expect(extractUserTasks(NO_NAME_XML)).toEqual([{ id: 'task-x', name: 'task-x' }]);
  });

  it('skips a userTask with no id (not a usable step-key candidate)', () => {
    expect(extractUserTasks(NO_ID_XML)).toEqual([]);
  });

  it('decodes XML entities in id/name', () => {
    expect(extractUserTasks(ENTITY_XML)).toEqual([{ id: 't1', name: 'Rock & Roll "quoted"' }]);
  });

  it('returns [] for empty string, non-string, null, undefined — never throws', () => {
    expect(extractUserTasks('')).toEqual([]);
    expect(extractUserTasks(null)).toEqual([]);
    expect(extractUserTasks(undefined)).toEqual([]);
    expect(extractUserTasks(123)).toEqual([]);
    expect(extractUserTasks('<not-even-xml')).toEqual([]);
  });

  it('returns [] for XML with no userTask elements (e.g. all serviceTask/scriptTask)', () => {
    const xml = `<definitions><process id="p"><serviceTask id="s1" name="Do it"/></process></definitions>`;
    expect(extractUserTasks(xml)).toEqual([]);
  });

  it('de-duplicates a repeated id defensively (malformed doc) — keeps first occurrence', () => {
    const xml = `<definitions><userTask id="dup" name="First"/><userTask id="dup" name="Second"/></definitions>`;
    expect(extractUserTasks(xml)).toEqual([{ id: 'dup', name: 'First' }]);
  });
});
