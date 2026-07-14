// T-0756 (D-064, P1 из live-proof T-0691 — E16 §6 links) · process → «Запись-
// источник» read-through projection with per-hop ACL — LIVE Postgres probe.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
//
// THE DEFECT (T-0691 P1): the process card «ЗАПИСЬ-ИСТОЧНИК» rendered a RAW UUID
// and GET /api/records/:id 404'd for the ACTING participant (approver) — the
// person who just acted on the process could neither name nor open the record it
// is about. Two causes this proves the fix is honest to: (a) READ-PDP masking,
// and (b) the sandbox/draft gate (a draft-tier source app hides the record card
// from non-creators even when READ-PDP would allow it).
//
// THE FIX: GET /api/processes/:id gains a PARTICIPANT tier + a SAFE `sourceRecord`
// projection { id, title, typeLabel, canOpen, appId? }. A participant (holds the
// instance's task role / acted on it / owner) but WITHOUT source-record READ now
// gets 200 + the safe projection (NO variables/history) instead of the T-0721
// 404. `canOpen` is true ONLY when GET /api/records/:id would actually 200
// (READ-PDP ∧ sandbox), so the «открыть» link never dead-ends.
//
// PROVES against the REAL choros_app (NOBYPASSRLS) role — the production RLS path:
//
//   SRP-1 (RED→GREEN core — participant, no READ grant): an actor who holds the
//     instance's task role but has ZERO covering READ grant on the source record —
//     who under T-0721 (FF-INST-VIS-1a) gets a hard 404 — now gets 200 with
//     sourceRecord{canOpen:false, title:<human>} and NO variables/history.
//     Reverting the participant tier → 404 → this assertion RED.
//
//   SRP-2 (fail-closed control): a STRANGER — no role, no READ, not owner, never
//     acted — still gets 404 (the participant tier did NOT open the door to every
//     tenant member; the ONLY delta from SRP-1 is the participant relation).
//
//   SRP-3 (reader unchanged + projection): an actor WITH a default-open READ grant
//     on a PUBLISHED source app gets 200 with variables/history (T-0721 unchanged)
//     AND sourceRecord{canOpen:true, appId:<app>}.
//
//   SRP-4 (canOpen honest to the sandbox/draft gate — the exact live-proof case):
//     for a DRAFT-tier source app, a READER (has READ grant, not the creator, not
//     privileged) gets sourceRecord{canOpen:false, appId:undefined, title present};
//     the record's CREATOR gets sourceRecord{canOpen:true}.
//
//   SRP-5 (no field leak): the participant-tier body carries the title value but
//     NONE of the record's other data field values, and no variables/history keys.
//
//   SRP-6 (cross-tenant isolation): a tenant-A actor requesting a tenant-B instance
//     id → 404 (RLS + the tenant-scoped projection fold are the first gate).
//
//   SRP-7 (audit-actor participant): an actor who ACTED on the instance (appears in
//     its audit track) but has no READ grant is a participant → 200 + safe projection.
//
// D-064 anti-case: uses only GENERIC role/actor slugs (a-*/role-checker-*), never a
// business persona/case literal — the fixture case lives here, not in src/.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerProcessesRoutes } from '../../../src/http/processes.js';
import type { StartInstanceDeps, ProcessReadVisibilityResolver } from '../../../src/http/process-start.js';
import { appendProcessStarted, appendTaskApproved } from '../../../src/http/process-projection.js';
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

// A schema with a title-like key so pickTitleFieldKey picks a DESIGNATED title
// field (never an arbitrary data-order scan). `amount` sits FIRST to prove the
// projection does NOT surface it as the title (only `title`, the designated one).
const SCHEMA = {
  type: 'object',
  properties: {
    amount: { type: 'number', title: 'Amount' },
    title: { type: 'string', title: 'Title' },
    secret_note: { type: 'string', title: 'Secret' },
  },
  required: ['title'],
  additionalProperties: true,
};

