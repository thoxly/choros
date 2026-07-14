// ci/checks/db/inbox-defer-escalation.db.test.ts — T-0638 [столп 4 P0] live-DB
// integration probe for two of the four defer-task defects fixed in this task:
//
//   AC-b — a defer task (agent.deferred audit event) appears in GET /api/inbox
//          with escalated:true, and counts.esc / tab=esc includes it. Before
//          this task, findInboxItems built defer InboxItems WITHOUT the
//          escalated field, so isEscalated(item) (item.escalated===true ||
//          status==='failed') never matched a waiting defer row — the
//          «Эскалации» tab counter never grew for a defer task.
//
//   AC-d — a defer task addressed to a role with NO confirmed holders in the
//          tenant resolves honestly: routed_to_fallback:"role_unfilled" is
//          set (the SAME mechanism T-0380's resolveExecutorFallbackBatch
//          already applies to ordinary instance pool tasks), instead of being
//          silently unclaimable by anyone (the bug: a hardcoded
//          "role-approver"/"fin-ctrl" fallback with no holder check).
//
// Hits the REAL HTTP route (registerInboxRoutes) against a REAL Postgres,
// mirroring ci/checks/db/inbox-actor-resolve.db.test.ts's harness.
//
// Run: DATABASE_URL=... npm run fitness:db

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerInboxRoutes, type InboxWriteDeps } from '../../../src/http/inbox.js';
import { makePgAuditWriter } from '../../../src/db/audit-writer.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';
import type { AuditEventInput } from '../../../src/core/audit-grant-encoder.js';
import { resolveActorTenant } from '../../../src/db/org.js';

const hasDb = Boolean(process.env['DATABASE_URL']);
const writer = makePgAuditWriter();

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers: extraHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// POST helper with a JSON body — used by the T-0676 owner-orphan resolve-action
// tests below (the plain makeRequest above never sends a body, sufficient for
// the pre-existing GET-only probes in this file).
function makeJsonRequest(
  baseUrl: string,
  method: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const headers: Record<string, string> = {
      ...extraHeaders,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
    };
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
    req.write(bodyStr);
    req.end();
  });
}

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;
let orgPool: pg.Pool;

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });
  // T-0676 (adversarial review follow-up): a SEPARATE BYPASSRLS pool for
  // resolveActorTenant — mirrors production wiring EXACTLY (src/server.ts:540-541
  // passes `pool: grantsPool` (RLS-scoped app role) but
  // `resolveActorTenant(getOrgPool(), actorSlug)`, i.e. a DIFFERENT pool, since
  // actor→tenant resolution must run BEFORE the tenant is known and therefore
  // cannot rely on a `SET LOCAL choros.tenant_id` GUC already being set — the
  // whole point of the call is to DISCOVER that tenant. getOrgPool() itself
  // resolves off the ambient DATABASE_URL (choros_migrator here); orgPool below
  // is that same BYPASSRLS connection, constructed locally since this test
  // harness doesn't import the process-wide getOrgPool() singleton.
  orgPool = new pg.Pool({ connectionString: migratorUrl() });
  const router = new Router();
  const writeDeps: InboxWriteDeps = {
    pool: appPool,
    // The new resolve-action tests below POST /api/inbox/:id/action, which needs
    // a REAL actor→tenant resolver (was a throwing stub — fine while only GET
    // was probed here, since GET resolves the actor via getAuthContext/dev-user
    // header directly, not through this writeDeps hook).
    resolveActorTenant: (actorSlug: string) => resolveActorTenant(orgPool, actorSlug),
  };
  registerInboxRoutes(router, undefined, writeDeps);
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (!hasDb) return;
  if (appPool) await appPool.end();
  if (orgPool) await orgPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Seed helpers (mirror inbox-actor-resolve.db.test.ts byte-for-byte).
// ---------------------------------------------------------------------------

type EmpFx = { id: string; slug: string; deptId: string };

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t0638-inbox-${tenantId.slice(0, 8)}`],
  );
}

async function seedEmployee(
  c: pg.Client,
  tenantId: string,
  slug: string,
  displayName: string,
): Promise<EmpFx> {
  const deptId = uuid();
  await c.query(
    `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $3, 0, 0)`,
    [tenantId, deptId, `t0638-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [tenantId, posId, deptId, `t0638-pos-${posId.slice(0, 8)}`],
  );
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, 'human', $4, $5, 0, 0)`,
    [tenantId, empId, posId, slug, displayName],
  );
  return { id: empId, slug, deptId };
}

async function seedRole(c: pg.Client, tenantId: string, slug: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 0, 0)`,
    [tenantId, id, slug],
  );
  return id;
}

