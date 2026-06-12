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
});
