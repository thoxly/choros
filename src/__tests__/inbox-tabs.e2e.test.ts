/**
 * T-0093: E2E tests for the Inbox task API — tabs, filters, role-addressing,
 * and tenant isolation.
 *
 * Covers the four tabs (Все / Мне / Из пула / Эскалации) computed SERVER-SIDE,
 * the executor-type + SLA-sort filters, the claim-from-pool role invariant, and
 * cross-tenant isolation (a task addressed to a role in tenant A must not appear
 * for an actor in tenant B).
 *
 * Deterministic — uses the in-memory store, no live Postgres required.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";
import { _resetClaimStateForTests } from "../http/inbox.js";

describe("Inbox tabs/filters/role-addressing E2E (T-0093)", () => {
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

  type Item = {
    id: string;
    role: string;
    pool?: boolean;
    mine?: boolean;
    escalated?: boolean;
    status: string;
    execType?: string;
    sla: { min: number; left: number };
  };
  type Resp = { items: Item[]; counts: Record<string, number>; tab: string };

  async function getInbox(query = "", user?: string): Promise<Resp> {
    const headers = user ? { "x-dev-user": user } : undefined;
    const r = await request("GET", `/api/inbox${query}`, headers);
    expect(r.statusCode).toBe(200);
    return JSON.parse(r.body) as Resp;
  }

  // ---- Role-addressing: every task carries a role ----

  it("every task is addressed to a role (role field present)", async () => {
    const data = await getInbox();
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) {
      expect(typeof item.role).toBe("string");
      expect(item.role.length).toBeGreaterThan(0);
    }
  });

  // ---- Tab: Все ----

  it("tab=all returns every tenant-scoped task and matches counts.all", async () => {
    const data = await getInbox("?tab=all");
    expect(data.tab).toBe("all");
    expect(data.items.length).toBe(data.counts.all);
    // 12 dev-tenant seed tasks (the foreign-tenant x1 is excluded by isolation).
    expect(data.items.length).toBe(12);
  });

  it("counts object is present with all four tabs", async () => {
    const data = await getInbox("", "e-kravtsova");
    for (const k of ["all", "mine", "pool", "esc"]) {
      expect(typeof data.counts[k]).toBe("number");
    }
  });

  // ---- Tab: Мне ----

  it("tab=mine returns only tasks assigned to / claimed by the actor", async () => {
    // e-kravtsova = А. Кравцова, assigned to t2 (execType human, execName matches).
    const data = await getInbox("?tab=mine", "e-kravtsova");
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    for (const item of data.items) expect(item.mine).toBe(true);
    expect(data.items.some((i) => i.id === "t2")).toBe(true);
  });

  it("tab=mine is empty for an anonymous actor (no header)", async () => {
    const data = await getInbox("?tab=mine");
    expect(data.items.length).toBe(0);
  });

  // ---- Tab: Из пула (role-addressed claim eligibility) ----

  it("tab=pool returns only UNCLAIMED tasks addressed to a role the actor holds", async () => {
    // e-kravtsova holds fin-ctrl → sees pooled fin-ctrl tasks (t3, t9, t11),
    // but NOT the pooled cs-l2 escalation t6 (different role).
    const data = await getInbox("?tab=pool", "e-kravtsova");
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    for (const item of data.items) {
      expect(item.pool).toBe(true);
      expect(item.role).toBe("fin-ctrl");
    }
    expect(data.items.some((i) => i.id === "t6")).toBe(false);
  });

  // T-0336 (E15-S2): tab=pool after claim — in no-DB mode the claim-state is NOT
  // persisted (audit_event projection requires live Postgres), so the task remains
  // in the pool. DB-mode: task moves out of pool once claimed (ci/checks/db/).
  it("tab=pool claim returns 200 (no-DB: task remains in pool without audit persistence)", async () => {
    const before = await getInbox("?tab=pool", "e-kravtsova");
    const poolId = before.items[0]!.id;
    const claim = await request("POST", `/api/inbox/${poolId}/claim`, { "x-dev-user": "e-kravtsova" });
    expect(claim.statusCode).toBe(200);
    // no-DB: claim-state not persisted → task still appears in pool (T-0336)
    const after = await getInbox("?tab=pool", "e-kravtsova");
    expect(after.items.some((i) => i.id === poolId)).toBe(true);
  });

  // ---- Tab: Эскалации ----

  it("tab=esc returns escalated/failed tasks only", async () => {
    const data = await getInbox("?tab=esc", "e-kravtsova");
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    for (const item of data.items) {
      expect(item.escalated === true || item.status === "failed").toBe(true);
    }
    // t6 (failed escalation) and t7 (escalated) are in this tab.
    expect(data.items.some((i) => i.id === "t6")).toBe(true);
    expect(data.items.some((i) => i.id === "t7")).toBe(true);
  });

  // ---- Filters: executor type + SLA sort ----

  it("exec filter narrows to one executor type", async () => {
    const data = await getInbox("?exec=agent");
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) expect(item.execType).toBe("agent");
  });

  it("sort=sla orders by SLA headroom ascending (most urgent first)", async () => {
    const data = await getInbox("?sort=sla");
    for (let i = 1; i < data.items.length; i++) {
      expect(data.items[i]!.sla.left).toBeGreaterThanOrEqual(data.items[i - 1]!.sla.left);
    }
  });

  // ---- Claim-from-pool role invariant ----

  it("claiming a pool task whose role the actor does NOT hold → 403 NOT_ELIGIBLE", async () => {
    // t6 is a pooled cs-l2 escalation; e-kravtsova holds fin-ctrl, not cs-l2.
    const r = await request("POST", "/api/inbox/t6/claim", { "x-dev-user": "e-kravtsova" });
    expect(r.statusCode).toBe(403);
    expect((JSON.parse(r.body).error as { code: string }).code).toBe("NOT_ELIGIBLE");
  });

  // T-0336 (E15-S2): claim for eligible actor returns 200 + item.
  // In no-DB mode, mine:true is NOT set (no claim-state persistence).
  // DB-mode: mine:true surfaced from audit projection (ci/checks/db/).
  it("claiming a pool task whose role the actor holds → 200", async () => {
    // e-petrov holds cs-l2 → may claim t6.
    const r = await request("POST", "/api/inbox/t6/claim", { "x-dev-user": "e-petrov" });
    expect(r.statusCode).toBe(200);
    // no-DB: mine is not set from claim-state (T-0336 — requires audit persistence)
    expect((JSON.parse(r.body).item as Item).id).toBe("t6");
  });

  // ---- Tenant isolation ----

  it("a foreign-tenant task (x1) never appears for the dev-tenant actor", async () => {
    const data = await getInbox("?tab=all", "e-kravtsova");
    expect(data.items.some((i) => i.id === "x1")).toBe(false);
  });

  it("claiming a foreign-tenant task by a dev-tenant actor → 404 (not visible)", async () => {
    const r = await request("POST", "/api/inbox/x1/claim", { "x-dev-user": "e-kravtsova" });
    expect(r.statusCode).toBe(404);
  });

  // ---- R-2: internal `tenant` field must NOT leak on the wire ----

  it("R-2: GET /api/inbox items do NOT expose the internal tenant field", async () => {
    const data = await getInbox("?tab=all", "e-kravtsova");
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) {
      expect(item).not.toHaveProperty("tenant");
    }
  });

  it("R-2: claim response item does NOT expose the internal tenant field", async () => {
    // e-petrov holds cs-l2 → may claim t6 (pooled cs-l2 escalation)
    const r = await request("POST", "/api/inbox/t6/claim", { "x-dev-user": "e-petrov" });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { item: Record<string, unknown> };
    expect(body.item).not.toHaveProperty("tenant");
  });
});
