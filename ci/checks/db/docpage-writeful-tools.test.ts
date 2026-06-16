// T-0210 · P-2 — docpage writeful mcp_tools DB fitness (docs-pipeline).
//
// Live Postgres probes — run in the `db` CI job via `npm run fitness:db`.
// Assumes migrations have been applied (the db job runs the runner ×2 before this suite).
//
// Reads dev-tenant a0...001 rows seeded by migration 063_docpage_writeful_tools.sql.
// No audit append → no freshTenant() needed (see [[choros-db-test-shared-db-gotcha]]).
//
// F-1: doc_page_author tool row exists with correct resource_ops
//       [{doc_page,create},{doc_page,update}] — UUID 10...013.
// F-2: doc_ref_set tool row exists with correct resource_ops
//       [{doc_page,update}] — UUID 10...014.
// F-3: both tools have pure_compute=true AND declares='[]' (mcp_tool_pure_empty_chk).
// F-4: isToolReachable(doc_page_author, [create, update]) = true;
//       isToolReachable(doc_ref_set, [create, update]) = true (pure unit, no IO).
// F-4b necessary-condition: remove {doc_page,update} → doc_ref_set unreachable;
//       remove both grants → both unreachable (AC-12 structural).
// F-5: read-only principal ({doc_page,read} only) cannot reach doc_page_author or doc_ref_set.
// F-6: docs-MCP read-only tool names (docs_list/docs_read/docs_search) do NOT appear in
//       mcp_tool table with any write operation, AND are not the same rows as 10...013/014.
// F-7: idempotent re-run of migration 063 INSERTs leaves tool counts stable.
// F-10: docs-author role (e0...005) still has exactly 2 grant rows (count unchanged from P-1).

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

// Dev-tenant and seed UUIDs from migrations 062 + 063.
const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '11111111-1111-1111-1111-111111111111'; // TENANT_A from _helpers

// P-2 mcp_tool UUIDs (migration 063)
const TOOL_DOC_PAGE_AUTHOR_UUID = '10000000-0000-0000-0000-000000000013';
const TOOL_DOC_REF_SET_UUID     = '10000000-0000-0000-0000-000000000014';

// P-1 grant UUIDs (migration 062) — these are the authority that covers P-2 tools
const GRANT_CREATE_UUID = 'e2000000-0000-0000-0000-000000000018';
const GRANT_UPDATE_UUID = 'e2000000-0000-0000-0000-000000000019';
const ROLE_DOCS_AUTHOR  = 'e0000000-0000-0000-0000-000000000005';

// ---------------------------------------------------------------------------
// F-1 — doc_page_author tool row exists with correct resource_ops
// ---------------------------------------------------------------------------

