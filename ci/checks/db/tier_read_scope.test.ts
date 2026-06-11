// T-0087 · tier_read_scope — live Postgres probe for FF-6 (AC-6).
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
//
// Covers:
//   FF-6  — published-context reads return 0 draft rows (AC-6 / FR-5)
//           readTierScope unit half is in src/__tests__/env-tier.test.ts

import { describe, it, expect } from 'vitest';
import { appUrl, withClient, uuid, TENANT_A } from './_helpers.js';
import { readTierScope } from '../../../src/core/env-tier.js';

const TENANT = TENANT_A;

// ---------------------------------------------------------------------------
// Helper: seed a registry_def + record at the given tier
// ---------------------------------------------------------------------------

async function seedApp(url: string, tenantId: string): Promise<string> {
  const id = uuid();
  await withClient(url, async (c) => {
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(
      `INSERT INTO choros.application
         (tenant_id, id, slug, display_name, tier, created_at, updated_at)
       VALUES ($1, $2, $3, 'Scope Test', 'draft', 0, 0)`,
      [tenantId, id, `scope-app-${id.slice(0, 8)}`],
    );
  });
  return id;
}

async function seedRegistryDef(url: string, tenantId: string, appId: string): Promise<string> {
  const id = uuid();
  await withClient(url, async (c) => {
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(
      `INSERT INTO choros.registry_def
         (tenant_id, id, application_id, slug, display_name, record_schema, tier, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Scope Reg', '{}', 'draft', 0, 0)`,
      [tenantId, id, appId, `scope-reg-${id.slice(0, 8)}`],
    );
  });
  return id;
}

async function seedRecord(url: string, tenantId: string, registryId: string, tier: 'draft' | 'published'): Promise<string> {
  const id = uuid();
  await withClient(url, async (c) => {
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    if (tier === 'published') {
      await c.query('BEGIN');
      await c.query("SET LOCAL choros.promoting = '1'");
      await c.query(
        `INSERT INTO choros.record
           (tenant_id, id, registry_id, data, tier, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, '{}', 'draft', 0, 0, 'test')`,
        [tenantId, id, registryId],
      );
      // Note: record is data class — tier_published_locked does NOT apply.
      // We can UPDATE directly to published (trigger is only on config tables).
      await c.query(
        `UPDATE choros.record SET tier = 'published' WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      await c.query('COMMIT');
    } else {
      await c.query(
        `INSERT INTO choros.record
           (tenant_id, id, registry_id, data, tier, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, '{}', 'draft', 0, 0, 'test')`,
        [tenantId, id, registryId],
      );
    }
  });
  return id;
}

// ---------------------------------------------------------------------------
// FF-6 (live) — draft records invisible in published context (AC-6)
// ---------------------------------------------------------------------------

describe('FF-6 (live): readTierScope default=published; draft rows 0 in published context', () => {
  it('readTierScope unit: default returns published, draftRequested=true returns draft', () => {
    expect(readTierScope({})).toBe('published');
    expect(readTierScope({ draftRequested: true })).toBe('draft');
    expect(readTierScope({ draftRequested: false })).toBe('published');
  });

  it('draft records do not appear in published-context query (AC-6)', async () => {
    const appId = await seedApp(appUrl(), TENANT);
    const regId = await seedRegistryDef(appUrl(), TENANT, appId);

    // Seed 2 draft records and 1 published record
    await seedRecord(appUrl(), TENANT, regId, 'draft');
    await seedRecord(appUrl(), TENANT, regId, 'draft');
    const pubId = await seedRecord(appUrl(), TENANT, regId, 'published');

    const publishedTier = readTierScope({});           // "published"
    const draftTier = readTierScope({ draftRequested: true }); // "draft"

    await withClient(appUrl(), async (c) => {
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);

      // Published context: only the 1 published record visible for this registry
      const pubRes = await c.query(
        `SELECT id FROM choros.record
          WHERE tenant_id = $1 AND registry_id = $2 AND tier = $3`,
        [TENANT, regId, publishedTier],
      );
      expect(pubRes.rows.length).toBe(1);
      expect(pubRes.rows[0].id).toBe(pubId);

      // Draft context: only the 2 draft records visible
      const draftRes = await c.query(
        `SELECT id FROM choros.record
          WHERE tenant_id = $1 AND registry_id = $2 AND tier = $3`,
        [TENANT, regId, draftTier],
      );
      expect(draftRes.rows.length).toBe(2);
    });
  });

  it('default application query in published context returns 0 draft-only apps', async () => {
    const appId = await seedApp(appUrl(), TENANT);

    const publishedTier = readTierScope({});

    await withClient(appUrl(), async (c) => {
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const res = await c.query(
        `SELECT id FROM choros.application
          WHERE tenant_id = $1 AND id = $2 AND tier = $3`,
        [TENANT, appId, publishedTier],
      );
      // The app is draft — it must not appear in published context
      expect(res.rows.length).toBe(0);
    });
  });
});
