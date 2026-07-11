// T-0566 · DELETE /api/applications/:id — cascade hard-delete live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:5432/choros \
//   APP_DATABASE_URL=postgres://choros_app:...@localhost:5432/choros \
//   npm run fitness:db
//
// Covers (frozen HTTP contract T-0566 §1):
//   - DELETE app → 204; the app row, its registry_defs, and those defs' records are
//     all gone; process_app_binding rows for the app are removed (UNBIND) while the
//     process definition is NOT deleted.
//   - an application.deleted audit event is appended with the removed counts.
//   - 404 when the app is not in the caller's tenant (RLS-filtered).
//
// Tenant scoping runs through registerApplicationRoutes' injected resolveActorTenant
// under withTenantTx + FORCE RLS (the production RLS path). The route pool uses the
// choros_app (NOBYPASSRLS) role so cross-tenant denial is enforced by the DB policy.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerApplicationRoutes } from '../../../src/http/applications.js';

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!process.env['DATABASE_URL']) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

const hasDb = Boolean(process.env['DATABASE_URL']);

// FRESH random tenants (NOT the shared TENANT_A/B) — avoids cross-suite audit_head
// pollution and keeps this probe hermetic (mirrors registry_def_cascade_relation).
const TENANT_A = uuid();
const TENANT_B = uuid();

// actor-a → TENANT_A (owner/admin), actor-b → TENANT_B.
// T-0690: actor-c → TENANT_A, actor-e → TENANT_A, actor-d → TENANT_B — NON-privileged
// (no role_assignment seeded for them at all; resolveActorPrivilege fail-closes an
// unknown actor to { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false }) —
// the author-of-own-draft floor (T-0690) is exercised by plain application
// authorship, not by any owner/admin/grant machinery.
async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'del-actor-a') return TENANT_A;
  if (slug === 'del-actor-b') return TENANT_B;
  if (slug === 'del-actor-c') return TENANT_A;
  if (slug === 'del-actor-e') return TENANT_A;
  if (slug === 'del-actor-d') return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

// Seed a tenant + a genesis-owner employee/role/assignment so resolveActorPrivilege
// grants the config-delete privilege (isOwnerOrAdmin). Mirrors the cascade-relation
// suite's owner seed.
async function seedOwnerTenant(c: pg.Client, tenantId: string, ownerSlug: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
  const empId = uuid();
  const roleId = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, empId, ownerSlug, `Owner ${ownerSlug}`],
  );
  // Role slug MUST be exactly 'tenant-owner' — isGenesisOwnerForTenant keys on it
  // (org.ts). Per-tenant RLS isolation lets each tenant carry its own 'tenant-owner'.
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, 'tenant-owner', 'Tenant Owner', 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, roleId],
  );
  // Resolve the actual role id (may pre-exist from a sibling suite's seed).
  const roleRes = await c.query<{ id: string }>(
    `SELECT id FROM choros.role WHERE tenant_id = $1 AND slug = 'tenant-owner' LIMIT 1`,
    [tenantId],
  );
  const actualRoleId = roleRes.rows[0]!.id;
  // Resolve the employee id (INSERT above may have hit ON CONFLICT DO NOTHING).
  const empRes = await c.query<{ id: string }>(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
    [tenantId, ownerSlug],
  );
  const actualEmpId = empRes.rows[0]!.id;
  // Idempotent owner assignment: only if this actor is not already tenant-owner.
  const raExists = await c.query(
    `SELECT 1 FROM choros.role_assignment
      WHERE tenant_id = $1 AND employee_id = $2 AND role_id = $3 AND confirmed_by IS NOT NULL LIMIT 1`,
    [tenantId, actualEmpId, actualRoleId],
  );
  if (raExists.rowCount === 0) {
    await c.query(
      `INSERT INTO choros.role_assignment
         (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
          source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
       VALUES ($1, $2, $3::uuid, $4, $5::jsonb, NULL, NULL, 'genesis', $6::text, $6::text, $6::text, 0, 0)`,
      [
        tenantId,
        uuid(),
        actualEmpId,
        actualRoleId,
        JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'org', nodeLevel: 'department' }),
        ownerSlug,
      ],
    );
  }
  await c.query('COMMIT');
}

