// T-0180 · T-0121f — author_report_page mcp_tool seed DB fitness.
//
// Live Postgres probes — run in the `db` CI job via `npm run fitness:db`.
// Assumes migrations 044 + 053 have been applied (the db job runs the runner ×2 before this suite).
//
// T180-1: author_report_page mcp_tool row exists in dev-tenant with correct UUID.
// T180-2: resource_ops contains both create and update operations on authoring_draft.
// T180-3: declares=[] and pure_compute=true (mcp_tool_pure_empty_chk satisfied).
// T180-4: 2 new grants (e2...008/e2...009) exist for role config-agent with authoring_draft.
// T180-5: author_report_page is discoverable via resolveAgentToolset pattern
//          (tool row is in dev-tenant, role config-agent has authoring_draft grants).
// T180-6: DRAFT-boundary — zero authoring_published grants for config-agent (unchanged from 044).
// T180-7: idempotency — re-running migration 053 INSERTs does not change row counts.
// T180-8 (RLS): author_report_page is invisible to other tenants under choros_app session.

import { describe, it, expect } from 'vitest';
import {
  migratorUrl,
  appUrl,
  withClient,
} from './_helpers.js';

// Seed constants — mirror of migration 053.
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const ROLE_CONFIG_AGENT = 'e0000000-0000-0000-0000-000000000003';
const TOOL_UUID = '10000000-0000-0000-0000-00000000000b';
const GRANT_CREATE_UUID = 'e2000000-0000-0000-0000-000000000008';
const GRANT_UPDATE_UUID = 'e2000000-0000-0000-0000-000000000009';
const OTHER_TENANT = '11111111-1111-1111-1111-111111111111'; // TENANT_A from _helpers

// ---------------------------------------------------------------------------
// T180-1 — author_report_page mcp_tool row exists with correct UUID
// ---------------------------------------------------------------------------

describe('T180-1: author_report_page mcp_tool row exists in dev-tenant', () => {
  it('tool row with UUID 10...00b and name=author_report_page found', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id, name, pure_compute, declares
           FROM choros.mcp_tool
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, TOOL_UUID],
      );
      expect(rows.length, 'author_report_page mcp_tool row missing').toBe(1);
      expect(rows[0].name).toBe('author_report_page');
      expect(rows[0].pure_compute).toBe(true);
      expect(rows[0].declares).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// T180-2 — resource_ops contains both create and update on authoring_draft
// ---------------------------------------------------------------------------

describe('T180-2: resource_ops has authoring_draft create + update', () => {
  it('resource_ops @> create op on authoring_draft', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND id = $2
            AND resource_ops @> '[{"resourceType":"authoring_draft","operation":"create"}]'::jsonb`,
        [DEV_TENANT, TOOL_UUID],
      );
      expect(rows.length, 'authoring_draft/create op missing from author_report_page').toBe(1);
    });
  });

  it('resource_ops @> update op on authoring_draft', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND id = $2
            AND resource_ops @> '[{"resourceType":"authoring_draft","operation":"update"}]'::jsonb`,
        [DEV_TENANT, TOOL_UUID],
      );
      expect(rows.length, 'authoring_draft/update op missing from author_report_page').toBe(1);
    });
  });

  it('resource_ops has exactly 2 entries (create + update)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT jsonb_array_length(resource_ops) AS n
           FROM choros.mcp_tool
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, TOOL_UUID],
      );
      expect(rows[0].n, 'resource_ops should have exactly 2 entries').toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// T180-3 — declares=[] and pure_compute=true (mcp_tool_pure_empty_chk)
// ---------------------------------------------------------------------------

describe('T180-3: declares=[] + pure_compute=true (CHECK constraint satisfied)', () => {
  it('declares is empty array and pure_compute=true', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT declares, pure_compute
           FROM choros.mcp_tool
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, TOOL_UUID],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].declares).toEqual([]);
      expect(rows[0].pure_compute).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// T180-4 — 2 new grants (e2...008/e2...009) for config-agent authoring_draft
// ---------------------------------------------------------------------------

describe('T180-4: 2 new grant rows e2...008 (create) and e2...009 (update) exist', () => {
  it('grant e2...008 has authoring_draft/create for role config-agent', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT resource_type, operation, role_id, delegable
           FROM choros."grant"
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, GRANT_CREATE_UUID],
      );
      expect(rows.length, 'grant e2...008 missing').toBe(1);
      expect(rows[0].resource_type).toBe('authoring_draft');
      expect(rows[0].operation).toBe('create');
      expect(rows[0].role_id).toBe(ROLE_CONFIG_AGENT);
      expect(rows[0].delegable).toBe(false);
    });
  });

  it('grant e2...009 has authoring_draft/update for role config-agent', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT resource_type, operation, role_id, delegable
           FROM choros."grant"
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, GRANT_UPDATE_UUID],
      );
      expect(rows.length, 'grant e2...009 missing').toBe(1);
      expect(rows[0].resource_type).toBe('authoring_draft');
      expect(rows[0].operation).toBe('update');
      expect(rows[0].role_id).toBe(ROLE_CONFIG_AGENT);
      expect(rows[0].delegable).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// T180-5 — resolveAgentToolset pattern: author_report_page reachable
