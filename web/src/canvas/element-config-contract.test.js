/**
 * T-0461 [D8-R6] — element-config-contract.js tests.
 *
 * The KEYSTONE contract: one driver-agnostic per-element config, two drivers
 * (panel + D8 bot). These tests assert:
 *   1. elementConfigKind — the typed dispatch routes each BPMN type to the right
 *      config kind (userTask / agentTask / gateway / parallel / timer / message /
 *      start / end / none).
 *   2. read/writeAgentConfig — the agentTask config block round-trips (write →
 *      persist on bo → read), through the registered moddle prop AND the $attrs
 *      fallback (imported XML), so the bot reads back exactly what it wrote.
 *   3. read/writeUserTaskConfig — the userTask form-binding block round-trips.
 *   4. field-list (de)serialisation — CSV ↔ array, trim/dedupe/empty.
 *   5. moddle descriptor — the new choros:* attrs are declared as isAttr/String
 *      on bpmn:Activity (round-trip contract).
 */

import { describe, it, expect } from 'vitest';
import {
  elementConfigKind,
  isTimerEventBo,
  isMessageEventBo,
  effectiveExecTypeOf,
  readConfigAttr,
  writeConfigAttr,
  readAgentConfig,
  writeAgentConfig,
  readUserTaskConfig,
  writeUserTaskConfig,
  splitFieldList,
  joinFieldList,
  AUTONOMY_LEVELS,
  isAutonomyLevel,
  ELEMENT_CONFIG_KINDS,
} from './element-config-contract.js';
import descriptor from './choros-moddle-extension.js';

// Helper: build a minimal businessObject.
const boOf = (type, extra = {}) => ({ $type: type, ...extra });
// Helper: a timer event bo.
const timerBo = (type = 'bpmn:BoundaryEvent') =>
  boOf(type, { eventDefinitions: [{ $type: 'bpmn:TimerEventDefinition' }] });
const messageBo = (type = 'bpmn:IntermediateCatchEvent') =>
  boOf(type, { eventDefinitions: [{ $type: 'bpmn:MessageEventDefinition' }] });

describe('elementConfigKind — typed dispatch (spec §3.7)', () => {
  it('routes a UserTask → userTask', () => {
    expect(elementConfigKind(boOf('bpmn:UserTask'))).toBe('userTask');
  });
  it('routes a ServiceTask typed as agent → agentTask', () => {
    expect(elementConfigKind(boOf('bpmn:ServiceTask', { executorType: 'agent' }))).toBe('agentTask');
  });
  it('routes a ServiceTask typed as agent via $attrs (imported XML) → agentTask', () => {
    expect(
      elementConfigKind(boOf('bpmn:ServiceTask', { $attrs: { 'choros:executorType': 'agent' } })),
    ).toBe('agentTask');
  });
  it('routes a plain/service ServiceTask (no agent) → userTask family', () => {
    expect(elementConfigKind(boOf('bpmn:ServiceTask'))).toBe('userTask');
  });
  it('routes an ExclusiveGateway → gateway', () => {
    expect(elementConfigKind(boOf('bpmn:ExclusiveGateway'))).toBe('gateway');
  });
  it('routes a ParallelGateway → parallel (no params)', () => {
    expect(elementConfigKind(boOf('bpmn:ParallelGateway'))).toBe('parallel');
  });
  it('routes a timer BoundaryEvent → timer', () => {
    expect(elementConfigKind(timerBo())).toBe('timer');
  });
  it('routes a message IntermediateCatchEvent → message (T-0459 seam)', () => {
    expect(elementConfigKind(messageBo())).toBe('message');
  });
  it('routes a ReceiveTask → message (T-0459 seam)', () => {
    expect(elementConfigKind(boOf('bpmn:ReceiveTask'))).toBe('message');
  });
  it('routes StartEvent → start, EndEvent → end', () => {
    expect(elementConfigKind(boOf('bpmn:StartEvent'))).toBe('start');
    expect(elementConfigKind(boOf('bpmn:EndEvent'))).toBe('end');
  });
  it('routes a SequenceFlow / unknown / null → none', () => {
    expect(elementConfigKind(boOf('bpmn:SequenceFlow'))).toBe('none');
    expect(elementConfigKind(boOf('bpmn:TextAnnotation'))).toBe('none');
    expect(elementConfigKind(null)).toBe('none');
  });
  it('every dispatch result is a member of the closed kind set', () => {
    const samples = [
      boOf('bpmn:UserTask'),
      boOf('bpmn:ServiceTask', { executorType: 'agent' }),
      boOf('bpmn:ExclusiveGateway'),
      boOf('bpmn:ParallelGateway'),
      timerBo(),
      messageBo(),
      boOf('bpmn:StartEvent'),
      boOf('bpmn:EndEvent'),
      boOf('bpmn:SequenceFlow'),
    ];
    for (const bo of samples) {
      expect(ELEMENT_CONFIG_KINDS).toContain(elementConfigKind(bo));
    }
  });
});

