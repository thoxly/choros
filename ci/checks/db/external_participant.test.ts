// T-0205 · ADR T-0122 §2.1 (FR-1) — external participant v1 = directory record.
//
// Live Postgres probes (run in the `db` CI job / locally):
//   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
//
// Proves the v1 DATA-ONLY external participant:
//   - createExternalParticipant inserts an ordinary choros.record under the
//     system external-participant directory (registry_def, migration 056).
//   - get/list return the tenant's own records.
//   - TENANT ISOLATION (T-0013, the 152-FZ invariant): from the choros_app role
//     (NOBYPASSRLS), tenant A CANNOT see tenant B's external participants —
//     neither via list nor via get-by-id (cross-tenant id reads as not-found).
//   - Creation appends a T-0016 audit_event (external_participant.create).
//
// SCOPE GUARD: this exercises the v1 directory record ONLY. The tokenized external
// surface (external_surface / external_token) is Stage-2 and intentionally untested
// here — it does not exist in v1.
//
// Seeds go through migratorUrl() (bypasses RLS). The model's data ops run through
// an explicit choros_app pool (appUrl) so RLS is the thing under test — same
// strategy as cross_tenant.test.ts. Test tenants TENANT_A/_B are distinct from the
// dev-seed tenant (a0…0001), so rows never collide with migration seeds.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';
import {
  createExternalParticipant,
  getExternalParticipant,
  listExternalParticipants,
  EXTERNAL_PARTICIPANT_REGISTRY_ID,
} from '../../../src/db/external-participant.js';

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
// Seed helpers (migrator role — bypasses RLS).
// Each test tenant gets: tenant row → application → external-participant
// registry_def with the well-known EXTERNAL_PARTICIPANT_REGISTRY_ID (PK is
// (tenant_id, id), so the same id across tenants is correct and expected).
// ---------------------------------------------------------------------------

const APP_ID = 'a5000000-0000-0000-0000-000000000001';

