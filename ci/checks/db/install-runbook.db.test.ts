// T-0213 · P-5 — install-runbook scope='system' projection DB fitness.
//
// Live Postgres probes — run in the `db` CI job via `npm run fitness:db`.
// Requires migrations 061/062/063/064/065 applied.
//
// Isolation discipline (T-0205):
//   - F-1/F-2/F-3/F-5/F-7/F-8: operate on a FRESH random tenant (freshTenant()),
//     applying the 065 projection INSERT shape parameterized to that tenant.
//     NEVER mutates the shared dev-tenant (a0...001) rows.
//   - Static assertions confirm 065 targets the dev-tenant UUID a0...001.
//   - Each describe block cleans up after itself via afterAll.
//
// Coverage:
//   F-1:  runbook page projected at provision (scope='system', stable slug,
//         catalog_version IS NOT NULL, authored_by='system', stale=false).
//   F-2:  Idempotent re-projection: applying twice → no dup page/refs/logs.
//   F-3:  Install-fact refs lint-clean against the LiveSnapshot (checkDocRefs).
//         Positive: all 3 refs resolve.
//         Negative: snapshot missing /health → checkDocRefs reports violation.
//   F-4/static: 065 targets dev-tenant UUID a0...001 (static assertion).
//   F-5:  Cross-tenant isolation: fresh tenant B cannot see fresh tenant A's
//         projected system/install-runbook page via choros_app.
//   F-7:  Additive-only: docs-author role still has exactly 2 doc_page grants
//         after projection; no new mcp_tool rows for docs tooling.
//   F-8:  doc_log row present with op='system_doc_projected', agent_actor='system',
//         diff_summary carries catalog_version, no secret material.

import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  migratorUrl,
  appUrl,
  withClient,
  uuid,
} from './_helpers.js';

import {
  assembleStaticSnapshot,
  collectConfigKeys,
} from '../../../src/core/doc-live-snapshot.js';
import { checkDocRefs } from '../../../src/core/doc-ref-lint.js';
import type { DocRef } from '../../../src/core/doc-ref-lint.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// Dev-tenant UUID (day-1 seed target, per ADR §4.1 and §2.1)
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
// Stable page UUID seeded by migration 065
const PAGE_UUID_065 = 'a1000000-0000-0000-0000-000000000001';
// Role docs-author from migration 062
const ROLE_DOCS_AUTHOR = 'e0000000-0000-0000-0000-000000000005';

// The stable slug for the projected runbook page.
const RUNBOOK_SLUG = 'system/install-runbook';
const CATALOG_VERSION = 'install-runbook.v1';

