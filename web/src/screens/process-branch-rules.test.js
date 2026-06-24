/**
 * web/src/screens/process-branch-rules.test.js — T-0437
 *
 * Unit tests for the «Правила ветвления» navigation affordance pure logic
 * (process-branch-rules.js).
 *
 * Tests mirror the existing screen-test pattern (process-catalog.test.js,
 * agents-form.test.js): pure node environment, no DOM, no React rendering.
 *
 * Assertions verify:
 *   - branchRulesPath returns the correct /processes/:processKey/branch-rules
 *     path for a valid key, and null for invalid/empty keys (UX G3);
 *   - hasBranchRulesAffordance returns true for definition rows that have a
 *     non-empty process_key, false for rows without one (prevents dead enabled
 *     button per OBLIK G3 principle).
 */

import { describe, it, expect } from 'vitest';
import { branchRulesPath, hasBranchRulesAffordance } from './process-branch-rules.js';

// ---------------------------------------------------------------------------
// branchRulesPath
// ---------------------------------------------------------------------------

describe('branchRulesPath — navigation target for branch-rules editor', () => {
  it('returns /processes/:processKey/branch-rules for a simple slug key', () => {
    expect(branchRulesPath('telLinear')).toBe('/processes/telLinear/branch-rules');
  });

  it('URL-encodes the processKey (keys with special chars are safe)', () => {
    expect(branchRulesPath('my process')).toBe('/processes/my%20process/branch-rules');
  });

  it('returns null for null (G3: no dead affordance)', () => {
    expect(branchRulesPath(null)).toBeNull();
  });

  it('returns null for undefined (G3: no dead affordance)', () => {
    expect(branchRulesPath(undefined)).toBeNull();
  });

  it('returns null for an empty string (G3: no dead affordance)', () => {
    expect(branchRulesPath('')).toBeNull();
  });

  it('returns null for a whitespace-only string (G3: no dead affordance)', () => {
    expect(branchRulesPath('   ')).toBeNull();
  });

  it('returns null for non-string types (G3: defensive)', () => {
    expect(branchRulesPath(42)).toBeNull();
    expect(branchRulesPath({})).toBeNull();
  });

  it('roundtrip: the returned path encodes the processKey as the :processKey param', () => {
    const key = 'tel-approval-v2';
    const path = branchRulesPath(key);
    // The param value is always the last segment before nothing (no trailing slash).
    const parts = path.split('/');
    // path: ['', 'processes', <key>, 'branch-rules']
    expect(parts[2]).toBe(encodeURIComponent(key));
    expect(parts[3]).toBe('branch-rules');
  });
});

// ---------------------------------------------------------------------------
// hasBranchRulesAffordance — UX G3 row eligibility
// ---------------------------------------------------------------------------

describe('hasBranchRulesAffordance — determines whether a definition row gets a button', () => {
  it('returns true for a definition with a valid process_key', () => {
    expect(hasBranchRulesAffordance({ process_key: 'telLinear', name: 'ТЭЛ', instance_count: 3 })).toBe(true);
  });

  it('returns false for a definition with an empty process_key (G3: no dead button)', () => {
    expect(hasBranchRulesAffordance({ process_key: '' })).toBe(false);
  });

  it('returns false for a definition with a whitespace process_key (G3: no dead button)', () => {
    expect(hasBranchRulesAffordance({ process_key: '   ' })).toBe(false);
  });

  it('returns false for a definition with no process_key property (G3: no dead button)', () => {
    expect(hasBranchRulesAffordance({ name: 'Процесс без ключа' })).toBe(false);
  });

  it('returns false for a definition with a null process_key (G3: no dead button)', () => {
    expect(hasBranchRulesAffordance({ process_key: null })).toBe(false);
  });

  it('returns false for null / undefined input (defensive)', () => {
    expect(hasBranchRulesAffordance(null)).toBe(false);
    expect(hasBranchRulesAffordance(undefined)).toBe(false);
  });

  it('returns false for non-object input (defensive)', () => {
    expect(hasBranchRulesAffordance('telLinear')).toBe(false);
    expect(hasBranchRulesAffordance(42)).toBe(false);
  });

  it('consistency: hasBranchRulesAffordance(d) true ↔ branchRulesPath(d.process_key) non-null', () => {
    const withKey = { process_key: 'purchase-flow' };
    const withoutKey = { process_key: '' };
    expect(hasBranchRulesAffordance(withKey)).toBe(branchRulesPath(withKey.process_key) !== null);
    expect(hasBranchRulesAffordance(withoutKey)).toBe(branchRulesPath(withoutKey.process_key) !== null);
  });
});
