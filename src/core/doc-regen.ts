/**
 * T-0211 · P-3 — REGEN procedure: pure planner (ADR §2 / §5 / §6).
 *
 * PURE. No I/O, no DB import, no env reads, no filesystem, no network,
 * no child_process, no import.meta, no process.env, no process.exit.
 * `node:crypto` is the ONLY permitted node import (mirrors document-render.ts).
 * Subject to ci/checks/doc-regen-isolation.sh (F-7).
 *
 * Exports:
 *   planRegen(live, currentPages, currentRefs, nowMs, actor) → RegenPlan | RegenError
 *   slugify(s)      — stable slug derivation (ADR §5.1)
 *   RegenPlan       — typed plan structure
 *   RegenPagePlan   — per-page planned upsert
 *   RegenRefPlan    — per-ref planned upsert
 *   RegenLogPlan    — per-page planned log append
 *   RegenError      — planner error (broken refs self-guard)
 *
 * Architecture (ADR §2):
 *   - Caller (scripts/doc-regen.ts) assembles LiveSnapshot + reads currentPages/Refs
 *   - This planner maps snapshot → RegenPlan (pure, fixture-testable)
 *   - Store (src/db/doc-page-store.ts) applies the plan
 *
 * Precedent: checkDocRefs (T-0238 / doc-ref-lint.ts) — same purity class.
 * Mirrors document-render.ts (T-0235) purity discipline.
 *
 * ADR §12 either-or choices pinned here:
 *   - updated_at: change-guard (body/title change detection at plan level; see §6.2)
 *   - audit: run-level (one audit_event per run, not per page; see §8)
 */

import { randomUUID } from 'node:crypto';

import type { LiveSnapshot, DocRef as LintDocRef } from './doc-ref-lint.js';
import { checkDocRefs } from './doc-ref-lint.js';
import type { DocPage, DocRef } from '../db/doc-page-store.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * Action the store will take for a page:
 * - 'insert'   — new page (no existing row with this slug)
 * - 'update'   — existing page, content changed
 * - 'unchanged' — existing page, content identical (no-op at DB level)
 */
export type PageAction = 'insert' | 'update' | 'unchanged';

/** Planned ref for one page — maps to a doc_ref row INSERT ON CONFLICT DO NOTHING. */
export interface RegenRefPlan {
  /** Candidate id (used for INSERT; ignored on conflict). */
  id: string;
  refKind: string;
  refTarget: Record<string, string>;
  createdAt: number;
}

/** Planned log entry for one page (appended only when action !== 'unchanged'). */
export interface RegenLogPlan {
  id: string;
  op: 'regenerated';
  agentActor: string;
  diffSummary: string | null;
  at: number;
}

/** Planned upsert for one doc_page. */
export interface RegenPagePlan {
  /** Candidate id for INSERT (preserved on conflict). */
  id: string;
  slug: string;
  title: string;
  body: string;
  authoredBy: string;
  authoredAt: number;
  updatedAt: number;
  /** Planned action (pure determination at plan time). */
  action: PageAction;
  /** Planned refs for this page (set-replace). */
  refs: readonly RegenRefPlan[];
  /** Planned log entry (present only when action !== 'unchanged'). */
  log: RegenLogPlan | null;
}

/** Complete REGEN plan — input to applyRegenPlan (at the edge). */
export interface RegenPlan {
  tenantId: string;
  pages: readonly RegenPagePlan[];
  /** Flat list of all planned refs across all pages (for lint self-guard). */
  allRefs: readonly LintDocRef[];
  /** Summary counts. */
  counts: {
    pagesInserted: number;
    pagesUpdated: number;
    pagesUnchanged: number;
    refsPlanned: number;
  };
}

/** Planner error (broken refs detected — self-guard F-4). */
export interface RegenError {
  error: true;
  reason: 'broken_refs';
  violations: ReadonlyArray<{ refKind: string; refTarget: Record<string, string> }>;
}

// ---------------------------------------------------------------------------
// slugify — stable slug derivation (ADR §5.1)
// ---------------------------------------------------------------------------

/**
 * Converts an arbitrary string to a stable URL-safe slug:
 * - lowercase
 * - replace every run of non-[a-z0-9] with a single '-'
 * - trim leading/trailing '-'
 * Identical to the pinned ADR §5.1 algorithm.
 *
 * Examples:
 *   'src/core/grant-lattice' → 'src-core-grant-lattice'
 *   'GET /api/org'           → 'get-api-org'
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Internal: per-kind page group derivation (ADR §5.1)
// ---------------------------------------------------------------------------

/** Internal: one logical page to be planned. */
interface PageSpec {
  kind: 'code' | 'api' | 'processes' | 'schema' | 'config';
  slug: string;
  title: string;
  body: string;
  refs: LintDocRef[];
}

