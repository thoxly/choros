// T-0747 (security P3, столп 4 — NB-2) · GET /api/records/:id/links per-hop
// READ-PDP — LIVE Postgres probe.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// THE LEAK (T-0739 judge finding NB-2): GET /api/records/:id/links gates the
// SOURCE record (T-0739) but the LINKED TARGET records were returned with their
// fields as-stored, gated ONLY by tenant RLS — so any grant-holder who could
// read the source ALSO saw the fields (and existence/id) of every linked target
// inside the tenant, even targets they held NO READ grant on. An intra-tenant
// per-record link leak.
//
// THE FIX: makeHopFetcher now applies the SAME `isRecordReadable` predicate the
// source gate uses (single resolver, NF-1). A target the caller cannot READ is
// collapsed to the SAME `not_found` denial as an absent record (FR-5) → the hop
// is redacted (no fields, no target id, no distinct reason that would leak
// existence). A target the caller CAN read still resolves fully (no over-redaction).
//
// PROVES against the REAL choros_app (NOBYPASSRLS) role:
//
//   NB2-1 (per-hop leak closed — the mutation-proof core): an actor whose ONLY
//     READ grant is scoped to the SOURCE record reads the source card (200) but
//     the linked TARGET (which they cannot READ) comes back DENIED — no fields,
//     no targetRecordId. Reverting the per-hop gate flips this hop to allowed=true
//     with the target's fields → this assertion RED.
//
//   NB2-2 (no over-redaction): an actor with the wide default-open grant reads
//     the SAME source card and the linked target resolves ALLOWED with its fields
//     + targetRecordId — the fix redacts only what the caller cannot READ.
//
//   NB2-3 (source gate intact, T-0739): an actor with ZERO covering grant gets
//     404 on /links (source-record gate unchanged — existence not leaked).
//
//   NB2-4 (honest-degrade == the pre-fix leak): the SAME source-only actor on a
//     server wired WITHOUT resolveReadVisibility sees the target fields LEAKED
//     (allowed=true) — the un-gated, pre-T-0747 behavior. This is the in-suite
//     RED baseline: the gate (resolver presence) is exactly what closes the leak.
//
//   NB2-5 (cross-tenant isolation untouched): a tenant-A actor requesting a
//     tenant-B record's /links gets 404 (RLS + explicit tenant filter remain the
//     first, unconditional gate; the per-hop PDP is additive on top).
//
// resolveReadVisibility mirrors the PRODUCTION wiring in server.ts:
// getGrantsForSubject (real DAO/SQL) + makeResourceAncestryOracle over
// loadTenantOrgAncestry — the SAME composition, not a stub PDP. Seeding goes
// through migratorUrl() (BYPASSRLS); the route runs through a choros_app Pool
// (RLS-enforced). Fresh per-test tenant UUIDs keep rows off other suites.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordLinksRoutes } from '../../../src/http/record-links.js';
import type { ReadVisibilityResolver } from '../../../src/http/records.js';
import { getGrantsForSubject } from '../../../src/db/grants-dao.js';
import { loadTenantOrgAncestry } from '../../../src/db/org-ancestry.js';
import { makeResourceAncestryOracle } from '../../../src/db/resource-ancestry.js';
import { RESOURCE_ROOT_NODE_ID, type RowAncestry } from '../../../src/core/read-visibility.js';

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

const SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    linked_id: { type: 'string', title: 'Linked' },
  },
  required: ['name'],
  additionalProperties: true,
};

const TARGET_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', title: 'Name' } },
  required: ['name'],
  additionalProperties: false,
};

const REF_FIELD = 'linked_id';

// ---------------------------------------------------------------------------
// Seed helpers (migrator role; SET LOCAL tenant for the RLS WITH CHECK).
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

