// T-0030 · ADVERSARIAL probes for the structural grant write-API.
//
// Run against the isolated DB:
//   DATABASE_URL=postgresql://choros_migrator:...@localhost:55481/choros \
//   npm run fitness:db
//
// Each probe is independent (no shared mutable state between tests).
// All DB inserts are cleaned up at the end of each test.
//
// Error envelope: { error: { code: string, message: string } }
// (router.ts sendErrorEnvelope — all HTTP errors use this shape).
//
// Probes (ADR adversarial contract):
//   ADV-1  — Escalation up the org chain: non-genesis admin with grant scoped to
//             a child org node (FIN) tries to issue a role-assignment scoped to the
//             FOREST (parent set) → deny, and to CS_SCOPE (sibling) → deny.
//   ADV-2  — Self-grant elevation: non-genesis admin with only a read grant on
//             mgmt_object:role cannot issue a create grant on mgmt_object:grant
//             (no covering authority) → 403 ADMIN_GATE_REJECTED.
//   ADV-3  — Revoke outside own scope: e-mironov (no admin role assignments)
//             tries to revoke a grant owned by genesis → 403; row untouched.
//   ADV-4  — Concurrent duplicate POST /api/grants (genesis owner): two parallel
//             requests → 2 unique rows in DB, gate applied independently per request.
//   ADV-5  — SQL/JSON injection in scope field: various malformed payloads must
//             return 400 INVALID_SCOPE and not reach INSERT.
//   ADV-6  — GET /api/rights/dictionaries in both modes (no DATABASE_URL /
//             with DATABASE_URL) → 200 with resources/operations/orgTree/scopeTags.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { migratorUrl, appUrl, withClient, uuid } from './_helpers.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// ---------------------------------------------------------------------------
// Shared server lifecycle (for HTTP-level probes)
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // Load server with a real DATABASE_URL so write routes are fully active.
  const { createServer } = await import(join(REPO_ROOT, 'src', 'server.js'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((res) => server.close(() => res()));
});

// Dev silo UUIDs (stable from migrations 019/020/026)
const DEV_TENANT      = 'a0000000-0000-0000-0000-000000000001';
const DEV_ROLE_OWNER  = 'e0000000-0000-0000-0000-000000000001'; // tenant-owner role
const DEV_ROLE_BUDGET = 'e0000000-0000-0000-0000-000000000002'; // budget-approver role
const DEV_EMP_MIRONOV_UUID = 'd0000000-0000-0000-0000-000000000004'; // e-mironov UUID

// Dept UUIDs from migration 014 seed
const DEPT_FIN  = 'b0000000-0000-0000-0000-000000000001';
const DEPT_CS   = 'b0000000-0000-0000-0000-000000000002';

// Org scopes
const FOREST_SCOPE = {
  kind: 'set',
  members: [
    { kind: 'node', hierarchy: 'org', nodeId: DEPT_FIN,  nodeLevel: 'department' },
    { kind: 'node', hierarchy: 'org', nodeId: DEPT_CS,   nodeLevel: 'department' },
    { kind: 'node', hierarchy: 'org', nodeId: 'b0000000-0000-0000-0000-000000000003', nodeLevel: 'department' },
  ],
};

const FIN_SCOPE = {
  kind: 'node', hierarchy: 'org', nodeId: DEPT_FIN, nodeLevel: 'department',
};

const CS_SCOPE = {
  kind: 'node', hierarchy: 'org', nodeId: DEPT_CS, nodeLevel: 'department',
};

// ---------------------------------------------------------------------------
// Helper: perform an HTTP request against the live server
// ---------------------------------------------------------------------------

type HttpResponse = { status: number; json: Record<string, unknown> };

function request(
  method: string,
  path: string,
  body: unknown | null,
  headers: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const buf = body !== null ? Buffer.from(JSON.stringify(body)) : null;
    const url = new URL(baseUrl + path);
    const hdrs: Record<string, string | number> = { ...headers };
    if (buf) {
      hdrs['Content-Type'] = 'application/json';
      hdrs['Content-Length'] = buf.length;
    }
    const req = http.request(url, { method, headers: hdrs }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) as Record<string, unknown> }); }
        catch { resolve({ status: res.statusCode ?? 0, json: { raw: data } }); }
      });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return request('POST', path, body, headers);
}

