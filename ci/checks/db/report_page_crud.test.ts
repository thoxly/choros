// T-0178 · T-0121d — report_page CRUD + promote live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// Covers (ADR T-0121 §5/§6/§7 / spec T-0178):
//   AC-1:  POST /api/report-pages → 201 draft page created.
//   AC-2:  Floor-1 create: deps auto-derived from page_def; report_page_dep rows created.
//   AC-4:  Create with bad field_key → 422 INVALID_DEP_FIELD; atomicity: no report_page row.
//   AC-6:  GET /api/report-pages/:id → 200 with full page object.
//   AC-7:  GET /api/report-pages?app_id=<uuid> → 200 { pages: [...] }.
//   AC-8:  PATCH draft page title → 200 updated_at changes.
//   AC-9:  PATCH published page → 409 PUBLISHED_LOCKED.
//   AC-10: PATCH Floor-1 page_def → old deps deleted, new deps registered atomically.
//   AC-11: DELETE page → 204; report_page_dep CASCADE deleted; audit_event written.
//   AC-14: Promote with stale dep → 409 STALE_DEPENDENCIES; tier remains draft.
//   AC-15: Promote non-draft page → 409 NOT_IN_DRAFT.
//   AC-16: Promote success (genesis-owner) → tier='published' in DB, audit_event written.
//   AC-18: Audit events present for create/promote/delete.
//   AC-23: end-to-end: create + promote (genesis-owner) flow.
//   AC-24: promote blocked on stale dep → stale cleared → promote success.
//   FF-DEP-VALIDATE, FF-PROMOTE-GATE, FF-AUDIT-EVENTS live probes.
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

// ---------------------------------------------------------------------------
// requireDb helper — skip if no DATABASE_URL
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
    [tenantId, id, `rp-app-${id.slice(0, 8)}`],
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
    [tenantId, id, appId, `rp-reg-${id.slice(0, 8)}`, JSON.stringify(schema)],
  );
  await c.query('COMMIT');
  return id;
}

/** Seed a report_page via direct INSERT (bypass HTTP). */
async function seedReportPageDirect(
  c: pg.Client,
  tenantId: string,
  appId: string,
  opts: { tier?: 'draft' | 'published'; floor?: '1' | '2'; slug?: string } = {},
): Promise<{ id: string; slug: string }> {
  const id = uuid();
  const slug = opts.slug ?? `rp-page-${id.slice(0, 8)}`;
  const tier = opts.tier ?? 'draft';
  const floor = opts.floor ?? '1';
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  if (tier === 'published') {
    // Need promoting GUC to bypass trigger
    await c.query("SET LOCAL choros.promoting = '1'");
  }
  await c.query(
    `INSERT INTO choros.report_page
       (tenant_id, id, app_id, slug, title, floor, tier, page_def, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5, $6, '[{"source_registry_def_id":"r1","field_key":"amount","agg":"sum"}]'::jsonb, 0, 0)`,
    [tenantId, id, appId, slug, floor, tier],
  );
  await c.query('COMMIT');
  return { id, slug };
}

