/**
 * ci/checks/db/registry-digest.test.ts — T-0607 (а, AC-3) live Postgres.
 * Extended by T-0587 (ADR-T0587 §1.4/§3, FF-3/AC-2) with a NARROWER-grant
 * scenario (not just zero-vs-full) + numeric-aggregate subset proof.
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
 * T-0587 (FF-3/AC-2, §1.4): a THIRD employee with a NARROWER grant — READ
 * scoped to exactly ONE of two seeded records (record-level lattice scope,
 * `nodeLevel:"record"`, the SAME mechanism records-read-pdp.db.test.ts
 * FF-RP-5 proves) — sees `visibleCount === 1`, STRICTLY a subset of the
 * owner's `visibleCount === 2`, and `numericAggregates.sum` reflecting ONLY
 * the one visible record's numeric field — never the other record's value.
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

  // -------------------------------------------------------------------------
  // T-0587 (FF-3/AC-2): NARROWER-grant employee — record-level READ scope,
  // the same lattice mechanism records-read-pdp.db.test.ts FF-RP-5 proves.
  // -------------------------------------------------------------------------

  async function seedSecondRecord(
    tenantId: string,
    registryId: string,
    createdBy: string,
    data: Record<string, unknown>,
  ): Promise<string> {
    const recId = uuid();
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.record (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4::jsonb, 0, 0, $5)`,
        [tenantId, recId, registryId, JSON.stringify(data), createdBy],
      );
      await c.query('COMMIT');
    });
    return recId;
  }

  /** scope = a specific record node (narrow grant, self-match only — no reach into a sibling record). */
  function recordScope(recordId: string): unknown {
    return { kind: 'node', hierarchy: 'resource', nodeLevel: 'record', nodeId: recordId };
  }

  /**
   * Add a THIRD employee whose only READ grant is scoped to exactly ONE
   * record (via a dedicated role + role_assignment + record-scoped grant row)
   * — strictly narrower than the owner's tenant-wide default-open grant.
   */
  async function addNarrowGrantEmployee(tenantId: string, visibleRecordId: string): Promise<string> {
    const empId = uuid();
    const slug = `narrow-${Math.random().toString(36).slice(2, 8)}`;
    const roleId = uuid();
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', 'Третий пользователь (сужен)', NULL, 0, 0)`,
        [tenantId, empId, slug],
      );
      await c.query(
        `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, $3, 0, 0)`,
        [tenantId, roleId, `narrow-role-${roleId.slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, granted_by, confirmed_by, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'seed', 'seed', 'seed', 0, 0)`,
        [tenantId, uuid(), empId, roleId, JSON.stringify({ kind: 'set', members: [] })],
      );
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
            "constraint", delegable, granted_by, proposed_by, confirmed_by,
            valid_from, valid_until, created_at)
         VALUES ($1, $2, $3, 'record', NULL, 'read', $4::jsonb,
                 NULL, true, 'seed', NULL, 'seed', NULL, NULL, 0)`,
        [tenantId, uuid(), roleId, JSON.stringify(recordScope(visibleRecordId))],
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

  // ---------------------------------------------------------------------------
  // T-0587 (ADR-T0587 §1.4/§3, FF-3/AC-2): a registry with a NUMERIC field and
  // TWO records; a narrow-grant employee sees exactly ONE of them, strictly a
  // subset of the owner's full view — both visibleCount AND numericAggregates.
  // ---------------------------------------------------------------------------

  async function seedRegistryWithTwoNumericRecords(
    tenantId: string,
    createdBy: string,
  ): Promise<{ regId: string; regSlug: string; rec1Id: string; rec2Id: string }> {
    const appId = uuid();
    const regId = uuid();
    const regSlug = `reg-${Math.random().toString(36).slice(2, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'Раздел (тест агрегата)', NULL, 'published', 0, 0)`,
        [tenantId, appId, `app-${regSlug}`],
      );
      await c.query(
        `INSERT INTO choros.registry_def
           (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'Записи с числом (тест)', NULL, $5::jsonb, 0, 0)`,
        [
          tenantId, regId, appId, regSlug,
          JSON.stringify({
            type: 'object',
            properties: {
              title: { type: 'string' },
              amount: { type: 'number', title: 'Сумма' },
            },
          }),
        ],
      );
      await c.query('COMMIT');
    });
    const rec1Id = await seedSecondRecord(tenantId, regId, createdBy, { title: 'Запись-1', amount: 100000 });
    const rec2Id = await seedSecondRecord(tenantId, regId, createdBy, { title: 'Запись-2', amount: 250000 });
    return { regId, regSlug, rec1Id, rec2Id };
  }

  it('T-0587 (FF-3/AC-2): narrow-grant employee sees STRICTLY a subset — visibleCount AND numericAggregates.sum smaller than the owner, never the invisible record\'s value', async () => {
    const { tenantId, ownerSlug } = await registerOne('NarrowGrant');
    try {
      const { regSlug, rec1Id } = await seedRegistryWithTwoNumericRecords(tenantId, ownerSlug);

      // Owner (default-open grant, T-0570) sees BOTH records and the FULL sum.
      const ownerDigest = await loadReadableRegistryDigest(migPool, tenantId, ownerSlug, NOW());
      expect(ownerDigest.degraded).toBe(false);
      const ownerEntry = ownerDigest.registries.find((r) => r.slug === regSlug);
      expect(ownerEntry).toBeDefined();
      expect(ownerEntry!.visibleCount).toBe(2);
      expect(ownerEntry!.numericAggregates).toBeDefined();
      const ownerAgg = ownerEntry!.numericAggregates!.find((a) => a.fieldKey === 'amount');
      expect(ownerAgg).toBeDefined();
      expect(ownerAgg!.count).toBe(2);
      expect(ownerAgg!.sum).toBe(350000);

      // Narrow-grant employee — READ scoped to rec1Id ONLY — sees exactly ONE
      // record and an aggregate reflecting ONLY that record's value.
      const narrowSlug = await addNarrowGrantEmployee(tenantId, rec1Id);
      const narrowDigest = await loadReadableRegistryDigest(migPool, tenantId, narrowSlug, NOW());
      expect(narrowDigest.degraded).toBe(false);
      const narrowEntry = narrowDigest.registries.find((r) => r.slug === regSlug);
      expect(narrowEntry).toBeDefined();
      expect(narrowEntry!.visibleCount).toBe(1);
      expect(narrowEntry!.visibleCount).toBeLessThan(ownerEntry!.visibleCount);
      expect(narrowEntry!.numericAggregates).toBeDefined();
      const narrowAgg = narrowEntry!.numericAggregates!.find((a) => a.fieldKey === 'amount');
      expect(narrowAgg).toBeDefined();
      expect(narrowAgg!.count).toBe(1);
      // STRICTLY the visible record's own value (100000), NEVER the sibling
      // record's value (250000) and NEVER the full sum (350000).
      expect(narrowAgg!.sum).toBe(100000);
      expect(narrowAgg!.sum).toBeLessThan(ownerAgg!.sum);
      expect(narrowAgg!.max).toBe(100000);
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);
});
