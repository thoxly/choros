/**
 * T-0029 · scoped-admin static fitness (AC-8/AC-9/AC-15).
 *
 * Static-now checks runnable inside `npm run ci` (no DB). These mirror the
 * T-0018 fitness style: assert architectural invariants over the module text
 * and over a model fixture, not just runtime behaviour.
 *
 *   AC-8  — no second authority subsystem: the model fixture expresses admin
 *           authority ONLY as grant rows on mgmt_object:* (no admin table/flag/
 *           role-kind). The grep half lives in scoped-admin-isolation.sh; here we
 *           assert the data model: a mgmt-admin is a role + grants, nothing else.
 *   AC-9  — no new scope algebra: scoped-admin.ts imports the lattice primitives
 *           and exports no ScopeElement-kind constructor / containment fn.
 *   AC-15 — audit obligation: a mgmt-grant create/revoke emits a GrantAuditEvent
 *           carrying actor, subject (role_id), capability (resource_type ×
 *           operation × facet), scope, and (when present) proposed_by/confirmed_by.
 *           T-0029 ships the obligation CONTRACT (the emit-shape) — the live call
 *           sites are T-0030. Here we pin the shape (reusing T-0018 GrantAuditEvent).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  type Grant,
  type GrantAuditEvent,
} from "../core/grant-lattice.js";
import { MGMT_OBJECT_KINDS } from "../core/scoped-admin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_SRC = readFileSync(join(HERE, "..", "core", "scoped-admin.ts"), "utf8");

// ---------------------------------------------------------------------------
// AC-8 — no second authority subsystem (model fixture)
// ---------------------------------------------------------------------------
describe("AC-8 · admin authority is grant rows on mgmt_object:* only", () => {
  it("a fully-capable mgmt-admin is a role + mgmt_object:* grants — no admin table/flag", () => {
    // The complete model of a mgmt-admin: a role principal carrying ordinary
    // grant rows whose resource_type is a mgmt_object kind. There is no
    // admin-specific entity.
    const adminModel = {
      role: { id: "e0000000-0000-0000-0000-000000000001", slug: "tenant-owner" },
      grants: MGMT_OBJECT_KINDS.map((kind, i) => ({
        roleId: "e0000000-0000-0000-0000-000000000001",
        resourceType: kind,
        operation: "create",
        scope: { kind: "node", hierarchy: "org", nodeId: `n${i}`, nodeLevel: "department" },
        delegable: true,
      })),
    };
    // Every authority-bearing field lives on a `grant`; the only other entity is
    // the role principal. Assert there is no admin-specific key in the model.
    const keys = Object.keys(adminModel);
    expect(keys.sort()).toEqual(["grants", "role"]);
    for (const g of adminModel.grants) {
      expect(g.resourceType.startsWith("mgmt_object:")).toBe(true);
    }
  });

  it("the checker module text introduces no admin-specific table/flag/ACL token", () => {
    for (const forbidden of ["admin_table", "adminRole", "isAdminFlag", "_acl", "admin_flag"]) {
      // Allow the token to appear only inside a comment line.
      const lines = MODULE_SRC.split("\n").filter((l) => l.includes(forbidden));
      const nonComment = lines.filter((l) => !/^\s*(\/\/|\*)/.test(l));
      expect(nonComment, `forbidden authority token '${forbidden}' in code`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-9 — no new scope algebra (import contract)
// ---------------------------------------------------------------------------
describe("AC-9 · reuses lattice primitives, defines no parallel algebra", () => {
  it("scoped-admin.ts imports validateNarrowing + isNarrowerOrEqual from grant-lattice.js", () => {
    expect(MODULE_SRC).toMatch(/from\s+["']\.\/grant-lattice\.js["']/);
    expect(MODULE_SRC).toMatch(/\bvalidateNarrowing\b/);
    expect(MODULE_SRC).toMatch(/\bisNarrowerOrEqual\b/);
  });

  it("scoped-admin.ts defines no parallel containment fn nor a new ScopeElement kind", () => {
    // No local re-implementation of the subset math.
    expect(MODULE_SRC).not.toMatch(/function\s+isNarrower/);
    expect(MODULE_SRC).not.toMatch(/function\s+validateNarrow/);
    expect(MODULE_SRC).not.toMatch(/function\s+atomIsNarrower/);
    // No new ScopeElement-kind literal (the four kinds are fixed in grant-lattice).
    expect(MODULE_SRC).not.toMatch(/kind:\s*["']hierarchy["']/);
  });
});

// ---------------------------------------------------------------------------
// AC-15 — audit obligation contract (emit-shape; call sites = T-0030)
// ---------------------------------------------------------------------------
describe("AC-15 · mgmt-grant issue/revoke audit obligation (emit-shape)", () => {
  // A representative mgmt-grant the write-path would persist.
  const mgmtGrant: Grant = {
    tenantId: "a0000000-0000-0000-0000-000000000001",
    id: "e1000000-0000-0000-0000-000000000001",
    roleId: "e0000000-0000-0000-0000-000000000001",
    resourceType: "mgmt_object:role",
    operation: "create",
    scope: { kind: "node", hierarchy: "org", nodeId: "b0000000-0000-0000-0000-000000000001", nodeLevel: "department" },
    delegable: true,
    grantedBy: "owner-actor",
    createdAt: 0,
  };

  // The obligation the T-0030 call site MUST satisfy: derive a GrantAuditEvent
  // (the T-0018 FR-7 shape, reused verbatim) from the persisted mgmt-grant.
  function mgmtGrantAudit(
    g: Grant,
    actor: string,
    kind: "grant.create" | "grant.revoke",
    opts?: { proposedBy?: string; confirmedBy?: string },
  ): GrantAuditEvent {
    return {
      kind,
      actor,
      subjectRoleId: g.roleId,
      capability: { resourceType: g.resourceType, operation: g.operation, resourceFacet: g.resourceFacet },
      scope: g.scope as GrantAuditEvent["scope"],
      proposedBy: opts?.proposedBy,
      confirmedBy: opts?.confirmedBy,
    };
  }

  it("a mgmt-grant create emits an event carrying actor / subject / capability / scope", () => {
    const ev = mgmtGrantAudit(mgmtGrant, "owner-actor", "grant.create", { confirmedBy: "founder" });
    expect(ev.kind).toBe("grant.create");
    expect(ev.actor).toBe("owner-actor");
    expect(ev.subjectRoleId).toBe(mgmtGrant.roleId);
    expect(ev.capability.resourceType).toBe("mgmt_object:role");
    expect(ev.capability.operation).toBe("create");
    expect(ev.scope).toEqual(mgmtGrant.scope);
    expect(ev.confirmedBy).toBe("founder");
  });

  it("a mgmt-grant revoke emits the same obligation shape", () => {
    const ev = mgmtGrantAudit(mgmtGrant, "owner-actor", "grant.revoke");
    expect(ev.kind).toBe("grant.revoke");
    expect(ev.subjectRoleId).toBe(mgmtGrant.roleId);
    expect(ev.capability.resourceType.startsWith("mgmt_object:")).toBe(true);
  });
});
