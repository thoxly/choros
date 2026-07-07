/**
 * T-0662 [security/системный анти-рецидив, столп 4] — unit tests for the single
 * NAMED deactivation predicate (src/db/actor-authority-gate.ts) and proof that it
 * reaches the runtime SQL of an authority actor-resolver.
 *
 * Pure unit — no live Postgres. A fake pg.Pool captures the SQL that
 * getGrantsForSubject (authority resolver A) issues, so we can assert:
 *   - the canonical marker literal is exactly "deactivated_at IS NULL" (INV-4),
 *   - the step-1 actor slug→employee lookup carries that predicate at RUNTIME
 *     (not just in the source) — i.e. the named constant is load-bearing,
 *   - an ACTIVE actor still resolves to their grants (happy-path unbroken),
 *   - a resolver that returns zero employee rows (the deactivated / unknown case)
 *     yields [] grants (fail-closed shape).
 *
 * The DISPLAY invariant (INV-1: resolving a deactivated actor's NAME must NOT be
 * gated) is enforced structurally by ci/checks/actor-authority-deactivation-gate.sh
 * (it inspects ONLY the registered authority resolvers, never the display/identity
 * paths humanEmployeeSlugExistsOnClient / findEmployeeById / actor-resolver.ts) —
 * see that gate's --self-test. This file proves the authority SIDE.
 */

import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import { ACTOR_ACTIVE_SQL } from "../db/actor-authority-gate.js";
import { getGrantsForSubject } from "../db/grants-dao.js";

// ---------------------------------------------------------------------------
// A fake pool that RECORDS every SQL string it is asked to run, and models the
// employee slug→id lookup + a minimal empty grant path.
// ---------------------------------------------------------------------------
function makeRecordingPool(opts: {
  employees: Record<string, string>; // slug → id (only ACTIVE employees appear here)
}): { pool: import("pg").Pool; captured: string[] } {
  const captured: string[] = [];
  const fakeClient = {
    query: async (text: string, values?: unknown[]) => {
      const sql = typeof text === "object" ? (text as { text: string }).text : text;
      captured.push(sql);
      const params = values ?? [];
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [] };
      if (/^\s*SET LOCAL/i.test(sql)) return { rows: [] };
      // Step 1: actor slug → employee id. The fake mirrors the DB's deactivation
      // gate by only KNOWING active employees — a deactivated/unknown slug is
      // simply absent from the map, so it returns zero rows (fail-closed shape).
      if (/FROM choros\.employee/i.test(sql)) {
        const slug = params[1] as string;
        const id = opts.employees[slug];
        return { rows: id ? [{ id }] : [] };
      }
      // Steps 2-3: role assignments / grants — empty for these tests.
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => fakeClient } as unknown as import("pg").Pool;
  return { pool, captured };
}

describe("T-0662 · ACTOR_ACTIVE_SQL — the single named deactivation predicate", () => {
  it("is exactly the canonical literal 'deactivated_at IS NULL' (INV-4)", () => {
    // The fitness gate ci/checks/actor-authority-deactivation-gate.sh greps for
    // this exact literal — rewording it (without updating the gate) would silently
    // break the anti-recurrence guard.
    expect(ACTOR_ACTIVE_SQL).toBe("deactivated_at IS NULL");
  });

  it("is a bare-column predicate that composes into a WHERE list without breaking SQL", () => {
    const where = `WHERE tenant_id = $1 AND slug = $2 AND ${ACTOR_ACTIVE_SQL} LIMIT 1`;
    expect(where).toContain("deactivated_at IS NULL");
    // no leading/trailing AND baked into the constant (caller supplies the AND)
    expect(ACTOR_ACTIVE_SQL.trim()).toBe(ACTOR_ACTIVE_SQL);
    expect(ACTOR_ACTIVE_SQL.startsWith("AND")).toBe(false);
  });
});

describe("T-0662 · authority resolver A (getGrantsForSubject) carries the predicate at RUNTIME", () => {
  it("the step-1 actor slug lookup embeds the deactivation predicate", async () => {
    const { pool, captured } = makeRecordingPool({ employees: { "e-active": "id-active" } });
    await getGrantsForSubject(pool, "11111111-1111-1111-1111-111111111111", "e-active", Date.now());
    const step1 = captured.find((s) => /FROM choros\.employee/i.test(s));
    expect(step1, "getGrantsForSubject must issue an employee slug lookup").toBeTruthy();
    // The named constant is LOAD-BEARING: the interpolated value reaches the SQL.
    expect(step1!).toMatch(/deactivated_at IS NULL/);
    expect(step1!).toMatch(/slug\s*=\s*\$2/);
  });

  it("an ACTIVE actor resolves through step 1 (happy-path unbroken; INV-3 no over-block)", async () => {
    const { pool, captured } = makeRecordingPool({ employees: { "e-active": "id-active" } });
    const grants = await getGrantsForSubject(pool, "11111111-1111-1111-1111-111111111111", "e-active", Date.now());
    // No role assignments seeded → [] grants, but the resolve REACHED the grant
    // path (proven by role_assignment being queried after the employee lookup).
    expect(Array.isArray(grants)).toBe(true);
    const idxEmp = captured.findIndex((s) => /FROM choros\.employee/i.test(s));
    const idxAfter = captured.findIndex((s, i) => i > idxEmp && /role_assignment|"grant"/i.test(s));
    expect(idxEmp).toBeGreaterThanOrEqual(0);
    expect(idxAfter, "an active actor must proceed past step 1 into the grant path").toBeGreaterThan(idxEmp);
  });

  it("a deactivated/unknown actor (zero employee rows) → [] grants, fail-closed", async () => {
    // The fake, like the gated DB, does not KNOW a deactivated slug → zero rows.
    const { pool } = makeRecordingPool({ employees: { "e-active": "id-active" } });
    const grants = await getGrantsForSubject(pool, "11111111-1111-1111-1111-111111111111", "e-deactivated", Date.now());
    expect(grants).toEqual([]);
  });
});
