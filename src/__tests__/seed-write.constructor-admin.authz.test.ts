/**
 * src/__tests__/seed-write.constructor-admin.authz.test.ts — T-0469 [auth]
 *
 * Proves the new "konstructor-admin" delegation seam on the org-write surface
 * (seed-write.ts): org-write is no longer genesis-owner-ONLY — it now also
 * accepts a NON-owner who holds a covering, delegable `mgmt_object:<kind>` grant
 * (the role-constructor-admin role). AND it proves the OWNER-ONLY BOUNDARY that
 * is the security crux of the task:
 *
 *   (a) a constructor-admin (NOT the owner, holds delegable mgmt_object grants)
 *       CAN create departments / positions / employees / roles, and delete
 *       departments / positions / roles                                  → 201/200
 *   (b) the SAME constructor-admin CANNOT delete an employee             → 403
 *       (employee DELETION stays owner-only — the role's grant set has no
 *        employee:delete and the route keeps a strict isGenesisOwner gate)
 *   (c) a non-owner with NO mgmt_object grants is still rejected         → 403
 *       (the delegation, not mere non-ownership, is what unlocks the write)
 *
 * The "owner's role_assignment can never be mutated by a constructor-admin"
 * property is STRUCTURAL: seed-write.ts has no role_assignment write surface at
 * all (it only touches department/position/employee/role tables). There is no
 * route through which a constructor-admin could remove/replace the tenant-owner.
 * (b) above demonstrates the closest reachable escalation — deleting a person —
 * is blocked, so the weaker "touch the owner assignment" is a fortiori blocked.
 *
 * No real DB: a scripted in-memory stub pg.Pool replays the queries the gate
 * runs — resolveActorTenant, loadAdminContext (owner lookup → NOT owner;
 * assignment lookup → one ⊥-scoped assignment; per-assignment grant lookup →
 * the delegable mgmt_object grants the constructor-admin holds). Runs in dev
 * auth mode (x-dev-user); the slug→tenant→grant resolution is auth-mode-agnostic.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerSeedWriteRoutes } from "../http/seed-write.js";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001"; // caller's own tenant
const DEPT_ID = "cccccccc-0000-0000-0000-000000000003";
const EMP_ID = "dddddddd-0000-0000-0000-000000000004";
const ROLE_ID = "eeeeeeee-0000-0000-0000-000000000005";
const POS_ID = "ffffffff-0000-0000-0000-000000000006";

const BOTTOM = { kind: "set", members: [] };

/**
 * Scripted stub pg.Pool modelling a CONSTRUCTOR-ADMIN principal:
 *   - resolveActorTenant → TENANT_A (the caller's own tenant)
 *   - loadAdminContext owner lookup ('tenant-owner') → NO rows (NOT the owner)
 *   - loadAdminContext assignment lookup → one ⊥-scoped role_assignment
 *   - per-assignment delegable mgmt_object grant lookup → the supplied grant set
 *
 * @param grantSet  the (resource_type, operation) pairs the role holds, all
 *                  delegable=true, scope=⊥. Pass the full constructor-admin set,
 *                  or [] to model a non-owner with no admin grants.
 */
