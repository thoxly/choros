/**
 * T-0212 · P-4 — Pure unit tests for planReconcile (no I/O, no DB).
 *
 * Mirrors doc-regen.test.ts discipline (T-0211): all assertions deterministic,
 * no pg, no fs, no net.
 *
 * Coverage:
 *   F-7a — broken ref → plan regenerates it; post-plan refs lint-clean
 *   F-7b — all members vanished → plan puts slug in orphan (not regenerate); refs=∅
 *   F-7c — clean lint input (ok:true) → empty plan (regenerate=[], orphan=[], logs=[])
 *   targeting — only affected slugs in plan; clean pages emit zero writes
 *   op='reconciled' — log entries use op='reconciled', not 'regenerated'
 *   violation→pageId re-join correctness — join by (refKind, refTarget) UNIQUE tuple
 *   idempotent over clean wiki — empty plan, no writes
 *   post-plan self-guard — checkDocRefs on post-plan refs returns ok:true
 *   counts — correct counts in the plan
 */

import { describe, it, expect } from 'vitest';
import {
  planReconcile,
  type ReconcilePlan,
  type ReconcileError,
} from '../doc-reconcile.js';
import { checkDocRefs } from '../doc-ref-lint.js';
import type { LiveSnapshot, DocLintResult } from '../doc-ref-lint.js';
import type { DocPage, DocRef } from '../../db/doc-page-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTOR = 'docs-author';
const NOW = 1_700_000_000_000;
const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** LiveSnapshot with codeSymbols in two modules + one config key. */
function fullLive(): LiveSnapshot {
  return {
    codeSymbols: new Set([
      'src/core/grant-lattice#BOTTOM',
      'src/core/grant-lattice#RESOURCE_TYPES',
      'src/core/audit-preimage#rowHash',
    ]),
    restEndpoints: new Set(['GET /api/org']),
    schemaFields: new Set(),
    processKeys: new Set(),
    configKeys: new Set(['kc.realm']),
  };
}

/** LiveSnapshot that is missing the 'BOTTOM' symbol from grant-lattice. */
function liveMissingBottom(): LiveSnapshot {
  return {
    ...fullLive(),
    codeSymbols: new Set([
      // 'src/core/grant-lattice#BOTTOM' is GONE
      'src/core/grant-lattice#RESOURCE_TYPES',
      'src/core/audit-preimage#rowHash',
    ]),
  };
}

/** LiveSnapshot where the entire src/core/grant-lattice module is gone. */
function liveMissingGrantLattice(): LiveSnapshot {
  return {
    ...fullLive(),
    codeSymbols: new Set([
      // All grant-lattice symbols are GONE
      'src/core/audit-preimage#rowHash',
    ]),
  };
}

/** An empty LiveSnapshot (all members gone). */
function emptyLive(): LiveSnapshot {
  return {
    codeSymbols: new Set(),
    restEndpoints: new Set(),
    schemaFields: new Set(),
    processKeys: new Set(),
    configKeys: new Set(),
  };
}

/**
 * Builds a DocPage with a code_symbol ref to src/core/grant-lattice#BOTTOM.
 * After REGEN would have been run against fullLive(), this is what would exist.
 */
function makeGrantLatticePageAndRefs(): { page: DocPage; refs: DocRef[] } {
  const pageId = 'page-0000-0000-0000-000000000001';
  const page: DocPage = {
    tenantId: TENANT,
    id: pageId,
    slug: 'code/src-core-grant-lattice',
    title: 'Code symbols — src/core/grant-lattice',
    body: '# Code symbols — src/core/grant-lattice\n\n- `BOTTOM`\n- `RESOURCE_TYPES`\n',
    scope: 'tenant',
    catalogVersion: null,
    appId: null,
    stale: false,
    authoredBy: ACTOR,
    authoredAt: NOW - 10000,
    updatedAt: NOW - 10000,
  };
  const refs: DocRef[] = [
    {
      tenantId: TENANT,
      id: 'ref-0000-0000-0000-000000000001',
      pageId,
      refKind: 'code_symbol',
      refTarget: { module: 'src/core/grant-lattice', symbol: 'BOTTOM' },
      broken: false,
      createdAt: NOW - 10000,
    },
    {
      tenantId: TENANT,
      id: 'ref-0000-0000-0000-000000000002',
      pageId,
      refKind: 'code_symbol',
      refTarget: { module: 'src/core/grant-lattice', symbol: 'RESOURCE_TYPES' },
      broken: false,
      createdAt: NOW - 10000,
    },
  ];
  return { page, refs };
}

