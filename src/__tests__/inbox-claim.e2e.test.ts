/**
 * T-0138: E2E tests for POST /api/inbox/:id/claim (write-path «Взять задачу»).
 *
 * Covers:
 *   AC-1: 401 when x-dev-user header is absent
 *   AC-2: 404 when task id does not exist
 *   AC-3: 200 and item returned when pool task is claimed
 *   AC-4: 200 idempotent re-claim by same user
 *   AC-5: 409 ALREADY_CLAIMED when another user has claimed the task
 *   AC-6: 409 NOT_POOL_TASK when task is not a pool task
 *   AC-7: GET /api/inbox reflects claimed task (pool:false, mine:true for claimer)
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";
import { _resetClaimStateForTests } from "../http/inbox.js";

describe("Inbox claim write-path E2E (T-0138)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer(undefined, undefined, "memory");
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  afterEach(() => {
    // Reset in-memory claim state between tests
    _resetClaimStateForTests();
  });

  function request(
    method: string,
    path: string,
    headers?: Record<string, string>,
    body?: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(url, { method, headers }, (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
        });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: buf }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  // AC-1: 401 when x-dev-user is absent
  it("returns 401 when x-dev-user header is absent", async () => {
    const result = await request("POST", "/api/inbox/t3/claim");
    expect(result.statusCode).toBe(401);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.error as Record<string, unknown>)?.code).toBe("UNAUTHENTICATED");
  });

  // AC-2: 404 when task does not exist
  it("returns 404 for unknown task id", async () => {
    const result = await request("POST", "/api/inbox/no-such-task/claim", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(404);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.error as Record<string, unknown>)?.code).toBe("NOT_FOUND");
  });

  // AC-3: 200 with updated item on successful claim of pool task (t3 is pool:true)
  it("returns 200 and updated item when claiming a pool task", async () => {
    const result = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect(data).toHaveProperty("item");
    const item = data.item as Record<string, unknown>;
    expect(item.id).toBe("t3");
    expect(item.pool).toBe(false);
    expect(item.execType).toBe("human");
    expect(item.mine).toBe(true);
  });

  // AC-4: 200 idempotent re-claim by the same user
  it("returns 200 idempotently when same user re-claims the same task", async () => {
    // First claim
    await request("POST", "/api/inbox/t3/claim", { "x-dev-user": "e-sokolov" });
    // Second claim — same user
    const result = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.item as Record<string, unknown>).id).toBe("t3");
  });

  // AC-5: 409 ALREADY_CLAIMED when task claimed by another user
  it("returns 409 ALREADY_CLAIMED when task is already claimed by another user", async () => {
    // First user claims
    await request("POST", "/api/inbox/t3/claim", { "x-dev-user": "e-sokolov" });
    // Second user tries to claim
    const result = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-kravtsova",
    });
    expect(result.statusCode).toBe(409);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.error as Record<string, unknown>)?.code).toBe("ALREADY_CLAIMED");
  });

  // AC-6: 409 NOT_POOL_TASK when task is assigned (not pool)
  it("returns 409 NOT_POOL_TASK when task is not in the pool", async () => {
    // t1 is not pool:true in INBOX_SEED
    const result = await request("POST", "/api/inbox/t1/claim", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(409);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.error as Record<string, unknown>)?.code).toBe("NOT_POOL_TASK");
  });

  // AC-7: GET /api/inbox reflects claim — pool:false for claimed task
  it("GET /api/inbox reflects claimed task as pool:false", async () => {
    await request("POST", "/api/inbox/t3/claim", { "x-dev-user": "e-sokolov" });

    const listResult = await request("GET", "/api/inbox", {
      "x-dev-user": "e-sokolov",
    });
    expect(listResult.statusCode).toBe(200);
    const data = JSON.parse(listResult.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;
    const t3 = items.find((i) => i.id === "t3");
    expect(t3).toBeDefined();
    expect(t3!.pool).toBeFalsy(); // pool is false/undefined after claim
    expect(t3!.execType).toBe("human");
    expect(t3!.mine).toBe(true);
  });

  // ---- T-0094: taken-task state («взято кем, когда») ----

  // AC-8 (T-0094): claim response carries the taken-state — claimedBy + claimedAt.
  it("claim returns taken-state fields claimedBy + claimedAt", async () => {
    const before = Date.now();
    const result = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(200);
    const item = (JSON.parse(result.body) as Record<string, unknown>)
      .item as Record<string, unknown>;
    expect(item.claimedBy).toBe("e-sokolov");
    expect(typeof item.claimedAt).toBe("number");
    expect(item.claimedAt as number).toBeGreaterThanOrEqual(before);
    expect(item.claimedAt as number).toBeLessThanOrEqual(Date.now());
  });

  // AC-9 (T-0094): claimedBy is the actor that holds the claim; GET surfaces it for
  // OTHER actors too (the «кто взял» is visible to the whole role pool, not just mine).
  it("GET surfaces claimedBy/claimedAt + mine:false for a non-claiming role peer", async () => {
    await request("POST", "/api/inbox/t9/claim", { "x-dev-user": "e-sokolov" });
    // e-kravtsova also holds fin-ctrl (the t9 role) — she sees who took it, but it is not hers.
    const listResult = await request("GET", "/api/inbox", {
      "x-dev-user": "e-kravtsova",
    });
    const items = (JSON.parse(listResult.body) as Record<string, unknown>)
      .items as Array<Record<string, unknown>>;
    const t9 = items.find((i) => i.id === "t9");
    expect(t9).toBeDefined();
    expect(t9!.claimedBy).toBe("e-sokolov");
    expect(typeof t9!.claimedAt).toBe("number");
    expect(t9!.pool).toBeFalsy();
    expect(t9!.mine).toBe(false); // claimed by someone else
  });

  // AC-10 (T-0094): execName resolves to the claimer's DISPLAY NAME when the id is a
  // known employee (e-kravtsova → "А. Кравцова"), not the raw slug.
  it("claimed item execName resolves to the claimer display name", async () => {
    // e-kravtsova holds fin-ctrl and may claim the t11 fin-ctrl pool task.
    const result = await request("POST", "/api/inbox/t11/claim", {
      "x-dev-user": "e-kravtsova",
    });
    expect(result.statusCode).toBe(200);
    const item = (JSON.parse(result.body) as Record<string, unknown>)
      .item as Record<string, unknown>;
    expect(item.claimedBy).toBe("e-kravtsova");
    expect(item.execName).toBe("А. Кравцова"); // display name, not the slug
  });

  // AC-11 (T-0094): idempotent re-claim does NOT advance claimedAt — «когда взято»
  // is a stable fact, not a touch-timestamp. (re-claim is a no-op success.)
  it("idempotent re-claim preserves the original claimedAt (no-op, not a touch)", async () => {
    const first = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-sokolov",
    });
    const firstAt = (
      (JSON.parse(first.body) as Record<string, unknown>).item as Record<
        string,
        unknown
      >
    ).claimedAt as number;
    // Small spin so wall-clock would differ if the impl wrongly re-stamped.
    await new Promise((r) => setTimeout(r, 5));
    const second = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-sokolov",
    });
    const secondAt = (
      (JSON.parse(second.body) as Record<string, unknown>).item as Record<
        string,
        unknown
      >
    ).claimedAt as number;
    expect(secondAt).toBe(firstAt);
  });

  // AC-12 (T-0094): tenant isolation holds on the write-path — a dev-tenant actor
  // cannot claim a foreign-tenant task (x1 is in OTHER_TENANT_ID) → 404, never leaks.
  it("cannot claim a foreign-tenant task (tenant isolation on write) → 404", async () => {
    const result = await request("POST", "/api/inbox/x1/claim", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(404);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.error as Record<string, unknown>)?.code).toBe("NOT_FOUND");
  });
});
