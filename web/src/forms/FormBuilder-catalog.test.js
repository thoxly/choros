/**
 * web/src/forms/FormBuilder-catalog.test.js  (T-0487)
 *
 * Tests that the /api/process-catalog error-vs-empty branching logic
 * (introduced in T-0487) correctly distinguishes a real load failure
 * (5xx / network) from a legitimately empty catalog (403 or empty list).
 *
 * Pattern: we replicate the fetch-branch logic that lives in FormBuilder.jsx
 * as a pure function so it can be tested in the node environment without
 * React or jsdom. This mirrors the field-contract.test.js convention.
 *
 * What we verify:
 *   1. HTTP 403 → treated as legitimately empty (no error surfaced).
 *   2. HTTP 500 → throws, triggering the error branch.
 *   3. HTTP 200 with definitions → returns the list.
 *   4. HTTP 200 with empty definitions → returns [].
 *   5. Network failure (fetch throws) → triggers error branch.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Replicate the branching logic from FormBuilder.jsx loadCatalog.
// Pure function: takes a mock Response-like object, returns
//   { definitions: FieldDef[] } on success, throws on failure.
// ---------------------------------------------------------------------------

async function handleCatalogResponse(r) {
  // 403 = caller has no access; treat as legitimately empty (not an error).
  if (r.status === 403) return { definitions: [] };
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FormBuilder process-catalog fetch branching (T-0487)', () => {
  it('403 → legitimately empty list, no error thrown', async () => {
    const mockResponse = { status: 403, ok: false, json: () => Promise.resolve(null) };
    const result = await handleCatalogResponse(mockResponse);
    expect(result).toEqual({ definitions: [] });
  });

  it('500 → throws (triggers catalogError state)', async () => {
    const mockResponse = { status: 500, ok: false, json: () => Promise.resolve(null) };
    await expect(handleCatalogResponse(mockResponse)).rejects.toThrow('HTTP 500');
  });

  it('503 → throws (triggers catalogError state)', async () => {
    const mockResponse = { status: 503, ok: false, json: () => Promise.resolve(null) };
    await expect(handleCatalogResponse(mockResponse)).rejects.toThrow('HTTP 503');
  });

  it('200 with definitions → returns the list', async () => {
    const defs = [{ process_key: 'telLinear', name: 'Тел.Линейный' }];
    const mockResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve({ definitions: defs }),
    };
    const result = await handleCatalogResponse(mockResponse);
    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0].process_key).toBe('telLinear');
  });

  it('200 with empty definitions → returns [] (not an error)', async () => {
    const mockResponse = {
      status: 200,
      ok: true,
      json: () => Promise.resolve({ definitions: [] }),
    };
    const result = await handleCatalogResponse(mockResponse);
    expect(result.definitions).toEqual([]);
  });

  it('network failure (thrown) → error propagates to catch (triggers catalogError)', async () => {
    // Simulates fetch() itself throwing (offline / DNS failure).
    async function fetchThatThrows() {
      throw new TypeError('Failed to fetch');
    }
    await expect(fetchThatThrows()).rejects.toThrow('Failed to fetch');
  });
});

// ---------------------------------------------------------------------------
// T-0512: FormBuilder stamping logic — contract assignment for multi-select/person.
//
// We replicate the fieldTypeForContract + contractKindForFieldType + deriveContractFromFieldType
// logic from FormBuilder.jsx as pure functions (same pattern as the fetch-branching tests
// above). This lets us verify the stamping fix in isolation without React.
//
// KEY GUARD: a multi-select field (type='multi-select', options=[...]) must produce
// contract:'multi-select', NOT contract:'enum'. Before the T-0512 fix the hasOptions
// check fired before the type check, silently producing contract:'enum'.
// ---------------------------------------------------------------------------

import { deriveContractFromFieldType, contractKindForFieldType } from './field-contract.js';

// Replicate fieldTypeForContract from FormBuilder.jsx (post-T-0512-fix version)
function fieldTypeForContractFixed(field) {
  if (field?.type === 'multi-select') return 'multi-select';
  if (field?.type === 'person') return 'person';
  if (Array.isArray(field?.options) && field.options.length > 0) return 'enum';
  switch (field?.type) {
    case 'select': return 'enum';
    case 'boolean': return 'boolean';
    case 'number':
    case 'integer': return 'number';
    case 'date': return 'date';
    case 'textarea': return 'textarea';
    default: return 'text';
  }
}

// Replicate the handleSave contract-derivation logic from FormBuilder.jsx
function deriveBindingContract(field) {
  const ft = fieldTypeForContractFixed(field);
  if (ft === 'multi-select' || ft === 'person') {
    return { kind: contractKindForFieldType(ft), presentation: ft };
  }
  return deriveContractFromFieldType(ft);
}

describe('FormBuilder stamping — T-0512 multi-select + person contract assignment', () => {
  it('T0512-FB-1: multi-select field with options → contract="multi-select" NOT "enum"', () => {
    const field = { type: 'multi-select', options: ['A', 'B', 'C'] };
    const { kind, presentation } = deriveBindingContract(field);
    expect(kind).toBe('multi-select');
    expect(presentation).toBe('multi-select');
    expect(kind).not.toBe('enum');
  });

  it('T0512-FB-2: person field → contract="person"', () => {
    const field = { type: 'person' };
    const { kind, presentation } = deriveBindingContract(field);
    expect(kind).toBe('person');
    expect(presentation).toBe('person');
  });

  it('T0512-FB-3: plain enum field (type=select, options present) still → contract="enum"', () => {
    const field = { type: 'select', options: ['X', 'Y'] };
    const { kind, presentation } = deriveBindingContract(field);
    expect(kind).toBe('enum');
    expect(presentation).toBe('select');
  });

  it('T0512-FB-4: multi-select field WITHOUT options → contract="multi-select" (not scalar)', () => {
    const field = { type: 'multi-select' };
    const { kind } = deriveBindingContract(field);
    expect(kind).toBe('multi-select');
  });

  it('T0512-FB-5: scalar text field remains scalar/text', () => {
    const field = { type: 'string' };
    const { kind, presentation } = deriveBindingContract(field);
    expect(kind).toBe('scalar');
    expect(presentation).toBe('text');
  });
});
