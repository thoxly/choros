/**
 * src/__tests__/rights-overview.test.ts — T-0572 [D2/D5]
 *
 * Static (no-DB) tests for GET /api/rights/tenant-state. Uses a stub pg.Pool
 * that discriminates query results by SQL pattern (same convention as
 * rights-change-requests.test.ts).
 *
 * Covers:
 *   RO-1  0 roles ⇒ {scope, can_manage, roles:[]} — no `demo` field (AC-2)
 *   RO-2  admin (isGenesisOwner) ⇒ scope:"tenant", can_manage:true
 *   RO-3  ordinary actor (no mgmt_object grant, not owner) ⇒ scope:"self",
 *         can_manage:false (AC-9)
 *   RO-4  semi-confirmed rows land in pending, never in active arrays (AC-8)
 *   RO-5  401 without auth header
 *   RO-6  active predicate: routine (proposed_by NULL, confirmed_by set) is
 *         active even though confirmed2_by is NULL (mirrors grants.ts write
 *         semantics, ADR §2.1)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerRightsOverviewRoutes } from "../http/rights-overview.js";
import pg from "pg";

const TENANT_A = "a0000000-0000-0000-0000-000000000001";
const ROLE_1 = "c0000000-0000-0000-0000-000000000001";
const ACTOR_ADMIN = "e-admin";
const ACTOR_ORDINARY = "e-ordinary";

interface StubOptions {
  roleRows?: Record<string, unknown>[];
  assignmentRows?: Record<string, unknown>[];
  grantRows?: Record<string, unknown>[];
  /** Rows returned for the loadAdminContext genesis-owner check. */
  ownerRows?: Record<string, unknown>[];
  /** Rows returned for the loadAdminContext actor-assignment lookup. */
  adminAssignmentRows?: Record<string, unknown>[];
  /** Rows returned for the loadAdminContext mgmt_object grant lookup. */
  adminGrantRows?: Record<string, unknown>[];
}

function makePool(opts: StubOptions = {}): pg.Pool {
  const {
    roleRows = [],
    assignmentRows = [],
    grantRows = [],
    ownerRows = [],
    adminAssignmentRows = [],
    adminGrantRows = [],
  } = opts;

  const stubClient = {
    query: async (_text: string | { text: string }, _values?: unknown[]) => {
      const sql = typeof _text === "string" ? _text : _text.text;

      // Transaction lifecycle
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET\s+LOCAL)/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }

      // resolveActorTenant: SELECT e.tenant_id FROM choros.employee e JOIN choros.tenant ...
      if (/e\.tenant_id\s*$/im.test(sql) && /choros\.employee\s+e/i.test(sql) && /choros\.tenant\s+t/i.test(sql)) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // loadAdminContext step 1 — genesis owner check (role.slug = 'tenant-owner')
      if (/r\.slug\s*=\s*'tenant-owner'/i.test(sql)) {
        return { rows: ownerRows, rowCount: ownerRows.length };
      }

      // loadAdminContext step 2 — actor's confirmed assignments (no role join)
      if (
        /SELECT\s+ra\.id,\s*ra\.role_id,\s*ra\.org_scope/i.test(sql)
      ) {
        return { rows: adminAssignmentRows, rowCount: adminAssignmentRows.length };
      }

      // loadAdminContext step 3 — mgmt_object:* grants for a role
      if (/resource_type\s+LIKE\s+'mgmt_object:%'/i.test(sql)) {
        return { rows: adminGrantRows, rowCount: adminGrantRows.length };
      }

      // resolveCallerEmployeeId: SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2
      if (/SELECT\s+id\s+FROM\s+choros\.employee\s+WHERE/i.test(sql)) {
        return { rows: [{ id: `emp-${ACTOR_ORDINARY}` }], rowCount: 1 };
      }

      // Our own query 1 — SELECT roles
      if (/SELECT\s+id,\s*slug,\s*display_name\s+FROM\s+choros\.role/i.test(sql)) {
        return { rows: roleRows, rowCount: roleRows.length };
      }

      // Our own query 2 — role_assignment JOIN employee
      if (/FROM\s+choros\.role_assignment\s+ra\s*[\s\S]*LEFT\s+JOIN\s+choros\.employee/i.test(sql)) {
        return { rows: assignmentRows, rowCount: assignmentRows.length };
      }

      // Our own query 3 — grant rows
      if (/FROM\s+choros\."grant"\s+g\s*$/im.test(sql) || /FROM\s+choros\."grant"\s+g\s*\n/i.test(sql)) {
        return { rows: grantRows, rowCount: grantRows.length };
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };

  return {
    connect: async () => stubClient as unknown as pg.PoolClient,
    query: async (...args: Parameters<typeof stubClient.query>) =>
      stubClient.query(...args) as unknown as pg.QueryResult,
  } as unknown as pg.Pool;
}

function makeHttpServer(pool: pg.Pool): http.Server {
  const router = new Router();
  registerRightsOverviewRoutes(router, pool);
  return http.createServer(router.dispatch.bind(router));
}

async function startTestServer(pool: pg.Pool): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = makeHttpServer(pool);
  return new Promise((resolve) => {
    server.listen(0, "localhost", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        resolve({
          baseUrl: `http://localhost:${addr.port}`,
          close: () => new Promise((res) => server.close(() => res())),
        });
      }
    });
  });
}

function req(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const httpReq = http.request(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    httpReq.on("error", reject);
    httpReq.end();
  });
}

