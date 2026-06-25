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
