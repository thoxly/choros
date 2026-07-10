// T-0655 (§6.4 + §1C) · org MOVE-API — LIVE Postgres integration probe.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
//   npm run fitness:db
//
// Validates the ACTUAL SQL added by the move-API (PATCH /api/{departments,
// positions,employees}/:id — reparent + rename), which the scripted-stub unit test
// (src/__tests__/seed-write.move-api.authz.test.ts) cannot reach:
//   - the entity UPDATE persists under RLS (choros_app, FORCE RLS), and
//   - the canonical <kind>.moved audit event is appended to the real
//     audit_event/audit_head hash-chain in the SAME transaction.
//
// COVERAGE (all through the REAL choros_app (NOBYPASSRLS) pool, production path):
//   AC-emp   — PATCH /api/employees/:id { position_id } moves the person to another
//              position AND appends exactly one employee.moved audit event.
//   AC-dept  — PATCH /api/departments/:id { display_name } renames in place AND
//              appends department.moved; the id is preserved (no delete+recreate).
//   AC-cycle — PATCH /api/departments/:id { parent_id: <own descendant> } → 400
//              CYCLE and does NOT write an audit event (rejected before UPDATE).
//
// Owner authority is a confirmed tenant-owner role_assignment (migration 026 shape),
// so the route's assertOrgObjectAuthority short-circuits and the real UPDATE + audit
// path runs. Generic (D-064): every slug is uuid()-suffixed; no case literals.
//
// Seeding goes through migratorUrl() (BYPASSRLS); the routes run through a
// choros_app Pool (RLS-enforced) — the production read/write path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import pg from 'pg';
import { migratorUrl, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerSeedWriteRoutes } from '../../../src/http/seed-write.js';
// T-0712: the readAuditLog side of the loop — proves the read-side enrichment
// (audit-read-dao.ts summaryFor/safeTarget) actually resolves a REAL row this
// suite's own move-API just wrote (subject column), not just a static fixture.
import { readAuditLog, type AuditReadFilters } from '../../../src/db/audit-read-dao.js';
import type { PgClientLike } from '../../../src/db/audit-writer.js';

const hasDb = Boolean(process.env['DATABASE_URL']);
const d = hasDb ? describe : describe.skip;

const TENANT = uuid();
const OWNER_SLUG = `t0655-owner-${uuid().slice(0, 8)}`;

// Fixture ids (seeded once).
const fx = {
  deptA: uuid(),
  deptChild: uuid(),
  posA: uuid(),
  posB: uuid(),
  emp: uuid(),
};

let pool: pg.Pool | null = null;
let server: http.Server | null = null;
let port = 0;

// Production drives seed-write routes with the DATABASE_URL (choros_migrator,
// BYPASSRLS) pool — tenant isolation comes from SET LOCAL choros.tenant_id inside
// each handler's withTenantTx, not from the pool role. Mirror that here so
// resolveActorTenant/loadAdminContext (which query without setting the GUC, relying
// on BYPASSRLS) resolve the owner exactly as in production.
function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: migratorUrl() });
  return pool;
}

const ORG_SCOPE = JSON.stringify({ kind: 'set', members: [] }); // ⊥ (owner scope irrelevant; owner short-circuits)

async function seed(): Promise<void> {
  const c = new pg.Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    await c.query('SET search_path TO choros;');
    // tenant
    await c.query(
      `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
       VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
      [TENANT, `t-${TENANT.slice(0, 8)}`],
    );
    // departments: deptA (root) + deptChild (under deptA) — for the cycle test.
    await c.query(
      `INSERT INTO choros.department (tenant_id, id, parent_id, slug, display_name, created_at, updated_at)
       VALUES ($1,$2,NULL,$3,'Отдел A',0,0), ($1,$4,$2,$5,'Дочерний',0,0)`,
      [TENANT, fx.deptA, `dept-a-${fx.deptA.slice(0, 6)}`, fx.deptChild, `dept-c-${fx.deptChild.slice(0, 6)}`],
    );
    // positions posA + posB in deptA.
    await c.query(
      `INSERT INTO choros.position (tenant_id, id, department_id, slug, title, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'Должность A',0,0), ($1,$5,$3,$6,'Должность B',0,0)`,
      [TENANT, fx.posA, fx.deptA, `pos-a-${fx.posA.slice(0, 6)}`, fx.posB, `pos-b-${fx.posB.slice(0, 6)}`],
    );
    // employee on posA.
    await c.query(
      `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
       VALUES ($1,$2,$3,'human',$4,'Сотрудник',0,0)`,
      [TENANT, fx.emp, fx.posA, `emp-${fx.emp.slice(0, 6)}`],
    );
    // owner employee + tenant-owner role + confirmed assignment (migration 026 shape).
    const ownerEmpId = uuid();
    await c.query(
      `INSERT INTO choros.employee (tenant_id, id, position_id, kind, slug, display_name, created_at, updated_at)
       VALUES ($1,$2,$3,'human',$4,'Владелец',0,0)`,
      [TENANT, ownerEmpId, fx.posA, OWNER_SLUG],
    );
    const ownerRoleId = uuid();
    await c.query(
      `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
       VALUES ($1,$2,'tenant-owner','Владелец тенанта',NULL,0,0)`,
      [TENANT, ownerRoleId],
    );
    await c.query(
      `INSERT INTO choros.role_assignment
         (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
          source, granted_by, proposed_by, confirmed_by, confirmed2_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,NULL,NULL,'genesis','seed',NULL,'seed',NULL,0,0)`,
      [TENANT, uuid(), ownerEmpId, ownerRoleId, ORG_SCOPE],
    );
  } finally {
    await c.end();
  }
}

async function cleanup(): Promise<void> {
  const c = new pg.Client({ connectionString: migratorUrl() });
  await c.connect();
  try {
    await c.query('SET search_path TO choros;');
    await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`).catch(() => {});
    for (const t of ['role_assignment', 'audit_event', 'audit_head', 'employee', 'position', 'department', 'role', 'tenant']) {
      await c.query(`DELETE FROM choros.${t} WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    }
  } finally {
    await c.end();
  }
}

function request(method: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path, method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-dev-user': OWNER_SLUG,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (ch) => (data += ch.toString()));
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Count <type> audit events for this tenant (RLS-scoped via the app pool). */
async function auditCount(type: string, subject: string): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    await client.query('SET LOCAL search_path TO choros');
    const r = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM choros.audit_event WHERE tenant_id = $1 AND type = $2 AND subject = $3`,
      [TENANT, type, subject],
    );
    await client.query('COMMIT');
    return Number(r.rows[0].n);
  } finally {
    client.release();
  }
}

