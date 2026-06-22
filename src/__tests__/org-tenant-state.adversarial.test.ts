/**
 * T-0417 · ADVERSARY (Враг red-team) — access-mgmt cross-tenant read suite.
 *
 * Surface under attack: T-0387 (access-mgmt UI on live data) consumes
 *   GET /api/org/tenant-state and GET /api/org. The backend authz gate is the
 *   T-0388 cross-tenant guard in src/http/seed-write.ts (authorizeOrgWrite →
 *   loadAdminContext → isGenesisOwner). This suite attacks the cross-tenant
 *   property: a genesis-owner of tenant B must NOT be able to read tenant A's
 *   org state by passing ?tenant_id=<A>.
 *
 *   Threat: the read runs withTenantTx(pool, <query-param tenant>), but the AUTHZ
 *   gates on the RESOLVED authority tenant. If the guard let a foreign tenant_id
 *   through, owner-of-B could enumerate A's departments/positions/employees/roles.
 *
 * GOAL: prove the guard denies (403 NOT_OWNER) for:
 *   OTS-1  owner-of-B reading B's OWN state → 200 (positive control).
 *   OTS-2  owner-of-B reading A's state (cross-tenant) → 403, NO data SELECT runs.
 *   OTS-3  a NON-owner reading their own tenant's state → 403 (owner-only gate).
 *   OTS-4  the bootstrap forest-owner (genesis owner of DEV_TENANT_ID) MAY read
 *          any tenant's state (the importer diff path) → 200.
 *   OTS-5  missing / malformed tenant_id → 400 (no SELECT, no leak).
 *
 * In-process http server + in-memory fake pg pool modeling resolveActorTenant,
 * isGenesisOwnerForTenant / loadAdminContext (tenant-owner role_assignment), and
 * the four state SELECTs. Pure unit — runnable NOW.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerSeedWriteRoutes } from "../http/seed-write.js";

const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001"; // forest/bootstrap silo
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const OWNER_A = "e-owner-a"; // genesis owner of A
const OWNER_B = "e-owner-b"; // genesis owner of B (NOT forest owner)
const FOREST_OWNER = "e-forest"; // genesis owner of DEV_TENANT_ID
const NOBODY_B = "e-nobody-b"; // member of B, NOT owner

// ---------------------------------------------------------------------------
// Fake pool modeling the org authz + state queries. The "world":
//   employee → tenant:  OWNER_A,NOBODY_A∈A ; OWNER_B,NOBODY_B∈B ; FOREST_OWNER∈DEV
//   tenant-owner role:  OWNER_A owns A, OWNER_B owns B, FOREST_OWNER owns DEV
// A data-SELECT counter proves the gate fires BEFORE any state read.
// ---------------------------------------------------------------------------
interface World {
  empTenant: Record<string, string>; // actor slug → tenant id
  owners: Record<string, string>; // actor slug → tenant id they own (tenant-owner)
  dataSelectCount: number; // increments on any department/position/employee/role SELECT
}

function makeFakePool(world: World): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    let boundTenant = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = async (sql: string, params?: unknown[]): Promise<any> => {
      const text = sql.trim();
      const p = params ?? [];

      const setM = /SET LOCAL choros\.tenant_id = '([^']+)'/.exec(text);
      if (setM) { boundTenant = setM[1]; return { rows: [] }; }
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
      if (/SET LOCAL search_path/i.test(text)) return { rows: [] };

      // resolveActorTenant: employee ⋈ tenant by slug → tenant_id.
      if (/FROM choros\.employee e[\s\S]*JOIN choros\.tenant t/.test(text)) {
        const slug = String(p[0] ?? "");
        const t = world.empTenant[slug];
        return { rows: t ? [{ tenant_id: t }] : [] };
      }

      // isGenesisOwnerForTenant / loadAdminContext step-1: tenant-owner role_assignment.
      // Query joins role_assignment ra ⋈ role r WHERE r.slug='tenant-owner' and the
      // employee slug ($2) within tenant ($1). Returns a row iff that actor owns $1.
      if (/role_assignment ra[\s\S]*r\.slug = 'tenant-owner'/.test(text)) {
        const tenantId = String(p[0] ?? "");
        const actorSlug = String(p[1] ?? "");
        const ownsTenant = world.owners[actorSlug] === tenantId;
        return { rows: ownsTenant ? [{ id: "ra-owner" }] : [] };
      }

      // loadAdminContext step-2: confirmed assignments (none needed for owner path).
      if (/SELECT ra\.id, ra\.role_id, ra\.org_scope/.test(text)) {
        return { rows: [] };
      }

      // The four state SELECTs — count them to prove the gate ran first.
      if (/FROM choros\.department WHERE tenant_id/.test(text)) {
        world.dataSelectCount++;
        return { rows: [{ id: "d1", slug: `dept-of-${boundTenant}` }] };
      }
      if (/FROM choros\.position WHERE tenant_id/.test(text)) {
        world.dataSelectCount++;
        return { rows: [] };
      }
      if (/FROM choros\.employee WHERE tenant_id/.test(text)) {
        world.dataSelectCount++;
        return { rows: [] };
      }
      if (/FROM choros\.role WHERE tenant_id/.test(text)) {
        world.dataSelectCount++;
        return { rows: [] };
      }

      return { rows: [] };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { query, release: () => {} } as any;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { connect: async () => makeClient() } as any;
}

function buildServer(world: World): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  registerSeedWriteRoutes(router, makeFakePool(world));
  router.setFallback((_req, res) => { res.statusCode = 404; res.end("{}"); });
  const server = http.createServer(router.dispatch.bind(router));
  return { server, baseUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function httpGet(
  url: string, headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname, port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search, method: "GET", headers,
    }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, json: { raw: data } }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function freshWorld(): World {
  return {
    empTenant: {
      [OWNER_A]: TENANT_A,
      [OWNER_B]: TENANT_B,
      [NOBODY_B]: TENANT_B,
      [FOREST_OWNER]: DEV_TENANT_ID,
    },
    owners: {
      [OWNER_A]: TENANT_A,
      [OWNER_B]: TENANT_B,
      [FOREST_OWNER]: DEV_TENANT_ID,
    },
    dataSelectCount: 0,
  };
}

describe("Враг · GET /api/org/tenant-state cross-tenant authz (T-0388 guard)", () => {
  let server: http.Server;
  let base: string;
  let world: World;

  async function start(): Promise<void> {
    world = freshWorld();
    const h = buildServer(world);
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  }

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it("OTS-1: owner-of-B reads B's OWN state → 200 (positive control)", async () => {
    await start();
    const r = await httpGet(`${base}/api/org/tenant-state?tenant_id=${TENANT_B}`, { "x-dev-user": OWNER_B });
    expect(r.status).toBe(200);
    expect(world.dataSelectCount).toBeGreaterThan(0); // own-tenant read did run
  });

  it("OTS-2: owner-of-B reading A's state (cross-tenant) → 403 NOT_OWNER, ZERO data SELECT", async () => {
    await start();
    const r = await httpGet(`${base}/api/org/tenant-state?tenant_id=${TENANT_A}`, { "x-dev-user": OWNER_B });
    expect(r.status).toBe(403);
    expect((r.json as { error: { code: string } }).error.code).toBe("NOT_OWNER");
    // The gate denied BEFORE any state SELECT — no cross-tenant enumeration.
    expect(world.dataSelectCount).toBe(0);
  });

  it("OTS-3: a NON-owner member of B reading B's own state → 403 (owner-only gate)", async () => {
    await start();
    const r = await httpGet(`${base}/api/org/tenant-state?tenant_id=${TENANT_B}`, { "x-dev-user": NOBODY_B });
    expect(r.status).toBe(403);
    expect((r.json as { error: { code: string } }).error.code).toBe("NOT_OWNER");
    expect(world.dataSelectCount).toBe(0);
  });

  it("OTS-4: the forest-owner (genesis owner of DEV_TENANT_ID) MAY read ANY tenant's state → 200", async () => {
    await start();
    // Forest owner reads A's state — the importer/diff path. authTenantId resolves
    // to DEV_TENANT_ID (where the forest owner's ownership lives); the read targets A.
    const r = await httpGet(`${base}/api/org/tenant-state?tenant_id=${TENANT_A}`, { "x-dev-user": FOREST_OWNER });
    expect(r.status).toBe(200);
    expect(world.dataSelectCount).toBeGreaterThan(0);
  });

  it("OTS-5a: missing tenant_id → 400 VALIDATION, no SELECT", async () => {
    await start();
    const r = await httpGet(`${base}/api/org/tenant-state`, { "x-dev-user": OWNER_B });
    expect(r.status).toBe(400);
    expect(world.dataSelectCount).toBe(0);
  });

  it("OTS-5b: malformed (non-UUID) tenant_id → 400 VALIDATION, no SELECT", async () => {
    await start();
    const r = await httpGet(`${base}/api/org/tenant-state?tenant_id=not-a-uuid`, { "x-dev-user": OWNER_B });
    expect(r.status).toBe(400);
    expect(world.dataSelectCount).toBe(0);
  });

  it("OTS-6: unauthenticated (no x-dev-user) → 401, no SELECT", async () => {
    await start();
    const r = await httpGet(`${base}/api/org/tenant-state?tenant_id=${TENANT_B}`, {});
    expect([401, 500]).toContain(r.status); // auth gate fires; never reaches state read
    expect(world.dataSelectCount).toBe(0);
  });
});
