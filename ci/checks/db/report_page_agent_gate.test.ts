// T-0178 review fix (R-1/R-2/R-3) — report_page agent-gate + Floor-2/FLOOR_MISMATCH live probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// This file is a NEW file (not a modification of report_page_crud.test.ts) to comply with
// FF-T147-2 (existing db test-files must not be modified post-REVIEW commit).
//
// Covers:
//   AC-12 (R-1 blocking): POST /api/report-pages/:id/promote with agent actor
//         → 403 FORBIDDEN_AGENT_SELF_PROMOTE.
//         Uses a-recon (slug seeded in 016_employee.sql, kind='agent').
//         extractActorWithType(req) → findEmployee('a-recon') → { type:'agent' }
//         → promoteReportPage throws HttpError(403, 'FORBIDDEN_AGENT_SELF_PROMOTE').
//
//   AC-3  (R-2 nit): POST /api/report-pages with floor=2, page_code, deps[] body
//         → 201 draft; report_page_dep rows created from body deps[].
//
//   AC-17 (R-3 nit): POST /api/report-pages with floor=2 + Floor-1-expressible page_def
//         → 400 FLOOR_MISMATCH.
//
// Unit test note (AC-12): ORG_SEED (unit harness) does not include a kind='agent'
// employee — e-agent / a-recon are absent from the in-memory fixture set, so
// findEmployee returns null → actorType defaults to 'human' → gate does not fire.
// The unit-test to-contain([200,403,...]) pattern is therefore a no-op (review R-1).
// This live test is the authoritative AC-12 coverage; unit test left as-is.
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { createServer } from '../../../src/server.js';
import { resetPoolForTesting } from '../../../src/http/report-pages.js';

// DEV_TENANT_ID must match the value used by the HTTP layer (report-pages.ts).
const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

// a-recon: seeded in 016_employee.sql with kind='agent'.
// UUID suffix 0002 per migration comment.
const AGENT_SLUG = 'a-recon';

// ---------------------------------------------------------------------------
// requireDb helper
// ---------------------------------------------------------------------------

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!process.env['DATABASE_URL']) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

// ---------------------------------------------------------------------------
// Seed helpers (bypass RLS via migratorUrl)
// ---------------------------------------------------------------------------

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'draft', 0, 0)`,
    [tenantId, id, `ag-app-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegistryDef(
  c: pg.Client,
  tenantId: string,
  appId: string,
  schema: object,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5::jsonb, 'draft', 0, 0)`,
    [tenantId, id, appId, `ag-reg-${id.slice(0, 8)}`, JSON.stringify(schema)],
  );
  await c.query('COMMIT');
  return id;
}

/** Seed a draft report_page via direct INSERT (bypass HTTP). */
async function seedDraftReportPage(
  c: pg.Client,
  tenantId: string,
  appId: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.report_page
       (tenant_id, id, app_id, slug, title, floor, tier, page_def, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '1', 'draft',
             '[{"source_registry_def_id":"r1","field_key":"amount","agg":"sum"}]'::jsonb, 0, 0)`,
    [tenantId, id, appId, `ag-page-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      'x-dev-user': 'e-owner', // genesis-owner default
      ...extraHeaders,
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test server + cleanup tracking
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl: string;
const cleanupFns: Array<() => Promise<void>> = [];

if (process.env['DATABASE_URL']) {
  resetPoolForTesting();
  server = createServer();
  server.listen(0, 'localhost');
  server.on('listening', () => {
    const addr = server.address();
    if (addr && typeof addr !== 'string') {
      baseUrl = `http://localhost:${addr.port}`;
    }
  });
}

