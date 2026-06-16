// T-0088 · isolated-env live Postgres probes.
//
// Verifies the migration 072 additive column on choros.tenant and the
// config-flip model seam:
//
//   AC-DB-IE-1  Column physical_isolation_requested exists with NOT NULL DEFAULT false.
//   AC-DB-IE-2  Default is false (logical tier mode) for existing + new tenant rows.
//   AC-DB-IE-3  Column is updatable (reversible flip: false→true and back).
//   AC-DB-IE-4  RLS: the column is protected by the existing tenant RLS policy —
//               a choros_app connection in the wrong tenant context cannot read it.
//   AC-DB-IE-5  No new table was created (additive-only migration).
//
// Uses FRESH RANDOM tenant UUIDs — never reuses TENANT_A / TENANT_B to avoid
// cross-file contamination in the shared-DB CI environment.

import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, withClient } from './_helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a fresh random v4 UUID (no crypto import — uses pg client). */
function freshUuid(): string {
  return crypto.randomUUID();
}

/** Seed a minimal tenant row using the migrator role (bypasses RLS). */
async function seedTenant(
  url: string,
  tenantId: string,
  slug: string,
): Promise<void> {
  await withClient(url, async (c) => {
    await c.query(
      `INSERT INTO choros.tenant
         (tenant_id, id, slug, display_name, created_at)
       VALUES ($1, $2, $3, $3, 0)
       ON CONFLICT DO NOTHING`,
      [tenantId, tenantId, slug],
    );
  });
}

/** Clean up seeded rows after test run. */
async function deleteTenant(url: string, tenantId: string): Promise<void> {
  await withClient(url, async (c) => {
    await c.query(
      `DELETE FROM choros.tenant WHERE tenant_id = $1`,
      [tenantId],
    );
  });
}

// Track seeded tenants for cleanup.
const seededTenants: string[] = [];

afterAll(async () => {
  for (const tid of seededTenants) {
    try {
      await deleteTenant(migratorUrl(), tid);
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// AC-DB-IE-1: column exists with correct type + default
// ---------------------------------------------------------------------------
describe('AC-DB-IE-1: migration 072 additive column shape', () => {
  it('physical_isolation_requested column exists on choros.tenant with NOT NULL DEFAULT false', async () => {
    await withClient(migratorUrl(), async (c) => {
      const result = await c.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'choros'
           AND table_name = 'tenant'
           AND column_name = 'physical_isolation_requested'`,
      );
      expect(result.rows.length).toBe(1);
      const col = result.rows[0]!;
      expect(col.column_name).toBe('physical_isolation_requested');
      expect(col.data_type).toBe('boolean');
      expect(col.is_nullable).toBe('NO');      // NOT NULL
      expect(col.column_default).toBe('false'); // DEFAULT false
    });
  });
});

// ---------------------------------------------------------------------------
// AC-DB-IE-2: default is false for existing and new rows
// ---------------------------------------------------------------------------
describe('AC-DB-IE-2: default value is false (logical tier mode)', () => {
  it('freshly inserted tenant row has physical_isolation_requested = false', async () => {
    const tenantId = freshUuid();
    const slug = `ie-test-default-${tenantId.slice(0, 8)}`;
    seededTenants.push(tenantId);
    await seedTenant(migratorUrl(), tenantId, slug);

    await withClient(migratorUrl(), async (c) => {
      // SET LOCAL requires an explicit transaction.
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const result = await c.query<{ physical_isolation_requested: boolean }>(
        `SELECT physical_isolation_requested FROM choros.tenant WHERE id = $1`,
        [tenantId],
      );
      await c.query('COMMIT');
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.physical_isolation_requested).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-DB-IE-3: column is updatable (reversible flip)
// ---------------------------------------------------------------------------
describe('AC-DB-IE-3: config-flip is reversible', () => {
  it('can flip physical_isolation_requested false→true→false (reversible)', async () => {
    const tenantId = freshUuid();
    const slug = `ie-test-flip-${tenantId.slice(0, 8)}`;
    seededTenants.push(tenantId);
    await seedTenant(migratorUrl(), tenantId, slug);

    await withClient(migratorUrl(), async (c) => {
      // Escalate: false → true
      await c.query(
        `UPDATE choros.tenant
         SET physical_isolation_requested = true
         WHERE tenant_id = $1 AND id = $1`,
        [tenantId],
      );
      const r1 = await c.query<{ physical_isolation_requested: boolean }>(
        `SELECT physical_isolation_requested FROM choros.tenant
         WHERE tenant_id = $1 AND id = $1`,
        [tenantId],
      );
      expect(r1.rows[0]!.physical_isolation_requested).toBe(true);

      // De-escalate: true → false (reversible)
      await c.query(
        `UPDATE choros.tenant
         SET physical_isolation_requested = false
         WHERE tenant_id = $1 AND id = $1`,
        [tenantId],
      );
      const r2 = await c.query<{ physical_isolation_requested: boolean }>(
        `SELECT physical_isolation_requested FROM choros.tenant
         WHERE tenant_id = $1 AND id = $1`,
        [tenantId],
      );
      expect(r2.rows[0]!.physical_isolation_requested).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-DB-IE-4: RLS isolates the flag — wrong tenant context returns 0 rows
// ---------------------------------------------------------------------------
describe('AC-DB-IE-4: RLS protects physical_isolation_requested', () => {
  it('choros_app in wrong tenant context cannot read the flag', async () => {
    const tenantId = freshUuid();
    const slug = `ie-test-rls-${tenantId.slice(0, 8)}`;
    seededTenants.push(tenantId);
    await seedTenant(migratorUrl(), tenantId, slug);

    // Connect as choros_app (NOBYPASSRLS) and set a DIFFERENT tenant context.
    const wrongTenant = freshUuid();
    const client = new pg.Client({ connectionString: appUrl() });
    await client.connect();
    try {
      await client.query('SET search_path TO choros;');
      // SET LOCAL requires an explicit transaction to work as intended.
      await client.query('BEGIN');
      await client.query(`SET LOCAL choros.tenant_id = '${wrongTenant}'`);
      const result = await client.query(
        `SELECT physical_isolation_requested FROM choros.tenant
         WHERE id = $1`,
        [tenantId],
      );
      await client.query('COMMIT');
      expect(result.rows.length).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('choros_app in correct tenant context can read the flag', async () => {
    const tenantId = freshUuid();
    const slug = `ie-test-rls-ok-${tenantId.slice(0, 8)}`;
    seededTenants.push(tenantId);
    await seedTenant(migratorUrl(), tenantId, slug);

    const client = new pg.Client({ connectionString: appUrl() });
    await client.connect();
    try {
      await client.query('SET search_path TO choros;');
      await client.query(`BEGIN`);
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const result = await client.query<{ physical_isolation_requested: boolean }>(
        `SELECT physical_isolation_requested FROM choros.tenant WHERE id = $1`,
        [tenantId],
      );
      await client.query(`COMMIT`);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0]!.physical_isolation_requested).toBe(false);
    } finally {
      await client.end();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-DB-IE-5: no new table created (additive-only)
// ---------------------------------------------------------------------------
describe('AC-DB-IE-5: migration 072 created no new table', () => {
  it('no table named isolated_env, contour_config, or physical_env exists in choros schema', async () => {
    await withClient(migratorUrl(), async (c) => {
      const result = await c.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'choros'
           AND table_name IN (
             'isolated_env', 'physical_env', 'contour_config',
             'tenant_isolation', 'physical_contour'
           )`,
      );
      expect(result.rows.length).toBe(0);
    });
  });
});
