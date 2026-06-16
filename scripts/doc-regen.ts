#!/usr/bin/env npx tsx
/**
 * scripts/doc-regen.ts — T-0211 · P-3 REGEN operator entry.
 *
 * npm run docs:regen
 *
 * Assembles LiveSnapshot → reads current pages/refs → calls planRegen →
 * applies plan (upsert pages, set refs, append log, emit audit) → prints
 * JSON summary → exits 0/1.
 *
 * Usage:
 *   DATABASE_URL=postgres://choros_app:choros_app_dev_pw@localhost:55432/choros \
 *     npm run docs:regen [-- --tenant a0000000-0000-0000-0000-000000000001] [--dry-run]
 *
 * --tenant   default = DEV_TENANT (a0000000-0000-0000-0000-000000000001)
 * --dry-run  assemble + plan + print JSON plan, write nothing
 *
 * Exit codes: 0 = success (or dry-run), 1 = error.
 *
 * Connection discipline (ADR §4):
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
import { planRegen } from '../src/core/doc-regen.js';
import {
  readDocPages,
  readDocRefs,
  upsertDocPage,
  setDocRefs,
  appendDocLog,
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

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('[doc-regen] ERROR: DATABASE_URL not set');
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
    console.error('[doc-regen] ERROR: cannot connect to DB:', (err as Error).message);
    process.exit(1);
  }

  try {
    // ---- 2. Assemble LiveSnapshot (edge: I/O allowed here) ----
    // The DB-backed parts (schemaFields, configKeys) use a migrator-role queryable
    // for the snapshot assembly — we pass the connected client.
    // Note: in the script context, DATABASE_URL may be choros_app or choros_migrator.
    // The snapshot queries (registry_def, mcp_tool) are informational and use the
    // supplied client's credentials. RLS is not relevant for read-only snapshot queries.
    const pgQueryable = {
      query: (sql: string, values?: unknown[]) =>
        client.query(sql, values).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
    };
    const live = await assembleFullSnapshot(repoRoot, pgQueryable, args.tenant);

    // ---- 3. Read current pages/refs (inside future transaction scope) ----
    // We read outside the write transaction to get a consistent pre-plan view.
    // The write transaction will then apply the plan idempotently.
    await client.query('BEGIN');
    await client.query(`SET LOCAL choros.tenant_id = '${args.tenant}'`);

    const currentPages = await readDocPages(pgQueryable, args.tenant);
    const currentRefs = await readDocRefs(pgQueryable, args.tenant);

    // ---- 4. Plan ----
    const nowMs = Date.now();
    const planResult = planRegen(live, currentPages, currentRefs, nowMs, DOCS_AUTHOR_ACTOR);

    if ('error' in planResult) {
      console.error('[doc-regen] ERROR: planner self-guard caught broken refs:', planResult.violations);
      await client.query('ROLLBACK');
      process.exit(1);
    }

    // Stamp tenantId (plan is pure; edge sets it).
    const plan = { ...planResult, tenantId: args.tenant };

    // ---- 5. Dry-run: print plan and exit ----
    if (args.dryRun) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({
        dryRun: true,
        tenant: args.tenant,
        plan: {
          pagesInserted: plan.counts.pagesInserted,
          pagesUpdated: plan.counts.pagesUpdated,
          pagesUnchanged: plan.counts.pagesUnchanged,
          refsPlanned: plan.counts.refsPlanned,
          pages: plan.pages.map((p) => ({
            slug: p.slug,
            action: p.action,
            refCount: p.refs.length,
          })),
        },
      }, null, 2));
      process.exit(0);
    }

    // ---- 6. Apply plan: upsert pages → set refs → append log → commit ----
    let pagesUpserted = 0;
    let pagesUnchanged = 0;
    let refsSet = 0;
    let logsAppended = 0;

    const storeClient = {
      query: (sql: string, params?: unknown[]) =>
        client.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
    };

    for (const pagePlan of plan.pages) {
      // Upsert page.
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

      if (upsertResult.action !== 'unchanged') {
        pagesUpserted++;
      } else {
        pagesUnchanged++;
      }

      // Set refs (set-replace per page).
      const refResult = await setDocRefs(storeClient, args.tenant, resolvedId, pagePlan.refs);
      refsSet += refResult.set;

      // Append log only for non-unchanged pages.
      if (pagePlan.log !== null && upsertResult.action !== 'unchanged') {
        await appendDocLog(
          storeClient,
          args.tenant,
          resolvedId,
          pagePlan.log.id,
          pagePlan.log.op,
          pagePlan.log.agentActor,
          pagePlan.log.diffSummary,
          pagePlan.log.at,
        );
        logsAppended++;
      }
    }

    // ---- 7. Emit one run-level audit event (ADR §8: run-level, not per-page) ----
    // Audit is emitted inside the transaction so ROLLBACK undoes it.
    const auditEvent: AuditEventInput = {
      id: randomUUID(),
      type: 'docs.regenerated',
      actor: DOCS_AUTHOR_ACTOR,
      subject: `tenant:${args.tenant}`,
      scope: null,
      via: null,
      proposed_by: null,
      confirmed_by: null,
      payload: {
        tenant: args.tenant,
        pagesUpserted,
        pagesUnchanged,
        refsSet,
        logsAppended,
        durationMs: Date.now() - startMs,
      },
      occurred_at: nowMs,
    };

    const auditWriter = makePgAuditWriter();
    await auditWriter.appendAuditEvent(storeClient, auditEvent);

    // ---- 8. Commit ----
    await client.query('COMMIT');

    // ---- 9. Print JSON summary ----
    const summary = {
      tenant: args.tenant,
      pagesUpserted,
      pagesUnchanged,
      refsSet,
      logsAppended,
      durationMs: Date.now() - startMs,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[doc-regen] ERROR:', (err as Error).message);
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
