/**
 * src/__tests__/rights-intents.substitution-coverage.authz.test.ts — T-0751 [SECURITY]
 *
 * Covers GET /api/rights/intents/substitution-coverage (registerSubstitutionCoverage,
 * T-0745), the pre-submit READ backing the SubstituteForm/SelfAbsenceForm
 * "stand-in does not hold the role" warning banner. `ci/checks/actor-active-
 * route-coverage.sh` (T-0726, FF-726-1) flagged this route as a live finding:
 * it resolved the caller via extractActor/resolveTenant ONLY (display-only
 * identity mapping, T-0662 doctrine — deliberately NOT deactivation-gated),
 * never checking whether the CALLER's own employee row is active. A
 * deactivated actor's still-live (~300s residual, offline-JWKS) JWT could
 * therefore query ANY (role_id, substitute_employee_id) pair and receive a
 * role-membership oracle (provides_coverage boolean + holder_count).
 *
 * Fix: resolveActiveActorEmployeeId (rights-intents.ts) resolves the caller's
 * slug → employee id filtered by `deactivated_at IS NULL`, called BEFORE the
 * holder-set read; a deactivated caller resolves to null → 404
 * NOT_FOUND, mirroring registerSelfAbsence's own denial shape exactly (T-0658
 * FIX-1's sibling test, rights-intents.self-absence.authz.test.ts).
 *
 * Proofs (full route through a scripted stub pool — dev auth, x-dev-user; no DB):
 *   (c1) active caller, nominee HOLDS the role → 200, provides_coverage:true,
 *        holder_count reflects the seeded pool.
 *   (c2) active caller, nominee does NOT hold the role → 200,
 *        provides_coverage:false.
 *   (c3) CRITICAL: deactivated caller → 404 NOT_FOUND, and the holder-set
 *        query is NEVER issued (fail-closed BEFORE the coverage read).
 *   (c4) 400 VALIDATION when role_id/substitute_employee_id is missing (guard
 *        unaffected by the new gate — still runs after the actor-active check
 *        would have passed for a well-formed active caller).
 *
 * No real DB: a scripted in-memory stub pg.Pool replays the queries the route
 * issues (actor-active lookup, role_assignment holder-set). Queries are
 * captured so (c3) can assert the holder-set read never ran.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerRightsIntentRoutes } from "../http/rights-intents.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTOR_SLUG = "alice";
const ACTOR_EMP_ID = "cccccccc-1000-0000-0000-000000000001";
const ROLE_ID = "e0000000-1000-0000-0000-000000000002";
const HOLDER_EMP_ID = "cccccccc-1000-0000-0000-000000000002";
const NONHOLDER_EMP_ID = "cccccccc-1000-0000-0000-000000000003";

// ---------------------------------------------------------------------------
// Scripted stub pg.Pool.
// ---------------------------------------------------------------------------

function makeStubPool(opts: {
  /** true iff the CALLING actor's own employee row is active (deactivated_at IS NULL). */
  actorActive: boolean;
  /** employee ids returned by the role's confirmed, in-window holder-set query. */
  holders: string[];
  /** sink for every query the route issues (for "never reached the read" assertions). */
  captured: string[];
}): pg.Pool {
  const holders = opts.holders;

  const client = {
    query: async (text: string) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };
      opts.captured.push(text);

      // --- resolveActiveActorEmployeeId: caller's own slug → employee id,
      //     filtered by ACTOR_ACTIVE_SQL. Distinguished by "slug = $2" WITHOUT
      //     a role_id/role_assignment join (a bare employee lookup). ---
      if (
        text.includes("SELECT id FROM choros.employee") &&
        text.includes("slug = $2")
      ) {
        return {
          rows: opts.actorActive ? [{ id: ACTOR_EMP_ID }] : [],
          rowCount: opts.actorActive ? 1 : 0,
        };
      }

      // --- holder-set read: role_assignment WHERE role_id = $2 AND
      //     confirmed_by IS NOT NULL (SELECTs employee_id, but has NO
      //     employee_id FILTER — the coverage route's own shape, distinct
      //     from substitute/self-absence's tier probes which always filter
      //     WHERE ... employee_id = / <> something). ---
      if (
        text.includes("FROM choros.role_assignment") &&
        text.includes("confirmed_by IS NOT NULL") &&
        !text.includes("employee_id <>") &&
        !text.includes("employee_id = $3")
      ) {
        return {
          rows: holders.map((employee_id) => ({ employee_id })),
          rowCount: holders.length,
        };
      }

      // Everything else (BEGIN / SET LOCAL / COMMIT / ROLLBACK) is a no-op.
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
// Tiny HTTP harness (mirrors rights-intents.self-absence.authz.test.ts).
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

function get(
  port: number,
  path: string,
  actor = ACTOR_SLUG,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { "x-dev-user": actor },
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
    req.end();
  });
}

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