async function seedRegDef(
  c: pg.Client,
  tenantId: string,
  appId: string,
  slug: string,
  schema: unknown,
): Promise<string> {
  const id = uuid();
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

async function seedRecord(
  c: pg.Client,
  tenantId: string,
  registryId: string,
  data: Record<string, unknown>,
): Promise<string> {
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

async function seedCrossAppRef(
  c: pg.Client,
  tenantId: string,
  sourceRegistryId: string,
  targetRegistryId: string,
  refField: string,
  label: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.cross_app_ref
       (tenant_id, id, source_registry_id, target_registry_id, ref_field, label,
        ref_strength, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'weak', 0, 0)`,
    [tenantId, id, sourceRegistryId, targetRegistryId, refField, label],
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

/** scope = RESOURCE_ROOT sentinel (the default-open grant — covers everything). */
function rootScope(): unknown {
  return { kind: 'node', hierarchy: 'resource', nodeLevel: 'application', nodeId: RESOURCE_ROOT_NODE_ID };
}

/** scope = a specific record node (narrow grant — self-match only). */
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

// ---------------------------------------------------------------------------
// The production-shaped resolveReadVisibility (mirrors server.ts wiring).
// ---------------------------------------------------------------------------

function makeProdShapedResolver(pool: pg.Pool): ReadVisibilityResolver {
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

interface HopShape {
  allowed: boolean;
  reason?: string;
  fields?: Record<string, unknown>;
  targetRecordId?: string;
  redactedProjection?: Record<string, unknown>;
}
interface LinkShape {
  refId: string;
  label: string;
  refField: string;
  hop: HopShape;
}

function getRecordLinks(
  baseUrl: string,
  recordId: string,
  actor: string,
): Promise<{ statusCode: number; links: LinkShape[] }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records/${recordId}/links`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        let links: LinkShape[] = [];
        try {
          const body = JSON.parse(raw) as Record<string, unknown>;
          links = (body['links'] as LinkShape[]) ?? [];
        } catch {
          /* non-JSON error body (e.g. 404) — links stays [] */
        }
        resolve({ statusCode: res.statusCode ?? 0, links });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server fixtures — one WITHOUT the resolver (pre-gate / honest-degrade, the
// pre-T-0747 leak baseline) and one WITH it (post-gate, production-shaped).
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
  registerRecordLinksRoutes(router, {
    pool: appPool,
    resolveActorTenant: stubResolveActorTenant,
    ...(withGate ? { resolveReadVisibility: makeProdShapedResolver(appPool) } : {}),
  });
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
let sourceRecId = '';
let targetRecId = '';
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

      const appA = await seedApp(c, TENANT_A, `rl-app-a-${uuid().slice(0, 8)}`);
      const srcReg = await seedRegDef(c, TENANT_A, appA, `rl-src-${uuid().slice(0, 8)}`, SOURCE_SCHEMA);
      const tgtReg = await seedRegDef(c, TENANT_A, appA, `rl-tgt-${uuid().slice(0, 8)}`, TARGET_SCHEMA);

      // Target record (the "hidden" linked record) + source record pointing at it.
      targetRecId = await seedRecord(c, TENANT_A, tgtReg, { name: 'linked-target-secret' });
      sourceRecId = await seedRecord(c, TENANT_A, srcReg, { name: 'source', [REF_FIELD]: targetRecId });

      // The cross_app_ref DEFINITION: srcReg.linked_id → tgtReg.
      await seedCrossAppRef(c, TENANT_A, srcReg, tgtReg, REF_FIELD, 'Linked App');

      // Actor 1: wide default-open grant → can read source AND target.
      const wideEmp = await seedEmployee(c, TENANT_A, 'a-wide-actor');
      const wideRole = await seedRole(c, TENANT_A, `rl-role-wide-${uuid().slice(0, 8)}`);
      await seedAssignment(c, TENANT_A, wideEmp, wideRole);
      await seedReadGrant(c, TENANT_A, wideRole, rootScope());

      // Actor 2: grant scoped to the SOURCE record ONLY → can read source, NOT target.
      const srcOnlyEmp = await seedEmployee(c, TENANT_A, 'a-source-only-actor');
      const srcOnlyRole = await seedRole(c, TENANT_A, `rl-role-srconly-${uuid().slice(0, 8)}`);
      await seedAssignment(c, TENANT_A, srcOnlyEmp, srcOnlyRole);
      await seedReadGrant(c, TENANT_A, srcOnlyRole, recordScope(sourceRecId));

      // Tenant B record (cross-tenant isolation check).
      const appB = await seedApp(c, TENANT_B, `rl-app-b-${uuid().slice(0, 8)}`);
      const regB = await seedRegDef(c, TENANT_B, appB, `rl-reg-b-${uuid().slice(0, 8)}`, TARGET_SCHEMA);
      recordBId = await seedRecord(c, TENANT_B, regB, { name: 'tenant-b-record' });
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
        await c.query(`DELETE FROM choros.cross_app_ref WHERE tenant_id = $1`, [t]);
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
// NB2-1 (mutation-proof core): source-only actor — source readable, hidden
// target REDACTED (no fields, no id). Reverting the per-hop gate → RED.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0747 NB2-1: per-hop leak closed — hidden target redacted for source-only actor', () => {
  it('reads the source card (200) but the un-readable linked target is a DENIED hop with no fields/id', async () => {
    const { statusCode, links } = await getRecordLinks(basePostGate, sourceRecId, 'a-source-only-actor');
    expect(statusCode).toBe(200); // source record IS readable by this actor
    expect(links).toHaveLength(1);

    const hop = links[0]!.hop;
    // The hidden target must be REDACTED — the leak fix.
    expect(hop.allowed).toBe(false);
    // No field VALUES leaked.
    expect(hop.fields).toBeUndefined();
    // No target record id leaked (existence not revealed).
    expect(hop.targetRecordId).toBeUndefined();
    // The denied projection carries only the DEFINITION label/refField (schema-level),
    // never the target record's id.
    expect(links[0]!.refField).toBe(REF_FIELD);
    expect(JSON.stringify(links[0]!)).not.toContain(targetRecId);
    // Collapsed to `not_found` (FR-5): indistinguishable from an absent record —
    // existence not leaked via a distinct `no_grant` reason.
    expect(hop.reason).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// NB2-2 (no over-redaction): wide actor — the readable target resolves fully.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0747 NB2-2: readable target still resolves (no over-redaction)', () => {
  it('an actor with the wide default-open grant sees the linked target ALLOWED with fields + id', async () => {
    const { statusCode, links } = await getRecordLinks(basePostGate, sourceRecId, 'a-wide-actor');
    expect(statusCode).toBe(200);
    expect(links).toHaveLength(1);

    const hop = links[0]!.hop;
    expect(hop.allowed).toBe(true);
    expect(hop.targetRecordId).toBe(targetRecId);
    expect(hop.fields).toMatchObject({ name: 'linked-target-secret' });
  });
});

// ---------------------------------------------------------------------------
// NB2-3 (source gate intact, T-0739): zero-grant actor → 404 on /links.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0747 NB2-3: source-record gate intact (T-0739)', () => {
  it('an actor with ZERO covering grant gets 404 on /links (source not readable, existence not leaked)', async () => {
    const { statusCode } = await getRecordLinks(basePostGate, sourceRecId, 'a-nogrant-actor');
    expect(statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// NB2-4 (honest-degrade == the pre-fix leak): the SAME source-only actor on a
// server WITHOUT the resolver sees the target fields LEAKED — the pre-T-0747
// baseline the fix closes (gate presence is exactly what shuts the leak).
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0747 NB2-4: pre-gate (no resolver) leaks the hidden target — the RED baseline', () => {
  it('WITHOUT resolveReadVisibility, the source-only actor sees the target fields (un-gated, pre-fix behavior)', async () => {
    const { statusCode, links } = await getRecordLinks(basePreGate, sourceRecId, 'a-source-only-actor');
    expect(statusCode).toBe(200);
    expect(links).toHaveLength(1);
    const hop = links[0]!.hop;
    // Un-gated: the target leaks — allowed with its fields. This is the exact NB-2
    // leak the post-gate server (NB2-1) closes.
    expect(hop.allowed).toBe(true);
    expect(hop.fields).toMatchObject({ name: 'linked-target-secret' });
  });
});

// ---------------------------------------------------------------------------
// NB2-5 (cross-tenant isolation untouched): tenant-A actor → tenant-B record 404.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0747 NB2-5: cross-tenant isolation untouched', () => {
  it('a tenant-A actor requesting a tenant-B record /links gets 404 (RLS first, PDP additive)', async () => {
    const { statusCode } = await getRecordLinks(basePostGate, recordBId, 'a-wide-actor');
    expect(statusCode).toBe(404);
  });
});
