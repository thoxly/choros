/**
 * T-0721 (D-064, P1 из T-0714 — security/PDP) · GET /api/processes/:id DETAIL
 * read-visibility gate — pure unit tests (fake pg pool, no live Postgres).
 *
 * THE FIX under test: `variables`/`history`/`completedBy*` on GET
 * /api/processes/:id are now gated by `isRecordReadable` over the instance's
 * SOURCE RECORD (isInstanceDetailVisible, process-projection.ts), fed by the
 * injected `resolveReadVisibility` (StartInstanceDeps, process-start.ts) —
 * the SAME single authority path records.ts's READ-PDP (T-0570) already
 * consumes. Mirrors processes-live-instances.test.ts's harness pattern
 * (buildServer/httpReq/fake pool), with ONE addition: the fake pool also
 * answers the recordId → {registryId, applicationId} ancestry SELECT
 * process-projection.ts's loadRecordRowAncestry issues.
 *
 * Live-PG coverage (real RLS, real getGrantsForSubject/loadTenantOrgAncestry)
 * is in ci/checks/db/processes-read-visibility.db.test.ts (mirrors T-0570's
 * records-read-pdp.db.test.ts).
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerProcessesRoutes } from "../http/processes.js";
import type { StartInstanceDeps } from "../http/process-start.js";
import {
  PROCESS_STARTED_TYPE,
  APPROVER_ROLE,
  isInstanceDetailVisible,
} from "../http/process-projection.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";
import { RESOURCE_ROOT_NODE_ID } from "../core/read-visibility.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR = "e-test-actor";
const LIVE_INST = "eng-inst-rv-1";
const LIVE_PROC = "telLinear";
const RECORD_ID = "aaaaaaaa-1111-0000-0000-000000000001";
const REGISTRY_ID = "reg-0001";
const APPLICATION_ID = "app-0001";

function startedRow(inst: string, recordId?: string): Record<string, unknown> {
  return {
    id: "audit-evt-1",
    actor: ACTOR,
    payload: {
      inst,
      proc_key: LIVE_PROC,
      task_role: APPROVER_ROLE,
      task_step: "detail-gate-test-step",
      inbox_task_id: "audit-evt-1",
      ...(recordId !== undefined ? { record_id: recordId } : {}),
    },
    occurred_at: Date.parse("2026-07-10T10:00:00Z"),
  };
}

/**
 * Fake pool: answers process-projection.ts's audit-event reads (routed by the
 * `type` = $1 arg, same convention as processes-live-instances.test.ts's
 * makeProjectionPool) AND the T-0721 record-ancestry SELECT
 * (`FROM choros.record r JOIN choros.registry_def rd ...`), routed by table
 * name since it carries no `type` arg.
 */
