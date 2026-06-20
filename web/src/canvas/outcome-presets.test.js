/**
 * T-0353 [E16] — outcome-presets.js + choros-moddle-extension.js contract tests
 *
 * Covers:
 *   1. OUTCOME_PRESETS ladder — 4 presets in correct order with correct outcomes.
 *   2. defaultOutcomesFor — returns correct outcomes per preset, deep copy (no mutation).
 *   3. getPreset — lookup by id.
 *   4. choros-moddle-extension — SequenceFlowOutcome + UserTaskOutcomes descriptor shape.
 *   5. ExecutorTypeActivity preserved (no regression on existing round-trip).
 *   6. Moddle round-trip contract (XML attributes are isAttr:true — the serialisation contract).
 */

import { describe, it, expect } from 'vitest';
import {
  OUTCOME_PRESETS,
  CUSTOM_PRESET_ID,
  defaultOutcomesFor,
  getPreset,
} from './outcome-presets.js';
import descriptor from './choros-moddle-extension.js';

// ---------------------------------------------------------------------------
// outcome-presets.js — preset ladder
// ---------------------------------------------------------------------------

describe('OUTCOME_PRESETS — T-0353 preset ladder', () => {
  it('exports 4 presets in the correct order', () => {
    expect(OUTCOME_PRESETS).toHaveLength(4);
    expect(OUTCOME_PRESETS[0].id).toBe('done');
    expect(OUTCOME_PRESETS[1].id).toBe('decision');
    expect(OUTCOME_PRESETS[2].id).toBe('decision-rework');
    expect(OUTCOME_PRESETS[3].id).toBe(CUSTOM_PRESET_ID);
    expect(CUSTOM_PRESET_ID).toBe('custom');
  });

  it("preset 'done': 1 outcome — Готово → next", () => {
    const outcomes = defaultOutcomesFor('done');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].name).toBe('Готово');
    expect(outcomes[0].targetKind).toBe('next');
    expect(outcomes[0].color).toBe('primary');
  });

  it("preset 'decision': 2 outcomes — Согласовать/Отклонить with correct kinds", () => {
    const outcomes = defaultOutcomesFor('decision');
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.name)).toEqual(['Согласовать', 'Отклонить']);
    expect(outcomes[0].targetKind).toBe('next');
    expect(outcomes[0].color).toBe('success');
    expect(outcomes[1].targetKind).toBe('end');
    expect(outcomes[1].color).toBe('danger');
  });

  it("preset 'decision-rework': 3 outcomes; На доработку is back with isBack=true", () => {
    const outcomes = defaultOutcomesFor('decision-rework');
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((o) => o.name)).toEqual(['Согласовать', 'Отклонить', 'На доработку']);
    const back = outcomes.find((o) => o.name === 'На доработку');
    expect(back).toBeDefined();
    expect(back.targetKind).toBe('back');
    expect(back.isBack).toBe(true);
    expect(back.color).toBe('warning');
  });

  it("preset 'custom': 0 default outcomes (escape hatch)", () => {
    const outcomes = defaultOutcomesFor(CUSTOM_PRESET_ID);
    expect(outcomes).toHaveLength(0);
  });

  it('defaultOutcomesFor returns deep copy — mutation does not affect the source', () => {
    const copy1 = defaultOutcomesFor('decision');
    copy1[0].name = 'MUTATED';
    const copy2 = defaultOutcomesFor('decision');
    expect(copy2[0].name).toBe('Согласовать'); // original unchanged
  });

  it('defaultOutcomesFor returns empty array for unknown preset id', () => {
    expect(defaultOutcomesFor('no-such-preset')).toEqual([]);
  });
});

describe('getPreset — lookup by id', () => {
  it('returns the preset def for a valid id', () => {
    const p = getPreset('done');
    expect(p).toBeDefined();
    expect(p.id).toBe('done');
    expect(p.label).toBe('Готово');
    expect(typeof p.hint).toBe('string');
  });

  it('returns undefined for an unknown id', () => {
    expect(getPreset('no-such-preset')).toBeUndefined();
  });

  it('returns the custom preset', () => {
    const p = getPreset(CUSTOM_PRESET_ID);
    expect(p).toBeDefined();
    expect(p.id).toBe(CUSTOM_PRESET_ID);
    expect(p.outcomes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// choros-moddle-extension.js — XML descriptor contract (T-0353)
//
// The moddle descriptor is a plain JS object describing the XML schema.
// We verify the type shapes so the round-trip contract holds:
//   <sequenceFlow ... choros:outcomeName="Согласовать"/>
//   <userTask ... choros:outcomePreset="decision" choros:outcomeButtonsJson="..."/>
// ---------------------------------------------------------------------------

describe('choros-moddle-extension — T-0353 descriptor shape', () => {
  it('namespace prefix is choros and URI is http://choros.io/bpmn', () => {
    expect(descriptor.prefix).toBe('choros');
    expect(descriptor.uri).toBe('http://choros.io/bpmn');
  });

  describe('SequenceFlowOutcome type', () => {
    const sfType = descriptor.types.find((t) => t.name === 'SequenceFlowOutcome');

    it('exists and extends bpmn:SequenceFlow', () => {
      expect(sfType).toBeDefined();
      expect(sfType.extends).toContain('bpmn:SequenceFlow');
    });

    it('has outcomeName as isAttr:true String property', () => {
      const prop = sfType.properties.find((p) => p.name === 'outcomeName');
      expect(prop).toBeDefined();
      expect(prop.isAttr).toBe(true);
      expect(prop.type).toBe('String');
    });
  });

  describe('UserTaskOutcomes type', () => {
    const utType = descriptor.types.find((t) => t.name === 'UserTaskOutcomes');

    it('exists and extends bpmn:UserTask', () => {
      expect(utType).toBeDefined();
      expect(utType.extends).toContain('bpmn:UserTask');
    });

    it('has outcomePreset as isAttr:true String property', () => {
      const prop = utType.properties.find((p) => p.name === 'outcomePreset');
      expect(prop).toBeDefined();
      expect(prop.isAttr).toBe(true);
      expect(prop.type).toBe('String');
    });

    it('has outcomeButtonsJson as isAttr:true String property', () => {
      const prop = utType.properties.find((p) => p.name === 'outcomeButtonsJson');
      expect(prop).toBeDefined();
      expect(prop.isAttr).toBe(true);
      expect(prop.type).toBe('String');
    });
  });

  describe('ExecutorTypeActivity type — regression (no change)', () => {
    const execType = descriptor.types.find((t) => t.name === 'ExecutorTypeActivity');

    it('exists and extends bpmn:Activity', () => {
      expect(execType).toBeDefined();
      expect(execType.extends).toContain('bpmn:Activity');
    });

    it('has executorType as isAttr:true String property', () => {
      const prop = execType.properties.find((p) => p.name === 'executorType');
      expect(prop).toBeDefined();
      expect(prop.isAttr).toBe(true);
      expect(prop.type).toBe('String');
    });
  });

  it('has exactly 3 types: ExecutorTypeActivity + UserTaskOutcomes + SequenceFlowOutcome', () => {
    const names = descriptor.types.map((t) => t.name);
    expect(names).toContain('ExecutorTypeActivity');
    expect(names).toContain('UserTaskOutcomes');
    expect(names).toContain('SequenceFlowOutcome');
    expect(descriptor.types).toHaveLength(3);
  });
});
