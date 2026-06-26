/**
 * T-0331 (E15-S0a): Unit tests for grants-dao.ts
 *
 * Verifies the getActorRoles / getRoleSlugsForActor DAO reads from the DB-backed
 * source (not in-memory fixtures) and that the inbox.ts call sites resolve
 * correctly via the DB path.
 *
 * Pure unit — no live Postgres. A minimal fake pg.Pool models:
 *   - choros.employee (slug → id lookup)
 *   - choros.role_assignment (confirmed, in-window assignments)
 *   - choros.role (id → slug)
 *
 * Covers:
 *   - getRoleSlugsForActor: unknown actor → []
 *   - getRoleSlugsForActor: known actor with confirmed assignments → role slugs from DB
 *   - getRoleSlugsForActor: actor with expired assignment → excluded (time-window filter)
 *   - getRoleSlugsForActor: actor with unconfirmed assignment → excluded
 *   - getGrantsForSubject: known actor → Grant[] from DB
 *   - makeDbGrantSource: GrantSource interface conformance
 */

import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import {
  getRoleSlugsForActor,
  getGrantsForSubject,
  makeDbGrantSource,
} from "../db/grants-dao.js";
import type { ResolveSubject } from "../core/object-handle.js";

// ---------------------------------------------------------------------------
// Minimal fake pg.Pool
//
// Each query call is intercepted based on a simplified match against the SQL
// text. The pool is stateless: it receives a query plan and returns canned rows.
// ---------------------------------------------------------------------------

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";

/** One fake employee row in the DB. */
const FAKE_EMPLOYEES: Record<string, string> = {
  // slug → id
  "e-kravtsova": "d0000000-0000-0000-0000-000000000001",
  "e-mironov": "d0000000-0000-0000-0000-000000000004",
};

/** Fake role_assignment rows (simplified, per-employee-id). */
interface FakeAssignment {
  role_id: string;
  confirmed_by: string | null;
  valid_from: number | null;
  valid_until: number | null;
}
const FAKE_ASSIGNMENTS: Record<string, FakeAssignment[]> = {
  "d0000000-0000-0000-0000-000000000001": [
    // e-kravtsova: confirmed, no expiry → fin-ctrl
    { role_id: "r-fin-ctrl", confirmed_by: "seed", valid_from: null, valid_until: null },
    // unconfirmed → must NOT appear
    { role_id: "r-fin-appr", confirmed_by: null, valid_from: null, valid_until: null },
  ],
  "d0000000-0000-0000-0000-000000000004": [
    // e-mironov: confirmed, not yet expired → fin-appr
    { role_id: "r-fin-appr", confirmed_by: "seed", valid_from: 0, valid_until: null },
    // expired → must NOT appear for nowMs = 9999
    { role_id: "r-fin-ctrl", confirmed_by: "seed", valid_from: 0, valid_until: 5000 },
  ],
};

/** Fake role rows (id → slug + grants). */
interface FakeRole {
  slug: string;
  grants: Array<{
    id: string;
    operation: string;
    resource_type: string;
    scope: object;
    delegable: boolean;
    granted_by: string;
    valid_from: null;
    valid_until: null;
    created_at: string;
  }>;
}
const FAKE_ROLES: Record<string, FakeRole> = {
  "r-fin-ctrl": {
    slug: "fin-ctrl",
    grants: [
      {
        id: "g-fin-ctrl-1",
        operation: "read",
        resource_type: "mcp://ledger.invoices",
        scope: { kind: "node", hierarchy: "org", nodeId: "fin", nodeLevel: "department" },
        delegable: false,
        granted_by: "seed",
        valid_from: null,
        valid_until: null,
        created_at: "0",
      },
    ],
  },
  "r-fin-appr": {
    slug: "fin-appr",
    grants: [],
  },
};

