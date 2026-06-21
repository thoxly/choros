/**
 * T-0365: [SECURITY] pool-visibility + claim fail-closed for zero-role actor.
 *
 * Invariant: «нет права действия → не видишь задачу; видимость пула = право действия».
 *
 * Before T-0365 the two seams were fail-OPEN:
 *   Seam 1 (inTab/pool): `myRoles.length === 0 ? true : myRoles.includes(item.role)`
 *     — zero-role actor ⇒ sees EVERY pool task.
 *   Seam 2 (claim gate): `myRoles.length > 0 && taskRole !== undefined && !myRoles.includes(taskRole)`
 *     — zero-role actor ⇒ skips the check ⇒ claim allowed (200).
 *
 * After T-0365:
 *   Seam 1: `item.pool === true && myRoles.includes(item.role)`
 *     — zero-role actor ⇒ pool tab is empty.
 *   Seam 2: `taskRole !== undefined && !myRoles.includes(taskRole)`
 *     — zero-role actor (empty roles) ⇒ !includes(taskRole) is true ⇒ 403 NOT_ELIGIBLE.
 *
 * Tests (memory-mode, no DATABASE_URL required):
 *   Z-1: zero-role actor pool tab is empty.
 *   Z-2: zero-role actor claim on a pool task → 403 NOT_ELIGIBLE.
 *   Z-3: correctly-roled actor still sees their pool tasks (no regression).
 *   Z-4: correctly-roled actor still claims their pool task → 200 (no regression).
 *   Z-5: correctly-roled actor cannot claim a pool task for a different role → 403.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";
import { _resetClaimStateForTests } from "../http/inbox.js";

describe("T-0365: inbox pool-visibility + claim fail-closed for zero-role actor", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer(undefined, undefined, "memory");
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => _resetClaimStateForTests());

  function request(
    method: string,
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(url, { method, headers }, (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString()));
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: buf }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  type Item = { id: string; role: string; pool?: boolean };
  type InboxResp = { items: Item[]; counts: Record<string, number>; tab: string };

  // Z-1: zero-role actor (not in USER_ROLES fixture) — pool tab must be empty.
  it("Z-1: zero-role actor sees an empty pool tab", async () => {
    // "e-unknown" is not in USER_ROLES → resolveRolesForActor returns [] in memory mode.
    const r = await request("GET", "/api/inbox?tab=pool", { "x-dev-user": "e-unknown" });
    expect(r.statusCode).toBe(200);
    const data = JSON.parse(r.body) as InboxResp;
    expect(data.items.length).toBe(0);
    expect(data.counts.pool).toBe(0);
  });

  // Z-2: zero-role actor claim on a pool task addressed to a role → 403 NOT_ELIGIBLE.
  it("Z-2: zero-role actor claim on pool task → 403 NOT_ELIGIBLE", async () => {
    // t3 is pool:true, role:"fin-ctrl"; e-unknown holds no roles.
    const r = await request("POST", "/api/inbox/t3/claim", { "x-dev-user": "e-unknown" });
    expect(r.statusCode).toBe(403);
    const body = JSON.parse(r.body) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_ELIGIBLE");
  });

  // Z-3: correctly-roled actor still sees pool tasks for their role (no regression).
  it("Z-3: roled actor (e-sokolov/fin-ctrl) still sees fin-ctrl pool tasks", async () => {
    // e-sokolov holds fin-ctrl → should see t3, t9, t11 (pool:true, role:fin-ctrl).
    const r = await request("GET", "/api/inbox?tab=pool", { "x-dev-user": "e-sokolov" });
    expect(r.statusCode).toBe(200);
    const data = JSON.parse(r.body) as InboxResp;
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) {
      expect(item.pool).toBe(true);
      expect(item.role).toBe("fin-ctrl");
    }
    expect(data.items.some((i) => i.id === "t3")).toBe(true);
  });

  // Z-4: correctly-roled actor claim on matching pool task → 200 (no regression).
  it("Z-4: roled actor (e-sokolov/fin-ctrl) claim on fin-ctrl pool task → 200", async () => {
    // t3 is pool:true, role:fin-ctrl; e-sokolov holds fin-ctrl.
    const r = await request("POST", "/api/inbox/t3/claim", { "x-dev-user": "e-sokolov" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { item: { id: string } };
    expect(body.item.id).toBe("t3");
  });

  // Z-5: correctly-roled actor cannot claim a pool task for a DIFFERENT role → 403.
  it("Z-5: roled actor (e-sokolov/fin-ctrl) claim on cs-l2 pool task → 403 NOT_ELIGIBLE", async () => {
    // t6 is pool:true, role:cs-l2; e-sokolov holds fin-ctrl only.
    const r = await request("POST", "/api/inbox/t6/claim", { "x-dev-user": "e-sokolov" });
    expect(r.statusCode).toBe(403);
    const body = JSON.parse(r.body) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_ELIGIBLE");
  });
});
