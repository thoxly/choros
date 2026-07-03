// T-0606 [approval-registry-guard] — LIVE Postgres integration proofs for both
// bugs this migration/task fixes:
//
//   Part A (bug #2, phantom process spawns): getOnCreateBinding now scopes an
//   on_create binding to the registry the caller is writing into
//   (process_app_binding.trigger_registry_id, migration 122) instead of
//   matching on application_id alone. A create in a SECONDARY (non-primary)
//   registry of the same application must NOT start the process; a create in
//   the PRIMARY registry must (regression guard).
//
//   Part B (bug #1, phantom/deletable decision records): registry_def.
//   engine_managed (migration 122) marks a registry as write-protected.
//   Generic CRUD create/update/delete via POST/PUT/DELETE /api/records must
//   reject with 403 REGISTRY_ENGINE_MANAGED for such a registry, while
//   step-applier.ts's applyStepResult (a completely separate, direct DAO
//   write path that never goes through this HTTP route) continues to write
//   into the SAME engine-managed registry unaffected.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';
import { registerFormsRoutes } from '../../../src/http/forms.js';
import {
  makeFormRecordPersister,
  makeFormDefResolver,
} from '../../../src/http/form-record-persister.js';
import type { FlowableClient, StartResult } from '../../../src/core/flowable-client.js';
import { makePgAuditWriter, type PgClientLike } from '../../../src/db/audit-writer.js';
import { applyStepResult, type OutboxEnqueuePort } from '../../../src/db/step-applier.js';

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

const TENANT_ID = uuid();
const ACTOR = 'guard-actor';

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === ACTOR) return TENANT_ID;
  throw new Error(`unknown test actor: ${slug}`);
}

/** Minimal stub FlowableClient — startInstance always succeeds; nothing else is asserted on. */
function makeStubFlowable(instanceId: string): FlowableClient {
  const startResult: StartResult = { ok: true, instanceId };
  return {
    deployBpmn: async () => ({ ok: false, code: 'UNKNOWN' as const }),
    startInstance: async () => startResult,
    fetchAndLock: async () => ({ ok: false, code: 'UNKNOWN' as const }),
    completeTask: async () => ({ ok: false, code: 'UNKNOWN' as const }),
    failTask: async () => ({ ok: false, code: 'UNKNOWN' as const }),
    getFirstActiveUserTask: async () => ({ ok: true, taskId: null }),
    completeUserTask: async () => ({ ok: true }),
    getActiveUserTasks: async () => ({ ok: true, tasks: [] }),
    getMessageCatchWaits: async () => ({ ok: true, waits: [] }),
    correlateMessage: async () => ({ ok: true }),
    isInstanceEnded: async () => ({ ok: true, ended: false }),
  };
}

// DELETE /api/records/:id requires owner/admin OR authoring_draft privilege
// (resolveActorPrivilege, records.ts ~1889) — UNRELATED to the T-0606
// engine_managed guard itself, but a precondition to reach it at all. Seed
// ACTOR as a confirmed tenant-owner so the delete tests below exercise the
// engine_managed guard specifically, not this separate authz gate. Mirrors
// ci/checks/db/records_delete.db.test.ts's seedOwnerTenant pattern.
async function seedOwnerTenant(c: pg.Client, tenantId: string, ownerSlug: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t-${tenantId.slice(0, 8)}`],
  );
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, 'human', $3, $4, 0, 0) ON CONFLICT DO NOTHING`,
    [tenantId, uuid(), ownerSlug, `Owner ${ownerSlug}`],
  );
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, 'tenant-owner', 'Tenant Owner', 0, 0) ON CONFLICT DO NOTHING`,
    [tenantId, uuid()],
  );
  const roleRes = await c.query<{ id: string }>(
    `SELECT id FROM choros.role WHERE tenant_id = $1 AND slug = 'tenant-owner' LIMIT 1`,
    [tenantId],
  );
  const roleId = roleRes.rows[0]!.id;
  const empRes = await c.query<{ id: string }>(
    `SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
    [tenantId, ownerSlug],
  );
  const empId = empRes.rows[0]!.id;
  const raExists = await c.query(
    `SELECT 1 FROM choros.role_assignment
      WHERE tenant_id = $1 AND employee_id = $2 AND role_id = $3 AND confirmed_by IS NOT NULL LIMIT 1`,
    [tenantId, empId, roleId],
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
        empId,
        roleId,
        JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'org', nodeLevel: 'department' }),
        ownerSlug,
      ],
    );
  }
  await c.query('COMMIT');
}

