// T-0619 (ADR-T0619 §2.1/§2.2/§2.3) — a hired HUMAN gets the baseline covering
// READ grant (role-reader) and can read records; a hired AGENT does not; and
// role-reader does NOT bypass field-visibility (composite gate). LIVE Postgres.
//
// Run in the `db` CI job / locally (solo — no parallel):
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//     npm run fitness:db
//
// PROVES:
//   FF-619-1 (AC): POST /api/rights/intents/hire with kind='human' assigns the
//     hired employee to role-reader (CONFIRMED) AND the covering READ grant
//     (read/record/RESOURCE_ROOT) is present → getGrantsForSubject(hired) yields
//     it → the hired human reads a record (GET /api/records/:id via the
//     production-shaped READ-PDP resolver → 200, LIST contains it). Before the
//     fix this hire produced NO role-reader assignment → 0 grants → empty
//     LIST / 404 DETAIL (the LIVE_PROOF wave-2 defect).
//   FF-619-2 (§2.2 boundary): a hire with kind='agent' does NOT get role-reader
//     — agents read via their own grant circuit; this fix touches humans only.
//   FF-619-3 (§2.3 composite gate): role-reader is a whole-resource READ that
//     makes the record VISIBLE, but it does NOT suppress field-visibility — a
//     role-scoped field omitted by a narrower covering grant is STILL redacted
//     (physically absent) even though role-reader confers it whole-resource.
//
// The hire runs through the REAL server (mirrors rights-intents.db.test.ts,
// OWNER_SLUG admin on the dev silo). The read runs through registerRecordRoutes
// with the SAME production-shaped resolveReadVisibility as
// records-read-pdp.db.test.ts (getGrantsForSubject + resource-ancestry oracle),
// against the RLS-enforcing choros_app role.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';
import type { ReadVisibilityResolver, FieldVisibilityResolver } from '../../../src/http/records.js';
import { getGrantsForSubject } from '../../../src/db/grants-dao.js';
import { loadTenantOrgAncestry } from '../../../src/db/org-ancestry.js';
import { makeResourceAncestryOracle } from '../../../src/db/resource-ancestry.js';
import { RESOURCE_ROOT_NODE_ID, READER_ROLE_SLUG, type RowAncestry } from '../../../src/core/read-visibility.js';
import type { FieldVisibilityPolicy } from '../../../src/core/field-visibility.js';
import type { Grant } from '../../../src/core/grant-lattice.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// Dev silo constants (stable from migrations) — same as rights-intents.db.test.ts.
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const ROLE_BUDGET = 'e0000000-0000-0000-0000-000000000002'; // any real role for the preset assignment
const OWNER_SLUG = 'e-owner';

// ---------------------------------------------------------------------------
// Server + seed helpers
// ---------------------------------------------------------------------------

function hireApi(port: number, body: unknown, user = OWNER_SLUG): Promise<{ status: number; json: any }> {
  return fetch(`http://127.0.0.1:${port}/api/rights/intents/hire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dev-user': user },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}

async function seedApp(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 'published', 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegDef(c: pg.Client, tenantId: string, appId: string, slug: string): Promise<string> {
  const id = uuid();
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, salary: { type: 'number' } },
    required: ['name'],
    additionalProperties: false,
  };
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
    [tenantId, id, appId, slug, JSON.stringify(schema)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecord(c: pg.Client, tenantId: string, registryId: string, data: unknown): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, 'seed')`,
    [tenantId, id, registryId, JSON.stringify(data)],
  );
  await c.query('COMMIT');
  return id;
}

