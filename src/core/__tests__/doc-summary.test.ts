/**
 * T-0214 · P-6 — Pure unit tests for doc_page.summary population.
 *
 * No I/O, no DB, no pg. Mirrors doc-regen.test.ts discipline.
 *
 * Coverage:
 *   S-1  — every page kind has a non-null, non-empty summary
 *   S-2  — summary contains no newline (one-line invariant, mirrors CHECK 064)
 *   S-3  — summary length ≤ 200 chars (mirrors CHECK 064 constraint)
 *   S-4  — summary is deterministic: same snapshot → same summary across two runs
 *   S-5  — each kind produces a summary matching its documented template
 *   S-6  — empty kinds produce no pages (and thus no summary to verify)
 */

import { describe, it, expect } from 'vitest';
import {
  planRegen,
  type RegenPlan,
} from '../doc-regen.js';
import type { LiveSnapshot } from '../doc-ref-lint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fullLiveSnapshot(): LiveSnapshot {
  return {
    codeSymbols: new Set([
      'src/core/grant-lattice#BOTTOM',
      'src/core/grant-lattice#TOP',
      'src/util/helpers#identity',
    ]),
    restEndpoints: new Set([
      'GET /api/org',
      'POST /api/grants',
      'DELETE /api/grants/:id',
    ]),
    schemaFields: new Set([
      'reg-001#contractNo',
      'reg-001#status',
      'reg-002#amount',
    ]),
    processKeys: new Set(['invoice-approval', 'onboarding']),
    configKeys: new Set(['kc.realm', 'storage.bucket', 'smtp.host']),
  };
}

/** Single-module snapshot to test determinism and code summary template. */
function singleModuleSnapshot(): LiveSnapshot {
  return {
    codeSymbols: new Set(['mymod#alpha', 'mymod#beta']),
    restEndpoints: new Set(),
    schemaFields: new Set(),
    processKeys: new Set(),
    configKeys: new Set(),
  };
}

const ACTOR = 'docs-author';
const NOW = 1_700_000_000_000;

function planOrThrow(live: LiveSnapshot): RegenPlan {
  const result = planRegen(live, [], [], NOW, ACTOR);
  if ('error' in result) throw new Error(`planRegen error: ${JSON.stringify(result.violations)}`);
  return result;
}

// ---------------------------------------------------------------------------
// S-1: every page kind has a non-null, non-empty summary
// ---------------------------------------------------------------------------

describe('S-1: every page has a non-null, non-empty summary', () => {
  it('all pages in a full snapshot have a non-empty summary', () => {
    const plan = planOrThrow(fullLiveSnapshot());
    expect(plan.pages.length, 'expected ≥1 page').toBeGreaterThan(0);
    for (const page of plan.pages) {
      expect(page.summary, `page ${page.slug} summary must not be null`).not.toBeNull();
      expect(page.summary.length, `page ${page.slug} summary must not be empty`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// S-2: summary contains no newline
// ---------------------------------------------------------------------------

describe('S-2: summary is one-line (no newline character)', () => {
  it('no summary contains a newline', () => {
    const plan = planOrThrow(fullLiveSnapshot());
    for (const page of plan.pages) {
      expect(page.summary, `page ${page.slug} summary must not contain newline`)
        .not.toContain('\n');
    }
  });
});

// ---------------------------------------------------------------------------
// S-3: summary length ≤ 200 chars (mirrors migration 064 CHECK)
// ---------------------------------------------------------------------------

describe('S-3: summary length ≤ 200 chars', () => {
  it('all summaries are within the 200-char CHECK constraint', () => {
    const plan = planOrThrow(fullLiveSnapshot());
    for (const page of plan.pages) {
      expect(page.summary.length, `page ${page.slug} summary length must be ≤ 200`)
        .toBeLessThanOrEqual(200);
    }
  });
});

// ---------------------------------------------------------------------------
// S-4: summary is deterministic across two planRegen calls
// ---------------------------------------------------------------------------

describe('S-4: summary is deterministic (stable across identical snapshot inputs)', () => {
  it('two planRegen calls with same snapshot produce identical summaries', () => {
    const live = fullLiveSnapshot();
    const plan1 = planOrThrow(live);
    const plan2 = planOrThrow(live);

    const summaries1 = new Map(plan1.pages.map((p) => [p.slug, p.summary]));
    const summaries2 = new Map(plan2.pages.map((p) => [p.slug, p.summary]));

    expect(summaries1.size, 'page counts must match').toBe(summaries2.size);
    for (const [slug, s1] of summaries1) {
      const s2 = summaries2.get(slug);
      expect(s2, `slug ${slug}: summary must be present in both plans`).toBeDefined();
      expect(s1, `slug ${slug}: summary must be identical across runs`).toBe(s2);
    }
  });
});

// ---------------------------------------------------------------------------
// S-5: kind-specific summary templates
// ---------------------------------------------------------------------------

describe('S-5: kind-specific summary templates', () => {
  it('code kind: summary = "`{n}` code symbols in {module}"', () => {
    const plan = planOrThrow(singleModuleSnapshot());
    // Only code pages in this snapshot (1 module with 2 symbols).
    const codePage = plan.pages.find((p) => p.slug.startsWith('code/'));
    expect(codePage, 'expected a code/ page').toBeDefined();
    expect(codePage!.summary).toBe('`2` code symbols in mymod');
  });

  it('api kind: summary = "`{n}` REST endpoints"', () => {
    const plan = planOrThrow(fullLiveSnapshot());
    const apiPage = plan.pages.find((p) => p.slug === 'api/endpoints');
    expect(apiPage, 'expected api/endpoints page').toBeDefined();
    expect(apiPage!.summary).toBe('`3` REST endpoints');
  });

  it('processes kind: summary = "`{n}` process definitions"', () => {
    const plan = planOrThrow(fullLiveSnapshot());
    const procPage = plan.pages.find((p) => p.slug === 'processes/index');
    expect(procPage, 'expected processes/index page').toBeDefined();
    expect(procPage!.summary).toBe('`2` process definitions');
  });

  it('schema kind: summary = "`{n}` schema fields in {defId}"', () => {
    const plan = planOrThrow(fullLiveSnapshot());
    const schemaPage001 = plan.pages.find((p) => p.slug === 'schema/reg-001');
    expect(schemaPage001, 'expected schema/reg-001 page').toBeDefined();
    expect(schemaPage001!.summary).toBe('`2` schema fields in reg-001');

    const schemaPage002 = plan.pages.find((p) => p.slug === 'schema/reg-002');
    expect(schemaPage002, 'expected schema/reg-002 page').toBeDefined();
    expect(schemaPage002!.summary).toBe('`1` schema fields in reg-002');
  });

  it('config kind: summary = "`{n}` config keys"', () => {
    const plan = planOrThrow(fullLiveSnapshot());
    const configPage = plan.pages.find((p) => p.slug === 'config/keys');
    expect(configPage, 'expected config/keys page').toBeDefined();
    expect(configPage!.summary).toBe('`3` config keys');
  });
});

// ---------------------------------------------------------------------------
// S-6: empty kinds produce no page (no undefined summary issue)
// ---------------------------------------------------------------------------

describe('S-6: empty snapshot produces no pages (no summary to check)', () => {
  it('empty snapshot → 0 pages, no crash', () => {
    const plan = planOrThrow({
      codeSymbols: new Set(),
      restEndpoints: new Set(),
      schemaFields: new Set(),
      processKeys: new Set(),
      configKeys: new Set(),
    });
    expect(plan.pages.length).toBe(0);
  });
});
