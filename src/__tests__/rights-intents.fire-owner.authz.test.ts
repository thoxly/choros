/**
 * src/__tests__/rights-intents.fire-owner.authz.test.ts — T-0469 [SECURITY]
 *
 * Closes the SECOND escalation surface found in the re-review of T-0469:
 *
 *   POST /api/rights/intents/fire (registerFire) revokes ALL of a target
 *   employee's role_assignments, gated ONLY on the admin covering each
 *   assignment's org_scope. The genesis owner's tenant-owner RA has
 *   org_scope = ⊥ (empty set), and isNarrowerOrEqual(⊥, anything) === true,
 *   so the org gate is TRIVIALLY satisfied. Without the fix, a constructor-admin
 *   (a non-owner holding delegable mgmt_object:* grants) could FIRE the genesis
 *   owner — stripping the tenant-owner assignment (owner-strip / denial-of-owner),
 *   violating T-0469's MUST ("any tenant-owner role_assignment mutation remains
 *   OWNER-ONLY").
 *
 * The fix resolves assignsOwnerRole per assignment (isOwnerRoleScoped on the RA's
 * role) and injects it into the SAME validateAdminDelegation gate, so the Step-0
 * owner carve-out rejects a non-owner with owner_assignment_owner_only BEFORE any
 * revoke UPDATE runs.
 *
 * Proofs (full route through a scripted stub pool — dev auth, x-dev-user; no DB):
 *   (f1) constructor-admin (delegable mgmt grants, NOT owner) firing an employee
 *        who holds the tenant-owner RA → 403 owner_assignment_owner_only, and the
 *        revoke UPDATE is NEVER issued (tx aborts whole).
 *   (f2) the genesis OWNER firing the same owner-holding employee → 200 (legit;
 *        the carve-out does not over-restrict the owner).
 *   (f3) a constructor-admin firing a NORMAL non-owner employee in scope → 200
 *        (no over-restriction; the carve-out is owner-role-specific).
 *
 * No real DB: a scripted in-memory stub pg.Pool replays the queries the fire path
 * issues (loadAdminContext steps 1-3, isOwnerRoleScoped, the target RA list, the
 * substitution_rule lookup). Revoke UPDATEs / audit INSERTs are observed via a
 * captured-query log so (f1) can assert no role_assignment UPDATE was attempted.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerRightsIntentRoutes } from "../http/rights-intents.js";

// ---------------------------------------------------------------------------
// Fixtures — the fire path runs against DEV_TENANT_ID (default silo).
// ---------------------------------------------------------------------------

const DEV_TENANT = "a0000000-0000-0000-0000-000000000001";
const OWNER_ROLE_ID = "e0000000-0000-0000-0000-000000000001"; // role.slug='tenant-owner'
const NORMAL_ROLE_ID = "e0000000-0000-0000-0000-000000000002";
const TARGET_EMPLOYEE_ID = "cccccccc-0000-0000-0000-000000000003";
const OWNER_RA_ID = "ra000000-0000-0000-0000-000000000001";
const NORMAL_RA_ID = "ra000000-0000-0000-0000-000000000002";

// ⊥ = empty set: the genesis owner's RA org_scope. isNarrowerOrEqual(⊥, x) === true.
const EMPTY_SET = { kind: "set", members: [] };

// ---------------------------------------------------------------------------
// Scripted stub pg.Pool.
//
// Distinguishes queries by SQL substring. All writes (BEGIN / SET LOCAL /
// COMMIT / ROLLBACK / UPDATE / INSERT) are captured into `captured` so a test
// can assert that a forbidden UPDATE never ran.
// ---------------------------------------------------------------------------

function makeStubPool(opts: {
  /** true iff the firing ACTOR is the genesis tenant-owner. */
  actorIsOwner: boolean;
  /** delegable mgmt_object grants the (non-owner) actor's role carries. */
  adminMgmtGrants?: Array<{ resourceType: string; operation: string }>;
  /** the active role_assignments of the TARGET employee being fired. */
  targetAssignments: Array<{ id: string; role_id: string; org_scope: unknown }>;
  /** roleIds whose role.slug = 'tenant-owner'. */
  ownerRoleIds: string[];
  /** sink for every query the route issues (for write-suppression assertions). */
  captured: string[];
}): pg.Pool {
  const ownerRoles = new Set(opts.ownerRoleIds);
  const mgmtGrants = opts.adminMgmtGrants ?? [];

  const client = {
    query: async (text: string, _params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };
      opts.captured.push(text);

      // --- isOwnerRoleScoped + loadAdminContext step 1 share 'tenant-owner'. ---
      // loadAdminContext step 1: owner lookup JOINs role_assignment+role.
      if (
        text.includes("slug = 'tenant-owner'") &&
        text.includes("role_assignment") &&
        text.includes("JOIN choros.role")
      ) {
        // Owner short-circuit for the ACTOR.
        return {
          rows: opts.actorIsOwner ? [{ id: "ra-owner-actor" }] : [],
          rowCount: opts.actorIsOwner ? 1 : 0,
        };
      }

      // isOwnerRoleScoped: choros.role … slug = 'tenant-owner' (NO role_assignment).
      if (
        text.includes("FROM choros.role") &&
        text.includes("slug = 'tenant-owner'") &&
        !text.includes("role_assignment")
      ) {
        const roleId = Array.isArray(_params) ? (_params[1] as string) : undefined;
        const isOwner = roleId !== undefined && ownerRoles.has(roleId);
        return { rows: isOwner ? [{ id: roleId }] : [], rowCount: isOwner ? 1 : 0 };
      }

      // --- loadAdminContext step 2: the ACTOR's own assignment list. ---
      // Distinguished from the fire target-list by the employee-slug SUBQUERY.
      if (
        text.includes("role_assignment ra") &&
        text.includes("ra.org_scope") &&
        text.includes("FROM choros.employee")
      ) {
        if (mgmtGrants.length > 0 && !opts.actorIsOwner) {
          return {
            rows: [{ id: "ra-admin-1", role_id: "role-admin-1", org_scope: EMPTY_SET }],
            rowCount: 1,
          };
        }
        // owner short-circuits; an owner needs no admin assignment row.
        return { rows: [], rowCount: 0 };
      }

      // --- loadAdminContext step 3: delegable mgmt_object:* grants. ---
      if (
        text.includes("LIKE 'mgmt_object:%'") &&
        text.includes("g.delegable = true")
      ) {
        const grants = mgmtGrants.map((g, i) => ({
          id: `g-${i}`,
          role_id: "role-admin-1",
          resource_type: g.resourceType,
          resource_facet: null,
          operation: g.operation,
          scope: EMPTY_SET, // whole-reach (⊥ ⊑ anything)
          constraint: null,
          delegable: true,
          granted_by: "seed",
          valid_from: null,
          valid_until: null,
          created_at: "0",
        }));
        return { rows: grants, rowCount: grants.length };
      }

      // --- fire: load the TARGET employee's active role_assignments. ---
      // Direct `employee_id = $2`, selects id/role_id/org_scope, no slug subquery.
      if (
        text.includes("FROM choros.role_assignment") &&
        text.includes("employee_id = $2") &&
        text.includes("org_scope") &&
        !text.includes("FROM choros.employee")
      ) {
        return { rows: opts.targetAssignments, rowCount: opts.targetAssignments.length };
      }

      // --- fire: substitution_rule lookup for sole-grant revoke. ---
      if (text.includes("substitution_rule")) {
        return { rows: [], rowCount: 0 };
      }

      // --- audit writer (appendAuditEvent) on the success path. ---
      // It reads the tenant GUC and the per-tenant audit_head row; return shapes
      // it expects so the success path commits (the hash-chain math is exercised
      // by the dedicated audit-writer suite; here we only need it to not throw).
      //
      // ORDER MATTERS: the audit_head SELECT FOR UPDATE *also* contains
      // `current_setting('choros.tenant_id'…)` in its WHERE, so it must be matched
      // BEFORE the bare-current_setting branch below (which is the preimage tenant
      // read) — otherwise head.seq is undefined → NaN bigint encode.
      if (text.includes("FROM choros.audit_head")) {
        // row_hash is a bytea → the audit writer frames it as a Buffer (32 bytes).
        return {
          rows: [{ seq: "0", row_hash: Buffer.alloc(32, 0), vocab_version: 1 }],
          rowCount: 1,
        };
      }
      if (text.includes("current_setting('choros.tenant_id'")) {
        return { rows: [{ tenant_id: DEV_TENANT }], rowCount: 1 };
      }

      // Everything else (BEGIN / SET LOCAL / COMMIT / ROLLBACK / UPDATE /
      // INSERT audit) is a no-op.
      return { rows: [], rowCount: 0 };
    },
    release() {
      /* no-op */
    },
  };

  return {
    connect: async () => client,
    query: client.query,
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// Tiny HTTP harness (mirrors grants.role-assignments.authz.test.ts).
// ---------------------------------------------------------------------------

async function startTestServer(
  pool: pg.Pool,
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerRightsIntentRoutes(router, pool);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e: Error | undefined) => (e ? reject(e) : resolve())),
      ),
  };
}