describe('F-1: doc_page_author tool row exists with correct UUID and resource_ops', () => {
  it('doc_page_author row present with UUID 10...013 and resource_ops [{doc_page,create},{doc_page,update}]', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT name, pure_compute, declares, resource_ops::text AS resource_ops_text
           FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND id = $2`,
        [DEV_TENANT, TOOL_DOC_PAGE_AUTHOR_UUID],
      );
      expect(rows.length, 'doc_page_author tool row missing').toBe(1);
      expect(rows[0].name).toBe('doc_page_author');
    });
  });

  it('resource_ops matches [{resourceType:doc_page,operation:create},{resourceType:doc_page,operation:update}]', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND name = 'doc_page_author'
            AND resource_ops = '[{"resourceType":"doc_page","operation":"create"},{"resourceType":"doc_page","operation":"update"}]'::jsonb`,
        [DEV_TENANT],
      );
      expect(rows[0].n, 'doc_page_author resource_ops mismatch').toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// F-2 — doc_ref_set tool row exists with correct resource_ops
// ---------------------------------------------------------------------------

describe('F-2: doc_ref_set tool row exists with correct UUID and resource_ops', () => {
  it('doc_ref_set row present with UUID 10...014 and resource_ops [{doc_page,update}]', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT name, pure_compute, declares
           FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND id = $2`,
        [DEV_TENANT, TOOL_DOC_REF_SET_UUID],
      );
      expect(rows.length, 'doc_ref_set tool row missing').toBe(1);
      expect(rows[0].name).toBe('doc_ref_set');
    });
  });

  it('resource_ops matches [{resourceType:doc_page,operation:update}]', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND name = 'doc_ref_set'
            AND resource_ops = '[{"resourceType":"doc_page","operation":"update"}]'::jsonb`,
        [DEV_TENANT],
      );
      expect(rows[0].n, 'doc_ref_set resource_ops mismatch').toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// F-3 — pure_compute=true AND declares='[]' on both P-2 tools
// ---------------------------------------------------------------------------

describe('F-3: pure_compute=true and declares=[] on both P-2 tools (mcp_tool_pure_empty_chk)', () => {
  it('both doc_page_author and doc_ref_set have pure_compute=true and declares=[]', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND name IN ('doc_page_author', 'doc_ref_set')
            AND pure_compute = true
            AND declares = '[]'::jsonb`,
        [DEV_TENANT],
      );
      expect(rows[0].n, 'expected 2 tools with pure_compute=true and declares=[]').toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// F-4 — isToolReachable under P-1 grants (pure unit, no IO)
// ---------------------------------------------------------------------------

describe('F-4: isToolReachable — doc_page_author and doc_ref_set reachable via docs-author grants', () => {
  const FAKE_TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const SCOPE = { kind: 'set' as const, members: [] };
  const NOW_MS = 1_700_000_000_000;

  // Synthetic grants mirroring P-1 migration 062
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

  // P-2 tool shapes (mirror ADR §4.2 exactly)
  const docPageAuthorTool: McpToolRow = {
    tenantId: FAKE_TENANT,
    id: TOOL_DOC_PAGE_AUTHOR_UUID,
    name: 'doc_page_author',
    description: 'P-2 doc_page_author tool',
    declares: [],
    pureCompute: true,
    resourceOps: [
      { resourceType: 'doc_page' as ResourceType, operation: 'create' as Operation },
      { resourceType: 'doc_page' as ResourceType, operation: 'update' as Operation },
    ],
    createdAt: 0,
    updatedAt: 0,
  };
  const docRefSetTool: McpToolRow = {
    tenantId: FAKE_TENANT,
    id: TOOL_DOC_REF_SET_UUID,
    name: 'doc_ref_set',
    description: 'P-2 doc_ref_set tool',
    declares: [],
    pureCompute: true,
    resourceOps: [
      { resourceType: 'doc_page' as ResourceType, operation: 'update' as Operation },
    ],
    createdAt: 0,
    updatedAt: 0,
  };

  it('doc_page_author is reachable with both P-1 grants', () => {
    const result = isToolReachable(
      docPageAuthorTool,
      [grantCreate, grantUpdate],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'doc_page_author must be reachable with both doc_page grants').toBe(true);
  });

  it('doc_ref_set is reachable with both P-1 grants (rides doc_page:update)', () => {
    const result = isToolReachable(
      docRefSetTool,
      [grantCreate, grantUpdate],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'doc_ref_set must be reachable with doc_page:update grant present').toBe(true);
  });

  it('doc_ref_set is reachable with update grant alone (only needs doc_page:update)', () => {
    const result = isToolReachable(
      docRefSetTool,
      [grantUpdate],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'doc_ref_set must be reachable with update-only grant (rides update)').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-4b — necessary-condition sub-tests
// ---------------------------------------------------------------------------

describe('F-4b: necessary-condition — remove grants → tools become unreachable', () => {
  const FAKE_TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const SCOPE = { kind: 'set' as const, members: [] };
  const NOW_MS = 1_700_000_000_000;

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

  const docPageAuthorTool: McpToolRow = {
    tenantId: FAKE_TENANT,
    id: TOOL_DOC_PAGE_AUTHOR_UUID,
    name: 'doc_page_author',
    description: 'P-2 doc_page_author tool',
    declares: [],
    pureCompute: true,
    resourceOps: [
      { resourceType: 'doc_page' as ResourceType, operation: 'create' as Operation },
      { resourceType: 'doc_page' as ResourceType, operation: 'update' as Operation },
    ],
    createdAt: 0,
    updatedAt: 0,
  };
  const docRefSetTool: McpToolRow = {
    tenantId: FAKE_TENANT,
    id: TOOL_DOC_REF_SET_UUID,
    name: 'doc_ref_set',
    description: 'P-2 doc_ref_set tool',
    declares: [],
    pureCompute: true,
    resourceOps: [
      { resourceType: 'doc_page' as ResourceType, operation: 'update' as Operation },
    ],
    createdAt: 0,
    updatedAt: 0,
  };

  it('remove {doc_page,update} → doc_ref_set becomes unreachable', () => {
    // Only create grant remains; doc_ref_set needs update
    const result = isToolReachable(
      docRefSetTool,
      [grantCreate],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'doc_ref_set must be unreachable without update grant').toBe(false);
  });

  it('remove both grants → doc_page_author unreachable (AC-12: 0 grants → 0 tools)', () => {
    const result = isToolReachable(
      docPageAuthorTool,
      [],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'doc_page_author must be unreachable with zero grants').toBe(false);
  });

  it('remove both grants → doc_ref_set unreachable (AC-12: 0 grants → 0 tools)', () => {
    const result = isToolReachable(
      docRefSetTool,
      [],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'doc_ref_set must be unreachable with zero grants').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-5 — read-only principal cannot reach either P-2 tool
// ---------------------------------------------------------------------------

describe('F-5: read-only principal ({doc_page,read} only) cannot reach P-2 tools', () => {
  const FAKE_TENANT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const SCOPE = { kind: 'set' as const, members: [] };
  const NOW_MS = 1_700_000_000_000;

  const grantReadOnly: Grant = {
    tenantId: FAKE_TENANT,
    id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    roleId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    resourceType: 'doc_page' as ResourceType,
    operation: 'read' as Operation,
    scope: SCOPE,
    delegable: false,
    grantedBy: 'seed',
    createdAt: 0,
  };

  const docPageAuthorTool: McpToolRow = {
    tenantId: FAKE_TENANT,
    id: TOOL_DOC_PAGE_AUTHOR_UUID,
    name: 'doc_page_author',
    description: 'P-2 doc_page_author tool',
    declares: [],
    pureCompute: true,
    resourceOps: [
      { resourceType: 'doc_page' as ResourceType, operation: 'create' as Operation },
      { resourceType: 'doc_page' as ResourceType, operation: 'update' as Operation },
    ],
    createdAt: 0,
    updatedAt: 0,
  };
  const docRefSetTool: McpToolRow = {
    tenantId: FAKE_TENANT,
    id: TOOL_DOC_REF_SET_UUID,
    name: 'doc_ref_set',
    description: 'P-2 doc_ref_set tool',
    declares: [],
    pureCompute: true,
    resourceOps: [
      { resourceType: 'doc_page' as ResourceType, operation: 'update' as Operation },
    ],
    createdAt: 0,
    updatedAt: 0,
  };

  it('doc_page_author NOT reachable with read-only grant (no create/update grant)', () => {
    const result = isToolReachable(
      docPageAuthorTool,
      [grantReadOnly],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'doc_page_author must NOT be reachable from read-only principal').toBe(false);
  });

  it('doc_ref_set NOT reachable with read-only grant (no update grant)', () => {
    const result = isToolReachable(
      docRefSetTool,
      [grantReadOnly],
      FAKE_TENANT,
      NOW_MS,
    );
    expect(result, 'doc_ref_set must NOT be reachable from read-only principal').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-6 — no docs-MCP read-only tool name carries write ops; P-2 UUIDs not in read surface
// ---------------------------------------------------------------------------

describe('F-6: docs-MCP read-only tool names (docs_list/docs_read/docs_search) have no write ops; P-2 UUIDs not in that set', () => {
  it('zero mcp_tool rows named docs_list/docs_read/docs_search with create or update operation', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE name IN ('docs_list', 'docs_read', 'docs_search')
            AND (resource_ops::text LIKE '%"create"%' OR resource_ops::text LIKE '%"update"%')`,
        [],
      );
      expect(rows[0].n, 'read-only docs-MCP tools must not carry create/update ops').toBe(0);
    });
  });

  it('P-2 tool UUIDs (10...013, 10...014) are not named docs_list/docs_read/docs_search', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE name IN ('docs_list', 'docs_read', 'docs_search')
            AND id IN ($1, $2)`,
        [TOOL_DOC_PAGE_AUTHOR_UUID, TOOL_DOC_REF_SET_UUID],
      );
      expect(rows[0].n, 'P-2 tool UUIDs must not belong to read-only docs-MCP surface').toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// F-7 — idempotent re-run of migration 063
// ---------------------------------------------------------------------------

describe('F-7: migration 063 idempotency (ON CONFLICT DO NOTHING)', () => {
  it('re-inserting migration 063 rows does not change tool counts', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows: before } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND name IN ('doc_page_author', 'doc_ref_set')`,
        [DEV_TENANT],
      );

      // Re-run both INSERTs (must be ON CONFLICT DO NOTHING)
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO choros.mcp_tool
           (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
         VALUES
           ($1, $2, 'doc_page_author',
            'Create or update a doc_page in the agent-maintained wiki.',
            '[]'::jsonb, true,
            '[{"resourceType":"doc_page","operation":"create"},{"resourceType":"doc_page","operation":"update"}]'::jsonb,
            0, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, TOOL_DOC_PAGE_AUTHOR_UUID],
      );
      await c.query(
        `INSERT INTO choros.mcp_tool
           (tenant_id, id, name, description, declares, pure_compute, resource_ops, created_at, updated_at)
         VALUES
           ($1, $2, 'doc_ref_set',
            'Set/replace the typed doc_ref rows for a given doc_page.',
            '[]'::jsonb, true,
            '[{"resourceType":"doc_page","operation":"update"}]'::jsonb,
            0, 0)
         ON CONFLICT DO NOTHING`,
        [DEV_TENANT, TOOL_DOC_REF_SET_UUID],
      );
      await c.query('COMMIT');

      const { rows: after } = await c.query(
        `SELECT count(*)::int AS n FROM choros.mcp_tool
          WHERE tenant_id = $1
            AND name IN ('doc_page_author', 'doc_ref_set')`,
        [DEV_TENANT],
      );
      expect(after[0].n, 'tool count changed after idempotent re-run').toBe(before[0].n);
    });
  });
});

// ---------------------------------------------------------------------------
// F-10 — docs-author role still has exactly 2 grant rows (P-1 unchanged)
// ---------------------------------------------------------------------------

describe('F-10: docs-author role (e0...005) still has exactly 2 grant rows (P-1 count unchanged by P-2)', () => {
  it('count of grant rows for docs-author role = 2 (P-2 adds no new grants)', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant"
          WHERE tenant_id = $1
            AND role_id = $2`,
        [DEV_TENANT, ROLE_DOCS_AUTHOR],
      );
      expect(rows[0].n, 'docs-author grant count must remain 2 (P-2 must add zero grants)').toBe(2);
    });
  });
});
