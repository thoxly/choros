/**
 * web/src/forms/field-contract.test.js  (T-0399 · D7-K)
 *
 * Unit tests for resolveFieldContract — the pure contract-resolution function
 * that drives the unified field renderer. No React runtime required.
 *
 * NOTE: these tests are committed here but not yet wired into the CI vitest
 * run (that is T-0408). They can be run manually via:
 *   cd web && npx vitest run src/forms/field-contract.test.js
 */

import { describe, it, expect } from 'vitest';
import {
  resolveFieldContract,
  normaliseTypeToFieldType,
  contractKindForFieldType,
} from './field-contract.js';

// ---------------------------------------------------------------------------
// normaliseTypeToFieldType
// ---------------------------------------------------------------------------

describe('normaliseTypeToFieldType', () => {
  it('maps "string" → "text"', () => {
    expect(normaliseTypeToFieldType('string')).toBe('text');
  });

  it('maps "text" → "text"', () => {
    expect(normaliseTypeToFieldType('text')).toBe('text');
  });

  it('maps unknown → "text" (safe degradation)', () => {
    expect(normaliseTypeToFieldType('whatever')).toBe('text');
    expect(normaliseTypeToFieldType(undefined)).toBe('text');
  });

  it('maps "select" → "enum"', () => {
    expect(normaliseTypeToFieldType('select')).toBe('enum');
  });

  it('maps "enum" → "enum"', () => {
    expect(normaliseTypeToFieldType('enum')).toBe('enum');
  });

  it('maps "boolean" → "boolean"', () => {
    expect(normaliseTypeToFieldType('boolean')).toBe('boolean');
  });

  it('maps "number" → "number"', () => {
    expect(normaliseTypeToFieldType('number')).toBe('number');
  });

  it('maps "integer" → "number"', () => {
    expect(normaliseTypeToFieldType('integer')).toBe('number');
  });

  it('maps "date" → "date"', () => {
    expect(normaliseTypeToFieldType('date')).toBe('date');
  });

  it('maps "textarea" → "textarea"', () => {
    expect(normaliseTypeToFieldType('textarea')).toBe('textarea');
  });
});

// ---------------------------------------------------------------------------
// resolveFieldContract — branch: explicit contract wins
// ---------------------------------------------------------------------------

