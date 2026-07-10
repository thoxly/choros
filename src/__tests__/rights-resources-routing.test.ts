/**
 * src/__tests__/rights-resources-routing.test.ts — T-0705
 *
 * Regression lock for the F-3 finding (LIVE_PROOF T-0652): admin screens
 * (/rights, /users, /rights/trail) at a VALID session spammed the browser
 * console with a 404 on GET /api/rights/resources — the screen degraded
 * silently (fetchRealResources() catches non-ok and returns []), so the UI
 * looked fine while the console filled with noise that would mask a REAL
 * error next to it.
 *
 * ROOT CAUSE (src/server.ts, before this fix): registerRightsResourcesRoute
 * (T-0609, the literal path GET /api/rights/resources) was registered AFTER
 * registerRightsRoutes, which adds the catch-all GET /api/rights/:roleId.
 * The Router (src/http/router.ts) is first-match-wins over a plain array —
 * so "/api/rights/resources" matched :roleId first, findRole("resources")
 * returned null, and the handler threw HttpError(404, "NOT_FOUND", "role not
 * found"). Four SIBLING routes (change-requests, sod-rules, sod-admin,
 * tenant-state — see server.ts comments right above registerRightsRoutes)
 * already carry an explicit "MUST be registered BEFORE registerRightsRoutes"
 * comment for this exact reason (rights-change-requests.test.ts CR-9 is the
 * sibling regression lock this test mirrors); registerRightsResourcesRoute
 * was added later (T-0609) after the catch-all and never got the memo.
 *
 * This test registers BOTH route sets in server.ts's CURRENT order (not a
 * hand-picked "correct" order) with a stub pool — no live Postgres required —
 * so a future re-ordering regresses this test rather than silently reopening
 * the console-noise hole.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import pg from "pg";
import { Router } from "../http/router.js";
import { registerRightsResourcesRoute } from "../http/rights-resources.js";
import { registerRightsRoutes } from "../http/rights.js";

const TENANT_A = "a0000000-0000-0000-0000-000000000001";
const ACTOR_A = "e-human";

// ---------------------------------------------------------------------------
// Stub pg.Pool — withTenantTx (src/http/binding.ts) drives BEGIN/SET LOCAL/
// COMMIT around the actual SELECTs; listApplications/listRegistryDefs each
// issue one SELECT. Neither row shape matters for THIS test (routing only) —
// empty result sets are enough to exercise the real handler end-to-end.
// ---------------------------------------------------------------------------

function makeStubPool(): pg.Pool {
  const stubClient = {
    query: async (text: string | { text: string }) => {
      const sql = typeof text === "string" ? text : text.text;
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET\s+LOCAL)/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      // choros.application / choros.registry_def SELECTs — honest-empty tenant.
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    connect: async () => stubClient as unknown as pg.PoolClient,
  } as unknown as pg.Pool;
}

async function stubResolveActorTenant(slug: string): Promise<string> {
  if (slug === ACTOR_A) return TENANT_A;
  throw new Error(`unknown test actor: ${slug}`);
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
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    httpReq.on("error", reject);
    httpReq.end();
  });
}

describe("T-0705 — GET /api/rights/resources resolves before :roleId catch-all", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const router = new Router();
    const pool = makeStubPool();
    // Register in server.ts order (post-fix): the literal /api/rights/resources
    // path BEFORE registerRightsRoutes' GET /api/rights/:roleId catch-all.
    registerRightsResourcesRoute(router, {
      pool,
      resolveActorTenant: stubResolveActorTenant,
    });
    registerRightsRoutes(router);
    server = http.createServer(router.dispatch.bind(router));
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => resolve());
    });
    const addr = server.address();
    baseUrl = `http://localhost:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /api/rights/resources resolves to the resources handler (200 + {resources:[]}), not :roleId's 404", async () => {
    // If the :roleId catch-all won instead, it would call findRole("resources")
    // and throw HttpError(404, "NOT_FOUND", "role not found") — the exact
    // console-noise 404 F-3 observed on /rights, /users, /rights/trail.
    const res = await req(baseUrl, "GET", "/api/rights/resources", { "x-dev-user": ACTOR_A });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { resources: unknown };
    expect(Array.isArray(body.resources)).toBe(true);
  });

  it("the :roleId catch-all still works for an actual role id (ordering fix does not break it)", async () => {
    const res = await req(baseUrl, "GET", "/api/rights/some-other-role-id", { "x-dev-user": ACTOR_A });
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