/**
 * Maps LiveSnapshot to an ordered list of PageSpecs (one per logical page).
 * ADR §5.1 grouping:
 *   codeSymbols   → one page per module (slug = `code/<module-slugified>`)
 *   restEndpoints → one index page (slug = `api/endpoints`)
 *   processKeys   → one index page (slug = `processes/index`)
 *   schemaFields  → one page per registryDefId (slug = `schema/<defId>`)
 *   configKeys    → one index page (slug = `config/keys`)
 * Empty kinds produce no page.
 */
function buildPageSpecs(live: LiveSnapshot): PageSpec[] {
  const pages: PageSpec[] = [];

  // ---- codeSymbols: one page per module ----
  const codeByModule = new Map<string, string[]>();
  for (const entry of live.codeSymbols) {
    const hashIdx = entry.lastIndexOf('#');
    if (hashIdx < 0) continue;
    const module = entry.slice(0, hashIdx);
    const symbol = entry.slice(hashIdx + 1);
    if (!codeByModule.has(module)) codeByModule.set(module, []);
    codeByModule.get(module)!.push(symbol);
  }
  for (const [module, symbols] of [...codeByModule.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sortedSymbols = [...symbols].sort();
    const slug = `code/${slugify(module)}`;
    const title = `Code symbols — ${module}`;
    const body = `# Code symbols — ${module}\n\n${sortedSymbols.map((s) => `- \`${s}\``).join('\n')}\n`;
    const refs: LintDocRef[] = sortedSymbols.map((symbol) => ({
      refKind: 'code_symbol' as const,
      refTarget: { module, symbol },
    }));
    pages.push({ kind: 'code', slug, title, body, refs });
  }

  // ---- restEndpoints: one index page ----
  const endpoints = [...live.restEndpoints].sort();
  if (endpoints.length > 0) {
    const slug = 'api/endpoints';
    const title = 'REST endpoints';
    const body = `# REST endpoints\n\n${endpoints.map((e) => `- \`${e}\``).join('\n')}\n`;
    const refs: LintDocRef[] = endpoints.map((entry) => {
      const spaceIdx = entry.indexOf(' ');
      const method = entry.slice(0, spaceIdx);
      const path = entry.slice(spaceIdx + 1);
      return { refKind: 'rest_endpoint' as const, refTarget: { method, path } };
    });
    pages.push({ kind: 'api', slug, title, body, refs });
  }

  // ---- processKeys: one index page ----
  const processKeys = [...live.processKeys].sort();
  if (processKeys.length > 0) {
    const slug = 'processes/index';
    const title = 'Process definitions';
    const body = `# Process definitions\n\n${processKeys.map((k) => `- \`${k}\``).join('\n')}\n`;
    const refs: LintDocRef[] = processKeys.map((processKey) => ({
      refKind: 'process' as const,
      refTarget: { processKey },
    }));
    pages.push({ kind: 'processes', slug, title, body, refs });
  }

  // ---- schemaFields: one page per registryDefId ----
  const schemaByDef = new Map<string, string[]>();
  for (const entry of live.schemaFields) {
    const hashIdx = entry.lastIndexOf('#');
    if (hashIdx < 0) continue;
    const defId = entry.slice(0, hashIdx);
    const fieldKey = entry.slice(hashIdx + 1);
    if (!schemaByDef.has(defId)) schemaByDef.set(defId, []);
    schemaByDef.get(defId)!.push(fieldKey);
  }
  for (const [defId, fields] of [...schemaByDef.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sortedFields = [...fields].sort();
    const slug = `schema/${slugify(defId)}`;
    const title = `Schema fields — ${defId}`;
    const body = `# Schema fields — ${defId}\n\n${sortedFields.map((f) => `- \`${f}\``).join('\n')}\n`;
    const refs: LintDocRef[] = sortedFields.map((fieldKey) => ({
      refKind: 'schema_field' as const,
      refTarget: { registryDefId: defId, fieldKey },
    }));
    pages.push({ kind: 'schema', slug, title, body, refs });
  }

  // ---- configKeys: one index page ----
  const configKeys = [...live.configKeys].sort();
  if (configKeys.length > 0) {
    const slug = 'config/keys';
    const title = 'Config keys';
    const body = `# Config keys\n\n${configKeys.map((k) => `- \`${k}\``).join('\n')}\n`;
    const refs: LintDocRef[] = configKeys.map((key) => ({
      refKind: 'config_key' as const,
      refTarget: { key },
    }));
    pages.push({ kind: 'config', slug, title, body, refs });
  }

  return pages;
}

// ---------------------------------------------------------------------------
// planRegen — main pure planner (ADR §3)
// ---------------------------------------------------------------------------

/**
 * Plans a REGEN run: maps a LiveSnapshot + current DB state to a RegenPlan.
 *
 * PURE — no I/O. All inputs are pre-fetched by the edge (scripts/doc-regen.ts).
 *
 * Steps:
 * 1. Build page specs from LiveSnapshot (§5.1 grouping).
 * 2. For each page spec, determine action (insert/update/unchanged) by comparing
 *    against currentPages keyed by slug.
 * 3. Build typed refs per page (§5.3).
 * 4. Self-assert lint-clean (checkDocRefs on all planned refs, F-4).
 * 5. Return RegenPlan or RegenError.
 *
 * @param live          LiveSnapshot assembled by the edge
 * @param currentPages  current doc_page rows (pre-read by edge)
 * @param currentRefs   current doc_ref rows (pre-read by edge; unused in plan but
 *                      available for future diff — plan uses set-replace via setDocRefs)
 * @param nowMs         injected clock (epoch-ms)
 * @param actor         DocsAuthorAgent actor label (e.g. 'docs-author')
 */
export function planRegen(
  live: LiveSnapshot,
  currentPages: readonly DocPage[],
  currentRefs: readonly DocRef[],
  nowMs: number,
  actor: string,
): RegenPlan | RegenError {
  // Build a slug → current page map for O(1) lookup.
  const currentBySlug = new Map<string, DocPage>();
  for (const p of currentPages) {
    currentBySlug.set(p.slug, p);
  }

  // Build page specs from the live snapshot.
  const specs = buildPageSpecs(live);

  // Collect all planned lint refs (for self-guard F-4).
  const allLintRefs: LintDocRef[] = [];

  const planPages: RegenPagePlan[] = [];
  let pagesInserted = 0;
  let pagesUpdated = 0;
  let pagesUnchanged = 0;

  for (const spec of specs) {
    const existing = currentBySlug.get(spec.slug);

    // Determine action (change-guard — ADR §6.2).
    let action: PageAction;
    let authoredAt: number;
    let pageId: string;

    if (!existing) {
      action = 'insert';
      authoredAt = nowMs;
      pageId = randomUUID();
      pagesInserted++;
    } else if (existing.body !== spec.body || existing.title !== spec.title) {
      action = 'update';
      authoredAt = existing.authoredAt; // preserve on update
      pageId = existing.id;             // keep stable id
      pagesUpdated++;
    } else {
      action = 'unchanged';
      authoredAt = existing.authoredAt;
      pageId = existing.id;
      pagesUnchanged++;
    }

    // Build typed ref plans for this page.
    const refPlans: RegenRefPlan[] = spec.refs.map((r) => ({
      id: randomUUID(),
      refKind: r.refKind,
      refTarget: r.refTarget,
      createdAt: nowMs,
    }));

    // Build log plan (only for non-unchanged pages).
    let log: RegenLogPlan | null = null;
    if (action !== 'unchanged') {
      log = {
        id: randomUUID(),
        op: 'regenerated',
        agentActor: actor,
        diffSummary: action === 'insert' ? 'created' : `body changed`,
        at: nowMs,
      };
    }

    // Accumulate all refs for the lint self-guard.
    allLintRefs.push(...spec.refs);

    planPages.push({
      id: pageId,
      slug: spec.slug,
      title: spec.title,
      body: spec.body,
      authoredBy: actor,
      authoredAt,
      updatedAt: nowMs,
      action,
      refs: refPlans,
      log,
    });
  }

  // F-4: self-assert refs are lint-clean (checkDocRefs on all planned refs against live).
  // This is the load-bearing correctness invariant: broken refs are structurally impossible
  // in REGEN output because refs derive from the same snapshot they lint against.
  // If a mapping bug ever produces a broken ref, this guard catches it before emission.
  const lintResult = checkDocRefs(allLintRefs, live);
  if (!lintResult.ok) {
    return {
      error: true,
      reason: 'broken_refs',
      violations: lintResult.violations.map((v) => ({
        refKind: v.refKind,
        refTarget: v.refTarget,
      })),
    };
  }

  // Suppress unused variable warning (currentRefs not used in plan but required by ADR §3).
  void currentRefs;

  return {
    tenantId: '', // set at edge (scripts/doc-regen.ts knows the tenantId)
    pages: planPages,
    allRefs: allLintRefs,
    counts: {
      pagesInserted,
      pagesUpdated,
      pagesUnchanged,
      refsPlanned: allLintRefs.length,
    },
  };
}