afterAll(async () => {
  for (const fn of [...cleanupFns].reverse()) {
    try {
      await fn();
    } catch (e) {
      console.warn('[cleanup error]', e);
    }
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function addCleanup(fn: () => Promise<void>): void {
  cleanupFns.push(fn);
}

// ---------------------------------------------------------------------------
// AC-12 (R-1 blocking): agent actor promote → 403 FORBIDDEN_AGENT_SELF_PROMOTE
//
// a-recon is seeded with kind='agent' in 016_employee.sql.
// extractActorWithType resolves x-dev-user via findEmployee → type='agent'
// → promoteReportPage: actorType==='agent' → throw HttpError(403,'FORBIDDEN_AGENT_SELF_PROMOTE').
// ---------------------------------------------------------------------------

describe('AC-12: agent actor POST /promote → 403 FORBIDDEN_AGENT_SELF_PROMOTE', () => {
  it('AC-12 live: a-recon (kind=agent) is blocked from promoting a draft page', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let pageId: string;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      pageId = await seedDraftReportPage(c, tenantId, appId!);
    });

    // POST promote as a-recon (kind='agent' in DB)
    const result = await makeRequest(
      baseUrl,
      'POST',
      `/api/report-pages/${pageId!}/promote`,
      undefined,
      { 'x-dev-user': AGENT_SLUG },
    );

    // Gate must fire: 403 FORBIDDEN_AGENT_SELF_PROMOTE — strictly, not just "in the set"
    expect(result.statusCode).toBe(403);
    const body = JSON.parse(result.body) as { error?: Record<string, unknown> };
    expect(body.error?.['code']).toBe('FORBIDDEN_AGENT_SELF_PROMOTE');

    // Verify: tier still 'draft' — gate did not promote
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const res = await c.query(
        `SELECT tier FROM choros.report_page WHERE tenant_id=$1 AND id=$2`,
        [tenantId, pageId!],
      );
      expect(res.rows[0]?.tier).toBe('draft');
      await c.query('COMMIT');
    });

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// AC-3 (R-2 nit): Floor-2 create with explicit deps[] body → 201; dep rows created
//
// Floor-2 page: floor='2', page_code present, no page_def (or Floor-2-only page_def).
// Deps come from body.deps[] (not auto-derived from page_def).
// ---------------------------------------------------------------------------

describe('AC-3 live: Floor-2 create with deps[] body → 201, dep rows created', () => {
  it('AC-3 live: floor=2 + page_code + deps[] → 201, report_page_dep rows match body deps', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!, {
        properties: { revenue: { type: 'number' }, count: { type: 'number' } },
      });
    });

    const slugVal = `f2-deps-${uuid().slice(0, 8)}`;
    const deps = [
      { registry_def_id: regId!, field_key: 'revenue', dep_kind: 'aggregate' },
      { registry_def_id: regId!, field_key: 'count',   dep_kind: 'aggregate' },
    ];

    const result = await makeRequest(
      baseUrl,
      'POST',
      '/api/report-pages',
      {
        app_id:    appId!,
        slug:      slugVal,
        title:     'Floor-2 Deps Test',
        floor:     '2',
        page_code: 'export default function Page() { return null; }',
        deps,
      },
    );

    expect(result.statusCode).toBe(201);
    const created = JSON.parse(result.body) as Record<string, unknown>;
    expect(created['floor']).toBe('2');
    expect(created['tier']).toBe('draft');
    const pageId = created['id'] as string;

    // Verify dep rows created from body deps (not auto-derived)
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const depRes = await c.query(
        `SELECT field_key, dep_kind, stale
           FROM choros.report_page_dep
          WHERE tenant_id=$1 AND page_id=$2
          ORDER BY field_key`,
        [tenantId, pageId],
      );
      expect(depRes.rows.length).toBe(2);
      const fieldKeys = depRes.rows.map((r: Record<string, unknown>) => r['field_key']);
      expect(fieldKeys).toContain('revenue');
      expect(fieldKeys).toContain('count');
      // All fresh, not stale
      for (const row of depRes.rows) {
        expect(row['stale']).toBe(false);
        expect(row['dep_kind']).toBe('aggregate');
      }
      await c.query('COMMIT');
    });

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// AC-17 (R-3 nit): Floor-2 create with Floor-1-expressible page_def → 400 FLOOR_MISMATCH
//
// classifyReportPageFloor is a pure function (unit-covered), but this live probe
// confirms it is wired into the HTTP path and the error is returned correctly.
// ---------------------------------------------------------------------------

describe('AC-17 live: floor=2 + Floor-1-expressible page_def → 400 FLOOR_MISMATCH', () => {
  it('AC-17 live: FLOOR_MISMATCH fires on Floor-2 page with standard agg page_def', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!, { properties: { score: { type: 'number' } } });
    });

    // page_def with standard Floor-1 vocab agg (sum, known field_key) → classifyReportPageFloor
    // returns requiredFloor='1' → FLOOR_MISMATCH
    const floor1PageDef = [
      { source_registry_def_id: regId!, field_key: 'score', agg: 'sum' },
    ];

    const result = await makeRequest(
      baseUrl,
      'POST',
      '/api/report-pages',
      {
        app_id:    appId!,
        slug:      `f2-mismatch-${uuid().slice(0, 8)}`,
        title:     'Floor Mismatch Test',
        floor:     '2',
        page_code: 'export default function Page() { return null; }',
        page_def:  floor1PageDef,
      },
    );

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body) as { error?: Record<string, unknown> };
    expect(body.error?.['code']).toBe('FLOOR_MISMATCH');

    // No page was created (atomicity: error before INSERT)
    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));
});