const TITLE_VALUE = 'source-record-human-title';
const SECRET_VALUE = 'this-must-not-leak';

// ---------------------------------------------------------------------------
// Seed helpers (migrator role; SET LOCAL tenant for the RLS WITH CHECK).
// ---------------------------------------------------------------------------

async function seedTenantRow(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
}

async function seedApp(c: pg.Client, tenantId: string, slug: string, tier: 'published' | 'draft', displayName: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, 0, 0)`,
    [tenantId, id, slug, displayName, tier],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegDef(c: pg.Client, tenantId: string, appId: string, slug: string, displayName: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, 0, 0)`,
    [tenantId, id, appId, slug, displayName, JSON.stringify(SCHEMA)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRecord(c: pg.Client, tenantId: string, registryId: string, createdBy: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record
       (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, $5)`,
    [tenantId, id, registryId, JSON.stringify({ amount: 42, title: TITLE_VALUE, secret_note: SECRET_VALUE }), createdBy],
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

function rootScope(): unknown {
  return { kind: 'node', hierarchy: 'resource', nodeLevel: 'application', nodeId: RESOURCE_ROOT_NODE_ID };
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

/** default-open reader (role-reader + RESOURCE_ROOT grant, migration-117 shape). */
async function seedDefaultOpenReader(c: pg.Client, tenantId: string, actorSlug: string): Promise<void> {
  const empId = await seedEmployee(c, tenantId, actorSlug);
  const roleId = await seedRole(c, tenantId, `role-reader-${uuid().slice(0, 8)}`);
  await seedAssignment(c, tenantId, empId, roleId);
  await seedReadGrant(c, tenantId, roleId, rootScope());
}

/** an actor holding ONLY the generic `roleSlug` — a participant-by-role, NO READ grant. */
async function seedRoleHolder(c: pg.Client, tenantId: string, actorSlug: string, roleSlug: string): Promise<void> {
  const empId = await seedEmployee(c, tenantId, actorSlug);
  const roleId = await seedRole(c, tenantId, roleSlug);
  await seedAssignment(c, tenantId, empId, roleId);
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

function makeProdShapedResolver(pool: pg.Pool): ProcessReadVisibilityResolver {
  return async (actorSlug: string, tenantId: string, nowMs: number) => {
    const [grants, orgOracle] = await Promise.all([
      getGrantsForSubject(pool, tenantId, actorSlug, nowMs),
      loadTenantOrgAncestry(pool, tenantId),
    ]);
    return { grants, ancestry: makeResourceAncestryOracle(orgOracle, new Map<string, RowAncestry>()) };
  };
}

interface SourceRecordShape {
  id: string;
  title: string;
  typeLabel: string;
  canOpen: boolean;
  appId?: string;
}

function getInstanceDetail(
  baseUrl: string,
  instanceId: string,
  actor: string,
): Promise<{ statusCode: number; body: Record<string, unknown>; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/processes/${instanceId}`);
    const req = http.request(url, { method: 'GET', headers: { 'x-dev-user': actor } }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* non-JSON */ }
        resolve({ statusCode: res.statusCode ?? 0, body, raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server fixture (production-shaped resolver wired — the postGate case).
// ---------------------------------------------------------------------------

let appPool: pg.Pool;
let server: http.Server;
let baseUrl = '';
let TENANT_A: string;
let TENANT_B: string;

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug.startsWith('a-')) return TENANT_A;
  if (slug.startsWith('b-')) return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

async function startServer(): Promise<{ server: http.Server; baseUrl: string }> {
  const router = new Router();
  const deps: StartInstanceDeps = {
    pool: appPool,
    flowable: {} as unknown as StartInstanceDeps['flowable'],
    resolveActorTenant: stubResolveActorTenant,
    resolveReadVisibility: makeProdShapedResolver(appPool),
  };
  registerProcessesRoutes(router, undefined, deps);
  const srv = http.createServer((req, res) => router.dispatch(req, res));
  const url = await new Promise<string>((resolve) => {
    srv.listen(0, 'localhost', () => {
      const addr = srv.address();
      resolve(addr && typeof addr !== 'string' ? `http://localhost:${addr.port}` : '');
    });
  });
  return { server: srv, baseUrl: url };
}

// Fixtures.
let pubRegA = '';
let pubRecordA = '';       // published-app source record
let draftRecordA = '';     // draft-app source record (created by a-creator)
let CHECK_ROLE = '';       // the generic task role of the seeded instances

async function startInstance(tenantId: string, recordId: string): Promise<string> {
  const instanceId = `flw-t0756-${uuid().slice(0, 12)}`;
  await withTenantTx(tenantId, (tx) =>
    appendProcessStarted(tx, {
      instanceId,
      procKey: 'proc-under-test',
      actor: 'a-starter',
      nowMs: Date.now(),
      approverRole: CHECK_ROLE, // GENERIC role — never a case persona (D-064)
      recordId,
    }),
  );
  return instanceId;
}

beforeAll(
  requireDb(async () => {
    TENANT_A = uuid();
    TENANT_B = uuid();
    CHECK_ROLE = `role-checker-${uuid().slice(0, 8)}`;
    appPool = new pg.Pool({ connectionString: appUrl() });

    const s = await startServer();
    server = s.server;
    baseUrl = s.baseUrl;

    await withClient(migratorUrl(), async (c) => {
      await seedTenantRow(c, TENANT_A);
      await seedTenantRow(c, TENANT_B);

      const pubApp = await seedApp(c, TENANT_A, `t0756-pub-${uuid().slice(0, 8)}`, 'published', 'Заявки');
      pubRegA = await seedRegDef(c, TENANT_A, pubApp, `t0756-reg-${uuid().slice(0, 8)}`, 'Заявка');
      pubRecordA = await seedRecord(c, TENANT_A, pubRegA, 'a-creator');

      const draftApp = await seedApp(c, TENANT_A, `t0756-draft-${uuid().slice(0, 8)}`, 'draft', 'Черновик-приложение');
      const draftReg = await seedRegDef(c, TENANT_A, draftApp, `t0756-dreg-${uuid().slice(0, 8)}`, 'Заявка');
      draftRecordA = await seedRecord(c, TENANT_A, draftReg, 'a-creator');

      // Participant-by-role: holds CHECK_ROLE, NO READ grant.
      await seedRoleHolder(c, TENANT_A, 'a-participant', CHECK_ROLE);
      // Reader: default-open READ grant (sees full detail + canOpen on published).
      await seedDefaultOpenReader(c, TENANT_A, 'a-reader');
      // Draft reader: default-open READ grant, but NOT the draft record's creator.
      await seedDefaultOpenReader(c, TENANT_A, 'a-draft-reader');
      // Creator of the draft record (also a reader so READ-PDP passes).
      await seedDefaultOpenReader(c, TENANT_A, 'a-creator');
      // Stranger: exists but no role, no READ, not owner (a-stranger → TENANT_A).
      await seedEmployee(c, TENANT_A, 'a-stranger');
      // Audit-actor participant: no role, no READ — becomes a participant by ACTING.
      await seedEmployee(c, TENANT_A, 'a-actor');
    });
  }),
);

afterAll(
  requireDb(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await withClient(migratorUrl(), async (c) => {
      for (const t of [TENANT_A, TENANT_B]) {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
        await c.query(`SET LOCAL choros.promoting = '1'`);
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
// SRP-1 (RED→GREEN core): participant (role-holder, no READ) → 200 + safe projection.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0756 SRP-1: participant without READ sees the safe projection (was 404)', () => {
  it('200 + sourceRecord{canOpen:false, title} + NO variables/history for a task-role holder', async () => {
    const instanceId = await startInstance(TENANT_A, pubRecordA);
    const res = await getInstanceDetail(baseUrl, instanceId, 'a-participant');

    expect(res.statusCode).toBe(200); // T-0721 gave 404 here — the participant tier is the delta
    const sr = res.body['sourceRecord'] as SourceRecordShape | undefined;
    expect(sr).toBeTruthy();
    expect(sr!.id).toBe(pubRecordA);
    expect(sr!.title).toBe(TITLE_VALUE);   // human title, NOT the raw UUID
    expect(sr!.canOpen).toBe(false);        // no READ grant → no open affordance
    expect(sr!.appId).toBeUndefined();      // appId only when canOpen
    // Reader-only fields MUST be withheld from a participant who cannot READ.
    expect('variables' in res.body).toBe(false);
    expect('history' in res.body).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SRP-2 (fail-closed control): stranger (no role, no READ, not owner) → 404.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0756 SRP-2: non-participant, non-reader stays 404 (fail-closed)', () => {
  it('404 for a tenant member who never acted and holds neither the role nor a READ grant', async () => {
    const instanceId = await startInstance(TENANT_A, pubRecordA);
    const res = await getInstanceDetail(baseUrl, instanceId, 'a-stranger');
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// SRP-3 (reader unchanged + projection): READ grant, published app → full detail
// + canOpen:true.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0756 SRP-3: reader keeps full detail (T-0721) and gets canOpen:true', () => {
  it('200 with variables/history AND sourceRecord{canOpen:true, appId}', async () => {
    const instanceId = await startInstance(TENANT_A, pubRecordA);
    const res = await getInstanceDetail(baseUrl, instanceId, 'a-reader');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body['variables'])).toBe(true);
    expect(Array.isArray(res.body['history'])).toBe(true);
    const sr = res.body['sourceRecord'] as SourceRecordShape | undefined;
    expect(sr).toBeTruthy();
    expect(sr!.title).toBe(TITLE_VALUE);
    expect(sr!.canOpen).toBe(true);
    expect(typeof sr!.appId).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// SRP-4 (canOpen honest to sandbox/draft — the live-proof case): draft app +
// reader-not-creator → canOpen:false; creator → canOpen:true.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0756 SRP-4: canOpen respects the sandbox/draft gate', () => {
  it('draft-app source: a READER who is not the creator gets canOpen:false but the title', async () => {
    const instanceId = await startInstance(TENANT_A, draftRecordA);
    const res = await getInstanceDetail(baseUrl, instanceId, 'a-draft-reader');
    expect(res.statusCode).toBe(200); // reader passes the T-0721 detail gate
    const sr = res.body['sourceRecord'] as SourceRecordShape | undefined;
    expect(sr).toBeTruthy();
    expect(sr!.title).toBe(TITLE_VALUE);
    expect(sr!.canOpen).toBe(false);   // draft + non-creator + non-privileged → record card 404s
    expect(sr!.appId).toBeUndefined();
  });

  it('draft-app source: the record CREATOR gets canOpen:true (creator-escape)', async () => {
    const instanceId = await startInstance(TENANT_A, draftRecordA);
    const res = await getInstanceDetail(baseUrl, instanceId, 'a-creator');
    expect(res.statusCode).toBe(200);
    const sr = res.body['sourceRecord'] as SourceRecordShape | undefined;
    expect(sr).toBeTruthy();
    expect(sr!.canOpen).toBe(true);
    expect(typeof sr!.appId).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// SRP-5 (no field leak): participant body has the title but NOT the secret field.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0756 SRP-5: the safe projection leaks no record fields', () => {
  it('participant body contains the title but never the record\'s other data values', async () => {
    const instanceId = await startInstance(TENANT_A, pubRecordA);
    const res = await getInstanceDetail(baseUrl, instanceId, 'a-participant');
    expect(res.statusCode).toBe(200);
    expect(res.raw).toContain(TITLE_VALUE);          // the designated title IS shown
    expect(res.raw).not.toContain(SECRET_VALUE);     // no other field value leaks
    expect(res.raw).not.toContain('"variables"');
    expect(res.raw).not.toContain('"history"');
  });
});

// ---------------------------------------------------------------------------
// SRP-6 (cross-tenant isolation): tenant-A actor → tenant-B instance id → 404.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0756 SRP-6: cross-tenant isolation untouched', () => {
  it('a tenant-A instance id is 404 for a tenant-B actor (RLS + tenant-scoped fold first)', async () => {
    const instanceId = await startInstance(TENANT_A, pubRecordA);
    const res = await getInstanceDetail(baseUrl, instanceId, 'b-someone');
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// SRP-7 (audit-actor participant): acted on the instance (no role, no READ) → 200.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0756 SRP-7: an actor who ACTED on the instance is a participant', () => {
  it('200 + safe projection for an actor recorded in the instance audit track, no READ grant', async () => {
    const instanceId = await startInstance(TENANT_A, pubRecordA);
    // a-actor completes a step on THIS instance → appears as an audit actor.
    await withTenantTx(TENANT_A, (tx) =>
      appendTaskApproved(tx, {
        taskId: uuid(),
        instanceId,
        procKey: 'proc-under-test',
        actor: 'a-actor',
        nowMs: Date.now(),
        tenantId: TENANT_A,
      }),
    );
    const res = await getInstanceDetail(baseUrl, instanceId, 'a-actor');
    expect(res.statusCode).toBe(200);
    const sr = res.body['sourceRecord'] as SourceRecordShape | undefined;
    expect(sr).toBeTruthy();
    expect(sr!.title).toBe(TITLE_VALUE);
    expect(sr!.canOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SRP-8 (T-0759, D-064 anti-case — N1 из ревью T-0756 §1.2): a DEACTIVATED
// former audit-actor no longer resolves as a participant. Before T-0759,
// clause (1) of isInstanceParticipant read the append-only audit track only —
// a PAST action alone was enough, regardless of the actor's CURRENT
// deactivated_at state (unlike clause (2)'s role-holder check, which was
// already ACTOR_ACTIVE-gated via getRoleSlugsForActor, T-0738). A deactivated
// actor with a still-live ~300s access-JWT (T-0702) therefore still resolved
// 200 + sourceRecord{title, canOpen:false} — a title-only leak of the record
// this task closes.
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('T-0756/T-0759 SRP-8: a DEACTIVATED former audit-actor is no longer a participant', () => {
  it('RED→GREEN: 404 for a deactivated actor who genuinely acted on the instance (was 200 title-only before the fix)', async () => {
    const instanceId = await startInstance(TENANT_A, pubRecordA);
    const deactActorSlug = `a-actor-deact-${uuid().slice(0, 8)}`;
    const empId = await withClient(migratorUrl(), (c) => seedEmployee(c, TENANT_A, deactActorSlug));
    await withTenantTx(TENANT_A, (tx) =>
      appendTaskApproved(tx, {
        taskId: uuid(),
        instanceId,
        procKey: 'proc-under-test',
        actor: deactActorSlug,
        nowMs: Date.now(),
        tenantId: TENANT_A,
      }),
    );

    // Sanity: BEFORE deactivation, the SAME actor IS a participant (200 +
    // safe projection) — mirrors SRP-7 exactly, proves the 404 below is
    // caused by deactivation, not a fixture mistake.
    const before = await getInstanceDetail(baseUrl, instanceId, deactActorSlug);
    expect(before.statusCode).toBe(200);
    const beforeSr = before.body['sourceRecord'] as SourceRecordShape | undefined;
    expect(beforeSr?.title).toBe(TITLE_VALUE);

    await withClient(migratorUrl(), (c) =>
      c.query(`UPDATE choros.employee SET deactivated_at = $1 WHERE id = $2`, [Date.now(), empId]),
    );

    const after = await getInstanceDetail(baseUrl, instanceId, deactActorSlug);
    expect(after.statusCode).toBe(404);
    expect(after.raw).not.toContain(TITLE_VALUE); // no title-only leak survives
  });
});