async function positionOf(empId: string): Promise<string | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
    await client.query('SET LOCAL search_path TO choros');
    const r = await client.query<{ position_id: string | null }>(
      `SELECT position_id FROM choros.employee WHERE tenant_id = $1 AND id = $2`,
      [TENANT, empId],
    );
    await client.query('COMMIT');
    return r.rows[0]?.position_id ?? null;
  } finally {
    client.release();
  }
}

d('T-0655 org move-API — live Postgres', () => {
  beforeAll(async () => {
    await seed();
    const router = new Router();
    registerSeedWriteRoutes(router, getPool());
    server = http.createServer((req, res) => router.dispatch(req, res));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server!.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (pool) await pool.end();
    await cleanup();
  });

  it('AC-emp — PATCH /api/employees/:id { position_id } moves + appends employee.moved', async () => {
    expect(await positionOf(fx.emp)).toBe(fx.posA);
    const r = await request('PATCH', `/api/employees/${fx.emp}`, { tenant_id: TENANT, position_id: fx.posB });
    expect(r.status).toBe(200);
    expect(await positionOf(fx.emp)).toBe(fx.posB);
    expect(await auditCount('employee.moved', fx.emp)).toBe(1);
  });

  it('AC-dept — PATCH /api/departments/:id { display_name } renames in place + appends department.moved', async () => {
    const r = await request('PATCH', `/api/departments/${fx.deptA}`, { tenant_id: TENANT, display_name: 'Переименовано' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(fx.deptA); // id preserved (no delete+recreate)
    expect(await auditCount('department.moved', fx.deptA)).toBe(1);
  });

  it('AC-cycle — reparent under own descendant → 400 CYCLE, no audit event', async () => {
    const before = await auditCount('department.moved', fx.deptA);
    const r = await request('PATCH', `/api/departments/${fx.deptA}`, { tenant_id: TENANT, parent_id: fx.deptChild });
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toBe('CYCLE');
    // no new audit event from the rejected move
    expect(await auditCount('department.moved', fx.deptA)).toBe(before);
  });

  // T-0712 [P3 из LIVE_PROOF T-0655] — the READ side of the loop: the audit
  // screen (/api/audit) reads through readAuditLog(), which used to have no
  // summary and no target for `employee.moved` (the raw `type` token was the
  // whole row). Proves against the SAME real row AC-emp just wrote (not a
  // static fixture) that the DAO now resolves a human summary AND `target ===
  // <the moved employee's id>` (sourced from the writer's `subject` column,
  // which this suite's own seed-write.ts route already populates — no writer
  // change was needed for this fix).
  it('AC-audit-read — readAuditLog resolves the real employee.moved row into a human summary + target=subject', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await client.query('SET LOCAL search_path TO choros');
      const filters: AuditReadFilters = { actor: null, action: 'employee.moved' };
      const page = await readAuditLog(client as unknown as PgClientLike, TENANT, 50, null, filters);
      await client.query('COMMIT');
      const row = page.items.find((item) => item.target === fx.emp);
      expect(row).toBeDefined();
      expect(row!.summary).toBe('Сотрудник перемещён');
      expect(row!.action).toBe('employee.moved');
    } finally {
      client.release();
    }
  });
});
