// T-0566 · DELETE /api/records/:id — hard-delete live Postgres probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:5432/choros \
//   APP_DATABASE_URL=postgres://choros_app:...@localhost:5432/choros \
//   npm run fitness:db
//
// Covers (frozen HTTP contract T-0566 §2):
//   - DELETE record → 204; the record row is gone; a record.deleted audit event
//     is appended.
//   - 404 when the record is not in the caller's tenant (RLS-filtered).
//
// Route wired exactly as server.ts: registerRecordRoutes({ pool, resolveActorTenant }).
// Authz falls back to the REAL resolveActorPrivilege against the pool (owner/admin |
// authoring_draft). The route pool uses choros_app (NOBYPASSRLS) so cross-tenant
// denial is DB-policy-enforced.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { appUrl, migratorUrl, withClient, uuid } from './_helpers.js';
import { Router } from '../../../src/http/router.js';
import { registerRecordRoutes } from '../../../src/http/records.js';

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

// FRESH random tenants (NOT the shared TENANT_A/B) — hermetic, no cross-suite pollution.
const TENANT_A = uuid();
const TENANT_B = uuid();

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === 'rec-actor-a') return TENANT_A;
  if (slug === 'rec-actor-b') return TENANT_B;
  throw new Error(`unknown test actor: ${slug}`);
}

// Seed a tenant + tenant-owner (so resolveActorPrivilege → isOwnerOrAdmin=true).
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
    // T-0764: proposed_by MUST be NULL — direct/genesis grant, not a pending
    // dual-control proposal (T-0605 canonical shape, эталон
    // T-0750-inbox-detail-authority.db.test.ts). Harmless here (sole consumer
    // isGenesisOwnerForTenant ignores proposed_by/confirmed2_by) but non-canonical.
    await c.query(
      `INSERT INTO choros.role_assignment
         (tenant_id, id, employee_id, role_id, org_scope, valid_from, valid_until,
          source, granted_by, proposed_by, confirmed_by, created_at, updated_at)
       VALUES ($1, $2, $3::uuid, $4, $5::jsonb, NULL, NULL, 'genesis', $6::text, NULL, $6::text, 0, 0)`,
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

// Seed an application + registry_def + one record; return the record id.
async function seedRecord(tenantId: string, ownerSlug: string): Promise<string> {
  const appId = uuid();
  const regId = uuid();
  const recId = uuid();
  await withClient(migratorUrl(), async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(
      `INSERT INTO choros.application (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
       VALUES ($1, $2, $3, $3, NULL, 'draft', 0, 0)`,
      [tenantId, appId, `rec-app-${appId.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO choros.registry_def (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, NULL, $5::jsonb, 0, 0)`,
      [tenantId, regId, appId, `rec-reg-${regId.slice(0, 8)}`, JSON.stringify({ type: 'object', properties: {} })],
    );
    await c.query(
      `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
       VALUES ($1, $2, $3, $4::jsonb, 0, 0, $5)`,
      [tenantId, recId, regId, JSON.stringify({ hello: 'world' }), ownerSlug],
    );
    await c.query('COMMIT');
  });
  return recId;
}

function request(
  baseUrl: string,
  method: string,
  path: string,
  actor: string,
): Promise<{ statusCode: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(baseUrl + path);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method, headers: { 'x-dev-user': actor } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch: Buffer) => chunks.push(ch));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = text; }
          resolve({ statusCode: res.statusCode ?? 0, json });
        });
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
  registerRecordRoutes(router, { pool: appPool, resolveActorTenant: stubResolveActorTenant });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  await withClient(migratorUrl(), async (c) => {
    await seedOwnerTenant(c, TENANT_A, 'rec-actor-a');
    await seedOwnerTenant(c, TENANT_B, 'rec-actor-b');
  });
});

afterAll(async () => {
  if (!hasDb) return;
  await withClient(migratorUrl(), async (c) => {
    for (const t of [TENANT_A, TENANT_B]) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${t}'`);
      for (const tbl of [
        'file_version', 'file', 'record', 'registry_def', 'application',
        'audit_event', 'audit_head', 'role_assignment', 'role', 'employee',
      ]) {
        await c.query(`DELETE FROM choros.${tbl} WHERE tenant_id = $1`, [t]).catch(() => {});
      }
      await c.query('COMMIT');
      await c.query(`DELETE FROM choros.tenant WHERE tenant_id = $1`, [t]).catch(() => {});
    }
  }).catch(() => {});
  if (appPool) await appPool.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('records API — delete (T-0566)', () => {
  it('DELETE own record → 204 + record.deleted audit; row gone', requireDb(async () => {
    const recId = await seedRecord(TENANT_A, 'rec-actor-a');

    const del = await request(baseUrl, 'DELETE', `/api/records/${recId}`, 'rec-actor-a');
    expect(del.statusCode, JSON.stringify(del.json)).toBe(204);

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const rec = await c.query(`SELECT 1 FROM choros.record WHERE tenant_id = $1 AND id = $2`, [TENANT_A, recId]);
      expect(rec.rowCount, 'record row must be gone').toBe(0);
      const audit = await c.query(
        `SELECT 1 FROM choros.audit_event
          WHERE tenant_id = $1 AND type = 'record.deleted' AND subject = $2 LIMIT 1`,
        [TENANT_A, recId],
      );
      expect(audit.rowCount, 'record.deleted audit event must exist').toBe(1);
      await c.query('COMMIT');
    });
  }));

  it('DELETE cross-tenant record → 404 (RLS-filtered); row survives', requireDb(async () => {
    const recId = await seedRecord(TENANT_B, 'rec-actor-b');

    const del = await request(baseUrl, 'DELETE', `/api/records/${recId}`, 'rec-actor-a');
    expect(del.statusCode, JSON.stringify(del.json)).toBe(404);

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
      const rec = await c.query(`SELECT 1 FROM choros.record WHERE tenant_id = $1 AND id = $2`, [TENANT_B, recId]);
      await c.query('COMMIT');
      expect(rec.rowCount, "B's record must survive A's cross-tenant delete").toBe(1);
    });
  }));

  it('DELETE unknown record id → 404', requireDb(async () => {
    const del = await request(baseUrl, 'DELETE', `/api/records/${uuid()}`, 'rec-actor-a');
    expect(del.statusCode, JSON.stringify(del.json)).toBe(404);
  }));
});