async function seedApplication(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 'published', 0, 0)`,
    [tenantId, id, slug],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegistry(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  slug: string,
  opts: {
    isSystem: boolean;
    engineManaged: boolean;
    createdAt?: number;
    /**
     * Optional record_schema override — the form-submit tests (Part B-bis)
     * need registries whose schema DECLARES the submitted fields, because
     * the form path derives its FormDef from record_schema and rejects
     * unknown fields (form-validator UNKNOWN_FIELD strictness).
     */
    recordSchema?: object;
  },
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, description,
        record_schema, is_system, engine_managed, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, $6, $7, $8, $8)`,
    [
      tenantId,
      id,
      applicationId,
      slug,
      JSON.stringify(
        opts.recordSchema ?? { type: 'object', properties: {}, additionalProperties: true },
      ),
      opts.isSystem,
      opts.engineManaged,
      // Explicit created_at (falls back to a system/non-system stagger) so
      // "first non-system registry by created_at ASC" ordering is
      // deterministic in every test, INCLUDING the case where two
      // registries share is_system=false (Part A's trigger-scope isolation
      // test) — random UUIDs give no guaranteed id-tiebreak ordering, so the
      // created_at value itself MUST differ whenever test intent requires
      // one registry to resolve as "primary" ahead of another.
      opts.createdAt ?? (opts.isSystem ? 1000 : 0),
    ],
  );
  await c.query('COMMIT');
  return id;
}

async function seedOnCreateBinding(
  c: pg.Client,
  tenantId: string,
  applicationId: string,
  processKey: string,
  triggerRegistryId: string | null,
): Promise<void> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.process_app_binding
       (tenant_id, id, process_key, application_id, trigger_type, field_mapping, trigger_registry_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'on_create', $5::jsonb, $6, 0, 0)`,
    [tenantId, id, processKey, applicationId, JSON.stringify({}), triggerRegistryId],
  );
  await c.query('COMMIT');
}

async function seedRecord(
  c: pg.Client,
  tenantId: string,
  registryId: string,
  data: Record<string, unknown>,
  createdBy: string,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
     VALUES ($1, $2, $3, $4::jsonb, 0, 0, $5)`,
    [tenantId, id, registryId, JSON.stringify(data), createdBy],
  );
  await c.query('COMMIT');
  return id;
}

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { ...extraHeaders };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });
  const flowable = makeStubFlowable('inst-guard-default');
  const router = new Router();
  registerRecordRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant, flowable });
  // T-0606 review F-1: the SECOND live write path into choros.record —
  // POST /api/forms/:formId/submit — wired EXACTLY as server.ts does
  // (makeFormRecordPersister + makeFormDefResolver over the same app pool),
  // so the Part B-bis tests below exercise the REAL production chain the
  // T-0606 judge proved bypassed the engine_managed guard.
  registerFormsRoutes(router, {
    persist: makeFormRecordPersister(appPool, stubResolveActorTenant),
    resolveFormDef: makeFormDefResolver(appPool, stubResolveActorTenant),
  });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
  await withClient(migratorUrl(), (c) => seedOwnerTenant(c, TENANT_ID, ACTOR));
});