/** A second "clean" page with a ref that will NOT be violated. */
function makeAuditPreimagePageAndRefs(): { page: DocPage; refs: DocRef[] } {
  const pageId = 'page-0000-0000-0000-000000000002';
  const page: DocPage = {
    tenantId: TENANT,
    id: pageId,
    slug: 'code/src-core-audit-preimage',
    title: 'Code symbols — src/core/audit-preimage',
    body: '# Code symbols — src/core/audit-preimage\n\n- `rowHash`\n',
    scope: 'tenant',
    catalogVersion: null,
    appId: null,
    stale: false,
    authoredBy: ACTOR,
    authoredAt: NOW - 10000,
    updatedAt: NOW - 10000,
  };
  const refs: DocRef[] = [
    {
      tenantId: TENANT,
      id: 'ref-0000-0000-0000-000000000003',
      pageId,
      refKind: 'code_symbol',
      refTarget: { module: 'src/core/audit-preimage', symbol: 'rowHash' },
      broken: false,
      createdAt: NOW - 10000,
    },
  ];
  return { page, refs };
}

function isPlan(r: ReconcilePlan | ReconcileError): r is ReconcilePlan {
  return !('error' in r);
}

function isError(r: ReconcilePlan | ReconcileError): r is ReconcileError {
  return 'error' in r && r.error === true;
}

// ---------------------------------------------------------------------------
// F-7c — clean lint input → empty plan (idempotent clean-wiki)
// ---------------------------------------------------------------------------

