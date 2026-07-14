// T-0209 · P-1 — DocsAuthorAgent seed DB fitness (docs-pipeline).
//
// Live Postgres probes — run in the `db` CI job via `npm run fitness:db`.
// Assumes migrations have been applied (the db job runs the runner ×2 before this suite).
//
// Reads dev-tenant a0...001 rows seeded by migration 062_docs_author_seed.sql.
// No audit append → no freshTenant() needed (see [[choros-db-test-shared-db-gotcha]]).
//
// AC-01: role 'docs-author' exists with correct UUID (e0...005) and slug.
// AC-02: exactly 2 grant rows for role e0...005 with resource_type='doc_page';
//         operation set = {create, update} (both present, count = 2).
// AC-03 (no delete): 0 grants for role e0...005 with resource_type='doc_page' AND operation='delete'.
// AC-04 (delegable boundary): 0 grants for role e0...005 with delegable=true.
// AC-05 (no read): 0 grants for role e0...005 with resource_type='doc_page' AND operation='read'.
// AC-06 (dormant card): agent_card for d0...015 has llm_endpoint/llm_model/llm_secret_handle
//         all NULL and a non-null budget_policy_id joining instance_budget.
// AC-07 (confirmed assignment): role_assignment f0...004 has confirmed_by NOT NULL,
//         links d0...015 ↔ e0...005, org_scope.nodeId = b0...001.
// AC-08 (scope consistency): both grants' scope->>'nodeId' = b0...001 (= role_assignment org_scope).
// AC-09 (idempotency): re-running the seed INSERTs in a txn leaves role/grant/assignment counts stable.
// AC-10 (RLS): choros_app session bound to OTHER_TENANT sees 0 doc_page grants for e0...005.
// AC-11 (toolset reachability): a synthetic McpToolRow with resource_ops=[{doc_page,create},
//         {doc_page,update}] is reachable via isToolReachable for these 2 grants,
//         and NOT reachable with the create grant removed (necessary & sufficient, nothing wider).

import { describe, it, expect } from 'vitest';
import {
  migratorUrl,
  appUrl,
  withClient,
} from './_helpers.js';
import {
  isToolReachable,
  type McpToolRow,
} from '../../../src/core/mcp-tool-registry.js';
import {
  type Grant,
  type ResourceType,
  type Operation,
} from '../../../src/core/grant-lattice.js';

// Dev-tenant and seed UUIDs from migration 062.
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const ROLE_DOCS_AUTHOR = 'e0000000-0000-0000-0000-000000000005';
const EMPLOYEE_DOCS_AUTHOR = 'd0000000-0000-0000-0000-000000000015';
const ASSIGNMENT_UUID = 'f0000000-0000-0000-0000-000000000004';
const GRANT_CREATE_UUID = 'e2000000-0000-0000-0000-000000000018';
const GRANT_UPDATE_UUID = 'e2000000-0000-0000-0000-000000000019';
const ORG_SCOPE_NODE = 'b0000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '11111111-1111-1111-1111-111111111111'; // TENANT_A from _helpers

// ---------------------------------------------------------------------------
// AC-01 — role 'docs-author' exists in dev-silo
// ---------------------------------------------------------------------------

describe('AC-01: role docs-author exists in dev-silo', () => {
  it('role row has slug=docs-author, UUID=e0...005', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT slug FROM choros.role
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows.length, 'role docs-author row missing').toBe(1);
      expect(rows[0].slug).toBe('docs-author');
    });
  });
});

// ---------------------------------------------------------------------------
// AC-02 — exactly 2 doc_page grants for role docs-author: {create, update}
// ---------------------------------------------------------------------------

