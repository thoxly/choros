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
// FRESH TENANTS: the db-tier runs all files against ONE shared cloned DB
// (globalSetup, --no-file-parallelism). Other files seed audit_head for the shared
// TENANT_A/_B fixtures with short bytea literals, which would corrupt this suite's
// audit-chain genesis read. So this suite mints its OWN random tenant ids per run
// (like audit-writer.chain.test.ts's freshTenant), isolating it from cross-file state.
//
// Seeds go through migratorUrl() (bypasses RLS). The model's data ops run through an
// explicit choros_app pool (appUrl) so RLS is the thing actually under test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, withClient } from './_helpers.js';
import {
  createExternalParticipant,
  getExternalParticipant,
  listExternalParticipants,
  EXTERNAL_PARTICIPANT_REGISTRY_ID,
  type ExternalParticipant,
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
// Fresh per-run tenant ids (avoid shared-fixture cross-file contamination).
// ---------------------------------------------------------------------------

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const APP_ID = crypto.randomUUID();

// ---------------------------------------------------------------------------
// Seed helper (migrator role — bypasses RLS).
// Each fresh tenant gets: tenant row → application → external-participant
// registry_def with the well-known EXTERNAL_PARTICIPANT_REGISTRY_ID (PK is
// (tenant_id, id), so the same registry id across tenants is correct and expected).
// audit_head is intentionally NOT seeded — the audit writer owns genesis on the
// first append (matching audit-writer.chain.test.ts).
// ---------------------------------------------------------------------------

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

// One create per tenant, performed once in beforeAll; assertions read the results.
let recA: ExternalParticipant | undefined;
let recB: ExternalParticipant | undefined;

beforeAll(async () => {
  if (!process.env['DATABASE_URL']) return;
  await withClient(migratorUrl(), async (c) => {
    await seedDirectory(c, TENANT_A);
    await seedDirectory(c, TENANT_B);
  });
  appPool = new pg.Pool({ connectionString: appUrl() });

  recA = await createExternalParticipant({
    pool: appPool,
    tenantId: TENANT_A,
    actor: 'ep-tester-a',
    data: { display_name: 'Контрагент A1', kind: 'counterparty', inn: '5000000001' },
  });
  recB = await createExternalParticipant({
    pool: appPool,
    tenantId: TENANT_B,
    actor: 'ep-tester-b',
    data: { display_name: 'Only-B', kind: 'visitor' },
  });
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
      expect(recA!.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(recA!.data.display_name).toBe('Контрагент A1');
      expect(recA!.createdBy).toBe('ep-tester-a');

      const fetched = await getExternalParticipant({
        pool: appPool,
        tenantId: TENANT_A,
        id: recA!.id,
      });
      expect(fetched).not.toBeNull();
      expect(fetched!.data.kind).toBe('counterparty');

      const list = await listExternalParticipants({ pool: appPool, tenantId: TENANT_A });
      expect(list.some((p) => p.id === recA!.id)).toBe(true);
    }),
  );

  it(
    'create wrote a T-0016 audit_event (external_participant.create)',
    requireDb(async () => {
      // Read the audit_event under tenant A's RLS context (app role).
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
        await client.query('SET LOCAL search_path TO choros');
        const { rows } = await client.query(
          `SELECT type, actor, subject FROM choros.audit_event
            WHERE tenant_id = $1 AND subject = $2 AND type = 'external_participant.create'`,
          [TENANT_A, recA!.id],
        );
        await client.query('COMMIT');
        expect(rows.length).toBe(1);
        expect((rows[0] as { actor: string }).actor).toBe('ep-tester-a');
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
    'tenant A cannot see tenant B external participants, and vice versa (list)',
    requireDb(async () => {
      const listA = await listExternalParticipants({ pool: appPool, tenantId: TENANT_A });
      const listB = await listExternalParticipants({ pool: appPool, tenantId: TENANT_B });

      const idsA = listA.map((p) => p.id);
      const idsB = listB.map((p) => p.id);

      expect(idsA).toContain(recA!.id);
      expect(idsA).not.toContain(recB!.id); // A never sees B's record
      expect(idsB).toContain(recB!.id);
      expect(idsB).not.toContain(recA!.id); // B never sees A's record
    }),
  );

  it(
    'tenant A get-by-id of a tenant B record → null (cross-tenant id invisible)',
    requireDb(async () => {
      // recB.id exists under TENANT_B; asked for under tenant A's context → RLS hides it → null.
      const leaked = await getExternalParticipant({
        pool: appPool,
        tenantId: TENANT_A,
        id: recB!.id,
      });
      expect(leaked).toBeNull();
    }),
  );
});