afterAll(async () => {
  if (!hasDb) return;
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('T-0606 Part A (live PG): on_create trigger scope', () => {
  it(
    'create in the PRIMARY registry starts the process; create in a SECONDARY (non-engine-managed) registry of the SAME application does NOT',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `guard-app-a-${Date.now()}`),
      );
      const primaryRegistryId = await withClient(migratorUrl(), (c) =>
        seedRegistry(c, TENANT_ID, applicationId, 'primary', { isSystem: false, engineManaged: false, createdAt: 0 }),
      );
      // A plain SECOND registry — is_system=false, engine_managed=false — so
      // this isolates the TRIGGER-SCOPE assertion from the write-protection
      // guard (Part B): the create itself must succeed (not 403'd), but the
      // binding (NULL trigger_registry_id → primary only) must not fire.
      // createdAt is explicitly LATER than the primary's — both rows share
      // is_system=false here, so created_at (not is_system) is what makes
      // "first non-system registry by created_at ASC" resolve to the
      // primary deterministically (a random-UUID id-tiebreak would not).
      const secondaryRegistryId = await withClient(migratorUrl(), (c) =>
        seedRegistry(c, TENANT_ID, applicationId, 'secondary', { isSystem: false, engineManaged: false, createdAt: 1000 }),
      );
      const processKey = `guardProcessA${Date.now()}`;
      await withClient(migratorUrl(), (c) =>
        seedOnCreateBinding(c, TENANT_ID, applicationId, processKey, null),
      );

      // Create in PRIMARY → process starts (process.started audit event exists).
      const rPrimary = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: primaryRegistryId, data: {} },
        { 'x-dev-user': ACTOR },
      );
      expect(rPrimary.statusCode, rPrimary.body).toBe(201);
      const primaryRecordId = (JSON.parse(rPrimary.body) as { id: string }).id;

      const primaryStarted = await withClient(migratorUrl(), (c) =>
        c.query(
          `SELECT 1 FROM choros.audit_event
            WHERE tenant_id = $1 AND type = 'process.started' AND payload->>'record_id' = $2 LIMIT 1`,
          [TENANT_ID, primaryRecordId],
        ),
      );
      expect(primaryStarted.rowCount, 'process must have started for the PRIMARY registry create').toBe(1);

      // Create in SECONDARY → process does NOT start (no process.started event).
      const rSecondary = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: secondaryRegistryId, data: {} },
        { 'x-dev-user': ACTOR },
      );
      expect(rSecondary.statusCode, rSecondary.body).toBe(201);
      const secondaryRecordId = (JSON.parse(rSecondary.body) as { id: string }).id;

      const secondaryStarted = await withClient(migratorUrl(), (c) =>
        c.query(
          `SELECT 1 FROM choros.audit_event
            WHERE tenant_id = $1 AND type = 'process.started' AND payload->>'record_id' = $2 LIMIT 1`,
          [TENANT_ID, secondaryRecordId],
        ),
      );
      expect(
        secondaryStarted.rowCount,
        'process must NOT have started for a create in the SECONDARY (non-primary) registry — bug #2',
      ).toBe(0);
    }),
  );
});

