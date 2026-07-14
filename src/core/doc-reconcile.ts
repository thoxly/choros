/**
 * T-0212 · P-4 — RECONCILE procedure: pure planner (ADR §3 / §4 / §5 / §6).
 *
 * PURE. No I/O, no DB import, no env reads, no filesystem, no network,
 * no child_process, no import.meta, no process.env, no process.exit.
 * `node:crypto` is the ONLY permitted node import (same exception as doc-regen.ts).
 * Subject to ci/checks/doc-reconcile-isolation.sh (F-6).
 *
 * DOES NOT import doc-live-snapshot.js — the planner takes a LiveSnapshot
 * (assembled at the edge); it does not assemble one itself.
 *
 * Exports:
 *   planReconcile(lintResult, live, currentPages, currentRefs, nowMs, actor)
 *                        → ReconcilePlan | ReconcileError
 *   ReconcilePlan        — typed plan structure
 *   ReconcileError       — planner error (post-plan self-guard)
 *   OrphanPagePlan       — per-orphan plan (mark stale + clear refs)
 *   ReconcileLogPlan     — per-affected-page log entry
 *
 * Architecture (ADR §3):
 *   - Caller (scripts/doc-reconcile.ts) assembles LiveSnapshot, reads currentPages/Refs,
 *     computes lintResult via checkDocRefs, passes all into this planner.
 *   - This planner maps (lintResult + live + current state) → ReconcilePlan (pure).
 *   - Store (src/db/doc-page-store.ts) applies the plan.
 *
 * Targeting (ADR §4):
 *   - affectedSlugs = slugs of pages owning ≥1 ref in lintResult.violations (§4.1).
 *   - planRegen is run against live and filtered to affectedSlugs only.
 *   - Clean pages (not in affectedSlugs) emit ZERO writes (the "not REGEN" invariant).
 *
 * Idempotency (ADR §6):
 *   - clean wiki ⇒ lintResult.ok=true ⇒ affectedSlugs=∅ ⇒ empty plan ⇒ no writes.
 *   - all writes go through REGEN's idempotent store helpers (upsert ON CONFLICT slug;
 *     ref set-replace DO NOTHING).
 */

import { randomUUID } from 'node:crypto';

import type { LiveSnapshot, DocRef as LintDocRef, DocLintResult, DocRefViolation } from './doc-ref-lint.js';
import { checkDocRefs } from './doc-ref-lint.js';
import type { DocPage, DocRef } from '../db/doc-page-store.js';
import { planRegen } from './doc-regen.js';
import type { RegenPagePlan } from './doc-regen.js';

// ---------------------------------------------------------------------------
// Re-export for consumers that need to import plan member types from here
// ---------------------------------------------------------------------------

export type { RegenPagePlan };

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Per-orphan plan: mark stale=true + clear refs (tombstone — NOT delete). */
export interface OrphanPagePlan {
  /** The page's stable UUID. */
  pageId: string;
  /** The page's stable slug (audit/summary visibility). */
  slug: string;
  /** Epoch-ms timestamp for the stale-mark write. */
  nowMs: number;
}

/**
 * Per-affected-page log entry (op='reconciled').
 * Replaces REGEN's 'regenerated' op for pages reconcile touches.
 */
export interface ReconcileLogPlan {
  id: string;
  pageId: string;
  op: 'reconciled';
  agentActor: string;
  diffSummary: string | null;
  at: number;
}

/** Complete RECONCILE plan — input to the edge's apply step. */
export interface ReconcilePlan {
  /** '' in core; stamped at edge (mirrors RegenPlan). */
  tenantId: string;
  /** The targeted set (audit/summary visibility). */
  affectedSlugs: readonly string[];
  /**
   * Pages to regenerate (filtered planRegen output, limited to affectedSlugs
   * that still have live backing). Apply via upsertDocPage + setDocRefs.
   */
  regenerate: readonly RegenPagePlan[];
  /**
   * Affected pages with NO live backing (orphans, ADR §2.2).
   * Apply via markPageStale(true) + setDocRefs([]).
   */
  orphan: readonly OrphanPagePlan[];
  /** Per-affected-page 'reconciled' doc_log entries (op='reconciled'). */
  logs: readonly ReconcileLogPlan[];
  counts: {
    pagesRegenerated: number;
    pagesOrphaned: number;
    /** Total refs across all regenerate plans (the new ref set). */
    refsFixed: number;
    logsAppended: number;
  };
}

/**
 * Planner error: the post-plan self-guard detected a surviving broken ref on a
 * regenerated page (impossible if planRegen is correct, but caught defensively).
 */
export interface ReconcileError {
  error: true;
  reason: 'post_reconcile_lint_dirty';
  violations: DocRefViolation[];
}

// ---------------------------------------------------------------------------
// planReconcile — main pure planner (ADR §4/§5/§6)
// ---------------------------------------------------------------------------

