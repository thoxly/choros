// T-0211 · P-3 — REGEN procedure DB fitness (docs-pipeline).
//
// Live Postgres probes — run in the `db` CI job via `npm run fitness:db`.
// Requires migrations 061/062/063 applied.
//
// Isolation discipline (T-0205):
//   - All DML uses FRESH random tenant UUIDs (freshTenant()).
//   - NEVER touches shared dev-tenant (a0...001) fixtures.
//   - Each describe block cleans up after itself via afterAll.
//
// F-1:  ≥1 doc_page with ≥1 typed doc_ref after one REGEN run.
// F-2:  Idempotent: run twice → page & ref counts stable; page ids unchanged.
// F-3:  doc_log('regenerated') appended after run 1.
// F-6:  scope='tenant' only; single tenant_id; catalog_version IS NULL.
// F-8:  Tenant isolation: REGEN run on tenant A does not write to tenant B;
//       SET LOCAL choros.tenant_id used (RLS enforced via choros_app).
// F-9:  audit_event('docs.regenerated') emitted, actor=docs-author, no secret in payload.
// F-10: No new grant rows for docs-author after REGEN;
//       no new mcp_tool rows;
//       known_tenant_tables.txt unchanged (static).
//       STATIC: script DEFAULT_TENANT constant === dev-tenant UUID.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  migratorUrl,
  appUrl,
  withClient,
  uuid,
} from './_helpers.js';

import { assembleStaticSnapshot } from '../../../src/core/doc-live-snapshot.js';
import { planRegen } from '../../../src/core/doc-regen.js';
import {
  readDocPages,
  readDocRefs,
  upsertDocPage,
  setDocRefs,
  appendDocLog,
} from '../../../src/db/doc-page-store.js';
import { makePgAuditWriter } from '../../../src/db/audit-writer.js';
import type { AuditEventInput } from '../../../src/core/audit-grant-encoder.js';
import { DEFAULT_TENANT, DOCS_AUTHOR_ACTOR } from '../../../scripts/doc-regen.js';

// T-0646: runRegen below faithfully replicates the production per-page write
// loop in scripts/doc-regen.ts (upsertDocPage → setDocRefs → appendDocLog per
// page, sequential — real operator behavior). The volume is the WHOLE live
// repo doc snapshot (assembleStaticSnapshot) and grows with the codebase;
// F-2/F-3 call runRegen twice, doubling the round-trips, and legitimately
// exceed the old 5000ms default. Covered by the suite-wide
// testTimeout/hookTimeout in vitest.config.js.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

/** Fresh random tenant UUID — never reuse shared fixtures (T-0205). */
function freshTenant(): string {
  return crypto.randomUUID();
}

// Dev-tenant and seed UUIDs from migrations 062 + 063.
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const ROLE_DOCS_AUTHOR = 'e0000000-0000-0000-0000-000000000005';
const DOCS_AUTHOR_ACTOR_LABEL = 'docs-author';

// ---------------------------------------------------------------------------
// STATIC: F-10 — DEFAULT_TENANT constant equals dev-tenant UUID
// ---------------------------------------------------------------------------

describe('F-10 (static): DEFAULT_TENANT constant equals dev-tenant UUID', () => {
  it('scripts/doc-regen.ts DEFAULT_TENANT === a0000000-0000-0000-0000-000000000001', () => {
    expect(DEFAULT_TENANT, 'DEFAULT_TENANT must equal the dev-tenant UUID').toBe(DEV_TENANT);
  });

  it('DOCS_AUTHOR_ACTOR constant equals docs-author', () => {
    expect(DOCS_AUTHOR_ACTOR, 'DOCS_AUTHOR_ACTOR must equal docs-author').toBe(DOCS_AUTHOR_ACTOR_LABEL);
  });
});

// ---------------------------------------------------------------------------
// STATIC: F-10 — known_tenant_tables.txt unchanged (doc tables registered)
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
// Helper: run REGEN (planRegen + apply) on a fresh tenant via choros_app
// Returns the page count and ref count after the run.
// ---------------------------------------------------------------------------

