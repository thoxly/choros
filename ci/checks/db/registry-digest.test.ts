/**
 * ci/checks/db/registry-digest.test.ts — T-0607 (а, AC-3) live Postgres.
 *
 * Run in the `db` CI job via `npm run fitness:db` (vitest --dir ci/checks/db).
 *
 * The live defect (столп 6): the analyst read only the S3 journal — listRecords
 * was never wired — so «сколько заведено?» answered «записей нет» while the user
 * SEES the section. This test proves the fix DAO reads entity data IN THE ACTOR'S
 * OWN RIGHTS, through the READ-PDP path:
 *
 *   AC-3a: a registered tenant's OWNER (holds the default-open READ grant, T-0570)
 *          → loadReadableRegistryDigest returns the seeded registry with
 *          visibleCount >= 1 and a non-empty sample.
 *   AC-3b: a second employee with NO READ grant (not assigned role-reader)
 *          → the SAME registry shows visibleCount 0 (rights are respected —
 *          nothing wider than the actor's grants).
 *
 * HERMETIC: fresh registered tenant per run; migrator-user cleanup after.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';
import { loadReadableRegistryDigest } from '../../../src/db/registry-digest-dao.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();

describe.skipIf(!LIVE)('T-0607 (AC-3) — analyst registry digest in actor rights (live Postgres)', () => {
  let migPool: pg.Pool;

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
  });

  afterAll(async () => {
    if (!LIVE) return;
    if (migPool) await migPool.end();
  });

  async function registerOne(label: string): Promise<{ tenantId: string; ownerSlug: string }> {
    const kc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await registerTenant(
      { pool: migPool, kc, nowMs: NOW },
      { orgName: `T-0607 ${label} ${stamp}`, email: `t0607-${label}-${stamp}@example.com`, password: 'digest-pw-1' },
    );
    return { tenantId: res.tenantId, ownerSlug: res.userId };
  }

  async function seedRegistryWithRecord(tenantId: string, createdBy: string): Promise<{ appId: string; regId: string; regSlug: string }> {
    const appId = uuid();
    const regId = uuid();
    const recId = uuid();
    const regSlug = `reg-${Math.random().toString(36).slice(2, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      // PUBLISHED application (the digest lists published-tier registries).
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'Каталог (тест)', NULL, 'published', 0, 0)`,
        [tenantId, appId, `app-${regSlug}`],
      );
      await c.query(
        `INSERT INTO choros.registry_def
           (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'Каталог позиций (тест)', NULL, $5::jsonb, 0, 0)`,
        [tenantId, regId, appId, regSlug, JSON.stringify({ type: 'object', properties: { title: { type: 'string' } } })],
      );
      await c.query(
        `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4::jsonb, 0, 0, $5)`,
        [tenantId, recId, regId, JSON.stringify({ title: 'Позиция-Альфа' }), createdBy],
      );
      await c.query('COMMIT');
    });
    return { appId, regId, regSlug };
  }

  /** Add a second employee (no role-reader assignment → no READ grant). */
  async function addNonReaderEmployee(tenantId: string): Promise<string> {
    const empId = uuid();
    const slug = `viewer-${Math.random().toString(36).slice(2, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.employee
           (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', 'Второй пользователь', NULL, 0, 0)`,
        [tenantId, empId, slug],
      );
      await c.query('COMMIT');
    });
    return slug;
  }

  async function cleanup(tenantId: string): Promise<void> {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      // Bypass the tier-published write-lock (T-0087 FR-4) for cleanup only.
      await c.query(`SET LOCAL choros.promoting = '1'`);
      await c.query(`DELETE FROM choros.record WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.registry_def WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.application WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.agent_card WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [tenantId]);
      await c.query('COMMIT');
    });
  }

  it('AC-3a: owner (READ grant) sees the registry with count>=1 + sample; AC-3b: non-reader sees 0', async () => {
    const { tenantId, ownerSlug } = await registerOne('Digest');
    try {
      const { regSlug } = await seedRegistryWithRecord(tenantId, ownerSlug);

      // AC-3a — owner sees the entity data (столп 6 blindness closed).
      const ownerDigest = await loadReadableRegistryDigest(migPool, tenantId, ownerSlug, NOW());
      expect(ownerDigest.degraded).toBe(false);
      const ownerEntry = ownerDigest.registries.find((r) => r.slug === regSlug);
      expect(ownerEntry).toBeDefined();
      expect(ownerEntry!.visibleCount).toBeGreaterThanOrEqual(1);
      expect(ownerEntry!.samples.length).toBeGreaterThanOrEqual(1);
      expect(ownerEntry!.samples.join(' ')).toContain('Позиция-Альфа');

      // AC-3b — a second employee with NO READ grant sees 0 records (rights honoured).
      const viewerSlug = await addNonReaderEmployee(tenantId);
      const viewerDigest = await loadReadableRegistryDigest(migPool, tenantId, viewerSlug, NOW());
      expect(viewerDigest.degraded).toBe(false);
      const viewerEntry = viewerDigest.registries.find((r) => r.slug === regSlug);
      // The registry may be listed, but with ZERO readable records (or absent).
      if (viewerEntry) {
        expect(viewerEntry.visibleCount).toBe(0);
        expect(viewerEntry.samples.length).toBe(0);
      }
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);
});