describe('F-7c: clean lint input (ok:true) → empty plan', () => {
  it('clean lint result → plan with empty regenerate, orphan, logs', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = fullLive(); // same as what refs were derived from → all lint-clean

    // Build lint refs in the shape checkDocRefs expects.
    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    expect(lintResult.ok, 'lint should be clean against fullLive').toBe(true);

    const plan = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    expect(isPlan(plan), 'should return a ReconcilePlan').toBe(true);
    if (!isPlan(plan)) throw new Error('expected plan');

    expect(plan.regenerate, 'clean wiki: no regenerations').toHaveLength(0);
    expect(plan.orphan, 'clean wiki: no orphans').toHaveLength(0);
    expect(plan.logs, 'clean wiki: no log entries').toHaveLength(0);
    expect(plan.affectedSlugs, 'clean wiki: no affected slugs').toHaveLength(0);
    expect(plan.counts.pagesRegenerated).toBe(0);
    expect(plan.counts.pagesOrphaned).toBe(0);
    expect(plan.counts.refsFixed).toBe(0);
    expect(plan.counts.logsAppended).toBe(0);
  });

  it('empty currentPages + empty currentRefs + ok lint → empty plan', () => {
    const cleanLint: DocLintResult = { ok: true };
    const plan = planReconcile(cleanLint, fullLive(), [], [], NOW, ACTOR);
    expect(isPlan(plan)).toBe(true);
    if (!isPlan(plan)) throw new Error('expected plan');
    expect(plan.regenerate).toHaveLength(0);
    expect(plan.orphan).toHaveLength(0);
    expect(plan.logs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F-7a — broken ref → plan regenerates the affected page
// ---------------------------------------------------------------------------

describe('F-7a: broken ref → plan regenerates the affected page', () => {
  it('violation on grant-lattice page → that slug is in regenerate', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingBottom(); // BOTTOM is gone

    // Compute lint: BOTTOM ref is broken.
    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    expect(lintResult.ok).toBe(false);

    const plan = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    expect(isPlan(plan)).toBe(true);
    if (!isPlan(plan)) throw new Error('expected plan');

    // The affected slug should be in regenerate (BOTTOM is gone but RESOURCE_TYPES remains,
    // so the module page still has live backing).
    const regenSlugs = plan.regenerate.map((p) => p.slug);
    expect(regenSlugs).toContain('code/src-core-grant-lattice');
    expect(plan.orphan).toHaveLength(0);
    expect(plan.logs.length).toBeGreaterThanOrEqual(1);
    // Log op must be 'reconciled', not 'regenerated'.
    for (const log of plan.logs) {
      expect(log.op).toBe('reconciled');
    }
  });

  it('post-plan refs are lint-clean (checkDocRefs(postPlanRefs, live).ok===true)', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingBottom();

    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    const plan = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    expect(isPlan(plan)).toBe(true);
    if (!isPlan(plan)) throw new Error('expected plan');

    // Collect the post-plan refs (regenerate page refs).
    const postRefs = plan.regenerate.flatMap((p) =>
      p.refs.map((r) => ({
        refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
        refTarget: r.refTarget,
      })),
    );
    const postLint = checkDocRefs(postRefs, live);
    expect(postLint.ok, 'post-plan refs must be lint-clean').toBe(true);
  });

  it('regenerated page refs no longer include the missing referent', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingBottom(); // BOTTOM is gone

    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    const plan = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    if (!isPlan(plan)) throw new Error('expected plan');

    const regenPage = plan.regenerate.find((p) => p.slug === 'code/src-core-grant-lattice');
    expect(regenPage, 'regenerated page missing').toBeDefined();
    // BOTTOM should NOT be in the new ref set.
    const symbols = regenPage!.refs.map((r) => r.refTarget['symbol']);
    expect(symbols).not.toContain('BOTTOM');
    // RESOURCE_TYPES is still live → should remain.
    expect(symbols).toContain('RESOURCE_TYPES');
  });
});

// ---------------------------------------------------------------------------
// F-7b — all members vanished → orphan branch (mark stale, refs cleared, not deleted)
// ---------------------------------------------------------------------------

describe('F-7b: all members vanished → orphan branch', () => {
  it('when entire module is gone → affected slug goes to orphan (not regenerate)', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingGrantLattice(); // ALL grant-lattice symbols gone

    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    expect(lintResult.ok).toBe(false);

    const plan = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    expect(isPlan(plan)).toBe(true);
    if (!isPlan(plan)) throw new Error('expected plan');

    // Orphan branch: no regeneration for this slug.
    const regenSlugs = plan.regenerate.map((p) => p.slug);
    expect(regenSlugs).not.toContain('code/src-core-grant-lattice');

    // Should be in orphan.
    const orphanSlugs = plan.orphan.map((o) => o.slug);
    expect(orphanSlugs).toContain('code/src-core-grant-lattice');
    expect(plan.counts.pagesOrphaned).toBe(1);

    // Orphan plan should have refs=∅ (cleared by setDocRefs([])).
    // The plan itself has OrphanPagePlan (no refs field) — refs are cleared at edge.
    const orphanPlan = plan.orphan.find((o) => o.slug === 'code/src-core-grant-lattice');
    expect(orphanPlan!.pageId).toBe(page.id);
  });

  it('orphan page: log entry has op="reconciled" and diffSummary mentions orphaned', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingGrantLattice();

    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    const plan = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    if (!isPlan(plan)) throw new Error('expected plan');

    const orphanLog = plan.logs.find((l) => l.pageId === page.id);
    expect(orphanLog, 'orphan log entry missing').toBeDefined();
    expect(orphanLog!.op).toBe('reconciled');
    expect(orphanLog!.diffSummary).toContain('orphaned');
  });

  it('orphan: affectedSlugs includes the orphaned slug', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingGrantLattice();

    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    const plan = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    if (!isPlan(plan)) throw new Error('expected plan');

    expect(plan.affectedSlugs).toContain('code/src-core-grant-lattice');
  });
});

// ---------------------------------------------------------------------------
// Targeting — clean pages are NOT in the plan (F-2, "not REGEN" property)
// ---------------------------------------------------------------------------

