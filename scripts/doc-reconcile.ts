#!/usr/bin/env npx tsx
/**
 * scripts/doc-reconcile.ts — T-0212 · P-4 RECONCILE operator entry.
 *
 * npm run docs:reconcile
 *
 * Assembles LiveSnapshot → reads current pages/refs → computes lint signal
 * (checkDocRefs) → calls planReconcile → applies plan → emits audit → prints
 * JSON summary → exits 0/1.
 *
 * Usage:
 *   DATABASE_URL=postgres://choros_app:choros_app_dev_pw@localhost:55432/choros \
 *     npm run docs:reconcile [-- --tenant a0000000-0000-0000-0000-000000000001] [--dry-run]
 *
 * --tenant   default = DEFAULT_TENANT (a0000000-0000-0000-0000-000000000001)
 *            Must be a valid UUID (v4-pattern: 8-4-4-4-12 hex digits).
 * --dry-run  assemble + plan + print JSON plan, write nothing
 *
 * Exit codes: 0 = success (or dry-run), 1 = error.
 *
 * Connection discipline (mirrors doc-regen.ts ADR §4):
 *   - Connects as choros_app (NOBYPASSRLS).
 *   - BEGIN; SET LOCAL choros.tenant_id = '<tenant>'; ... COMMIT
 *   - All writes structurally tenant-scoped through RLS (NF-1).
 *   - Never connects as choros_migrator; never bypasses RLS.
 *
 * Static guard (F-10): the DEFAULT_TENANT constant below must equal the dev-tenant UUID.
 * The db test asserts this statically (import + compare) without modifying shared fixtures.
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { assembleFullSnapshot } from '../src/core/doc-live-snapshot.js';
import { checkDocRefs } from '../src/core/doc-ref-lint.js';
import { planReconcile } from '../src/core/doc-reconcile.js';
import {
  readDocPages,
  readDocRefs,
  upsertDocPage,
  setDocRefs,
  appendDocLog,
  markPageStale,
} from '../src/db/doc-page-store.js';
import type { AuditEventInput } from '../src/core/audit-grant-encoder.js';
import { makePgAuditWriter } from '../src/db/audit-writer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default tenant: the dev-tenant UUID (F-10 static assertion target).
 * The db test imports this constant and asserts it equals the dev-tenant UUID,
 * proving the operator command defaults to the right tenant without touching
 * shared dev-tenant fixtures in CI.
 */
export const DEFAULT_TENANT = 'a0000000-0000-0000-0000-000000000001';

/**
 * DocsAuthorAgent actor label (migration 062: employee d0...015, role 'docs-author').
 * Used in authored_by, agent_actor, and audit event actor fields.
 */
export const DOCS_AUTHOR_ACTOR = 'docs-author';

// UUID v4 pattern: 8-4-4-4-12 hex digits (case-insensitive).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// CLI arg parser
// ---------------------------------------------------------------------------

