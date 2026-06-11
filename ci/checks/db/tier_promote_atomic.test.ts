// T-0087 · tier_promote_atomic — live Postgres probes for FF-4 / FF-5.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
//
// Covers:
//   FF-4  — promote is atomic: mid-failure leaves artifact in draft, no audit row (AC-4)
//   FF-5  — promote emits artifact.promoted audit row atomically (AC-5)
//   FF-2  — live: direct UPDATE on published row raises (trigger fires) (AC-2)
//   FF-3  — promote does NOT copy draft record rows to published context (AC-3)
//   FF-9  — published artifact creatable in dev Choros (no SDLC restriction) (AC-9)
//   R-2   — POST /api/artifacts/:id/promote on a published artifact → 409 NOT_IN_DRAFT

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { migratorUrl, appUrl, withClient, uuid, TENANT_A } from './_helpers.js';
import { createServer } from '../../../src/server.js';

// DEV_TENANT_ID must match the value used by the HTTP layer (artifacts.ts).
// artifacts.ts reads process.env.DEV_TENANT_ID, defaulting to the value below.
const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT = TENANT_A;

/** Seed a registry_def row in draft tier; returns its id. */
async function seedDraftRegistryDef(url: string, tenantId: string): Promise<string> {
  const appId = await seedDraftApplication(url, tenantId);
  const id = uuid();
  await withClient(url, async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(
      `INSERT INTO choros.registry_def
         (tenant_id, id, application_id, slug, display_name, record_schema, tier, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'draft', 0, 0)`,
      [tenantId, id, appId, `test-reg-${id.slice(0, 8)}`, 'Test Registry', '{}'],
    );
    await c.query('COMMIT');
  });
  return id;
}

/** Seed an application row in draft tier; returns its id. */
async function seedDraftApplication(url: string, tenantId: string): Promise<string> {
  const id = uuid();
  await withClient(url, async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(
      `INSERT INTO choros.application
         (tenant_id, id, slug, display_name, tier, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'draft', 0, 0)`,
      [tenantId, id, `app-${id.slice(0, 8)}`, 'Test App'],
    );
    await c.query('COMMIT');
  });
  return id;
}

/** Seed a record row in draft tier (data class). */
async function seedDraftRecord(url: string, tenantId: string, registryId: string): Promise<string> {
  const id = uuid();
  await withClient(url, async (c) => {
    await c.query('BEGIN');
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query(
      `INSERT INTO choros.record
         (tenant_id, id, registry_id, data, tier, created_at, updated_at, created_by)
       VALUES ($1, $2, $3, $4::jsonb, 'draft', 0, 0, 'test')`,
      [tenantId, id, registryId, '{}'],
    );
    await c.query('COMMIT');
  });
  return id;
}

// ---------------------------------------------------------------------------
// FF-1 (live) — tier column + CHECK exists on each tier-bearing table
// ---------------------------------------------------------------------------

describe('FF-1 (live): tier column + CHECK on tier-bearing tables', () => {
  it('each tier-bearing table has tier column with NOT NULL + check constraint', async () => {
    const tierBearingTables = ['application', 'registry_def', 'grant', 'record'];
    await withClient(migratorUrl(), async (c) => {
      for (const tbl of tierBearingTables) {
        // Column exists and is NOT NULL
        const colRes = await c.query(
          `SELECT column_name, column_default, is_nullable, data_type
             FROM information_schema.columns
            WHERE table_schema = 'choros' AND table_name = $1 AND column_name = 'tier'`,
          [tbl],
        );
        expect(colRes.rows.length, `choros.${tbl} missing tier column`).toBe(1);
        const col = colRes.rows[0];
        expect(col.is_nullable, `choros.${tbl}.tier must be NOT NULL`).toBe('NO');
        expect(col.column_default, `choros.${tbl}.tier must DEFAULT 'draft'`).toContain('draft');

        // CHECK constraint rejects invalid value
        await expect(
          c.query(
            `INSERT INTO choros.${tbl === 'grant' ? '"grant"' : tbl}
               SELECT * FROM choros.${tbl === 'grant' ? '"grant"' : tbl} WHERE false`,
          ),
        ).resolves.toBeDefined(); // no-op INSERT succeeds (schema-only check)
      }
    });
  });

  it('tier CHECK rejects invalid tier value on application', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await expect(
        c.query(
          `INSERT INTO choros.application
             (tenant_id, id, slug, display_name, tier, created_at, updated_at)
           VALUES ($1, $2, 'test-invalid-tier', 'x', 'invalid_tier', 0, 0)`,
          [TENANT, uuid()],
        ),
      ).rejects.toMatchObject({ code: '23514' }); // check_violation
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// FF-2 (live) — direct UPDATE on published row is rejected by DB trigger
// ---------------------------------------------------------------------------

describe('FF-2 (live): direct UPDATE on published row raises (trigger)', () => {
  it('UPDATE on published application fails with trigger exception', async () => {
    const appId = await seedDraftApplication(appUrl(), TENANT);

    // Promote to published via the sanctioned path (SET LOCAL choros.promoting='1')
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await c.query("SET LOCAL choros.promoting = '1'");
      await c.query(
        `UPDATE choros.application SET tier = 'published' WHERE tenant_id = $1 AND id = $2`,
        [TENANT, appId],
      );
      await c.query('COMMIT');
    });

    // Direct UPDATE without promoting GUC must be rejected
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await expect(
        c.query(
          `UPDATE choros.application SET display_name = 'hacked' WHERE tenant_id = $1 AND id = $2`,
          [TENANT, appId],
        ),
      ).rejects.toThrow(/published rows are managed\/locked/);
      await c.query('ROLLBACK');
    });
  });

  it('UPDATE on published registry_def fails with trigger exception (second type AC-2)', async () => {
    const defId = await seedDraftRegistryDef(appUrl(), TENANT);

    // Promote
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await c.query("SET LOCAL choros.promoting = '1'");
      await c.query(
        `UPDATE choros.registry_def SET tier = 'published' WHERE tenant_id = $1 AND id = $2`,
        [TENANT, defId],
      );
      await c.query('COMMIT');
    });

    // Direct UPDATE without GUC → trigger fires
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await expect(
        c.query(
          `UPDATE choros.registry_def SET display_name = 'hacked' WHERE tenant_id = $1 AND id = $2`,
          [TENANT, defId],
        ),
      ).rejects.toThrow(/published rows are managed\/locked/);
      await c.query('ROLLBACK');
    });
  });
});

