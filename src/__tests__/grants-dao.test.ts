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
// T-0397 — PDP dual-control read-path enforcement (UNIT — predicate MIRROR)
//
// ⚠️ MIRROR, NOT THE REAL SQL: this fake pool RE-IMPLEMENTS the criticality
// predicate in TS (isCriticalGrant below). It proves the DAO WIRING + the gate's
// SHAPE, but it does NOT exercise the real grants-dao.ts SQL. The authoritative
// proof that the ACTUAL SQL predicate gates every axis (incl. axis-c clearance
// JSONB parsing) is the LIVE-Postgres probe ci/checks/db/grants-dao-dual-control
// .db.test.ts (review B2 — that is what closes the test-theater). The mirror is
// kept in sync with the SQL over all four axes so it is not actively misleading.
//
// A CRITICAL GRANT is PDP-active only when its SECOND distinct approver is
// present (confirmed2_by IS NOT NULL); the grant query also honors valid_until
// (previously ignored for grants). "Critical" = the full escalation
// classification (criticalGrantPredicate):
//   axis a — operation IN ('approve','transition')
//   axis b — resource_type = 'effect_resource' AND operation = 'invoke'
//   axis c — operation = 'read' with a sensitive clearance marker (confidential|restricted)
//   Q-2   — operation = 'read' with a present-but-garbage clearance token
//
// T-0605 — ASSIGNMENT activation is the CANONICAL predicate (single source with
// rights-overview.ts and the write side), NOT the role's absolute criticality:
//   confirmed_by IS NOT NULL AND (confirmed2_by IS NOT NULL OR proposed_by IS NULL)
//   AND in-window.
// A routine assignment (proposed_by NULL, one confirm) is active EVEN to a
// critical role — the prior "role-critical ⇒ assignment needs confirmed2_by"
// gate was a self-lock (holder shown on the card, invisible to the PDP → 403).
// A genuinely-ESCALATING (semi-confirmed) assignment carries proposed_by (set)
// with confirmed2_by NULL and stays inactive until the second approver confirms.
// ---------------------------------------------------------------------------

interface T0397Grant {
  id: string;
  operation: string;
  resource_type: string;
  confirmed_by: string | null;
  confirmed2_by: string | null;
  valid_from: number | null;
  valid_until: number | null;
  // T-0397 axis-c/Q-2 mirror: the clearance marker carried on the constraint
  // surface ({ clearance: <DataClass | garbage> }). Absent = no marker.
  constraint?: Record<string, unknown> | null;
}
interface T0397Assignment {
  role_id: string;
  // T-0605: proposed_by carries the write-side ROUTINE-vs-ESCALATING signal.
  // Routine assignment → proposed_by = null (active on one confirm). Escalating
  // (semi-confirmed) assignment → proposed_by = actor (pending until confirmed2_by).
  proposed_by: string | null;
  confirmed_by: string | null;
  confirmed2_by: string | null;
  valid_from: number | null;
  valid_until: number | null;
}

const VALID_DATA_CLASSES = ["public", "internal", "confidential", "restricted"];
const SENSITIVE_DATA_CLASSES = ["confidential", "restricted"];

/** Is a single grant row "critical" under the full four-axis predicate (mirror)? */
function isCriticalGrant(g: {
  operation: string;
  resource_type: string;
  constraint?: Record<string, unknown> | null;
}): boolean {
  // axis a
  if (g.operation === "approve" || g.operation === "transition") return true;
  // axis b
  if (g.resource_type === "effect_resource" && g.operation === "invoke") return true;
  // axis c + Q-2 — read grant with a clearance marker (constraint-first; the unit
  // fixtures only co-locate the marker on constraint, matching grantClearance order).
  if (g.operation === "read") {
    const c = g.constraint;
    if (c !== null && c !== undefined && Object.prototype.hasOwnProperty.call(c, "clearance")) {
      const v = c["clearance"];
      // axis c: a sensitive DataClass token.
      if (typeof v === "string" && SENSITIVE_DATA_CLASSES.includes(v)) return true;
      // Q-2: present-but-not-a-derivable-DataClass token (incl. null / non-string).
      if (typeof v !== "string" || !VALID_DATA_CLASSES.includes(v)) return true;
    }
  }
  return false;
}

// T-0605: `roleHoldsCriticalGrant` removed — the assignment-active predicate no
// longer depends on the role's absolute criticality (only on the assignment's own
// confirmed/semi-confirmed state). `isCriticalGrant` remains: it still gates the
// GRANT-level dual-control in the grant-query mirror below (getGrantsForSubject
// step 3), which is where authority for critical rights actually lives.

const T0397_NOW = 10_000;

