// Live behavioral probes over the T-0053 baseline. Covers FF-DENY · FF-SCOPE ·
// FF-APPEND (live half). Run in the `db` CI job / locally against compose PG.
//
// NOTE: choros_migrator is subject to FORCE RLS too, so seeds set
// choros.tenant_id within the transaction (default-DENY otherwise).

import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, appUrl, withClient, TENANT_A, TENANT_B, uuid } from './_helpers.js';

async function seedApplication(
  c: pg.Client,
  tenant: string,
  slug: string,
): Promise<void> {
  await c.query(`SET LOCAL choros.tenant_id = '${tenant}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 0, 0)`,
    [tenant, uuid(), slug],
  );
}

describe('FF-DENY: default-DENY — app role with no tenant context sees 0 rows', () => {
  beforeAll(async () => {
    // Seed one application under tenant-A as migrator.
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await seedApplication(c, TENANT_A, `deny-seed-${uuid().slice(0, 8)}`);
      await c.query('COMMIT');
    });
  });

  it('choros_app with NO choros.tenant_id GUC counts 0 rows on application', async () => {
    await withClient(appUrl(), async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM choros.application`);
      expect(rows[0].n).toBe(0);
    });
  });

  it('choros_app WITH the tenant-A GUC sees the seeded row(s)', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM choros.application`);
      await c.query('COMMIT');
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('FF-SCOPE: scoped uniqueness + tenant_id NOT NULL', () => {
  it('same slug allowed across tenants, forbidden within one (23505)', async () => {
    const slug = `scope-${uuid().slice(0, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      // (A, slug) ok
      await c.query('BEGIN');
      await seedApplication(c, TENANT_A, slug);
      await c.query('COMMIT');
      // (B, slug) ok — same business key, different tenant
      await c.query('BEGIN');
      await seedApplication(c, TENANT_B, slug);
      await c.query('COMMIT');
      // (A, slug) again ⇒ unique violation
      await c.query('BEGIN');
      await expect(seedApplication(c, TENANT_A, slug)).rejects.toMatchObject({
        code: '23505',
      });
      await c.query('ROLLBACK');
    });
  });

  it('tenant_id = NULL is rejected by NOT NULL (23502)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(
          `INSERT INTO choros.application
             (tenant_id, id, slug, display_name, created_at, updated_at)
           VALUES (NULL, $1, $2, $2, 0, 0)`,
          [uuid(), `null-${uuid().slice(0, 8)}`],
        ),
      ).rejects.toMatchObject({ code: '23502' });
      await c.query('ROLLBACK');
    });
  });
});

describe('FF-APPEND (live): choros_app cannot UPDATE/DELETE audit_event', () => {
  beforeAll(async () => {
    // Seed an audit_event row under tenant-A as migrator (INSERT is allowed).
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await c.query(
        `INSERT INTO choros.audit_event
           (tenant_id, seq, id, type, actor, payload, occurred_at,
            prev_hash, row_hash, vocab_version)
         VALUES ($1, 1, $2, 'seed', 'tester', '{}'::jsonb, 0,
                 '\\x00'::bytea, '\\x01'::bytea, 1)
         ON CONFLICT DO NOTHING`,
        [TENANT_A, uuid()],
      );
      await c.query('COMMIT');
    });
  });

  it('choros_app UPDATE on audit_event fails', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(`UPDATE choros.audit_event SET actor = 'x'`),
      ).rejects.toBeDefined();
      await c.query('ROLLBACK');
    });
  });

  it('choros_app DELETE on audit_event fails', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(`DELETE FROM choros.audit_event`),
      ).rejects.toBeDefined();
      await c.query('ROLLBACK');
    });
  });

  it('even choros_migrator cannot UPDATE audit_event (trigger blocks all roles)', async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT_A}'`);
      await expect(
        c.query(`UPDATE choros.audit_event SET actor = 'x'`),
      ).rejects.toBeDefined();
      await c.query('ROLLBACK');
    });
  });
});