describe('T-0606 Part B (live PG): registry write-protection (engine_managed)', () => {
  it(
    'POST create against an engine_managed registry → 403 REGISTRY_ENGINE_MANAGED; no row written',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `guard-app-b1-${Date.now()}`),
      );
      const protectedRegistryId = await withClient(migratorUrl(), (c) =>
        seedRegistry(c, TENANT_ID, applicationId, 'protected', { isSystem: true, engineManaged: true }),
      );

      const res = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: protectedRegistryId, data: { decision: 'approve' } },
        { 'x-dev-user': ACTOR },
      );
      expect(res.statusCode, res.body).toBe(403);
      const body = JSON.parse(res.body) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('REGISTRY_ENGINE_MANAGED');
      expect(body.error?.message).toMatch(/процесс/i);

      const rows = await withClient(migratorUrl(), (c) =>
        c.query(`SELECT 1 FROM choros.record WHERE tenant_id = $1 AND registry_id = $2`, [
          TENANT_ID,
          protectedRegistryId,
        ]),
      );
      expect(rows.rowCount, 'no record must have been written').toBe(0);
    }),
  );

  it(
    'PUT update against an existing record in an engine_managed registry → 403; row unchanged',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `guard-app-b2-${Date.now()}`),
      );
      const protectedRegistryId = await withClient(migratorUrl(), (c) =>
        seedRegistry(c, TENANT_ID, applicationId, 'protected2', { isSystem: true, engineManaged: true }),
      );
      const recordId = await withClient(migratorUrl(), (c) =>
        seedRecord(c, TENANT_ID, protectedRegistryId, { decision: 'approve' }, 'system'),
      );

      const res = await makeRequest(
        baseUrl,
        'PUT',
        `/api/records/${recordId}`,
        { data: { decision: 'reject' } },
        { 'x-dev-user': ACTOR },
      );
      expect(res.statusCode, res.body).toBe(403);
      const body = JSON.parse(res.body) as { error?: { code?: string } };
      expect(body.error?.code).toBe('REGISTRY_ENGINE_MANAGED');

      const row = await withClient(migratorUrl(), (c) =>
        c.query<{ data: { decision: string } }>(
          `SELECT data FROM choros.record WHERE tenant_id = $1 AND id = $2`,
          [TENANT_ID, recordId],
        ),
      );
      expect(row.rows[0]?.data.decision, 'record data must be unchanged').toBe('approve');
    }),
  );

  it(
    'DELETE an existing decision record in an engine_managed registry → 403; row survives',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `guard-app-b3-${Date.now()}`),
      );
      const protectedRegistryId = await withClient(migratorUrl(), (c) =>
        seedRegistry(c, TENANT_ID, applicationId, 'protected3', { isSystem: true, engineManaged: true }),
      );
      const recordId = await withClient(migratorUrl(), (c) =>
        seedRecord(c, TENANT_ID, protectedRegistryId, { decision: 'approve' }, 'system'),
      );

      const res = await makeRequest(baseUrl, 'DELETE', `/api/records/${recordId}`, undefined, {
        'x-dev-user': ACTOR,
      });
      expect(res.statusCode, res.body).toBe(403);
      const body = JSON.parse(res.body) as { error?: { code?: string } };
      expect(body.error?.code).toBe('REGISTRY_ENGINE_MANAGED');

      const row = await withClient(migratorUrl(), (c) =>
        c.query(`SELECT 1 FROM choros.record WHERE tenant_id = $1 AND id = $2`, [TENANT_ID, recordId]),
      );
      expect(row.rowCount, 'decision record must survive the rejected delete').toBe(1);
    }),
  );

  it(
    'a NON-engine_managed registry is unaffected: normal create/update/delete still succeed',
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `guard-app-b4-${Date.now()}`),
      );
      const plainRegistryId = await withClient(migratorUrl(), (c) =>
        seedRegistry(c, TENANT_ID, applicationId, 'plain', { isSystem: false, engineManaged: false }),
      );

      const created = await makeRequest(
        baseUrl,
        'POST',
        '/api/records',
        { application_id: applicationId, registry_def_id: plainRegistryId, data: { hello: 'world' } },
        { 'x-dev-user': ACTOR },
      );
      expect(created.statusCode, created.body).toBe(201);
      const recordId = (JSON.parse(created.body) as { id: string }).id;

      const updated = await makeRequest(
        baseUrl,
        'PUT',
        `/api/records/${recordId}`,
        { data: { hello: 'updated' } },
        { 'x-dev-user': ACTOR },
      );
      expect(updated.statusCode, updated.body).toBe(200);

      const deleted = await makeRequest(baseUrl, 'DELETE', `/api/records/${recordId}`, undefined, {
        'x-dev-user': ACTOR,
      });
      expect(deleted.statusCode, deleted.body).toBe(204);
    }),
  );

  it(
    "applyStepResult (step-applier.ts's own direct DAO insert — NOT this HTTP route) still writes successfully into an engine_managed registry",
    requireDb(async () => {
      const applicationId = await withClient(migratorUrl(), (c) =>
        seedApplication(c, TENANT_ID, `guard-app-b5-${Date.now()}`),
      );
      // PRIMARY (business-data) registry — is_system=false.
      const primaryRegistryId = await withClient(migratorUrl(), (c) =>
        seedRegistry(c, TENANT_ID, applicationId, 'primary5', { isSystem: false, engineManaged: false }),
      );
      // ENGINE-MANAGED approvals/decision registry — the step-result target,
      // resolved by SLUG (step-applier.ts's own resolution, unrelated to the
      // HTTP guard entirely).
      const approvalsSlug = `guard-approvals-${Date.now()}`;
      const approvalsRegistryId = await withClient(migratorUrl(), (c) =>
        seedRegistry(c, TENANT_ID, applicationId, approvalsSlug, { isSystem: true, engineManaged: true }),
      );

      const processKey = `guardStepApplierProcess${Date.now()}`;
      const instanceId = uuid();
      const taskId = uuid();

      // Seed process_app_binding with target_registry_slug pointing at the
      // engine-managed approvals registry (mirrors migration 119's mechanism —
      // entirely separate from trigger_registry_id / Part A).
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_ID}'`);
        await c.query(
          `INSERT INTO choros.process_app_binding
             (tenant_id, id, process_key, application_id, trigger_type, field_mapping, target_registry_slug, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'launcher', $5::jsonb, $6, 0, 0)`,
          [TENANT_ID, uuid(), processKey, applicationId, JSON.stringify({}), approvalsSlug],
        );
        await c.query('COMMIT');
      });

      // Seed the process.started audit event the resolver needs (payload.inst = instanceId).
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_ID}'`);
        const writer = makePgAuditWriter();
        await writer.appendAuditEvent(c as unknown as PgClientLike, {
          id: uuid(),
          type: 'process.started',
          actor: ACTOR,
          subject: instanceId,
          scope: { application_id: applicationId },
          via: 'test-seed',
          proposed_by: null,
          confirmed_by: ACTOR,
          payload: { inst: instanceId, proc_key: processKey },
          occurred_at: 0,
        });
        await c.query('COMMIT');
      });

      // Call applyStepResult directly (the SAME code path an approve action
      // uses) inside a tenant tx — NOT through POST/PUT/DELETE /api/records.
      const outboxEnqueued: unknown[] = [];
      const outboxStore: OutboxEnqueuePort = {
        enqueueInTx: async (_client, row) => {
          outboxEnqueued.push(row);
        },
      };

      let recordId = '';
      await withClient(migratorUrl(), async (c) => {
        await c.query('BEGIN');
        await c.query(`SET LOCAL choros.tenant_id = '${TENANT_ID}'`);
        const result = await applyStepResult(c as unknown as pg.PoolClient, {
          tenantId: TENANT_ID,
          instanceId,
          procKey: processKey,
          activity: 'task.approved',
          actor: ACTOR,
          taskId,
          stepClass: 'A',
          formData: { decision: 'approve', approved_by: ACTOR },
          durationMs: 1234,
          nowMs: 5000,
          outboxStore,
        });
        expect(result.kind).toBe('applied-A');
        if (result.kind === 'applied-A') recordId = result.recordId;
        await c.query('COMMIT');
      });

      expect(recordId).not.toBe('');
      expect(outboxEnqueued).toHaveLength(1);

      // The decision record IS in the engine-managed registry — proving the
      // write-protection guard (which lives ONLY inside records.ts's HTTP
      // create/update/delete handlers) never touched this path.
      const row = await withClient(migratorUrl(), (c) =>
        c.query<{ registry_id: string; data: { decision: string } }>(
          `SELECT registry_id, data FROM choros.record WHERE tenant_id = $1 AND id = $2`,
          [TENANT_ID, recordId],
        ),
      );
      expect(row.rows[0]?.registry_id).toBe(approvalsRegistryId);
      expect(row.rows[0]?.data.decision).toBe('approve');

      // Sanity: the primary registry is untouched by this flow (defensive).
      const primaryRows = await withClient(migratorUrl(), (c) =>
        c.query(`SELECT 1 FROM choros.record WHERE tenant_id = $1 AND registry_id = $2`, [
          TENANT_ID,
          primaryRegistryId,
        ]),
      );
      expect(primaryRows.rowCount).toBe(0);
    }),
  );
});

