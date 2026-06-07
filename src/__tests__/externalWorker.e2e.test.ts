/**
 * src/__tests__/externalWorker.e2e.test.ts
 *
 * End-to-end tests for the external-worker HTTP endpoints.
 * All tests use an ephemeral port (listen 0) with a fresh server per test suite.
 * The lock-expiry test (AC-6) injects a stub clock to drive time deterministically
 * — no wall-clock sleep longer than a few ms for TCP handshake.
 *
 * Zero runtime dependencies — only node:http and node:net stdlib.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createServer } from "../server.js";
import { JobStore } from "../core/jobStore.js";
import type { Clock } from "../core/types.js";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload =
      body !== undefined ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(payload !== undefined
          ? { "Content-Length": Buffer.byteLength(payload) }
          : {}),
      },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });

    req.on("error", reject);

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

function requestRaw(
  port: number,
  method: string,
  path: string,
  rawBody: string,
  contentType = "application/json"
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(rawBody),
      },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });

    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Stub clock
// ---------------------------------------------------------------------------

function makeStubClock(initialMs: number): Clock & { advance(ms: number): void } {
  let now = initialMs;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Main suite (default store)
// ---------------------------------------------------------------------------

describe("external-worker endpoints (default store)", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createServer();
    port = await startServer(server);
  });

  afterAll(async () => {
    await stopServer(server);
  });

  // ---- AC-1: Happy path full round-trip -----------------------------------

  it("AC-1: POST /jobs → 201 Job; fetch-and-lock → LOCKED; complete → {ok:true}", async () => {
    // Enqueue
    const enqueue = await request(port, "POST", "/jobs", { topic: "my-topic" });
    expect(enqueue.status).toBe(201);
    const job = enqueue.body as { id: string; topic: string; state: string };
    expect(typeof job.id).toBe("string");
    expect(job.topic).toBe("my-topic");
    expect(job.state).toBe("CREATED");

    // Fetch-and-lock
    const fetch = await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "w1",
      topics: ["my-topic"],
      maxJobs: 1,
      lockDurationMs: 60_000,
    });
    expect(fetch.status).toBe(200);
    const fetchBody = fetch.body as { jobs: { id: string; state: string }[] };
    expect(fetchBody.jobs).toHaveLength(1);
    expect(fetchBody.jobs[0]!.id).toBe(job.id);
    expect(fetchBody.jobs[0]!.state).toBe("LOCKED");

    // Complete
    const complete = await request(port, "POST", `/external-task/${job.id}/complete`, {
      workerId: "w1",
    });
    expect(complete.status).toBe(200);
    expect((complete.body as { ok: boolean }).ok).toBe(true);
  });

  // ---- AC-2: Retry path ---------------------------------------------------

  it("AC-2: enqueue retries=1; fail(retries=1) → CREATED; fetch again; fail(retries=0) → FAILED; fetch returns []", async () => {
    const topic = "retry-topic-2";

    const enqueue = await request(port, "POST", "/jobs", { topic, retries: 1 });
    expect(enqueue.status).toBe(201);
    const jobId = (enqueue.body as { id: string }).id;

    // First fetch
    const fetch1 = await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "w2",
      topics: [topic],
      maxJobs: 1,
      lockDurationMs: 60_000,
    });
    expect(fetch1.status).toBe(200);
    expect((fetch1.body as { jobs: unknown[] }).jobs).toHaveLength(1);

    // Fail with retries=1 → should go back to CREATED
    const fail1 = await request(port, "POST", `/external-task/${jobId}/fail`, {
      workerId: "w2",
      retries: 1,
      retryTimeoutMs: 0,
    });
    expect(fail1.status).toBe(200);
    expect((fail1.body as { ok: boolean }).ok).toBe(true);

    // Second fetch — same job available again
    const fetch2 = await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "w2",
      topics: [topic],
      maxJobs: 1,
      lockDurationMs: 60_000,
    });
    expect(fetch2.status).toBe(200);
    const fetch2Jobs = (fetch2.body as { jobs: { id: string; state: string }[] }).jobs;
    expect(fetch2Jobs).toHaveLength(1);
    expect(fetch2Jobs[0]!.id).toBe(jobId);

    // Fail with retries=0 → FAILED
    const fail2 = await request(port, "POST", `/external-task/${jobId}/fail`, {
      workerId: "w2",
      retries: 0,
      retryTimeoutMs: 0,
    });
    expect(fail2.status).toBe(200);
    expect((fail2.body as { ok: boolean }).ok).toBe(true);

    // Fetch again — empty (job is FAILED)
    const fetch3 = await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "w2",
      topics: [topic],
      maxJobs: 1,
      lockDurationMs: 60_000,
    });
    expect(fetch3.status).toBe(200);
    expect((fetch3.body as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  // ---- AC-3: Exhausted retries --------------------------------------------

  it("AC-3: enqueue retries=0; fetch; fail(retries=0) → FAILED; next fetch returns []", async () => {
    const topic = "exhausted-topic";

    const enqueue = await request(port, "POST", "/jobs", { topic, retries: 0 });
    expect(enqueue.status).toBe(201);
    const jobId = (enqueue.body as { id: string }).id;

    const fetch1 = await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "w3",
      topics: [topic],
      maxJobs: 1,
      lockDurationMs: 60_000,
    });
    expect(fetch1.status).toBe(200);
    expect((fetch1.body as { jobs: unknown[] }).jobs).toHaveLength(1);

    const fail = await request(port, "POST", `/external-task/${jobId}/fail`, {
      workerId: "w3",
      retries: 0,
      retryTimeoutMs: 0,
    });
    expect(fail.status).toBe(200);

    const fetch2 = await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "w3",
      topics: [topic],
      maxJobs: 1,
      lockDurationMs: 60_000,
    });
    expect(fetch2.status).toBe(200);
    expect((fetch2.body as { jobs: unknown[] }).jobs).toHaveLength(0);
  });

  // ---- AC-4: Wrong owner --------------------------------------------------

  it("AC-4: complete with wrong workerId → 403 NOT_OWNER", async () => {
    const topic = "wrong-owner-topic";

    const enqueue = await request(port, "POST", "/jobs", { topic });
    const jobId = (enqueue.body as { id: string }).id;

    await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "workerA",
      topics: [topic],
      maxJobs: 1,
      lockDurationMs: 60_000,
    });

    const complete = await request(port, "POST", `/external-task/${jobId}/complete`, {
      workerId: "workerB",
    });
    expect(complete.status).toBe(403);
    const body = complete.body as { error: { code: string } };
    expect(body.error.code).toBe("NOT_OWNER");
  });

  // ---- AC-5: Unknown job --------------------------------------------------

  it("AC-5: complete on nonexistent job → 404 NOT_FOUND", async () => {
    const complete = await request(
      port,
      "POST",
      "/external-task/nonexistent-uuid/complete",
      { workerId: "w1" }
    );
    expect(complete.status).toBe(404);
    const body = complete.body as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  // ---- AC-7: Validation — missing topic -----------------------------------

  it("AC-7: POST /jobs missing topic → 400 VALIDATION", async () => {
    const res = await request(port, "POST", "/jobs", {});
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  // ---- AC-8: Validation — empty topic -------------------------------------

  it("AC-8: POST /jobs with topic='' → 400 VALIDATION", async () => {
    const res = await request(port, "POST", "/jobs", { topic: "" });
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  // ---- AC-9: Validation — retries wrong type ------------------------------

  it("AC-9: POST /jobs with retries='three' → 400 VALIDATION", async () => {
    const res = await request(port, "POST", "/jobs", { topic: "t", retries: "three" });
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  // ---- AC-10: Validation — topics missing/null ----------------------------

  it("AC-10: fetch-and-lock with topics=null → 400 VALIDATION", async () => {
    const res = await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "w1",
      topics: null,
      maxJobs: 1,
      lockDurationMs: 1000,
    });
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  it("AC-10b: fetch-and-lock with topics missing → 400 VALIDATION", async () => {
    const res = await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "w1",
      maxJobs: 1,
      lockDurationMs: 1000,
    });
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  // ---- AC-11: Validation — maxJobs=0 --------------------------------------

  it("AC-11: fetch-and-lock with maxJobs=0 → 400 VALIDATION", async () => {
    const res = await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "w1",
      topics: ["t"],
      maxJobs: 0,
      lockDurationMs: 1000,
    });
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  // ---- AC-12: Validation — fail missing retryTimeoutMs --------------------

  it("AC-12: POST /external-task/:id/fail missing retryTimeoutMs → 400 VALIDATION", async () => {
    const res = await request(port, "POST", "/external-task/some-id/fail", {
      workerId: "w1",
      retries: 0,
    });
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
  });

  // ---- AC-13: Invalid JSON body -------------------------------------------

  it("AC-13: POST /jobs with invalid JSON body → 400 INVALID_JSON", async () => {
    const res = await requestRaw(port, "POST", "/jobs", "not-json");
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_JSON");
  });

  // ---- AC-14: Health regression -------------------------------------------

  it("AC-14: GET /health still returns 200 { status: 'ok' }", async () => {
    const res = await request(port, "GET", "/health");
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("ok");
  });

  // ---- AC-15: Defaults for retries and variables --------------------------

  it("AC-15: POST /jobs with no retries/variables → 201; job has retries=0, variables={}", async () => {
    const res = await request(port, "POST", "/jobs", { topic: "defaults-topic" });
    expect(res.status).toBe(201);
    const job = res.body as { retries: number; variables: Record<string, unknown> };
    expect(job.retries).toBe(0);
    expect(job.variables).toEqual({});
  });

  // ---- AC-16: Not-locked guard on fail ------------------------------------

  it("AC-16: fail on CREATED job → 409 NOT_LOCKED", async () => {
    const enqueue = await request(port, "POST", "/jobs", { topic: "not-locked-topic" });
    const jobId = (enqueue.body as { id: string }).id;

    // Do NOT fetch-and-lock — job stays CREATED
    const fail = await request(port, "POST", `/external-task/${jobId}/fail`, {
      workerId: "w1",
      retries: 0,
      retryTimeoutMs: 0,
    });
    expect(fail.status).toBe(409);
    const body = fail.body as { error: { code: string } };
    expect(body.error.code).toBe("NOT_LOCKED");
  });

  // ---- AC-17: Ephemeral port ----------------------------------------------

  it("AC-17: server uses an ephemeral port (port > 0)", () => {
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

// ---------------------------------------------------------------------------
// AC-6 suite — stub-clock lock expiry (isolated server with injected store)
// ---------------------------------------------------------------------------

describe("AC-6: lock-expiry via stub clock", () => {
  let server: http.Server;
  let port: number;
  let stubClock: Clock & { advance(ms: number): void };

  beforeAll(async () => {
    stubClock = makeStubClock(1_000_000); // arbitrary starting epoch
    const store = new JobStore(stubClock);
    server = createServer(store);
    port = await startServer(server);
  });

  afterAll(async () => {
    await stopServer(server);
  });

  it("AC-6: complete after lock expiry (stub clock) → 409 LOCK_EXPIRED", async () => {
    // Enqueue a job
    const enqueue = await request(port, "POST", "/jobs", { topic: "expiry-topic" });
    expect(enqueue.status).toBe(201);
    const jobId = (enqueue.body as { id: string }).id;

    // Fetch-and-lock with lockDurationMs=100
    const fetch = await request(port, "POST", "/external-task/fetch-and-lock", {
      workerId: "expiry-worker",
      topics: ["expiry-topic"],
      maxJobs: 1,
      lockDurationMs: 100,
    });
    expect(fetch.status).toBe(200);
    expect((fetch.body as { jobs: unknown[] }).jobs).toHaveLength(1);

    // Advance fake time past lock expiry (100 ms) — no real sleep needed
    stubClock.advance(200);

    // Now complete — lock has expired
    const complete = await request(port, "POST", `/external-task/${jobId}/complete`, {
      workerId: "expiry-worker",
    });
    expect(complete.status).toBe(409);
    const body = complete.body as { error: { code: string } };
    expect(body.error.code).toBe("LOCK_EXPIRED");
  });
});

// ---------------------------------------------------------------------------
// AC-17 guard: no hardcoded port in this file (checked by FF-8)
// ---------------------------------------------------------------------------

// AC-18: The 83 pre-existing tests are tracked by the overall npm run ci pass.