describe('Targeting: clean pages are not in plan (F-2 property)', () => {
  it('broken ref on page A → only page A is in plan; page B (clean) is absent', () => {
    const { page: pageA, refs: refsA } = makeGrantLatticePageAndRefs();
    const { page: pageB, refs: refsB } = makeAuditPreimagePageAndRefs();
    const live = liveMissingBottom(); // BOTTOM is gone; pageB's ref (rowHash) is still present

    const allRefs = [...refsA, ...refsB];
    const lintRefs = allRefs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    expect(lintResult.ok).toBe(false); // BOTTOM ref is broken

    const plan = planReconcile(lintResult, live, [pageA, pageB], allRefs, NOW, ACTOR);
    expect(isPlan(plan)).toBe(true);
    if (!isPlan(plan)) throw new Error('expected plan');

    // Page A is affected (has broken ref) → in regenerate.
    const regenSlugs = plan.regenerate.map((p) => p.slug);
    expect(regenSlugs).toContain('code/src-core-grant-lattice');

    // Page B is clean → NOT in regenerate, NOT in orphan, NOT in logs.
    expect(regenSlugs).not.toContain('code/src-core-audit-preimage');
    expect(plan.orphan.map((o) => o.slug)).not.toContain('code/src-core-audit-preimage');
    const logPageIds = plan.logs.map((l) => l.pageId);
    expect(logPageIds).not.toContain(pageB.id);
  });

  it('affectedSlugs excludes clean pages', () => {
    const { page: pageA, refs: refsA } = makeGrantLatticePageAndRefs();
    const { page: pageB, refs: refsB } = makeAuditPreimagePageAndRefs();
    const live = liveMissingBottom();

    const allRefs = [...refsA, ...refsB];
    const lintRefs = allRefs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    const plan = planReconcile(lintResult, live, [pageA, pageB], allRefs, NOW, ACTOR);
    if (!isPlan(plan)) throw new Error('expected plan');

    expect(plan.affectedSlugs).not.toContain('code/src-core-audit-preimage');
    expect(plan.affectedSlugs).toContain('code/src-core-grant-lattice');
  });
});

// ---------------------------------------------------------------------------
// Violation→pageId re-join correctness
// ---------------------------------------------------------------------------

describe('violation→pageId re-join: joins by (refKind, refTarget) UNIQUE tuple', () => {
  it('only the page owning the broken ref is in affectedSlugs', () => {
    // pageA has BOTTOM ref (broken)
    // pageB has rowHash ref (clean)
    const { page: pageA, refs: refsA } = makeGrantLatticePageAndRefs();
    const { page: pageB, refs: refsB } = makeAuditPreimagePageAndRefs();
    const live = liveMissingBottom();

    const allRefs = [...refsA, ...refsB];
    const lintRefs = allRefs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    expect(lintResult.ok).toBe(false);

    const plan = planReconcile(lintResult, live, [pageA, pageB], allRefs, NOW, ACTOR);
    if (!isPlan(plan)) throw new Error('expected plan');

    // Only pageA's slug should be affected.
    expect(plan.affectedSlugs).toHaveLength(1);
    expect(plan.affectedSlugs[0]).toBe('code/src-core-grant-lattice');
  });
});

// ---------------------------------------------------------------------------
// op='reconciled' in log entries
// ---------------------------------------------------------------------------