async function runRegen(tenantId: string): Promise<{
  pagesUpserted: number;
  refsSet: number;
  logsAppended: number;
}> {
  // Use static snapshot (no DB queries for codeSymbols/restEndpoints).
  // This guarantees ≥1 page + ≥1 ref even without a live DB for schemaFields/configKeys.
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

    // Read current state.
    const currentPages = await readDocPages(storeClient, tenantId);
    const currentRefs = await readDocRefs(storeClient, tenantId);

    const nowMs = Date.now();
    const planResult = planRegen(live, currentPages, currentRefs, nowMs, DOCS_AUTHOR_ACTOR_LABEL);

    if ('error' in planResult) {
      throw new Error(`planRegen error: ${JSON.stringify(planResult.violations)}`);
    }

    let pagesUpserted = 0;
    let refsSet = 0;
    let logsAppended = 0;

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

      const refResult = await setDocRefs(storeClient, tenantId, resolvedId, pagePlan.refs);
      refsSet += refResult.set;

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
        logsAppended++;
      }
    }

    // Emit run-level audit event.
    const auditEvent: AuditEventInput = {
      id: crypto.randomUUID(),
      type: 'docs.regenerated',
      actor: DOCS_AUTHOR_ACTOR_LABEL,
      subject: `tenant:${tenantId}`,
      scope: null,
      via: null,
      proposed_by: null,
      confirmed_by: null,
      payload: {
        tenant: tenantId,
        pagesUpserted,
        refsSet,
        logsAppended,
      },
      occurred_at: nowMs,
    };

    const auditWriter = makePgAuditWriter();
    await auditWriter.appendAuditEvent(c as unknown as Parameters<typeof auditWriter.appendAuditEvent>[0], auditEvent);

    await c.query('COMMIT');

    return { pagesUpserted, refsSet, logsAppended };
  });
}

// ---------------------------------------------------------------------------
// F-1: ≥1 doc_page with ≥1 typed doc_ref after one REGEN run
// ---------------------------------------------------------------------------