async function seedAssignment(
  c: pg.Client,
  tenantId: string,
  args: { empId: string; roleId: string },
): Promise<void> {
  await c.query(
    `INSERT INTO choros.role_assignment
       (tenant_id, id, employee_id, role_id, org_scope,
        valid_from, valid_until, source, granted_by,
        proposed_by, confirmed_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             NULL, NULL, 'seed', 'seed',
             NULL, 'seed', 0, 0)`,
    [
      tenantId, uuid(), args.empId, args.roleId,
      JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' }),
    ],
  );
}

/** Seed the 'tenant-owner' role + assignment (findTenantOwnerSlug's query target). */
async function seedTenantOwner(c: pg.Client, tenantId: string, ownerSlug: string): Promise<EmpFx> {
  const owner = await seedEmployee(c, tenantId, ownerSlug, 'Owner Т-0638');
  const ownerRoleId = await seedRole(c, tenantId, 'tenant-owner');
  await seedAssignment(c, tenantId, { empId: owner.id, roleId: ownerRoleId });
  return owner;
}

/**
 * Seed ONE agent.deferred audit event (mirrors dispatch-outcome.ts's deferredAuditEvent shape).
 *
 * T-0676: `deferRole` is OPTIONAL and, when omitted, the `defer_role` key is left
 * OUT of the payload entirely — this mirrors a legacy row written before the
 * field existed (or any write path that genuinely never had a role to thread),
 * which is exactly the case deferred-inbox-store.ts's read-side default handles.
 */
async function seedDeferEvent(
  c: pg.Client,
  tenantId: string,
  opts: { taskId: string; agentEmployeeId: string; doubtReason: string; deferRole?: string; instanceId?: string },
): Promise<void> {
  const input: AuditEventInput = {
    id: opts.taskId,
    type: 'agent.deferred',
    actor: opts.agentEmployeeId,
    subject: `agent:${opts.agentEmployeeId}`,
    scope: { proc_key: 'telLinear', signal: 'dormant', via: 'agent-dispatch' },
    via: 'agent-dispatch',
    proposed_by: null,
    confirmed_by: null,
    payload: {
      doubt_reason: opts.doubtReason,
      signal: 'dormant',
      inbox_task_id: opts.taskId,
      instance_id: opts.instanceId ?? null,
      proc_key: 'telLinear',
      ...(opts.deferRole !== undefined ? { defer_role: opts.deferRole } : {}),
      defer_sla_minutes: null,
      defer_name: `Проверить: ${opts.doubtReason}`,
      agent_draft: null,
    },
    occurred_at: Date.now(),
  };
  await writer.appendAuditEvent(c as unknown as PgClientLike, input);
}