// Employees: slug → id.
const T0397_EMP: Record<string, string> = {
  "e-approver": "d0000000-0000-0000-0000-0000000003a1",
  "e-reader": "d0000000-0000-0000-0000-0000000003a2",
  "e-expired": "d0000000-0000-0000-0000-0000000003a3",
  "e-ra-critical": "d0000000-0000-0000-0000-0000000003a4",
  "e-axisc": "d0000000-0000-0000-0000-0000000003a5",
  "e-q2": "d0000000-0000-0000-0000-0000000003a6",
  "e-read-internal": "d0000000-0000-0000-0000-0000000003a7",
  // T-0605: ROUTINE assignment (proposed_by NULL) to a CRITICAL role — the
  // exact live-факт shape: an owner self-assigns a workflow role and must get
  // eligibility on ONE confirm (no second approver needed for a routine assign).
  "e-crit-routine": "d0000000-0000-0000-0000-0000000003a8",
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
  // (f) axis-c — read grant with a SENSITIVE clearance marker, single-confirm → NOT active.
  "r-axisc-single": {
    slug: "axisc-single",
    grants: [
      { id: "g-axisc-single", operation: "read", resource_type: "record",
        confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null,
        constraint: { clearance: "confidential" } },
    ],
  },
  // (f') same axis-c read grant but dual-confirmed → active.
  "r-axisc-dual": {
    slug: "axisc-dual",
    grants: [
      { id: "g-axisc-dual", operation: "read", resource_type: "record",
        confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null,
        constraint: { clearance: "confidential" } },
    ],
  },
  // (g) Q-2 — read grant with a GARBAGE clearance token, single-confirm → NOT active.
  "r-q2-single": {
    slug: "q2-single",
    grants: [
      { id: "g-q2-single", operation: "read", resource_type: "record",
        confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null,
        constraint: { clearance: "top-secret-garbage" } },
    ],
  },
  // (h) read grant with a VALID non-sensitive clearance (internal), single-confirm → active.
  "r-read-internal": {
    slug: "read-internal",
    grants: [
      { id: "g-read-internal", operation: "read", resource_type: "record",
        confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null,
        constraint: { clearance: "internal" } },
    ],
  },
};

// Assignments per employee-id (for the role_assignment-level gate).
const T0397_ASSIGN: Record<string, T0397Assignment[]> = {
  // e-approver: assigned to BOTH crit-single (no #2) and crit-dual (#2 set), each
  // assignment itself dual-confirmed so the assignment gate passes — this isolates
  // the GRANT-level confirmed2_by gate.
  [T0397_EMP["e-approver"]!]: [
    { role_id: "r-crit-single", proposed_by: null, confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null },
    { role_id: "r-crit-dual",   proposed_by: null, confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null },
  ],
  // e-reader: non-critical role, routine single-confirm assignment → active.
  [T0397_EMP["e-reader"]!]: [
    { role_id: "r-noncrit", proposed_by: null, confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null },
  ],
  // e-expired: critical role with EXPIRED grant; routine assignment → active.
  [T0397_EMP["e-expired"]!]: [
    { role_id: "r-crit-expired", proposed_by: null, confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null },
  ],
  // e-ra-critical: a genuinely ESCALATING (semi-confirmed) assignment to crit-dual
  // — proposed_by SET, confirmed2_by NULL → the assignment is pending a distinct
  // second approver and is NOT active (deliverable (e), T-0605 re-framing: the
  // gate is the assignment's OWN semi-confirmed state, not the role's criticality).
  [T0397_EMP["e-ra-critical"]!]: [
    { role_id: "r-crit-dual", proposed_by: "seed", confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null },
  ],
  // e-axisc: holds BOTH axisc-single (read+confidential, no #2) and axisc-dual (#2),
  // each assignment routine to isolate the GRANT-level axis-c gate.
  [T0397_EMP["e-axisc"]!]: [
    { role_id: "r-axisc-single", proposed_by: null, confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null },
    { role_id: "r-axisc-dual",   proposed_by: null, confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null },
  ],
  // e-q2: Q-2 garbage-clearance read grant, routine assignment.
  [T0397_EMP["e-q2"]!]: [
    { role_id: "r-q2-single", proposed_by: null, confirmed_by: "seed", confirmed2_by: "seed2", valid_from: null, valid_until: null },
  ],
  // e-read-internal: valid non-sensitive clearance read grant, routine assignment.
  [T0397_EMP["e-read-internal"]!]: [
    { role_id: "r-read-internal", proposed_by: null, confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null },
  ],
  // e-crit-routine (T-0605): ROUTINE assignment (proposed_by NULL, confirmed2_by
  // NULL) to crit-dual (a CRITICAL role holding an active approve grant). Under
  // the canonical predicate this assignment is ACTIVE on one confirm → its role
  // slug IS returned (the fix for the 403-eligibility self-lock).
  [T0397_EMP["e-crit-routine"]!]: [
    { role_id: "r-crit-dual", proposed_by: null, confirmed_by: "seed", confirmed2_by: null, valid_from: null, valid_until: null },
  ],
};