/** A narrow covering READ grant scoped to one record that omits 'salary' via facet. */
async function seedNarrowFacetGrant(
  c: pg.Client, tenantId: string, roleId: string, recordId: string,
): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
        "constraint", delegable, granted_by, proposed_by, confirmed_by,
        valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'record', $4::jsonb, 'read', $5::jsonb,
             NULL, true, 'seed', NULL, 'seed', NULL, NULL, 0)`,
    [
      tenantId, uuid(), roleId,
      JSON.stringify({ fields: ['name'] }), // omits 'salary'
      JSON.stringify({ kind: 'node', hierarchy: 'resource', nodeLevel: 'record', nodeId: recordId }),
    ],
  );
  await c.query('COMMIT');
}

// Production-shaped resolvers (mirror server.ts / records-read-pdp.db.test.ts).
function makeProdShapedReadResolver(pool: pg.Pool): ReadVisibilityResolver {
  return async (actorSlug: string, tenantId: string, nowMs: number) => {
    const [grants, orgOracle] = await Promise.all([
      getGrantsForSubject(pool, tenantId, actorSlug, nowMs),
      loadTenantOrgAncestry(pool, tenantId),
    ]);
    return { grants, ancestry: makeResourceAncestryOracle(orgOracle, new Map<string, RowAncestry>()) };
  };
}

// Field-visibility resolver: covering grants from the SAME DAO (single-resolver),
// with a policy that marks 'salary' role-scoped. Because the hired human ALSO
// holds a narrow facet grant omitting 'salary', the most-restrictive rule hides
// it — proving role-reader's whole-resource READ does not suppress this layer.
function makeFieldVisibilityResolver(pool: pg.Pool, roleScoped: Set<string>): FieldVisibilityResolver {
  return async (actorSlug: string, tenantId: string, nowMs: number) => {
    const grants = await getGrantsForSubject(pool, tenantId, actorSlug, nowMs);
    const policy: FieldVisibilityPolicy = { roleScopedFields: roleScoped };
    return { coveringGrants: grants as Grant[], policy };
  };
}

function getRecordDetail(baseUrl: string, recordId: string, actor: string):
  Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records/${recordId}`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      let raw = '';
      res.on('data', (ch: Buffer) => { raw += ch.toString(); });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(raw || '{}') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function getRecords(baseUrl: string, actor: string):
  Promise<{ statusCode: number; records: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      let raw = '';
      res.on('data', (ch: Buffer) => { raw += ch.toString(); });
      res.on('end', () => {
        const b = JSON.parse(raw || '{}') as Record<string, unknown>;
        resolve({ statusCode: res.statusCode ?? 0, records: (b['records'] as Array<Record<string, unknown>>) ?? [] });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(!LIVE)('T-0619 — hire grants covering READ to a human (live Postgres)', () => {
  let hireServer: http.Server;
  let hirePort = 0;
  let readServer: http.Server;
  let readBase = '';
  let appPool: pg.Pool;

  let appId = '';
  let regId = '';
  let recordId = '';
  const createdEmployees: string[] = [];
  const createdAssignments: string[] = [];
  const createdGrants: string[] = [];
  let hiredHumanId = '';
  let hiredHumanSlug = '';
  let hiredAgentId = '';

  // resolveActorTenant for the read server: dev-silo actors map to DEV_TENANT.
  async function resolveActorTenant(_slug: string): Promise<string> {
    return DEV_TENANT;
  }

  beforeAll(async () => {
    if (!LIVE) return;
    appPool = new pg.Pool({ connectionString: appUrl() });

    // Real server drives the hire endpoint (dev-mode x-dev-user).
    const { createServer } = await import(join(REPO_ROOT, 'src', 'server.js'));
    hireServer = createServer();
    await new Promise<void>((resolve, reject) => {
      hireServer.listen(0, '127.0.0.1', () => resolve());
      hireServer.once('error', reject);
    });
    hirePort = (hireServer.address() as { port: number }).port;

    // Seed a record with a sensitive 'salary' field in the dev silo.
    await withClient(migratorUrl(), async (c) => {
      appId = await seedApp(c, DEV_TENANT, `t0619-app-${uuid().slice(0, 8)}`);
      regId = await seedRegDef(c, DEV_TENANT, appId, `t0619-reg-${uuid().slice(0, 8)}`);
      recordId = await seedRecord(c, DEV_TENANT, regId, { name: 'Payroll row', salary: 999000 });
    });

    // Read server: production-shaped READ-PDP resolver + field-visibility
    // resolver (salary role-scoped) — the SAME single DAO for both.
    const router = new Router();
    registerRecordRoutes(router, {
      pool: appPool,
      resolveActorTenant,
      resolveReadVisibility: makeProdShapedReadResolver(appPool),
      resolveFieldVisibility: makeFieldVisibilityResolver(appPool, new Set(['salary'])),
    });
    readServer = http.createServer((req, res) => router.dispatch(req, res));
    readBase = await new Promise<string>((resolve) => {
      readServer.listen(0, '127.0.0.1', () => {
        const a = readServer.address();
        resolve(a && typeof a !== 'string' ? `http://127.0.0.1:${a.port}` : '');
      });
    });
  });

  afterAll(async () => {
    if (!LIVE) return;
    await new Promise<void>((resolve) => hireServer?.close(() => resolve()));
    await new Promise<void>((resolve) => readServer?.close(() => resolve()));
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(`SET LOCAL choros.promoting = '1'`);
      for (const id of createdGrants) await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, id]);
      // Drop reader/preset assignments + grants tied to the hired employees.
      for (const id of createdEmployees) {
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND employee_id=$2`, [DEV_TENANT, id]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, id]);
      }
      for (const id of createdAssignments) await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, id]);
      // Narrow facet grant seeded onto role-reader for FF-619-3.
      await c.query(`DELETE FROM choros.record WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, recordId]);
      await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, regId]);
      await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, appId]);
      await c.query('COMMIT');
    });
    await appPool?.end();
  });

  // -------------------------------------------------------------------------
  // FF-619-1: hire kind='human' → role-reader assignment + covering READ grant
  // resolvable → the hired human reads the record (200 / LIST contains it).
  // -------------------------------------------------------------------------
  it('FF-619-1: a hired HUMAN gets role-reader and reads a record (was empty/404 before the fix)', async () => {
    hiredHumanSlug = `e-t0619-human-${Date.now()}`;
    const res = await hireApi(hirePort, {
      preset_id: 'p-audit-observer', // read-only atoms → non-critical → active
      role_id: ROLE_BUDGET,
      kind: 'human',
      slug: hiredHumanSlug,
      display_name: 'T-0619 Human',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    hiredHumanId = res.json.employee_id;
    createdEmployees.push(hiredHumanId);
    createdAssignments.push(res.json.role_assignment_id);

    // A CONFIRMED role-reader assignment now exists for the hired human.
    await withClient(migratorUrl(), async (c) => {
      await c.query('SET search_path TO choros');
      const { rows } = await c.query(
        `SELECT ra.id FROM choros.role_assignment ra
           JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
          WHERE ra.tenant_id = $1 AND ra.employee_id = $2 AND r.slug = $3
            AND ra.confirmed_by IS NOT NULL`,
        [DEV_TENANT, hiredHumanId, READER_ROLE_SLUG],
      );
      expect(rows.length, 'hired human must hold a CONFIRMED role-reader assignment').toBe(1);
    });

    // The covering READ grant resolves for the hired human.
    const grants = await getGrantsForSubject(appPool, DEV_TENANT, hiredHumanSlug, Date.now());
    const covering = grants.filter(
      (g) => g.operation === 'read' && g.resourceType === 'record'
        && (g.scope as { nodeId?: string })?.nodeId === RESOURCE_ROOT_NODE_ID,
    );
    expect(covering.length, 'hired human must resolve the RESOURCE_ROOT covering READ grant').toBeGreaterThanOrEqual(1);

    // End-to-end: the hired human READS the record through the READ-PDP gate.
    const detail = await getRecordDetail(readBase, recordId, hiredHumanSlug);
    expect(detail.statusCode, JSON.stringify(detail.body)).toBe(200);

    const list = await getRecords(readBase, hiredHumanSlug);
    expect(list.statusCode).toBe(200);
    expect(list.records.map((r) => r['id'])).toContain(recordId);
  });

  // -------------------------------------------------------------------------
  // FF-619-2: hire kind='agent' does NOT get role-reader (§2.2 boundary).
  // -------------------------------------------------------------------------
  it('FF-619-2: a hired AGENT does NOT get role-reader (agent read is a separate circuit)', async () => {
    const res = await hireApi(hirePort, {
      preset_id: 'p-audit-observer',
      role_id: ROLE_BUDGET,
      kind: 'agent',
      slug: `e-t0619-agent-${Date.now()}`,
      display_name: 'T-0619 Agent',
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    hiredAgentId = res.json.employee_id;
    createdEmployees.push(hiredAgentId);
    createdAssignments.push(res.json.role_assignment_id);

    await withClient(migratorUrl(), async (c) => {
      await c.query('SET search_path TO choros');
      const { rows } = await c.query(
        `SELECT ra.id FROM choros.role_assignment ra
           JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
          WHERE ra.tenant_id = $1 AND ra.employee_id = $2 AND r.slug = $3`,
        [DEV_TENANT, hiredAgentId, READER_ROLE_SLUG],
      );
      expect(rows.length, 'a hired AGENT must NOT be assigned role-reader by this fix').toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // FF-619-3: role-reader (whole-resource READ) does NOT bypass field-
  // visibility. The hired human ALSO holds a narrower record-scoped grant that
  // omits 'salary'; with 'salary' role-scoped, the most-restrictive rule
  // redacts it even though role-reader confers it whole-resource. Composite.
  // -------------------------------------------------------------------------
  it('FF-619-3: role-reader does NOT bypass field-visibility — a role-scoped field is still redacted', async () => {
    // Attach a narrow facet grant (omits 'salary') to role-reader so the hired
    // human's covering-grant SET no longer unanimously confers 'salary'.
    const readerRoleId = await withClient(migratorUrl(), async (c) => {
      await c.query('SET search_path TO choros');
      const { rows } = await c.query(
        `SELECT id FROM choros.role WHERE tenant_id=$1 AND slug=$2`,
        [DEV_TENANT, READER_ROLE_SLUG],
      );
      return rows[0].id as string;
    });
    await withClient(migratorUrl(), async (c) => {
      await seedNarrowFacetGrant(c, DEV_TENANT, readerRoleId, recordId);
    });

    const detail = await getRecordDetail(readBase, recordId, hiredHumanSlug);
    expect(detail.statusCode, JSON.stringify(detail.body)).toBe(200);
    const data = (detail.body['data'] ?? detail.body) as Record<string, unknown>;
    // The record is VISIBLE (record-level READ succeeded via role-reader)…
    expect(data['name'], 'a non-role-scoped field stays visible').toBe('Payroll row');
    // …but the role-scoped 'salary' is PHYSICALLY ABSENT (field-visibility layer
    // fired independently — role-reader did NOT suppress it).
    expect(Object.prototype.hasOwnProperty.call(data, 'salary'),
      'field-visibility must still redact the role-scoped field despite role-reader').toBe(false);
  });
});
