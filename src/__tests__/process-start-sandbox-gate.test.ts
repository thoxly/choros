/**
 * T-0558 — process-start sandbox-gate tests
 *
 * Verifies that POST /api/processes/start REFUSES (before the engine is touched, no
 * instance created) to start:
 *   - a process whose definition is NOT published (still in sandbox), OR
 *   - a process bound to an application still in the DRAFT (sandbox) tier,
 * UNLESS the caller is PRIVILEGED (owner/admin OR authoring_draft grant → sandbox
 * dry-run allowed). A published definition with a published bound app is unaffected.
 *
 * Pure unit — no live DB / no live Flowable. The sandbox-state resolver and the
 * privilege resolver are injected (resolveProcessSandboxState / resolveSandboxPrivilege)
 * so every branch is driven without a Postgres. The FlowableClient is a stub; we assert
 * startInstance is NOT called when the start is refused.
 *
 * Tests:
 *   PS-1  Unprivileged + draft definition → 409 SANDBOX_NOT_RUNNABLE, engine untouched
 *   PS-2  Unprivileged + draft-bound application → 409 SANDBOX_NOT_RUNNABLE
 *   PS-3  Privileged owner/admin + draft definition → 201 (dry-run allowed)
 *   PS-4  Privileged authoring_draft + draft-bound app → 201 (dry-run allowed)
 *   PS-5  Unprivileged + published definition + published app → 201 (unaffected)
 *   PS-6  Unprivileged + legacy process (no definition row) + no draft binding → 201
 *         (the definition-published gate does not apply to directly-deployed processes)
 */

import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerProcessesRoutes } from "../http/processes.js";
import type {
  StartInstanceDeps,
  ProcessSandboxState,
  ProcessSandboxStateResolver,
} from "../http/process-start.js";
import type { ActorPrivilegeResolver } from "../http/process-start.js";
import type { ActorPrivilege } from "../db/sandbox-gate-dao.js";
import type { FlowableClient, StartResult } from "../core/flowable-client.js";

// ---------------------------------------------------------------------------
// Stubs (mirror process-start.test.ts)
// ---------------------------------------------------------------------------

function makeStubFlowableClient(startResult: StartResult): FlowableClient {
  return {
    deployBpmn: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    startInstance: vi.fn().mockResolvedValue(startResult),
    fetchAndLock: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    completeTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    failTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null }),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
    getActiveUserTasks: vi.fn().mockResolvedValue({ ok: true, tasks: [] }),
    getMessageCatchWaits: vi.fn().mockResolvedValue({ ok: true, waits: [] }),
    correlateMessage: vi.fn().mockResolvedValue({ ok: true }),
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
  };
}

function makeMemoryPool(): import("pg").Pool {
  const fakeClient = {
    query: async () => ({ rows: [] }),
    release: () => {},
  };
  return {
    connect: async () => fakeClient as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

function buildServer(deps: StartInstanceDeps): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  registerProcessesRoutes(router, undefined, deps);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  return {
    server,
    baseUrl: () => {
      const addr = server.address() as { port: number } | null;
      if (!addr) throw new Error("server not listening");
      return `http://127.0.0.1:${addr.port}`;
    },
  };
}

async function httpReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(buf ? { "Content-Type": "application/json", "Content-Length": String(buf.length) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, json: { raw: data } }); }
      });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Constants + dep factories
// ---------------------------------------------------------------------------

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR = "e-orlov";
const AUTH = { "x-dev-user": ACTOR, "x-tenant-id": TENANT_ID };

const UNPRIVILEGED: ActorPrivilege = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false };
const OWNER_ADMIN: ActorPrivilege = { isOwnerOrAdmin: true, hasAuthoringDraftGrant: false };
const AUTHORING_DRAFT: ActorPrivilege = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: true };

function privResolver(priv: ActorPrivilege): ActorPrivilegeResolver {
  return async () => priv;
}
function stateResolver(state: ProcessSandboxState): ProcessSandboxStateResolver {
  return async () => state;
}

function makeDeps(
  state: ProcessSandboxState,
  priv: ActorPrivilege,
): { deps: StartInstanceDeps; flowable: FlowableClient } {
  const flowable = makeStubFlowableClient({ ok: true, instanceId: "inst-xyz" });
  const deps: StartInstanceDeps = {
    pool: makeMemoryPool(),
    flowable,
    resolveActorTenant: async () => TENANT_ID,
    resolveSandboxPrivilege: privResolver(priv),
    resolveProcessSandboxState: stateResolver(state),
  };
  return { deps, flowable };
}