function request(
  baseUrl: string,
  method: string,
  path: string,
  actor: string,
  body?: unknown,
): Promise<{ statusCode: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { 'x-dev-user': actor };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = text; }
          resolve({ statusCode: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });

  const router = new Router();
  registerApplicationRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  await withClient(migratorUrl(), async (c) => {
    await seedOwnerTenant(c, TENANT_A, 'del-actor-a');
    await seedOwnerTenant(c, TENANT_B, 'del-actor-b');
  });
});

afterAll(async () => {
  if (!hasDb) return;
  // FK-safe teardown of any residue for the fresh tenants (self-cleanup).
  await withClient(migratorUrl(), async (c) => {
    for (const t of [TENANT_A, TENANT_B]) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
      for (const tbl of [
        'file_version', 'file', 'record', 'cross_app_ref', 'registry_schema_history',
        'report_page_dep', 'template_dep', 'template_def', 'registry_def',
        'doc_log', 'doc_ref', 'doc_page', 'list_view', 'report_page',
        'process_app_binding', 'application', 'audit_event', 'audit_head',
        'role_assignment', 'role', 'employee',
      ]) {
        await c.query(`DELETE FROM choros.${tbl} WHERE tenant_id = $1`, [t]).catch(() => {});
      }
      await c.query('COMMIT');
      await c.query(`DELETE FROM choros.tenant WHERE tenant_id = $1`, [t]).catch(() => {});
    }
  }).catch(() => {});
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Seed an application + registry_def + N records + a process_app_binding, all directly
// under the migrator (bypass RLS). Returns the ids for assertions.
//
// T-0690 opts:
//   - appTier: 'draft' (default) | 'published' — the app's own tier.
//   - appCreatedBy: the app row's created_by (author slug); null (default) mirrors
//     the pre-T-0690 shape (unknown authorship).
//   - withBindings: also seed a report_page + list_view + doc_page bound DIRECTLY
//     to the application (app_id / application_id) — the T-0690 cascade-completeness
//     probe (these three were NOT cascaded before T-0690's cascade extension).
async function seedAppWithData(
  tenantId: string,
  ownerSlug: string,
  recordCount: number,
  opts: { appTier?: 'draft' | 'published'; appCreatedBy?: string | null; withBindings?: boolean } = {},
): Promise<{
  appId: string;
  regId: string;
  recordIds: string[];
  procKey: string;
  reportPageId: string | null;
  listViewId: string | null;
  docPageId: string | null;
}> {
  const { appTier = 'draft', appCreatedBy = null, withBindings = false } = opts;
  const appId = uuid();
  const regId = uuid();
  const procKey = `proc-${uuid().slice(0, 8)}`;
  const recordIds: string[] = [];
  let reportPageId: string | null = null;
  let listViewId: string | null = null;
  let docPageId: string | null = null;
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(
      `INSERT INTO choros.application (tenant_id, id, slug, display_name, description, tier, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $3, NULL, $4, $5, 0, 0)`,
      [tenantId, appId, `del-app-${appId.slice(0, 8)}`, appTier, appCreatedBy],
    );
    await c.query(
      `INSERT INTO choros.registry_def (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
      [tenantId, regId, appId, `del-reg-${regId.slice(0, 8)}`, JSON.stringify({ type: 'object', properties: {} })],
    );
    for (let i = 0; i < recordCount; i++) {
      const rid = uuid();
      recordIds.push(rid);
      await c.query(
        `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4::jsonb, 0, 0, $5)`,
        [tenantId, rid, regId, JSON.stringify({ n: i }), ownerSlug],
      );
    }
    await c.query(
      `INSERT INTO choros.process_app_binding (tenant_id, id, process_key, application_id, form_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, 0, 0)`,
      [tenantId, uuid(), procKey, appId],
    );
    if (withBindings) {
      reportPageId = uuid();
      await c.query(
        `INSERT INTO choros.report_page (tenant_id, id, app_id, slug, title, floor, tier, page_def, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4, '1', $5, $6::jsonb, 0, 0)`,
        [tenantId, reportPageId, appId, `del-rp-${reportPageId.slice(0, 8)}`, appTier, JSON.stringify({ blocks: [] })],
      );
      listViewId = uuid();
      await c.query(
        `INSERT INTO choros.list_view (tenant_id, id, application_id, type, name, is_default, config, created_at, updated_at, created_by, source)
         VALUES ($1, $2, $3, 'list', $4, false, $5::jsonb, 0, 0, $6, 'records')`,
        [tenantId, listViewId, appId, `del-lv-${listViewId.slice(0, 8)}`, JSON.stringify({}), ownerSlug],
      );
      docPageId = uuid();
      await c.query(
        `INSERT INTO choros.doc_page (tenant_id, id, slug, title, body, scope, app_id, authored_by, authored_at, updated_at)
         VALUES ($1, $2, $3, $3, 'body', 'tenant', $4, $5, 0, 0)`,
        [tenantId, docPageId, `del-dp-${docPageId.slice(0, 8)}`, appId, ownerSlug],
      );
    }
    await c.query('COMMIT');
  });
  return { appId, regId, recordIds, procKey, reportPageId, listViewId, docPageId };
}

describe('applications API — cascade delete (T-0566)', () => {
  it('DELETE cascades records + registry_defs, unbinds processes, audits, → 204', requireDb(async () => {
    const { appId, regId, recordIds, procKey } = await seedAppWithData(TENANT_A, 'del-actor-a', 3);

    const del = await request(baseUrl, 'DELETE', `/api/applications/${appId}`, 'del-actor-a');
    expect(del.statusCode, JSON.stringify(del.json)).toBe(204);

    // Assert full cascade + audit under the migrator (bypass RLS to inspect).
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);

      const app = await c.query(`SELECT 1 FROM choros.application WHERE tenant_id = $1 AND id = $2`, [TENANT_A, appId]);
      expect(app.rowCount, 'application row must be gone').toBe(0);

      const reg = await c.query(`SELECT 1 FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`, [TENANT_A, regId]);
      expect(reg.rowCount, 'registry_def must be gone').toBe(0);

      const recs = await c.query(
        `SELECT 1 FROM choros.record WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [TENANT_A, recordIds],
      );
      expect(recs.rowCount, 'all records must be gone').toBe(0);

      const bind = await c.query(
        `SELECT 1 FROM choros.process_app_binding WHERE tenant_id = $1 AND application_id = $2`,
        [TENANT_A, appId],
      );
      expect(bind.rowCount, 'process_app_binding rows for the app must be removed (unbind)').toBe(0);

      const audit = await c.query<{ payload: unknown }>(
        `SELECT payload FROM choros.audit_event
          WHERE tenant_id = $1 AND type = 'application.deleted' AND subject = $2
          ORDER BY occurred_at DESC LIMIT 1`,
        [TENANT_A, appId],
      );
      expect(audit.rowCount, 'application.deleted audit event must exist').toBe(1);
      const payload = audit.rows[0]!.payload as Record<string, unknown>;
      expect(payload['records_removed']).toBe(3);
      expect(payload['fieldsets_removed']).toBe(1);
      expect(payload['processes_unbound']).toBe(1);

      await c.query('COMMIT');
    });

    // procKey is only referenced to make the binding meaningful; nothing to assert on
    // the process definition side (it was never created — the binding is the link).
    void procKey;
  }));

  it('DELETE cross-tenant app → 404 (RLS-filtered)', requireDb(async () => {
    const { appId } = await seedAppWithData(TENANT_B, 'del-actor-b', 1);

    // actor-a (TENANT_A) tries to delete B's app → not visible → 404.
    const del = await request(baseUrl, 'DELETE', `/api/applications/${appId}`, 'del-actor-a');
    expect(del.statusCode, JSON.stringify(del.json)).toBe(404);

    // Sanity: the app still exists (nothing deleted cross-tenant).
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const app = await c.query(`SELECT 1 FROM choros.application WHERE tenant_id = $1 AND id = $2`, [TENANT_B, appId]);
      await c.query('COMMIT');
      expect(app.rowCount, "B's app must survive A's cross-tenant delete attempt").toBe(1);
    });
  }));

  it('DELETE unknown id in own tenant → 404', requireDb(async () => {
    const del = await request(baseUrl, 'DELETE', `/api/applications/${uuid()}`, 'del-actor-a');
    expect(del.statusCode, JSON.stringify(del.json)).toBe(404);
  }));
});

