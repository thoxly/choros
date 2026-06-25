// T-0466 · [D8-G5] capture-as-request — live Postgres probes.
//
// Run in the `db` CI job via `npm run fitness:db` (vitest --dir ci/checks/db).
// Assumes migrations applied (the db job runs the runner ×2 before this suite).
//
// What this covers (spec docs/specs/text-first-solution-builder.spec.md §3.5):
//   AC-T466-DB-1: getAuthoringDraftHolderEmployeeIds returns the SEEDED human
//                 holder (e-configurator, migration 088) and NEVER the agent
//                 employee (assistant-agent, kind='agent').
//   AC-T466-DB-2: captureConfigRequest end-to-end — a non-admin's description is
//                 filed as a config_request notification that the admin holder
//                 can SEE (recipient_id = admin employee UUID, FK-satisfied).
//   AC-T466-DB-3: when NO authoring_draft holder exists, captureConfigRequest
//                 falls back to the tenant owner (request not dropped).
//
// HERMETIC: every fixture lives under a FRESH uuid() tenant (durable lesson —
// never share TENANT_A; cross-test pollution caused false-greens). Migrator-user
// cleanup after each group (bypasses RLS).
//
// recipient_id is an EMPLOYEE UUID (choros.notification FK → employee, mig 046).

import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, uuid } from './_helpers.js';
import {
  getAuthoringDraftHolderEmployeeIds,
  findTenantOwnerEmployeeId,
} from '../../../src/db/grants-dao.js';
import { PgNotificationStore } from '../../../src/core/postgres/pgNotificationStore.js';

// ---------------------------------------------------------------------------
// Seeded dev-silo fixtures (migration 088)
// ---------------------------------------------------------------------------

const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const EMP_E_CONFIGURATOR = 'd0000000-0000-0000-0000-000000000016'; // human holder
const EMP_ASSISTANT_AGENT = 'd0000000-0000-0000-0000-000000000017'; // agent holder (must NOT be returned)

// ---------------------------------------------------------------------------
// Pool + migrator helpers
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: appUrl() });
  return _pool;
}

afterAll(async () => {
  if (_pool) await _pool.end();
});

async function withMigrator<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: migratorUrl() });
  await client.connect();
  try {
    await client.query('SET search_path TO choros;');
    return await fn(client);
  } finally {
    await client.end();
  }
}

const ORG_SCOPE = JSON.stringify({
  kind: 'node',
  hierarchy: 'org',
  nodeId: 'b0000000-0000-0000-0000-000000000099',
  nodeLevel: 'department',
});

/**
 * Seed a hermetic tenant with:
 *   - admin employee (human) holding an authoring_draft grant via a role.
 *   - requester employee (human) with NO grant.
 *   - optionally a tenant-owner role assignment for the owner employee.
 * Returns the created UUIDs. All under a fresh tenant (no shared-fixture risk).
 */