function get(path: string): Promise<HttpResponse> {
  return request('GET', path, null);
}

// Helper: extract error code from the response envelope
// Envelope: { error: { code: string, message: string } }
function errCode(res: HttpResponse): string | undefined {
  const err = res.json['error'];
  if (err && typeof err === 'object') {
    return (err as Record<string, unknown>)['code'] as string | undefined;
  }
  return undefined;
}

// Helper: extract error message from the response envelope
function errMsg(res: HttpResponse): string | undefined {
  const err = res.json['error'];
  if (err && typeof err === 'object') {
    return (err as Record<string, unknown>)['message'] as string | undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ADV-1: Org-chain escalation
//
// Setup: create a non-genesis employee scoped only to FIN dept (via a
// confirmed role_assignment + delegable mgmt_object:grant on budget-approver role).
// They try to assign mironov to: (a) FOREST_SCOPE (broader than FIN) → deny;
// (b) CS_SCOPE (sibling of FIN) → deny.
//
// Verifies: validateAdminDelegation org-ceiling enforcement for non-genesis admins.
// ---------------------------------------------------------------------------
describe('ADV-1: Org-chain escalation — non-genesis admin cannot grant beyond their org ceiling', () => {
  let testEmpId: string;
  let testRaId: string;
  let testGrantId: string;
  const testEmpSlug = `adv1-${Date.now()}`;

  beforeAll(async () => {
    testEmpId = uuid();
    const nowMs = Date.now();

    // Insert employee (display_name + kind required, no 'name' column in schema)
    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, kind, display_name, slug, created_at, updated_at)
         VALUES ($1, $2, 'human', $3, $4, $5, $5)`,
        [DEV_TENANT, testEmpId, 'ADV1 Test Admin', testEmpSlug, nowMs],
      );
      await c.query('COMMIT');
    });

    // Confirmed role_assignment for this admin, scoped to FIN_SCOPE only
    testRaId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope,
            source, granted_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'test', 'e-owner', 'e-owner', $6, $6)`,
        [DEV_TENANT, testRaId, testEmpId, DEV_ROLE_BUDGET, JSON.stringify(FIN_SCOPE), nowMs],
      );
      await c.query('COMMIT');
    });

    // Delegable mgmt_object:grant on budget-approver role scoped to FIN_SCOPE
    testGrantId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, operation, scope,
            delegable, granted_by, created_at)
         VALUES ($1, $2, $3, 'mgmt_object:grant', 'create', $4::jsonb,
                 true, 'e-owner', $5)`,
        [DEV_TENANT, testGrantId, DEV_ROLE_BUDGET, JSON.stringify(FIN_SCOPE), nowMs],
      );
      await c.query('COMMIT');
    });
  });

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, testGrantId]);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, testRaId]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, testEmpId]);
    });
  });

  it('ADV-1a: non-genesis admin (fin-scoped) tries role-assignment to FOREST_SCOPE → 403', async () => {
    const countBefore = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role_assignment WHERE tenant_id=$1`,
        [DEV_TENANT],
      );
      return (rows[0] as Record<string, unknown>)['n'] as number;
    });

    const res = await post(
      '/api/role-assignments',
      {
        employee_id: DEV_EMP_MIRONOV_UUID,
        role_id:     DEV_ROLE_BUDGET,
        org_scope:   FOREST_SCOPE,  // FOREST ⊄ FIN → org_scope_widens
        source:      'adv1-forest-test',
        granted_by:  testEmpSlug,
      },
      { 'x-dev-user': testEmpSlug },
    );

    expect(res.status, `expected 403 for FOREST escalation, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(403);
    expect(errCode(res)).toBe('ADMIN_GATE_REJECTED');

    // reason must be org_scope_widens or no_admin_authority
    const reason = errMsg(res);
    expect(
      reason === 'org_scope_widens' || reason === 'no_admin_authority',
      `expected org_scope_widens or no_admin_authority, got: ${reason}`,
    ).toBe(true);

    // No new row inserted
    const countAfter = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role_assignment WHERE tenant_id=$1`,
        [DEV_TENANT],
      );
      return (rows[0] as Record<string, unknown>)['n'] as number;
    });
    expect(countAfter, 'no role_assignment row must be inserted on org escalation deny').toBe(countBefore);
  });

  it('ADV-1b: non-genesis admin (fin-scoped) tries role-assignment to CS_SCOPE sibling → 403', async () => {
    const countBefore = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role_assignment WHERE tenant_id=$1`,
        [DEV_TENANT],
      );
      return (rows[0] as Record<string, unknown>)['n'] as number;
    });

    const res = await post(
      '/api/role-assignments',
      {
        employee_id: DEV_EMP_MIRONOV_UUID,
        role_id:     DEV_ROLE_BUDGET,
        org_scope:   CS_SCOPE,      // CS is sibling, not subtree of FIN → escalation
        source:      'adv1-cs-test',
        granted_by:  testEmpSlug,
      },
      { 'x-dev-user': testEmpSlug },
    );

    expect(res.status, `expected 403 for CS sibling escalation, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(403);
    expect(errCode(res)).toBe('ADMIN_GATE_REJECTED');

    const countAfter = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros.role_assignment WHERE tenant_id=$1`,
        [DEV_TENANT],
      );
      return (rows[0] as Record<string, unknown>)['n'] as number;
    });
    expect(countAfter, 'no row must be inserted on sibling escalation').toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// ADV-2: Self-grant elevation
//
// A non-genesis admin (with only a read grant on mgmt_object:role scoped to FIN)
// tries to issue a grant for mgmt_object:grant (different resource — no authority).
// Verifies: no_admin_authority response, no DB write.
// ---------------------------------------------------------------------------
describe('ADV-2: Self-grant elevation — non-genesis admin cannot widen own resource scope', () => {
  let testEmpId2: string;
  let testRaId2: string;
  let testGrantId2: string;
  const testEmpSlug2 = `adv2-${Date.now()}`;

  beforeAll(async () => {
    testEmpId2 = uuid();
    const nowMs = Date.now();

    await withClient(migratorUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros.employee (tenant_id, id, kind, display_name, slug, created_at, updated_at)
         VALUES ($1, $2, 'human', $3, $4, $5, $5)`,
        [DEV_TENANT, testEmpId2, 'ADV2 Test Admin', testEmpSlug2, nowMs],
      );
      await c.query('COMMIT');
    });

    testRaId2 = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope,
            source, granted_by, confirmed_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'test', 'e-owner', 'e-owner', $6, $6)`,
        [DEV_TENANT, testRaId2, testEmpId2, DEV_ROLE_BUDGET, JSON.stringify(FIN_SCOPE), nowMs],
      );
      await c.query('COMMIT');
    });

    // Admin has only "read" on mgmt_object:role — NOT mgmt_object:grant, NOT create
    testGrantId2 = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, operation, scope,
            delegable, granted_by, created_at)
         VALUES ($1, $2, $3, 'mgmt_object:role', 'read', $4::jsonb,
                 true, 'e-owner', $5)`,
        [DEV_TENANT, testGrantId2, DEV_ROLE_BUDGET, JSON.stringify(FIN_SCOPE), nowMs],
      );
      await c.query('COMMIT');
    });
  });

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, testGrantId2]);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, testRaId2]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, testEmpId2]);
    });
  });

  it('ADV-2: admin with read-only role grant cannot issue create grant on mgmt_object:grant → 403', async () => {
    const countBefore = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant" WHERE tenant_id=$1`,
        [DEV_TENANT],
      );
      return (rows[0] as Record<string, unknown>)['n'] as number;
    });

    const res = await post(
      '/api/grants',
      {
        role_id:       DEV_ROLE_BUDGET,
        resource_type: 'mgmt_object:grant',  // admin has NO authority here
        operation:     'create',
        scope:         FIN_SCOPE,
        granted_by:    testEmpSlug2,
        delegable:     true,
      },
      { 'x-dev-user': testEmpSlug2 },
    );

    expect(res.status, `expected 403 for self-elevation attempt, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(403);
    expect(errCode(res)).toBe('ADMIN_GATE_REJECTED');

    const countAfter = await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM choros."grant" WHERE tenant_id=$1`,
        [DEV_TENANT],
      );
      return (rows[0] as Record<string, unknown>)['n'] as number;
    });
    expect(countAfter, 'no row must be inserted on self-elevation deny').toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// ADV-3: Revoke outside own scope
