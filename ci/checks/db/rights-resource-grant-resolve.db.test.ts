// T-0609 F-1 fix · «Дать роли право» на РЕАЛЬНЫЙ ресурс → грант РЕЗОЛВИТСЯ PDP.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// THE BLOCKING FINDING THIS PINS (review T-0609 F-1): the PDP covering predicate
// (grant-resolver.ts resolveFor:589-607) matches grants by tenant + operation +
// isEffective + isNarrowerOrEqual(handleScope, g.scope) — it never reads
// resource_type. A runtime request carries handleScope {hierarchy:'resource',
// nodeId:<UUID>} (refToScope); the PRE-FIX form emitted {hierarchy:'org',
// nodeId:<demo-tree-id>} — isNarrowerOrEqual short-circuits on the hierarchy
// mismatch (grant-lattice.ts:280), so EVERY grant the form produced was inert.
//
// THE FIX under test: the form now emits scope {kind:'node', hierarchy:'resource',
// nodeId:<real application/registry UUID from GET /api/rights/resources>,
// nodeLevel:'application'|'registry'} — the same enforcement path READ-PDP uses
// (migration 117 style). This suite drives the REAL form path end-to-end on live
// Postgres with PRODUCTION components only:
//
//   write:   POST /api/grants (real server via createServer(), genesis owner
//            e-owner, dev auth) with the EXACT body GrantRightForm now emits;
//   resolve: resolveFor (frozen core) + makeDbGrantSource/getGrantsForSubject
//            (production DAO, RLS pool) + makeResourceAncestryOracle over
//            loadTenantOrgAncestry (production composite oracle).
//
// Cases:
//   RESOLVE-1 (positive): grant scoped at the REAL registry node covers a record
//             in that registry → resolveFor returns denied:false.
//   RESOLVE-2 (negative, other resource): the same subject is DENIED (no_grant)
//             for a record in a DIFFERENT registry/application chain.
//   RESOLVE-3 (negative, cross-tenant): a subject from another tenant is DENIED
//             (cross_tenant) before any grant read.
//   RESOLVE-4 (F-1 pin): a grant with the PRE-FIX shape (hierarchy:'org' scope —
//             the demo-resource path, unchanged by this task) does NOT cover the
//             same record request → denied no_grant. Pins the F-1 mechanism so a
//             future regression back to org-scope emission turns this suite red.
//
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always; cleanup after self.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, TENANT_B, uuid } from './_helpers.js';
import { resolveFor } from '../../../src/core/grant-resolver.js';
import { makeHandle } from '../../../src/core/object-handle.js';
import { makeDbGrantSource } from '../../../src/db/grants-dao.js';
import { makeResourceAncestryOracle } from '../../../src/db/resource-ancestry.js';
import { loadTenantOrgAncestry } from '../../../src/db/org-ancestry.js';
import type { RowAncestry } from '../../../src/core/read-visibility.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// Genesis dev-silo tenant — e-owner (genesis owner) is seeded by migrations, so
// the REAL POST /api/grants admin gate passes for him without extra fixtures.
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const OWNER = 'e-owner';

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

// ---------------------------------------------------------------------------
// Fixture ids — two full application→registry chains + roles/holders.
// ---------------------------------------------------------------------------

const APP_A = uuid();
const REG_A = uuid();
const APP_OTHER = uuid();
const REG_OTHER = uuid();
const ROLE_REAL = uuid(); // holds the REAL-resource (resource-hierarchy) grant
const ROLE_ORG = uuid(); // holds the PRE-FIX-shaped (org-hierarchy) grant
const HOLDER_REAL = `e-t0609-real-${uuid().slice(0, 8)}`;
const HOLDER_ORG = `e-t0609-org-${uuid().slice(0, 8)}`;
const RECORD_IN_A = uuid(); // a record living in REG_A/APP_A (ancestry via rowIndex)
const RECORD_IN_OTHER = uuid(); // a record living in REG_OTHER/APP_OTHER

const APP_A_SLUG = `t0609-app-${APP_A.slice(0, 8)}`;
const REG_A_SLUG = `t0609-reg-${REG_A.slice(0, 8)}`;