describe('event detection helpers', () => {
  it('isTimerEventBo only matches boundary/intermediate-catch with a TimerEventDefinition', () => {
    expect(isTimerEventBo(timerBo('bpmn:BoundaryEvent'))).toBe(true);
    expect(isTimerEventBo(timerBo('bpmn:IntermediateCatchEvent'))).toBe(true);
    expect(isTimerEventBo(messageBo())).toBe(false);
    expect(isTimerEventBo(boOf('bpmn:UserTask'))).toBe(false);
  });
  it('isMessageEventBo matches receiveTask + message/signal catch, not timers', () => {
    expect(isMessageEventBo(boOf('bpmn:ReceiveTask'))).toBe(true);
    expect(isMessageEventBo(messageBo())).toBe(true);
    expect(isMessageEventBo(timerBo())).toBe(false);
  });
  it('effectiveExecTypeOf: UserTask→human, agent-attr→agent, other task→service', () => {
    expect(effectiveExecTypeOf(boOf('bpmn:UserTask'))).toBe('human');
    expect(effectiveExecTypeOf(boOf('bpmn:ServiceTask', { executorType: 'agent' }))).toBe('agent');
    expect(effectiveExecTypeOf(boOf('bpmn:ServiceTask'))).toBe('service');
    expect(effectiveExecTypeOf(boOf('bpmn:StartEvent'))).toBeNull();
  });
});

describe('readConfigAttr / writeConfigAttr — dual-write primitive', () => {
  it('writes the registered property AND the $attrs fallback', () => {
    const bo = {};
    writeConfigAttr(bo, 'agentRef', 'choros:agentRef', 'emp-1');
    expect(bo.agentRef).toBe('emp-1');
    expect(bo.$attrs['choros:agentRef']).toBe('emp-1');
    expect(readConfigAttr(bo, 'agentRef', 'choros:agentRef')).toBe('emp-1');
  });
  it('clearing (empty) removes both sides', () => {
    const bo = { agentRef: 'x', $attrs: { 'choros:agentRef': 'x' } };
    writeConfigAttr(bo, 'agentRef', 'choros:agentRef', '');
    expect(bo.agentRef).toBeUndefined();
    expect(bo.$attrs['choros:agentRef']).toBeUndefined();
  });
  it('reads from $attrs fallback when the registered prop is absent (imported XML)', () => {
    const bo = { $attrs: { 'choros:agentRef': 'emp-2' } };
    expect(readConfigAttr(bo, 'agentRef', 'choros:agentRef')).toBe('emp-2');
  });
});

describe('agentTask config — round-trips for BOTH drivers', () => {
  it('write → read returns the same structure (the bot writes the same shape)', () => {
    const bo = {};
    writeAgentConfig(bo, {
      agentRef: 'emp-9',
      autonomyLevel: 'auto',
      readsFields: ['amount', 'vendor'],
      writesFields: ['decision'],
    });
    const read = readAgentConfig(bo);
    expect(read).toEqual({
      agentRef: 'emp-9',
      autonomyLevel: 'auto',
      readsFields: ['amount', 'vendor'],
      writesFields: ['decision'],
    });
  });
  it('persists as choros:* attrs on the bo (round-trips through saveXML/importXML)', () => {
    const bo = {};
    writeAgentConfig(bo, { agentRef: 'emp-9', autonomyLevel: 'auto', readsFields: ['a'], writesFields: ['b'] });
    expect(bo.$attrs['choros:agentRef']).toBe('emp-9');
    expect(bo.$attrs['choros:autonomyLevel']).toBe('auto');
    expect(bo.$attrs['choros:agentReadsFields']).toBe('a');
    expect(bo.$attrs['choros:agentWritesFields']).toBe('b');
  });
  it('a partial patch leaves other keys untouched', () => {
    const bo = {};
    writeAgentConfig(bo, { agentRef: 'emp-1', autonomyLevel: 'auto' });
    writeAgentConfig(bo, { agentRef: 'emp-2' }); // only agentRef
    const read = readAgentConfig(bo);
    expect(read.agentRef).toBe('emp-2');
    expect(read.autonomyLevel).toBe('auto'); // unchanged
  });
  it('an unknown/empty autonomy level defaults to "assisted" on read', () => {
    expect(readAgentConfig({}).autonomyLevel).toBe('assisted');
    const bo = { $attrs: { 'choros:autonomyLevel': 'bogus' } };
    expect(readAgentConfig(bo).autonomyLevel).toBe('assisted');
  });
  it('reads agent config from imported $attrs (no registered props)', () => {
    const bo = { $attrs: { 'choros:agentRef': 'emp-7', 'choros:agentReadsFields': 'x, y , z' } };
    const read = readAgentConfig(bo);
    expect(read.agentRef).toBe('emp-7');
    expect(read.readsFields).toEqual(['x', 'y', 'z']);
  });
});