// ---------------------------------------------------------------------------
// T-0690: "draft = personal sandbox of the author" — a NON-privileged actor
// (no owner/admin, no authoring_draft grant — del-actor-c/d/e hold NEITHER,
// see stubResolveActorTenant) may delete an application THEY created THEMSELVES
// while it is still draft. Every boundary is its own test (адверс-judge target):
// own-draft → 204; own-published → 403; someone-else's-draft (same tenant) →
// 403; authorship match across tenants → 404 (RLS wins, never leaks).
// ---------------------------------------------------------------------------
describe('applications API — author-of-own-draft delete floor (T-0690)', () => {
  it("non-privileged author deletes THEIR OWN draft app → 204, full cascade incl. " +
     'report_page/list_view/doc_page (no orphans)', requireDb(async () => {
    const { appId, regId, recordIds, reportPageId, listViewId, docPageId } =
      await seedAppWithData(TENANT_A, 'del-actor-c', 2, {
        appTier: 'draft',
        appCreatedBy: 'del-actor-c',
        withBindings: true,
      });

    // del-actor-c has NO role_assignment / grant anywhere (only actor-a/actor-b
    // are seeded as owners) — resolveActorPrivilege fail-closes them to
    // { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false }. Only the T-0690
    // created_by=self AND tier=draft floor can let this succeed.
    const del = await request(baseUrl, 'DELETE', `/api/applications/${appId}`, 'del-actor-c');
    expect(del.statusCode, JSON.stringify(del.json)).toBe(204);

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);

      const app = await c.query(`SELECT 1 FROM choros.application WHERE tenant_id = $1 AND id = $2`, [TENANT_A, appId]);
      expect(app.rowCount, 'application row must be gone').toBe(0);

      const reg = await c.query(`SELECT 1 FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`, [TENANT_A, regId]);
      expect(reg.rowCount, 'registry_def must be gone').toBe(0);

      const recs = await c.query(
        `SELECT 1 FROM choros.record WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [TENANT_A, recordIds],
      );
      expect(recs.rowCount, 'all records must be gone').toBe(0);

      const bind = await c.query(
        `SELECT 1 FROM choros.process_app_binding WHERE tenant_id = $1 AND application_id = $2`,
        [TENANT_A, appId],
      );
      expect(bind.rowCount, 'process_app_binding rows for the app must be removed (unbind)').toBe(0);

      // T-0690 cascade-completeness: report_page/list_view/doc_page bound DIRECTLY
      // to the application (never touched by T-0566's original cascade) must be
      // gone too — no orphans left by the newly-enabled self-service delete path.
      const rp = await c.query(`SELECT 1 FROM choros.report_page WHERE tenant_id = $1 AND id = $2`, [TENANT_A, reportPageId]);
      expect(rp.rowCount, 'report_page bound to the app must be gone').toBe(0);
      const lv = await c.query(`SELECT 1 FROM choros.list_view WHERE tenant_id = $1 AND id = $2`, [TENANT_A, listViewId]);
      expect(lv.rowCount, 'list_view bound to the app must be gone').toBe(0);
      const dp = await c.query(`SELECT 1 FROM choros.doc_page WHERE tenant_id = $1 AND id = $2`, [TENANT_A, docPageId]);
      expect(dp.rowCount, 'doc_page bound to the app must be gone').toBe(0);

      const audit = await c.query<{ payload: unknown; actor: string }>(
        `SELECT payload, actor FROM choros.audit_event
          WHERE tenant_id = $1 AND type = 'application.deleted' AND subject = $2
          ORDER BY occurred_at DESC LIMIT 1`,
        [TENANT_A, appId],
      );
      expect(audit.rowCount, 'application.deleted audit event must exist').toBe(1);
      expect(audit.rows[0]!.actor).toBe('del-actor-c');
      const payload = audit.rows[0]!.payload as Record<string, unknown>;
      expect(payload['records_removed']).toBe(2);
      expect(payload['fieldsets_removed']).toBe(1);
      expect(payload['report_pages_removed']).toBe(1);
      expect(payload['list_views_removed']).toBe(1);
      expect(payload['doc_pages_removed']).toBe(1);
      expect(payload['processes_unbound']).toBe(1);

      await c.query('COMMIT');
    });
  }));

  it("non-privileged author's OWN app is PUBLISHED → 403 (self-service floor is draft-only)",
    requireDb(async () => {
    const { appId } = await seedAppWithData(TENANT_A, 'del-actor-c', 0, {
      appTier: 'published',
      appCreatedBy: 'del-actor-c',
    });

    const del = await request(baseUrl, 'DELETE', `/api/applications/${appId}`, 'del-actor-c');
    expect(del.statusCode, JSON.stringify(del.json)).toBe(403);

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const app = await c.query(`SELECT 1 FROM choros.application WHERE tenant_id = $1 AND id = $2`, [TENANT_A, appId]);
      await c.query('COMMIT');
      expect(app.rowCount, "author's own PUBLISHED app must survive a non-privileged delete attempt").toBe(1);
    });
  }));

  it("non-privileged actor CANNOT delete someone ELSE's draft app in the SAME tenant → 403",
    requireDb(async () => {
    // Drafted by 'del-actor-e' (also non-privileged); del-actor-c tries to delete it.
    const { appId } = await seedAppWithData(TENANT_A, 'del-actor-e', 0, {
      appTier: 'draft',
      appCreatedBy: 'del-actor-e',
    });

    const del = await request(baseUrl, 'DELETE', `/api/applications/${appId}`, 'del-actor-c');
    expect(del.statusCode, JSON.stringify(del.json)).toBe(403);

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const app = await c.query(`SELECT 1 FROM choros.application WHERE tenant_id = $1 AND id = $2`, [TENANT_A, appId]);
      await c.query('COMMIT');
      expect(app.rowCount, "another author's draft app must survive a non-owner delete attempt").toBe(1);
    });
  }));

  it('authorship-slug match ALONE never crosses the tenant boundary → 404 (RLS wins)',
    requireDb(async () => {
    // A draft app in TENANT_B whose created_by happens to equal 'del-actor-c' (the
    // SAME slug as the TENANT_A actor below) — an adversarial probe that the
    // created_by=actor comparison is never reached for a row outside the caller's
    // OWN RLS-scoped tenant; tenant resolution (resolveActorTenant) pins del-actor-c
    // to TENANT_A only, so the SELECT ... WHERE tenant_id = TENANT_A never even
    // sees this TENANT_B row.
    const { appId } = await seedAppWithData(TENANT_B, 'del-actor-c', 0, {
      appTier: 'draft',
      appCreatedBy: 'del-actor-c',
    });

    const del = await request(baseUrl, 'DELETE', `/api/applications/${appId}`, 'del-actor-c');
    expect(del.statusCode, JSON.stringify(del.json)).toBe(404);

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const app = await c.query(`SELECT 1 FROM choros.application WHERE tenant_id = $1 AND id = $2`, [TENANT_B, appId]);
      await c.query('COMMIT');
      expect(app.rowCount, 'a same-slug-authored app in a DIFFERENT tenant must survive').toBe(1);
    });
  }));
});