let server: http.Server;
let port = 0;
let appPool: pg.Pool;

async function seedEmployeeWithRole(
  c: pg.Client,
  slug: string,
  roleId: string,
): Promise<void> {
  const employeeId = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $3, 0, 0)
     ON CONFLICT (tenant_id, slug) DO NOTHING`,
    [DEV_TENANT, employeeId, slug],
  );
  // Routine, ACTIVE assignment (canonical predicate, T-0605): confirmed_by set,
  // proposed_by NULL, confirmed2_by NULL — active immediately for the PDP.
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, granted_by, confirmed_by, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6, 'manual', 0, 0)`,
    [DEV_TENANT, uuid(), employeeId, roleId, JSON.stringify({ kind: 'set', members: [] }), slug],
  );
  await c.query('COMMIT');
}

beforeAll(async () => {
  if (!hasDb) return;

  appPool = new pg.Pool({ connectionString: appUrl() });

  await withClient(migratorUrl(), async (c) => {
    const now = Date.now();
    // Two application→registry chains (the second is the "other resource" negative).
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
    await c.query(
      `INSERT INTO choros.application
         (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
       VALUES ($1, $2, $3, $3, NULL, 'draft', 0, 0), ($1, $4, $5, $5, NULL, 'draft', 0, 0)`,
      [DEV_TENANT, APP_A, APP_A_SLUG, APP_OTHER, `t0609-other-${APP_OTHER.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO choros.registry_def
         (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, NULL, '{}'::jsonb, 0, 0), ($1, $5, $6, $7, $7, NULL, '{}'::jsonb, 0, 0)`,
      [DEV_TENANT, REG_A, APP_A, REG_A_SLUG, REG_OTHER, APP_OTHER, `t0609-rother-${REG_OTHER.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    // Two fresh roles (no other grants → deterministic grant sets).
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
    await c.query(
      `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, 'T-0609 real-resource role', $4, $4),
              ($1, $5, $6, 'T-0609 org-scope role', $4, $4)`,
      [DEV_TENANT, ROLE_REAL, `t0609-real-${ROLE_REAL.slice(0, 8)}`, now, ROLE_ORG, `t0609-org-${ROLE_ORG.slice(0, 8)}`],
    );
    await c.query('COMMIT');

    await seedEmployeeWithRole(c, HOLDER_REAL, ROLE_REAL);
    await seedEmployeeWithRole(c, HOLDER_ORG, ROLE_ORG);
  });

  const { createServer } = await import(join(REPO_ROOT, 'src', 'server.js'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
    await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND role_id = ANY($2::uuid[])`, [DEV_TENANT, [ROLE_REAL, ROLE_ORG]]);
    await c.query(
      `DELETE FROM choros.role_assignment WHERE tenant_id=$1
        AND employee_id IN (SELECT id FROM choros.employee WHERE tenant_id=$1 AND slug = ANY($2))`,
      [DEV_TENANT, [HOLDER_REAL, HOLDER_ORG]],
    );
    await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND slug = ANY($2)`, [DEV_TENANT, [HOLDER_REAL, HOLDER_ORG]]);
    await c.query(`DELETE FROM choros.role WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, [DEV_TENANT, [ROLE_REAL, ROLE_ORG]]);
    await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, [DEV_TENANT, [REG_A, REG_OTHER]]);
    await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, [DEV_TENANT, [APP_A, APP_OTHER]]);
    await c.query('COMMIT');
  });
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Shared helpers — the production resolve wiring.
// ---------------------------------------------------------------------------