describe('log entries always use op="reconciled"', () => {
  it('regenerate path: log.op is reconciled (not regenerated)', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingBottom();

    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    const plan = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    if (!isPlan(plan)) throw new Error('expected plan');

    for (const log of plan.logs) {
      expect(log.op, 'log.op must be reconciled, never regenerated').toBe('reconciled');
    }
  });

  it('each log entry has a unique id', () => {
    const { page: pageA, refs: refsA } = makeGrantLatticePageAndRefs();
    const { page: pageB, refs: refsB } = makeAuditPreimagePageAndRefs();
    // Both pages have broken refs.
    const liveGone = emptyLive();

    const allRefs = [...refsA, ...refsB];
    const lintRefs = allRefs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, liveGone);
    // With empty live, all refs are broken; both pages are orphans.
    const plan = planReconcile(lintResult, liveGone, [pageA, pageB], allRefs, NOW, ACTOR);
    if (!isPlan(plan)) throw new Error('expected plan');

    const ids = plan.logs.map((l) => l.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size, 'all log IDs must be unique').toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Counts correctness
// ---------------------------------------------------------------------------

describe('counts are correct', () => {
  it('one broken ref on one page: pagesRegenerated=1, pagesOrphaned=0, logsAppended=1', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingBottom(); // BOTTOM gone but module still has live backing

    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    const plan = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    if (!isPlan(plan)) throw new Error('expected plan');

    expect(plan.counts.pagesRegenerated).toBe(1);
    expect(plan.counts.pagesOrphaned).toBe(0);
    expect(plan.counts.logsAppended).toBe(1);
    // refsFixed = number of refs in regenerated plan (the new set).
    expect(plan.counts.refsFixed).toBeGreaterThanOrEqual(1); // at least RESOURCE_TYPES
  });

  it('orphan: pagesOrphaned=1, pagesRegenerated=0, logsAppended=1', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingGrantLattice(); // entire module gone → orphan

    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    const plan = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    if (!isPlan(plan)) throw new Error('expected plan');

    expect(plan.counts.pagesOrphaned).toBe(1);
    expect(plan.counts.pagesRegenerated).toBe(0);
    expect(plan.counts.logsAppended).toBe(1);
    expect(plan.counts.refsFixed).toBe(0); // no refs in orphan plan
  });
});

// ---------------------------------------------------------------------------
// Post-plan self-guard: refs must be lint-clean after plan application
// ---------------------------------------------------------------------------

describe('post-plan self-guard (F-1 correctness invariant)', () => {
  it('plan returns ReconcilePlan (not ReconcileError) when broken refs can be fixed', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingBottom();

    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    const result = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    expect(isPlan(result), 'should be a ReconcilePlan when fix is possible').toBe(true);
  });

  it('plan returns ReconcilePlan (not ReconcileError) for orphan case (no new broken refs)', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingGrantLattice(); // entire module gone → orphan

    const lintRefs = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);
    const result = planReconcile(lintResult, live, [page], refs, NOW, ACTOR);
    // Orphan should not trigger ReconcileError (orphan refs are cleared → zero post-plan refs for it).
    expect(isPlan(result), 'orphan should return ReconcilePlan').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Idempotency over a clean wiki (after a successful reconcile)
// ---------------------------------------------------------------------------

describe('idempotency: clean re-run after reconcile = empty plan', () => {
  it('after fixing, clean lint ⇒ second planReconcile is empty plan', () => {
    const { page, refs } = makeGrantLatticePageAndRefs();
    const live = liveMissingBottom();

    // First run: BOTTOM is broken.
    const lintRefs1 = refs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult1 = checkDocRefs(lintRefs1, live);
    const plan1 = planReconcile(lintResult1, live, [page], refs, NOW, ACTOR);
    expect(isPlan(plan1)).toBe(true);
    if (!isPlan(plan1)) throw new Error('expected plan');

    // After RECONCILE, RESOURCE_TYPES refs are set (BOTTOM dropped).
    // Simulate: post-reconcile currentRefs = plan1's regenerated page refs as DocRef[].
    const regeneratedPage = plan1.regenerate.find((p) => p.slug === 'code/src-core-grant-lattice');
    expect(regeneratedPage, 'regenerated page not found').toBeDefined();

    const postRefs: DocRef[] = regeneratedPage!.refs.map((r) => ({
      tenantId: TENANT,
      id: r.id,
      pageId: page.id,
      refKind: r.refKind,
      refTarget: r.refTarget,
      broken: false,
      createdAt: r.createdAt,
    }));

    // Now compute the post-reconcile lint — should be clean.
    const lintRefs2 = postRefs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult2 = checkDocRefs(lintRefs2, live);
    expect(lintResult2.ok, 'post-reconcile lint should be clean').toBe(true);

    // Second planReconcile with clean lint → empty plan.
    const plan2 = planReconcile(lintResult2, live, [page], postRefs, NOW + 1000, ACTOR);
    expect(isPlan(plan2)).toBe(true);
    if (!isPlan(plan2)) throw new Error('expected plan');

    expect(plan2.regenerate).toHaveLength(0);
    expect(plan2.orphan).toHaveLength(0);
    expect(plan2.logs).toHaveLength(0);
    expect(plan2.affectedSlugs).toHaveLength(0);
  });
});
