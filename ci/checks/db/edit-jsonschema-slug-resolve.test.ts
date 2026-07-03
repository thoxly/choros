/**
 * ci/checks/db/edit-jsonschema-slug-resolve.test.ts — T-0607 (в1, AC-6) live Postgres.
 *
 * Run in the `db` CI job via `npm run fitness:db`.
 *
 * The live defect: the configurator LLM has no id↔slug↔name catalogue, so it
 * passed a SLUG where the executor's SQL required a raw UUID (registry_def.id) →
 * «invalid input syntax for type uuid: "<slug>"». 4/4 ops silently failed while
 * the report said «Все поля добавлены ✅». This test proves the executor now
 * accepts slug OR uuid, resolving slug→UUID in the tenant's own rights:
 *
 *   AC-6a: executeApprovedOpAsDraft(edit_jsonschema_non_destructive) with
 *          registryDefId = the registry's SLUG → returns null (success) and the
 *          new field is present in the registry_def.record_schema.
 *   AC-6b: the SAME op with a NON-EXISTENT slug → returns an HONEST op-error
 *          string (not null, no thrown exception).
 *   AC-6c: adding a field that ALREADY exists → returns a "DUPLICATE:"-prefixed
 *          error (the honest report shows «уже было», not «added»).
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

describe.skipIf(!LIVE)('T-0607 (AC-6) — edit_jsonschema slug→UUID resolution (live Postgres)', () => {
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
      { orgName: `T-0607 ${label} ${stamp}`, email: `t0607-${label}-${stamp}@example.com`, password: 'slug-pw-1' },
    );
    return res.tenantId;
  }

  async function seedRegistry(tenantId: string): Promise<{ regId: string; regSlug: string }> {
    const appId = uuid();
    const regId = uuid();
    const regSlug = `reg-${Math.random().toString(36).slice(2, 8)}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'Прил (тест)', NULL, 'draft', 0, 0)`,
        [tenantId, appId, `app-${regSlug}`],
      );
      await c.query(
        `INSERT INTO choros.registry_def
           (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'Реестр (тест)', NULL, $5::jsonb, 0, 0)`,
        [tenantId, regId, appId, regSlug, JSON.stringify({ type: 'object', properties: {} })],
      );
      await c.query('COMMIT');
    });
    return { regId, regSlug };
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

  it('AC-6a: slug identifier resolves and the field lands; AC-6b: unknown slug → honest error; AC-6c: duplicate → DUPLICATE', async () => {
    const tenantId = await registerOne('SlugResolve');
    try {
      const { regId, regSlug } = await seedRegistry(tenantId);

      // AC-6a — passing the SLUG (what the LLM actually knows) must work now.
      const errOk = await executeApprovedOpAsDraft(migPool, tenantId, addFieldOp(regSlug, 'amount'));
      expect(errOk).toBeNull();
      const schema = await readSchema(tenantId, regId);
      const props = (schema['properties'] ?? {}) as Record<string, unknown>;
      expect(props['amount']).toBeDefined();

      // AC-6b — a non-existent slug → honest op-error string, NOT a throw.
      const errUnknown = await executeApprovedOpAsDraft(
        migPool, tenantId, addFieldOp('no-such-registry-xyz', 'foo'),
      );
      expect(errUnknown).not.toBeNull();
      expect(String(errUnknown)).toMatch(/не найден/);
      expect(String(errUnknown)).not.toMatch(/invalid input syntax/);

      // AC-6c — re-adding the same field → DUPLICATE-prefixed error (report shows «уже было»).
      const errDup = await executeApprovedOpAsDraft(migPool, tenantId, addFieldOp(regSlug, 'amount'));
      expect(errDup).not.toBeNull();
      expect(String(errDup)).toMatch(/^DUPLICATE:/);
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);
});