describe('AC-02: exactly 2 doc_page grants for role docs-author (create + update)', () => {
  it('count = 2 grant rows with resource_type=doc_page for role e0...005', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND role_id = $2
            AND resource_type = 'doc_page'`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows[0].n, 'expected exactly 2 doc_page grants for docs-author').toBe(2);
    });
  });

  it('operation set contains create', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM choros."grant"
          WHERE tenant_id = $1 AND role_id = $2
            AND resource_type = 'doc_page' AND operation = 'create'`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows.length, 'doc_page/create grant missing for docs-author').toBe(1);
      expect(rows[0].id).toBe(GRANT_CREATE_UUID);
    });
  });

  it('operation set contains update', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM choros."grant"
          WHERE tenant_id = $1 AND role_id = $2
            AND resource_type = 'doc_page' AND operation = 'update'`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows.length, 'doc_page/update grant missing for docs-author').toBe(1);
      expect(rows[0].id).toBe(GRANT_UPDATE_UUID);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-03 — no doc_page delete grant (structural absence)
// ---------------------------------------------------------------------------

describe('AC-03: no doc_page delete grant for docs-author (DRAFT-boundary)', () => {
  it('zero grants with resource_type=doc_page AND operation=delete for role e0...005', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND role_id = $2
            AND resource_type = 'doc_page'
            AND operation = 'delete'`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows[0].n, 'doc_page/delete grant found — DRAFT-boundary violated').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-04 — zero delegable=true grants for docs-author
// ---------------------------------------------------------------------------

