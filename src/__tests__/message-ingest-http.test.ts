/**
 * src/__tests__/message-ingest-http.test.ts — T-0536 [D8-R4 delivery].
 *
 * HTTP-layer tests for the message-ingest seam registered by
 * registerMessageIngestRoutes (POST /api/message) + emitInternalSignal.
 *
 * NO live DB, NO live Flowable. The engine is a mock (correlateMessage +
 * getActiveUserTasks); the subscription source is INJECTED (deps.subscriptionSource)
 * so the pure correlation core runs against fixture subscriptions while the DB pool
 * is a tripwire that throws if the no-task reconcile path is ever hit. Auth runs in
 * dev-mode (CHOROS_AUTH_MODE unset) — x-dev-user is the actor slug.
 *
 * Scenarios (task ТЕСТЫ а–д):
 *   (а) valid envelope → correlates into the right instance (mock engine signalled).
 *   (б) CROSS-TENANT → rejected, engine NEVER signalled (tenant-fail-closed). The
 *       route forces envelope.tenant = ACTOR tenant, so a forged body.tenant cannot
 *       reach another tenant; the 404 body is identical to no-match (NO leak).
 *   (в) internal signal (emitInternalSignal) broadcasts ONLY within the tenant.
 *   (г) GENERIC non-ТЭЛ process with a message-catch receives its message.
 *   (д) unknown correlationKey → honest 404 no-match (no crash, no leak).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import {
  registerMessageIngestRoutes,
  emitInternalSignal,
  type MessageIngestDeps,
  type MessageEngine,
} from "../http/message-ingest.js";
import type { MessageSubscription } from "../core/message-correlation.js";
import type { MessageSubscriptionSource } from "../http/process-projection.js";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ACTOR_A = "alice"; // resolves to TENANT_A
const ACTOR_B = "bob"; // resolves to TENANT_B

/** A pool that throws if touched — proves the no-task reconcile path is never hit. */
const tripwirePool = {
  connect: () => {
    throw new Error("pool must not be touched on this path");
  },
} as unknown as pg.Pool;

/** A tenant-scoped subscription source over a fixture set. */
function subSource(subs: MessageSubscription[]): MessageSubscriptionSource {
  return { listWaitingSubscriptions: async (t) => subs.filter((s) => s.tenant === t) };
}

/** A mock engine. correlateMessage records calls; getActiveUserTasks returns
 *  ok:false so the DB-touching reconcile branch is skipped (tripwire stays clean). */
function mockEngine() {
  const calls: Array<{ inst: string; messageName: string; payload: Record<string, unknown> }> = [];
  const engine: MessageEngine = {
    correlateMessage: async (inst, messageName, payload) => {
      calls.push({ inst, messageName, payload });
      return { ok: true as const };
    },
    getActiveUserTasks: async () => ({ ok: false as const, code: "skip" }),
    getMessageCatchWaits: async () => ({ ok: true as const, waits: [] }),
  };
  return { engine, calls };
}

// ---------------------------------------------------------------------------
// Test server harness
// ---------------------------------------------------------------------------

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function makeServer(deps: MessageIngestDeps) {
  const router = new Router();
  registerMessageIngestRoutes(router, deps);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  servers.push(server);
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function makeDeps(
  subs: MessageSubscription[],
  engine: MessageEngine,
): MessageIngestDeps {
  return {
    pool: tripwirePool,
    // ACTOR_A → TENANT_A, ACTOR_B → TENANT_B (the ONLY tenant source).
    resolveActorTenant: async (slug) => (slug === ACTOR_B ? TENANT_B : TENANT_A),
    engine,
    subscriptionSource: subSource(subs),
  };
}

async function postMessage(
  base: string,
  actor: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const url = new URL(base + "/api/message");
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          "x-dev-user": actor,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let json: unknown = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* ok */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// (а) valid envelope → correlates into the right instance
// ---------------------------------------------------------------------------

describe("T-0536 — POST /api/message: valid envelope correlates", () => {
  it("signals the engine for the instance whose business key matches", async () => {
    const subs: MessageSubscription[] = [
      { inst: "inst-other", tenant: TENANT_A, messageName: "contract-signed", correlationKey: "CT-999", broadcast: false },
      { inst: "inst-target", tenant: TENANT_A, messageName: "contract-signed", correlationKey: "CT-100", broadcast: false },
    ];
    const { engine, calls } = mockEngine();
    const base = await makeServer(makeDeps(subs, engine));

    const r = await postMessage(base, ACTOR_A, {
      messageName: "contract-signed",
      correlationKey: "CT-100",
      payload: { doc: "ref-1" },
    });

    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ delivered: true, firedInstances: ["inst-target"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ inst: "inst-target", messageName: "contract-signed", payload: { doc: "ref-1" } });
  });
});

// ---------------------------------------------------------------------------
// (б) CROSS-TENANT → rejected; engine NEVER signalled; no leak
// ---------------------------------------------------------------------------

describe("T-0536 — POST /api/message: TENANT-FAIL-CLOSED", () => {
  it("a forged body.tenant cannot reach another tenant's instance", async () => {
    // The waiting instance lives in TENANT_A. ACTOR_A posts but FORGES body.tenant=TENANT_B.
    const subs: MessageSubscription[] = [
      { inst: "inst-A", tenant: TENANT_A, messageName: "contract-signed", correlationKey: "CT-100", broadcast: false },
    ];
    const { engine, calls } = mockEngine();
    const base = await makeServer(makeDeps(subs, engine));

    const r = await postMessage(base, ACTOR_A, {
      tenant: TENANT_B, // FORGED — must be IGNORED (tenant comes from identity = TENANT_A)
      messageName: "contract-signed",
      correlationKey: "CT-100",
      payload: {},
    });

    // Forced to ACTOR_A's tenant (TENANT_A) → correlates the TENANT_A instance.
    // The body.tenant=TENANT_B is discarded; the instance still fires (in-tenant).
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.inst).toBe("inst-A");
  });

  it("ACTOR_B (TENANT_B) can NEVER correlate a TENANT_A instance — 404, engine silent, no leak", async () => {
    // The only waiting instance is in TENANT_A; ACTOR_B is in TENANT_B.
    const subs: MessageSubscription[] = [
      { inst: "inst-A", tenant: TENANT_A, messageName: "contract-signed", correlationKey: "CT-100", broadcast: false },
    ];
    const { engine, calls } = mockEngine();
    const base = await makeServer(makeDeps(subs, engine));

    const r = await postMessage(base, ACTOR_B, {
      messageName: "contract-signed",
      correlationKey: "CT-100",
      payload: {},
    });

    expect(r.status).toBe(404);
    // No-leak: the 404 body must NOT reveal that a TENANT_A match exists.
    expect(r.json).toMatchObject({ delivered: false });
    expect(JSON.stringify(r.json)).not.toContain("inst-A");
    expect(JSON.stringify(r.json)).not.toContain(TENANT_A);
    expect(calls).toHaveLength(0); // engine NEVER signalled cross-tenant.
  });
});