function post(
  port: number,
  path: string,
  body: unknown,
  actor = "constructor-admin",
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-dev-user": actor,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function errMessage(body: unknown): string | undefined {
  return (body as { error?: { message?: string } })?.error?.message;
}
function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-0469 (f) — fire intent CANNOT strip the tenant-owner RA (owner-strip closed)", () => {
  it("(f1) constructor-admin (delegable mgmt grants, NOT owner) firing the genesis owner → 403, no revoke UPDATE", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({
        actorIsOwner: false,
        adminMgmtGrants: [
          { resourceType: "mgmt_object:role", operation: "create" },
          { resourceType: "mgmt_object:employee", operation: "create" },
        ],
        // the target holds the tenant-owner RA (org_scope = ⊥ → org gate trivially passes)
        targetAssignments: [
          { id: OWNER_RA_ID, role_id: OWNER_ROLE_ID, org_scope: EMPTY_SET },
        ],
        ownerRoleIds: [OWNER_ROLE_ID],
        captured,
      }),
    );
    try {
      const resp = await post(port, "/api/rights/intents/fire", {
        employee_id: TARGET_EMPLOYEE_ID,
      });
      expect(resp.status).toBe(403);
      expect(errCode(resp.body)).toBe("ADMIN_GATE_REJECTED");
      // The precise reason proves the owner carve-out fired (not org/authority).
      expect(errMessage(resp.body)).toContain("owner_assignment_owner_only");
      // CRITICAL: the revoke UPDATE on role_assignment must NEVER have run.
      const ranRevoke = captured.some(
        (q) =>
          q.includes("UPDATE choros.role_assignment") && q.includes("valid_until"),
      );
      expect(ranRevoke).toBe(false);
    } finally {
      await close();
    }
  });

  it("(f2) the genesis OWNER CAN fire the owner-holding employee → 200 (no over-restriction)", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({
        actorIsOwner: true,
        targetAssignments: [
          { id: OWNER_RA_ID, role_id: OWNER_ROLE_ID, org_scope: EMPTY_SET },
        ],
        ownerRoleIds: [OWNER_ROLE_ID],
        captured,
      }),
    );
    try {
      const resp = await post(
        port,
        "/api/rights/intents/fire",
        { employee_id: TARGET_EMPLOYEE_ID },
        "genesis-owner",
      );
      expect(resp.status).toBe(200);
      expect((resp.body as { revoked_assignments?: number }).revoked_assignments).toBe(1);
    } finally {
      await close();
    }
  });

  it("(f3) constructor-admin firing a NORMAL non-owner employee in scope → 200 (carve-out is owner-specific)", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({
        actorIsOwner: false,
        adminMgmtGrants: [{ resourceType: "mgmt_object:employee", operation: "create" }],
        // the target holds only a NORMAL role assignment (org_scope = ⊥ ⊑ admin reach ⊥)
        targetAssignments: [
          { id: NORMAL_RA_ID, role_id: NORMAL_ROLE_ID, org_scope: EMPTY_SET },
        ],
        ownerRoleIds: [OWNER_ROLE_ID], // owner role exists, but target does NOT hold it
        captured,
      }),
    );
    try {
      const resp = await post(port, "/api/rights/intents/fire", {
        employee_id: TARGET_EMPLOYEE_ID,
      });
      expect(resp.status).toBe(200);
      expect((resp.body as { revoked_assignments?: number }).revoked_assignments).toBe(1);
    } finally {
      await close();
    }
  });
});
