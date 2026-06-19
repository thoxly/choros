/**
 * T-0138 / T-0336: E2E tests for POST /api/inbox/:id/claim (write-path «Взять задачу»).
 *
 * T-0336 (E15-S2): The in-memory CLAIMED Map has been removed. Claim-state is now
 * projected from the audit_event track (task.claimed events). In no-DB / memory mode
 * (used by these tests), claim-state is NOT persisted — the TOCTOU-safe concurrent-
 * claim-lock primitive is deferred to T-0338.
 *
 * As a result, the no-DB tests reflect honest behavior:
 *   - Claims still return 200 (AuthN/AuthZ gates work).
 *   - Claimed-state (claimedBy/claimedAt/pool:false) is NOT reflected in responses.
 *   - ALREADY_CLAIMED and idempotent re-claim detection require the DB (T-0338).
 *   - Tenant isolation and role-eligibility gates are unchanged.
 *
 * DB-backed claim behavior (audit projection) is tested in ci/checks/db/*.
 *
 * Covers:
 *   AC-1: 401 when x-dev-user header is absent
 *   AC-2: 404 when task id does not exist
 *   AC-3: 200 returned when pool task is claimed (no claimedBy in no-DB mode)
 *   AC-4: 200 on re-claim (no prior state in no-DB mode)
 *   AC-5: 200 on concurrent claim (ALREADY_CLAIMED deferred to T-0338)
 *   AC-6: 409 NOT_POOL_TASK when task is not a pool task
 *   AC-7: GET /api/inbox does NOT reflect claimed task in no-DB mode (no state)
 *   AC-12: 404 for foreign-tenant task (tenant isolation preserved)
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

  // AC-3: 200 with item returned when pool task is claimed (no-DB mode)
  // T-0336: In no-DB mode, claimedBy/claimedAt are not set (no audit persistence).
  // The 200 response and item shape are preserved; pool/mine state is not mutated.
  it("returns 200 and item when claiming a pool task (no-DB: no state mutation)", async () => {
    const result = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect(data).toHaveProperty("item");
    const item = data.item as Record<string, unknown>;
    expect(item.id).toBe("t3");
    // no-DB mode: pool/mine/execType unchanged (no claim-state persistence)
  });

  // AC-4: 200 on re-claim (no-DB: no prior state to detect re-claim)
  // T-0336: Idempotent re-claim detection requires DB (T-0338). In no-DB mode,
  // the second claim also returns 200 as a fresh claim (no TOCTOU detection).
  it("returns 200 on re-claim (no-DB: no prior state to detect re-claim)", async () => {
    // First claim
    await request("POST", "/api/inbox/t3/claim", { "x-dev-user": "e-sokolov" });
    // Second claim — same user (no-DB: treated as fresh claim, returns 200)
    const result = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(200);
    const data = JSON.parse(result.body) as Record<string, unknown>;
    expect((data.item as Record<string, unknown>).id).toBe("t3");
  });

  // AC-5: concurrent claim — ALREADY_CLAIMED detection deferred to T-0338 (DB-only)
  // T-0336: In no-DB mode, concurrent claim returns 200 for both actors (no protection).
  // The deferred DB claim-lock primitive is in T-0338. DB-mode claim tests
  // are in ci/checks/db/*.
  it("concurrent claim by second user returns 200 in no-DB mode (ALREADY_CLAIMED needs T-0338)", async () => {
    // First user claims
    await request("POST", "/api/inbox/t3/claim", { "x-dev-user": "e-sokolov" });
    // Second user claims — no-DB: returns 200 (no TOCTOU protection without T-0338)
    const result = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-kravtsova",
    });
    expect(result.statusCode).toBe(200); // T-0336: ALREADY_CLAIMED deferred to T-0338
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

  // AC-7: GET /api/inbox does NOT reflect claimed state in no-DB mode (T-0336)
  // T-0336: Claim-state is projected from audit_event; in no-DB mode there is no
  // persistent claim-state so GET still shows the task as pool:true. DB-mode
  // projection is tested via ci/checks/db/*.
  it("GET /api/inbox task remains unclaimed in no-DB mode (no audit persistence)", async () => {
    await request("POST", "/api/inbox/t3/claim", { "x-dev-user": "e-sokolov" });

    const listResult = await request("GET", "/api/inbox", {
      "x-dev-user": "e-sokolov",
    });
    expect(listResult.statusCode).toBe(200);
    const data = JSON.parse(listResult.body) as Record<string, unknown>;
    const items = data.items as Array<Record<string, unknown>>;
    const t3 = items.find((i) => i.id === "t3");
    expect(t3).toBeDefined();
    // no-DB: pool remains true (no claim state), claimedBy absent
    expect(t3!.claimedBy).toBeUndefined();
  });

  // ---- T-0094: taken-task state («взято кем, когда») ----
  // T-0336: In no-DB mode, claim-state (claimedBy/claimedAt) is NOT persisted because
  // audit_event projection requires a live Postgres connection. The 200 response + item
  // shape are preserved; field-level claim assertions require DB (ci/checks/db/*.test.ts).

  // AC-8 (T-0094): claim response carries item shape (200 + item.id).
  // T-0336: claimedBy/claimedAt are NOT set in no-DB mode (no audit persistence).
  // DB-mode assertion: ci/checks/db/inbox_claim.test.ts verifies claimedBy + claimedAt.
  it("claim returns 200 and item (no-DB: claimedBy/claimedAt absent)", async () => {
    const result = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-sokolov",
    });
    expect(result.statusCode).toBe(200);
    const item = (JSON.parse(result.body) as Record<string, unknown>)
      .item as Record<string, unknown>;
    expect(item.id).toBe("t3");
    // no-DB: claimedBy/claimedAt are not set (no audit persistence — T-0336)
    expect(item.claimedBy).toBeUndefined();
    expect(item.claimedAt).toBeUndefined();
  });

  // AC-9 (T-0094): GET after claim — no-DB mode has no persistent claim-state.
  // T-0336: claimedBy/claimedAt are NOT surfaced in no-DB mode; pool/mine unchanged.
  // DB-mode: GET reflects claimedBy + mine:false for role peer (ci/checks/db/).
  it("GET after claim shows no claimedBy in no-DB mode (audit persistence deferred)", async () => {
    await request("POST", "/api/inbox/t9/claim", { "x-dev-user": "e-sokolov" });
    // e-kravtsova also holds fin-ctrl (the t9 role) — in no-DB she sees no claim-state.
    const listResult = await request("GET", "/api/inbox", {
      "x-dev-user": "e-kravtsova",
    });
    const items = (JSON.parse(listResult.body) as Record<string, unknown>)
      .items as Array<Record<string, unknown>>;
    const t9 = items.find((i) => i.id === "t9");
    expect(t9).toBeDefined();
    // no-DB: claim-state not persisted → claimedBy absent, pool/mine unchanged
    expect(t9!.claimedBy).toBeUndefined();
  });

  // AC-10 (T-0094): claim returns 200 for eligible actor (execName + claimedBy in DB-mode).
  // T-0336: In no-DB mode, claimedBy/execName are not set (no audit persistence).
  // DB-mode assertion: ci/checks/db/inbox_claim.test.ts verifies execName display name.
  it("claim returns 200 for eligible actor (no-DB: no claimedBy/execName fields)", async () => {
    // e-kravtsova holds fin-ctrl and may claim the t11 fin-ctrl pool task.
    const result = await request("POST", "/api/inbox/t11/claim", {
      "x-dev-user": "e-kravtsova",
    });
    expect(result.statusCode).toBe(200);
    const item = (JSON.parse(result.body) as Record<string, unknown>)
      .item as Record<string, unknown>;
    expect(item.id).toBe("t11");
    // no-DB: claimedBy/execName not set (no audit persistence — T-0336)
    expect(item.claimedBy).toBeUndefined();
  });

  // AC-11 (T-0094): idempotent re-claim — both return 200 in no-DB mode.
  // T-0336: Without audit persistence, the second claim is treated as fresh (no prior
  // state to detect idempotency). DB-mode: re-claim preserves original claimedAt (T-0338).
  it("re-claim also returns 200 in no-DB mode (idempotency deferred to T-0338)", async () => {
    const first = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-sokolov",
    });
    expect(first.statusCode).toBe(200);
    // Small spin so wall-clock would differ if the impl wrongly re-stamped.
    await new Promise((r) => setTimeout(r, 5));
    const second = await request("POST", "/api/inbox/t3/claim", {
      "x-dev-user": "e-sokolov",
    });
    // no-DB: both return 200 (no prior state to detect idempotent re-claim — T-0336)
    expect(second.statusCode).toBe(200);
    const item = (JSON.parse(second.body) as Record<string, unknown>)
      .item as Record<string, unknown>;
    expect(item.id).toBe("t3");
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
