// T-0721 (D-064, P1 из T-0714 — security/PDP) · GET /api/processes/:id DETAIL
// read-visibility gate — LIVE Postgres probe.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// PROVES against the REAL choros_app (NOBYPASSRLS) role — the production RLS
// path, not a query-filter shim — that GET /api/processes/:id's `variables` /
// `history` / `completedBy*` are gated by the READ-visibility of the
// instance's SOURCE RECORD, mirroring T-0570's records-read-pdp.db.test.ts:
//
//   FF-INST-VIS-1a: an actor with ZERO covering READ grant on the source
//     record gets 404 on DETAIL (fail-closed), even though the instance
//     exists and is tenant-scoped-visible on LIST.
//
//   FF-INST-VIS-1b: an actor WITH a covering READ grant (default-open
//     RESOURCE_ROOT grant — the SAME migration-117 shape) sees the DETAIL,
//     including variables/history.
//
//   Owner parity: the tenant-owner employee (seeded with the SAME
//     role-reader + RESOURCE_ROOT grant migration 117 gives every real
//     tenant) sees the DETAIL — NOT via a bespoke isGenesisOwnerForTenant
//     branch (there isn't one, mirroring records.ts), but via the SAME
//     single grant-resolver path every other actor goes through.
//
//   Record-less fallback (T-0714 §5 phase-1 scope): an instance started
//     WITHOUT a recordId (no create=start binding) stays visible to an
//     actor with ZERO grants — this gate does not narrow it (deferred to a
//     phase-3 follow-up).
//
//   Honest-degrade (NF-2): a server registered WITHOUT resolveReadVisibility
//     wired serves the SAME DETAIL to every tenant member as pre-T-0721
//     (byte-identical to today's production posture before this resolver is
//     deployed).
//
//   Tenant isolation (NF-3): an actor of tenant A can never resolve tenant
//     B's instance id (RLS + the explicit tenant-scoped projection fold
//     remain the FIRST, unconditional gate — this PDP predicate is additive
//     on top, never a replacement).
//
// resolveReadVisibility here mirrors the PRODUCTION wiring in server.ts
// (registerProcessesRoutes's deps object): getGrantsForSubject (real DAO,
// real SQL) + makeResourceAncestryOracle over loadTenantOrgAncestry (real
// per-tenant org tree, empty rowIndex) — the SAME composition records.ts's
// resolver uses, not a stub PDP (FF-INST-VIS-2, single-resolver).
//
// Seeding goes through migratorUrl() (BYPASSRLS); the route calls run
// through a choros_app Pool (RLS-enforced) so SET LOCAL choros.tenant_id
// scoping is the real production path. Fresh per-run tenant UUIDs (never the
// shared TENANT_A/TENANT_B from _helpers.ts) keep rows off other suites'
// fixtures (memory: choros-ci-db-gotchas).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerProcessesRoutes } from '../../../src/http/processes.js';
import type { StartInstanceDeps, ProcessReadVisibilityResolver } from '../../../src/http/process-start.js';
import { appendProcessStarted } from '../../../src/http/process-projection.js';
import { getGrantsForSubject } from '../../../src/db/grants-dao.js';
import { loadTenantOrgAncestry } from '../../../src/db/org-ancestry.js';
import { makeResourceAncestryOracle } from '../../../src/db/resource-ancestry.js';
import { RESOURCE_ROOT_NODE_ID, type RowAncestry } from '../../../src/core/read-visibility.js';

const { Client } = pg;

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

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', title: 'Name' } },
  required: ['name'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Seed helpers (migrator role; SET LOCAL tenant for the RLS WITH CHECK).
// Mirrors ci/checks/db/records-read-pdp.db.test.ts's seed helpers (T-0570) —
// same shapes, reused for the SAME tables, not a bespoke fixture format.
// ---------------------------------------------------------------------------

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
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
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
    [tenantId, id, appId, slug, JSON.stringify(SCHEMA)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecord(c: pg.Client, tenantId: string, registryId: string, name: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, 'seed')`,
    [tenantId, id, registryId, JSON.stringify({ name })],
  );
  await c.query('COMMIT');
  return id;
}

async function seedEmployee(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $3, 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRole(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedAssignment(c: pg.Client, tenantId: string, empId: string, roleId: string): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope, granted_by, confirmed_by, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'seed', 'seed', 'seed', 0, 0)`,
    [tenantId, uuid(), empId, roleId, JSON.stringify({ kind: 'set', members: [] })],
  );
  await c.query('COMMIT');
}

