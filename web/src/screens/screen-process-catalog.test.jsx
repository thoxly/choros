/**
 * web/src/screens/screen-process-catalog.test.jsx — T-0742 (T-0654-c)
 *
 * Source-presence wiring tests (project convention: vitest "node" env, no React
 * mount — see screen-processes.test.jsx). The card helpers' PURE logic
 * (bindingsForDefinition, processGridDeepLink, instanceCountLabel,
 * definitionVersionLabel) is tested behaviorally in process-catalog.test.js; here
 * we assert the screen CONSUMES them and wires the part-C acceptance criteria.
 */

import { describe, it, expect } from 'vitest';

const fs = await import('fs');
const path = await import('path');
const screenPath = path.default.resolve(new URL(import.meta.url).pathname, '../screen-process-catalog.jsx');
const src = fs.default.readFileSync(screenPath, 'utf-8');

describe('screen-process-catalog — cards over definitions (T-0742, AC-C2)', () => {
  it('imports the process-catalog card helpers', () => {
    expect(src).toContain("from './process-catalog.js'");
    expect(src).toContain('bindingsForDefinition');
    expect(src).toContain('processGridDeepLink');
    expect(src).toContain('instanceCountLabel');
    expect(src).toContain('definitionVersionLabel');
  });

  it('renders definitions as Card kit primitives keyed by process_key (not a table)', () => {
    expect(src).toContain('Card');
    expect(src).toMatch(/defs\.map\(\(d\) => \(\s*<DefinitionCard/);
    expect(src).toMatch(/key=\{d\.process_key\}/);
    // The card layout must NOT re-introduce the old definitions/«Связи» tables.
    expect(src).not.toContain('chs-itable');
  });

  it('AC-C2: card shows human NAME as content, status + version badges', () => {
    // name is the content (title); the raw key is a demoted MonoId subtitle only.
    expect(src).toMatch(/title=\{def\.name \|\| procKey\}/);
    expect(src).toContain('definitionStatusLabel(def.status)');
    expect(src).toContain('definitionVersionLabel(def)');
    expect(src).toContain('<MonoId>{demotedKey}</MonoId>');
  });
});

describe('screen-process-catalog — instance-count deep-link (T-0742, AC-C3)', () => {
  it('renders the instance count as a deep-link button ONLY when count > 0 (no dead affordance)', () => {
    expect(src).toMatch(/count > 0 \? \(/);
    expect(src).toContain('navigate(processGridDeepLink(procKey))');
    // the zero case is honest static text, not a button
    expect(src).toContain('{instanceCountLabel(0)}');
  });
});

describe('screen-process-catalog — triggers folded into the card (T-0742, AC-C4)', () => {
  it('lists this definition’s bindings inline via bindingsForDefinition (no standalone «Связи» table)', () => {
    expect(src).toContain('bindingsForDefinition(bindings, procKey)');
    expect(src).toContain('bindingApplicationLabel(b)');
    expect(src).toContain('triggerTypeLabel(b.trigger_type)');
  });
});

describe('screen-process-catalog — modeler / DMN / trigger entry points (T-0742, AC-C5)', () => {
  it('card has «В модельер», «Правила ветвления» and «Настроить триггер» actions', () => {
    expect(src).toMatch(/navigate\(`\/processes\/\$\{procKey\}\/edit`\)/);
    expect(src).toMatch(/navigate\(`\/processes\/\$\{procKey\}\/branch-rules`\)/);
    expect(src).toContain('В модельер');
    expect(src).toContain('Правила ветвления');
    expect(src).toContain('Настроить триггер');
    // the trigger config still goes through the moved BindProcessModal → POST upsert.
    expect(src).toContain('function BindProcessModal');
    expect(src).toContain("fetch('/api/process-app-bindings'");
  });
});

describe('screen-process-catalog — one creation point (T-0742, AC-C6)', () => {
  it('has exactly ONE «Новый процесс» button (no duplicate creation affordance)', () => {
    // The header button renders «Новый процесс» as a JSX child (`>Новый процесс<`).
    // The empty-state references it only as quoted copy («Новый процесс»), which does
    // NOT match this button-child pattern — so exactly one button exists.
    const buttonChildHits = src.match(/Новый процесс\s*</g) || [];
    expect(buttonChildHits.length).toBe(1);
    expect(src).toContain("navigate('/processes/new/edit')");
  });
});

describe('screen-process-catalog — anti-uuid / anti-case (D-064)', () => {
  it('never renders a bare instance/record/actor id as content', () => {
    expect(src).not.toMatch(/>\s*\{[A-Za-z0-9_]+\.(recordId|actor|assignee|claimedBy)\}/);
  });

  it('no process/domain slug literal baked into the screen', () => {
    expect(src).not.toMatch(/telLinear|purchaseApproval|novyy-protsess/);
  });
});
