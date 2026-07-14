/**
 * src/__tests__/grants.role-assignments.authz.test.ts — T-0389 [D1]
 *
 * Proves that POST /api/role-assignments (and the other grants.ts org-write
 * routes) resolve the write-target tenant from the CALLER'S AUTHENTICATED
 * IDENTITY, not a hardcoded DEV_TENANT_ID.
 *
 * Before T-0389 (B6 class): a self-registered owner of tenant A got 403 from
 * POST /api/role-assignments because the route resolved `tenantId = DEV_TENANT_ID`
 * (the bootstrap silo), where the caller holds no role. After the fix, the route
 * resolves the caller's slug → their own tenant and gates there.
 *
 * Central security properties proven here:
 *   (a) own-tenant owner CAN create a role-assignment       → 201
 *   (b) cross-tenant attempt: caller resolves to TENANT_A,
 *       but the employee/role the assignment targets belong to TENANT_B
 *       — the write lands in the CALLER'S tenant (A), so the fetch of
 *       employeeId/roleId against that tenant fails with 404 (not 403, because
 *       the row simply does not exist in the caller's tenant; cross-tenant reads
 *       are always scoped by RLS). This is the correct behaviour: the caller
 *       CANNOT assign a role they don't own into a tenant they don't control.
 *   (c) non-owner of own tenant → 403 ADMIN_GATE_REJECTED
 *
 * No real DB: a scripted in-memory stub pg.Pool replays the queries issued by
 * extractActorFromReq → resolveActorSlugFromAuth, resolveActorTenant,
 * loadAdminContext, and the assertEmployeeExists / assertRoleExists helpers.
 * Dev auth mode (x-dev-user) — no JWKS / Keycloak network is touched.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerGrantsRoutes } from "../http/grants.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";
const EMPLOYEE_ID = "cccccccc-0000-0000-0000-000000000003";
const ROLE_ID = "dddddddd-0000-0000-0000-000000000004";

// ---------------------------------------------------------------------------
// Scripted stub pg.Pool
//
// The stub distinguishes queries by SQL substring matching the patterns each
// DB function emits. All unknown queries (INSERT, BEGIN, SET LOCAL, COMMIT,
// ROLLBACK, dual-control inserts, audit events…) are treated as no-ops.
//
// @param callerTenant    what resolveActorTenant returns for the caller
// @param ownedTenants    tenants for which the caller holds 'tenant-owner'
// @param knownEmployee   (tenant, id) pair that assertEmployeeExists accepts
// @param knownRole       (tenant, id) pair that assertRoleExists accepts
// @param knownRoleGrants effective grant list for dual-control decision
// ---------------------------------------------------------------------------

function makeStubPool(opts: {
  callerTenant: string;
  ownedTenants: string[];
  knownEmployee?: { tenant: string; id: string };
  knownRole?: { tenant: string; id: string };
  // T-0469 — roleIds whose role.slug = 'tenant-owner' (the genesis owner role).
  ownerRoleIds?: string[];
  // T-0469 — delegable mgmt_object grants the caller's (non-owner) role carries.
  // When set, loadAdminContext step 2 returns one assignment and step 3 returns
  // these grants, modelling a constructor-admin who holds covering mgmt grants.
  adminMgmtGrants?: Array<{ resourceType: string; operation: string }>;
}): pg.Pool {
  const { callerTenant, ownedTenants } = opts;
  const owned = new Set(ownedTenants);
  const ownerRoles = new Set(opts.ownerRoleIds ?? []);

  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };

      // T-0469 isOwnerRole — choros.role … AND slug = 'tenant-owner'.
      // MUST come before the generic assertRoleExists matcher below (that one
      // also matches FROM choros.role + tenant_id=$1 + id=$2) and before any
      // role_assignment owner-lookup (this query has no 'role_assignment').
      if (
        text.includes("FROM choros.role") &&
        text.includes("slug = 'tenant-owner'") &&
        !text.includes("role_assignment")
      ) {
        const roleId = Array.isArray(params) ? (params[1] as string) : undefined;
        const isOwner = roleId !== undefined && ownerRoles.has(roleId);
        return { rows: isOwner ? [{ id: roleId }] : [], rowCount: isOwner ? 1 : 0 };
      }

      // resolveActorSlugFromAuth — EXISTS check: choros.employee WHERE slug = $1 AND kind = 'human'
      // Dev-mode: no getAuthContext → this path is not reached; but guard it anyway.
      if (text.includes("SELECT EXISTS") && text.includes("kind = 'human'")) {
        const slug = Array.isArray(params) ? (params[0] as string) : undefined;
        // In dev-auth mode (x-dev-user), extractActorFromReq returns the header
        // value directly without calling resolveActorSlugFromAuth. But if a JWT
        // were present, the slug lookup would run here.
        const exists = slug !== undefined && slug.length > 0;
        return { rows: [{ exists }], rowCount: 1 };
      }

      // resolveActorTenant — JOIN choros.tenant … WHERE e.slug = $1
      if (text.includes("JOIN choros.tenant") && text.includes("e.slug")) {
        return { rows: [{ tenant_id: callerTenant }], rowCount: 1 };
      }

      // loadAdminContext step 1 — tenant-owner lookup
      // Param[0] = tenantId being checked against.
      if (text.includes("tenant-owner") && text.includes("role_assignment")) {
        const tenantId = Array.isArray(params) ? (params[0] as string) : undefined;
        const isOwner = tenantId !== undefined && owned.has(tenantId);
        return { rows: isOwner ? [{ id: "ra-owner-1" }] : [], rowCount: isOwner ? 1 : 0 };
      }

      // loadAdminContext step 2 — assignment list. For a non-owner constructor-admin
      // we return ONE in-window assignment (org_scope = empty set = the caller's
      // reach) so step 3 can attach the delegable mgmt grants (T-0469).
      if (text.includes("ra.id") && text.includes("ra.org_scope") && text.includes("role_assignment ra")) {
        if ((opts.adminMgmtGrants?.length ?? 0) > 0) {
          return {
            rows: [
              {
                id: "ra-admin-1",
                role_id: "role-admin-1",
                org_scope: { kind: "set", members: [] },
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // assertEmployeeExists — choros.employee WHERE tenant_id = $1 AND id = $2
      if (text.includes("FROM choros.employee") && text.includes("tenant_id = $1") && text.includes("id = $2")) {
        const tenantId = Array.isArray(params) ? (params[0] as string) : undefined;
        const empId = Array.isArray(params) ? (params[1] as string) : undefined;
        const known = opts.knownEmployee;
        const found = known !== undefined && tenantId === known.tenant && empId === known.id;
        return { rows: found ? [{ id: empId }] : [], rowCount: found ? 1 : 0 };
      }

      // assertRoleExists — choros.role WHERE tenant_id = $1 AND id = $2
      if (text.includes("FROM choros.role") && text.includes("tenant_id = $1") && text.includes("id = $2")) {
        const tenantId = Array.isArray(params) ? (params[0] as string) : undefined;
        const roleId = Array.isArray(params) ? (params[1] as string) : undefined;
        const known = opts.knownRole;
        const found = known !== undefined && tenantId === known.tenant && roleId === known.id;
        return { rows: found ? [{ id: roleId }] : [], rowCount: found ? 1 : 0 };
      }

      // loadAdminContext step 3 — delegable mgmt_object:* grants on the admin's
      // role. Distinguished from loadRoleEffectiveGrants by the LIKE filter and
      // delegable=true. Returns the configured constructor-admin grants (T-0469).
      if (
        text.includes("LIKE 'mgmt_object:%'") &&
        text.includes("g.delegable = true")
      ) {
        const grants = (opts.adminMgmtGrants ?? []).map((g, i) => ({
          id: `g-${i}`,
          role_id: "role-admin-1",
          resource_type: g.resourceType,
          resource_facet: null,
          operation: g.operation,
          scope: { kind: "set", members: [] }, // whole-reach (empty set ⊑ anything)
          constraint: null,
          delegable: true,
          granted_by: "seed",
          valid_from: null,
          valid_until: null,
          created_at: "0",
        }));
        return { rows: grants, rowCount: grants.length };
      }

      // loadRoleEffectiveGrants (dual-control): returns empty list → routine 1-approver path
      if (text.includes("FROM choros.\"grant\"") || text.includes("FROM choros.grant")) {
        return { rows: [], rowCount: 0 };
      }

      // appendAuditEvent step 3: SELECT seq, row_hash FROM audit_head FOR UPDATE
      // Must come BEFORE the current_setting check because the query text also
      // contains 'current_setting' and 'tenant_id'.
      // row_hash MUST be a 32-byte Buffer (canonicalPreimage validates this).
      if (text.includes("audit_head") && text.includes("FOR UPDATE")) {
        return {
          rows: [{ seq: 0, row_hash: Buffer.alloc(32, 0), vocab_version: 1 }],
          rowCount: 1,
        };
      }

      // appendAuditEvent step 1: SELECT current_setting('choros.tenant_id') → return callerTenant
      // Narrowed: must NOT also match the audit_head FOR UPDATE query above.
      if (text.includes("current_setting") && text.includes("AS tenant_id")) {
        return { rows: [{ tenant_id: callerTenant }], rowCount: 1 };
      }

      // INSERT / UPDATE / BEGIN / SET LOCAL / COMMIT / ROLLBACK / other audit ops → no-op
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// In-process HTTP server harness
// ---------------------------------------------------------------------------

async function startTestServer(
  pool: pg.Pool,
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerGrantsRoutes(router, pool);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e: Error | undefined) => (e ? reject(e) : resolve())),
      ),
  };
}

async function post(
  port: number,
  path: string,
  body: unknown,
  devUser = "e-owner-a",
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(devUser ? { "x-dev-user": devUser } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

// Valid role-assignment payload targeting TENANT_A's employee and role.
// org_scope uses { kind: "set", members: [] } (empty set — valid ScopeElement,
// parseable by parseScopeElement; "whole" is not a valid kind in this codebase).
function roleAssignmentPayload(employeeId = EMPLOYEE_ID, roleId = ROLE_ID) {
  return {
    employee_id: employeeId,
    role_id: roleId,
    org_scope: { kind: "set", members: [] },
    source: "test",
    granted_by: "e-owner-a",
  };
}

// ---------------------------------------------------------------------------
// (a) Own-tenant owner CAN create a role-assignment — the B6 fix
// ---------------------------------------------------------------------------

describe("T-0389 (a) — own-tenant owner CAN create a role-assignment", () => {
  it("POST /api/role-assignments — owner of TENANT_A writes into TENANT_A → 201", async () => {
    // The caller (e-owner-a) resolves to TENANT_A and owns TENANT_A.
    // The employee and role being assigned also live in TENANT_A.
    const { port, close } = await startTestServer(
      makeStubPool({
        callerTenant: TENANT_A,
        ownedTenants: [TENANT_A],
        knownEmployee: { tenant: TENANT_A, id: EMPLOYEE_ID },
        knownRole: { tenant: TENANT_A, id: ROLE_ID },
      }),
    );
    try {
      const resp = await post(port, "/api/role-assignments", roleAssignmentPayload());
      expect(resp.status).toBe(201);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Security: caller resolves to TENANT_A; employee/role in TENANT_B
//     → the route writes into TENANT_A (caller's tenant), finds no such
//     employee/role there, and returns 404 (row not found in caller's tenant).
//     This is the correct cross-tenant isolation: RLS scoping prevents the
//     caller from touching TENANT_B data.
// ---------------------------------------------------------------------------

describe("T-0389 (b) — cross-tenant isolation: employee/role in TENANT_B are invisible to TENANT_A caller", () => {
  it("POST /api/role-assignments — TENANT_A caller, TENANT_B employee/role → 404 NOT_FOUND", async () => {
    // Caller resolves to TENANT_A and owns it. The employee and role only
    // exist in TENANT_B. Because tenantId is now the caller's tenant (TENANT_A),
    // the assertEmployeeExists / assertRoleExists queries are scoped to TENANT_A
    // and find nothing → 404.
    const { port, close } = await startTestServer(
      makeStubPool({
        callerTenant: TENANT_A,
        ownedTenants: [TENANT_A],
        // employee and role live in TENANT_B, invisible from TENANT_A
        knownEmployee: { tenant: TENANT_B, id: EMPLOYEE_ID },
        knownRole: { tenant: TENANT_B, id: ROLE_ID },
      }),
    );
    try {
      const resp = await post(port, "/api/role-assignments", roleAssignmentPayload());
      // 404 because the employee does not exist in the caller's (TENANT_A) tenant.
      expect(resp.status).toBe(404);
      expect(errCode(resp.body)).toBe("NOT_FOUND");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Non-owner of own tenant is still rejected by the gate
// ---------------------------------------------------------------------------

describe("T-0389 (c) — non-owner of own tenant is rejected by the admin gate", () => {
  it("POST /api/role-assignments — caller of TENANT_A but NOT tenant-owner → 403", async () => {
    const { port, close } = await startTestServer(
      makeStubPool({
        callerTenant: TENANT_A,
        ownedTenants: [], // caller holds NO tenant-owner role
        knownEmployee: { tenant: TENANT_A, id: EMPLOYEE_ID },
        knownRole: { tenant: TENANT_A, id: ROLE_ID },
      }),
    );
    try {
      const resp = await post(port, "/api/role-assignments", roleAssignmentPayload());
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("ADMIN_GATE_REJECTED");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (d) POST /api/grants also routes through caller's tenant (T-0389 audit)
// ---------------------------------------------------------------------------

describe("T-0389 (d) — POST /api/grants also uses caller's tenant, not DEV_TENANT_ID", () => {
  it("genesis owner of TENANT_A can create a grant in TENANT_A → 201", async () => {
    const { port, close } = await startTestServer(
      makeStubPool({
        callerTenant: TENANT_A,
        ownedTenants: [TENANT_A],
        knownRole: { tenant: TENANT_A, id: ROLE_ID },
      }),
    );
    try {
      const resp = await post(port, "/api/grants", {
        role_id: ROLE_ID,
        resource_type: "process",
        operation: "read",
        scope: { kind: "set", members: [] },
        granted_by: "e-owner-a",
      });
      expect(resp.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("non-owner of TENANT_A cannot create a grant → 403", async () => {
    const { port, close } = await startTestServer(
      makeStubPool({
        callerTenant: TENANT_A,
        ownedTenants: [],
        knownRole: { tenant: TENANT_A, id: ROLE_ID },
      }),
    );
    try {
      const resp = await post(port, "/api/grants", {
        role_id: ROLE_ID,
        resource_type: "process",
        operation: "read",
        scope: { kind: "set", members: [] },
        granted_by: "e-owner-a",
      });
      expect(resp.status).toBe(403);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (e) T-0469 [SECURITY] — owner-role assignment is OWNER-ONLY.
//
// The adversarial review PROVED: a role-constructor-admin holds delegable
// `mgmt_object:*` grants, which satisfy the kind:"assignment" authority check.
// Without the fix, that admin could POST /api/role-assignments with role_id =
// the tenant-owner role → self-promote to owner → delete the original owner.
//
// These tests run the FULL route through the stub pool:
//   (e1) constructor-admin (non-owner, holds delegable mgmt grants) assigning
//        the OWNER role → 403 ADMIN_GATE_REJECTED (owner_assignment_owner_only).
//   (e2) the genesis OWNER assigning the OWNER role → 201 (legit flow green).
//   (e3) a non-owner scoped-admin assigning a NORMAL in-scope role → 201
//        (no over-restriction; the carve-out is owner-role-specific).
// ---------------------------------------------------------------------------

const OWNER_ROLE_ID = "e0000000-0000-0000-0000-000000000001"; // role.slug='tenant-owner'

describe("T-0469 (e) — owner role_assignment is OWNER-ONLY (escalation closed)", () => {
  it("(e1) constructor-admin (delegable mgmt grants, NOT owner) assigning tenant-owner → 403", async () => {
    const { port, close } = await startTestServer(
      makeStubPool({
        callerTenant: TENANT_A,
        ownedTenants: [], // NOT the genesis owner
        knownEmployee: { tenant: TENANT_A, id: EMPLOYEE_ID },
        knownRole: { tenant: TENANT_A, id: OWNER_ROLE_ID },
        // role.slug = 'tenant-owner' for the target role → carve-out fires
        ownerRoleIds: [OWNER_ROLE_ID],
        // the constructor-admin's delegable mgmt grants — WITHOUT the carve-out
        // these would satisfy the kind:"assignment" authority and yield 201.
        adminMgmtGrants: [
          { resourceType: "mgmt_object:role", operation: "create" },
          { resourceType: "mgmt_object:employee", operation: "create" },
        ],
      }),
    );
    try {
      const resp = await post(
        port,
        "/api/role-assignments",
        roleAssignmentPayload(EMPLOYEE_ID, OWNER_ROLE_ID),
      );
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("ADMIN_GATE_REJECTED");
      // The precise reason proves it was the owner carve-out, not org/authority.
      expect((resp.body as { error?: { message?: string } })?.error?.message).toBe(
        "owner_assignment_owner_only",
      );
    } finally {
      await close();
    }
  });

  it("(e2) the genesis OWNER CAN assign the tenant-owner role → 201", async () => {
    const { port, close } = await startTestServer(
      makeStubPool({
        callerTenant: TENANT_A,
        ownedTenants: [TENANT_A], // the genesis owner
        knownEmployee: { tenant: TENANT_A, id: EMPLOYEE_ID },
        knownRole: { tenant: TENANT_A, id: OWNER_ROLE_ID },
        ownerRoleIds: [OWNER_ROLE_ID],
      }),
    );
    try {
      const resp = await post(
        port,
        "/api/role-assignments",
        roleAssignmentPayload(EMPLOYEE_ID, OWNER_ROLE_ID),
      );
      expect(resp.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("(e3) non-owner scoped-admin assigning a NORMAL in-scope role → 201 (no over-restriction)", async () => {
    const { port, close } = await startTestServer(
      makeStubPool({
        callerTenant: TENANT_A,
        ownedTenants: [], // NOT owner
        knownEmployee: { tenant: TENANT_A, id: EMPLOYEE_ID },
        knownRole: { tenant: TENANT_A, id: ROLE_ID }, // a NORMAL role (not owner)
        ownerRoleIds: [OWNER_ROLE_ID], // owner role exists, but is NOT the target
        adminMgmtGrants: [{ resourceType: "mgmt_object:role", operation: "create" }],
      }),
    );
    try {
      const resp = await post(
        port,
        "/api/role-assignments",
        roleAssignmentPayload(EMPLOYEE_ID, ROLE_ID),
      );
      expect(resp.status).toBe(201);
    } finally {
      await close();
    }
  });
});