describe('AC-04: delegable boundary — zero delegable=true grants for docs-author', () => {
  it('no grants with delegable=true for role e0...005', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND role_id = $2
            AND delegable = true`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows[0].n, 'delegable=true grant found — boundary violated').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-05 — no doc_page read grant (read = external docs-MCP surface, T-0134g)
// ---------------------------------------------------------------------------

describe('AC-05: no doc_page read grant for docs-author (read is external surface)', () => {
  it('zero grants with resource_type=doc_page AND operation=read for role e0...005', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND role_id = $2
            AND resource_type = 'doc_page'
            AND operation = 'read'`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows[0].n, 'doc_page/read grant found — must be external surface only').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-06 — agent_card for d0...015 is dormant (all LLM fields NULL, budget FK set)
// ---------------------------------------------------------------------------

describe('AC-06: agent_card for d0...015 is dormant (LLM fields NULL, budget_policy_id set)', () => {
  it('llm_endpoint, llm_model, llm_secret_handle all NULL', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT llm_endpoint, llm_model, llm_secret_handle, autonomy_threshold
           FROM choros.agent_card
          WHERE tenant_id = $1 AND employee_id = $2`,
        [DEV_TENANT, EMPLOYEE_DOCS_AUTHOR],
      );
      expect(rows.length, 'agent_card for d0...015 missing').toBe(1);
      expect(rows[0].llm_endpoint, 'llm_endpoint must be NULL (dormant)').toBeNull();
      expect(rows[0].llm_model, 'llm_model must be NULL (dormant)').toBeNull();
      expect(rows[0].llm_secret_handle, 'llm_secret_handle must be NULL (dormant)').toBeNull();
    });
  });

  it('budget_policy_id references an existing instance_budget', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT ac.budget_policy_id
           FROM choros.agent_card ac
           JOIN choros.instance_budget ib
             ON ac.tenant_id = ib.tenant_id AND ac.budget_policy_id = ib.id
          WHERE ac.employee_id = $1`,
        [EMPLOYEE_DOCS_AUTHOR],
      );
      expect(rows.length, 'agent_card budget_policy_id must reference instance_budget').toBe(1);
      expect(rows[0].budget_policy_id).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// AC-07 — role_assignment f0...004 is CONFIRMED, links d0...015 ↔ e0...005
// ---------------------------------------------------------------------------

describe('AC-07: role_assignment f0...004 is CONFIRMED and links correct entities', () => {
  it('role_assignment has confirmed_by NOT NULL, correct employee_id and role_id', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT employee_id, role_id, confirmed_by, org_scope->>'nodeId' AS node_id
           FROM choros.role_assignment
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, ASSIGNMENT_UUID],
      );
      expect(rows.length, 'role_assignment f0...004 missing').toBe(1);
      expect(rows[0].employee_id).toBe(EMPLOYEE_DOCS_AUTHOR);
      expect(rows[0].role_id).toBe(ROLE_DOCS_AUTHOR);
      expect(rows[0].confirmed_by, 'confirmed_by must be NOT NULL (CONFIRMED)').not.toBeNull();
      expect(rows[0].node_id, 'org_scope.nodeId must be b0...001 fin-dept node').toBe(ORG_SCOPE_NODE);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-08 — grant scope.nodeId = b0...001 (consistent with role_assignment org_scope)
// ---------------------------------------------------------------------------

describe('AC-08: grant scope.nodeId = b0...001 (consistent with role_assignment org_scope)', () => {
  it('both doc_page grants have scope->nodeId = b0...001', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id, scope->>'nodeId' AS node_id
           FROM choros."grant"
          WHERE tenant_id = $1
            AND role_id = $2
            AND resource_type = 'doc_page'
          ORDER BY operation`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows.length, 'expected 2 doc_page grants').toBe(2);
      for (const row of rows) {
        expect(row.node_id, `grant ${row.id} scope.nodeId must be b0...001`).toBe(ORG_SCOPE_NODE);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// AC-09 — idempotency: re-running seed INSERTs leaves counts stable
// ---------------------------------------------------------------------------

describe('AC-09: migration 062 idempotency (ON CONFLICT DO NOTHING)', () => {
  it('re-inserting all seed rows does not change role/grant/assignment counts', async () => {
    await withClient(migratorUrl(), async (c) => {
      // Count before
      const { rows: rolesBefore } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      const { rows: grantsBefore } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND resource_type = 'doc_page'
            AND role_id = $2`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      const { rows: assignBefore } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role_assignment
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, ASSIGNMENT_UUID],
      );

      // Re-run all seed INSERTs (they must all be ON CONFLICT DO NOTHING)
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.role (tenant_id, id, slug, display_name, description, created_at, updated_at)
         VALUES ($1, $2, 'docs-author', 'Docs Author Agent', 'System docs-author role (T-0209 P-1)', 0, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
            "constraint", delegable, granted_by, valid_from, valid_until, created_at)
         VALUES
           ($1, $2, $3, 'doc_page', NULL, 'create',
            '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
            NULL, false, 'seed', NULL, NULL, 0),
           ($1, $4, $3, 'doc_page', NULL, 'update',
            '{"kind":"node","hierarchy":"org","nodeId":"b0000000-0000-0000-0000-000000000001","nodeLevel":"department"}'::jsonb,
            NULL, false, 'seed', NULL, NULL, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, GRANT_CREATE_UUID, ROLE_DOCS_AUTHOR, GRANT_UPDATE_UUID],
      );
      await c.query('COMMIT');

      // Count after — must match before
      const { rows: rolesAfter } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      const { rows: grantsAfter } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND resource_type = 'doc_page'
            AND role_id = $2`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      const { rows: assignAfter } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role_assignment
          WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, ASSIGNMENT_UUID],
      );

      expect(rolesAfter[0].n, 'role count changed after re-run (idempotency broken)').toBe(rolesBefore[0].n);
      expect(grantsAfter[0].n, 'grant count changed after re-run (idempotency broken)').toBe(grantsBefore[0].n);
      expect(assignAfter[0].n, 'assignment count changed after re-run (idempotency broken)').toBe(assignBefore[0].n);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-10 — RLS: cross-tenant SELECT sees 0 doc_page grants for e0...005
// ---------------------------------------------------------------------------

describe('AC-10: RLS — cross-tenant SELECT for doc_page grants returns 0', () => {
  it('choros_app session bound to OTHER_TENANT sees 0 grants for docs-author role', async () => {
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${OTHER_TENANT}'`);
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE resource_type = 'doc_page'
            AND role_id = $1`,
        [ROLE_DOCS_AUTHOR],
      );
      await c.query('COMMIT');
      expect(rows[0].n, 'cross-tenant RLS leak: doc_page grants visible to OTHER_TENANT').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// AC-11 — toolset reachability (pure unit: isToolReachable, no IO)
//          A synthetic McpToolRow with resource_ops=[{doc_page,create},{doc_page,update}]
//          is reachable iff BOTH grants are present (necessary & sufficient).
// ---------------------------------------------------------------------------

describe('AC-11: toolset reachability — isToolReachable pure unit assertion', () => {
  const FAKE_TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const SCOPE = { kind: 'set' as const, members: [] };
  const NOW_MS = 1_700_000_000_000;

  // Synthetic grants mirroring migration 062 (with string-cast for doc_page TEXT type)
  const grantCreate: Grant = {
    tenantId: FAKE_TENANT,
    id: GRANT_CREATE_UUID,
    roleId: ROLE_DOCS_AUTHOR,
    resourceType: 'doc_page' as ResourceType,
    operation: 'create' as Operation,
    scope: SCOPE,
    delegable: false,
    grantedBy: 'seed',
    createdAt: 0,
  };
  const grantUpdate: Grant = {
    tenantId: FAKE_TENANT,
    id: GRANT_UPDATE_UUID,
    roleId: ROLE_DOCS_AUTHOR,
    resourceType: 'doc_page' as ResourceType,
    operation: 'update' as Operation,
    scope: SCOPE,
    delegable: false,
    grantedBy: 'seed',
    createdAt: 0,
  };

  // Synthetic doc_page_author tool (P-2 shape) — resource_ops=[{doc_page,create},{doc_page,update}]
  const docPageAuthorTool: McpToolRow = {
    tenantId: FAKE_TENANT,
    id: '10000000-0000-0000-0000-000000000020',
    name: 'doc_page_author',
    description: 'Synthetic P-2 doc_page_author tool for AC-11 reachability assertion',
    declares: [],
    pureCompute: true,
    resourceOps: [
      { resourceType: 'doc_page' as ResourceType, operation: 'create' as Operation },
      { resourceType: 'doc_page' as ResourceType, operation: 'update' as Operation },
    ],
    createdAt: 0,
    updatedAt: 0,
  };

  it('tool is reachable when both doc_page grants present (necessary & sufficient)', () => {
    const result = isToolReachable(
      docPageAuthorTool,
      [grantCreate, grantUpdate],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'tool must be reachable with both doc_page grants').toBe(true);
  });

  it('tool is NOT reachable when create grant is removed (create is necessary)', () => {
    // Only update grant — missing create → not reachable
    const result = isToolReachable(
      docPageAuthorTool,
      [grantUpdate],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'tool must NOT be reachable without create grant').toBe(false);
  });

  it('tool is NOT reachable when update grant is removed (update is necessary)', () => {
    // Only create grant — missing update → not reachable
    const result = isToolReachable(
      docPageAuthorTool,
      [grantCreate],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'tool must NOT be reachable without update grant').toBe(false);
  });

  it('tool is NOT reachable with zero grants (AC-12 structural: 0 roles → 0 tools)', () => {
    const result = isToolReachable(
      docPageAuthorTool,
      [],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'tool must NOT be reachable with zero grants').toBe(false);
  });

  it('grants do not cover a wider operation (e.g. delete) — doc_page/delete tool not reachable', () => {
    const docPageDeleteTool: McpToolRow = {
      ...docPageAuthorTool,
      id: '10000000-0000-0000-0000-000000000021',
      name: 'doc_page_delete_probe',
      resourceOps: [
        { resourceType: 'doc_page' as ResourceType, operation: 'delete' as Operation },
      ],
    };
    const result = isToolReachable(
      docPageDeleteTool,
      [grantCreate, grantUpdate],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'delete tool must NOT be reachable — no delete grant in seed').toBe(false);
  });
});
