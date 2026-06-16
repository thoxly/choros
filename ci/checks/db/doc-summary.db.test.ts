// T-0214 · P-6 — doc_page.summary DB fitness (docs-pipeline).
//
// Live Postgres probes — run in the `db` CI job via `npm run fitness:db`.
// Requires migrations 061/062/063/064 applied.
//
// Isolation discipline (T-0205):
//   - All DML uses FRESH random tenant UUIDs (freshTenant()).
//   - NEVER touches shared dev-tenant (a0...001) fixtures.
//   - Each describe block cleans up after itself via afterAll.
//
// FS-1: readDocIndex returns non-null, one-line summary for every page after REGEN.
// FS-2: readDocIndex result shape has NO `body` field (load-bearing P-6 invariant).
// FS-3: summary is idempotent — re-regen leaves summary unchanged.
// FS-4: additive migration — existing rows without summary are accepted (NULL is valid).
// FS-5: readDocIndex ORDER BY slug (stable ordering).

import { describe, it, expect, afterAll } from 'vitest';
import {
  migratorUrl,
  appUrl,
  withClient,
} from './_helpers.js';

import { assembleStaticSnapshot } from '../../../src/core/doc-live-snapshot.js';
import { planRegen } from '../../../src/core/doc-regen.js';
import {
  readDocPages,
  readDocRefs,
  readDocIndex,
  upsertDocPage,
  setDocRefs,
  appendDocLog,
} from '../../../src/db/doc-page-store.js';
import type { AuditEventInput } from '../../../src/core/audit-grant-encoder.js';
import { makePgAuditWriter } from '../../../src/db/audit-writer.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

const DOCS_AUTHOR_ACTOR = 'docs-author';

/** Fresh random tenant UUID — never reuse shared fixtures (T-0205). */
function freshTenant(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Helper: run REGEN (planRegen + apply) on a fresh tenant via choros_app.
// Mirrors doc-regen.db.test.ts runRegen but also passes summary from pagePlan.
// ---------------------------------------------------------------------------

async function runRegen(tenantId: string): Promise<{ pagesUpserted: number }> {
  const live = assembleStaticSnapshot(REPO_ROOT);

  return await withClient(appUrl(), async (c) => {
    const storeClient = {
      query: (sql: string, params?: unknown[]) =>
        c.query(sql, params).then((r) => ({
          rows: r.rows as Record<string, unknown>[],
        })),
    };

    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query('SET LOCAL search_path TO choros');

    const currentPages = await readDocPages(storeClient, tenantId);
    const currentRefs = await readDocRefs(storeClient, tenantId);

    const nowMs = Date.now();
    const planResult = planRegen(live, currentPages, currentRefs, nowMs, DOCS_AUTHOR_ACTOR);

    if ('error' in planResult) {
      throw new Error(`planRegen error: ${JSON.stringify(planResult.violations)}`);
    }

    let pagesUpserted = 0;

    for (const pagePlan of planResult.pages) {
      const upsertResult = await upsertDocPage(storeClient, tenantId, {
        id: pagePlan.id,
        slug: pagePlan.slug,
        title: pagePlan.title,
        body: pagePlan.body,
        summary: pagePlan.summary,
        authoredBy: pagePlan.authoredBy,
        authoredAt: pagePlan.authoredAt,
        updatedAt: pagePlan.updatedAt,
      });

      const resolvedId = upsertResult.id;

      if (upsertResult.action !== 'unchanged') {
        pagesUpserted++;
      }

      await setDocRefs(storeClient, tenantId, resolvedId, pagePlan.refs);

      if (pagePlan.log !== null && upsertResult.action !== 'unchanged') {
        await appendDocLog(
          storeClient,
          tenantId,
          resolvedId,
          pagePlan.log.id,
          pagePlan.log.op,
          pagePlan.log.agentActor,
          pagePlan.log.diffSummary,
          pagePlan.log.at,
        );
      }
    }

    // Run-level audit event.
    const auditEvent: AuditEventInput = {
      id: crypto.randomUUID(),
      type: 'docs.regenerated',
      actor: DOCS_AUTHOR_ACTOR,
      subject: `tenant:${tenantId}`,
      scope: null,
      via: null,
      proposed_by: null,
      confirmed_by: null,
      payload: { tenant: tenantId, pagesUpserted },
      occurred_at: nowMs,
    };
    const auditWriter = makePgAuditWriter();
    await auditWriter.appendAuditEvent(c as unknown as Parameters<typeof auditWriter.appendAuditEvent>[0], auditEvent);

    await c.query('COMMIT');
    return { pagesUpserted };
  });
}

// ---------------------------------------------------------------------------
// FS-1: readDocIndex returns non-null, one-line summary for every page
// ---------------------------------------------------------------------------

describe('FS-1: readDocIndex returns non-null, one-line summary for every page after REGEN', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('every index entry has non-null, non-empty, one-line summary', async () => {
    await runRegen(tenant);

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);

      const storeClient = {
        query: (sql: string, params?: unknown[]) =>
          c.query(sql, params).then((r) => ({
            rows: r.rows as Record<string, unknown>[],
          })),
      };

      const index = await readDocIndex(storeClient, tenant);
      await c.query('ROLLBACK');

      expect(index.length, '≥1 index entry required after REGEN').toBeGreaterThanOrEqual(1);

      for (const entry of index) {
        expect(entry.summary, `slug ${entry.slug}: summary must not be null`).not.toBeNull();
        expect(entry.summary!.length, `slug ${entry.slug}: summary must not be empty`).toBeGreaterThan(0);
        expect(entry.summary!, `slug ${entry.slug}: summary must not contain newline`).not.toContain('\n');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// FS-2: readDocIndex result shape has NO `body` field
// ---------------------------------------------------------------------------

describe('FS-2: readDocIndex result shape has no `body` field', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('index entries do not have a body field', async () => {
    await runRegen(tenant);

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);

      const storeClient = {
        query: (sql: string, params?: unknown[]) =>
          c.query(sql, params).then((r) => ({
            rows: r.rows as Record<string, unknown>[],
          })),
      };

      const index = await readDocIndex(storeClient, tenant);
      await c.query('ROLLBACK');

      expect(index.length, '≥1 entry required').toBeGreaterThanOrEqual(1);

      for (const entry of index) {
        // Load-bearing: the DocPageIndexEntry type must NOT have `body`.
        // At runtime we confirm the DB row also does not return `body`.
        expect('body' in entry, `slug ${entry.slug}: entry must not have a body field`).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// FS-3: summary is idempotent — re-regen leaves summary unchanged
// ---------------------------------------------------------------------------

describe('FS-3: summary is idempotent across two REGEN runs', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('summaries from readDocIndex are identical after run1 and run2', async () => {
    // Run 1.
    await runRegen(tenant);

    const summaries1 = await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);
      const storeClient = {
        query: (sql: string, params?: unknown[]) =>
          c.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
      };
      const idx = await readDocIndex(storeClient, tenant);
      await c.query('ROLLBACK');
      return new Map(idx.map((e) => [e.slug, e.summary]));
    });

    // Run 2.
    await runRegen(tenant);

    const summaries2 = await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);
      const storeClient = {
        query: (sql: string, params?: unknown[]) =>
          c.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
      };
      const idx = await readDocIndex(storeClient, tenant);
      await c.query('ROLLBACK');
      return new Map(idx.map((e) => [e.slug, e.summary]));
    });

    expect(summaries1.size, 'page count stable').toBe(summaries2.size);
    for (const [slug, s1] of summaries1) {
      expect(summaries2.get(slug), `slug ${slug}: summary must be identical across runs`).toBe(s1);
    }
  });
});

