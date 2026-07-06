/**
 * web/src/components/step-ref.test.jsx — T-0687 (capstone T-0647-A)
 *
 * Pin-tests for the StepRef primitive + its pure decision helpers
 * (isMachineStepKey / deriveStepLabel). The capstone finding (LIVE_PROOF): the
 * task-detail drawer led with a RAW BPMN node id ("legal_precheck") as the
 * primary «Шаг» / «Текущий шаг» value — a machine key the operator cannot read.
 *
 * These are BEHAVIORAL (mutational) tests, not source-presence: they assert on
 * the pure decision AND on the rendered element tree (StepRef is hook-free — a
 * plain function-component, safe to call directly and tree-walk, same discipline
 * as the ProcessRef tests in actor-chip.test.jsx).
 *
 * MUTATION sensitivity: if StepRef ever regressed to rendering the raw key as
 * primary (the exact capstone defect), `flattenText` would contain
 * "legal_precheck" as a bare leaf and the `not.toContain` assertions would fail.
 */

import { describe, it, expect } from 'vitest';
import { StepRef, isMachineStepKey, deriveStepLabel } from './components.jsx';

// Collect elements matching a predicate (mirrors actor-chip.test.jsx).
function collectElements(node, predicate, results = []) {
  if (node === null || node === undefined) return results;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, results);
    return results;
  }
  if (typeof node !== 'object' || !node.type) return results;
  if (predicate(node)) results.push(node);
  if (typeof node.type === 'function') {
    collectElements(node.type(node.props || {}), predicate, results);
    return results;
  }
  const { children } = node.props || {};
  if (children !== undefined) collectElements(children, predicate, results);
  return results;
}

// Tree-walk helper (mirrors actor-chip.test.jsx::flattenText) — recurses into
// function-component subtrees so we see all the way down to the text leaves.
function flattenText(node, acc = []) {
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) flattenText(child, acc);
    return acc;
  }
  if (typeof node === 'object' && node.type) {
    if (typeof node.type === 'function') {
      flattenText(node.type(node.props || {}), acc);
      return acc;
    }
    flattenText(node.props && node.props.children, acc);
  }
  return acc;
}

describe('T-0687 isMachineStepKey — bare BPMN node id detection', () => {
  it('snake_case node id is a machine key', () => {
    expect(isMachineStepKey('legal_precheck')).toBe(true);
  });
  it('camelCase / dashed / dotted single tokens are machine keys', () => {
    expect(isMachineStepKey('userTask_1')).toBe(true);
    expect(isMachineStepKey('approve-step')).toBe(true);
    expect(isMachineStepKey('flow.node.a')).toBe(true);
  });
  it('a human step name (has a space) is NOT a machine key', () => {
    expect(isMachineStepKey('Проверка реквизитов')).toBe(false);
  });
  it('a «·»-separated node label is NOT a machine key', () => {
    expect(isMachineStepKey('Проверка реквизитов · этап A')).toBe(false);
  });
  it('a single Cyrillic word is NOT a machine key (human, even without a space)', () => {
    expect(isMachineStepKey('Проверка')).toBe(false);
  });
  it('empty / missing step is treated as a machine key (no human value)', () => {
    expect(isMachineStepKey('')).toBe(true);
    expect(isMachineStepKey(undefined)).toBe(true);
    expect(isMachineStepKey(null)).toBe(true);
  });
});

describe('T-0687 deriveStepLabel — primary is human, machine key demoted', () => {
  it('MUTATION: a machine key never becomes the primary label', () => {
    const { label, showKey } = deriveStepLabel('legal_precheck');
    expect(label).toBe('Шаг процесса');       // generic human primary
    expect(label).not.toBe('legal_precheck');  // NOT the raw key
    expect(showKey).toBe(true);                // raw key demoted to a mono chip
  });
  it('a human step name stays primary and shows no separate key', () => {
    const { label, showKey } = deriveStepLabel('Проверка реквизитов счёта');
    expect(label).toBe('Проверка реквизитов счёта');
    expect(showKey).toBe(false);
  });
  it('empty step → generic human primary, no key to show', () => {
    const { label, showKey } = deriveStepLabel('');
    expect(label).toBe('Шаг процесса');
    expect(showKey).toBe(false);
  });
});

// The primary label lives in the <span className="chs-stepref__name">. The raw
// key, when demoted, lives in a SEPARATE MonoId chip — so the whole-tree text
// naturally contains the key (intentional, secondary). To pin the actual defect
// (raw key as PRIMARY) we read the primary name span in isolation.
function primaryNameText(tree) {
  const [nameEl] = collectElements(
    tree,
    (el) => el.props && el.props.className === 'chs-stepref__name',
  );
  return nameEl ? flattenText(nameEl).join(' ') : '';
}

describe('T-0687 StepRef component tree — raw node id never the PRIMARY text', () => {
  it('MUTATION: machine step key → primary name is human, NOT the raw key', () => {
    const tree = StepRef({ step: 'legal_precheck' });
    const primary = primaryNameText(tree);
    expect(primary).toBe('Шаг процесса');
    expect(primary).not.toContain('legal_precheck');
    // Traceability: the raw key is still reachable somewhere (the demoted chip).
    expect(flattenText(tree).join(' ')).toContain('legal_precheck');
  });
  it('human step name → appears verbatim as the primary text', () => {
    const tree = StepRef({ step: 'Проверка реквизитов · этап A' });
    expect(primaryNameText(tree)).toContain('Проверка реквизитов · этап A');
  });
});
