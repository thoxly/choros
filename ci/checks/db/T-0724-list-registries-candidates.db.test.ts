/**
 * ci/checks/db/T-0724-list-registries-candidates.db.test.ts — T-0724 (E-FORMS,
 * столп 5 «настройка через ИИ», ревью T-0700 N1) live Postgres.
 *
 * Run in the `db` CI job via `npm run fitness:db`, or standalone:
 *   DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros \
 *     npx vitest run --dir ci/checks/db --no-file-parallelism \
 *     ci/checks/db/T-0724-list-registries-candidates.db.test.ts
 *
 * The gap this closes: T-0700 let the bot NAME a targetRegistrySlug in
 * author_binding, but it still had to GUESS the real slug — a human always
 * sees the real options in the "Реестр результата" picker
 * (GET /api/registry-defs, T-0681). T-0724 gives the bot an equivalent:
 * list_registries (src/core/assistant-configurator.ts) — fed by
 * fetchRegistryListCandidates (src/http/assistant.ts), which REUSES
 * listRegistryDefs (src/http/registry-defs.ts) VERBATIM — the SAME DAO
 * GET /api/registry-defs calls. The pure-core unit tests
 * (assistant-configurator.test.ts, AC-T724-1..5) prove the tool's shape and
 * filtering logic against INJECTED data; THIS file proves the injection
 * itself never sees more than a human of the SAME tenant could — i.e. the
 * rights contour is REAL tenant/RLS scoping, not a bespoke query with its own
 * (possibly wider) reach.
 *
 *   AC-1: fetchRegistryListCandidates(pool, tenantId) returns THIS tenant's
 *         registries, tagged with the correct applicationId (so the pure-core
 *         filter can scope by application) and the correct human display_name.
 *   AC-2: a SECOND tenant's registries NEVER appear in the first tenant's
 *         result — cross-tenant isolation (RLS), the same boundary a human
 *         of tenant A hits at GET /api/registry-defs.
 *   AC-3: an application with zero registries → an empty result, not a crash
 *         (honest empty, mirrors what the human picker would show too).
 *
 * HERMETIC: fresh registered tenants per run; migrator-user cleanup after.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { registerTenant } from '../../../src/core/register.js';
import { InMemoryKeycloakUserPort } from '../../../src/keycloak/fake-user-port.js';
import { fetchRegistryListCandidates } from '../../../src/http/assistant.js';

const LIVE = !!process.env['DATABASE_URL'];
const NOW = () => Date.now();

describe.skipIf(!LIVE)('T-0724 — fetchRegistryListCandidates reaches the live DB scoped exactly like the human registry picker', () => {
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
      { orgName: `T-0724 ${label} ${stamp}`, email: `t0724-${label}-${stamp}@example.com`, password: 'list-registries-pw-1' },
    );
    return res.tenantId;
  }

  /** Seeds ONE application with TWO registry_defs, plus a SECOND, empty application. */
  async function seedTenantFixtures(
    tenantId: string,
  ): Promise<{ appWithRegs: string; appEmpty: string; regSlugA: string; regSlugB: string }> {
    const appWithRegs = uuid();
    const appEmpty = uuid();
    const regIdA = uuid();
    const regIdB = uuid();
    const stamp = Math.random().toString(36).slice(2, 8);
    const regSlugA = `t0724-reg-a-${stamp}`;
    const regSlugB = `t0724-reg-b-${stamp}`;
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'Прил. с реестрами (тест T-0724)', NULL, 'draft', 0, 0)`,
        [tenantId, appWithRegs, `t0724-app-regs-${stamp}`],
      );
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, description, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'Прил. без реестров (тест T-0724)', NULL, 'draft', 0, 0)`,
        [tenantId, appEmpty, `t0724-app-empty-${stamp}`],
      );
      for (const [regId, slug, name] of [
        [regIdA, regSlugA, 'Реестр А (тест T-0724)'],
        [regIdB, regSlugB, 'Реестр Б (тест T-0724)'],
      ] as const) {
        await c.query(
          `INSERT INTO choros.registry_def
             (tenant_id, id, application_id, slug, display_name, description, record_schema, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NULL, $6::jsonb, 0, 0)`,
          [tenantId, regId, appWithRegs, slug, name, JSON.stringify({ type: 'object', properties: {} })],
        );
      }
      await c.query('COMMIT');
    });
    return { appWithRegs, appEmpty, regSlugA, regSlugB };
  }

  async function cleanup(tenantId: string): Promise<void> {
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
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

  it('AC-1: returns this tenant\'s registries tagged with the right applicationId + human display_name; AC-3: an empty application contributes nothing (no crash)', async () => {
    const tenantId = await registerOne('Scope');
    try {
      const { appWithRegs, appEmpty, regSlugA, regSlugB } = await seedTenantFixtures(tenantId);

      const candidates = await fetchRegistryListCandidates(migPool, tenantId);

      const bySlug = new Map(candidates.map((c) => [c.slug, c]));
      expect(bySlug.get(regSlugA)?.applicationId).toBe(appWithRegs);
      expect(bySlug.get(regSlugA)?.displayName).toBe('Реестр А (тест T-0724)');
      expect(bySlug.get(regSlugB)?.applicationId).toBe(appWithRegs);
      expect(bySlug.get(regSlugB)?.displayName).toBe('Реестр Б (тест T-0724)');

      // AC-3: the empty application contributes ZERO rows — honest, not an error.
      const forEmptyApp = candidates.filter((c) => c.applicationId === appEmpty);
      expect(forEmptyApp).toHaveLength(0);
    } finally {
      await cleanup(tenantId);
    }
  }, 30_000);

  it('AC-2: a second tenant\'s registries NEVER appear in the first tenant\'s candidate list (RLS — the same boundary a human hits at GET /api/registry-defs)', async () => {
    const tenantA = await registerOne('CrossA');
    const tenantB = await registerOne('CrossB');
    try {
      const { regSlugA: slugInA } = await seedTenantFixtures(tenantA);
      const { regSlugA: slugInB } = await seedTenantFixtures(tenantB);

      const candidatesA = await fetchRegistryListCandidates(migPool, tenantA);
      const candidatesB = await fetchRegistryListCandidates(migPool, tenantB);

      // Tenant A sees its own registry...
      expect(candidatesA.some((c) => c.slug === slugInA)).toBe(true);
      // ...but NEVER tenant B's — the bot acting for A must stay inside A's
      // rights contour exactly as a human of A would at the picker route.
      expect(candidatesA.some((c) => c.slug === slugInB)).toBe(false);

      // Symmetric check for B.
      expect(candidatesB.some((c) => c.slug === slugInB)).toBe(true);
      expect(candidatesB.some((c) => c.slug === slugInA)).toBe(false);
    } finally {
      await cleanup(tenantA);
      await cleanup(tenantB);
    }
  }, 30_000);
});