async function withServer(
  deps: StartInstanceDeps,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const h = buildServer(deps);
  await new Promise<void>((r) => h.server.listen(0, "127.0.0.1", () => r()));
  try {
    await fn(h.baseUrl());
  } finally {
    await new Promise<void>((r) => h.server.close(() => r()));
  }
}

const PUBLISHED_RUNNABLE: ProcessSandboxState = {
  hasDefinitionRow: true,
  definitionPublished: true,
  boundAppDraft: false,
};
const DRAFT_DEFINITION: ProcessSandboxState = {
  hasDefinitionRow: true,
  definitionPublished: false,
  boundAppDraft: false,
};
const DRAFT_BOUND_APP: ProcessSandboxState = {
  hasDefinitionRow: true,
  definitionPublished: true,
  boundAppDraft: true,
};
const LEGACY_NO_DEFINITION: ProcessSandboxState = {
  hasDefinitionRow: false,
  definitionPublished: false,
  boundAppDraft: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("process-start sandbox-gate: refuse for unprivileged", () => {
  it("PS-1 draft definition → 409 SANDBOX_NOT_RUNNABLE, engine untouched", async () => {
    const { deps, flowable } = makeDeps(DRAFT_DEFINITION, UNPRIVILEGED);
    await withServer(deps, async (base) => {
      const r = await httpReq("POST", `${base}/api/processes/start`, AUTH, { processKey: "draftProc" });
      expect(r.status).toBe(409);
      const err = (r.json as Record<string, unknown>)["error"] as Record<string, unknown>;
      expect(err["code"]).toBe("SANDBOX_NOT_RUNNABLE");
    });
    expect(vi.mocked(flowable.startInstance)).not.toHaveBeenCalled();
  });

  it("PS-2 draft-bound application → 409 SANDBOX_NOT_RUNNABLE", async () => {
    const { deps, flowable } = makeDeps(DRAFT_BOUND_APP, UNPRIVILEGED);
    await withServer(deps, async (base) => {
      const r = await httpReq("POST", `${base}/api/processes/start`, AUTH, { processKey: "boundDraftApp" });
      expect(r.status).toBe(409);
      const err = (r.json as Record<string, unknown>)["error"] as Record<string, unknown>;
      expect(err["code"]).toBe("SANDBOX_NOT_RUNNABLE");
    });
    expect(vi.mocked(flowable.startInstance)).not.toHaveBeenCalled();
  });
});

describe("process-start sandbox-gate: privileged dry-run allowed", () => {
  it("PS-3 owner/admin + draft definition → 201", async () => {
    const { deps, flowable } = makeDeps(DRAFT_DEFINITION, OWNER_ADMIN);
    await withServer(deps, async (base) => {
      const r = await httpReq("POST", `${base}/api/processes/start`, AUTH, { processKey: "draftProc" });
      expect(r.status).toBe(201);
    });
    expect(vi.mocked(flowable.startInstance)).toHaveBeenCalled();
  });

  it("PS-4 authoring_draft + draft-bound app → 201", async () => {
    const { deps, flowable } = makeDeps(DRAFT_BOUND_APP, AUTHORING_DRAFT);
    await withServer(deps, async (base) => {
      const r = await httpReq("POST", `${base}/api/processes/start`, AUTH, { processKey: "boundDraftApp" });
      expect(r.status).toBe(201);
    });
    expect(vi.mocked(flowable.startInstance)).toHaveBeenCalled();
  });
});

describe("process-start sandbox-gate: published / legacy unaffected", () => {
  it("PS-5 unprivileged + published definition + published app → 201", async () => {
    const { deps, flowable } = makeDeps(PUBLISHED_RUNNABLE, UNPRIVILEGED);
    await withServer(deps, async (base) => {
      const r = await httpReq("POST", `${base}/api/processes/start`, AUTH, { processKey: "telLinear" });
      expect(r.status).toBe(201);
    });
    expect(vi.mocked(flowable.startInstance)).toHaveBeenCalled();
  });

  it("PS-6 unprivileged + legacy process (no definition row), no draft binding → 201", async () => {
    const { deps, flowable } = makeDeps(LEGACY_NO_DEFINITION, UNPRIVILEGED);
    await withServer(deps, async (base) => {
      const r = await httpReq("POST", `${base}/api/processes/start`, AUTH, { processKey: "telLinear" });
      expect(r.status).toBe(201);
    });
    expect(vi.mocked(flowable.startInstance)).toHaveBeenCalled();
  });
});