function ranHolderSetQuery(captured: string[]): boolean {
  return captured.some(
    (q) =>
      q.includes("FROM choros.role_assignment") &&
      q.includes("confirmed_by IS NOT NULL") &&
      !q.includes("employee_id <>") &&
      !q.includes("employee_id = $3"),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-0751 (c) — substitution-coverage ACTOR_ACTIVE gate (route-coverage finding closed)", () => {
  it("(c1) active caller, nominee HOLDS the role → 200 provides_coverage:true", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({ actorActive: true, holders: [HOLDER_EMP_ID], captured }),
    );
    try {
      const resp = await get(
        port,
        `/api/rights/intents/substitution-coverage?role_id=${ROLE_ID}&substitute_employee_id=${HOLDER_EMP_ID}`,
      );
      expect(resp.status, JSON.stringify(resp.body)).toBe(200);
      const b = resp.body as { provides_coverage?: boolean; holder_count?: number };
      expect(b.provides_coverage).toBe(true);
      expect(b.holder_count).toBe(1);
      expect(ranHolderSetQuery(captured)).toBe(true);
    } finally {
      await close();
    }
  });

  it("(c2) active caller, nominee does NOT hold the role → 200 provides_coverage:false", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({ actorActive: true, holders: [HOLDER_EMP_ID], captured }),
    );
    try {
      const resp = await get(
        port,
        `/api/rights/intents/substitution-coverage?role_id=${ROLE_ID}&substitute_employee_id=${NONHOLDER_EMP_ID}`,
      );
      expect(resp.status, JSON.stringify(resp.body)).toBe(200);
      const b = resp.body as { provides_coverage?: boolean; holder_count?: number };
      expect(b.provides_coverage).toBe(false);
      expect(b.holder_count).toBe(1);
    } finally {
      await close();
    }
  });

  it("(c3) CRITICAL: deactivated caller → 404 NOT_FOUND, holder-set read NEVER issued", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({ actorActive: false, holders: [HOLDER_EMP_ID], captured }),
    );
    try {
      const resp = await get(
        port,
        `/api/rights/intents/substitution-coverage?role_id=${ROLE_ID}&substitute_employee_id=${HOLDER_EMP_ID}`,
      );
      expect(resp.status, JSON.stringify(resp.body)).toBe(404);
      expect(errCode(resp.body)).toBe("NOT_FOUND");
      const b = resp.body as { provides_coverage?: unknown; holder_count?: unknown };
      expect(b.provides_coverage).toBeUndefined();
      expect(b.holder_count).toBeUndefined();
      // Fail-closed BEFORE any coverage read: the holder-set query must never
      // have been issued (mutation-verified: without the gate this would run).
      expect(ranHolderSetQuery(captured)).toBe(false);
    } finally {
      await close();
    }
  });

  it("(c4) 400 VALIDATION when role_id is missing (unaffected by the actor-active gate)", async () => {
    const captured: string[] = [];
    const { port, close } = await startTestServer(
      makeStubPool({ actorActive: true, holders: [], captured }),
    );
    try {
      const resp = await get(
        port,
        `/api/rights/intents/substitution-coverage?substitute_employee_id=${HOLDER_EMP_ID}`,
      );
      expect(resp.status).toBe(400);
      expect(errCode(resp.body)).toBe("VALIDATION");
    } finally {
      await close();
    }
  });
});