async function seedDirectory(c: pg.Client, tenantId: string): Promise<void> {
  await c.query(
    `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
     VALUES ($1, $1, $2, $2, 0) ON CONFLICT DO NOTHING`,
    [tenantId, `ep-tenant-${tenantId.slice(0, 8)}`],
  );
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, 'external-directory', 'External directory', 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, APP_ID],
  );
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema,
        is_system, created_at, updated_at)
     VALUES ($1, $2, $3, 'external-participant', 'External participants',
             '{}'::jsonb, true, 0, 0)
     ON CONFLICT DO NOTHING`,
    [tenantId, EXTERNAL_PARTICIPANT_REGISTRY_ID, APP_ID],
  );
}

let appPool: pg.Pool;

beforeAll(async () => {
  if (!process.env['DATABASE_URL']) return;
  await withClient(migratorUrl(), async (c) => {
    await seedDirectory(c, TENANT_A);
    await seedDirectory(c, TENANT_B);
  });
  appPool = new pg.Pool({ connectionString: appUrl() });

  // DIAGNOSTIC (temporary): replicate the audit writer's exact head sequence via the
  // choros_app pool client, then read row_hash back — under TENANT_B so we don't
  // disturb TENANT_A's chain.
  const ZERO = Buffer.alloc(32, 0);
  const NONZERO = Buffer.from('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20', 'hex');
  const dc = await appPool.connect();
  try {
    await dc.query('BEGIN');
    await dc.query(`SET LOCAL choros.tenant_id = '${TENANT_B}'`);
    await dc.query('SET LOCAL search_path TO choros');
    await dc.query('CREATE TEMP TABLE ep_diag (k int, v bytea) ON COMMIT DROP');
    await dc.query('INSERT INTO ep_diag VALUES (1, $1), (2, $2)', [ZERO, NONZERO]);
    const rs = await dc.query('SELECT k, length(v) AS n FROM ep_diag ORDER BY k');
    const inlineZero = await dc.query('SELECT length($1::bytea) AS n', [ZERO]);
    // eslint-disable-next-line no-console
    console.log('[DIAG ep] Pool col-store:', {
      zeroColLen: (rs.rows.find((r) => (r as { k: number }).k === 1) as { n: number }).n,
      nonzeroColLen: (rs.rows.find((r) => (r as { k: number }).k === 2) as { n: number }).n,
      zeroInlineLen: (inlineZero.rows[0] as { n: number }).n,
    });
    await dc.query('ROLLBACK');
  } finally {
    dc.release();
  }
});

afterAll(async () => {
  if (appPool) await appPool.end();
});

// ---------------------------------------------------------------------------
// Live DB: create / get / list (single tenant).
// ---------------------------------------------------------------------------

describe('external participant directory — create/get/list (live db)', () => {
  it(
    'create → returns record; get and list see it',
    requireDb(async () => {
      const created = await createExternalParticipant({
        pool: appPool,
        tenantId: TENANT_A,
        actor: 'ep-tester-a',
        data: { display_name: 'Контрагент A1', kind: 'counterparty', inn: '5000000001' },
      });
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(created.data.display_name).toBe('Контрагент A1');
      expect(created.createdBy).toBe('ep-tester-a');

      const fetched = await getExternalParticipant({
        pool: appPool,
        tenantId: TENANT_A,
        id: created.id,
      });
      expect(fetched).not.toBeNull();
      expect(fetched!.data.kind).toBe('counterparty');

      const list = await listExternalParticipants({ pool: appPool, tenantId: TENANT_A });
      expect(list.some((p) => p.id === created.id)).toBe(true);
    }),
  );

  it(
    'create writes a T-0016 audit_event (external_participant.create)',
    requireDb(async () => {
      const created = await createExternalParticipant({
        pool: appPool,
        tenantId: TENANT_A,
        actor: 'ep-tester-audit',
        data: { display_name: 'Контрагент Audit', kind: 'counterparty' },
      });
      // Read the audit_event under tenant A's RLS context (app role).
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        await client.query('SET LOCAL search_path TO choros');
        const { rows } = await client.query(
          `SELECT type, actor, subject FROM choros.audit_event
            WHERE tenant_id = $1 AND subject = $2 AND type = 'external_participant.create'`,
          [TENANT_A, created.id],
        );
        await client.query('COMMIT');
        expect(rows.length).toBe(1);
        expect((rows[0] as { actor: string }).actor).toBe('ep-tester-audit');
      } finally {
        client.release();
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// Live DB: TENANT ISOLATION — the load-bearing assertion.
// ---------------------------------------------------------------------------

describe('external participant directory — tenant isolation (live db, choros_app NOBYPASSRLS)', () => {
  it(
    'tenant A cannot see tenant B external participants (list)',
    requireDb(async () => {
      const a = await createExternalParticipant({
        pool: appPool,
        tenantId: TENANT_A,
        actor: 'iso-a',
        data: { display_name: 'Only-A', kind: 'counterparty' },
      });
      const b = await createExternalParticipant({
        pool: appPool,
        tenantId: TENANT_B,
        actor: 'iso-b',
        data: { display_name: 'Only-B', kind: 'visitor' },
      });

      const listA = await listExternalParticipants({ pool: appPool, tenantId: TENANT_A });
      const listB = await listExternalParticipants({ pool: appPool, tenantId: TENANT_B });

      const idsA = listA.map((p) => p.id);
      const idsB = listB.map((p) => p.id);

      expect(idsA).toContain(a.id);
      expect(idsA).not.toContain(b.id); // A never sees B's record
      expect(idsB).toContain(b.id);
      expect(idsB).not.toContain(a.id); // B never sees A's record
    }),
  );

  it(
    'tenant A get-by-id of a tenant B record → null (cross-tenant id invisible)',
    requireDb(async () => {
      const b = await createExternalParticipant({
        pool: appPool,
        tenantId: TENANT_B,
        actor: 'iso-b2',
        data: { display_name: 'Cross-probe-B', kind: 'counterparty' },
      });
      // Same id, but asked for under tenant A's context → RLS hides it → null.
      const leaked = await getExternalParticipant({
        pool: appPool,
        tenantId: TENANT_A,
        id: b.id,
      });
      expect(leaked).toBeNull();
    }),
  );
});

// silence unused-import lint when DB is absent (uuid kept for parity with siblings)
void uuid;
