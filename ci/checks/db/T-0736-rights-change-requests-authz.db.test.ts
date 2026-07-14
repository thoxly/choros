// T-0736 [security P1, substrate] · GET /api/rights/change-requests authority
// gate — LIVE Postgres integration probe.
//
// THE BUG (T-0726 §5.2 finding): the pending dual-control approval queue
// (semi-confirmed grants/role_assignments awaiting a second approver) was
// returned to ANY authenticated tenant member — including a DEACTIVATED one
// with a still-live JWT/dev-header — with zero authority check.
//
// THE FIX (T-0736, src/http/rights-change-requests.ts): the GET handler now
// calls assertApproverIsHuman(pool, tenantId, actorId) — the SAME registered
// T-0662 authority resolver (AUTHORITY_RESOLVERS #7 in
// actor-authority-deactivation-gate.sh) the sibling approve/reject routes on
// this exact file already carry. NOT narrowed to admin/owner: T-0044 ADR §9
// (dual-control) is explicit that ANY distinct ACTIVE human may be a second
// approver — the LIST gate mirrors exactly that eligibility, no more, no less.
//
// Run:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npx vitest run --dir ci/checks/db --no-file-parallelism \
//     ci/checks/db/T-0736-rights-change-requests-authz.db.test.ts
//
// COVERAGE (real http.Server + the real production route, real migrator pool):
//   AC-1  ordinary ACTIVE human (no admin/owner authority at all) -> 200, sees
//         the pending item (proves the gate is NOT narrowed to admin/owner)
//   AC-2  DEACTIVATED human                                        -> 403
//   AC-3  agent (kind='agent')                                     -> 403 AGENT_NOT_ALLOWED
//
// Generic by construction (D-064): every slug is uuid()-suffixed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRightsChangeRequestRoutes } from '../../../src/http/rights-change-requests.js';

const hasDb = Boolean(process.env['DATABASE_URL']);

const TENANT = uuid();

type EmpFx = { id: string; slug: string };
const EMPTY_EMP: EmpFx = { id: '', slug: '' };

const fx: {
  proposer: EmpFx;
  plainMember: EmpFx;
  deactivatedMember: EmpFx;
  agent: EmpFx;
  roleId: string;
} = {
  proposer: EMPTY_EMP,
  plainMember: EMPTY_EMP,
  deactivatedMember: EMPTY_EMP,
  agent: EMPTY_EMP,
  roleId: '',
};

const GRANT_SCOPE = JSON.stringify({ kind: 'node', hierarchy: 'org', nodeId: 'x', nodeLevel: 'department' });

async function seedEmployee(
  c: pg.Client,
  slug: string,
  opts?: { kind?: 'human' | 'agent'; deactivatedAt?: number },
): Promise<EmpFx> {
  const empId = uuid();
  await c.query(
    `INSERT INTO choros.employee
       (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at, deactivated_at)
     VALUES ($1, $2, NULL, $3, $4, $4, 0, 0, $5)`,
    [TENANT, empId, opts?.kind ?? 'human', slug, opts?.deactivatedAt ?? null],
  );
  return { id: empId, slug };
}

