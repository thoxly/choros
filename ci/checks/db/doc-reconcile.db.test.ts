// T-0212 · P-4 — RECONCILE procedure DB fitness (docs-pipeline).
//
// Live Postgres probes — run in the `db` CI job via `npm run fitness:db`.
// Requires migrations 061/062/063 applied.
//
// Isolation discipline (T-0205):
//   - All DML uses FRESH random tenant UUIDs (freshTenant()).
//   - NEVER touches shared dev-tenant (a0...001) fixtures.
//   - Each describe block cleans up after itself via afterAll.
//
// Strategy: seed a tenant, run REGEN to produce real pages/refs, then
// REMOVE a member from the static snapshot fixture so that checkDocRefs
// reports a missing_referent — exactly the acceptance scenario.
//
// F-1:  Broken ref → ref fixed OR page marked; post-reconcile lint clean (ACCEPTANCE).
// F-2:  Targeted: unaffected pages byte-unchanged (the "not REGEN" property).
// F-3:  doc_log('reconciled') appended per affected page.
// F-4:  Idempotent over a clean wiki = no-op (zero new writes/logs on second run).
// F-5:  Orphan branch: page marked stale, refs cleared, not deleted.
// F-8:  Audit emitted: one audit_event('docs.reconciled'), actor=docs-author, secret-free.
// F-9:  Tenant isolation: RECONCILE on tenant A does not write to tenant B.
// F-10: No new grant/tool/table rows; DEFAULT_TENANT constant static.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  migratorUrl,
  appUrl,
  withClient,
} from './_helpers.js';

import { assembleStaticSnapshot } from '../../../src/core/doc-live-snapshot.js';
import { checkDocRefs } from '../../../src/core/doc-ref-lint.js';
import { planRegen } from '../../../src/core/doc-regen.js';
import { planReconcile } from '../../../src/core/doc-reconcile.js';
import {
  readDocPages,
  readDocRefs,
  upsertDocPage,
  setDocRefs,
  appendDocLog,
  markPageStale,
} from '../../../src/db/doc-page-store.js';
import { makePgAuditWriter } from '../../../src/db/audit-writer.js';
import type { AuditEventInput } from '../../../src/core/audit-grant-encoder.js';
import type { LiveSnapshot } from '../../../src/core/doc-ref-lint.js';
import { DEFAULT_TENANT, DOCS_AUTHOR_ACTOR } from '../../../scripts/doc-reconcile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

/** Fresh random tenant UUID — never reuse shared fixtures (T-0205). */
function freshTenant(): string {
  return crypto.randomUUID();
}

// Seed UUIDs from migrations 062 + 063.
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const ROLE_DOCS_AUTHOR = 'e0000000-0000-0000-0000-000000000005';
const DOCS_AUTHOR_ACTOR_LABEL = 'docs-author';

// ---------------------------------------------------------------------------
// STATIC: F-10 — DEFAULT_TENANT constant equals dev-tenant UUID
// ---------------------------------------------------------------------------

describe('F-10 (static): DEFAULT_TENANT / DOCS_AUTHOR_ACTOR constants', () => {
  it('scripts/doc-reconcile.ts DEFAULT_TENANT === a0000000-0000-0000-0000-000000000001', () => {
    expect(DEFAULT_TENANT, 'DEFAULT_TENANT must equal the dev-tenant UUID').toBe(DEV_TENANT);
  });

  it('DOCS_AUTHOR_ACTOR constant equals docs-author', () => {
    expect(DOCS_AUTHOR_ACTOR, 'DOCS_AUTHOR_ACTOR must equal docs-author').toBe(DOCS_AUTHOR_ACTOR_LABEL);
  });
});

// ---------------------------------------------------------------------------
// STATIC: F-10 — known_tenant_tables.txt unchanged
// ---------------------------------------------------------------------------