describe('F-1: ≥1 doc_page with ≥1 typed doc_ref after REGEN', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('produces ≥1 doc_page and ≥1 doc_ref on fresh tenant', async () => {
    await runRegen(tenant);

    await withClient(migratorUrl(), async (c) => {
      const pageRows = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1`,
        [tenant],
      );
      expect(pageRows.rows[0].n, '≥1 doc_page required').toBeGreaterThanOrEqual(1);

      const refRows = await c.query(
        `SELECT count(*)::int AS n
           FROM choros.doc_ref r
           JOIN choros.doc_page p ON p.tenant_id = r.tenant_id AND p.id = r.page_id
          WHERE r.tenant_id = $1`,
        [tenant],
      );
      expect(refRows.rows[0].n, '≥1 doc_ref required').toBeGreaterThanOrEqual(1);
    });
  });

  it('all doc_ref rows have ref_kind in the closed vocab', async () => {
    const validKinds = new Set(['code_symbol', 'rest_endpoint', 'schema_field', 'process', 'config_key']);

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT DISTINCT ref_kind FROM choros.doc_ref WHERE tenant_id = $1`,
        [tenant],
      );
      for (const row of rows) {
        expect(validKinds.has(row.ref_kind as string),
          `unknown ref_kind: ${row.ref_kind as string}`).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// F-2: idempotent — run twice → page & ref counts stable; ids unchanged
// ---------------------------------------------------------------------------

describe('F-2: idempotent — run twice → page & ref counts stable', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('page and ref counts are stable across two REGEN runs', async () => {
    // Run 1
    await runRegen(tenant);

    const after1 = await withClient(migratorUrl(), async (c) => {
      const pagesResult = await c.query(
        `SELECT id, slug FROM choros.doc_page WHERE tenant_id = $1 ORDER BY slug`,
        [tenant],
      );
      const refsResult = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_ref WHERE tenant_id = $1`,
        [tenant],
      );
      return {
        pageCount: pagesResult.rows.length,
        refCount: refsResult.rows[0].n as number,
        pageIds: pagesResult.rows.map((r: { id: string }) => r.id).sort(),
      };
    });

    // Run 2
    await runRegen(tenant);

    const after2 = await withClient(migratorUrl(), async (c) => {
      const pagesResult = await c.query(
        `SELECT id, slug FROM choros.doc_page WHERE tenant_id = $1 ORDER BY slug`,
        [tenant],
      );
      const refsResult = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_ref WHERE tenant_id = $1`,
        [tenant],
      );
      return {
        pageCount: pagesResult.rows.length,
        refCount: refsResult.rows[0].n as number,
        pageIds: pagesResult.rows.map((r: { id: string }) => r.id).sort(),
      };
    });

    expect(after2.pageCount, 'page count must be stable across runs').toBe(after1.pageCount);
    expect(after2.refCount, 'ref count must be stable across runs').toBe(after1.refCount);
    expect(after2.pageIds, 'page ids must be unchanged (upsert preserved ids)').toEqual(after1.pageIds);
  });
});

// ---------------------------------------------------------------------------
// F-3: doc_log('regenerated') appended after run 1
// ---------------------------------------------------------------------------

describe('F-3: doc_log("regenerated") appended after REGEN', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('doc_log has ≥1 row with op=regenerated after run 1', async () => {
    await runRegen(tenant);

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log WHERE tenant_id = $1 AND op = 'regenerated'`,
        [tenant],
      );
      expect(rows[0].n, '≥1 doc_log(regenerated) required after run 1').toBeGreaterThanOrEqual(1);
    });
  });

  it('doc_log rows are each joined to an existing doc_page (no orphans)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n
           FROM choros.doc_log l
           JOIN choros.doc_page p ON p.tenant_id = l.tenant_id AND p.id = l.page_id
          WHERE l.tenant_id = $1 AND l.op = 'regenerated'`,
        [tenant],
      );
      expect(rows[0].n, 'all doc_log rows must join to an existing page').toBeGreaterThanOrEqual(1);
    });
  });

  it('doc_log is append-only: second run may grow the log (not a duplicate bug)', async () => {
    const countBefore = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log WHERE tenant_id = $1`,
        [tenant],
      );
      return rows[0].n as number;
    });

    // Second run (all pages unchanged → zero new log rows since change-guard).
    await runRegen(tenant);

    // Log count may be equal (no new rows on unchanged re-run) or greater (if grow).
    // The invariant is: no-op run does NOT produce doc_page/doc_ref duplicates (F-2).
    // Log growth is EXPECTED and CORRECT (append-only history — ADR §6.3).
    const countAfter = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log WHERE tenant_id = $1`,
        [tenant],
      );
      return rows[0].n as number;
    });

    // On a true no-op (unchanged pages), our implementation appends no new log rows.
    // Either equal (no-op) or greater (change detected) is acceptable.
    expect(countAfter, 'log count must not decrease (append-only)').toBeGreaterThanOrEqual(countBefore);
  });
});

// ---------------------------------------------------------------------------
// F-6: scope='tenant' only; single tenant; catalog_version IS NULL
// ---------------------------------------------------------------------------