async function seedRole(c: pg.Client, slug: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
     VALUES ($1, $2, $3, $3, NULL, 0, 0)`,
    [TENANT, id, slug],
  );
  return id;
}

/** A SEMI-CONFIRMED grant: confirmed_by set, confirmed2_by NULL — the "pending" shape. */
async function seedPendingGrant(c: pg.Client, roleId: string, confirmedBy: string): Promise<string> {
  const id = uuid();
  await c.query(
    `INSERT INTO choros."grant"
       (tenant_id, id, role_id, resource_type, resource_facet,
        operation, scope, "constraint", delegable, granted_by,
        valid_from, valid_until, created_at,
        proposed_by, confirmed_by, confirmed2_by)
     VALUES ($1, $2, $3, 'mcp://record.x', NULL,
             'approve', $4::jsonb, NULL, false, 'seed',
             NULL, NULL, 0,
             $5, $5, NULL)`,
    [TENANT, id, roleId, GRANT_SCOPE, confirmedBy],
  );
  return id;
}

let pool: pg.Pool;
let baseUrl = '';
let closeServer: () => Promise<void> = async () => {};
let pendingGrantId = '';

function req(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const httpReq = http.request(url, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    httpReq.on('error', reject);
    httpReq.end();
  });
}

describe('T-0736 · GET /api/rights/change-requests — authority gate (live Postgres)', () => {
  if (!hasDb) {
    it.skip('DATABASE_URL not set — skipping live DB tests', () => {});
    return;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: migratorUrl() });

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
         VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
        [TENANT, `t0736-cr-${TENANT.slice(0, 8)}`],
      );
      await c.query('COMMIT');

      await c.query('BEGIN');
      fx.roleId = await seedRole(c, `t0736-cr-role-${uuid().slice(0, 6)}`);
      fx.proposer = await seedEmployee(c, `t0736-cr-proposer-${uuid().slice(0, 6)}`);
      fx.plainMember = await seedEmployee(c, `t0736-cr-member-${uuid().slice(0, 6)}`);
      fx.deactivatedMember = await seedEmployee(c, `t0736-cr-deact-${uuid().slice(0, 6)}`, {
        deactivatedAt: 500_000,
      });
      fx.agent = await seedEmployee(c, `t0736-cr-agent-${uuid().slice(0, 6)}`, { kind: 'agent' });

      pendingGrantId = await seedPendingGrant(c, fx.roleId, fx.proposer.slug);
      await c.query('COMMIT');
    });

    const router = new Router();
    registerRightsChangeRequestRoutes(router, pool);
    const server = http.createServer(router.dispatch.bind(router));
    await new Promise<void>((resolve) => {
      server.listen(0, 'localhost', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
    closeServer = () => new Promise((res) => server.close(() => res()));
  });

  afterAll(async () => {
    await closeServer();
    if (pool) await pool.end();
  });

  // ---------------------------------------------------------------------------
  // AC-1 — an ordinary ACTIVE human with no admin/owner authority still sees
  // the queue: this LIST is NOT narrowed to admin/owner (matches the
  // write-path's actual eligibility model, T-0044 ADR §9).
  // ---------------------------------------------------------------------------
  it('AC-1: ordinary active human (no admin/owner authority) -> 200, sees the pending item', async () => {
    const r = await req('/api/rights/change-requests', { 'x-dev-user': fx.plainMember.slug });
    expect(r.status, r.body).toBe(200);
    const body = JSON.parse(r.body) as { change_requests: Array<{ id: string }> };
    expect(body.change_requests.some((cr) => cr.id === pendingGrantId)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC-2 — a DEACTIVATED human (still-live dev-header/JWT) -> 403.
  // ---------------------------------------------------------------------------
  it('AC-2: DEACTIVATED human -> 403 FORBIDDEN', async () => {
    const r = await req('/api/rights/change-requests', { 'x-dev-user': fx.deactivatedMember.slug });
    expect(r.status, r.body).toBe(403);
    const body = JSON.parse(r.body) as { error?: { code: string } };
    expect(body.error?.code).toBe('FORBIDDEN');
  });

  // ---------------------------------------------------------------------------
  // AC-3 — an agent (kind='agent') -> 403 AGENT_NOT_ALLOWED (DC-3, mirrors the
  // sibling approve/reject routes on this same file).
  // ---------------------------------------------------------------------------
  it('AC-3: agent actor -> 403 AGENT_NOT_ALLOWED', async () => {
    const r = await req('/api/rights/change-requests', { 'x-dev-user': fx.agent.slug });
    expect(r.status, r.body).toBe(403);
    const body = JSON.parse(r.body) as { error?: { code: string } };
    expect(body.error?.code).toBe('AGENT_NOT_ALLOWED');
  });
});