/** scope = RESOURCE_ROOT sentinel (the default-open grant, migration-117 shape). */
function rootScope(): unknown {
  return { kind: 'node', hierarchy: 'resource', nodeLevel: 'application', nodeId: RESOURCE_ROOT_NODE_ID };
}

/**
 * T-0722: scope = ONE specific record's own resource-node (self-match rule 1
 * of makeResourceAncestryOracle — works regardless of the empty rowIndex the
 * production wiring uses, since self-identity needs no ancestry-map lookup).
 * Lets a test grant READ on exactly ONE record, not the whole tenant — used
 * by the "mixed visibility" LIST test to prove the response excludes a
 * SPECIFIC other record's instance while keeping the granted one.
 */
function recordScope(recordId: string): unknown {
  return { kind: 'node', hierarchy: 'resource', nodeLevel: 'record', nodeId: recordId };
}

async function seedReadGrant(c: pg.Client, tenantId: string, roleId: string, scope: unknown): Promise<void> {
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
        "constraint", delegable, granted_by, proposed_by, confirmed_by,
        valid_from, valid_until, created_at)
     VALUES ($1, $2, $3, 'record', NULL, 'read', $4::jsonb,
             NULL, true, 'seed', NULL, 'seed', NULL, NULL, 0)`,
    [tenantId, uuid(), roleId, JSON.stringify(scope)],
  );
  await c.query('COMMIT');
}

/** Give `actorSlug` the SAME role-reader + RESOURCE_ROOT grant shape migration
 * 117 backfills for every real tenant's owner/assistant-agent — the ONLY
 * mechanism records.ts's READ-PDP (and now this DETAIL gate) uses to grant
 * default-open visibility. No bespoke "owner bypass" exists on either route. */
async function seedDefaultOpenReader(c: pg.Client, tenantId: string, actorSlug: string): Promise<void> {
  const empId = await seedEmployee(c, tenantId, actorSlug);
  const roleId = await seedRole(c, tenantId, `role-reader-${uuid().slice(0, 8)}`);
  await seedAssignment(c, tenantId, empId, roleId);
  await seedReadGrant(c, tenantId, roleId, rootScope());
}

async function withTenantTx<T>(tenantId: string, fn: (tx: pg.Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query('SET LOCAL search_path TO choros');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------------------
// The production-shaped resolveReadVisibility (mirrors server.ts wiring).
// ---------------------------------------------------------------------------

function makeProdShapedResolver(pool: pg.Pool): ProcessReadVisibilityResolver {
  return async (actorSlug: string, tenantId: string, nowMs: number) => {
    const [grants, orgOracle] = await Promise.all([
      getGrantsForSubject(pool, tenantId, actorSlug, nowMs),
      loadTenantOrgAncestry(pool, tenantId),
    ]);
    return {
      grants,
      ancestry: makeResourceAncestryOracle(orgOracle, new Map<string, RowAncestry>()),
    };
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function getInstanceDetail(
  baseUrl: string,
  instanceId: string,
  actor: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/processes/${instanceId}`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** T-0722: GET /api/processes (LIST) helper — mirrors getInstanceDetail.
 *  T-0654 [rebase]: also returns `total` (the T-0654 pagination count field) so the
 *  composition test can assert it is POST-PDP (= |visible ∩ query|), never the tenant
 *  count. Existing T-0722 callers destructure only {statusCode, instances} — additive. */