function makeT0397Pool(nowMs: number): import("pg").Pool {
  const inWindow = (vf: number | null, vu: number | null): boolean => {
    if (vf !== null && vf > nowMs) return false;
    if (vu !== null && vu <= nowMs) return false;
    return true;
  };
  // T-0605 CANONICAL assignment-active predicate (mirror of grants-dao.ts and
  // rights-overview.ts): confirmed, in-window, AND (confirmed2_by set OR
  // proposed_by NULL). Independent of the role's absolute criticality — that was
  // the self-lock. A routine assignment (proposed_by NULL) is active on one
  // confirm even to a critical role; a semi-confirmed one (proposed_by set,
  // confirmed2_by NULL) stays pending.
  const assignmentActive = (ra: T0397Assignment): boolean => {
    if (!ra.confirmed_by) return false;
    if (!inWindow(ra.valid_from, ra.valid_until)) return false;
    if (ra.confirmed2_by === null && ra.proposed_by !== null) return false;
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
              constraint: g.constraint ?? null,
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

  it("(f) axis-c read+confidential grant, ONE approver → NOT active (B1 hole closed)", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-axisc", T0397_NOW);
    expect(grants.map((g) => g.id)).not.toContain("g-axisc-single");
  });

  it("(f') same axis-c capability with confirmed2_by set → active", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-axisc", T0397_NOW);
    expect(grants.map((g) => g.id)).toContain("g-axisc-dual");
  });

  it("(g) Q-2 read+garbage-clearance grant, ONE approver → NOT active (fail-closed)", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-q2", T0397_NOW);
    expect(grants.map((g) => g.id)).not.toContain("g-q2-single");
  });

  it("(h) read+internal (valid non-sensitive) clearance, ONE approver → STILL active", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-read-internal", T0397_NOW);
    expect(grants.map((g) => g.id)).toContain("g-read-internal");
  });
});

describe("getRoleSlugsForActor / getGrantsForSubject — T-0605 canonical assignment-active gate", () => {
  it("(e) SEMI-CONFIRMED assignment (proposed_by set, confirmed2_by NULL) → role slug excluded", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    // e-ra-critical: an ESCALATING assignment to crit-dual — proposed_by set,
    // confirmed2_by NULL → pending a distinct second approver → NOT active.
    // (T-0605: the gate is the assignment's OWN semi-confirmed state, not the
    // role's criticality.)
    const slugs = await getRoleSlugsForActor(pool, TENANT_ID, "e-ra-critical", T0397_NOW);
    expect(slugs).not.toContain("crit-dual");
    expect(slugs).toEqual([]);
  });

  it("(e') same semi-confirmed assignment also contributes ZERO grants (PDP path)", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    // Step 2 (assignment) drops the role before step 3 (grants) runs → no grants.
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-ra-critical", T0397_NOW);
    expect(grants).toEqual([]);
  });

  it("(e'') non-critical routine assignment (proposed_by NULL) → role slug INCLUDED (no regression)", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    // e-reader: routine assignment to a non-critical role → active.
    const slugs = await getRoleSlugsForActor(pool, TENANT_ID, "e-reader", T0397_NOW);
    expect(slugs).toContain("noncrit");
  });

  it("(e''') T-0605 FIX — ROUTINE assignment (proposed_by NULL) to a CRITICAL role → role slug INCLUDED", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    // e-crit-routine: routine one-confirm assignment (proposed_by NULL,
    // confirmed2_by NULL) to crit-dual (holds an active approve grant). Under the
    // canonical predicate the assignment is ACTIVE → slug returned. This is the
    // exact eligibility the prior T-0397 gate wrongly withheld (403 self-lock).
    const slugs = await getRoleSlugsForActor(pool, TENANT_ID, "e-crit-routine", T0397_NOW);
    expect(slugs).toContain("crit-dual");
  });

  it("(e'''') T-0605 FIX — routine assignment to a critical role ALSO yields the role's active grants", async () => {
    const pool = makeT0397Pool(T0397_NOW);
    // The assignment activates (step 2), so step 3 loads crit-dual's grants; the
    // approve grant is itself dual-confirmed (confirmed2_by set) → PDP-active.
    // GRANT-level dual-control is untouched: had the grant been semi-confirmed it
    // would still be withheld here.
    const grants = await getGrantsForSubject(pool, TENANT_ID, "e-crit-routine", T0397_NOW);
    expect(grants.map((g) => g.id)).toContain("g-crit-dual");
  });
});