// ---------------------------------------------------------------------------
// (в) internal signal broadcasts ONLY within the tenant
// ---------------------------------------------------------------------------

describe("T-0536 — emitInternalSignal: in-tenant broadcast only", () => {
  it("a broadcast signal fires EVERY matching instance in the SAME tenant", async () => {
    const subs: MessageSubscription[] = [
      { inst: "a1", tenant: TENANT_A, messageName: "record-status-changed", correlationKey: "REC-1", broadcast: true },
      { inst: "a2", tenant: TENANT_A, messageName: "record-status-changed", correlationKey: "REC-1", broadcast: true },
      // Same name+key but ANOTHER tenant — must never fire.
      { inst: "b1", tenant: TENANT_B, messageName: "record-status-changed", correlationKey: "REC-1", broadcast: true },
    ];
    const { engine, calls } = mockEngine();
    const deps = makeDeps(subs, engine);

    const r = await emitInternalSignal(deps, {
      tenantId: TENANT_A,
      signalName: "record-status-changed",
      correlationKey: "REC-1",
      payload: { record_id: "REC-1" },
    });

    expect(r.delivered).toBe(true);
    if (r.delivered) expect(r.firedInstances.sort()).toEqual(["a1", "a2"]);
    // The TENANT_B instance was never signalled.
    expect(calls.map((c) => c.inst).sort()).toEqual(["a1", "a2"]);
    expect(calls.some((c) => c.inst === "b1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (г) GENERIC non-ТЭЛ process receives its message
// ---------------------------------------------------------------------------

describe("T-0536 — generic (non-ТЭЛ) correlation", () => {
  it("an arbitrary process+message name correlates by business key (no ТЭЛ hardcode)", async () => {
    // A process from some other domain entirely — purchase-order approval.
    const subs: MessageSubscription[] = [
      { inst: "po-inst-7", tenant: TENANT_A, messageName: "vendor-countersigned", correlationKey: "PO-2024-7", broadcast: false },
    ];
    const { engine, calls } = mockEngine();
    const base = await makeServer(makeDeps(subs, engine));

    const r = await postMessage(base, ACTOR_A, {
      messageName: "vendor-countersigned",
      correlationKey: "PO-2024-7",
      payload: { signedUrl: "s3://x" },
    });

    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ delivered: true, firedInstances: ["po-inst-7"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messageName).toBe("vendor-countersigned");
  });
});

// ---------------------------------------------------------------------------
// (д) unknown correlationKey → honest 404 no-match (no crash, no leak)
// ---------------------------------------------------------------------------

describe("T-0536 — POST /api/message: honest no-match", () => {
  it("an unknown correlationKey returns 404 without crashing or signalling", async () => {
    const subs: MessageSubscription[] = [
      { inst: "inst-A", tenant: TENANT_A, messageName: "contract-signed", correlationKey: "CT-100", broadcast: false },
    ];
    const { engine, calls } = mockEngine();
    const base = await makeServer(makeDeps(subs, engine));

    const r = await postMessage(base, ACTOR_A, {
      messageName: "contract-signed",
      correlationKey: "CT-DOES-NOT-EXIST",
      payload: {},
    });

    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ delivered: false });
    expect(calls).toHaveLength(0);
  });

  it("a malformed envelope (missing correlationKey) → 400, engine silent", async () => {
    const subs: MessageSubscription[] = [];
    const { engine, calls } = mockEngine();
    const base = await makeServer(makeDeps(subs, engine));

    const r = await postMessage(base, ACTOR_A, {
      messageName: "contract-signed",
      // correlationKey missing
      payload: {},
    });

    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