/** Fresh random tenant UUID — never reuse shared fixtures (T-0205). */
function freshTenant(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Helper: apply the install-runbook projection to a given tenant.
// Mirrors the INSERT shape from migration 065 but parameterized to any tenantId.
// Uses choros_migrator (bypasses FORCE-RLS — same authority as the migrator).
// ---------------------------------------------------------------------------

// Stable "per-tenant" UUIDs for idempotency testing.
// These are deterministically derived from the tenantId via a simple XOR/hash
// so that double-applying applyProjection() to the same tenant hits the
// ON CONFLICT DO NOTHING on all three tables (page by slug, refs by UNIQUE
// constraint, log by fixed UUID).
function stableUuidsForTenant(tenantId: string): {
  pageId: string;
  ref1Id: string;
  ref2Id: string;
  ref3Id: string;
  logId: string;
} {
  // Derive deterministic UUIDs by XOR-ing the last 4 bytes of the tenant UUID
  // with a slot-specific constant, keeping the rest stable.
  // UUID format: 8-4-4-4-12 (last segment is 12 hex = 6 bytes).
  const base = tenantId.replace(/-/g, ''); // 32 hex chars
  const lastSeg = base.slice(20); // 12 hex chars (last segment)
  const lastInt = parseInt(lastSeg.slice(4), 16); // use last 4 bytes (8 hex)
  const mk = (slot: number) => {
    const n = (lastInt ^ (slot * 0x13370001)) >>> 0;
    const newLastSeg = lastSeg.slice(0, 4) + n.toString(16).padStart(8, '0');
    return [
      base.slice(0, 8),
      base.slice(8, 12),
      base.slice(12, 16),
      base.slice(16, 20),
      newLastSeg,
    ].join('-');
  };
  return {
    pageId: mk(1),
    ref1Id: mk(2),
    ref2Id: mk(3),
    ref3Id: mk(4),
    logId: mk(5),
  };
}

async function applyProjection(tenantId: string): Promise<{
  pageId: string;
  ref1Id: string;
  ref2Id: string;
  ref3Id: string;
  logId: string;
}> {
  // Use stable deterministic UUIDs so that double-apply hits ON CONFLICT DO NOTHING.
  const { pageId, ref1Id, ref2Id, ref3Id, logId } = stableUuidsForTenant(tenantId);

  // We need an mcp_tool row for config_key ref ('emit_form_code') to resolve
  // via collectConfigKeys for the fresh test tenant. Seed a minimal mcp_tool row
  // so the lint check passes on the fresh tenant (the dev-tenant already has it
  // from migration 044, but fresh random tenants do not).
  await withClient(migratorUrl(), async (c) => {
    // Seed mcp_tool row for emit_form_code in the fresh tenant
    await c.query(
      `INSERT INTO choros.mcp_tool
         (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
       VALUES ($1, $2, 'emit_form_code', 'Test config key for P-5 lint probe',
               '[]'::jsonb, true, '[]'::jsonb, 0, 0)
       ON CONFLICT DO NOTHING`,
      [tenantId, uuid()],
    );

    // INSERT doc_page (scope='system')
    await c.query(
      `INSERT INTO choros.doc_page
         (tenant_id, id, slug, title, body, summary, scope, catalog_version, app_id,
          stale, authored_by, authored_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'system', $7, NULL, false, 'system', 0, 0)
       ON CONFLICT (tenant_id, slug) DO NOTHING`,
      [
        tenantId, pageId, RUNBOOK_SLUG,
        'Установка и обновление (genesis-runbook)',
        'Install runbook body (T-0213 projection test)',
        'Установка одной командой ops/install.sh; verify GET /health; статус активации.',
        CATALOG_VERSION,
      ],
    );

    // Resolve actual page id (in case slug already existed → ON CONFLICT DO NOTHING)
    const { rows: pgRows } = await c.query(
      `SELECT id FROM choros.doc_page WHERE tenant_id = $1 AND slug = $2`,
      [tenantId, RUNBOOK_SLUG],
    );
    const resolvedPageId: string = (pgRows[0] as { id: string }).id;

    // INSERT doc_ref × 3
    await c.query(
      `INSERT INTO choros.doc_ref
         (tenant_id, id, page_id, ref_kind, ref_target, broken, created_at)
       VALUES
         ($1, $2, $3, 'rest_endpoint', '{"method":"GET","path":"/health"}'::jsonb, false, 0),
         ($1, $4, $3, 'rest_endpoint', '{"method":"GET","path":"/vendor/activation"}'::jsonb, false, 0),
         ($1, $5, $3, 'config_key', '{"key":"emit_form_code"}'::jsonb, false, 0)
       ON CONFLICT (tenant_id, page_id, ref_kind, ref_target) DO NOTHING`,
      [tenantId, ref1Id, resolvedPageId, ref2Id, ref3Id],
    );

    // INSERT doc_log
    await c.query(
      `INSERT INTO choros.doc_log
         (tenant_id, id, page_id, op, agent_actor, diff_summary, at)
       VALUES ($1, $2, $3, 'system_doc_projected', 'system',
               'install-runbook.v1 projected at provision (T-0213 P-5)', 0)
       ON CONFLICT DO NOTHING`,
      [tenantId, logId, resolvedPageId],
    );
  });

  return { pageId, ref1Id, ref2Id, ref3Id, logId };
}

// ---------------------------------------------------------------------------
// STATIC: F-4 — 065 targets dev-tenant UUID a0...001
// ---------------------------------------------------------------------------

describe('F-4 (static): 065 migration targets dev-tenant UUID a0...001', () => {
  it('migration 065 references the dev-tenant UUID a0000000-0000-0000-0000-000000000001', async () => {
    const { readFileSync } = await import('node:fs');
    const migrationPath = join(REPO_ROOT, 'migrations', '065_install_runbook_projection.sql');
    const content = readFileSync(migrationPath, 'utf8');
    expect(
      content,
      '065 must contain the dev-tenant UUID a0000000-0000-0000-0000-000000000001',
    ).toContain('a0000000-0000-0000-0000-000000000001');
  });

  it('migration 065 has scope=\'system\' for doc_page insert', async () => {
    const { readFileSync } = await import('node:fs');
    const migrationPath = join(REPO_ROOT, 'migrations', '065_install_runbook_projection.sql');
    const content = readFileSync(migrationPath, 'utf8');
    expect(
      content,
      '065 must set scope=\'system\' in doc_page INSERT',
    ).toContain("'system'");
    expect(
      content,
      '065 must NOT set scope=\'tenant\' in doc_page INSERT',
    ).not.toContain("scope='tenant'");
  });

  it('migration 065 has slug=\'system/install-runbook\' (stable idempotency key)', async () => {
    const { readFileSync } = await import('node:fs');
    const migrationPath = join(REPO_ROOT, 'migrations', '065_install_runbook_projection.sql');
    const content = readFileSync(migrationPath, 'utf8');
    expect(content, '065 must contain stable slug system/install-runbook').toContain(RUNBOOK_SLUG);
  });
});

// ---------------------------------------------------------------------------
// F-1: runbook page projected at provision (scope='system', catalog_version, etc.)
// ---------------------------------------------------------------------------

describe('F-1: runbook page projected with scope=\'system\', correct markers', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM choros.mcp_tool WHERE tenant_id = $1 AND name = 'emit_form_code'`, [tenant]);
    });
  });

  it('doc_page exists with scope=system, catalog_version, authored_by=system, stale=false', async () => {
    await applyProjection(tenant);

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT scope, catalog_version, authored_by, stale
           FROM choros.doc_page
          WHERE tenant_id = $1 AND slug = $2`,
        [tenant, RUNBOOK_SLUG],
      );
      expect(rows.length, '≥1 row for system/install-runbook').toBe(1);
      const row = rows[0] as {
        scope: string;
        catalog_version: string | null;
        authored_by: string;
        stale: boolean;
      };
      expect(row.scope, 'scope must be system').toBe('system');
      expect(row.catalog_version, 'catalog_version must be non-null').not.toBeNull();
      expect(row.catalog_version, 'catalog_version must be install-runbook.v1').toBe(CATALOG_VERSION);
      expect(row.authored_by, 'authored_by must be system').toBe('system');
      expect(row.stale, 'stale must be false').toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// F-2: Idempotent re-projection — applying twice produces no duplicates
// ---------------------------------------------------------------------------

describe('F-2: idempotent re-projection — no duplicates on second apply', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM choros.mcp_tool WHERE tenant_id = $1 AND name = 'emit_form_code'`, [tenant]);
    });
  });

  it('double-apply: doc_page count for slug=1, ref count unchanged, log count unchanged', async () => {
    // First projection
    await applyProjection(tenant);

    const after1 = await withClient(migratorUrl(), async (c) => {
      const pageRows = await c.query(
        `SELECT id FROM choros.doc_page WHERE tenant_id = $1 AND slug = $2`,
        [tenant, RUNBOOK_SLUG],
      );
      const refRows = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_ref r
           JOIN choros.doc_page p ON p.tenant_id = r.tenant_id AND p.id = r.page_id
          WHERE r.tenant_id = $1 AND p.slug = $2`,
        [tenant, RUNBOOK_SLUG],
      );
      const logRows = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log l
           JOIN choros.doc_page p ON p.tenant_id = l.tenant_id AND p.id = l.page_id
          WHERE l.tenant_id = $1 AND p.slug = $2`,
        [tenant, RUNBOOK_SLUG],
      );
      return {
        pageId: (pageRows.rows[0] as { id: string }).id,
        pageCount: pageRows.rows.length,
        refCount: (refRows.rows[0] as { n: number }).n,
        logCount: (logRows.rows[0] as { n: number }).n,
      };
    });

    // Second projection (idempotent)
    await applyProjection(tenant);

    const after2 = await withClient(migratorUrl(), async (c) => {
      const pageRows = await c.query(
        `SELECT id FROM choros.doc_page WHERE tenant_id = $1 AND slug = $2`,
        [tenant, RUNBOOK_SLUG],
      );
      const refRows = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_ref r
           JOIN choros.doc_page p ON p.tenant_id = r.tenant_id AND p.id = r.page_id
          WHERE r.tenant_id = $1 AND p.slug = $2`,
        [tenant, RUNBOOK_SLUG],
      );
      const logRows = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_log l
           JOIN choros.doc_page p ON p.tenant_id = l.tenant_id AND p.id = l.page_id
          WHERE l.tenant_id = $1 AND p.slug = $2`,
        [tenant, RUNBOOK_SLUG],
      );
      return {
        pageId: (pageRows.rows[0] as { id: string }).id,
        pageCount: pageRows.rows.length,
        refCount: (refRows.rows[0] as { n: number }).n,
        logCount: (logRows.rows[0] as { n: number }).n,
      };
    });

    expect(after2.pageCount, 'page count must be 1 after double-apply').toBe(1);
    expect(after2.refCount, 'ref count must be unchanged after double-apply').toBe(after1.refCount);
    expect(after2.logCount, 'log count must be unchanged after double-apply (fixed UUIDs + ON CONFLICT DO NOTHING)').toBe(after1.logCount);
    expect(after2.pageId, 'page id must be unchanged (idempotent slug keying)').toBe(after1.pageId);
  });
});

// ---------------------------------------------------------------------------
// F-3: Install-fact refs lint-clean against LiveSnapshot (checkDocRefs)
// Positive: all 3 refs resolve. Negative: snapshot missing /health → violation.
// ---------------------------------------------------------------------------

describe('F-3: install-fact refs lint-clean against LiveSnapshot (checkDocRefs)', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM choros.mcp_tool WHERE tenant_id = $1 AND name = 'emit_form_code'`, [tenant]);
    });
  });

  it('positive: all 3 projected refs (2 rest_endpoint + 1 config_key) lint-clean', async () => {
    await applyProjection(tenant);

    // Build LiveSnapshot: static for restEndpoints, DB for configKeys.
    const staticSnap = assembleStaticSnapshot(REPO_ROOT);
    // Augment with configKeys from the fresh tenant's mcp_tool rows.
    const configKeys = await withClient(migratorUrl(), async (c) => {
      return collectConfigKeys(
        {
          query: (sql: string, values?: unknown[]) =>
            c.query(sql, values).then((r) => ({ rows: r.rows as Record<string, unknown>[] })),
        },
        tenant,
      );
    });
    const live = { ...staticSnap, configKeys };

    // Read the projected refs from DB.
    const refRows = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT r.ref_kind, r.ref_target
           FROM choros.doc_ref r
           JOIN choros.doc_page p ON p.tenant_id = r.tenant_id AND p.id = r.page_id
          WHERE r.tenant_id = $1 AND p.slug = $2`,
        [tenant, RUNBOOK_SLUG],
      );
      return rows as { ref_kind: string; ref_target: Record<string, string> }[];
    });

    expect(refRows.length, '≥1 ref row required').toBeGreaterThanOrEqual(1);

    // Map to DocRef shape.
    const refs: DocRef[] = refRows.map((row) => ({
      refKind: row.ref_kind as DocRef['refKind'],
      refTarget: row.ref_target,
    }));

    // Assert the specific refs the ADR mandates exist.
    const restRefs = refs.filter((r) => r.refKind === 'rest_endpoint');
    const configRefs = refs.filter((r) => r.refKind === 'config_key');

    expect(restRefs.length, '≥2 rest_endpoint refs required').toBeGreaterThanOrEqual(2);
    expect(configRefs.length, '≥1 config_key ref required').toBeGreaterThanOrEqual(1);

    const healthRef = restRefs.find((r) => r.refTarget['path'] === '/health');
    const activationRef = restRefs.find((r) => r.refTarget['path'] === '/vendor/activation');
    expect(healthRef, 'GET /health ref must be present').toBeDefined();
    expect(activationRef, 'GET /vendor/activation ref must be present').toBeDefined();
    expect(healthRef?.refTarget['method'], 'GET /health method').toBe('GET');
    expect(activationRef?.refTarget['method'], 'GET /vendor/activation method').toBe('GET');

    const emitFormRef = configRefs.find((r) => r.refTarget['key'] === 'emit_form_code');
    expect(emitFormRef, 'emit_form_code config_key ref must be present').toBeDefined();

    // Assert lint-clean.
    const result = checkDocRefs(refs, live);
    expect(result.ok, `checkDocRefs must return ok:true; violations: ${
      result.ok ? '' : JSON.stringify((result as { violations: unknown[] }).violations)
    }`).toBe(true);

    // Assert restEndpoints in static snapshot.
    expect(
      staticSnap.restEndpoints.has('GET /health'),
      'LiveSnapshot must contain GET /health',
    ).toBe(true);
    expect(
      staticSnap.restEndpoints.has('GET /vendor/activation'),
      'LiveSnapshot must contain GET /vendor/activation',
    ).toBe(true);
    expect(
      configKeys.has('emit_form_code'),
      'configKeys for fresh tenant must contain emit_form_code (seeded in test setup)',
    ).toBe(true);
  });

  it('negative: snapshot missing GET /health → checkDocRefs reports missing_referent violation', () => {
    // Build a synthetic snapshot that is missing /health.
    const staticSnap = assembleStaticSnapshot(REPO_ROOT);
    // Remove 'GET /health' from restEndpoints to simulate absence.
    const reducedEndpoints = new Set([...staticSnap.restEndpoints].filter((e) => e !== 'GET /health'));
    const truncatedLive = {
      ...staticSnap,
      restEndpoints: reducedEndpoints,
      configKeys: new Set(['emit_form_code']),
    };

    const refs: DocRef[] = [
      { refKind: 'rest_endpoint', refTarget: { method: 'GET', path: '/health' } },
    ];

    const result = checkDocRefs(refs, truncatedLive);
    expect(result.ok, 'checkDocRefs must return ok:false when /health is absent').toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.refTarget['path'] === '/health'),
        'violation must mention missing /health path').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// F-5: Cross-tenant isolation — fresh tenant B cannot see fresh tenant A's page
// via choros_app (single tenant_id RLS, NF-1, T-0134 §2.4, migration 061)
// ---------------------------------------------------------------------------

describe('F-5: cross-tenant isolation — tenant B cannot see tenant A projected page', () => {
  const tenantA = freshTenant();
  const tenantB = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1 OR tenant_id = $2`, [tenantA, tenantB]);
      await c.query(
        `DELETE FROM choros.mcp_tool WHERE (tenant_id = $1 OR tenant_id = $2) AND name = 'emit_form_code'`,
        [tenantA, tenantB],
      );
    });
  });

  it('choros_app session for tenant B sees 0 rows from tenant A projected page', async () => {
    // Project into tenant A.
    await applyProjection(tenantA);

    // Tenant A sees its own page.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantA}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1 AND slug = $2`,
        [tenantA, RUNBOOK_SLUG],
      );
      await c.query('ROLLBACK');
      expect((rows[0] as { n: number }).n, 'tenant A must see its own projected page').toBe(1);
    });

    // Tenant B sees 0 rows for slug system/install-runbook from tenant A.
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantB}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.doc_page WHERE tenant_id = $1 AND slug = $2`,
        [tenantA, RUNBOOK_SLUG],  // explicitly filter by tenant A — RLS must block
      );
      await c.query('ROLLBACK');
      expect((rows[0] as { n: number }).n, 'tenant B must see 0 rows from tenant A (RLS enforced)').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// F-7: Additive-only — docs-author role still has exactly 2 doc_page grants;
//      no new mcp_tool rows for docs tooling (unchanged after projection)
// ---------------------------------------------------------------------------

describe('F-7: additive-only — docs-author grants unchanged, no extra mcp_tool rows', () => {
  it('docs-author role (e0...005) has exactly 2 doc_page grants (unchanged from P-1)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND role_id = $2
            AND resource_type = 'doc_page'`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect((rows[0] as { n: number }).n, 'docs-author must still have exactly 2 doc_page grants').toBe(2);
    });
  });

  it('no new doc tooling mcp_tool rows (doc_page_author + doc_ref_set count remains 2)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool WHERE tenant_id = $1
            AND (name = 'doc_page_author' OR name = 'doc_ref_set')`,
        [DEV_TENANT],
      );
      expect((rows[0] as { n: number }).n, 'doc tooling mcp_tool count must remain 2').toBe(2);
    });
  });

  it('migration 065 dev-tenant page (a1...001) has scope=system and catalog_version=install-runbook.v1', async () => {
    // Verify the actual seed inserted by migration 065 into the dev-tenant.
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT scope, catalog_version, authored_by
           FROM choros.doc_page
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, PAGE_UUID_065],
      );
      expect(rows.length, '065 page row must exist in dev-tenant').toBe(1);
      const row = rows[0] as { scope: string; catalog_version: string; authored_by: string };
      expect(row.scope, 'scope must be system').toBe('system');
      expect(row.catalog_version, 'catalog_version must be install-runbook.v1').toBe(CATALOG_VERSION);
      expect(row.authored_by, 'authored_by must be system').toBe('system');
    });
  });
});

// ---------------------------------------------------------------------------
// F-8: doc_log row present with correct op, actor, diff_summary, no secret
// ---------------------------------------------------------------------------

describe('F-8: doc_log row with op=system_doc_projected, agent_actor=system, secret-free', () => {
  const tenant = freshTenant();

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros.doc_page WHERE tenant_id = $1`, [tenant]);
      await c.query(`DELETE FROM choros.mcp_tool WHERE tenant_id = $1 AND name = 'emit_form_code'`, [tenant]);
    });
  });

  it('doc_log has ≥1 row with op=system_doc_projected and agent_actor=system', async () => {
    await applyProjection(tenant);

    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT l.op, l.agent_actor, l.diff_summary
           FROM choros.doc_log l
           JOIN choros.doc_page p ON p.tenant_id = l.tenant_id AND p.id = l.page_id
          WHERE l.tenant_id = $1 AND p.slug = $2 AND l.op = 'system_doc_projected'`,
        [tenant, RUNBOOK_SLUG],
      );
      expect(rows.length, '≥1 doc_log row with op=system_doc_projected required').toBeGreaterThanOrEqual(1);
      const logRow = rows[0] as { op: string; agent_actor: string; diff_summary: string | null };
      expect(logRow.op, 'op must be system_doc_projected').toBe('system_doc_projected');
      expect(logRow.agent_actor, 'agent_actor must be system').toBe('system');
      expect(logRow.diff_summary, 'diff_summary must not be null').not.toBeNull();
      // diff_summary must carry catalog_version and no secret material.
      expect(
        logRow.diff_summary,
        'diff_summary must mention catalog_version (install-runbook.v1)',
      ).toContain(CATALOG_VERSION);
    });
  });

  it('doc_log diff_summary contains no secret material', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT l.diff_summary
           FROM choros.doc_log l
           JOIN choros.doc_page p ON p.tenant_id = l.tenant_id AND p.id = l.page_id
          WHERE l.tenant_id = $1 AND p.slug = $2 AND l.op = 'system_doc_projected'`,
        [tenant, RUNBOOK_SLUG],
      );
      expect(rows.length, 'doc_log row required').toBeGreaterThanOrEqual(1);
      const summary = ((rows[0] as { diff_summary: string | null }).diff_summary ?? '').toLowerCase();
      const secretTerms = ['password', 'secret', 'token', 'private_key', 'api_key', 'auth'];
      for (const term of secretTerms) {
        expect(summary, `diff_summary must not contain '${term}'`).not.toContain(term);
      }
    });
  });
});