function makeConstructorAdminPool(
  grantSet: Array<{ resourceType: string; operation: string }>,
): pg.Pool {
  const client = {
    query: async (text: string, _params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };

      // resolveActorTenant: slug → caller's tenant
      if (text.includes("JOIN choros.tenant") && text.includes("CASE WHEN t.slug")) {
        return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      }

      // loadAdminContext: tenant-owner role lookup → NOT the owner (0 rows)
      if (text.includes("tenant-owner") && text.includes("role_assignment")) {
        return { rows: [], rowCount: 0 };
      }

      // loadAdminContext: assignment list (ra.id, ra.role_id, ra.org_scope)
      // → one ⊥-scoped assignment so adminOrgScope = ⊥.
      if (text.includes("ra.id") && text.includes("ra.org_scope")) {
        return {
          rows: [{ id: "ra-ca-1", role_id: "role-ca-1", org_scope: BOTTOM }],
          rowCount: 1,
        };
      }

      // loadAdminContext: per-assignment delegable mgmt_object:* grant lookup.
      if (text.includes('choros."grant"') && text.includes("mgmt_object:%")) {
        const rows = grantSet.map((g, i) => ({
          id: `g-${i}`,
          role_id: "role-ca-1",
          resource_type: g.resourceType,
          resource_facet: null,
          operation: g.operation,
          scope: BOTTOM,
          constraint: null,
          delegable: true,
          granted_by: "owner",
          valid_from: null,
          valid_until: null,
          created_at: "0",
        }));
        return { rows, rowCount: rows.length };
      }

      // INSERT / DELETE / BEGIN / SET LOCAL / COMMIT / ROLLBACK → no-op success.
      // DELETE returns rowCount 1 so the 404-on-zero path is not taken.
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

// The full role-constructor-admin grant set seeded by registerTenant (T-0469):
// owner-like authoring MINUS employee:delete MINUS mgmt_object:grant.
const CONSTRUCTOR_ADMIN_GRANTS = [
  { resourceType: "mgmt_object:department", operation: "create" },
  { resourceType: "mgmt_object:department", operation: "update" },
  { resourceType: "mgmt_object:department", operation: "delete" },
  { resourceType: "mgmt_object:position", operation: "create" },
  { resourceType: "mgmt_object:position", operation: "update" },
  { resourceType: "mgmt_object:position", operation: "delete" },
  { resourceType: "mgmt_object:employee", operation: "create" },
  { resourceType: "mgmt_object:employee", operation: "update" },
  { resourceType: "mgmt_object:role", operation: "create" },
  { resourceType: "mgmt_object:role", operation: "update" },
  { resourceType: "mgmt_object:role", operation: "delete" },
];

async function startTestServer(
  pool: pg.Pool,
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerSeedWriteRoutes(router, pool);
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

function request(
  port: number,
  method: string,
  path: string,
  body: unknown,
  devUser = "e-constructor-admin",
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
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

// ---------------------------------------------------------------------------
// (a) A constructor-admin (NOT owner) CAN author org structure
// ---------------------------------------------------------------------------

describe("T-0469 (a) — a constructor-admin grant holder CAN write org structure", () => {
  it("POST /api/departments → 201", async () => {
    const { port, close } = await startTestServer(
      makeConstructorAdminPool(CONSTRUCTOR_ADMIN_GRANTS),
    );
    try {
      const r = await request(port, "POST", "/api/departments", {
        tenant_id: TENANT_A,
        slug: "ops",
        display_name: "Operations",
      });
      expect(r.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("POST /api/positions → 201", async () => {
    const { port, close } = await startTestServer(
      makeConstructorAdminPool(CONSTRUCTOR_ADMIN_GRANTS),
    );
    try {
      const r = await request(port, "POST", "/api/positions", {
        tenant_id: TENANT_A,
        department_id: DEPT_ID,
        slug: "lead",
        title: "Team Lead",
      });
      expect(r.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("POST /api/employees → 201 (constructor-admin can HIRE)", async () => {
    const { port, close } = await startTestServer(
      makeConstructorAdminPool(CONSTRUCTOR_ADMIN_GRANTS),
    );
    try {
      const r = await request(port, "POST", "/api/employees", {
        tenant_id: TENANT_A,
        kind: "human",
        slug: "e-new",
        display_name: "New Person",
      });
      expect(r.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("POST /api/roles → 201 (existing mgmt_object:role/create delegation path)", async () => {
    const { port, close } = await startTestServer(
      makeConstructorAdminPool(CONSTRUCTOR_ADMIN_GRANTS),
    );
    try {
      const r = await request(port, "POST", "/api/roles", {
        tenant_id: TENANT_A,
        slug: "manager",
        display_name: "Manager",
      });
      expect(r.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("DELETE /api/departments/:id → 200", async () => {
    const { port, close } = await startTestServer(
      makeConstructorAdminPool(CONSTRUCTOR_ADMIN_GRANTS),
    );
    try {
      const r = await request(port, "DELETE", `/api/departments/${DEPT_ID}`, {
        tenant_id: TENANT_A,
      });
      expect(r.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("DELETE /api/positions/:id → 200", async () => {
    const { port, close } = await startTestServer(
      makeConstructorAdminPool(CONSTRUCTOR_ADMIN_GRANTS),
    );
    try {
      const r = await request(port, "DELETE", `/api/positions/${POS_ID}`, {
        tenant_id: TENANT_A,
      });
      expect(r.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("DELETE /api/roles/:id → 200", async () => {
    const { port, close } = await startTestServer(
      makeConstructorAdminPool(CONSTRUCTOR_ADMIN_GRANTS),
    );
    try {
      const r = await request(port, "DELETE", `/api/roles/${ROLE_ID}`, {
        tenant_id: TENANT_A,
      });
      expect(r.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("GET /api/org/tenant-state → 200 (read-counterpart honoured)", async () => {
    const { port, close } = await startTestServer(
      makeConstructorAdminPool(CONSTRUCTOR_ADMIN_GRANTS),
    );
    try {
      const r = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/api/org/tenant-state?tenant_id=${TENANT_A}`,
            method: "GET",
            headers: { "x-dev-user": "e-constructor-admin" },
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(r.status).toBe(200);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (b) THE OWNER-ONLY BOUNDARY — a constructor-admin CANNOT delete an employee
// ---------------------------------------------------------------------------

describe("T-0469 (b) — a constructor-admin CANNOT delete an employee (owner-only)", () => {
  it("DELETE /api/employees/:id → 403 NOT_OWNER even with the full constructor-admin grant set", async () => {
    // The full constructor-admin grant set is intentionally WITHOUT
    // mgmt_object:employee/delete, AND the route keeps a strict isGenesisOwner
    // gate — so a constructor-admin can never remove a person.
    const { port, close } = await startTestServer(
      makeConstructorAdminPool(CONSTRUCTOR_ADMIN_GRANTS),
    );
    try {
      const r = await request(port, "DELETE", `/api/employees/${EMP_ID}`, {
        tenant_id: TENANT_A,
      });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });

  it("even if the role were (mis)granted mgmt_object:employee/delete, the route still rejects (defense-in-depth)", async () => {
    // Adversarial: suppose a future seed wrongly added employee:delete. The
    // DELETE /api/employees route does NOT route through the delegation helper —
    // it keeps a strict isGenesisOwner gate — so deletion is STILL 403. This is
    // the second, independent layer protecting the owner-only boundary.
    const withDeleteGrant = [
      ...CONSTRUCTOR_ADMIN_GRANTS,
      { resourceType: "mgmt_object:employee", operation: "delete" },
    ];
    const { port, close } = await startTestServer(
      makeConstructorAdminPool(withDeleteGrant),
    );
    try {
      const r = await request(port, "DELETE", `/api/employees/${EMP_ID}`, {
        tenant_id: TENANT_A,
      });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) A non-owner with NO mgmt_object grants is still rejected
// ---------------------------------------------------------------------------

describe("T-0469 (c) — a non-owner with NO admin grants is still rejected (delegation is the unlock)", () => {
  it("POST /api/departments by a non-owner with no grants → 403 NOT_OWNER", async () => {
    const { port, close } = await startTestServer(makeConstructorAdminPool([]));
    try {
      const r = await request(port, "POST", "/api/departments", {
        tenant_id: TENANT_A,
        slug: "ops",
        display_name: "Operations",
      });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });

  it("POST /api/employees by a non-owner with no grants → 403 NOT_OWNER", async () => {
    const { port, close } = await startTestServer(makeConstructorAdminPool([]));
    try {
      const r = await request(port, "POST", "/api/employees", {
        tenant_id: TENANT_A,
        kind: "human",
        slug: "e-x",
        display_name: "X",
      });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });

  it("a constructor-admin holding ONLY department grants cannot create a ROLE → 403 (per-object scoping)", async () => {
    // Proves the delegation is per-object, not a blanket bypass: a dept-only
    // grant set does not unlock role creation.
    const deptOnly = [
      { resourceType: "mgmt_object:department", operation: "create" },
    ];
    const { port, close } = await startTestServer(makeConstructorAdminPool(deptOnly));
    try {
      const r = await request(port, "POST", "/api/roles", {
        tenant_id: TENANT_A,
        slug: "manager",
        display_name: "Manager",
      });
      expect(r.status).toBe(403);
      expect(errCode(r.body)).toBe("NOT_OWNER");
    } finally {
      await close();
    }
  });
});