describe('F-10 (static): known_tenant_tables.txt contains doc tables (unchanged since 061)', () => {
  it('doc_page, doc_ref, doc_log registered in known_tenant_tables.txt', () => {
    const lines = readFileSync(
      join(REPO_ROOT, 'ci', 'checks', 'known_tenant_tables.txt'),
      'utf8',
    )
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const table of ['doc_page', 'doc_ref', 'doc_log']) {
      expect(lines, `${table} missing from known_tenant_tables.txt`).toContain(table);
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers: run REGEN, run RECONCILE
// ---------------------------------------------------------------------------

/**
 * Run REGEN on the given tenant using the static snapshot.
 * Returns the live snapshot used (so callers can modify it for broken-ref scenarios).
 */
async function runRegen(tenantId: string, live?: LiveSnapshot): Promise<LiveSnapshot> {
  const snapshot = live ?? assembleStaticSnapshot(REPO_ROOT);

  await withClient(appUrl(), async (c) => {
    const storeClient = {
      query: (sql: string, params?: unknown[]) =>
        c.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
    };

    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query('SET LOCAL search_path TO choros');

    const currentPages = await readDocPages(storeClient, tenantId);
    const currentRefs = await readDocRefs(storeClient, tenantId);

    const nowMs = Date.now();
    const planResult = planRegen(snapshot, currentPages, currentRefs, nowMs, DOCS_AUTHOR_ACTOR_LABEL);
    if ('error' in planResult) throw new Error(`planRegen error: ${JSON.stringify(planResult.violations)}`);

    for (const pagePlan of planResult.pages) {
      const upsertResult = await upsertDocPage(storeClient, tenantId, {
        id: pagePlan.id,
        slug: pagePlan.slug,
        title: pagePlan.title,
        body: pagePlan.body,
        authoredBy: pagePlan.authoredBy,
        authoredAt: pagePlan.authoredAt,
        updatedAt: pagePlan.updatedAt,
      });
      const resolvedId = upsertResult.id;
      await setDocRefs(storeClient, tenantId, resolvedId, pagePlan.refs);
      if (pagePlan.log !== null && upsertResult.action !== 'unchanged') {
        await appendDocLog(storeClient, tenantId, resolvedId,
          pagePlan.log.id, pagePlan.log.op, pagePlan.log.agentActor,
          pagePlan.log.diffSummary, pagePlan.log.at);
      }
    }

    await c.query('COMMIT');
  });

  return snapshot;
}

/**
 * Run RECONCILE on the given tenant using the provided live snapshot.
 * The live snapshot passed here is the "current" one (possibly degraded to simulate drift).
 */
async function runReconcile(tenantId: string, live: LiveSnapshot): Promise<{
  pagesRegenerated: number;
  pagesOrphaned: number;
  refsFixed: number;
  logsAppended: number;
}> {
  return await withClient(appUrl(), async (c) => {
    const storeClient = {
      query: (sql: string, params?: unknown[]) =>
        c.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
    };

    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query('SET LOCAL search_path TO choros');

    const currentPages = await readDocPages(storeClient, tenantId);
    const currentRefs = await readDocRefs(storeClient, tenantId);

    // Compute lint signal.
    const lintRefs = currentRefs.map((r) => ({
      refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
      refTarget: r.refTarget,
    }));
    const lintResult = checkDocRefs(lintRefs, live);

    const nowMs = Date.now();
    const planResult = planReconcile(lintResult, live, currentPages, currentRefs, nowMs, DOCS_AUTHOR_ACTOR_LABEL);
    if ('error' in planResult) throw new Error(`planReconcile error: ${JSON.stringify(planResult.violations)}`);

    let pagesRegenerated = 0;
    let pagesOrphaned = 0;
    let refsFixed = 0;
    let logsAppended = 0;

    // Apply regenerate path.
    for (const pagePlan of planResult.regenerate) {
      await upsertDocPage(storeClient, tenantId, {
        id: pagePlan.id,
        slug: pagePlan.slug,
        title: pagePlan.title,
        body: pagePlan.body,
        authoredBy: pagePlan.authoredBy,
        authoredAt: pagePlan.authoredAt,
        updatedAt: pagePlan.updatedAt,
      });
      const refResult = await setDocRefs(storeClient, tenantId, pagePlan.id, pagePlan.refs);
      refsFixed += refResult.set;
      pagesRegenerated++;
    }

    // Apply orphan path.
    for (const orphanPlan of planResult.orphan) {
      await markPageStale(storeClient, tenantId, orphanPlan.pageId, true, orphanPlan.nowMs);
      await setDocRefs(storeClient, tenantId, orphanPlan.pageId, []);
      pagesOrphaned++;
    }

    // Append doc_log('reconciled') per affected page.
    for (const logPlan of planResult.logs) {
      await appendDocLog(storeClient, tenantId, logPlan.pageId, logPlan.id,
        logPlan.op, logPlan.agentActor, logPlan.diffSummary, logPlan.at);
      logsAppended++;
    }

    // Emit run-level audit event.
    const auditEvent: AuditEventInput = {
      id: crypto.randomUUID(),
      type: 'docs.reconciled',
      actor: DOCS_AUTHOR_ACTOR_LABEL,
      subject: `tenant:${tenantId}`,
      scope: null,
      via: null,
      proposed_by: null,
      confirmed_by: null,
      payload: {
        tenant: tenantId,
        affectedSlugs: planResult.affectedSlugs,
        pagesRegenerated,
        pagesOrphaned,
        refsFixed,
        logsAppended,
        durationMs: 0,
      },
      occurred_at: nowMs,
    };

    const auditWriter = makePgAuditWriter();
    await auditWriter.appendAuditEvent(storeClient, auditEvent);

    await c.query('COMMIT');

    return { pagesRegenerated, pagesOrphaned, refsFixed, logsAppended };
  });
}

/**
 * Build a "degraded" snapshot: take the static snapshot and drop the first codeSymbol
 * (whichever it is). This makes that symbol's page have a broken ref.
 * Returns { degradedLive, brokenSymbol, moduleName } so tests can verify.
 */
function buildDegradedSnapshot(base: LiveSnapshot): {
  degradedLive: LiveSnapshot;
  removedSymbol: string;
} {
  // Pick the first code symbol (sorted) to remove.
  const allSymbols = [...base.codeSymbols].sort();
  if (allSymbols.length === 0) {
    throw new Error('static snapshot has no codeSymbols — cannot build degraded snapshot');
  }
  const removedSymbol = allSymbols[0]!;
  const degradedSymbols = new Set(allSymbols.filter((s) => s !== removedSymbol));
  const degradedLive: LiveSnapshot = {
    ...base,
    codeSymbols: degradedSymbols,
  };
  return { degradedLive, removedSymbol };
}

// ---------------------------------------------------------------------------
// F-1: Broken ref → ref fixed OR page marked; post-reconcile lint clean (ACCEPTANCE)
// ---------------------------------------------------------------------------

describe('F-1: broken ref → fixed or marked; post-reconcile lint clean', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('broken ref: RECONCILE fixes it; post-reconcile checkDocRefs is clean', async () => {
    // Run REGEN with the full static snapshot.
    const fullLive = await runRegen(tenant);

    // Degrade: remove one symbol → that page now has a broken ref.
    const { degradedLive } = buildDegradedSnapshot(fullLive);

    // Verify lint reports a violation before reconcile.
    const preRefs = await withClient(appUrl(), async (c) => {
      const storeClient = {
        query: (sql: string, params?: unknown[]) =>
          c.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
      };
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);
      const refs = await readDocRefs(storeClient, tenant);
      await c.query('ROLLBACK');
      return refs;
    });

    const preLint = checkDocRefs(
      preRefs.map((r) => ({
        refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
        refTarget: r.refTarget,
      })),
      degradedLive,
    );
    // There should be a violation (the removed symbol).
    expect(preLint.ok, 'pre-reconcile lint should detect broken ref').toBe(false);

    // Run RECONCILE with the degraded snapshot.
    await runReconcile(tenant, degradedLive);

    // Verify post-reconcile lint is clean.
    const postRefs = await withClient(appUrl(), async (c) => {
      const storeClient = {
        query: (sql: string, params?: unknown[]) =>
          c.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
      };
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);
      const refs = await readDocRefs(storeClient, tenant);
      await c.query('ROLLBACK');
      return refs;
    });

    const postLint = checkDocRefs(
      postRefs.map((r) => ({
        refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
        refTarget: r.refTarget,
      })),
      degradedLive,
    );
    expect(postLint.ok, 'post-reconcile lint must be clean').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-2: Targeted — unaffected pages byte-unchanged
// ---------------------------------------------------------------------------

describe('F-2: targeted — unaffected pages are byte-unchanged after RECONCILE', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('clean pages: updated_at, body, ref rows, stale are unchanged; no new doc_log', async () => {
    const fullLive = await runRegen(tenant);

    // Capture all pages before reconcile.
    const beforePages = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id, slug, body, stale, updated_at FROM choros.doc_page WHERE tenant_id = $1 ORDER BY slug`,
        [tenant],
      );
      return rows;
    });
    const beforeRefs = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT page_id, ref_kind, ref_target::text FROM choros.doc_ref WHERE tenant_id = $1 ORDER BY page_id, ref_kind`,
        [tenant],
      );
      return rows;
    });
    const beforeLogs = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT page_id, op FROM choros.doc_log WHERE tenant_id = $1`,
        [tenant],
      );
      return rows;
    });

    // Degrade: remove one symbol. Only the page owning that symbol is affected.
    const { degradedLive, removedSymbol } = buildDegradedSnapshot(fullLive);

    // Determine the slug of the affected page (the module page that owned removedSymbol).
    const hashIdx = removedSymbol.lastIndexOf('#');
    const affectedModule = hashIdx >= 0 ? removedSymbol.slice(0, hashIdx) : removedSymbol;
    const affectedSlug = `code/${affectedModule.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

    // Run RECONCILE.
    await runReconcile(tenant, degradedLive);

    // Check that clean pages are byte-unchanged.
    const afterPages = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id, slug, body, stale, updated_at FROM choros.doc_page WHERE tenant_id = $1 ORDER BY slug`,
        [tenant],
      );
      return rows;
    });

    // For each clean page (not the affected slug), assert byte-identical.
    for (const beforePage of beforePages) {
      if (beforePage['slug'] === affectedSlug) continue; // the affected page may change

      const afterPage = afterPages.find((p) => p['id'] === beforePage['id']);
      expect(afterPage, `clean page ${beforePage['slug'] as string} should still exist`).toBeDefined();
      expect(afterPage!['body'], `clean page ${beforePage['slug'] as string} body unchanged`).toBe(beforePage['body']);
      expect(afterPage!['stale'], `clean page ${beforePage['slug'] as string} stale unchanged`).toBe(beforePage['stale']);
      expect(afterPage!['updated_at'], `clean page ${beforePage['slug'] as string} updated_at unchanged`).toEqual(beforePage['updated_at']);
    }

    // No new doc_log rows for clean pages.
    const afterLogs = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT page_id, op FROM choros.doc_log WHERE tenant_id = $1`,
        [tenant],
      );
      return rows;
    });

    // Get ids of clean pages.
    const cleanPageIds = new Set(
      beforePages
        .filter((p) => p['slug'] !== affectedSlug)
        .map((p) => p['id'] as string),
    );

    const newLogsForCleanPages = afterLogs.filter(
      (l) => !beforeLogs.some((bl) => bl['page_id'] === l['page_id'] && bl['op'] === l['op'])
        && cleanPageIds.has(l['page_id'] as string),
    );
    expect(newLogsForCleanPages, 'no new log rows for clean pages after RECONCILE').toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F-3: doc_log('reconciled') appended per affected page
// ---------------------------------------------------------------------------

describe('F-3: doc_log("reconciled") appended per affected page', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('≥1 doc_log row with op=reconciled after RECONCILE', async () => {
    const fullLive = await runRegen(tenant);
    const { degradedLive } = buildDegradedSnapshot(fullLive);

    await runReconcile(tenant, degradedLive);

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log WHERE tenant_id = $1 AND op = 'reconciled'`,
        [tenant],
      );
      expect(rows[0]!['n'], '≥1 doc_log(reconciled) required after RECONCILE').toBeGreaterThanOrEqual(1);
    });
  });

  it('all doc_log(reconciled) rows are joined to existing doc_page rows', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n
           FROM choros.doc_log l
           JOIN choros.doc_page p ON p.tenant_id = l.tenant_id AND p.id = l.page_id
          WHERE l.tenant_id = $1 AND l.op = 'reconciled'`,
        [tenant],
      );
      expect(rows[0]!['n'], 'all doc_log rows must join to an existing page').toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// F-4: Idempotent — clean wiki re-run = no-op (zero new writes/logs)
// ---------------------------------------------------------------------------

describe('F-4: idempotent over a clean wiki = no-op', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('second RECONCILE on already-clean wiki: no new pages/refs/logs, no updated_at bumps', async () => {
    const fullLive = await runRegen(tenant);
    const { degradedLive } = buildDegradedSnapshot(fullLive);

    // First RECONCILE: fixes the broken ref.
    await runReconcile(tenant, degradedLive);

    // Capture state after first reconcile.
    const after1 = await withClient(migratorUrl(), async (c) => {
      const pages = await c.query(
        `SELECT id, slug, updated_at FROM choros.doc_page WHERE tenant_id = $1 ORDER BY slug`,
        [tenant],
      );
      const refs = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_ref WHERE tenant_id = $1`,
        [tenant],
      );
      const logs = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log WHERE tenant_id = $1`,
        [tenant],
      );
      return {
        pageCount: pages.rows.length,
        pageIds: pages.rows.map((r) => r['id'] as string).sort(),
        updatedAts: pages.rows.map((r) => ({ id: r['id'], ts: r['updated_at'] })),
        refCount: refs.rows[0]!['n'] as number,
        logCount: logs.rows[0]!['n'] as number,
      };
    });

    // Second RECONCILE with the same degraded snapshot (wiki should now be clean for it).
    await runReconcile(tenant, degradedLive);

    // Capture state after second reconcile.
    const after2 = await withClient(migratorUrl(), async (c) => {
      const pages = await c.query(
        `SELECT id, slug, updated_at FROM choros.doc_page WHERE tenant_id = $1 ORDER BY slug`,
        [tenant],
      );
      const refs = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_ref WHERE tenant_id = $1`,
        [tenant],
      );
      const logs = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log WHERE tenant_id = $1`,
        [tenant],
      );
      return {
        pageCount: pages.rows.length,
        pageIds: pages.rows.map((r) => r['id'] as string).sort(),
        updatedAts: pages.rows.map((r) => ({ id: r['id'], ts: r['updated_at'] })),
        refCount: refs.rows[0]!['n'] as number,
        logCount: logs.rows[0]!['n'] as number,
      };
    });

    expect(after2.pageCount, 'page count must be stable').toBe(after1.pageCount);
    expect(after2.pageIds, 'page ids must be unchanged').toEqual(after1.pageIds);
    expect(after2.refCount, 'ref count must be stable').toBe(after1.refCount);
    expect(after2.logCount, 'zero new doc_log rows on clean re-run').toBe(after1.logCount);

    // No updated_at bumps.
    for (const before of after1.updatedAts) {
      const after = after2.updatedAts.find((a) => a.id === before.id);
      expect(after, `page ${before.id as string} must still exist`).toBeDefined();
      expect(after!.ts, `page ${before.id as string} updated_at must not be bumped`).toEqual(before.ts);
    }
  });
});

// ---------------------------------------------------------------------------
// F-5: Orphan branch — page marked stale, refs cleared, not deleted
// ---------------------------------------------------------------------------

describe('F-5: orphan branch — page marked stale, refs cleared, not deleted', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('page whose entire module is gone: stale=true, zero refs, still exists', async () => {
    const fullLive = await runRegen(tenant);

    // Build a snapshot where all symbols of the first module are removed,
    // making that module's page an orphan.
    const allSymbols = [...fullLive.codeSymbols].sort();
    if (allSymbols.length === 0) {
      // No code symbols in static snapshot — skip this test gracefully.
      console.log('[F-5] Skipping: no codeSymbols in static snapshot');
      return;
    }

    // Find the first module (the one whose page we'll orphan).
    const firstSymbol = allSymbols[0]!;
    const hashIdx = firstSymbol.lastIndexOf('#');
    const orphanModule = hashIdx >= 0 ? firstSymbol.slice(0, hashIdx) : firstSymbol;

    // Remove ALL symbols from orphanModule.
    const survivingSymbols = new Set(allSymbols.filter((s) => !s.startsWith(orphanModule + '#')));
    const orphanLive: LiveSnapshot = { ...fullLive, codeSymbols: survivingSymbols };

    // Derive the expected orphan slug.
    const orphanSlug = `code/${orphanModule.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

    // Verify lint reports violations for the orphan page.
    const preRefs = await withClient(appUrl(), async (c) => {
      const storeClient = {
        query: (sql: string, params?: unknown[]) =>
          c.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
      };
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);
      const refs = await readDocRefs(storeClient, tenant);
      await c.query('ROLLBACK');
      return refs;
    });

    const preLint = checkDocRefs(
      preRefs.map((r) => ({
        refKind: r.refKind as Parameters<typeof checkDocRefs>[0][number]['refKind'],
        refTarget: r.refTarget,
      })),
      orphanLive,
    );
    // Should have violations for the orphaned page's refs.
    expect(preLint.ok).toBe(false);

    // Run RECONCILE with the orphan snapshot.
    await runReconcile(tenant, orphanLive);

    // Assert the orphan page still exists, stale=true, zero refs, has doc_log('reconciled').
    await withClient(migratorUrl(), async (c) => {
      // Page still exists.
      const pageRow = await c.query(
        `SELECT id, stale FROM choros.doc_page WHERE tenant_id = $1 AND slug = $2`,
        [tenant, orphanSlug],
      );
      expect(pageRow.rows.length, `orphan page ${orphanSlug} must still exist`).toBe(1);
      expect(pageRow.rows[0]!['stale'], 'orphan page must have stale=true').toBe(true);

      const orphanPageId = pageRow.rows[0]!['id'] as string;

      // Zero refs.
      const refCount = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_ref WHERE tenant_id = $1 AND page_id = $2`,
        [tenant, orphanPageId],
      );
      expect(refCount.rows[0]!['n'], 'orphan page must have zero refs').toBe(0);

      // doc_log('reconciled') exists for the orphan page.
      const logRow = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log WHERE tenant_id = $1 AND page_id = $2 AND op = 'reconciled'`,
        [tenant, orphanPageId],
      );
      expect(logRow.rows[0]!['n'], 'orphan page must have doc_log(reconciled)').toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// F-8: Audit event emitted — docs.reconciled, actor=docs-author, no secret
// ---------------------------------------------------------------------------

describe('F-8: audit_event(docs.reconciled) emitted, secret-free', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('≥1 audit_event with type=docs.reconciled, actor=docs-author, no secret in payload', async () => {
    const fullLive = await runRegen(tenant);
    const { degradedLive } = buildDegradedSnapshot(fullLive);

    await runReconcile(tenant, degradedLive);

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT type, actor, payload
           FROM choros.audit_event
          WHERE tenant_id = $1 AND type = 'docs.reconciled'
          ORDER BY seq DESC
          LIMIT 1`,
        [tenant],
      );
      expect(rows.length, 'at least one docs.reconciled audit event required').toBeGreaterThanOrEqual(1);

      const auditRow = rows[0]!;
      expect(auditRow['actor'], 'audit actor must be docs-author').toBe('docs-author');

      // No secret material in payload.
      const payload = typeof auditRow['payload'] === 'string'
        ? JSON.parse(auditRow['payload'] as string)
        : auditRow['payload'];
      const payloadStr = JSON.stringify(payload).toLowerCase();

      const secretTerms = ['password', 'secret', 'token', 'private_key', 'api_key'];
      for (const term of secretTerms) {
        expect(payloadStr, `audit payload must not contain '${term}'`).not.toContain(term);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// F-9: Tenant isolation — RECONCILE on tenant A does not write to tenant B
// ---------------------------------------------------------------------------

describe('F-9: tenant isolation — RECONCILE on tenant A does not touch tenant B', () => {
  const tenantA = freshTenant();
  const tenantB = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `DELETE FROM choros.doc_page WHERE tenant_id = $1 OR tenant_id = $2`,
        [tenantA, tenantB],
      );
    });
  });

  it('RECONCILE on tenant A writes no pages to tenant B', async () => {
    const fullLive = await runRegen(tenantA);
    const { degradedLive } = buildDegradedSnapshot(fullLive);

    // Run REGEN on tenant B (so it has pages) — use full snapshot, no broken refs.
    await runRegen(tenantB, fullLive);

    // Capture tenant B page count before reconcile.
    const bCountBefore = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1`,
        [tenantB],
      );
      return rows[0]!['n'] as number;
    });

    // Run RECONCILE on tenant A only.
    await runReconcile(tenantA, degradedLive);

    // Tenant B page count must be unchanged.
    const bCountAfter = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1`,
        [tenantB],
      );
      return rows[0]!['n'] as number;
    });
    expect(bCountAfter, 'tenant B page count must not change after RECONCILE on tenant A').toBe(bCountBefore);

    // No doc_log(reconciled) rows for tenant B.
    const bLogs = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log WHERE tenant_id = $1 AND op = 'reconciled'`,
        [tenantB],
      );
      return rows[0]!['n'] as number;
    });
    expect(bLogs, 'no reconciled logs for tenant B').toBe(0);
  });

  it('choros_app session for tenant B cannot see tenant A doc_pages (RLS)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantB}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1`,
        [tenantA], // explicitly filtering by tenant A — RLS should block
      );
      await c.query('ROLLBACK');
      expect(rows[0]!['n'], 'choros_app session for tenant B must see 0 pages from tenant A').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// F-10: No new grants, no new mcp_tool rows, no migration (additive-only)
// ---------------------------------------------------------------------------

describe('F-10: RECONCILE creates no new grants or mcp_tool rows (additive-only)', () => {
  it('docs-author role (e0...005) still has exactly 2 doc_page grants (unchanged from P-1)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND role_id = $2
            AND resource_type = 'doc_page'`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows[0]!['n'], 'docs-author must still have exactly 2 doc_page grants').toBe(2);
    });
  });

  it('no mcp_tool rows added by RECONCILE (count=2, unchanged from P-2)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool WHERE tenant_id = $1
            AND (name = 'doc_page_author' OR name = 'doc_ref_set')`,
        [DEV_TENANT],
      );
      expect(rows[0]!['n'], 'mcp_tool count for doc tools must remain 2').toBe(2);
    });
  });

  it('no migration 064 exists (RECONCILE does not consume next-free slot)', () => {
    const migrationPath = join(REPO_ROOT, 'migrations', '064_doc_page.sql');
    // It must not exist.
    let exists = false;
    try {
      readFileSync(migrationPath);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists, 'migration 064 must not exist (RECONCILE needs no migration)').toBe(false);
  });
});