describe('userTask form-binding config — round-trips', () => {
  it('write → read returns role + form + visible fields', () => {
    const bo = {};
    writeUserTaskConfig(bo, {
      assignedRoleId: 'role-uuid',
      formContractRef: 'purchase-request',
      visibleFields: ['amount', 'comment'],
    });
    expect(readUserTaskConfig(bo)).toEqual({
      assignedRoleId: 'role-uuid',
      formContractRef: 'purchase-request',
      visibleFields: ['amount', 'comment'],
    });
  });
  it('assignedRoleId persists under the SAME attr the existing role assignment uses (T-0325 compat)', () => {
    const bo = {};
    writeUserTaskConfig(bo, { assignedRoleId: 'role-uuid' });
    expect(bo.$attrs['choros:assignedRoleId']).toBe('role-uuid');
  });
  it('a partial patch leaves other keys untouched', () => {
    const bo = {};
    writeUserTaskConfig(bo, { formContractRef: 'f1', visibleFields: ['a'] });
    writeUserTaskConfig(bo, { visibleFields: ['a', 'b'] });
    const read = readUserTaskConfig(bo);
    expect(read.formContractRef).toBe('f1');
    expect(read.visibleFields).toEqual(['a', 'b']);
  });
});

describe('field-list (de)serialisation', () => {
  it('splitFieldList: trims, drops empties, dedupes', () => {
    expect(splitFieldList('a, b ,, a , c')).toEqual(['a', 'b', 'c']);
    expect(splitFieldList('')).toEqual([]);
    expect(splitFieldList('   ')).toEqual([]);
  });
  it('splitFieldList accepts an array too', () => {
    expect(splitFieldList([' a ', 'b', 'b', ''])).toEqual(['a', 'b']);
  });
  it('joinFieldList: array → CSV; round-trips through split', () => {
    expect(joinFieldList(['a', 'b'])).toBe('a,b');
    expect(splitFieldList(joinFieldList(['a', ' b ', 'a']))).toEqual(['a', 'b']);
    expect(joinFieldList(undefined)).toBe('');
  });
});

describe('autonomy levels', () => {
  it('exposes the closed set', () => {
    expect(AUTONOMY_LEVELS.map((l) => l.value)).toEqual(['suggest', 'assisted', 'auto']);
  });
  it('isAutonomyLevel validates membership', () => {
    expect(isAutonomyLevel('auto')).toBe(true);
    expect(isAutonomyLevel('nope')).toBe(false);
    expect(isAutonomyLevel(undefined)).toBe(false);
  });
});

describe('moddle descriptor — new choros:* attrs round-trip on bpmn:Activity', () => {
  it('declares agentRef/autonomyLevel/agentReadsFields/agentWritesFields/formContractRef/visibleFields as isAttr String', () => {
    const ext = descriptor.types.find((t) => t.name === 'ExecutorTypeActivity');
    expect(ext).toBeDefined();
    expect(ext.extends).toContain('bpmn:Activity');
    const byName = Object.fromEntries(ext.properties.map((p) => [p.name, p]));
    for (const name of [
      'agentRef', 'autonomyLevel', 'agentReadsFields', 'agentWritesFields',
      'formContractRef', 'visibleFields',
    ]) {
      expect(byName[name], `missing moddle prop ${name}`).toBeDefined();
      expect(byName[name].isAttr).toBe(true);
      expect(byName[name].type).toBe('String');
    }
  });
});
