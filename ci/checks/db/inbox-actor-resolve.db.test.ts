// ci/checks/db/inbox-actor-resolve.db.test.ts — T-0648 [W4-UX/столп 4] live-DB
// integration probe: GET /api/inbox resolves the claimant's employee.slug
// (claimedBy) to a human display name (execName) instead of leaking the raw
// slug — the exact "Исполнитель: 3462410f-…" defect docs/design/ux-study-
// 2026-07-05.md §3 documents live on the founder's stand.
//
// Hits the REAL HTTP route (registerInboxRoutes, the same handler production
// traffic uses) against a REAL Postgres, through the batch resolver added to
// findInboxItems (src/http/inbox.ts).
//
// Seed helpers mirror ci/checks/db/inbox_claim_substitution.db.test.ts
// (seedTenant/seedEmployee/seedRole/seedAssignment/seedPoolTask) — the same
// proven department→position→employee→role→role_assignment chain the claim
// eligibility gate (getRoleSlugsForActor) actually reads.
//
// Run: DATABASE_URL=... npm run fitness:db

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerInboxRoutes, type InboxWriteDeps } from '../../../src/http/inbox.js';
import { appendProcessStarted } from '../../../src/http/process-projection.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';

const hasDb = Boolean(process.env['DATABASE_URL']);

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

let server: http.Server;
let baseUrl = '';
let appPool: pg.Pool;

beforeAll(async () => {
  if (!hasDb) return;
  appPool = new pg.Pool({ connectionString: appUrl() });
  const router = new Router();
  const writeDeps: InboxWriteDeps = {
    pool: appPool,
    resolveActorTenant: async () => {
      throw new Error('unused in this probe — GET /api/inbox resolves tenant via db/org.ts');
    },
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
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Seed helpers — mirror inbox_claim_substitution.db.test.ts byte-for-byte
// (proven working department→position→employee→role→role_assignment chain).
// ---------------------------------------------------------------------------

type EmpFx = { id: string; slug: string; deptId: string };

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `t0648-inbox-${tenantId.slice(0, 8)}`],
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
    [tenantId, deptId, `t0648-dept-${deptId.slice(0, 8)}`],
  );
  const posId = uuid();
  await c.query(
    `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, 0, 0)`,
    [tenantId, posId, deptId, `t0648-pos-${posId.slice(0, 8)}`],
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

async function seedPoolTask(c: pg.Client, tenantId: string, roleSlug: string): Promise<string> {
  return appendProcessStarted(c as unknown as PgClientLike, {
    instanceId: uuid(),
    procKey: `t0648-proc-${uuid().slice(0, 6)}`,
    actor: 'system:test-seed',
    nowMs: Date.now(),
    approverRole: roleSlug,
    tenantId,
  });
}

describe('T-0648 GET /api/inbox — claimedBy resolves to a display name (live DB)', () => {
  it('a claimed task shows the claimant DISPLAY NAME in execName, not the raw slug', async () => {
    if (!hasDb) return;

    const tenantId = uuid();
    const roleSlug = `t0648-role-${uuid().slice(0, 6)}`;
    const claimantSlug = `t0648-claimant-${uuid().slice(0, 6)}`;
    const claimantName = 'Т-0648 Тестовый Клеймер';
    let taskId = '';

    const c = new pg.Client({ connectionString: migratorUrl() });
    await c.connect();
    try {
      await c.query('SET search_path TO choros;');
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await seedTenant(c, tenantId);
      const roleId = await seedRole(c, tenantId, roleSlug);
      const claimant = await seedEmployee(c, tenantId, claimantSlug, claimantName);
      await seedAssignment(c, tenantId, { empId: claimant.id, roleId });
      taskId = await seedPoolTask(c, tenantId, roleSlug);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      await c.end();
    }

    // Claim the pool task as the claimant.
    const claimRes = await makeRequest(baseUrl, 'POST', `/api/inbox/${taskId}/claim`, {
      'x-dev-user': claimantSlug,
    });
    expect(claimRes.statusCode, claimRes.body).toBe(200);

    // GET /api/inbox as the SAME actor — the claimed row's execName must be the
    // resolved DISPLAY NAME, never the raw slug.
    const listRes = await makeRequest(baseUrl, 'GET', '/api/inbox', {
      'x-dev-user': claimantSlug,
    });
    expect(listRes.statusCode, listRes.body).toBe(200);
    const parsed = JSON.parse(listRes.body) as { items: Array<Record<string, unknown>> };
    const item = parsed.items.find((i) => i['id'] === taskId);
    expect(item).toBeDefined();
    expect(item!['claimedBy']).toBe(claimantSlug);
    expect(item!['execName']).toBe(claimantName);
    expect(item!['execName']).not.toBe(claimantSlug);
    expect(item!['execType']).toBe('human');
  });
});