// ---------------------------------------------------------------------------
// RO-1 (AC-2): 0 roles ⇒ honest {roles:[]}, no demo field.
// ---------------------------------------------------------------------------

describe("RO-1 — empty tenant returns honest {roles:[]}", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  beforeAll(async () => {
    const s = await startTestServer(makePool({}));
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("returns 200, roles:[], no demo field", async () => {
    const res = await req(baseUrl, "GET", "/api/rights/tenant-state", { "x-dev-user": ACTOR_ORDINARY });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as Record<string, unknown>;
    expect(data["roles"]).toEqual([]);
    expect(data["demo"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RO-2: admin (genesis owner) ⇒ scope:"tenant", can_manage:true.
// ---------------------------------------------------------------------------

describe("RO-2 — genesis-owner actor gets tenant-wide admin projection", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  const ROLE_ROW = { id: ROLE_1, slug: "role-worker", display_name: "Worker" };

  beforeAll(async () => {
    const s = await startTestServer(
      makePool({
        roleRows: [ROLE_ROW],
        ownerRows: [{ id: "ra-owner" }], // isGenesisOwner === true
      }),
    );
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("returns scope:tenant, can_manage:true, and the tenant's roles", async () => {
    const res = await req(baseUrl, "GET", "/api/rights/tenant-state", { "x-dev-user": ACTOR_ADMIN });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { scope: string; can_manage: boolean; roles: unknown[] };
    expect(data.scope).toBe("tenant");
    expect(data.can_manage).toBe(true);
    expect(data.roles).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// RO-3 (AC-9): ordinary actor (no admin authority) ⇒ scope:"self", can_manage:false.
// ---------------------------------------------------------------------------

describe("RO-3 — ordinary actor gets self-scoped, read-only projection", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  const ROLE_ROW = { id: ROLE_1, slug: "role-worker", display_name: "Worker" };

  beforeAll(async () => {
    const s = await startTestServer(
      makePool({
        roleRows: [ROLE_ROW],
        ownerRows: [], // not genesis owner
        adminAssignmentRows: [], // no confirmed assignments ⇒ no mgmt_object grants reachable
      }),
    );
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("returns scope:self, can_manage:false", async () => {
    const res = await req(baseUrl, "GET", "/api/rights/tenant-state", { "x-dev-user": ACTOR_ORDINARY });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { scope: string; can_manage: boolean };
    expect(data.scope).toBe("self");
    expect(data.can_manage).toBe(false);
  });

  it("filters roles to only those the caller is assigned to (no assignment ⇒ role dropped)", async () => {
    const res = await req(baseUrl, "GET", "/api/rights/tenant-state", { "x-dev-user": ACTOR_ORDINARY });
    const data = JSON.parse(res.body) as { roles: unknown[] };
    // The ordinary actor holds no assignment on ROLE_1 in this fixture, so it
    // must not appear in their self-projection.
    expect(data.roles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RO-4 (AC-8): semi-confirmed rows land in pending, never active.
// ---------------------------------------------------------------------------

describe("RO-4 — semi-confirmed rows are pending, never active (admin view)", () => {
  let close: () => Promise<void>;
  let baseUrl: string;

  const ROLE_ROW = { id: ROLE_1, slug: "role-worker", display_name: "Worker" };
  const PENDING_GRANT = {
    id: "grant-pending",
    role_id: ROLE_1,
    resource_type: "record",
    resource_facet: null,
    operation: "write",
    scope: { kind: "set", members: [] },
    proposed_by: "e-proposer",
    confirmed_by: "e-proposer",
    confirmed2_by: null,
    valid_from: null,
    valid_until: null,
  };
  const ACTIVE_GRANT = {
    id: "grant-active",
    role_id: ROLE_1,
    resource_type: "record",
    resource_facet: null,
    operation: "read",
    scope: { kind: "set", members: [] },
    proposed_by: null,
    confirmed_by: "seed",
    confirmed2_by: null,
    valid_from: null,
    valid_until: null,
  };

  beforeAll(async () => {
    const s = await startTestServer(
      makePool({
        roleRows: [ROLE_ROW],
        ownerRows: [{ id: "ra-owner" }],
        grantRows: [PENDING_GRANT, ACTIVE_GRANT],
      }),
    );
    close = s.close; baseUrl = s.baseUrl;
  });
  afterAll(async () => { await close(); });

  it("pending grant is in pending.grants, never in grants", async () => {
    const res = await req(baseUrl, "GET", "/api/rights/tenant-state", { "x-dev-user": ACTOR_ADMIN });
    const data = JSON.parse(res.body) as {
      roles: Array<{ id: string; grants: Array<{ id: string }>; pending: { grants: Array<{ id: string }> } }>;
    };
    const role = data.roles.find((r) => r.id === ROLE_1)!;
    expect(role.grants.map((g) => g.id)).toContain("grant-active");
    expect(role.grants.map((g) => g.id)).not.toContain("grant-pending");
    expect(role.pending.grants.map((g) => g.id)).toContain("grant-pending");
  });
});

// ---------------------------------------------------------------------------
// RO-5: 401 without auth header.
// ---------------------------------------------------------------------------

describe("RO-5 — 401 without auth", () => {
  it("rejects an unauthenticated request", async () => {
    const s = await startTestServer(makePool({}));
    try {
      const res = await req(s.baseUrl, "GET", "/api/rights/tenant-state");
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });
});