//           (tool in dev-tenant + config-agent has authoring_draft grants)
// ---------------------------------------------------------------------------

describe('T180-5: author_report_page reachable via resolveAgentToolset pattern', () => {
  it('tool with name=author_report_page visible when joining mcp_tool to grants', async () => {
    await withClient(migratorUrl(), async (c) => {
      // Simulate resolveAgentToolset: find tools whose resource_ops match
      // the grants held by role config-agent in dev-tenant.
      const { rows } = await c.query(
        `SELECT t.name
           FROM choros.mcp_tool t
          WHERE t.tenant_id = $1
            AND EXISTS (
              SELECT 1 FROM choros."grant" g
               WHERE g.tenant_id = t.tenant_id
                 AND g.role_id = $2
                 AND t.resource_ops @> jsonb_build_array(
                   jsonb_build_object(
                     'resourceType', g.resource_type,
                     'operation', g.operation
                   )
                 )
            )
          ORDER BY t.name`,
        [DEV_TENANT, ROLE_CONFIG_AGENT],
      );
      const names = rows.map((r: { name: string }) => r.name);
      expect(names).toContain('author_report_page');
    });
  });
});

// ---------------------------------------------------------------------------
// T180-6 — DRAFT-boundary: still zero authoring_published grants (unchanged)
// ---------------------------------------------------------------------------

describe('T180-6: DRAFT-boundary still holds after migration 053', () => {
  it('zero authoring_published grants for config-agent after adding T-0180 tool', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND resource_type = 'authoring_published'
            AND role_id = $2`,
        [DEV_TENANT, ROLE_CONFIG_AGENT],
      );
      expect(rows[0].n, 'authoring_published grant found — DRAFT-boundary violated by T-0180').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// T180-7 — idempotency: re-running 053 INSERTs does not change counts
// ---------------------------------------------------------------------------

describe('T180-7: migration 053 idempotency (ON CONFLICT DO NOTHING)', () => {
  it('re-inserting author_report_page rows does not change mcp_tool or grant counts', async () => {
    await withClient(migratorUrl(), async (c) => {
      // Count before re-run
      const { rows: toolsBefore } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND resource_ops @> '[{"resourceType":"authoring_draft"}]'::jsonb`,
        [DEV_TENANT],
      );
      const { rows: grantsBefore } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND resource_type = 'authoring_draft'
            AND role_id = $2`,
        [DEV_TENANT, ROLE_CONFIG_AGENT],
      );

      // Re-run migration 053 inserts
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.mcp_tool
           (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
         VALUES ($1, $2, 'author_report_page', 'desc', '[]'::jsonb, true,
                 '[{"resourceType":"authoring_draft","operation":"create"},{"resourceType":"authoring_draft","operation":"update"}]'::jsonb,
                 0, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, TOOL_UUID],
      );
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
            "constraint", delegable, granted_by, valid_from, valid_until, created_at)
         VALUES
           ($1, $2, $3, 'authoring_draft', NULL, 'create',
            '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
            NULL, false, 'seed', NULL, NULL, 0),
           ($1, $4, $3, 'authoring_draft', NULL, 'update',
            '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
            NULL, false, 'seed', NULL, NULL, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, GRANT_CREATE_UUID, ROLE_CONFIG_AGENT, GRANT_UPDATE_UUID],
      );
      await c.query('COMMIT');

      // Count after — must match before
      const { rows: toolsAfter } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND resource_ops @> '[{"resourceType":"authoring_draft"}]'::jsonb`,
        [DEV_TENANT],
      );
      const { rows: grantsAfter } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND resource_type = 'authoring_draft'
            AND role_id = $2`,
        [DEV_TENANT, ROLE_CONFIG_AGENT],
      );

      expect(toolsAfter[0].n, 'mcp_tool count changed after re-run (idempotency broken)').toBe(toolsBefore[0].n);
      expect(grantsAfter[0].n, 'grant count changed after re-run (idempotency broken)').toBe(grantsBefore[0].n);
    });
  });
});

// ---------------------------------------------------------------------------
// T180-8 — RLS: author_report_page invisible to other tenants
// ---------------------------------------------------------------------------

describe('T180-8: RLS — author_report_page invisible to other tenants', () => {
  it('choros_app session bound to OTHER_TENANT sees 0 rows for author_report_page', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${OTHER_TENANT}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE name = 'author_report_page'`,
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'RLS leak: author_report_page visible to OTHER_TENANT').toBe(0);
    });
  });
});