function getInstanceList(
  baseUrl: string,
  actor: string,
  query = '',
): Promise<{ statusCode: number; instances: Array<Record<string, unknown>>; total: number }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/processes${query}`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        const body = JSON.parse(raw) as { instances?: Array<Record<string, unknown>>; total?: number };
        resolve({ statusCode: res.statusCode ?? 0, instances: body.instances ?? [], total: body.total ?? 0 });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server fixtures — one server WITHOUT resolveReadVisibility (pre-gate,
// honest-degrade) and one WITH it (post-gate, production-shaped resolver).
// A bare FlowableClient stub is enough: the gate decides visibility BEFORE
// fetchInstanceHistoryDetail ever calls the engine (variables/history simply
// degrade to [] / historyAvailable:false — proven separately by T-0609's
// own unit suite; this file's concern is 200-vs-404, not engine wiring).
// ---------------------------------------------------------------------------

let appPool: pg.Pool;
let serverPreGate: http.Server;
let serverPostGate: http.Server;
let basePreGate = '';
let basePostGate = '';

let TENANT_A: string;
let TENANT_B: string;

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug.startsWith('a-')) return TENANT_A;
  if (slug.startsWith('b-')) return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

async function startServer(withGate: boolean): Promise<{ server: http.Server; baseUrl: string }> {
  const router = new Router();
  const deps: StartInstanceDeps = {
    pool: appPool,
    flowable: {} as unknown as StartInstanceDeps['flowable'],
    resolveActorTenant: stubResolveActorTenant,
    ...(withGate ? { resolveReadVisibility: makeProdShapedResolver(appPool) } : {}),
  };
  registerProcessesRoutes(router, undefined, deps);
  const srv = http.createServer((req, res) => router.dispatch(req, res));
  const baseUrl = await new Promise<string>((resolve) => {
    srv.listen(0, 'localhost', () => {
      const addr = srv.address();
      resolve(addr && typeof addr !== 'string' ? `http://localhost:${addr.port}` : '');
    });
  });
  return { server: srv, baseUrl };
}

// Fixtures.
let appAId = '';
let regAId = '';
let recordAId = '';
// T-0722: a SECOND record in TENANT_A (same registry) — used by the LIST
// "mixed visibility" test (a narrow, record-scoped grant on recordAId only
// must exclude the recordAId2-bound instance from LIST while keeping the
// recordAId-bound one).
let recordAId2 = '';
let appBId = '';
let regBId = '';
let recordBId = '';

beforeAll(
  requireDb(async () => {
    TENANT_A = uuid();
    TENANT_B = uuid();
    appPool = new pg.Pool({ connectionString: appUrl() });

    const pre = await startServer(false);
    serverPreGate = pre.server;
    basePreGate = pre.baseUrl;
    const post = await startServer(true);
    serverPostGate = post.server;
    basePostGate = post.baseUrl;

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, TENANT_A);
      await seedTenantRow(c, TENANT_B);

      appAId = await seedApp(c, TENANT_A, `piv-app-a-${uuid().slice(0, 8)}`);
      regAId = await seedRegDef(c, TENANT_A, appAId, `piv-reg-a-${uuid().slice(0, 8)}`);
      recordAId = await seedRecord(c, TENANT_A, regAId, 'source-record-a');
      recordAId2 = await seedRecord(c, TENANT_A, regAId, 'source-record-a2');

      appBId = await seedApp(c, TENANT_B, `piv-app-b-${uuid().slice(0, 8)}`);
      regBId = await seedRegDef(c, TENANT_B, appBId, `piv-reg-b-${uuid().slice(0, 8)}`);
      recordBId = await seedRecord(c, TENANT_B, regBId, 'source-record-b');
    });
  }),
);