describe('resolveFieldContract — explicit contract', () => {
  it('uses the explicit contract kind when provided', () => {
    const result = resolveFieldContract({ contract: 'relation', type: 'string' });
    expect(result.contractKind).toBe('relation');
    expect(result.presentation).toBe('reference');
    expect(result.editable).toBe(true);
  });

  it('explicit rollup → editable: false', () => {
    const result = resolveFieldContract({ contract: 'rollup' });
    expect(result.contractKind).toBe('rollup');
    expect(result.presentation).toBe('readout');
    expect(result.editable).toBe(false);
  });

  it('explicit matrix-lookup → editable: false', () => {
    const result = resolveFieldContract({ contract: 'matrix-lookup' });
    expect(result.contractKind).toBe('matrix-lookup');
    expect(result.presentation).toBe('readout');
    expect(result.editable).toBe(false);
  });

  it('explicit contract + valid presentation override → override wins', () => {
    const result = resolveFieldContract({ contract: 'enum', presentation: 'radio' });
    expect(result.contractKind).toBe('enum');
    expect(result.presentation).toBe('radio');
  });

  it('explicit contract + invalid presentation override → default wins', () => {
    // 'text' is not a valid presentation for 'enum' → falls back to 'select'
    const result = resolveFieldContract({ contract: 'enum', presentation: 'text' });
    expect(result.contractKind).toBe('enum');
    expect(result.presentation).toBe('select');
  });

  it('unknown explicit contract kind → falls back to scalar', () => {
    const result = resolveFieldContract({ contract: 'totally-unknown' });
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// resolveFieldContract — branch: options-force-enum (snapshot bug fix)
// ---------------------------------------------------------------------------

describe('resolveFieldContract — options-force-enum', () => {
  it('non-empty options[] with type="string" → enum (snapshot bug fix)', () => {
    const result = resolveFieldContract({
      type: 'string',
      options: ['Alpha', 'Beta', 'Gamma'],
    });
    expect(result.contractKind).toBe('enum');
    expect(result.presentation).toBe('select');
    expect(result.editable).toBe(true);
  });

  it('non-empty options[] with no type at all → enum', () => {
    const result = resolveFieldContract({ options: ['X', 'Y'] });
    expect(result.contractKind).toBe('enum');
    expect(result.presentation).toBe('select');
  });

  it('empty options[] does NOT force enum', () => {
    const result = resolveFieldContract({ type: 'string', options: [] });
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('text');
  });

  it('explicit contract wins even when options[] is non-empty', () => {
    // contract is checked first; options-force-enum only applies when no explicit contract
    const result = resolveFieldContract({
      contract: 'scalar',
      type: 'string',
      options: ['A', 'B'],
    });
    expect(result.contractKind).toBe('scalar');
  });
});

// ---------------------------------------------------------------------------
// resolveFieldContract — branch: derive from type (no contract, no options)
// ---------------------------------------------------------------------------

describe('resolveFieldContract — derive from type', () => {
  it('type="text" → scalar / text', () => {
    const result = resolveFieldContract({ type: 'text' });
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('text');
  });

  it('type="string" → scalar / text', () => {
    const result = resolveFieldContract({ type: 'string' });
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('text');
  });

  it('type="textarea" → scalar / textarea', () => {
    const result = resolveFieldContract({ type: 'textarea' });
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('textarea');
  });

  it('type="number" → scalar / number', () => {
    const result = resolveFieldContract({ type: 'number' });
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('number');
  });

  it('type="integer" → scalar / number (via normalise)', () => {
    const result = resolveFieldContract({ type: 'integer' });
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('number');
  });

  it('type="boolean" → scalar / checkbox', () => {
    const result = resolveFieldContract({ type: 'boolean' });
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('checkbox');
    expect(result.editable).toBe(true);
  });

  it('type="date" → scalar / date', () => {
    const result = resolveFieldContract({ type: 'date' });
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('date');
  });

  it('type="select" → enum / select', () => {
    const result = resolveFieldContract({ type: 'select' });
    expect(result.contractKind).toBe('enum');
    expect(result.presentation).toBe('select');
  });

  it('type="enum" → enum / select', () => {
    const result = resolveFieldContract({ type: 'enum' });
    expect(result.contractKind).toBe('enum');
    expect(result.presentation).toBe('select');
  });
});

// ---------------------------------------------------------------------------
// resolveFieldContract — branch: legacy / missing field (backward compat)
// ---------------------------------------------------------------------------

describe('resolveFieldContract — legacy default (no type/contract/options)', () => {
  it('null field → scalar / text (safe default)', () => {
    const result = resolveFieldContract(null);
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('text');
    expect(result.editable).toBe(true);
  });

  it('undefined field → scalar / text', () => {
    const result = resolveFieldContract(undefined);
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('text');
  });

  it('empty object → scalar / text', () => {
    const result = resolveFieldContract({});
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('text');
  });

  it('BindingField row with only key/label (legacy schema without contract) → scalar / text', () => {
    const result = resolveFieldContract({ key: 'name', label: 'Имя' });
    expect(result.contractKind).toBe('scalar');
    expect(result.presentation).toBe('text');
    expect(result.editable).toBe(true);
  });

  it('descriptor is always returned and has kind matching contractKind', () => {
    const result = resolveFieldContract({ type: 'boolean' });
    expect(result.descriptor).toBeDefined();
    expect(result.descriptor.kind).toBe(result.contractKind);
  });
});

// ---------------------------------------------------------------------------
// T-0480 [D7-K]: contractKindForFieldType — single map of the records-form
// legacy `type` vocabulary onto the catalog contract kinds.
// ---------------------------------------------------------------------------

describe('contractKindForFieldType', () => {
  it('scalar primitives → scalar', () => {
    for (const t of ['string', 'text', 'textarea', 'number', 'integer', 'boolean', 'date']) {
      expect(contractKindForFieldType(t)).toBe('scalar');
    }
  });

  it('select / enum → enum', () => {
    expect(contractKindForFieldType('select')).toBe('enum');
    expect(contractKindForFieldType('enum')).toBe('enum');
  });

  it('relation → relation', () => {
    expect(contractKindForFieldType('relation')).toBe('relation');
  });

  it('collection → collection', () => {
    expect(contractKindForFieldType('collection')).toBe('collection');
  });

  it('computed → rollup (read-only итог)', () => {
    expect(contractKindForFieldType('computed')).toBe('rollup');
  });

  it('unknown → scalar (safe degradation)', () => {
    expect(contractKindForFieldType('whatever')).toBe('scalar');
    expect(contractKindForFieldType(undefined)).toBe('scalar');
  });
});

// ---------------------------------------------------------------------------
// T-0512: contractKindForFieldType maps multi-select and person to their own kinds.
// ---------------------------------------------------------------------------

describe('contractKindForFieldType — T-0512 multi-select + person', () => {
  it('multi-select → "multi-select"', () => {
    expect(contractKindForFieldType('multi-select')).toBe('multi-select');
  });

  it('person → "person"', () => {
    expect(contractKindForFieldType('person')).toBe('person');
  });
});

// ---------------------------------------------------------------------------
// T-0512: resolveFieldContract for multi-select and person fields.
// ---------------------------------------------------------------------------

describe('resolveFieldContract — T-0512 multi-select + person', () => {
  it('type="multi-select" with options → multi-select contract (NOT misclassified as enum)', () => {
    const result = resolveFieldContract({ type: 'multi-select', options: ['A', 'B', 'C'] });
    expect(result.contractKind).toBe('multi-select');
    expect(result.presentation).toBe('multi-select');
    expect(result.editable).toBe(true);
  });

  it('type="multi-select" without options → multi-select contract', () => {
    const result = resolveFieldContract({ type: 'multi-select' });
    expect(result.contractKind).toBe('multi-select');
    expect(result.presentation).toBe('multi-select');
  });

  it('explicit contract="multi-select" wins', () => {
    const result = resolveFieldContract({ contract: 'multi-select', type: 'string' });
    expect(result.contractKind).toBe('multi-select');
    expect(result.presentation).toBe('multi-select');
  });

  it('type="person" → person contract (scalar employee id)', () => {
    const result = resolveFieldContract({ type: 'person' });
    expect(result.contractKind).toBe('person');
    expect(result.presentation).toBe('person');
    expect(result.editable).toBe(true);
  });

  it('explicit contract="person" wins', () => {
    const result = resolveFieldContract({ contract: 'person', type: 'string' });
    expect(result.contractKind).toBe('person');
    expect(result.presentation).toBe('person');
  });

  it('multi-select with options is NOT classified as enum (structural-before-hasOptions rule)', () => {
    // This is the key regression guard: a multi-select field that carries options must
    // NOT fall into the hasOptions→enum branch.
    const result = resolveFieldContract({ type: 'multi-select', options: ['X', 'Y'] });
    expect(result.contractKind).not.toBe('enum');
    expect(result.contractKind).toBe('multi-select');
  });
});

// ---------------------------------------------------------------------------
// T-0579: contractKindForFieldType + resolveFieldContract for the `file` type
// (AC-4, FF-CATALOG). file was already declared in BINDING_CONTRACT_CATALOG
// (both client field-contract.js and server binding-contract-catalog.ts) as a
// stub; this task wires the dispatch functions — no new catalog kind added.
// ---------------------------------------------------------------------------

describe('contractKindForFieldType — T-0579 file', () => {
  it('file → "file" (AC-4)', () => {
    expect(contractKindForFieldType('file')).toBe('file');
  });
});

describe('resolveFieldContract — T-0579 file', () => {
  it('type="file" → file contract, presentation="file" (AC-4)', () => {
    const result = resolveFieldContract({ type: 'file' });
    expect(result.contractKind).toBe('file');
    expect(result.presentation).toBe('file');
    expect(result.editable).toBe(true);
  });

  it('explicit contract="file" wins', () => {
    const result = resolveFieldContract({ contract: 'file', type: 'string' });
    expect(result.contractKind).toBe('file');
    expect(result.presentation).toBe('file');
  });

  it('FF-CATALOG: file is classified as structural BEFORE any options-based rule (no accidental enum)', () => {
    const result = resolveFieldContract({ type: 'file' });
    expect(result.contractKind).not.toBe('enum');
    expect(result.contractKind).toBe('file');
  });
});

// ---------------------------------------------------------------------------
// T-0480 [D7-K]: resolveFieldContract routes records-form STRUCTURAL types
// (relation/collection/computed) to their catalog contracts, so the record
// screen dispatches off the catalog — not a parallel `inputKind` string chain.
// ---------------------------------------------------------------------------

describe('resolveFieldContract — records-form structural types', () => {
  it('records-form relation descriptor → relation contract (reference)', () => {
    const result = resolveFieldContract({ key: 'supplier', type: 'relation', label: 'Поставщик' });
    expect(result.contractKind).toBe('relation');
    expect(result.presentation).toBe('reference');
    expect(result.editable).toBe(true);
  });

  it('records-form collection descriptor → collection contract (table)', () => {
    const result = resolveFieldContract({ key: 'lines', type: 'collection', label: 'Позиции' });
    expect(result.contractKind).toBe('collection');
    expect(result.presentation).toBe('table');
    expect(result.editable).toBe(true);
  });

  it('records-form computed descriptor → rollup contract (readout, read-only)', () => {
    const result = resolveFieldContract({ key: 'total', type: 'computed', label: 'Итог' });
    expect(result.contractKind).toBe('rollup');
    expect(result.presentation).toBe('readout');
    expect(result.editable).toBe(false);
  });

  it('explicit contract still wins over a structural type', () => {
    const result = resolveFieldContract({ type: 'collection', contract: 'scalar' });
    expect(result.contractKind).toBe('scalar');
  });

  it('structural type with no options is not mis-classified as enum', () => {
    // relation/collection/computed must classify BEFORE the options-force-enum rule.
    const result = resolveFieldContract({ type: 'relation' });
    expect(result.contractKind).toBe('relation');
  });

  it('records-form file descriptor → file contract, presentation="file" (T-0579, AC-4)', () => {
    const result = resolveFieldContract({ key: 'doc', type: 'file', label: 'Договор' });
    expect(result.contractKind).toBe('file');
    expect(result.presentation).toBe('file');
    expect(result.editable).toBe(true);
  });
});