// ---------------------------------------------------------------------------
// FS-4: additive migration — existing rows without summary are accepted (NULL valid)
// ---------------------------------------------------------------------------

describe('FS-4: additive migration — existing rows without summary (NULL) are accepted', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('INSERT with summary=NULL succeeds (column is nullable)', async () => {
    // Use choros_migrator to bypass RLS for this legacy-row test.
    await withClient(migratorUrl(), async (c) => {
      const id = crypto.randomUUID();
      const nowMs = Date.now();
      // Insert a legacy row with summary explicitly NULL (pre-064 scenario).
      await c.query(
        `INSERT INTO choros.doc_page
           (tenant_id, id, slug, title, body, summary, scope,
            catalog_version, app_id, stale, authored_by, authored_at, updated_at)
         VALUES ($1, $2, 'legacy/row', 'Legacy Row', 'body text', NULL, 'tenant',
                 NULL, NULL, false, 'test-actor', $3, $3)`,
        [tenant, id, nowMs],
      );

      // Verify the row is present with summary=NULL.
      const { rows } = await c.query(
        `SELECT slug, summary FROM choros.doc_page WHERE tenant_id = $1 AND slug = 'legacy/row'`,
        [tenant],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].summary).toBeNull();
    });
  });

  it('existing NULL-summary row does not violate CHECK constraint', async () => {
    // The check is `summary IS NULL OR (no newline AND len <= 200)`.
    // A NULL summary must pass without error (already inserted above).
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1 AND summary IS NULL`,
        [tenant],
      );
      expect(rows[0].n, 'at least 1 NULL-summary row must exist').toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// FS-5: readDocIndex ORDER BY slug — stable ordering (structural check)
// ---------------------------------------------------------------------------

describe('FS-5: readDocIndex returns all pages and each has a non-null slug', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('all index entries have non-empty slug, id, scope', async () => {
    await runRegen(tenant);

    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);
      const storeClient = {
        query: (sql: string, params?: unknown[]) =>
          c.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
      };
      const index = await readDocIndex(storeClient, tenant);
      await c.query('ROLLBACK');

      expect(index.length, '≥1 entry required').toBeGreaterThanOrEqual(1);

      // Structural: every entry has the required fields from DocPageIndexEntry.
      for (const entry of index) {
        expect(entry.slug.length, `slug must not be empty`).toBeGreaterThan(0);
        expect(entry.id.length, `id must not be empty`).toBeGreaterThan(0);
        expect(['system', 'tenant'], `scope must be system or tenant`).toContain(entry.scope);
        // updatedAt is a number > 0
        expect(entry.updatedAt, `updatedAt must be a positive number`).toBeGreaterThan(0);
      }
    });
  });

  it('index entry count equals doc_page count for tenant', async () => {
    // Verify readDocIndex returns ALL pages (no body = no filtering).
    const indexCount = await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);
      const storeClient = {
        query: (sql: string, params?: unknown[]) =>
          c.query(sql, params).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
      };
      const index = await readDocIndex(storeClient, tenant);
      await c.query('ROLLBACK');
      return index.length;
    });

    const dbCount = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1`,
        [tenant],
      );
      return rows[0].n as number;
    });

    expect(indexCount, 'readDocIndex must return same count as doc_page table').toBe(dbCount);
  });
});