function makeFakePool(opts: {
  startedRows: Array<Record<string, unknown>>;
  recordExists?: boolean;
}): import("pg").Pool {
  const fakeClient = {
    query: async (text: string, values?: unknown[]) => {
      if (!/^\s*SELECT/i.test(text)) return { rows: [] };
      if (/FROM\s+choros\.record\s+r/i.test(text)) {
        if (opts.recordExists === false) return { rows: [] };
        return {
          rows: [{ id: RECORD_ID, registry_id: REGISTRY_ID, application_id: APPLICATION_ID }],
        };
      }
      if (/FROM\s+choros\.process_definition/i.test(text)) return { rows: [] };
      if (/FROM\s+choros\.employee/i.test(text)) return { rows: [] };
      const type = Array.isArray(values) ? values[0] : undefined;
      if (type === PROCESS_STARTED_TYPE) return { rows: opts.startedRows };
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => fakeClient as unknown as import("pg").PoolClient } as unknown as import("pg").Pool;
}

/** A grant covering EVERY record in the tenant (RESOURCE_ROOT sentinel, the
 * default-open shape migration 117 backfills). */
function wideReadGrant(): Grant {
  return {
    tenantId: TENANT_ID,
    id: "grant-wide",
    roleId: "role-reader",
    resourceType: "record",
    operation: "read",
    scope: { kind: "node", hierarchy: "resource", nodeId: RESOURCE_ROOT_NODE_ID, nodeLevel: "application" },
    delegable: true,
    grantedBy: "seed",
    createdAt: 0,
  };
}

/** Minimal AncestryOracle: root sentinel covers everything, otherwise self-match only. */
const rootAncestry: AncestryOracle = {
  isDescendantOrSelf(hierarchy, descendantId, ancestorId) {
    if (hierarchy === "resource" && ancestorId === RESOURCE_ROOT_NODE_ID) return true;
    return descendantId === ancestorId;
  },
};

function makeResolver(grants: Grant[]): StartInstanceDeps["resolveReadVisibility"] {
  return async () => ({ grants, ancestry: rootAncestry });
}

function makeDeps(opts: {
  startedRows: Array<Record<string, unknown>>;
  recordExists?: boolean;
  resolveReadVisibility?: StartInstanceDeps["resolveReadVisibility"];
}): StartInstanceDeps {
  return {
    pool: makeFakePool({ startedRows: opts.startedRows, recordExists: opts.recordExists }),
    flowable: {} as unknown as StartInstanceDeps["flowable"],
    resolveActorTenant: async () => TENANT_ID,
    ...(opts.resolveReadVisibility ? { resolveReadVisibility: opts.resolveReadVisibility } : {}),
  };
}

function buildServer(deps?: StartInstanceDeps): { server: http.Server; baseUrl: () => string } {
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
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port: parseInt(parsed.port, 10), path: parsed.pathname + parsed.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: { raw: data } });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withServer(
  deps: StartInstanceDeps | undefined,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const { server, baseUrl } = buildServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await fn(baseUrl());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("T-0721 · GET /api/processes/:id honest-degrade when resolveReadVisibility is absent", () => {
  const prevDbUrl = process.env["DATABASE_URL"];

  it("200 for any actor, unchanged from pre-T-0721 (no gate wired)", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0721-degrade";
    try {
      const deps = makeDeps({ startedRows: [startedRow(LIVE_INST, RECORD_ID)] });
      await withServer(deps, async (baseUrl) => {
        const { status } = await httpReq("GET", `${baseUrl}/api/processes/${LIVE_INST}`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });
});

describe("T-0721 · GET /api/processes/:id gated by READ-visibility of the source record", () => {
  const prevDbUrl = process.env["DATABASE_URL"];

  it("actor WITH a covering READ grant sees DETAIL (200)", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0721-allow";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST, RECORD_ID)],
        resolveReadVisibility: makeResolver([wideReadGrant()]),
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes/${LIVE_INST}`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
        expect((json as Record<string, unknown>).id).toBe(LIVE_INST);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("actor WITHOUT any covering READ grant is denied DETAIL (honest-404, records.ts precedent)", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0721-deny";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST, RECORD_ID)],
        resolveReadVisibility: makeResolver([]), // zero covering grants
      });
      await withServer(deps, async (baseUrl) => {
        const { status } = await httpReq("GET", `${baseUrl}/api/processes/${LIVE_INST}`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(404);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("the source record no longer resolves in-tenant (deleted) → honest-deny even with a wide grant", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0721-deleted";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST, RECORD_ID)],
        recordExists: false,
        resolveReadVisibility: makeResolver([wideReadGrant()]),
      });
      await withServer(deps, async (baseUrl) => {
        const { status } = await httpReq("GET", `${baseUrl}/api/processes/${LIVE_INST}`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(404);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("a record-less instance (no recordId) stays visible even to a zero-grant actor (phase-1 scope)", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0721-recordless";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST)], // no record_id in payload
        resolveReadVisibility: makeResolver([]), // zero covering grants
      });
      await withServer(deps, async (baseUrl) => {
        const { status } = await httpReq("GET", `${baseUrl}/api/processes/${LIVE_INST}`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("LIST (/api/processes) is UNAFFECTED — phase-1 scope is DETAIL only (T-0714 §5 phase 2 is a follow-up)", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0721-list-unaffected";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST, RECORD_ID)],
        resolveReadVisibility: makeResolver([]), // zero covering grants — would deny DETAIL
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
        const data = json as { instances: Array<Record<string, unknown>> };
        // The instance still appears on LIST despite being denied on DETAIL.
        expect(data.instances.some((i) => i.id === LIVE_INST)).toBe(true);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });
});

// ---------------------------------------------------------------------------
// isInstanceDetailVisible — direct unit coverage of the predicate itself
// (process-projection.ts), independent of the HTTP layer.
// ---------------------------------------------------------------------------

describe("T-0721 · isInstanceDetailVisible (process-projection.ts)", () => {
  it("record-less (recordId undefined) is always visible, regardless of grants", async () => {
    const visible = await isInstanceDetailVisible(
      makeFakePool({ startedRows: [] }),
      TENANT_ID,
      undefined,
      [],
      rootAncestry,
      Date.now(),
    );
    expect(visible).toBe(true);
  });

  it("a covering grant makes an existing record visible", async () => {
    const visible = await isInstanceDetailVisible(
      makeFakePool({ startedRows: [], recordExists: true }),
      TENANT_ID,
      RECORD_ID,
      [wideReadGrant()],
      rootAncestry,
      Date.now(),
    );
    expect(visible).toBe(true);
  });

  it("zero covering grants denies an existing record", async () => {
    const visible = await isInstanceDetailVisible(
      makeFakePool({ startedRows: [], recordExists: true }),
      TENANT_ID,
      RECORD_ID,
      [],
      rootAncestry,
      Date.now(),
    );
    expect(visible).toBe(false);
  });

  it("a record that does not resolve in-tenant is denied even with a wide grant", async () => {
    const visible = await isInstanceDetailVisible(
      makeFakePool({ startedRows: [], recordExists: false }),
      TENANT_ID,
      RECORD_ID,
      [wideReadGrant()],
      rootAncestry,
      Date.now(),
    );
    expect(visible).toBe(false);
  });
});