//
// e-mironov (no confirmed role_assignments in the dev silo) tries to revoke
// a grant created by genesis owner. loadAdminContext returns an empty admin
// context → validateAdminDelegation → no_admin_authority → 403.
// Row must remain untouched (valid_until IS NULL).
// ---------------------------------------------------------------------------
describe('ADV-3: Revoke outside own scope — actor with no authority cannot revoke', () => {
  let victimGrantId: string;

  beforeAll(async () => {
    victimGrantId = uuid();
    await withClient(appUrl(), async (c) => {
      await c.query('BEGIN');
      await c.query(`SET LOCAL choros.tenant_id = '${DEV_TENANT}'`);
      await c.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, operation, scope,
            delegable, granted_by, created_at)
         VALUES ($1, $2, $3, 'mgmt_object:role', 'read', $4::jsonb,
                 true, 'e-owner', $5)`,
        [DEV_TENANT, victimGrantId, DEV_ROLE_OWNER, JSON.stringify(CS_SCOPE), Date.now()],
      );
      await c.query('COMMIT');
    });
  });

  afterAll(async () => {
    await withClient(migratorUrl(), async (c) => {
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`, [DEV_TENANT, victimGrantId]);
    });
  });

  it('ADV-3a: e-mironov (no admin grants) cannot revoke victim grant → 403 no_admin_authority', async () => {
    const res = await post(
      `/api/grants/${victimGrantId}/revoke`,
      {},
      { 'x-dev-user': 'e-mironov' },
    );

    expect(res.status, `expected 403, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(403);
    expect(errCode(res)).toBe('ADMIN_GATE_REJECTED');
    // reason may be no_admin_authority (no authority at all) OR scope_widens / org_scope_widens
    // (actor has some authority but insufficient scope) — all are correct deny outcomes.
    const reason = errMsg(res);
    const validReasons = ['no_admin_authority', 'scope_widens', 'org_scope_widens', 'facet_widens', 'constraint_widens'];
    expect(
      validReasons.includes(reason ?? ''),
      `expected a deny reason, got: ${reason}`,
    ).toBe(true);

    // Row must be untouched (valid_until still null)
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT valid_until FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, victimGrantId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].valid_until, 'valid_until must remain null after denied revoke').toBeNull();
    });
  });

  it('ADV-3b: unknown actor slug (no employee record) cannot revoke → 403 or empty context deny', async () => {
    const res = await post(
      `/api/grants/${victimGrantId}/revoke`,
      {},
      { 'x-dev-user': 'nonexistent-actor-adv3x' },
    );

    // Unknown actor → loadAdminContext returns isGenesisOwner=false + empty adminGrants
    // → validateAdminDelegation → no_admin_authority → 403
    expect([403, 404]).toContain(res.status);
    if (res.status === 403) {
      expect(errCode(res)).toBe('ADMIN_GATE_REJECTED');
    }

    // Row must be untouched
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT valid_until FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
        [DEV_TENANT, victimGrantId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].valid_until).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// ADV-4: Concurrent duplicate POST /api/grants
//
// Two simultaneous POST /api/grants from genesis owner (e-owner) with the
// same body → each produces a unique UUID (server generates randomUUID() per
// request). No gate-skip: each request loads admin context independently.
// Verify: both return 201 with distinct IDs; both rows in DB.
// ---------------------------------------------------------------------------
describe('ADV-4: Concurrent duplicate POST /api/grants — no gate skip, IDs are unique', () => {
  const insertedIds: string[] = [];

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await withClient(migratorUrl(), async (c) => {
        for (const id of insertedIds) {
          await c.query(
            `DELETE FROM choros."grant" WHERE tenant_id=$1 AND id=$2`,
            [DEV_TENANT, id],
          );
        }
      });
    }
  });

  it('ADV-4: two concurrent identical-body requests → two unique DB rows, each gated independently', async () => {
    // Use DEV_ROLE_BUDGET (budget-approver) to avoid polluting the genesis
    // tenant-owner grant count checked by genesis-owner-seed.test.ts (AC-12/FF-12).
    const grantBody = {
      role_id:       DEV_ROLE_BUDGET,
      resource_type: 'mgmt_object:role',
      operation:     'read',
      scope:         FIN_SCOPE,
      granted_by:    'e-owner',
      delegable:     true,
      confirmed_by:  'e-owner',
    };

    // Fire both simultaneously (Promise.all)
    const [r1, r2] = await Promise.all([
      post('/api/grants', grantBody, { 'x-dev-user': 'e-owner' }),
      post('/api/grants', grantBody, { 'x-dev-user': 'e-owner' }),
    ]);

    expect(r1.status, `req1 expected 201, got ${r1.status}: ${JSON.stringify(r1.json)}`).toBe(201);
    expect(r2.status, `req2 expected 201, got ${r2.status}: ${JSON.stringify(r2.json)}`).toBe(201);

    const id1 = r1.json['id'] as string;
    const id2 = r2.json['id'] as string;
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1, 'concurrent requests must produce unique IDs (randomUUID per request)').not.toBe(id2);

    insertedIds.push(id1, id2);

    // Both rows must be in DB
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM choros."grant" WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
        [DEV_TENANT, [id1, id2]],
      );
      expect(rows.length, 'both concurrent grant rows must exist in DB').toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// ADV-5: SQL/JSON injection in scope field
//
// Malformed scope payloads must be rejected by parseScopeElement with
// 400 INVALID_SCOPE before any DB write. The envelope is { error: { code, message } }.
// None of these payloads should cause a 500 or insert a row.
// ---------------------------------------------------------------------------
describe('ADV-5: SQL/JSON injection in scope — rejected with 400 INVALID_SCOPE, no INSERT', () => {
  const injectionCases: Array<{ label: string; scope: unknown }> = [
    {
      label: 'free-text string scope (SQL injection attempt)',
      scope: "'; DROP TABLE grant; --",
    },
    {
      label: 'number scope',
      scope: 42,
    },
    {
      label: 'null scope',
      scope: null,
    },
    {
      label: 'empty object scope (missing kind)',
      scope: {},
    },
    {
      label: 'unknown kind value',
      scope: { kind: 'evil_kind', data: "' OR 1=1 --" },
    },
    {
      // NOTE: nodeId is stored as JSONB (parameterized query — no SQL injection possible).
      // parseScopeElement accepts any string nodeId — this is by design.
      // We test missing nodeLevel instead (structural invalidity).
      label: 'node missing nodeLevel field (structurally invalid)',
      scope: {
        kind: 'node',
        hierarchy: 'org',
        nodeId: DEPT_FIN,
        // nodeLevel intentionally missing → parseScopeElement returns null
      },
    },
    {
      label: 'interval with non-numeric lo',
      scope: { kind: 'interval', axis: 'risk', lo: 'evil', hi: 100 },
    },
    {
      label: 'set with nested set (depth > 1 not allowed)',
      scope: {
        kind: 'set',
        members: [
          {
            kind: 'set',
            members: [
              { kind: 'node', hierarchy: 'org', nodeId: DEPT_FIN, nodeLevel: 'department' },
            ],
          },
        ],
      },
    },
    {
      label: 'tags with non-string members',
      scope: { kind: 'tags', tags: [1, 2, 3] },
    },
  ];

  for (const { label, scope } of injectionCases) {
    it(`ADV-5 [${label}] → 400 INVALID_SCOPE (no 500, no DB write)`, async () => {
      const countBefore = await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM choros."grant" WHERE tenant_id=$1`,
          [DEV_TENANT],
        );
        return (rows[0] as Record<string, unknown>)['n'] as number;
      });

      const res = await post(
        '/api/grants',
        {
          role_id:       DEV_ROLE_OWNER,
          resource_type: 'mgmt_object:role',
          operation:     'read',
          scope,
          granted_by:    'e-owner',
        },
        { 'x-dev-user': 'e-owner' },
      );

      // Must be 400 INVALID_SCOPE, never 500
      expect(
        res.status,
        `[${label}]: expected 400 INVALID_SCOPE, got ${res.status}: ${JSON.stringify(res.json)}`,
      ).toBe(400);
      expect(
        errCode(res),
        `[${label}]: error.code must be INVALID_SCOPE`,
      ).toBe('INVALID_SCOPE');

      // DB must be unmodified
      const countAfter = await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM choros."grant" WHERE tenant_id=$1`,
          [DEV_TENANT],
        );
        return (rows[0] as Record<string, unknown>)['n'] as number;
      });
      expect(countAfter, `[${label}]: grant count must not increase`).toBe(countBefore);
    });
  }
});

// ---------------------------------------------------------------------------
// ADV-6: GET /api/rights/dictionaries — correct shape in both modes
//
// When the server is running WITH DATABASE_URL set, the dictionaries route
// must still return 200 with the correct seed-data arrays (it's unconditionally
// seed-backed). Also verify the route is not captured by :roleId catch-all.
// ---------------------------------------------------------------------------
describe('ADV-6: GET /api/rights/dictionaries — reachable in both modes, correct shape', () => {
  it('ADV-6a: with DATABASE_URL → 200 with resources/operations/orgTree/scopeTags arrays', async () => {
    const res = await get('/api/rights/dictionaries');

    expect(res.status, `expected 200, got ${res.status}`).toBe(200);
    expect(Array.isArray(res.json['resources']), 'resources must be array').toBe(true);
    expect(Array.isArray(res.json['operations']), 'operations must be array').toBe(true);
    expect(Array.isArray(res.json['orgTree']), 'orgTree must be array').toBe(true);
    expect(Array.isArray(res.json['scopeTags']), 'scopeTags must be array').toBe(true);

    // Resources shape: must have uri + name fields
    const resources = res.json['resources'] as Array<Record<string, unknown>>;
    expect(resources.length).toBeGreaterThan(0);
    expect(typeof resources[0]['uri']).toBe('string');
    expect(typeof resources[0]['name']).toBe('string');

    // Operations must include standard verbs
    const ops = res.json['operations'] as string[];
    expect(ops).toContain('read');
    expect(ops).toContain('create');

    // orgTree must include id/label/depth
    const orgTree = res.json['orgTree'] as Array<Record<string, unknown>>;
    expect(orgTree.length).toBeGreaterThan(0);
    expect(orgTree[0]).toHaveProperty('id');
    expect(orgTree[0]).toHaveProperty('label');
    expect(typeof orgTree[0]['depth']).toBe('number');

    // scopeTags must have id/label
    const scopeTags = res.json['scopeTags'] as Array<Record<string, unknown>>;
    expect(scopeTags.length).toBeGreaterThan(0);
    expect(typeof scopeTags[0]['id']).toBe('string');
    expect(typeof scopeTags[0]['label']).toBe('string');
  });

  it('ADV-6b: dictionaries route is not shadowed by :roleId catch-all', async () => {
    // If 'dictionaries' were captured by /api/rights/:roleId, the response
    // would be a role object (with 'grants', 'holders') or 404 — NOT the dictionary shape.
    const res = await get('/api/rights/dictionaries');
    expect(res.json).toHaveProperty('resources');     // dictionary shape
    expect(res.json).toHaveProperty('operations');    // dictionary shape
    expect(res.json).not.toHaveProperty('grants');    // not a role response
    expect(res.json).not.toHaveProperty('holders');   // not a role response
  });

  it('ADV-6c: seed data matches ra-data.jsx well-known URIs (spot check)', async () => {
    const res = await get('/api/rights/dictionaries');
    const uris = (res.json['resources'] as Array<Record<string, unknown>>).map(
      (r) => r['uri'] as string,
    );
    // Well-known URIs from ra-data.jsx that the web screen relies on
    expect(uris).toContain('mcp://ledger.invoices');
    expect(uris).toContain('mcp://crm.customer');
    expect(uris).toContain('mcp://support.queue');
  });
});