/**
 * Plans a RECONCILE run: maps (lintResult + live + current DB state) → ReconcilePlan.
 *
 * PURE — no I/O. All inputs are pre-fetched by the edge (scripts/doc-reconcile.ts).
 *
 * Steps:
 * 1. Compute affectedSlugs from lintResult violations (§4.1).
 *    If lintResult.ok → affectedSlugs=∅ → return empty plan (idempotent clean-wiki, §6.1).
 * 2. Build violation lookup: (refKind, refTarget) → pageId (re-join via currentRefs).
 *    The join key is the doc_ref UNIQUE tuple so it is unambiguous.
 * 3. Run planRegen(live, currentPages, currentRefs, nowMs, actor).
 *    Filter its pages to slug ∈ affectedSlugs → regenerate.
 *    Replace their log.op='regenerated' with op='reconciled'.
 * 4. Orphan detection: affected slugs not in planRegen output → OrphanPagePlan.
 * 5. Post-plan self-guard (F-1): verify planned ref universe is lint-clean
 *    (regenerated pages' refs + unaffected pages' existing refs). If a violation
 *    survives on a regenerated page, return ReconcileError (mapping bug).
 *
 * @param lintResult   output of checkDocRefs(currentRefs, live) — the lint signal
 * @param live         LiveSnapshot assembled by the edge
 * @param currentPages current doc_page rows (pre-read by edge)
 * @param currentRefs  current doc_ref rows (pre-read by edge; used for violation→pageId join)
 * @param nowMs        injected clock (epoch-ms)
 * @param actor        DocsAuthorAgent actor label (e.g. 'docs-author')
 */