/** Read agent.defer_resolved audit-event payloads for a given inbox task id (BYPASSRLS, mirrors T-0744's readClaimedPayload). */
async function readDeferResolvedPayloads(taskId: string): Promise<Array<Record<string, unknown>>> {
  const c = new pg.Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    await c.query('SET search_path TO choros;');
    const { rows } = await c.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM choros.audit_event
        WHERE type = 'agent.defer_resolved' AND payload->>'inbox_task_id' = $1`,
      [taskId],
    );
    return rows.map((r) => r.payload);
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------------------
// AC-b: defer task → escalated:true + counts.esc
// ---------------------------------------------------------------------------

describe('T-0638 AC-b — GET /api/inbox: a defer task is escalated (tab=esc, counts.esc)', () => {
  it('a defer task carries escalated:true and is counted/returned under tab=esc', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const roleSlug = `t0638-role-esc-${uuid().slice(0, 6)}`;
    const holderSlug = `t0638-holder-${uuid().slice(0, 6)}`;
    const taskId = uuid();

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const holder = await seedEmployee(c, tenantId, holderSlug, 'Т-0638 Держатель роли');
      await seedAssignment(c, tenantId, { empId: holder.id, roleId });
      await seedDeferEvent(c, tenantId, {
        taskId,
        agentEmployeeId: `agent-t0638-${uuid().slice(0, 6)}`,
        doubtReason: 'no published instruction for agent',
        deferRole: roleSlug,
      });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    const allRes = await makeRequest(baseUrl, 'GET', '/api/inbox', { 'x-dev-user': holderSlug });
    expect(allRes.statusCode, allRes.body).toBe(200);
    const allParsed = JSON.parse(allRes.body) as { items: Array<Record<string, unknown>>; counts: Record<string, number> };
    const item = allParsed.items.find((i) => i['id'] === taskId);
    expect(item).toBeDefined();
    expect(item!['escalated']).toBe(true);
    // Human-readable doubt_reason (defect #3), not raw English.
    expect(String(item!['doubt_reason'])).not.toBe('no published instruction for agent');
    expect(String(item!['doubt_reason'])).toMatch(/[а-яА-Я]/);

    const escRes = await makeRequest(baseUrl, 'GET', '/api/inbox?tab=esc', { 'x-dev-user': holderSlug });
    expect(escRes.statusCode, escRes.body).toBe(200);
    const escParsed = JSON.parse(escRes.body) as { items: Array<Record<string, unknown>>; counts: Record<string, number> };
    expect(escParsed.items.some((i) => i['id'] === taskId)).toBe(true);
    expect(escParsed.counts['esc']).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AC-d: defer task addressed to a role with NO holders → honest fallback.
// ---------------------------------------------------------------------------

describe('T-0638 AC-d — GET /api/inbox: a defer task addressed to an unfilled role resolves honestly', () => {
  it('routed_to_fallback:"role_unfilled" is set when the defer role has no confirmed holders (not a silent hardcode)', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const unfilledRoleSlug = `t0638-role-unfilled-${uuid().slice(0, 6)}`;
    const ownerSlug = `t0638-owner-${uuid().slice(0, 6)}`;
    const taskId = uuid();

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      // The role EXISTS but has NO role_assignment (no holders) — mirrors the
      // live bug: a fallback like "role-approver"/"fin-ctrl" may not exist or
      // may hold nobody in this tenant.
      await seedRole(c, tenantId, unfilledRoleSlug);
      const owner = await seedTenantOwner(c, tenantId, ownerSlug);
      void owner;
      await seedDeferEvent(c, tenantId, {
        taskId,
        agentEmployeeId: `agent-t0638-${uuid().slice(0, 6)}`,
        doubtReason: 'autonomy threshold not met',
        deferRole: unfilledRoleSlug,
      });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    // The tenant owner reads the inbox — sees the unfilled-role defer task
    // marked with the SAME honest fallback signal instance tasks already use.
    const res = await makeRequest(baseUrl, 'GET', '/api/inbox', { 'x-dev-user': ownerSlug });
    expect(res.statusCode, res.body).toBe(200);
    const parsed = JSON.parse(res.body) as { items: Array<Record<string, unknown>> };
    const item = parsed.items.find((i) => i['id'] === taskId);
    expect(item).toBeDefined();
    expect(item!['routed_to_fallback']).toBe('role_unfilled');
  });

  it('a defer task addressed to a role WITH holders does NOT get routed_to_fallback (no regression)', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const filledRoleSlug = `t0638-role-filled-${uuid().slice(0, 6)}`;
    const holderSlug = `t0638-holder2-${uuid().slice(0, 6)}`;
    const taskId = uuid();

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, filledRoleSlug);
      const holder = await seedEmployee(c, tenantId, holderSlug, 'Т-0638 Держатель-2');
      await seedAssignment(c, tenantId, { empId: holder.id, roleId });
      await seedDeferEvent(c, tenantId, {
        taskId,
        agentEmployeeId: `agent-t0638-${uuid().slice(0, 6)}`,
        doubtReason: 'answer marked ambiguous',
        deferRole: filledRoleSlug,
      });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    const res = await makeRequest(baseUrl, 'GET', '/api/inbox', { 'x-dev-user': holderSlug });
    expect(res.statusCode, res.body).toBe(200);
    const parsed = JSON.parse(res.body) as { items: Array<Record<string, unknown>> };
    const item = parsed.items.find((i) => i['id'] === taskId);
    expect(item).toBeDefined();
    expect(item!['routed_to_fallback']).toBeUndefined();
  });

  // T-0676: anti-case hardcode fix. Before this task, deferred-inbox-store.ts
  // defaulted a MISSING payload.defer_role to the literal "fin-ctrl" — so even
  // though this defer task never had a role assigned, it would incorrectly land
  // on whoever holds "fin-ctrl" in THIS tenant (a real, commonly-seeded role)
  // instead of the honest role_unfilled → tenant-owner fallback. This test seeds
  // a tenant where "fin-ctrl" DOES have a confirmed holder — the exact condition
  // that used to mask the bug (an empty-pool "fin-ctrl" would have accidentally
  // "worked") — and asserts the defer task still resolves honestly to the owner,
  // never to the fin-ctrl holder.
  it('T-0676: a defer task with NO defer_role in payload resolves to the owner, even when "fin-ctrl" has a live holder', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const ownerSlug = `t0676-owner-${uuid().slice(0, 6)}`;
    const finCtrlHolderSlug = `t0676-fin-ctrl-holder-${uuid().slice(0, 6)}`;
    const taskId = uuid();

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const owner = await seedTenantOwner(c, tenantId, ownerSlug);
      void owner;
      // Seed the "fin-ctrl" role WITH a confirmed holder — proves the fallback
      // is NOT keyed off that literal ever being unfilled by coincidence.
      const finCtrlRoleId = await seedRole(c, tenantId, 'fin-ctrl');
      const finCtrlHolder = await seedEmployee(c, tenantId, finCtrlHolderSlug, 'Т-0676 fin-ctrl держатель');
      await seedAssignment(c, tenantId, { empId: finCtrlHolder.id, roleId: finCtrlRoleId });
      // deferRole OMITTED entirely — mirrors a legacy/no-role-context defer event.
      await seedDeferEvent(c, tenantId, {
        taskId,
        agentEmployeeId: `agent-t0676-${uuid().slice(0, 6)}`,
        doubtReason: 'no published instruction for agent',
      });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    // The fin-ctrl holder must NOT see this task in their POOL tab (pool
    // eligibility is role-addressed — myRoles.includes(item.role) — and this task
    // was never actually addressed to fin-ctrl; a case-role hardcode would have
    // wrongly made it claimable by this holder).
    const finCtrlRes = await makeRequest(baseUrl, 'GET', '/api/inbox?tab=pool', { 'x-dev-user': finCtrlHolderSlug });
    expect(finCtrlRes.statusCode, finCtrlRes.body).toBe(200);
    const finCtrlParsed = JSON.parse(finCtrlRes.body) as { items: Array<Record<string, unknown>> };
    expect(finCtrlParsed.items.find((i) => i['id'] === taskId)).toBeUndefined();

    // The tenant owner sees it, honestly marked as a role_unfilled fallback.
    const ownerRes = await makeRequest(baseUrl, 'GET', '/api/inbox', { 'x-dev-user': ownerSlug });
    expect(ownerRes.statusCode, ownerRes.body).toBe(200);
    const ownerParsed = JSON.parse(ownerRes.body) as { items: Array<Record<string, unknown>> };
    const item = ownerParsed.items.find((i) => i['id'] === taskId);
    expect(item).toBeDefined();
    expect(item!['routed_to_fallback']).toBe('role_unfilled');
    expect(item!['role']).not.toBe('fin-ctrl');
  });
});

// ---------------------------------------------------------------------------
// T-0676 (adversarial review follow-up): the ACTION path must actually let the
// owner RESOLVE a role-less defer, not just SEE it. Before this fix, the
// defer-resolve authz branch (inbox.ts's POST /api/inbox/:id/action defer
// branch) had no owner-orphan rung — unlike the claim (T-0744) and
// instance-approve branches, which both fall back to isOwnerOrphanClaimEligible
// when the plain role/Tier-2 checks miss. So the owner, routed a role-less
// defer via routed_to_fallback:"role_unfilled" (READ-side, T-0676 §above),
// hit deferMyRoles.includes("") === false → 403 NOT_ELIGIBLE — a dead end that
// left the engine token stuck forever (contradicts ADR-T0638's success
// criterion: "взятая defer-задача продвигает процесс").
// ---------------------------------------------------------------------------

describe('T-0676 (owner-orphan resolve-action) — POST /api/inbox/:id/action on a role-less defer', () => {
  it('the tenant owner CAN resolve a role-less (defer_role omitted) defer task — no more 403 dead-end', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const ownerSlug = `t0676-act-owner-${uuid().slice(0, 6)}`;
    const taskId = uuid();
    const instanceId = uuid();

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const owner = await seedTenantOwner(c, tenantId, ownerSlug);
      void owner;
      // deferRole OMITTED — deferred-inbox-store.ts's read-side default resolves
      // this to "" (role-unfilled), which routes it to the tenant owner.
      await seedDeferEvent(c, tenantId, {
        taskId,
        agentEmployeeId: `agent-t0676-act-${uuid().slice(0, 6)}`,
        doubtReason: 'no published instruction for agent',
        instanceId, // required: an instance-less defer hits DEFER_NOT_ROUTABLE, not the authz gate under test
      });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    // Sanity: GET shows it routed to the owner as role_unfilled (mirrors the
    // T-0676 GET test above — re-asserted here so this test is self-contained).
    const getRes = await makeRequest(baseUrl, 'GET', '/api/inbox', { 'x-dev-user': ownerSlug });
    expect(getRes.statusCode, getRes.body).toBe(200);
    const getParsed = JSON.parse(getRes.body) as { items: Array<Record<string, unknown>> };
    const seenItem = getParsed.items.find((i) => i['id'] === taskId);
    expect(seenItem).toBeDefined();
    expect(seenItem!['routed_to_fallback']).toBe('role_unfilled');

    // The owner clicks resolve on the defer card — this is the ACTION path that
    // was blocking-403 before the fix (no engine/flowableClient wired in this
    // probe, so the route's `!writeDepsFlowable` early-return applies —
    // audit-only resolve is sufficient to prove the authz gate opened).
    const ownerResolve = await makeJsonRequest(
      baseUrl,
      'POST',
      `/api/inbox/${taskId}/action`,
      { action: 'approve' },
      { 'x-dev-user': ownerSlug },
    );
    expect(ownerResolve.statusCode, ownerResolve.body).toBe(200);
    const resolveBody = JSON.parse(ownerResolve.body) as Record<string, unknown>;
    expect(resolveBody['status']).toBe('done');
    expect(resolveBody['instanceId']).toBe(instanceId);

    // The defer-resolve audit event is the source of truth for this action —
    // confirm it was actually written (not a silent no-op 200).
    const auditRows = await readDeferResolvedPayloads(taskId);
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]!['resolved_by']).toBe(ownerSlug);
  });

  it('adversarial: a non-owner, non-holder actor still gets 403 on the same role-less defer (no over-widening)', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const ownerSlug = `t0676-act-owner2-${uuid().slice(0, 6)}`;
    const bystanderSlug = `t0676-act-bystander-${uuid().slice(0, 6)}`;
    const taskId = uuid();
    const instanceId = uuid();

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const owner = await seedTenantOwner(c, tenantId, ownerSlug);
      void owner;
      // A plain employee — NOT the owner, holds no role at all.
      await seedEmployee(c, tenantId, bystanderSlug, 'Т-0676 сторонний');
      await seedDeferEvent(c, tenantId, {
        taskId,
        agentEmployeeId: `agent-t0676-act2-${uuid().slice(0, 6)}`,
        doubtReason: 'no published instruction for agent',
        instanceId,
      });
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    const bystanderResolve = await makeJsonRequest(
      baseUrl,
      'POST',
      `/api/inbox/${taskId}/action`,
      { action: 'approve' },
      { 'x-dev-user': bystanderSlug },
    );
    expect(bystanderResolve.statusCode, bystanderResolve.body).toBe(403);
    expect(JSON.parse(bystanderResolve.body).error.code).toBe('NOT_ELIGIBLE');

    // Regression check: the genesis owner (this tenant's real owner) still CAN
    // resolve it — proves the 403 above is actor-specific, not a broken fixture.
    const ownerResolve = await makeJsonRequest(
      baseUrl,
      'POST',
      `/api/inbox/${taskId}/action`,
      { action: 'approve' },
      { 'x-dev-user': ownerSlug },
    );
    expect(ownerResolve.statusCode, ownerResolve.body).toBe(200);
  });
});