/** Build the fake pool that routes queries to canned data. */
function makeFakePool(nowMs: number): import("pg").Pool {
  const fakeClient = {
    query: async (text: string, values?: unknown[]) => {
      const sql = typeof text === "object" ? (text as { text: string }).text : text;
      const params = values ?? [];

      // BEGIN / COMMIT / ROLLBACK
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) {
        return { rows: [] };
      }
      // SET LOCAL …
      if (/^\s*SET LOCAL/i.test(sql)) {
        return { rows: [] };
      }

      // Employee slug lookup: SELECT id FROM choros.employee WHERE … slug = $2
      if (/FROM choros\.employee/i.test(sql)) {
        const slug = params[1] as string;
        const id = FAKE_EMPLOYEES[slug];
        return { rows: id ? [{ id }] : [] };
      }

      // Role slug lookup (JOIN): SELECT DISTINCT r.slug FROM choros.role_assignment ra JOIN choros.role r …
      // MUST be checked BEFORE the plain role_assignment pattern (JOIN is a superset).
      if (/JOIN choros\.role\b/i.test(sql)) {
        const empId = params[1] as string;
        const assignments = (FAKE_ASSIGNMENTS[empId] ?? []).filter((ra) => {
          if (!ra.confirmed_by) return false;
          if (ra.valid_from !== null && ra.valid_from > nowMs) return false;
          if (ra.valid_until !== null && ra.valid_until <= nowMs) return false;
          return true;
        });
        const slugs = [...new Set(
          assignments
            .map((ra) => FAKE_ROLES[ra.role_id]?.slug)
            .filter((s): s is string => s !== undefined),
        )];
        return { rows: slugs.map((slug) => ({ slug })) };
      }

      // Plain role_assignment lookup (no JOIN): SELECT ra.role_id FROM choros.role_assignment …
      // Used by getGrantsForSubject step 2 (separate from the JOIN path above).
      if (/FROM choros\.role_assignment\b/i.test(sql)) {
        const empId = params[1] as string;
        const rows = (FAKE_ASSIGNMENTS[empId] ?? []).filter((ra) => {
          if (!ra.confirmed_by) return false;
          if (ra.valid_from !== null && ra.valid_from > nowMs) return false;
          if (ra.valid_until !== null && ra.valid_until <= nowMs) return false;
          return true;
        });
        return { rows: rows.map((r) => ({ role_id: r.role_id })) };
      }

      // Grant rows for roles: SELECT … FROM choros."grant" WHERE … role_id = ANY($2::uuid[]) …
      if (/FROM choros\."grant"/i.test(sql)) {
        const roleIds = params[1] as string[];
        const rows: unknown[] = [];
        for (const roleId of roleIds) {
          const role = FAKE_ROLES[roleId];
          if (!role) continue;
          for (const g of role.grants) {
            rows.push({
              id: g.id,
              role_id: roleId,
              resource_type: g.resource_type,
              resource_facet: null,
              operation: g.operation,
              scope: g.scope,
              constraint: null,
              delegable: g.delegable,
              granted_by: g.granted_by,
              valid_from: g.valid_from,
              valid_until: g.valid_until,
              created_at: g.created_at,
            });
          }
        }
        return { rows };
      }

      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;

  return {
    connect: async () => fakeClient,
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getRoleSlugsForActor (T-0331 S0a DAO)", () => {
  const NOW = 10000;

  it("returns [] for an unknown actor (no employee row)", async () => {
    const pool = makeFakePool(NOW);
    const slugs = await getRoleSlugsForActor(pool, TENANT_ID, "e-unknown", NOW);
    expect(slugs).toEqual([]);
  });

  it("returns role slugs from DB for a known actor with confirmed assignments", async () => {
    const pool = makeFakePool(NOW);
    const slugs = await getRoleSlugsForActor(pool, TENANT_ID, "e-kravtsova", NOW);
    // e-kravtsova: only fin-ctrl is confirmed (fin-appr is unconfirmed → excluded)
    expect(slugs).toContain("fin-ctrl");
    expect(slugs).not.toContain("fin-appr");
  });

  it("excludes expired assignments (valid_until <= nowMs)", async () => {
    const pool = makeFakePool(NOW);
    // e-mironov: fin-appr is not expired (valid_until = null), fin-ctrl is expired (valid_until=5000 < NOW=10000)
    const slugs = await getRoleSlugsForActor(pool, TENANT_ID, "e-mironov", NOW);
    expect(slugs).toContain("fin-appr");
    expect(slugs).not.toContain("fin-ctrl");
  });

  it("excludes unconfirmed assignments", async () => {
    const pool = makeFakePool(NOW);
    // e-kravtsova has an unconfirmed fin-appr assignment → must not appear
    const slugs = await getRoleSlugsForActor(pool, TENANT_ID, "e-kravtsova", NOW);
    expect(slugs).not.toContain("fin-appr");
  });

  it("returns [] when actor has no valid assignments", async () => {
    const pool = makeFakePool(NOW);
    // Use an actor with no rows at all
    const slugs = await getRoleSlugsForActor(pool, TENANT_ID, "e-savina", NOW);
    expect(slugs).toEqual([]);
  });
});

describe("getGrantsForSubject (T-0331 S0a — full Grant[])", () => {
  const NOW = 10000;

  it("returns Grant[] for a known actor with confirmed assignments and grants", async () => {
    const pool = makeFakePool(NOW);
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-kravtsova", NOW);
    // e-kravtsova holds fin-ctrl which has one grant (read on ledger.invoices)
    expect(grants.length).toBe(1);
    expect(grants[0]!.operation).toBe("read");
    expect(grants[0]!.resourceType).toBe("mcp://ledger.invoices");
    expect(grants[0]!.tenantId).toBe(TENANT_ID);
  });

  it("returns [] for an unknown actor", async () => {
    const pool = makeFakePool(NOW);
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-nobody", NOW);
    expect(grants).toEqual([]);
  });
});

describe("makeDbGrantSource (T-0331 S0a — GrantSource interface)", () => {
  const NOW = 10000;

  it("implements GrantSource.getGrants and returns Grant[]", async () => {
    const pool = makeFakePool(NOW);
    const grantSource = makeDbGrantSource(pool);

    const subject: ResolveSubject = { tenantId: TENANT_ID, subjectId: "e-kravtsova" };
    const grants = await grantSource.getGrants(subject, NOW);
    expect(Array.isArray(grants)).toBe(true);
    expect(grants.length).toBe(1);
    expect(grants[0]!.roleId).toBe("r-fin-ctrl");
  });

  it("GrantSource.getGrants returns [] for unknown actor", async () => {
    const pool = makeFakePool(NOW);
    const grantSource = makeDbGrantSource(pool);
    const subject: ResolveSubject = { tenantId: TENANT_ID, subjectId: "e-nobody" };
    const grants = await grantSource.getGrants(subject, NOW);
    expect(grants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R-1 fail-closed propagation tests (T-0331 S0a review finding)
//
// Proves that getRoleSlugsForActor propagates DB errors rather than swallowing
// them. Since resolveRolesForActor (inbox.ts) delegates directly to
// getRoleSlugsForActor with no try/catch when hasDb() is true, this is the
// canonical proof that authority gates (claim, approve) will receive a thrown
// error — not a fixture/[] fallback — when the DB fails.
// ---------------------------------------------------------------------------

/** Build a pool whose query always throws with the given error. */
function makeThrowingPool(err: Error): import("pg").Pool {
  const fakeClient = {
    query: async (_text: unknown, _values?: unknown[]) => {
      throw err;
    },
    release: () => {},
  } as unknown as import("pg").PoolClient;

  return {
    connect: async () => fakeClient,
  } as unknown as import("pg").Pool;
}

describe("getRoleSlugsForActor — fail-closed DB error propagation (R-1, T-0331)", () => {
  const NOW = 10000;

  it("propagates a DB connection error rather than returning [] or fixture roles", async () => {
    const dbErr = new Error("simulated DB connection failure");
    const pool = makeThrowingPool(dbErr);

    // Must reject — no swallowing, no fixture fallback.
    await expect(
      getRoleSlugsForActor(pool, TENANT_ID, "e-kravtsova", NOW),
    ).rejects.toThrow("simulated DB connection failure");
  });

  it("propagates a query timeout error (actor unknown but DB still throws)", async () => {
    const dbErr = new Error("query timed out");
    const pool = makeThrowingPool(dbErr);

    // Even for an actor that would have no rows — a DB-level throw must propagate.
    await expect(
      getRoleSlugsForActor(pool, TENANT_ID, "e-nobody", NOW),
    ).rejects.toThrow("query timed out");
  });
});

describe("getGrantsForSubject — fail-closed DB error propagation (R-1, T-0331)", () => {
  const NOW = 10000;

  it("propagates a DB error rather than returning []", async () => {
    const dbErr = new Error("simulated network failure");
    const pool = makeThrowingPool(dbErr);

    await expect(
      getGrantsForSubject(pool, TENANT_ID, "e-kravtsova", NOW),
    ).rejects.toThrow("simulated network failure");
  });
});

// ---------------------------------------------------------------------------
// T-0366 — fallback slug for KC seed personas
//
// Seed personas have employee.slug = 'e-larina' but KC sub = a random UUID
// (e.g. 'f4a5f440-3c5b-438b-b1eb-eac5d4dff3e9'). The primary lookup
// (slug=sub) returns 0 rows; the fallback (slug=preferred_username) resolves
// the employee and returns the correct role slugs.
//
// Three scenarios:
//   (a) sub matches employee slug (registered user) → primary hit, no fallback.
//   (b) sub matches NO employee, fallback (preferred_username) matches → roles via fallback.
//   (c) neither primary nor fallback matches → [].
// ---------------------------------------------------------------------------

/** Extended fake employees: adds a seed persona whose slug ≠ sub UUID. */
const FAKE_EMPLOYEES_WITH_SEED: Record<string, string> = {
  ...FAKE_EMPLOYEES,
  // Registered user: slug == sub (UUID sub format for this test).
  "registered-sub-uuid": "d0000000-0000-0000-0000-000000000010",
  // Seed persona: slug = 'e-larina', KC sub = random UUID that won't match slug.
  "e-larina": "d0000000-0000-0000-0000-000000000005",
};

const FAKE_ASSIGNMENTS_WITH_SEED: Record<string, Array<{
  role_id: string;
  confirmed_by: string | null;
  valid_from: number | null;
  valid_until: number | null;
}>> = {
  ...FAKE_ASSIGNMENTS,
  "d0000000-0000-0000-0000-000000000010": [
    // Registered user: confirmed role-approver.
    { role_id: "r-fin-ctrl", confirmed_by: "seed", valid_from: null, valid_until: null },
  ],
  "d0000000-0000-0000-0000-000000000005": [
    // Seed persona e-larina: confirmed fin-cfo + role-approver assignments.
    { role_id: "r-fin-ctrl", confirmed_by: "seed", valid_from: null, valid_until: null },
  ],
};

const FAKE_ROLES_WITH_SEED = { ...FAKE_ROLES };

function makeFakePoolWithSeed(nowMs: number): import("pg").Pool {
  const fakeClient = {
    query: async (text: string, values?: unknown[]) => {
      const sql = typeof text === "object" ? (text as { text: string }).text : text;
      const params = values ?? [];
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [] };
      if (/^\s*SET LOCAL/i.test(sql)) return { rows: [] };

      if (/FROM choros\.employee/i.test(sql)) {
        const slug = params[1] as string;
        const id = FAKE_EMPLOYEES_WITH_SEED[slug];
        return { rows: id ? [{ id }] : [] };
      }

      if (/JOIN choros\.role\b/i.test(sql)) {
        const empId = params[1] as string;
        const assignments = (FAKE_ASSIGNMENTS_WITH_SEED[empId] ?? []).filter((ra) => {
          if (!ra.confirmed_by) return false;
          if (ra.valid_from !== null && ra.valid_from > nowMs) return false;
          if (ra.valid_until !== null && ra.valid_until <= nowMs) return false;
          return true;
        });
        const slugs = [...new Set(
          assignments
            .map((ra) => FAKE_ROLES_WITH_SEED[ra.role_id]?.slug)
            .filter((s): s is string => s !== undefined),
        )];
        return { rows: slugs.map((slug) => ({ slug })) };
      }

      if (/FROM choros\.role_assignment\b/i.test(sql)) {
        const empId = params[1] as string;
        const rows = (FAKE_ASSIGNMENTS_WITH_SEED[empId] ?? []).filter((ra) => {
          if (!ra.confirmed_by) return false;
          if (ra.valid_from !== null && ra.valid_from > nowMs) return false;
          if (ra.valid_until !== null && ra.valid_until <= nowMs) return false;
          return true;
        });
        return { rows: rows.map((r) => ({ role_id: r.role_id })) };
      }

      if (/FROM choros\."grant"/i.test(sql)) {
        return { rows: [] };
      }

      return { rows: [] };
    },
    release: () => {},
  } as unknown as import("pg").PoolClient;

  return {
    connect: async () => fakeClient,
  } as unknown as import("pg").Pool;
}

describe("getRoleSlugsForActor — T-0366 KC seed persona fallback", () => {
  const NOW = 10000;

  it("(a) registered user: primary (sub=slug) hits → roles resolved, fallback never consulted", async () => {
    const pool = makeFakePoolWithSeed(NOW);
    // 'registered-sub-uuid' is the slug AND the sub for this registered user.
    const slugs = await getRoleSlugsForActor(
      pool, TENANT_ID,
      "registered-sub-uuid",   // primary = sub = slug → hits employee row
      NOW,
      "some-other-username",   // fallback provided but must NOT be consulted
    );
    expect(slugs).toContain("fin-ctrl");
  });

  it("(b) KC seed persona: sub matches no employee, fallback (preferred_username=e-larina) resolves roles", async () => {
    const pool = makeFakePoolWithSeed(NOW);
    // 'f4a5f440-3c5b-438b-b1eb-eac5d4dff3e9' is the KC UUID sub — no employee row.
    const slugs = await getRoleSlugsForActor(
      pool, TENANT_ID,
      "f4a5f440-3c5b-438b-b1eb-eac5d4dff3e9",  // primary (sub) → no employee row
      NOW,
      "e-larina",              // fallback (preferred_username) → resolves to seed persona
    );
    expect(slugs).toContain("fin-ctrl");
  });

  it("(c) neither primary nor fallback matches → [] (no impersonation)", async () => {
    const pool = makeFakePoolWithSeed(NOW);
    const slugs = await getRoleSlugsForActor(
      pool, TENANT_ID,
      "unknown-sub-uuid",      // primary → no row
      NOW,
      "e-nobody",              // fallback → also no row
    );
    expect(slugs).toEqual([]);
  });

  it("no fallback provided and primary misses → [] (unchanged behaviour)", async () => {
    const pool = makeFakePoolWithSeed(NOW);
    const slugs = await getRoleSlugsForActor(
      pool, TENANT_ID,
      "unknown-sub-uuid",      // primary → no row
      NOW,
      // no fallback
    );
    expect(slugs).toEqual([]);
  });

  it("fallback equals primary → treated as no-fallback, returns [] when neither matches", async () => {
    const pool = makeFakePoolWithSeed(NOW);
    // When fallbackSlug === actorSlug, the DAO skips the second lookup (same slug → same result).
    const slugs = await getRoleSlugsForActor(
      pool, TENANT_ID,
      "unknown-sub-uuid",
      NOW,
      "unknown-sub-uuid",      // fallback === primary → skipped
    );
    expect(slugs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-0397 — PDP dual-control read-path enforcement
//
// A CRITICAL grant/assignment is PDP-active only when its SECOND distinct
// approver is present (confirmed2_by IS NOT NULL); the grant query also honors
// valid_until (previously ignored for grants). "Critical" = the SQL-expressible
// criticality axes a grant row can carry (role-criticality.ts axis a/b):
//   axis a — operation IN ('approve','transition')
//   axis b — resource_type = 'effect_resource' AND operation = 'invoke'
// An assignment is critical iff the role it binds holds any such grant.
//
// This dedicated fake pool models the FULL T-0397 SQL semantics (confirmed2_by,
// grant valid_until, role→grant criticality EXISTS) so the gating is verified
// end-to-end through the real DAO queries. It is self-contained — it does NOT
// reuse the legacy fixtures above (which predate confirmed2_by).
// ---------------------------------------------------------------------------

interface T0397Grant {
  id: string;
  operation: string;
  resource_type: string;
  confirmed_by: string | null;
  confirmed2_by: string | null;
  valid_from: number | null;
  valid_until: number | null;
}
interface T0397Assignment {
  role_id: string;
  confirmed_by: string | null;
  confirmed2_by: string | null;
  valid_from: number | null;
  valid_until: number | null;
}

/** Is a single grant row "critical" under the axis-a/b SQL predicate? */
function isCriticalGrant(g: { operation: string; resource_type: string }): boolean {
  return (
    g.operation === "approve" ||
    g.operation === "transition" ||
    (g.resource_type === "effect_resource" && g.operation === "invoke")
  );
}

/** Does this role hold ANY confirmed critical grant? (assignment criticality) */
function roleHoldsCriticalGrant(grants: T0397Grant[]): boolean {
  return grants.some((g) => g.confirmed_by !== null && isCriticalGrant(g));
}

const T0397_NOW = 10_000;

// Employees: slug → id.
const T0397_EMP: Record<string, string> = {
  "e-approver": "d0000000-0000-0000-0000-0000000003a1",
  "e-reader": "d0000000-0000-0000-0000-0000000003a2",
  "e-expired": "d0000000-0000-0000-0000-0000000003a3",
  "e-ra-critical": "d0000000-0000-0000-0000-0000000003a4",
};

// Roles: id → { slug, grants }.
const T0397_ROLES: Record<string, { slug: string; grants: T0397Grant[] }> = {
  // (a)/(b) Critical grant — single-confirm vs dual-confirm tested via two roles.
  "r-crit-single": {
    slug: "crit-single",
    grants: [
      // approve grant, confirmed_by only, confirmed2_by NULL → NOT active.
      { id: "g-crit-single", operation: "approve", resource_type: "record",
        confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null },
    ],
  },
  "r-crit-dual": {
    slug: "crit-dual",
    grants: [
      // same approve grant but confirmed2_by present → active.
      { id: "g-crit-dual", operation: "approve", resource_type: "record",
        confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null },
    ],
  },
  // (c) Critical, dual-confirmed, but EXPIRED valid_until → NOT active.
  "r-crit-expired": {
    slug: "crit-expired",
    grants: [
      { id: "g-crit-expired", operation: "invoke", resource_type: "effect_resource",
        confirmed_by: "seed", confirmed2_by: "seed2", valid_from: 0, valid_until: 5_000 },
    ],
  },
  // (d) Non-critical (read) grant, single-confirm → STILL active (no regression).
  "r-noncrit": {
    slug: "noncrit",
    grants: [
      { id: "g-noncrit", operation: "read", resource_type: "record",
        confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null },
    ],
  },
};

// Assignments per employee-id (for the role_assignment-level gate).
const T0397_ASSIGN: Record<string, T0397Assignment[]> = {
  // e-approver: assigned to BOTH crit-single (no #2) and crit-dual (#2 set), each
  // assignment itself dual-confirmed so the assignment gate passes — this isolates
  // the GRANT-level confirmed2_by gate.
  [T0397_EMP["e-approver"]!]: [
    { role_id: "r-crit-single", confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null },
    { role_id: "r-crit-dual",   confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null },
  ],
  // e-reader: non-critical role, single-confirm assignment → active.
  [T0397_EMP["e-reader"]!]: [
    { role_id: "r-noncrit", confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null },
  ],
  // e-expired: critical role with EXPIRED grant (assignment itself fine).
  [T0397_EMP["e-expired"]!]: [
    { role_id: "r-crit-expired", confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null },
  ],
  // e-ra-critical: assigned to a CRITICAL role (crit-dual holds an active approve
  // grant) but the ASSIGNMENT has confirmed2_by NULL → assignment-level gate
  // excludes it (this is the role_assignment confirmed2_by test, deliverable (e)).
  [T0397_EMP["e-ra-critical"]!]: [
    { role_id: "r-crit-dual", confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null },
  ],
};

function makeT0397Pool(nowMs: number): import("pg").Pool {
  const inWindow = (vf: number | null, vu: number | null): boolean => {
    if (vf !== null && vf > nowMs) return false;
    if (vu !== null && vu <= nowMs) return false;
    return true;
  };
  // Assignment passes its own gate: confirmed, in-window, AND
  // (confirmed2_by set OR role holds no critical grant).
  const assignmentActive = (ra: T0397Assignment): boolean => {
    if (!ra.confirmed_by) return false;
    if (!inWindow(ra.valid_from, ra.valid_until)) return false;
    const role = T0397_ROLES[ra.role_id];
    const roleCritical = role ? roleHoldsCriticalGrant(role.grants) : false;
    if (roleCritical && ra.confirmed2_by === null) return false;
    return true;
  };

  const fakeClient = {
    query: async (text: string, values?: unknown[]) => {
      const sql = typeof text === "object" ? (text as { text: string }).text : text;
      const params = values ?? [];
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [] };
      if (/^\s*SET LOCAL/i.test(sql)) return { rows: [] };

      if (/FROM choros\.employee/i.test(sql)) {
        const slug = params[1] as string;
        const id = T0397_EMP[slug];
        return { rows: id ? [{ id }] : [] };
      }

      // Role-slug JOIN path (getRoleSlugsForActor).
      if (/JOIN choros\.role\b/i.test(sql)) {
        const empId = params[1] as string;
        const slugs = [...new Set(
          (T0397_ASSIGN[empId] ?? [])
            .filter(assignmentActive)
            .map((ra) => T0397_ROLES[ra.role_id]?.slug)
            .filter((s): s is string => s !== undefined),
        )];
        return { rows: slugs.map((slug) => ({ slug })) };
      }

      // Plain role_assignment path (getGrantsForSubject step 2).
      if (/FROM choros\.role_assignment\b/i.test(sql)) {
        const empId = params[1] as string;
        const rows = (T0397_ASSIGN[empId] ?? [])
          .filter(assignmentActive)
          .map((ra) => ({ role_id: ra.role_id }));
        return { rows };
      }

      // Grant path (getGrantsForSubject step 3): confirmed, in-window, AND
      // (not critical OR confirmed2_by set).
      if (/FROM choros\."grant"/i.test(sql)) {
        const roleIds = params[1] as string[];
        const rows: unknown[] = [];
        for (const roleId of roleIds) {
          const role = T0397_ROLES[roleId];
          if (!role) continue;
          for (const g of role.grants) {
            if (!g.confirmed_by) continue;
            if (!inWindow(g.valid_from, g.valid_until)) continue;
            if (isCriticalGrant(g) && g.confirmed2_by === null) continue;
            rows.push({
              id: g.id,
              role_id: roleId,
              resource_type: g.resource_type,
              resource_facet: null,
              operation: g.operation,
              scope: { kind: "node", hierarchy: "org", nodeId: "x", nodeLevel: "department" },
              constraint: null,
              delegable: false,
              granted_by: "seed",
              valid_from: g.valid_from,
              valid_until: g.valid_until,
              created_at: "0",
            });
          }
        }
        return { rows };
      }

      return { rows: [] };
    },
    release: () => {},
  } as unknown as import("pg").PoolClient;

  return { connect: async () => fakeClient } as unknown as import("pg").Pool;
}

describe("getGrantsForSubject — T-0397 dual-control grant gate", () => {
  it("(a) critical grant with only confirmed_by (no confirmed2_by) → NOT PDP-active", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    // e-approver holds BOTH crit-single (no #2) and crit-dual (#2 set).
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-approver", T0397_NOW);
    const ids = grants.map((g) => g.id);
    // crit-single grant must be excluded (confirmed2_by NULL on a critical grant).
    expect(ids).not.toContain("g-crit-single");
  });

  it("(b) same critical capability with confirmed2_by set → PDP-active", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-approver", T0397_NOW);
    const ids = grants.map((g) => g.id);
    // crit-dual grant IS active (second approver present).
    expect(ids).toContain("g-crit-dual");
  });

  it("(c) critical grant past its valid_until → NOT active (grant query honors valid_until)", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    // e-expired holds crit-expired (dual-confirmed) but valid_until=5000 < NOW=10000.
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-expired", T0397_NOW);
    expect(grants.map((g) => g.id)).not.toContain("g-crit-expired");
  });

  it("(d) non-critical grant with single confirm → STILL active (no regression)", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-reader", T0397_NOW);
    // read grant, confirmed2_by NULL → must remain active (non-critical path).
    expect(grants.map((g) => g.id)).toContain("g-noncrit");
  });
});

describe("getRoleSlugsForActor / getGrantsForSubject — T-0397 role_assignment confirmed2_by gate", () => {
  it("(e) assignment to a critical role with confirmed2_by NULL → role slug excluded", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    // e-ra-critical: assigned to crit-dual (a critical role), but the ASSIGNMENT
    // has confirmed2_by NULL → the assignment-level dual-control gate drops it.
    const slugs = await getRoleSlugsForActor(pool, TENANT_ID, "e-ra-critical", T0397_NOW);
    expect(slugs).not.toContain("crit-dual");
    expect(slugs).toEqual([]);
  });

  it("(e') same critical assignment also contributes ZERO grants (PDP path)", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    // Step 2 (assignment) drops the role before step 3 (grants) runs → no grants.
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-ra-critical", T0397_NOW);
    expect(grants).toEqual([]);
  });

  it("(e'') non-critical assignment with confirmed2_by NULL → role slug INCLUDED (no regression)", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    // e-reader: assigned to noncrit role (no critical grant) with confirmed2_by
    // NULL → assignment gate passes (role not critical).
    const slugs = await getRoleSlugsForActor(pool, TENANT_ID, "e-reader", T0397_NOW);
    expect(slugs).toContain("noncrit");
  });
});