async function seedTenant(opts: {
  withAdminHolder: boolean;
  withOwner: boolean;
}): Promise<{
  tenantId: string;
  adminId: string;
  requesterId: string;
  ownerId: string;
}> {
  const tenantId = uuid();
  const adminId = uuid();
  const requesterId = uuid();
  const ownerId = uuid();
  const roleAdminId = uuid();
  const roleOwnerId = uuid();
  const grantId = uuid();
  const raAdminId = uuid();
  const raOwnerId = uuid();

  await withMigrator(async (c) => {
    await c.query('BEGIN');

    // Employees: admin + requester (+ owner) — all human.
    for (const [id, slug, name] of [
      [adminId, `admin-${adminId.slice(0, 8)}`, 'Админ'],
      [requesterId, `req-${requesterId.slice(0, 8)}`, 'Сотрудник'],
      [ownerId, `owner-${ownerId.slice(0, 8)}`, 'Владелец'],
    ] as const) {
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, kind, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, 'human', $3, $4, 0, 0)`,
        [tenantId, id, slug, name],
      );
    }

    // Roles: an authoring role + a tenant-owner role.
    await c.query(
      `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
       VALUES ($1, $2, 'role-authoring-t466', 'Авторинг', 0, 0)`,
      [tenantId, roleAdminId],
    );
    await c.query(
      `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
       VALUES ($1, $2, 'tenant-owner', 'Владелец', 0, 0)`,
      [tenantId, roleOwnerId],
    );

    // authoring_draft grant on the authoring role (CONFIRMED).
    await c.query(
      `INSERT INTO choros."grant"
         (tenant_id, id, role_id, resource_type, operation, scope, delegable,
          granted_by, confirmed_by, created_at)
       VALUES ($1, $2, $3, 'authoring_draft', 'create', $4::jsonb, false,
               'seed', 'seed', 0)`,
      [tenantId, grantId, roleAdminId, ORG_SCOPE],
    );

    // Assign admin → authoring role (CONFIRMED) when requested.
    if (opts.withAdminHolder) {
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, source, granted_by,
            confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'seed', 'seed', 'seed', 0, 0)`,
        [tenantId, raAdminId, adminId, roleAdminId, ORG_SCOPE],
      );
    }

    // Assign owner → tenant-owner role (CONFIRMED) when requested.
    if (opts.withOwner) {
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, source, granted_by,
            confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'seed', 'seed', 'seed', 0, 0)`,
        [tenantId, raOwnerId, ownerId, roleOwnerId, ORG_SCOPE],
      );
    }

    await c.query('COMMIT');
  });

  return { tenantId, adminId, requesterId, ownerId };
}

/** Drop a hermetic tenant's rows via migrator (bypasses RLS). */
async function dropTenant(tenantId: string): Promise<void> {
  await withMigrator(async (c) => {
    for (const tbl of [
      'notification',
      'role_assignment',
      'grant',
      'role',
      'employee',
    ]) {
      const name = tbl === 'grant' ? 'choros."grant"' : `choros.${tbl}`;
      await c.query(`DELETE FROM ${name} WHERE tenant_id = $1`, [tenantId]);
    }
  });
}

// ---------------------------------------------------------------------------
// captureConfigRequest — copied contract from src/http/assistant.ts.
//
// We test the DAO-driven recipient resolution + the notification INSERT (the
// route's pure side-effect) directly against live PG. This mirrors the route's
// captureConfigRequest exactly (same recipient resolution, same INSERT columns).
// ---------------------------------------------------------------------------

const CONFIG_REQUEST_EVENT_KIND = 'config_request';

async function captureConfigRequest(
  pool: pg.Pool,
  tenantId: string,
  requesterId: string,
  description: string,
): Promise<number> {
  const nowMs = Date.now();
  let recipientIds = await getAuthoringDraftHolderEmployeeIds(pool, tenantId, nowMs).catch(
    () => [] as string[],
  );
  if (recipientIds.length === 0) {
    const ownerId = await findTenantOwnerEmployeeId(pool, tenantId, nowMs).catch(() => null);
    if (ownerId) recipientIds = [ownerId];
  }
  if (recipientIds.length === 0) return 0;

  const trimmed = description.replace(/\s+/g, ' ').trim();
  const body = `Заявка на настройку:\n\n${trimmed}`;
  const title = 'Заявка на настройку системы';

  let notified = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query('SET LOCAL search_path TO choros');
    for (const recipientId of recipientIds) {
      if (recipientId === requesterId) continue;
      await client.query(
        `INSERT INTO choros.notification
           (tenant_id, id, recipient_id, event_kind, title, body, object_ref,
            is_read, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, false, $7, NULL)`,
        [tenantId, uuid(), recipientId, CONFIG_REQUEST_EVENT_KIND, title, body, nowMs],
      );
      notified++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return notified;
}

// ---------------------------------------------------------------------------
// AC-T466-DB-1: holder resolution — seeded human holder, never the agent
// ---------------------------------------------------------------------------

describe('AC-T466-DB-1: getAuthoringDraftHolderEmployeeIds resolves the human holder', () => {
  it('returns e-configurator (human) and NOT assistant-agent (agent) in dev silo', async () => {
    const holders = await getAuthoringDraftHolderEmployeeIds(getPool(), DEV_TENANT);
    // The seeded human configurator (migration 088) holds authoring_draft → present.
    expect(holders).toContain(EMP_E_CONFIGURATOR);
    // The agent employee also holds the grant, but kind='agent' → MUST be excluded
    // (agents have no notification center to read).
    expect(holders).not.toContain(EMP_ASSISTANT_AGENT);
  });
});

// ---------------------------------------------------------------------------
// AC-T466-DB-2: capture end-to-end — admin sees the config_request notification
// ---------------------------------------------------------------------------

describe('AC-T466-DB-2: captureConfigRequest files a request the admin can SEE', () => {
  it('non-admin description → config_request notification visible to the admin holder', async () => {
    const seeded = await seedTenant({ withAdminHolder: true, withOwner: false });
    try {
      const notified = await captureConfigRequest(
        getPool(),
        seeded.tenantId,
        seeded.requesterId,
        'хочу единую форму заявок на закупку с автоподсчётом суммы',
      );
      // Exactly one recipient: the admin holder.
      expect(notified).toBe(1);

      // The admin can see it in their own notification listing (own-only read).
      const store = new PgNotificationStore(getPool());
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL choros.tenant_id = '${seeded.tenantId}'`);
        await client.query('SET LOCAL search_path TO choros');
        const result = await store.list(client, { recipientId: seeded.adminId });
        await client.query('COMMIT');

        const req = result.rows.find((r) => r.eventKind === CONFIG_REQUEST_EVENT_KIND);
        expect(req, 'admin must see the captured config_request').toBeDefined();
        expect(req!.recipientId).toBe(seeded.adminId);
        expect(req!.body).toMatch(/автоподсчётом суммы/);
      } finally {
        client.release();
      }
    } finally {
      await dropTenant(seeded.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-T466-DB-3: no holder → fallback to tenant owner (request not dropped)
// ---------------------------------------------------------------------------

describe('AC-T466-DB-3: no authoring_draft holder → falls back to tenant owner', () => {
  it('with only a tenant owner, the request is routed to the owner', async () => {
    const seeded = await seedTenant({ withAdminHolder: false, withOwner: true });
    try {
      const notified = await captureConfigRequest(
        getPool(),
        seeded.tenantId,
        seeded.requesterId,
        'настройте мне процесс согласования',
      );
      expect(notified).toBe(1);

      const store = new PgNotificationStore(getPool());
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL choros.tenant_id = '${seeded.tenantId}'`);
        await client.query('SET LOCAL search_path TO choros');
        const result = await store.list(client, { recipientId: seeded.ownerId });
        await client.query('COMMIT');

        const req = result.rows.find((r) => r.eventKind === CONFIG_REQUEST_EVENT_KIND);
        expect(req, 'owner must receive the fallback config_request').toBeDefined();
        expect(req!.recipientId).toBe(seeded.ownerId);
      } finally {
        client.release();
      }
    } finally {
      await dropTenant(seeded.tenantId);
    }
  });
});
