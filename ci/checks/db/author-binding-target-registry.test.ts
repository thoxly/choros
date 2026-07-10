/**
 * ci/checks/db/author-binding-target-registry.test.ts — T-0700 (E-FORMS, столп 5
 * «настройка через ИИ») live Postgres.
 *
 * Run in the `db` CI job via `npm run fitness:db`, or standalone:
 *   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros \
 *     npx vitest run ci/checks/db/author-binding-target-registry.test.ts
 *
 * The gap this closes: T-0681 taught the SERVER (executeApprovedOpAsDraft's
 * "author_binding" case, src/http/assistant.ts) to accept + validate
 * args.targetRegistrySlug — but the tool schema the configurator LLM is handed
 * (TOOL_AUTHOR_BINDING, src/core/assistant-configurator.ts) never declared that
 * parameter. A human, using the visual bind-form (screen-processes.jsx), could
 * always pick a non-default "Реестр результата"; the bot could not — bot≠human
 * asymmetry. T-0700 adds the parameter to the tool schema (proven by the pure
 * unit tests in src/__tests__/assistant-configurator.test.ts, AC-T700-1/2/3);
 * THIS file proves the other half live: an ApprovedOp shaped exactly like what
 * the configurator now produces (kind='author_binding', args carrying
 * targetRegistrySlug) reaches a REAL registry_def row through the SAME executor
 * function the HTTP route calls — no divergent second path.
 *
 *   AC-1: targetRegistrySlug naming a REAL registry_def under the bound
 *         application → executeApprovedOpAsDraft returns null (success); the
 *         written process_app_binding.target_registry_slug equals the slug.
 *   AC-2: targetRegistrySlug naming a registry that does NOT exist under the
 *         bound application → an HONEST op-error string (not null, no throw,
 *         no row silently written) — same fail-closed guard T-0681 put on the
 *         human POST /api/process-app-bindings route.
 *   AC-3: targetRegistrySlug OMITTED → null (success); the written
 *         target_registry_slug is NULL — unchanged default-registry behavior
 *         (the configurator's pre-T-0700 path, still exercised).
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

describe.skipIf(!LIVE)('T-0700 — author_binding targetRegistrySlug reaches the live DB via the configurator executor', () => {
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
      { orgName: `T-0700 ${label} ${stamp}`, email: `t0700-${label}-${stamp}@example.com`, password: 'target-reg-pw-1' },
    );
    return res.tenantId;
  }

  /** Seeds ONE application with TWO registry_defs under it (default + an alternate). */
  async function seedApplicationWithTwoRegistries(
    tenantId: string,
  ): Promise<{ appId: string; defaultRegSlug: string; altRegSlug: string }> {
    const appId = uuid();
    const defaultRegId = uuid();
    const altRegId = uuid();
    const stamp = Math.random().toString(36).slice(2, 8);
    const defaultRegSlug = `default-${stamp}`;
    const altRegSlug = `alt-${stamp}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'Прил (тест T-0700)', NULL, 'draft', 0, 0)`,
        [tenantId, appId, `app-${stamp}`],
      );
      for (const [regId, slug] of [
        [defaultRegId, defaultRegSlug],
        [altRegId, altRegSlug],
      ] as const) {
        await c.query(
          `INSERT INTO choros.registry_def
             (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'Реестр (тест T-0700)', NULL, $5::jsonb, 0, 0)`,
          [tenantId, regId, appId, slug, JSON.stringify({ type: 'object', properties: {} })],
        );
      }
      await c.query('COMMIT');
    });
    return { appId, defaultRegSlug, altRegSlug };
  }

  async function readBinding(
    tenantId: string,
    processKey: string,
    appId: string,
  ): Promise<{ target_registry_slug: string | null } | null> {
    return withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const r = await c.query<{ target_registry_slug: string | null }>(
        `SELECT target_registry_slug FROM choros.process_app_binding
          WHERE tenant_id = $1 AND process_key = $2 AND application_id = $3`,
        [tenantId, processKey, appId],
      );
      await c.query('COMMIT');
      return r.rows[0] ?? null;
    });
  }

  /** Shapes an ApprovedOp exactly as processToolCall (assistant-configurator.ts,
   * case "author_binding") produces it once the LLM calls the T-0700-extended
   * TOOL_AUTHOR_BINDING schema — args flow through verbatim from the tool call. */
  function bindingOp(
    processKey: string,
    applicationId: string,
    targetRegistrySlug?: string,
  ): ApprovedOp {
    return {
      kind: 'author_binding',
      description: `Привязка процесса «${processKey}» — тест T-0700`,
      args: {
        processKey,
        applicationId,
        triggerType: 'on_create',
        humanReadableReason: 'Тест T-0700 — targetRegistrySlug через конфигуратор',
        ...(targetRegistrySlug !== undefined ? { targetRegistrySlug } : {}),
      },
      tier: 'draft',
    };
  }

  async function cleanup(tenantId: string): Promise<void> {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(`DELETE FROM choros.process_app_binding WHERE tenant_id = $1`, [tenantId]);
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

  it('AC-1: a REAL non-default registry slug → written; AC-2: an unknown slug → honest error, no row; AC-3: omitted → NULL (default, unchanged)', async () => {
    const tenantId = await registerOne('TargetRegistry');
    try {
      const { appId, altRegSlug } = await seedApplicationWithTwoRegistries(tenantId);

      // AC-1 — the configurator picked the ALTERNATE (non-default) registry, exactly
      // what a human could already do via the bind-form's picker (T-0681 parity).
      const procKeyOk = `proc-ac1-${Math.random().toString(36).slice(2, 8)}`;
      const errOk = await executeApprovedOpAsDraft(migPool, tenantId, bindingOp(procKeyOk, appId, altRegSlug));
      expect(errOk).toBeNull();
      const rowOk = await readBinding(tenantId, procKeyOk, appId);
      expect(rowOk?.target_registry_slug).toBe(altRegSlug);

      // AC-2 — the LLM hallucinated / mistyped a registry slug that does not exist
      // under this application → fail-closed, honest error, no silent binding.
      const procKeyBad = `proc-ac2-${Math.random().toString(36).slice(2, 8)}`;
      const errBad = await executeApprovedOpAsDraft(
        migPool, tenantId, bindingOp(procKeyBad, appId, 'no-such-registry-xyz'),
      );
      expect(errBad).not.toBeNull();
      expect(String(errBad)).toMatch(/не найден/);
      const rowBad = await readBinding(tenantId, procKeyBad, appId);
      expect(rowBad).toBeNull();

      // AC-3 — targetRegistrySlug omitted (pre-T-0700 tool-call shape) → still a
      // true no-op on this column: NULL, i.e. the server's default-registry
      // resolution path (unchanged by this task).
      const procKeyDefault = `proc-ac3-${Math.random().toString(36).slice(2, 8)}`;
      const errDefault = await executeApprovedOpAsDraft(migPool, tenantId, bindingOp(procKeyDefault, appId));
      expect(errDefault).toBeNull();
      const rowDefault = await readBinding(tenantId, procKeyDefault, appId);
      expect(rowDefault?.target_registry_slug).toBeNull();
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);
});
