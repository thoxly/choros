// T-0128 / T-0206 · ADR docs/design/T-0128-connector-entity.adr.md §3/§5 (AC-13).
//
// Live Postgres probes (run in the `db` CI job / locally):
//   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
//
// Proves the v1 connector/integration STUB at the data-model layer:
//   - PgConnectorStore.insert/get/list/delete write & read choros.connector
//     (migration 054) through the choros_app role under RLS.
//   - TENANT ISOLATION (T-0013, the 152-FZ invariant): from choros_app
//     (NOBYPASSRLS), tenant A CANNOT see tenant B's connectors — neither via
//     list nor via get-by-id (a cross-tenant id read returns null).
//   - The connector is a STUB: this suite writes config + opaque handle + status
//     and reads them back. It makes NO external (1С/AD/SMTP/HTTP) call — there is
//     no driver day-1.
//
// SCOPE GUARD: exercises the connector RECORD only. The driver seam
// (ConnectorDriverPort) is Stage-2 and intentionally has no implementation.
//
// FRESH TENANTS: the db-tier runs all files against ONE shared cloned DB
// (globalSetup, --no-file-parallelism). To avoid cross-file contamination of the
// shared TENANT_A/_B fixtures, this suite mints its OWN random tenant ids per run
// (like audit-writer.chain.test.ts / external_participant.test.ts).
//
// Seeds (the tenant row) go through migratorUrl() (bypasses RLS). The DAO ops run
// through GUC-scoped choros_app pools (one per tenant) so RLS is what is under test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, withClient } from './_helpers.js';
import { PgConnectorStore } from '../../../src/core/postgres/pgConnectorStore.js';
import type { Connector } from '../../../src/core/connector.js';

// ---------------------------------------------------------------------------
// requireDb — skip the whole suite locally when no DATABASE_URL (no Postgres).
// ---------------------------------------------------------------------------

function requireDb<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!process.env['DATABASE_URL']) {
      console.log('[skip] DATABASE_URL not set');
      return;
    }
    return fn();
  };
}

// ---------------------------------------------------------------------------
// Fresh per-run tenant ids (avoid shared-fixture cross-file contamination).
// ---------------------------------------------------------------------------

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();

/** A GUC-scoped choros_app pool: every pooled connection SETs the tenant GUC
 *  (session-level), so PgConnectorStore's bare pool.query runs under RLS for
 *  exactly this tenant — the production wiring pattern (bridge-smoke-runner.ts). */
function makeTenantPool(tenantId: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: appUrl() });
  pool.on('connect', (c: pg.PoolClient) => {
    void c.query(`SET "choros.tenant_id" = '${tenantId.replace(/'/g, "''")}'`);
  });
  return pool;
}

async function seedTenant(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `conn-tenant-${tenantId.slice(0, 8)}`],
  );
}

function makeConnector(tenantId: string, over: Partial<Connector> = {}): Connector {
  return {
    tenantId,
    id: crypto.randomUUID(),
    kind: '1c',
    displayName: 'conn',
    config: {},
    secretHandle: null,
    status: 'disabled',
    backsEffectResourceId: null,
    createdBy: 'conn-tester',
    createdAt: 0,
    updatedBy: 'conn-tester',
    updatedAt: 0,
    ...over,
  };
}

let poolA: pg.Pool;
let poolB: pg.Pool;
let storeA: PgConnectorStore;
let storeB: PgConnectorStore;

let connA: Connector;
let connB: Connector;

beforeAll(async () => {
  if (!process.env['DATABASE_URL']) return;
  await withClient(migratorUrl(), async (c) => {
    await seedTenant(c, TENANT_A);
    await seedTenant(c, TENANT_B);
  });
  poolA = makeTenantPool(TENANT_A);
  poolB = makeTenantPool(TENANT_B);
  // Prime each pool so the GUC is applied before any query (pg@8 connect timing).
  for (const [pool, tenantId] of [[poolA, TENANT_A], [poolB, TENANT_B]] as const) {
    const c = await pool.connect();
    await c.query(`SET "choros.tenant_id" = '${tenantId}'`);
    c.release();
  }
  storeA = new PgConnectorStore(poolA);
  storeB = new PgConnectorStore(poolB);

  connA = makeConnector(TENANT_A, {
    kind: 'ad_ldap',
    displayName: 'AD-A',
    config: { host: 'ldap.a.local', port: 636 },
    secretHandle: 'vault://secret/connector/a',
    status: 'configured',
  });
  connB = makeConnector(TENANT_B, { kind: 'smtp', displayName: 'SMTP-B' });

  await storeA.insert(connA);
  await storeB.insert(connB);
});

afterAll(async () => {
  if (poolA) await poolA.end();
  if (poolB) await poolB.end();
});

// ---------------------------------------------------------------------------
// Live DB: insert / get / list / update / delete (single tenant).
// ---------------------------------------------------------------------------

describe('connector DAO — insert/get/list/update/delete (live db)', () => {
  it(
    'get and list see the inserted connector with its config + handle + status',
    requireDb(async () => {
      const fetched = await storeA.get(TENANT_A, connA.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.kind).toBe('ad_ldap');
      expect(fetched!.config).toEqual({ host: 'ldap.a.local', port: 636 });
      expect(fetched!.secretHandle).toBe('vault://secret/connector/a');
      expect(fetched!.status).toBe('configured');

      const list = await storeA.list(TENANT_A);
      expect(list.some((c) => c.id === connA.id)).toBe(true);
    }),
  );

  it(
    'update mutates fields; delete removes the row',
    requireDb(async () => {
      const tmp = makeConnector(TENANT_A, { kind: 'http_generic', displayName: 'tmp' });
      await storeA.insert(tmp);

      await storeA.update({ ...tmp, status: 'error', displayName: 'tmp-2' });
      const afterUpd = await storeA.get(TENANT_A, tmp.id);
      expect(afterUpd!.status).toBe('error');
      expect(afterUpd!.displayName).toBe('tmp-2');

      expect(await storeA.delete(TENANT_A, tmp.id)).toBe(true);
      expect(await storeA.get(TENANT_A, tmp.id)).toBeNull();
      expect(await storeA.delete(TENANT_A, tmp.id)).toBe(false);
    }),
  );
});

// ---------------------------------------------------------------------------
// Live DB: TENANT ISOLATION — the load-bearing assertion (AC-13).
// ---------------------------------------------------------------------------

describe('connector DAO — tenant isolation (live db, choros_app NOBYPASSRLS)', () => {
  it(
    'tenant A cannot see tenant B connectors, and vice versa (list)',
    requireDb(async () => {
      const listA = await storeA.list(TENANT_A);
      const listB = await storeB.list(TENANT_B);

      const idsA = listA.map((c) => c.id);
      const idsB = listB.map((c) => c.id);

      expect(idsA).toContain(connA.id);
      expect(idsB).toContain(connB.id);
      // No leakage either way.
      expect(idsA).not.toContain(connB.id);
      expect(idsB).not.toContain(connA.id);
    }),
  );

  it(
    "tenant A get-by-id of tenant B's connector returns null (cross-tenant read denied)",
    requireDb(async () => {
      expect(await storeA.get(TENANT_A, connB.id)).toBeNull();
      expect(await storeB.get(TENANT_B, connA.id)).toBeNull();
    }),
  );

  it(
    "tenant A delete of tenant B's connector affects 0 rows; B row survives",
    requireDb(async () => {
      expect(await storeA.delete(TENANT_A, connB.id)).toBe(false);
      // B's row is still there, read under B's own RLS context.
      expect(await storeB.get(TENANT_B, connB.id)).not.toBeNull();
    }),
  );
});