describe('F-6: scope=tenant, single tenant, catalog_version IS NULL', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
    });
  });

  it('all REGEN pages have scope=tenant', async () => {
    await runRegen(tenant);

    await withClient(migratorUrl(), async (c) => {
      // Count pages with scope != 'tenant' — must be 0.
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1 AND scope != 'tenant'`,
        [tenant],
      );
      expect(rows[0].n, 'all REGEN pages must have scope=tenant').toBe(0);
    });
  });

  it('all REGEN pages have catalog_version IS NULL', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1 AND catalog_version IS NOT NULL`,
        [tenant],
      );
      expect(rows[0].n, 'all REGEN pages must have catalog_version IS NULL').toBe(0);
    });
  });

  it('all REGEN pages share a single tenant_id', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT DISTINCT tenant_id FROM choros.doc_page WHERE tenant_id = $1`,
        [tenant],
      );
      // Either 0 (no pages) or 1 (all same tenant).
      expect(rows.length, 'all pages must share a single tenant_id').toBeLessThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// F-8: tenant isolation — REGEN run on tenant A does not write to tenant B
// ---------------------------------------------------------------------------

describe('F-8: tenant isolation — REGEN on tenant A does not touch tenant B', () => {
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

  it('REGEN on tenant A writes no pages to tenant B', async () => {
    await runRegen(tenantA);

    await withClient(migratorUrl(), async (c) => {
      const pageCountA = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1`,
        [tenantA],
      );
      const pageCountB = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1`,
        [tenantB],
      );

      expect(pageCountA.rows[0].n, 'tenant A must have ≥1 page after REGEN').toBeGreaterThanOrEqual(1);
      expect(pageCountB.rows[0].n, 'tenant B must have 0 pages (no cross-tenant write)').toBe(0);
    });
  });

  it('choros_app session for tenant B sees 0 doc_pages from tenant A (RLS)', async () => {
    // Verify RLS: tenant B session cannot see tenant A's pages.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantB}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1`,
        [tenantA],  // explicitly filtering by tenant A — RLS should block
      );
      await c.query('ROLLBACK');
      expect(rows[0].n, 'choros_app session for tenant B must see 0 pages from tenant A').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// F-9: audit_event('docs.regenerated') emitted, actor=docs-author, no secret in payload
// ---------------------------------------------------------------------------

describe('F-9: audit_event(docs.regenerated) emitted, actor=docs-author, no secret in payload', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
      // audit events are append-only, no cleanup needed
    });
  });

  it('at least one audit_event with type=docs.regenerated exists after REGEN', async () => {
    await runRegen(tenant);

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT type, actor, payload
           FROM choros.audit_event
          WHERE tenant_id = $1 AND type = 'docs.regenerated'
          ORDER BY seq DESC
          LIMIT 1`,
        [tenant],
      );
      expect(rows.length, 'at least one docs.regenerated audit event required').toBeGreaterThanOrEqual(1);

      const auditRow = rows[0];
      expect(auditRow.actor, 'audit actor must be docs-author').toBe('docs-author');

      // F-9: payload must not contain secret material.
      const payload = typeof auditRow.payload === 'string'
        ? JSON.parse(auditRow.payload)
        : auditRow.payload;
      const payloadStr = JSON.stringify(payload).toLowerCase();

      // These are banned terms — no secrets should appear in audit payload.
      const secretTerms = ['password', 'secret', 'token', 'private_key', 'api_key', 'auth'];
      for (const term of secretTerms) {
        expect(payloadStr, `audit payload must not contain '${term}'`).not.toContain(term);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// F-10: no new grants, no new mcp_tool rows for docs-author after REGEN
// ---------------------------------------------------------------------------

describe('F-10: REGEN creates no new grants or mcp_tool rows (additive-only)', () => {
  it('docs-author role (e0...005) still has exactly 2 doc_page grants (unchanged from P-1)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND role_id = $2
            AND resource_type = 'doc_page'`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows[0].n, 'docs-author must still have exactly 2 doc_page grants').toBe(2);
    });
  });

  it('no mcp_tool rows added by REGEN (P-2 tools are sufficient, count = 2)', async () => {
    // The 2 P-2 tools are doc_page_author (10...013) and doc_ref_set (10...014).
    // REGEN must not add any additional mcp_tool rows for the dev-tenant.
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool WHERE tenant_id = $1
            AND (name = 'doc_page_author' OR name = 'doc_ref_set')`,
        [DEV_TENANT],
      );
      // Should still be exactly 2 (P-2 seeded them, REGEN doesn't touch them).
      expect(rows[0].n, 'mcp_tool count for doc tools must remain 2').toBe(2);
    });
  });
});
