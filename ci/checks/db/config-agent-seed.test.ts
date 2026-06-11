// T-0077 · config-agent-seed DB fitness (E11.6).
//
// Live Postgres probes — run in the `db` CI job + locally via `npm run fitness:db`.
// Assumes migrations have been applied (the db job runs the runner ×2 before this suite).
//
// AC-01: role 'config-agent' exists with correct UUID and slug.
// AC-02: 7 mcp_tool rows with resource_ops @> '[{"resourceType":"authoring_draft"}]'.
// AC-03: all 7 tools have pure_compute=true.
// AC-04: 7 grant rows with resource_type='authoring_draft' for role config-agent.
// AC-05: ZERO grants with resource_type='authoring_published' for role config-agent.
// AC-09: idempotency — migration already applied; second pass is a no-op (row counts stable).
// AC-12 (RLS): cross-tenant SELECT for authoring_draft mcp_tool returns 0 rows.
// AC-13: agent_card for d0...013 has budget_policy_id referencing an instance_budget.

import { describe, it, expect } from 'vitest';
import {
  migratorUrl,
  appUrl,
  withClient,
} from './_helpers.js';

// Dev-tenant and seed UUIDs from migration 044.
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const ROLE_CONFIG_AGENT = 'e0000000-0000-0000-0000-000000000003';
const EMPLOYEE_CONFIG_AGENT = 'd0000000-0000-0000-0000-000000000013';
const OTHER_TENANT = '11111111-1111-1111-1111-111111111111'; // TENANT_A from _helpers

// ---------------------------------------------------------------------------
// AC-01 — role 'config-agent' exists (AC-01)
// ---------------------------------------------------------------------------

describe('AC-01: role config-agent exists in dev-silo', () => {
  it('role row has slug=config-agent and correct UUID', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT slug FROM choros.role
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, ROLE_CONFIG_AGENT],
      );
      expect(rows.length, 'role config-agent row missing').toBe(1);
      expect(rows[0].slug).toBe('config-agent');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-02 — 7 mcp_tool rows with authoring_draft resource_ops
// ---------------------------------------------------------------------------

describe('AC-02: 7 mcp_tool rows with authoring_draft resource_ops', () => {
  it('exactly 7 mcp_tool rows for dev-tenant with authoring_draft', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT name FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND resource_ops @> '[{"resourceType":"authoring_draft"}]'::jsonb
          ORDER BY name`,
        [DEV_TENANT],
      );
      expect(rows.length, 'expected 7 authoring_draft mcp_tool rows').toBe(7);
      const names = rows.map((r: { name: string }) => r.name).sort();
      expect(names).toContain('emit_form_code');
      expect(names).toContain('edit_jsonschema');
      expect(names).toContain('author_dmn');
      expect(names).toContain('scaffold_external_worker');
      expect(names).toContain('write_object_migration');
      expect(names).toContain('open_draft_branch');
      expect(names).toContain('request_promote');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-03 — pure_compute=true for all 7 tools
// ---------------------------------------------------------------------------

describe('AC-03: pure_compute=true for all authoring_draft tools', () => {
  it('zero rows with pure_compute=false among authoring_draft tools', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND resource_ops @> '[{"resourceType":"authoring_draft"}]'::jsonb
            AND pure_compute = false`,
        [DEV_TENANT],
      );
      expect(rows[0].n, 'some authoring_draft tools have pure_compute=false').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-04 — 7 grant rows for role config-agent with authoring_draft
// ---------------------------------------------------------------------------

describe('AC-04: 7 grants for role config-agent with authoring_draft', () => {
  it('exactly 7 grant rows with resource_type=authoring_draft for config-agent role', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND resource_type = 'authoring_draft'
            AND role_id = $2`,
        [DEV_TENANT, ROLE_CONFIG_AGENT],
      );
      expect(rows[0].n, 'expected 7 authoring_draft grants for config-agent').toBe(7);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-05 — ZERO authoring_published grants for config-agent (DRAFT-boundary)
// ---------------------------------------------------------------------------

describe('AC-05: DRAFT-boundary — zero authoring_published grants for config-agent', () => {
  it('no grants with resource_type=authoring_published for config-agent', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND resource_type = 'authoring_published'
            AND role_id = $2`,
        [DEV_TENANT, ROLE_CONFIG_AGENT],
      );
      expect(rows[0].n, 'authoring_published grants found — DRAFT-boundary violated').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-09 — idempotency: row counts stable after a simulated second apply
// ---------------------------------------------------------------------------

describe('AC-09: migration 044 idempotency', () => {
  it('re-running seed INSERTs does not change row counts (ON CONFLICT DO NOTHING)', async () => {
    // Count before
    await withClient(migratorUrl(), async (c) => {
      const { rows: rolesBefore } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, ROLE_CONFIG_AGENT],
      );
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

      // Re-run the idempotent INSERTs
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, 'config-agent', 'Config Agent', 0, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, ROLE_CONFIG_AGENT],
      );
      await c.query('COMMIT');

      // Count after
      const { rows: rolesAfter } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, ROLE_CONFIG_AGENT],
      );
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

      expect(rolesAfter[0].n).toBe(rolesBefore[0].n);
      expect(toolsAfter[0].n).toBe(toolsBefore[0].n);
      expect(grantsAfter[0].n).toBe(grantsBefore[0].n);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-12 — RLS: cross-tenant SELECT for authoring_draft returns 0 rows
// ---------------------------------------------------------------------------

describe('AC-12: RLS — cross-tenant SELECT for authoring_draft mcp_tool returns 0', () => {
  it('choros_app session bound to OTHER_TENANT sees 0 authoring_draft tools', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${OTHER_TENANT}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE resource_ops @> '[{"resourceType":"authoring_draft"}]'::jsonb`,
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'cross-tenant RLS leak: authoring_draft tools visible to OTHER_TENANT').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-13 — agent_card for config-agent has budget_policy_id set
// ---------------------------------------------------------------------------

describe('AC-13: agent_card budget_policy_id references instance_budget', () => {
  it('agent_card for d0...013 has non-null budget_policy_id joining to instance_budget', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT ac.budget_policy_id
           FROM choros.agent_card ac
           JOIN choros.instance_budget ib
             ON ac.tenant_id = ib.tenant_id AND ac.budget_policy_id = ib.id
          WHERE ac.employee_id = $1`,
        [EMPLOYEE_CONFIG_AGENT],
      );
      expect(rows.length, 'agent_card budget_policy_id must reference instance_budget').toBe(1);
      expect(rows[0].budget_policy_id).not.toBeNull();
    });
  });
});