async function postGrant(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/grants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dev-user': OWNER },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/**
 * Production resolve wiring: makeDbGrantSource (RLS DAO) + composite
 * resource-ancestry oracle (loadTenantOrgAncestry + inline rowIndex — the exact
 * shape records.ts builds from its already-selected page). RecordSource is the
 * injectable port (per grant-resolver.ts T-0053 seam); a stub record body is
 * legitimate here — the AUTHORITY decision under test (grants + scope
 * containment) is 100% production code over live PG rows.
 */
async function resolveRecordRead(
  subjectSlug: string,
  subjectTenant: string,
  rec: RowAncestry,
): Promise<{ denied: boolean; reason?: string }> {
  const orgOracle = await loadTenantOrgAncestry(appPool, DEV_TENANT);
  const rowIndex = new Map<string, RowAncestry>([[rec.recordId, rec]]);
  const ancestry = makeResourceAncestryOracle(orgOracle, rowIndex);

  const handle = makeHandle(
    { kind: 'record', tenantId: DEV_TENANT, registryId: rec.registryId, recordId: rec.recordId },
    DEV_TENANT,
  );
  const view = await resolveFor(
    {
      grants: makeDbGrantSource(appPool),
      records: { getRecord: async () => ({ probe: 'fields' }) },
      ancestry,
    },
    handle,
    { tenantId: subjectTenant, subjectId: subjectSlug },
    'read',
  );
  return view as { denied: boolean; reason?: string };
}

const REC_A: RowAncestry = { recordId: RECORD_IN_A, registryId: REG_A, applicationId: APP_A };
const REC_OTHER: RowAncestry = { recordId: RECORD_IN_OTHER, registryId: REG_OTHER, applicationId: APP_OTHER };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T-0609 F-1 · грант из формы на реальный ресурс резолвится PDP (live PG)', () => {
  it('RESOLVE-1: POST /api/grants (форма, resource-hierarchy scope) → resolveFor разрешает read записи этого реестра', requireDb(async () => {
    // The EXACT body GrantRightForm now emits for a real registry resource.
    const { status, json } = await postGrant({
      role_id: ROLE_REAL,
      resource_type: `registry:${APP_A_SLUG}.${REG_A_SLUG}`,
      operation: 'read',
      scope: { kind: 'node', hierarchy: 'resource', nodeId: REG_A, nodeLevel: 'registry' },
      granted_by: 'ui:rights-overview',
    });
    expect(status, JSON.stringify(json)).toBe(201);
    // Routine read grant → confirmed in one request → PDP-active immediately.
    expect(json.state).toBe('confirmed');

    const view = await resolveRecordRead(HOLDER_REAL, DEV_TENANT, REC_A);
    expect(view.denied, `expected ALLOW, got ${JSON.stringify(view)}`).toBe(false);
  }));

  it('RESOLVE-2 (negative): тот же субъект НЕ получает доступ к записи ЧУЖОГО реестра/приложения', requireDb(async () => {
    const view = await resolveRecordRead(HOLDER_REAL, DEV_TENANT, REC_OTHER);
    expect(view.denied).toBe(true);
    expect(view.reason).toBe('no_grant');
  }));

  it('RESOLVE-3 (negative): субъект другого тенанта отбивается fail-closed до чтения грантов', requireDb(async () => {
    const view = await resolveRecordRead(HOLDER_REAL, TENANT_B, REC_A);
    expect(view.denied).toBe(true);
    expect(view.reason).toBe('cross_tenant');
  }));

  it('RESOLVE-4 (F-1 pin): грант ДО-фиксной формы (org-hierarchy scope) НЕ покрывает resource-запрос', requireDb(async () => {
    // The PRE-FIX shape: org-hierarchy scope (what the form used to emit for
    // every resource, and still emits for tagged demo entries — unchanged path).
    const { status, json } = await postGrant({
      role_id: ROLE_ORG,
      resource_type: `registry:${APP_A_SLUG}.${REG_A_SLUG}`,
      operation: 'read',
      scope: { kind: 'node', hierarchy: 'org', nodeId: 'fin', nodeLevel: 'department' },
      granted_by: 'ui:rights-overview',
    });
    expect(status, JSON.stringify(json)).toBe(201);
    expect(json.state).toBe('confirmed');

    // Same record request that RESOLVE-1 allows — but this grant's scope lives in
    // the org hierarchy: isNarrowerOrEqual short-circuits on the hierarchy
    // mismatch (grant-lattice.ts:280) → inert, exactly finding F-1.
    const view = await resolveRecordRead(HOLDER_ORG, DEV_TENANT, REC_A);
    expect(view.denied).toBe(true);
    expect(view.reason).toBe('no_grant');
  }));
});