type Args = { tenant: string; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== undefined && a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = 'true';
      }
    }
  }
  return {
    tenant: opts['tenant'] ?? DEFAULT_TENANT,
    dryRun: opts['dry-run'] === 'true',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startMs = Date.now();

  // Validate --tenant is a well-formed UUID before interpolating into SQL GUC.
  if (!UUID_RE.test(args.tenant)) {
    console.error(`[doc-reconcile] ERROR: --tenant must be a valid UUID, got: ${args.tenant}`);
    process.exit(1);
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('[doc-reconcile] ERROR: DATABASE_URL not set');
    process.exit(1);
  }

  // Resolve repo root: scripts/ is one level below repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..');

  // ---- 1. Connect ----
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (err) {
    console.error('[doc-reconcile] ERROR: cannot connect to DB:', (err as Error).message);
    process.exit(1);
  }

  try {
    // ---- 2. Assemble LiveSnapshot (edge: I/O allowed here) ----
    const pgQueryable = {
      query: (sql: string, values?: unknown[]) =>
        client.query(sql, values).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
    };
    const live = await assembleFullSnapshot(repoRoot, pgQueryable, args.tenant);

    // ---- 3. Begin transaction + read current state ----
    await client.query('BEGIN');
    await client.query(`SET LOCAL choros.tenant_id = '${args.tenant}'`);

    const storeClient = {
      query: (sql: string, params?: unknown[]) =>
        client.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
    };

    const currentPages = await readDocPages(storeClient, args.tenant);
    const currentRefs = await readDocRefs(storeClient, args.tenant);

    // ---- 4. Compute lint signal (the RECONCILE input) ----
    // Map currentRefs to the DocRef shape expected by checkDocRefs.
    const lintRefs = currentRefs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);

    // ---- 5. Plan ----
    const nowMs = Date.now();
    const planResult = planReconcile(lintResult, live, currentPages, currentRefs, nowMs, DOCS_AUTHOR_ACTOR);

    if ('error' in planResult) {
      console.error('[doc-reconcile] ERROR: planner self-guard caught dirty post-plan lint:', planResult.violations);
      await client.query('ROLLBACK');
      process.exit(1);
    }

    // Stamp tenantId (plan is pure; edge sets it).
    const plan = { ...planResult, tenantId: args.tenant };

    // ---- 6. Dry-run: print plan and exit ----
    if (args.dryRun) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({
        dryRun: true,
        tenant: args.tenant,
        plan: {
          affectedSlugs: plan.affectedSlugs,
          pagesRegenerated: plan.counts.pagesRegenerated,
          pagesOrphaned: plan.counts.pagesOrphaned,
          refsFixed: plan.counts.refsFixed,
          logsAppended: plan.counts.logsAppended,
          regenerate: plan.regenerate.map((p) => ({
            slug: p.slug,
            action: p.action,
            refCount: p.refs.length,
          })),
          orphan: plan.orphan.map((o) => ({ slug: o.slug, pageId: o.pageId })),
        },
      }, null, 2));
      process.exit(0);
    }

    // ---- 7. Apply plan ----
    //
    // For each regenerate page: upsertDocPage → setDocRefs → appendDocLog('reconciled')
    // For each orphan page: markPageStale(true) → setDocRefs([]) → appendDocLog('reconciled')

    let pagesRegenerated = 0;
    let pagesOrphaned = 0;
    let refsFixed = 0;
    let logsAppended = 0;

    // Apply regenerate path.
    for (const pagePlan of plan.regenerate) {
      const upsertResult = await upsertDocPage(storeClient, args.tenant, {
        id: pagePlan.id,
        slug: pagePlan.slug,
        title: pagePlan.title,
        body: pagePlan.body,
        authoredBy: pagePlan.authoredBy,
        authoredAt: pagePlan.authoredAt,
        updatedAt: pagePlan.updatedAt,
      });

      const resolvedId = upsertResult.id;
      pagesRegenerated++;

      // Set refs (set-replace per page — clears broken refs, inserts live-derived refs).
      const refResult = await setDocRefs(storeClient, args.tenant, resolvedId, pagePlan.refs);
      refsFixed += refResult.set;
    }

    // Apply orphan path.
    for (const orphanPlan of plan.orphan) {
      // markPageStale(true) — tombstone (page survives, stale=true).
      await markPageStale(storeClient, args.tenant, orphanPlan.pageId, true, orphanPlan.nowMs);
      // Clear refs (all backing members gone).
      await setDocRefs(storeClient, args.tenant, orphanPlan.pageId, []);
      pagesOrphaned++;
    }

    // Append doc_log('reconciled') per affected page (use plan.logs).
    for (const logPlan of plan.logs) {
      // Determine the resolved page ID: for regenerated pages the upsert may have
      // kept the existing id; for orphan pages the id is already in the plan.
      // We use logPlan.pageId which is the plan-time id (stable for existing pages).
      await appendDocLog(
        storeClient,
        args.tenant,
        logPlan.pageId,
        logPlan.id,
        logPlan.op,
        logPlan.agentActor,
        logPlan.diffSummary,
        logPlan.at,
      );
      logsAppended++;
    }

    // ---- 8. Emit one run-level audit event (ADR §8: run-level, not per-page) ----
    const auditEvent: AuditEventInput = {
      id: randomUUID(),
      type: 'docs.reconciled',
      actor: DOCS_AUTHOR_ACTOR,
      subject: `tenant:${args.tenant}`,
      scope: null,
      via: null,
      proposed_by: null,
      confirmed_by: null,
      payload: {
        tenant: args.tenant,
        affectedSlugs: plan.affectedSlugs,
        pagesRegenerated,
        pagesOrphaned,
        refsFixed,
        logsAppended,
        durationMs: Date.now() - startMs,
      },
      occurred_at: nowMs,
    };

    const auditWriter = makePgAuditWriter();
    await auditWriter.appendAuditEvent(storeClient, auditEvent);

    // ---- 9. Commit ----
    await client.query('COMMIT');

    // ---- 10. Print JSON summary ----
    const summary = {
      tenant: args.tenant,
      pagesRegenerated,
      pagesOrphaned,
      refsFixed,
      logsAppended,
      durationMs: Date.now() - startMs,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[doc-reconcile] ERROR:', (err as Error).message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

// Only run main() when executed as a CLI script, not when imported by tests.
// ESM pattern: compare the resolved URL to the entry-point argv[1].
// tsx rewrites import.meta.url to a file:// URL; process.argv[1] is the raw path.
// We use a safe startsWith check to handle both .ts and compiled .js paths.
const _scriptPath = fileURLToPath(import.meta.url);
const _entryPath = process.argv[1] ?? '';
if (
  _entryPath === _scriptPath ||
  _entryPath.replace(/\.[jt]s$/, '') === _scriptPath.replace(/\.[jt]s$/, '')
) {
  main();
}