// ---------------------------------------------------------------------------
// T-0606 review F-1 (Part B-bis, live PG): the SECOND write path —
// POST /api/forms/:formId/submit → makeFormRecordPersister — must respect
// engine_managed exactly like /api/records does.
// ---------------------------------------------------------------------------
// The T-0606 judge proved live that this path wrote a phantom decision record
// into the engine_managed «Согласование»-shaped registry, bypassing the
// records.ts guard entirely (review F-1, blocking). These tests drive the
// REAL HTTP route (registerFormsRoutes wired with the production
// makeFormRecordPersister + makeFormDefResolver — see beforeAll) against the
// SAME default chain the judge used: application slug 'tel-approval'
// (resolveTelApplicationSlug default) + registry slugs 'purchases' /
// 'soglasovanie' (resolveApprovalFormRegistrySlug default). The slug
// literals here are TEST FIXTURE DATA seeding the fresh test tenant — a
// .test.ts file, excluded from the D-064 anti-case scans by methodology
// (same class as step-applier.test.ts's SOGLASOVANIE_SLUG fixtures).

describe('T-0606 Part B-bis (live PG): form-submit write path respects engine_managed (review F-1)', () => {
  /** Seed the tel-approval-shaped application + both form-target registries under TENANT_ID. */
  async function seedFormChain(): Promise<{
    applicationId: string;
    purchasesRegistryId: string;
    approvalsRegistryId: string;
  }> {
    const applicationId = await withClient(migratorUrl(), (c) =>
      seedApplication(c, TENANT_ID, 'tel-approval'),
    );
    // 'purchases' — the primary business registry the "purchase" form targets:
    // NOT engine-managed, form submits must keep working (regression guard).
    const purchasesRegistryId = await withClient(migratorUrl(), (c) =>
      seedRegistry(c, TENANT_ID, applicationId, 'purchases', {
        isSystem: false,
        engineManaged: false,
        createdAt: 0,
        recordSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { title: { type: 'string', title: 'Тема заявки' } },
          required: ['title'],
        },
      }),
    );
    // 'soglasovanie' — the decision-projection registry the "approval" form
    // targets: engine-managed (mirrors migration 122's data-completion), the
    // form submit MUST be rejected.
    const approvalsRegistryId = await withClient(migratorUrl(), (c) =>
      seedRegistry(c, TENANT_ID, applicationId, 'soglasovanie', {
        isSystem: true,
        engineManaged: true,
        createdAt: 1000,
        recordSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { decision: { type: 'string', title: 'Решение' } },
          required: ['decision'],
        },
      }),
    );
    return { applicationId, purchasesRegistryId, approvalsRegistryId };
  }

  it(
    "POST /api/forms/approval/submit against an engine_managed registry → 403 REGISTRY_ENGINE_MANAGED; no phantom decision record written (the judge's exact bypass, now closed)",
    requireDb(async () => {
      const { approvalsRegistryId } = await seedFormChain();

      const res = await makeRequest(
        baseUrl,
        'POST',
        '/api/forms/approval/submit',
        { decision: 'approve' },
        { 'x-dev-user': ACTOR },
      );
      expect(res.statusCode, res.body).toBe(403);
      const body = JSON.parse(res.body) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('REGISTRY_ENGINE_MANAGED');
      expect(body.error?.message).toMatch(/процесс/i);

      // The phantom record must NOT exist (the judge's probe observed rowCount=1
      // here pre-fix — this pins rowCount=0 post-fix).
      const rows = await withClient(migratorUrl(), (c) =>
        c.query(`SELECT 1 FROM choros.record WHERE tenant_id = $1 AND registry_id = $2`, [
          TENANT_ID,
          approvalsRegistryId,
        ]),
      );
      expect(rows.rowCount, 'no phantom decision record may be written via form-submit').toBe(0);
    }),
  );

  it(
    'POST /api/forms/purchase/submit against a NON-engine_managed registry → 200 ok + record persists (regression: legitimate form targets unaffected)',
    requireDb(async () => {
      // seedFormChain was already applied by the previous test for THIS tenant —
      // but tests must not depend on ordering; seed idempotently by slug check.
      const existing = await withClient(migratorUrl(), (c) =>
        c.query<{ id: string }>(
          `SELECT rd.id FROM choros.registry_def rd
             JOIN choros.application a ON a.tenant_id = rd.tenant_id AND a.id = rd.application_id
            WHERE rd.tenant_id = $1 AND rd.slug = 'purchases' AND a.slug = 'tel-approval' LIMIT 1`,
          [TENANT_ID],
        ),
      );
      const purchasesRegistryId =
        existing.rows[0]?.id ?? (await seedFormChain()).purchasesRegistryId;

      const res = await makeRequest(
        baseUrl,
        'POST',
        '/api/forms/purchase/submit',
        { title: 'Заявка через форму' },
        { 'x-dev-user': ACTOR },
      );
      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as { ok?: boolean; recordId?: string };
      expect(body.ok).toBe(true);
      expect(body.recordId).toBeDefined();

      const row = await withClient(migratorUrl(), (c) =>
        c.query<{ registry_id: string; data: { title: string } }>(
          `SELECT registry_id, data FROM choros.record WHERE tenant_id = $1 AND id = $2`,
          [TENANT_ID, body.recordId],
        ),
      );
      expect(row.rows[0]?.registry_id).toBe(purchasesRegistryId);
      expect(row.rows[0]?.data.title).toBe('Заявка через форму');
    }),
  );
});