export function planReconcile(
  lintResult: DocLintResult,
  live: LiveSnapshot,
  currentPages: readonly DocPage[],
  currentRefs: readonly DocRef[],
  nowMs: number,
  actor: string,
): ReconcilePlan | ReconcileError {
  // ---- 1. Early exit: clean wiki → empty plan (idempotent, §6.1) ----
  if (lintResult.ok) {
    return {
      tenantId: '',
      affectedSlugs: [],
      regenerate: [],
      orphan: [],
      logs: [],
      counts: { pagesRegenerated: 0, pagesOrphaned: 0, refsFixed: 0, logsAppended: 0 },
    };
  }

  // ---- 2. Compute affectedSlugs from violations (§4.1) ----
  //
  // Each violation carries (refKind, refTarget) — no pageId in the lint output.
  // We re-join via currentRefs whose (refKind, refTarget) UNIQUE tuple maps 1:1 to
  // a (pageId → slug). Build a Set<pageId> of affected pages, then map to slugs.

  // Build violation key set: serialize each violation as a canonical string.
  // Must match the serialization used for currentRef lookup below.
  const violationKeys = new Set<string>();
  for (const v of lintResult.violations) {
    violationKeys.add(serializeRefKey(v.refKind, v.refTarget));
  }

  // Build pageId → slug map from currentPages (O(1) lookup below).
  const pageIdToSlug = new Map<string, string>();
  for (const p of currentPages) {
    pageIdToSlug.set(p.id, p.slug);
  }

  // Re-join violations → pageIds.
  const affectedPageIds = new Set<string>();
  for (const ref of currentRefs) {
    if (violationKeys.has(serializeRefKey(ref.refKind, ref.refTarget))) {
      affectedPageIds.add(ref.pageId);
    }
  }

  // Map pageIds → slugs.
  const affectedSlugs = new Set<string>();
  for (const pageId of affectedPageIds) {
    const slug = pageIdToSlug.get(pageId);
    if (slug !== undefined) {
      affectedSlugs.add(slug);
    }
  }

  // If no affected slugs were found (no matching refs in currentRefs), return empty plan.
  // This can happen if violations reference refs not in currentRefs (defensive).
  if (affectedSlugs.size === 0) {
    return {
      tenantId: '',
      affectedSlugs: [],
      regenerate: [],
      orphan: [],
      logs: [],
      counts: { pagesRegenerated: 0, pagesOrphaned: 0, refsFixed: 0, logsAppended: 0 },
    };
  }

  // ---- 3. Run planRegen, filter to affectedSlugs ----
  const regenResult = planRegen(live, currentPages, currentRefs, nowMs, actor);

  // planRegen self-guard fires only if planRegen itself produces broken refs (impossible
  // by construction, since refs derive from live). Propagate defensively.
  if ('error' in regenResult) {
    return {
      error: true,
      reason: 'post_reconcile_lint_dirty',
      violations: regenResult.violations.map((v) => ({
        type: 'missing_referent' as const,
        refKind: v.refKind as never,
        refTarget: v.refTarget,
      })),
    };
  }

  // Filter planRegen output to affectedSlugs only (the "not REGEN" targeting invariant).
  const regenBySlug = new Map<string, RegenPagePlan>();
  for (const page of regenResult.pages) {
    if (affectedSlugs.has(page.slug)) {
      regenBySlug.set(page.slug, page);
    }
  }

  // Build the regenerate list with op replaced from 'regenerated' → 'reconciled'.
  const regenerate: RegenPagePlan[] = [];
  for (const [, page] of regenBySlug) {
    // Replace the log op: REGEN emits op='regenerated', RECONCILE emits op='reconciled'.
    // We produce a new page plan with the log overridden.
    const reconciledPage: RegenPagePlan = {
      ...page,
      log: page.log !== null
        ? { ...page.log, op: 'reconciled' as never }
        : null,
    };
    regenerate.push(reconciledPage);
  }

  // ---- 4. Orphan detection: affected slugs with no live backing (§2.2) ----
  //
  // An orphan slug is in affectedSlugs but NOT in planRegen's output for this slug —
  // meaning planRegen found no live members to project for that slug (all members gone).
  // Cure: mark stale=true + clear refs (tombstone).

  // Build pageId → id map from currentPages for orphan plan.
  const slugToPageId = new Map<string, string>();
  for (const p of currentPages) {
    slugToPageId.set(p.slug, p.id);
  }

  const orphan: OrphanPagePlan[] = [];
  for (const slug of affectedSlugs) {
    if (!regenBySlug.has(slug)) {
      // This affected slug has no live backing → orphan.
      const pageId = slugToPageId.get(slug);
      if (pageId !== undefined) {
        orphan.push({ pageId, slug, nowMs });
      }
      // If the slug is not in currentPages either, it cannot be in currentRefs
      // (FK constraint), so there is nothing to orphan — skip.
    }
  }

  // ---- 5. Build log entries for all affected pages ----
  //
  // Each affected page gets exactly ONE ReconcileLogPlan with op='reconciled'.
  // Regenerated pages: diffSummary describes the fix.
  // Orphan pages: diffSummary = 'orphaned: no live referents'.

  const logs: ReconcileLogPlan[] = [];

  for (const page of regenerate) {
    logs.push({
      id: randomUUID(),
      pageId: page.id,
      op: 'reconciled',
      agentActor: actor,
      diffSummary: page.action === 'insert'
        ? 'reconciled: created'
        : 'reconciled: refs re-derived from live',
      at: nowMs,
    });
  }

  for (const o of orphan) {
    logs.push({
      id: randomUUID(),
      pageId: o.pageId,
      op: 'reconciled',
      agentActor: actor,
      diffSummary: 'orphaned: no live referents',
      at: nowMs,
    });
  }

  // ---- 6. Post-plan self-guard (F-1 correctness invariant, ADR §5 step 4) ----
  //
  // Compute the ref universe that WOULD exist after applying the plan:
  //   - Regenerated pages: use refs from their RegenPagePlan (planRegen-derived, lint-clean).
  //   - Orphan pages: contribute ZERO refs (cleared by setDocRefs([])).
  //   - Unaffected pages: keep their existing refs from currentRefs.
  //
  // checkDocRefs over this universe must return ok:true.
  // If not, a mapping bug produced a surviving broken ref on a regenerated page.

  // Collect regenerated page IDs (for excluding their existing refs from currentRefs).
  const regeneratedPageIds = new Set<string>(regenerate.map((p) => p.id));
  const orphanPageIds = new Set<string>(orphan.map((o) => o.pageId));
  const touchedPageIds = new Set<string>([...regeneratedPageIds, ...orphanPageIds]);

  // Post-plan refs: regenerated pages contribute their plan refs; unaffected pages contribute existing.
  const postPlanRefs: LintDocRef[] = [];

  // From regenerated pages: use plan refs (lint-clean by planRegen's own guard).
  for (const page of regenerate) {
    for (const ref of page.refs) {
      postPlanRefs.push({ refKind: ref.refKind as LintDocRef['refKind'], refTarget: ref.refTarget });
    }
  }
  // Orphan pages contribute zero refs (they are cleared).

  // From unaffected pages: use existing refs from currentRefs.
  for (const ref of currentRefs) {
    if (!touchedPageIds.has(ref.pageId)) {
      postPlanRefs.push({
        refKind: ref.refKind as LintDocRef['refKind'],
        refTarget: ref.refTarget,
      });
    }
  }

  const postGuard = checkDocRefs(postPlanRefs, live);
  if (!postGuard.ok) {
    // A surviving broken ref on a regenerated page — mapping bug.
    return {
      error: true,
      reason: 'post_reconcile_lint_dirty',
      violations: postGuard.violations,
    };
  }

  // ---- 7. Assemble the final plan ----
  const refsFixed = regenerate.reduce((sum, p) => sum + p.refs.length, 0);

  return {
    tenantId: '',
    affectedSlugs: [...affectedSlugs].sort(),
    regenerate,
    orphan,
    logs,
    counts: {
      pagesRegenerated: regenerate.length,
      pagesOrphaned: orphan.length,
      refsFixed,
      logsAppended: logs.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Serializes a (refKind, refTarget) pair to a canonical string for use as a Map/Set key.
 * Must match between violation lookup and currentRef lookup.
 * Uses JSON.stringify with sorted keys for deterministic output.
 */
function serializeRefKey(refKind: string, refTarget: Record<string, string>): string {
  const sortedTarget = Object.fromEntries(
    Object.entries(refTarget).sort(([a], [b]) => a.localeCompare(b)),
  );
  return `${refKind}:${JSON.stringify(sortedTarget)}`;
}