/** Seed a report_page_dep via direct INSERT. */
async function seedReportPageDepDirect(
  c: pg.Client,
  tenantId: string,
  pageId: string,
  registryDefId: string,
  fieldKey: string,
  stale = false,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.report_page_dep
       (tenant_id, id, page_id, registry_def_id, field_key, dep_kind, stale, created_at)
     VALUES ($1, $2, $3, $4, $5, 'aggregate', $6, 0)`,
    [tenantId, id, pageId, registryDefId, fieldKey, stale],
  );
  await c.query('COMMIT');
  return id;
}

// ---------------------------------------------------------------------------
// HTTP helpers
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
      'x-dev-user': 'e-owner', // genesis-owner
      ...extraHeaders,
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const parsed = new URL(baseUrl + path);
    const options = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
      });
    });
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

// Start test server once
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
  // Run cleanup in reverse order
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

// ---------------------------------------------------------------------------
// Helper: delete seeded rows after test
// ---------------------------------------------------------------------------

function addCleanup(fn: () => Promise<void>): void {
  cleanupFns.push(fn);
}

// ---------------------------------------------------------------------------
// AC-1/AC-2: POST /api/report-pages → create draft, deps auto-derived (Floor-1)
// ---------------------------------------------------------------------------

describe('POST /api/report-pages — create draft (Floor-1, AC-1/AC-2)', () => {
  it('AC-1/AC-2', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!, { properties: { amount: { type: 'number' } } });
    });

    const pageDef = [
      { source_registry_def_id: regId!, field_key: 'amount', agg: 'sum' },
    ];

    const result = await makeRequest(baseUrl, 'POST', '/api/report-pages', {
      app_id: appId!,
      slug: `crud-test-${uuid().slice(0, 8)}`,
      title: 'Test Page',
      floor: '1',
      page_def: pageDef,
    });

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body['tier']).toBe('draft');
    expect(body['floor']).toBe('1');
    expect(typeof body['id']).toBe('string');
    const pageId = body['id'] as string;

    // Verify dep was auto-derived and created
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      const depRes = await c.query(
        `SELECT field_key, dep_kind, stale
           FROM choros.report_page_dep
          WHERE tenant_id = $1 AND page_id = $2`,
        [tenantId, pageId],
      );
      expect(depRes.rows.length).toBe(1);
      expect(depRes.rows[0].field_key).toBe('amount');
      expect(depRes.rows[0].dep_kind).toBe('aggregate');
      expect(depRes.rows[0].stale).toBe(false);

      // AC-18: audit event report_page.authored present
      const auditRes = await c.query(
        `SELECT type FROM choros.audit_event
          WHERE tenant_id = $1 AND subject = $2 AND type = 'report_page.authored'`,
        [tenantId, pageId],
      );
      expect(auditRes.rows.length).toBeGreaterThan(0);

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
// AC-4: POST with invalid dep field_key → 422; no report_page row created (atomicity)
// ---------------------------------------------------------------------------

describe('POST /api/report-pages — INVALID_DEP_FIELD atomicity (AC-4)', () => {
  it('AC-4', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!, { properties: { real_field: {} } });
    });

    const slugVal = `crud-bad-${uuid().slice(0, 8)}`;
    const result = await makeRequest(baseUrl, 'POST', '/api/report-pages', {
      app_id: appId!,
      slug: slugVal,
      title: 'Bad Page',
      floor: '1',
      // page_def references 'nonexistent_field' which is not in record_schema
      page_def: [
        { source_registry_def_id: regId!, field_key: 'nonexistent_field', agg: 'sum' },
      ],
    });

    expect(result.statusCode).toBe(422);
    const body = JSON.parse(result.body) as { error?: Record<string, unknown> };
    expect(body.error?.['code']).toBe('INVALID_DEP_FIELD');

    // Atomicity: no report_page row was created
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const res = await c.query(
        `SELECT id FROM choros.report_page WHERE tenant_id=$1 AND slug=$2`,
        [tenantId, slugVal],
      );
      expect(res.rows.length).toBe(0); // atomicity: not created
      await c.query('COMMIT');
    });

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

// ---------------------------------------------------------------------------
// AC-6/AC-7: GET /api/report-pages/:id and ?app_id
// ---------------------------------------------------------------------------

describe('GET /api/report-pages — read endpoints (AC-6/AC-7)', () => {
  it('AC-6/AC-7', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let page: { id: string; slug: string };

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      page = await seedReportPageDirect(c, tenantId, appId!);
    });

    // AC-6: GET by id
    const r1 = await makeRequest(baseUrl, 'GET', `/api/report-pages/${page!.id}`);
    expect(r1.statusCode).toBe(200);
    const pageBody = JSON.parse(r1.body) as Record<string, unknown>;
    expect(pageBody['id']).toBe(page!.id);
    expect(pageBody['tier']).toBe('draft');
    expect(pageBody['app_id']).toBe(appId!);

    // AC-7: GET by app_id
    const r2 = await makeRequest(baseUrl, 'GET', `/api/report-pages?app_id=${appId!}`);
    expect(r2.statusCode).toBe(200);
    const listBody = JSON.parse(r2.body) as { pages: unknown[] };
    expect(Array.isArray(listBody.pages)).toBe(true);
    const found = listBody.pages.find((p: unknown) => (p as Record<string, unknown>)['id'] === page!.id);
    expect(found).toBeDefined();

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, page!.id]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// AC-8/AC-9: PATCH — update draft, block on published
// ---------------------------------------------------------------------------

describe('PATCH /api/report-pages/:id — update (AC-8/AC-9)', () => {
  it('AC-8 — update draft title, AC-9 — block on published', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let draftPage: { id: string; slug: string };
    let publishedPage: { id: string; slug: string };

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      draftPage = await seedReportPageDirect(c, tenantId, appId!);
      publishedPage = await seedReportPageDirect(c, tenantId, appId!, { tier: 'published' });
    });

    // AC-8: update draft
    const r1 = await makeRequest(baseUrl, 'PATCH', `/api/report-pages/${draftPage!.id}`, {
      title: 'Updated Title',
    });
    expect(r1.statusCode).toBe(200);
    const updated = JSON.parse(r1.body) as Record<string, unknown>;
    expect(updated['title']).toBe('Updated Title');
    expect(updated['tier']).toBe('draft');

    // AC-9: block on published
    const r2 = await makeRequest(baseUrl, 'PATCH', `/api/report-pages/${publishedPage!.id}`, {
      title: 'Cannot update',
    });
    expect(r2.statusCode).toBe(409);
    const errBody = JSON.parse(r2.body) as { error?: Record<string, unknown> };
    expect(errBody.error?.['code']).toBe('PUBLISHED_LOCKED');

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, draftPage!.id]);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, publishedPage!.id]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// AC-10: PATCH Floor-1 page_def → deps re-derived atomically
// ---------------------------------------------------------------------------

describe('PATCH /api/report-pages/:id — deps re-derived on page_def update (AC-10)', () => {
  it('AC-10', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;
    let pageId: string;
    const slugVal = `crud-patch-${uuid().slice(0, 8)}`;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!, {
        properties: { amount: { type: 'number' }, status: { type: 'string' } },
      });
    });

    // Create with dep on 'amount'
    const createResult = await makeRequest(baseUrl, 'POST', '/api/report-pages', {
      app_id: appId!,
      slug: slugVal,
      title: 'Dep Test Page',
      floor: '1',
      page_def: [{ source_registry_def_id: regId!, field_key: 'amount', agg: 'sum' }],
    });
    expect(createResult.statusCode).toBe(201);
    pageId = (JSON.parse(createResult.body) as Record<string, unknown>)['id'] as string;

    // Patch page_def to dep on 'status' instead
    const patchResult = await makeRequest(baseUrl, 'PATCH', `/api/report-pages/${pageId}`, {
      page_def: [{ source_registry_def_id: regId!, field_key: 'status', agg: 'count' }],
    });
    expect(patchResult.statusCode).toBe(200);

    // Verify: 'amount' dep gone, 'status' dep exists
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const depRes = await c.query(
        `SELECT field_key FROM choros.report_page_dep WHERE tenant_id=$1 AND page_id=$2`,
        [tenantId, pageId],
      );
      const fieldKeys = depRes.rows.map((r: Record<string, unknown>) => r['field_key']);
      expect(fieldKeys).not.toContain('amount');
      expect(fieldKeys).toContain('status');
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
// AC-11: DELETE page → 204, deps cascade, audit_event written
// ---------------------------------------------------------------------------

describe('DELETE /api/report-pages/:id (AC-11)', () => {
  it('AC-11', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;
    let pageId: string;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!, { properties: { qty: {} } });
    });

    // Create page with dep
    const createResult = await makeRequest(baseUrl, 'POST', '/api/report-pages', {
      app_id: appId!,
      slug: `crud-del-${uuid().slice(0, 8)}`,
      title: 'Delete Me',
      floor: '1',
      page_def: [{ source_registry_def_id: regId!, field_key: 'qty', agg: 'sum' }],
    });
    expect(createResult.statusCode).toBe(201);
    pageId = (JSON.parse(createResult.body) as Record<string, unknown>)['id'] as string;

    // DELETE
    const delResult = await makeRequest(baseUrl, 'DELETE', `/api/report-pages/${pageId}`);
    expect(delResult.statusCode).toBe(204);

    // Verify: page gone, deps gone, audit_event present
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      const pageRes = await c.query(
        `SELECT id FROM choros.report_page WHERE tenant_id=$1 AND id=$2`,
        [tenantId, pageId],
      );
      expect(pageRes.rows.length).toBe(0);

      const depRes = await c.query(
        `SELECT id FROM choros.report_page_dep WHERE tenant_id=$1 AND page_id=$2`,
        [tenantId, pageId],
      );
      expect(depRes.rows.length).toBe(0);

      // AC-18: audit_event report_page.deleted present (append-only, survives deletion)
      const auditRes = await c.query(
        `SELECT type FROM choros.audit_event
          WHERE tenant_id=$1 AND subject=$2 AND type='report_page.deleted'`,
        [tenantId, pageId],
      );
      expect(auditRes.rows.length).toBeGreaterThan(0);

      await c.query('COMMIT');
    });

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

// ---------------------------------------------------------------------------
// AC-14: Promote with stale dep → 409
// AC-15: Promote non-draft → 409
// ---------------------------------------------------------------------------

describe('POST /api/report-pages/:id/promote — stale + not-in-draft gates (AC-14/AC-15)', () => {
  it('AC-14 stale dep blocks promote', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;
    let page: { id: string; slug: string };

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!, { properties: { val: {} } });
      page = await seedReportPageDirect(c, tenantId, appId!);
      await seedReportPageDepDirect(c, tenantId, page.id, regId!, 'val', true); // stale=true
    });

    const r = await makeRequest(baseUrl, 'POST', `/api/report-pages/${page!.id}/promote`);
    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body) as { error?: Record<string, unknown> };
    expect(body.error?.['code']).toBe('STALE_DEPENDENCIES');

    // tier should still be draft
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const res = await c.query(
        `SELECT tier FROM choros.report_page WHERE tenant_id=$1 AND id=$2`,
        [tenantId, page!.id],
      );
      expect(res.rows[0].tier).toBe('draft');
      await c.query('COMMIT');
    });

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, page!.id]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));

  it('AC-15 promote already-published page → 409 NOT_IN_DRAFT', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let page: { id: string; slug: string };

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      page = await seedReportPageDirect(c, tenantId, appId!, { tier: 'published' });
    });

    const r = await makeRequest(baseUrl, 'POST', `/api/report-pages/${page!.id}/promote`);
    expect(r.statusCode).toBe(409);
    const body = JSON.parse(r.body) as { error?: Record<string, unknown> };
    expect(body.error?.['code']).toBe('NOT_IN_DRAFT');

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, page!.id]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// AC-16/AC-18/AC-23: Promote success end-to-end (genesis-owner)
// ---------------------------------------------------------------------------

describe('AC-16/AC-23: promote success flow (genesis-owner)', () => {
  it('end-to-end: create + promote + verify published + audit_event', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;
    let pageId: string;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!, { properties: { score: {} } });
    });

    // Create page
    const createResult = await makeRequest(baseUrl, 'POST', '/api/report-pages', {
      app_id: appId!,
      slug: `crud-promote-${uuid().slice(0, 8)}`,
      title: 'Promote Me',
      floor: '1',
      page_def: [{ source_registry_def_id: regId!, field_key: 'score', agg: 'avg' }],
    });
    expect(createResult.statusCode).toBe(201);
    pageId = (JSON.parse(createResult.body) as Record<string, unknown>)['id'] as string;

    // Promote (genesis-owner = e-owner, which is in ORG_SEED as human)
    const promoteResult = await makeRequest(baseUrl, 'POST', `/api/report-pages/${pageId}/promote`);
    expect(promoteResult.statusCode).toBe(200);
    const promoteBody = JSON.parse(promoteResult.body) as Record<string, unknown>;
    expect(promoteBody['promoted']).toBe(true);

    // Verify: tier='published' in DB
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);

      const pageRes = await c.query(
        `SELECT tier FROM choros.report_page WHERE tenant_id=$1 AND id=$2`,
        [tenantId, pageId],
      );
      expect(pageRes.rows[0].tier).toBe('published');

      // AC-18: audit_event report_page.promoted present
      const auditRes = await c.query(
        `SELECT type FROM choros.audit_event
          WHERE tenant_id=$1 AND subject=$2 AND type='report_page.promoted'`,
        [tenantId, pageId],
      );
      expect(auditRes.rows.length).toBeGreaterThan(0);

      await c.query('COMMIT');
    });

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        // Need promoting GUC to delete published page
        await c.query("SET LOCAL choros.promoting = '1'");
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, pageId]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));
});

// ---------------------------------------------------------------------------
// AC-24: promote blocked on stale dep → stale cleared → promote success
// ---------------------------------------------------------------------------

describe('AC-24: stale cleared → promote success', () => {
  it('AC-24', requireDb(async () => {
    const tenantId = DEV_TENANT_ID;
    let appId: string;
    let regId: string;
    let page: { id: string; slug: string };
    let depId: string;

    await withClient(migratorUrl(), async (c) => {
      appId = await seedApplication(c, tenantId);
      regId = await seedRegistryDef(c, tenantId, appId!, { properties: { count: {} } });
      page = await seedReportPageDirect(c, tenantId, appId!);
      depId = await seedReportPageDepDirect(c, tenantId, page.id, regId!, 'count', true); // stale=true
    });

    // First promote attempt → 409 stale
    const r1 = await makeRequest(baseUrl, 'POST', `/api/report-pages/${page!.id}/promote`);
    expect(r1.statusCode).toBe(409);
    expect(JSON.parse(r1.body).error?.['code']).toBe('STALE_DEPENDENCIES');

    // Clear stale flag directly in DB
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `UPDATE choros.report_page_dep SET stale=false WHERE tenant_id=$1 AND id=$2`,
        [tenantId, depId!],
      );
      await c.query('COMMIT');
    });

    // Second promote attempt → 200 success
    const r2 = await makeRequest(baseUrl, 'POST', `/api/report-pages/${page!.id}/promote`);
    expect(r2.statusCode).toBe(200);

    // Verify published
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const res = await c.query(
        `SELECT tier FROM choros.report_page WHERE tenant_id=$1 AND id=$2`,
        [tenantId, page!.id],
      );
      expect(res.rows[0].tier).toBe('published');
      await c.query('COMMIT');
    });

    addCleanup(async () => {
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
        await c.query("SET LOCAL choros.promoting = '1'");
        await c.query(`DELETE FROM choros.report_page WHERE tenant_id=$1 AND id=$2`, [tenantId, page!.id]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId!]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId!]);
        await c.query('COMMIT');
      });
    });
  }));
});