afterAll(
  requireDb(async () => {
    await new Promise<void>((resolve) => serverPreGate?.close(() => resolve()));
    await new Promise<void>((resolve) => serverPostGate?.close(() => resolve()));

    await withClient(migratorUrl(), async (c) => {
      for (const t of [TENANT_A, TENANT_B]) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
        await c.query(`SET LOCAL choros.promoting = '1'`);
        // choros.audit_event / audit_head are append-only (no DELETE) — this
        // suite runs against a T-0147 per-run cloned test DB that is dropped
        // wholesale after the file completes, so those rows never leak into
        // another suite's fixtures anyway.
        await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.record WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.application WHERE tenant_id = $1`, [t]);
        await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [t]);
        await c.query('COMMIT');
      }
      await c.query(`DELETE FROM choros.tenant WHERE id = ANY($1::uuid[])`, [[TENANT_A, TENANT_B]]);
    });
    await appPool?.end();
  }),
);

// ---------------------------------------------------------------------------
// FF-INST-VIS-1a: fail-closed — actor with ZERO covering READ grant on the
// source record gets 404 on DETAIL.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0721 FF-INST-VIS-1a: actor without READ on the source record is denied DETAIL', () => {
  it('404 on GET /api/processes/:id even though the instance exists (tenant-scoped, no covering grant)', async () => {
    const instanceId = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        recordId: recordAId,
      }),
    );

    const detail = await getInstanceDetail(basePostGate, instanceId, 'a-nogrant-actor');
    expect(detail.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// FF-INST-VIS-1b: actor WITH a covering READ grant sees DETAIL.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0721 FF-INST-VIS-1b: actor WITH READ on the source record sees DETAIL', () => {
  it('200 on GET /api/processes/:id with variables/history present (engine-degraded but not denied)', async () => {
    const instanceId = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        recordId: recordAId,
      }),
    );

    await withClient(migratorUrl(), async (c) => {
      await seedDefaultOpenReader(c, TENANT_A, 'a-reader-actor');
    });

    const detail = await getInstanceDetail(basePostGate, instanceId, 'a-reader-actor');
    expect(detail.statusCode).toBe(200);
    expect(detail.body['id']).toBe(instanceId);
    expect(Array.isArray(detail.body['variables'])).toBe(true);
    expect(Array.isArray(detail.body['history'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Owner parity: the SAME role-reader + RESOURCE_ROOT grant shape migration
// 117 gives every tenant-owner also grants DETAIL visibility here — no
// bespoke isGenesisOwnerForTenant branch, single grant-resolver path.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0721: tenant-owner (via the standard default-open grant) sees DETAIL', () => {
  it('200 for an employee holding the tenant-owner role + the migration-117-shaped role-reader grant', async () => {
    const instanceId = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        recordId: recordAId,
      }),
    );

    await withClient(migratorUrl(), async (c) => {
      const ownerId = await seedEmployee(c, TENANT_A, 'a-owner-actor');
      const ownerRoleId = await seedRole(c, TENANT_A, `tenant-owner-${uuid().slice(0, 8)}`);
      await seedAssignment(c, TENANT_A, ownerId, ownerRoleId);
      // The migration-117 default-open grant (role-reader), assigned to the
      // SAME owner employee — mirrors migration 117 blocks A/B/D exactly.
      const readerRoleId = await seedRole(c, TENANT_A, `role-reader-owner-${uuid().slice(0, 8)}`);
      await seedAssignment(c, TENANT_A, ownerId, readerRoleId);
      await seedReadGrant(c, TENANT_A, readerRoleId, rootScope());
    });

    const detail = await getInstanceDetail(basePostGate, instanceId, 'a-owner-actor');
    expect(detail.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Record-less fallback (T-0714 §5 phase-1 scope): an instance started WITHOUT
// a recordId is NOT narrowed by this gate — visible to ANY tenant member,
// even one with zero grants.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0721: record-less instance stays tenant-default-open (phase-1 scope)', () => {
  it('200 for an actor with ZERO grants when the instance carries no recordId', async () => {
    const instanceId = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        // no recordId — explicit-launch instance.
      }),
    );

    const detail = await getInstanceDetail(basePostGate, instanceId, 'a-zero-grant-actor-2');
    expect(detail.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Honest-degrade (NF-2): resolveReadVisibility absent ⇒ DETAIL unchanged from
// pre-T-0721 (every tenant member sees it, regardless of grants).
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0721: honest-degrade when resolveReadVisibility is not wired', () => {
  it('200 on the pre-gate server even for an actor with zero grants on a record-bound instance', async () => {
    const instanceId = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        recordId: recordAId,
      }),
    );

    const detail = await getInstanceDetail(basePreGate, instanceId, 'a-degrade-actor');
    expect(detail.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (NF-3): the PDP gate is additive, never a substitute for
// the tenant-scoped projection fold.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0721: tenant isolation is not weakened by the DETAIL read-visibility gate', () => {
  it('a tenant-A actor (even a default-open reader) never resolves a tenant-B instance id', async () => {
    const instanceIdB = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_B, (tx) =>
      appendProcessStarted(tx, {
        instanceId: instanceIdB,
        procKey: 'telLinear',
        actor: 'b-starter',
        nowMs: Date.now(),
        recordId: recordBId,
      }),
    );

    await withClient(migratorUrl(), async (c) => {
      await seedDefaultOpenReader(c, TENANT_A, 'a-wide-reader-crosscheck');
    });

    const detail = await getInstanceDetail(basePostGate, instanceIdB, 'a-wide-reader-crosscheck');
    expect(detail.statusCode).toBe(404);
  });
});

// =============================================================================
// T-0722 (D-064, P2 из T-0714 — security/PDP) · GET /api/processes LIST
// read-visibility filter — LIVE Postgres probe. Mirrors the DETAIL suite
// above (T-0721) exactly, adapted for LIST semantics: a denied instance is
// EXCLUDED from `instances[]` (honest-narrow) rather than 404ing on its own
// dedicated route.
//
//   FF-INST-VIS list-a: an actor with ZERO covering READ grant on the source
//     record does NOT see that instance in LIST (fail-closed), even though
//     it is tenant-scoped-visible under the pre-T-0722 posture.
//   FF-INST-VIS list-b: an actor WITH a covering READ grant sees it in LIST.
//   Record-less fallback: an instance started WITHOUT a recordId stays in
//     LIST for a zero-grant actor (phase-1/2 scope, symmetric to DETAIL).
//   Mixed visibility / count correctness (T-0722 spec §4.1 (b)): an actor
//     holding a NARROW grant scoped to exactly ONE record sees ONLY that
//     record's instance in LIST — `instances.length` reflects the FILTERED
//     set, not the tenant's full instance count.
//   Tenant isolation (FF-INST-VIS-4): a tenant-A actor with a WIDE grant
//     never sees a tenant-B instance in LIST.
//   Honest-degrade (NF-2): the pre-gate server serves LIST unchanged
//     (byte-identical to pre-T-0722) regardless of grants.
// =============================================================================

describe.skipIf(!hasDb)('T-0722 FF-INST-VIS list-a: actor without READ on the source record does not see it in LIST', () => {
  it('the record-bound instance is ABSENT from instances[] (tenant-scoped, no covering grant)', async () => {
    const instanceId = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        recordId: recordAId,
      }),
    );

    const list = await getInstanceList(basePostGate, 'a-nogrant-list-actor');
    expect(list.statusCode).toBe(200);
    expect(list.instances.some((i) => i['id'] === instanceId)).toBe(false);
  });
});

describe.skipIf(!hasDb)('T-0722 FF-INST-VIS list-b: actor WITH READ on the source record sees it in LIST', () => {
  it('the record-bound instance IS present in instances[]', async () => {
    const instanceId = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        recordId: recordAId,
      }),
    );

    await withClient(migratorUrl(), async (c) => {
      await seedDefaultOpenReader(c, TENANT_A, 'a-reader-list-actor');
    });

    const list = await getInstanceList(basePostGate, 'a-reader-list-actor');
    expect(list.statusCode).toBe(200);
    expect(list.instances.some((i) => i['id'] === instanceId)).toBe(true);
  });
});

describe.skipIf(!hasDb)('T-0722: record-less instance stays in LIST for a zero-grant actor (phase-1/2 scope)', () => {
  it('the record-less instance IS present in instances[] even with zero grants', async () => {
    const instanceId = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        // no recordId — explicit-launch instance.
      }),
    );

    const list = await getInstanceList(basePostGate, 'a-zero-grant-list-actor');
    expect(list.statusCode).toBe(200);
    expect(list.instances.some((i) => i['id'] === instanceId)).toBe(true);
  });
});

describe.skipIf(!hasDb)('T-0722: mixed visibility — LIST count reflects ONLY the visible instances (spec §4.1 (b))', () => {
  it('a narrow (single-record-scoped) grant sees ONLY that record\'s instance, not a sibling record\'s instance in the same tenant', async () => {
    const instanceGranted = `flw-piv-${uuid().slice(0, 8)}`;
    const instanceDenied = `flw-piv-${uuid().slice(0, 8)}`;

    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId: instanceGranted,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        recordId: recordAId,
      }),
    );
    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId: instanceDenied,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        recordId: recordAId2,
      }),
    );

    // A grant scoped to recordAId ONLY (self-match rule, no RESOURCE_ROOT, no
    // registry/application-level rule 3 needed — see recordScope() doc-comment).
    await withClient(migratorUrl(), async (c) => {
      const empId = await seedEmployee(c, TENANT_A, 'a-narrow-reader-actor');
      const roleId = await seedRole(c, TENANT_A, `role-narrow-reader-${uuid().slice(0, 8)}`);
      await seedAssignment(c, TENANT_A, empId, roleId);
      await seedReadGrant(c, TENANT_A, roleId, recordScope(recordAId));
    });

    const list = await getInstanceList(basePostGate, 'a-narrow-reader-actor');
    expect(list.statusCode).toBe(200);
    const ids = list.instances.map((i) => i['id']);
    expect(ids).toContain(instanceGranted);
    expect(ids).not.toContain(instanceDenied);
  });
});

describe.skipIf(!hasDb)('T-0722: tenant isolation is not weakened by the LIST read-visibility filter', () => {
  it('a tenant-A actor (even a default-open reader) never sees a tenant-B instance in LIST', async () => {
    const instanceIdB = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_B, (tx) =>
      appendProcessStarted(tx, {
        instanceId: instanceIdB,
        procKey: 'telLinear',
        actor: 'b-starter',
        nowMs: Date.now(),
        recordId: recordBId,
      }),
    );

    await withClient(migratorUrl(), async (c) => {
      await seedDefaultOpenReader(c, TENANT_A, 'a-wide-reader-list-crosscheck');
    });

    const list = await getInstanceList(basePostGate, 'a-wide-reader-list-crosscheck');
    expect(list.statusCode).toBe(200);
    expect(list.instances.some((i) => i['id'] === instanceIdB)).toBe(false);
  });
});

describe.skipIf(!hasDb)('T-0722: honest-degrade when resolveReadVisibility is not wired — LIST unchanged', () => {
  it('the pre-gate server serves the record-bound instance in LIST even for a zero-grant actor', async () => {
    const instanceId = `flw-piv-${uuid().slice(0, 8)}`;
    await withTenantTx(TENANT_A, (tx) =>
      appendProcessStarted(tx, {
        instanceId,
        procKey: 'telLinear',
        actor: 'a-starter',
        nowMs: Date.now(),
        recordId: recordAId,
      }),
    );

    const list = await getInstanceList(basePreGate, 'a-degrade-list-actor');
    expect(list.statusCode).toBe(200);
    expect(list.instances.some((i) => i['id'] === instanceId)).toBe(true);
  });
});

// =============================================================================
// T-0654 [rebase+recompose] · GET /api/processes LIST `total` is POST-PDP — the
// pagination count field this task ADDED must NOT re-open the enumeration
// side-channel T-0722 closed. The composition rule under test: the T-0722
// READ-visibility filter runs BEFORE the T-0654 query pipeline, so
// {total} = |PDP-visible ∩ query-match|, NOT the raw tenant instance count.
//
// Method (hermetic to the shared-TENANT_A instance accumulation above): seed a
// FRESH record with TWO instances, grant a "seer" a NARROW grant scoped to that
// record ONLY, and give a "blind" actor ZERO grant on it. Both actors see the
// SAME record-less / otherwise-visible instances from the tests above, so those
// CANCEL in the delta — the ONLY difference between them is the two new
// record-bound instances. Therefore:
//   - the seer's `total` counts the two hidden-to-blind instances,
//   - the blind actor's `total` does NOT (delta === 2, exactly the visible-only set),
//   - and for BOTH, total === instances.length (post-PDP total, no leaked count).
// =============================================================================

describe.skipIf(!hasDb)('T-0654: LIST `total` is post-PDP — a hidden instance never inflates total (enumeration stays closed)', () => {
  it('seer total counts the record-scoped instances; blind total excludes them; total === instances.length for both', async () => {
    // A fresh record unique to THIS test (no prior test seeded instances on it).
    const secretRecord = await withClient(migratorUrl(), (c) =>
      seedRecord(c, TENANT_A, regAId, 'source-record-secret-t0654'),
    );
    const instX1 = `flw-piv-${uuid().slice(0, 8)}`;
    const instX2 = `flw-piv-${uuid().slice(0, 8)}`;
    for (const instanceId of [instX1, instX2]) {
      await withTenantTx(TENANT_A, (tx) =>
        appendProcessStarted(tx, {
          instanceId,
          procKey: 'telLinear',
          actor: 'a-starter',
          nowMs: Date.now(),
          recordId: secretRecord,
        }),
      );
    }

    // SEER: a NARROW grant scoped to secretRecord ONLY (self-match rule) — sees the
    // two instances above PLUS whatever record-less/other instances any tenant member
    // sees. BLIND: zero grant on secretRecord — sees the SAME baseline, minus those two.
    const seer = `a-seer-${uuid().slice(0, 8)}`;
    const blind = `a-blind-${uuid().slice(0, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      const seerEmp = await seedEmployee(c, TENANT_A, seer);
      const seerRole = await seedRole(c, TENANT_A, `role-seer-${uuid().slice(0, 8)}`);
      await seedAssignment(c, TENANT_A, seerEmp, seerRole);
      await seedReadGrant(c, TENANT_A, seerRole, recordScope(secretRecord));
      // BLIND: an employee with a role but NO grant covering secretRecord.
      const blindEmp = await seedEmployee(c, TENANT_A, blind);
      const blindRole = await seedRole(c, TENANT_A, `role-blind-${uuid().slice(0, 8)}`);
      await seedAssignment(c, TENANT_A, blindEmp, blindRole);
    });

    const seerList = await getInstanceList(basePostGate, seer);
    const blindList = await getInstanceList(basePostGate, blind);

    expect(seerList.statusCode).toBe(200);
    expect(blindList.statusCode).toBe(200);

    // (1) total is honest per side: equals the actual visible array length (no
    //     separately-computed count that could leak the invisible set).
    expect(seerList.total).toBe(seerList.instances.length);
    expect(blindList.total).toBe(blindList.instances.length);

    // (2) the two record-scoped instances are visible to the seer, hidden from blind.
    const seerIds = seerList.instances.map((i) => i['id']);
    const blindIds = blindList.instances.map((i) => i['id']);
    expect(seerIds).toContain(instX1);
    expect(seerIds).toContain(instX2);
    expect(blindIds).not.toContain(instX1);
    expect(blindIds).not.toContain(instX2);

    // (3) THE enumeration proof: the ONLY difference between the two actors' visibility
    //     is those two record-bound instances, so total(seer) - total(blind) === 2.
    //     The blind actor's `total` therefore does NOT include the invisible instances —
    //     the added pagination count cannot be used to enumerate hidden process work.
    expect(seerList.total - blindList.total).toBe(2);
  });

  it('a status filter composes AFTER the PDP narrowing — total counts only PDP-visible ∩ status', async () => {
    // Prove the query pipeline sees the ALREADY PDP-narrowed set: a status that no
    // visible instance matches yields total 0 for the seer, even though the raw tenant
    // has matching-status instances the caller cannot read.
    const seerList = await getInstanceList(basePostGate, 'a-nogrant-status-actor', '?status=done');
    expect(seerList.statusCode).toBe(200);
    // a-nogrant-status-actor has no grants → sees only record-less instances; none of
    // this suite's record-less instances are `done` (telLinear starts `waiting`).
    expect(seerList.total).toBe(seerList.instances.length);
    expect(seerList.instances.every((i) => i['status'] === 'done')).toBe(true);
  });
});