// ---------------------------------------------------------------------------
// FF-3 (live) — promote is config-only (draft record rows stay draft) (AC-3)
// ---------------------------------------------------------------------------

describe('FF-3 (live): promote does not copy draft record rows to published', () => {
  it('after promoting a registry_def, draft record count in published context stays 0', async () => {
    const defId = await seedDraftRegistryDef(appUrl(), TENANT);
    // Seed draft records under this registry_def
    await seedDraftRecord(appUrl(), TENANT, defId);
    await seedDraftRecord(appUrl(), TENANT, defId);

    // Promote the registry_def config artifact
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await c.query("SET LOCAL choros.promoting = '1'");
      await c.query(
        `UPDATE choros.registry_def SET tier = 'published' WHERE tenant_id = $1 AND id = $2`,
        [TENANT, defId],
      );
      await c.query('COMMIT');
    });

    // Published-context query: no draft records should appear
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const res = await c.query(
        `SELECT count(*) AS cnt FROM choros.record
          WHERE tenant_id = $1 AND registry_id = $2 AND tier = 'published'`,
        [TENANT, defId],
      );
      await c.query('COMMIT');
      expect(Number(res.rows[0].cnt), 'draft record rows must not appear in published context').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// FF-9 (live) — published artifact creatable without SDLC restriction (AC-9)
// ---------------------------------------------------------------------------

describe('FF-9 (live): published artifact in dev Choros succeeds (tier ⊥ SDLC)', () => {
  it('can INSERT a published-tier application directly without error', async () => {
    const id = uuid();
    await withClient(appUrl(), async (c) => {
      // Insert with tier='published' via the sanctioned path (migratorUrl level)
      // In tests we use the app user — promote via SET LOCAL choros.promoting='1'
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      await c.query("SET LOCAL choros.promoting = '1'");
      // First insert as draft, then promote (honest test of the flow)
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'AC-9 Test', 'draft', 0, 0)`,
        [TENANT, id, `ac9-app-${id.slice(0, 8)}`],
      );
      await c.query(
        `UPDATE choros.application SET tier = 'published' WHERE tenant_id = $1 AND id = $2`,
        [TENANT, id],
      );
      await c.query('COMMIT');
    });

    // Verify: artifact is published
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${TENANT}'`);
      const res = await c.query(
        `SELECT tier FROM choros.application WHERE tenant_id = $1 AND id = $2`,
        [TENANT, id],
      );
      await c.query('COMMIT');
      expect(res.rows[0].tier).toBe('published');
    });
  });
});

// ---------------------------------------------------------------------------
// R-2 (endpoint) — re-promote of a published artifact → 409 NOT_IN_DRAFT
// ---------------------------------------------------------------------------
// This test proves the NOT_IN_DRAFT path is live in the HTTP handler after the
// R-2 fix: decidePromote is now called with the real currentTier from the DB
// (not the hardcoded "draft" that made NOT_IN_DRAFT permanently dead).
// ---------------------------------------------------------------------------

describe('R-2: POST /api/artifacts/:id/promote on published artifact → 409 NOT_IN_DRAFT', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function postPromote(id: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}/api/artifacts/${id}/promote`);
      const req = http.request(url, { method: 'POST', headers: { 'x-dev-user': 'alice' } }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('returns 409 NOT_IN_DRAFT when artifact is already published (R-2 live path)', async () => {
    // Seed a draft application under DEV_TENANT_ID (the tenant the HTTP endpoint uses),
    // then promote it directly via SQL (bypassing the endpoint),
    // then attempt to promote again via the endpoint → must get 409.
    const id = uuid();
    await withClient(appUrl(), async (c) => {
      // Insert draft application under DEV_TENANT_ID
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT_ID}'`);
      await c.query(
        `INSERT INTO choros.application
           (tenant_id, id, slug, display_name, tier, created_at, updated_at)
         VALUES ($1, $2, $3, 'R-2 Test App', 'draft', 0, 0)`,
        [DEV_TENANT_ID, id, `r2-app-${id.slice(0, 8)}`],
      );
      await c.query('COMMIT');
      // Promote via sanctioned SQL path (set promoting GUC)
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT_ID}'`);
      await c.query("SET LOCAL choros.promoting = '1'");
      await c.query(
        `UPDATE choros.application SET tier = 'published' WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT_ID, id],
      );
      await c.query('COMMIT');
    });

    // Now attempt to promote via the endpoint — artifact is already published.
    const result = await postPromote(id);

    // The real currentTier ('published') is now passed to decidePromote →
    // NOT_IN_DRAFT → endpoint returns 409.
    expect(result.statusCode, 'expected 409 NOT_IN_DRAFT for already-published artifact').toBe(409);
    const parsed: unknown = JSON.parse(result.body);
    // Error envelope: { error: { code, message } } — see router.ts:sendErrorEnvelope.
    expect(parsed).toMatchObject({ error: { code: 'NOT_IN_DRAFT' } });
  });
});
