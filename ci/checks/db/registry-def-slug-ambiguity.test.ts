/**
 * ci/checks/db/registry-def-slug-ambiguity.test.ts — T-0611 (live Postgres).
 *
 * Run in the `db` CI job via `npm run fitness:db`.
 *
 * The live defect (T-0607 review F4): resolveIdBySlug resolved a registry_def
 * slug with `WHERE tenant_id = $1 AND slug = $2 LIMIT 1` — NO application_id
 * filter, NO ORDER BY. registry_def is UNIQUE(tenant_id, application_id, slug),
 * so the SAME slug can legitimately exist under two different applications in
 * one tenant. On such a collision, the old query returned an ARBITRARY row —
 * the configurator could silently edit the WRONG registry's record_schema
 * while buildHonestOpsReport still showed a false ✓.
 *
 * This test proves resolveIdBySlug now refuses deterministically instead of
 * guessing:
 *
 *   AC-1/AC-2: two registries share slug "items" under two different
 *              applications in one tenant → edit_jsonschema_non_destructive
 *              against the SLUG returns an honest "неоднозначен" error,
 *              enumerating BOTH candidate applications, and — critically —
 *              NEITHER registry's record_schema is mutated.
 *   AC-3:      the raw-UUID escape hatch still works — addressing one of the
 *              two ambiguous registries by its UUID succeeds and touches
 *              ONLY that one registry.
 *   AC-4:      the non-ambiguous path (T-0607 AC-6a/b/c, exercised in
 *              edit-jsonschema-slug-resolve.test.ts) is untouched by this file
 *              — re-run alongside this one in the same fitness:db job.
 *
 * HERMETIC: fresh registered tenant per run; migrator-user cleanup after.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';
import { executeApprovedOpAsDraft } from '../../../src/http/assistant.js';
import type { ApprovedOp } from '../../../src/core/assistant-configurator.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();

describe.skipIf(!LIVE)('T-0611 — registry_def slug ambiguity across applications (live Postgres)', () => {
  let migPool: pg.Pool;

  beforeAll(async () => {
    if (!LIVE) return;
    migPool = new pg.Pool({ connectionString: migratorUrl() });
  });

  afterAll(async () => {
    if (!LIVE) return;
    if (migPool) await migPool.end();
  });

  async function registerOne(label: string): Promise<string> {
    const kc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await registerTenant(
      { pool: migPool, kc, nowMs: NOW },
      { orgName: `T-0611 ${label} ${stamp}`, email: `t0611-${label}-${stamp}@example.com`, password: 'slug-amb-pw-1' },
    );
    return res.tenantId;
  }

  /**
   * Seeds TWO applications, each with a registry_def sharing the SAME slug
   * ("items") — the precondition for the ambiguity defect.
   */
  async function seedAmbiguousPair(tenantId: string): Promise<{
    appAId: string; appASlug: string;
    appBId: string; appBSlug: string;
    regAId: string; regBId: string;
    sharedSlug: string;
  }> {
    const appAId = uuid();
    const appBId = uuid();
    const regAId = uuid();
    const regBId = uuid();
    const stamp = Math.random().toString(36).slice(2, 8);
    const appASlug = `app-a-${stamp}`;
    const appBSlug = `app-b-${stamp}`;
    const sharedSlug = `items-${stamp}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'Приложение А (тест)', NULL, 'draft', 0, 0)`,
        [tenantId, appAId, appASlug],
      );
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'Приложение Б (тест)', NULL, 'draft', 0, 0)`,
        [tenantId, appBId, appBSlug],
      );
      await c.query(
        `INSERT INTO choros.registry_def
           (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'Реестр А (тест)', NULL, $5::jsonb, 0, 0)`,
        [tenantId, regAId, appAId, sharedSlug, JSON.stringify({ type: 'object', properties: {} })],
      );
      await c.query(
        `INSERT INTO choros.registry_def
           (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'Реестр Б (тест)', NULL, $5::jsonb, 0, 0)`,
        [tenantId, regBId, appBId, sharedSlug, JSON.stringify({ type: 'object', properties: {} })],
      );
      await c.query('COMMIT');
    });
    return { appAId, appASlug, appBId, appBSlug, regAId, regBId, sharedSlug };
  }

  async function readSchema(tenantId: string, regId: string): Promise<Record<string, unknown>> {
    return withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const r = await c.query<{ record_schema: Record<string, unknown> }>(
        `SELECT record_schema FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`,
        [tenantId, regId],
      );
      await c.query('COMMIT');
      return r.rows[0]?.record_schema ?? {};
    });
  }

  function addFieldOp(registryDefIdOrSlug: string, fieldKey: string): ApprovedOp {
    return {
      kind: 'edit_jsonschema_non_destructive',
      description: `add field ${fieldKey}`,
      args: {
        registryDefId: registryDefIdOrSlug,
        fieldKey,
        fieldSchema: JSON.stringify({ type: 'string', title: fieldKey }),
        opKind: 'add_field',
      },
      tier: 'draft',
    };
  }

  async function cleanup(tenantId: string): Promise<void> {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.registry_schema_history WHERE tenant_id = $1`, [tenantId]);
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

  it('AC-1/AC-2: ambiguous slug across two apps → honest refusal, NO mutation on either registry', async () => {
    const tenantId = await registerOne('Ambiguous');
    try {
      const { appASlug, appBSlug, regAId, regBId, sharedSlug } = await seedAmbiguousPair(tenantId);
      const schemaABefore = await readSchema(tenantId, regAId);
      const schemaBBefore = await readSchema(tenantId, regBId);

      const err = await executeApprovedOpAsDraft(migPool, tenantId, addFieldOp(sharedSlug, 'amount'));

      // Honest refusal — never a thrown 500, never a silent success on the wrong target.
      expect(err).not.toBeNull();
      expect(String(err)).toMatch(/неоднозначен/);
      expect(String(err)).toContain(sharedSlug);
      // Both candidate applications named — the user/LLM has enough to disambiguate.
      expect(String(err)).toContain(appASlug);
      expect(String(err)).toContain(appBSlug);
      // Actionable guidance — re-issue with the raw UUID.
      expect(String(err)).toMatch(/UUID/);

      // CRITICAL: neither registry's record_schema was touched.
      const schemaAAfter = await readSchema(tenantId, regAId);
      const schemaBAfter = await readSchema(tenantId, regBId);
      expect(schemaAAfter).toEqual(schemaABefore);
      expect(schemaBAfter).toEqual(schemaBBefore);
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);

  it('AC-3: raw-UUID escape hatch still resolves exactly one of the two ambiguous registries', async () => {
    const tenantId = await registerOne('AmbiguousUuidEscape');
    try {
      const { regAId, regBId } = await seedAmbiguousPair(tenantId);

      // Address registry A directly by its UUID — must succeed and touch ONLY A.
      const err = await executeApprovedOpAsDraft(migPool, tenantId, addFieldOp(regAId, 'amount'));
      expect(err).toBeNull();

      const schemaA = await readSchema(tenantId, regAId);
      const propsA = (schemaA['properties'] ?? {}) as Record<string, unknown>;
      expect(propsA['amount']).toBeDefined();

      const schemaB = await readSchema(tenantId, regBId);
      const propsB = (schemaB['properties'] ?? {}) as Record<string, unknown>;
      expect(propsB['amount']).toBeUndefined();
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);
});
