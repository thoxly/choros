/**
 * T-0771 (E16 consistency, live-proof T-0742) · GET /api/process-catalog
 * per-definition instance_count is now narrowed to the SAME READ-visibility
 * predicate (filterProjectionsByReadVisibility, T-0721/T-0722/T-0723) the
 * /api/processes grid's ?definition=<key> deep-link applies.
 *
 * THE BUG under test (found live, T-0742): the catalog counted EVERY
 * tenant-scoped instance for a definition ("N инстансов" on the card), but
 * the deep-linked grid was ALREADY participant-scoped (T-0723). A card could
 * say "3 инстанса" while a non-participant's click showed 0 rows.
 *
 * THE FIX: buildCatalogDefinitions is now fed `visibleProjections` — the
 * SAME `filterProjectionsByReadVisibility` output the grid's LIST route
 * computes (process-catalog.ts) — so the card's count equals exactly what
 * the grid will show for the SAME actor. Mirrors
 * processes-read-visibility.test.ts's fake-pool harness (pure unit, no live
 * Postgres; live-PG coverage stays in ci/checks/db/process-catalog.test.ts).
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerProcessCatalogRoutes, type ProcessCatalogDeps } from "../http/process-catalog.js";
import { PROCESS_STARTED_TYPE, APPROVER_ROLE } from "../http/process-projection.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";
import { RESOURCE_ROOT_NODE_ID } from "../core/read-visibility.js";
import { ACTOR_ACTIVE_SQL } from "../db/actor-authority-gate.js";

const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const ACTOR = "e-catalog-actor";
const NON_PARTICIPANT_ACTOR = "e-catalog-stranger";
const PROC_KEY = "cat-count-proc";
const RECORD_ID = "bbbbbbbb-1111-0000-0000-000000000001";
const REGISTRY_ID = "reg-cat-0001";
const APPLICATION_ID = "app-cat-0001";

function startedRow(inst: string, recordId?: string, id = `audit-${inst}`): Record<string, unknown> {
  return {
    id,
    actor: ACTOR,
    payload: {
      inst,
      proc_key: PROC_KEY,
      task_role: APPROVER_ROLE,
      task_step: "catalog-count-test-step",
      inbox_task_id: id,
      ...(recordId !== undefined ? { record_id: recordId } : {}),
    },
    occurred_at: Date.parse("2026-07-13T10:00:00Z"),
  };
}

/**
 * Fake pool — mirrors processes-read-visibility.test.ts's makeFakePool (SAME
 * process-projection.ts internals are exercised here: listInstanceProjections +
 * filterProjectionsByReadVisibility). Additionally answers process-catalog.ts's
 * OWN queries (choros.process_definition / choros.process_app_binding /
 * choros.engine_process_name) with an honest empty result — this test seeds NO
 * modeler rows or bindings, so every definition surfaced is 'engine'-sourced,
 * purely derived from the (visibility-narrowed) instance projections.
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
      if (/FROM\s+choros\.process_app_binding/i.test(text)) return { rows: [] };
      if (/FROM\s+choros\.engine_process_name/i.test(text)) return { rows: [] };
      // T-0723 participant-track query (the only query selecting confirmed_by).
      if (/confirmed_by/i.test(text)) {
        const instArg = Array.isArray(values) ? values[1] : undefined;
        const wanted = new Set<string>(
          Array.isArray(instArg)
            ? (instArg as string[])
            : instArg !== undefined
              ? [instArg as string]
              : [],
        );
        const rows = opts.startedRows
          .filter((r) => {
            const payload = r["payload"] as Record<string, unknown> | undefined;
            const inst = payload?.["inst"];
            return typeof inst === "string" && wanted.has(inst);
          })
          .map((r) => {
            const payload = r["payload"] as Record<string, unknown>;
            return {
              inst: payload["inst"],
              actor: (r["actor"] as string | undefined) ?? null,
              confirmed_by: null,
              task_role: (payload["task_role"] as string | undefined) ?? null,
            };
          });
        return { rows };
      }
      // Bare employee-active lookup (no role_assignment JOIN) — every actor named
      // in this file is active (no deactivated-slug scenario needed for T-0771).
      if (/FROM\s+choros\.employee/i.test(text) && !/role_assignment/i.test(text)) {
        const slugArg = Array.isArray(values) ? values[1] : undefined;
        if (typeof slugArg !== "string") return { rows: [] };
        void ACTOR_ACTIVE_SQL; // predicate presence asserted in processes-read-visibility.test.ts
        return { rows: [{ id: `emp-${slugArg}` }] };
      }
      const type = Array.isArray(values) ? values[0] : undefined;
      if (type === PROCESS_STARTED_TYPE) return { rows: opts.startedRows };
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => fakeClient as unknown as import("pg").PoolClient } as unknown as import("pg").Pool;
}

/** A grant covering EVERY record in the tenant (RESOURCE_ROOT sentinel). */
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

const rootAncestry: AncestryOracle = {
  isDescendantOrSelf(hierarchy, descendantId, ancestorId) {
    if (hierarchy === "resource" && ancestorId === RESOURCE_ROOT_NODE_ID) return true;
    return descendantId === ancestorId;
  },
};

function makeResolver(grants: Grant[]): ProcessCatalogDeps["resolveReadVisibility"] {
  return async () => ({ grants, ancestry: rootAncestry });
}

function makeDeps(opts: {
  startedRows: Array<Record<string, unknown>>;
  recordExists?: boolean;
  resolveReadVisibility?: ProcessCatalogDeps["resolveReadVisibility"];
}): ProcessCatalogDeps {
  return {
    pool: makeFakePool({ startedRows: opts.startedRows, recordExists: opts.recordExists }),
    resolveActorTenant: async () => TENANT_ID,
    ...(opts.resolveReadVisibility ? { resolveReadVisibility: opts.resolveReadVisibility } : {}),
  };
}

async function withServer(
  deps: ProcessCatalogDeps,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const router = new Router();
  registerProcessCatalogRoutes(router, deps);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const addr = server.address() as { port: number };
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

type CatalogResponse = {
  definitions: Array<{ process_key: string; instance_count: number }>;
  instances: Array<{ inst: string }>;
};

describe("T-0771 · GET /api/process-catalog instance_count narrowed by READ-visibility (consistency with /api/processes grid)", () => {
  it("non-participant, zero grants: the record-bound + non-participant record-less instances are invisible → the definition does not surface at all (honest — nothing about it is visible)", async () => {
    const deps = makeDeps({
      startedRows: [
        startedRow("inst-record-a", RECORD_ID),
        startedRow("inst-record-b", RECORD_ID),
        startedRow("inst-recordless-c"), // audit actor = ACTOR, not the querying stranger
      ],
      resolveReadVisibility: makeResolver([]), // zero covering grants
    });
    await withServer(deps, async (baseUrl) => {
      const { status, json } = await httpReq("GET", `${baseUrl}/api/process-catalog`, {
        "x-dev-user": NON_PARTICIPANT_ACTOR,
      });
      expect(status).toBe(200);
      const body = json as CatalogResponse;
      // Nothing about PROC_KEY is visible to this actor — no ghost card with a
      // lying "3 инстанса" that a click would show 0 rows for.
      expect(body.definitions.find((d) => d.process_key === PROC_KEY)).toBeUndefined();
      expect(body.instances.some((i) => i.inst.startsWith("inst-"))).toBe(false);
    });
  });

  it("participant of the record-less instance: count = 1 (only what THIS actor can see), NOT the tenant-wide 3", async () => {
    const deps = makeDeps({
      startedRows: [
        startedRow("inst-record-a", RECORD_ID),
        startedRow("inst-record-b", RECORD_ID),
        startedRow("inst-recordless-c"), // ACTOR is its audit-track participant
      ],
      resolveReadVisibility: makeResolver([]), // zero covering grants — record-bound stay hidden
    });
    await withServer(deps, async (baseUrl) => {
      const { status, json } = await httpReq("GET", `${baseUrl}/api/process-catalog`, {
        "x-dev-user": ACTOR,
      });
      expect(status).toBe(200);
      const body = json as CatalogResponse;
      const def = body.definitions.find((d) => d.process_key === PROC_KEY);
      expect(def).toBeDefined();
      // THE FIX: count is the visible set (1), not the raw tenant total (3).
      expect(def!.instance_count).toBe(1);
      expect(body.instances.map((i) => i.inst)).toEqual(["inst-recordless-c"]);
    });
  });

  it("wide covering grant: the two record-bound instances become visible; the record-less one stays gated by participant-tier (count = 2, not 3)", async () => {
    const deps = makeDeps({
      startedRows: [
        startedRow("inst-record-a", RECORD_ID),
        startedRow("inst-record-b", RECORD_ID),
        startedRow("inst-recordless-c"), // audit actor = ACTOR, not this querying actor
      ],
      recordExists: true,
      resolveReadVisibility: makeResolver([wideReadGrant()]),
    });
    await withServer(deps, async (baseUrl) => {
      const { status, json } = await httpReq("GET", `${baseUrl}/api/process-catalog`, {
        "x-dev-user": NON_PARTICIPANT_ACTOR,
      });
      expect(status).toBe(200);
      const body = json as CatalogResponse;
      const def = body.definitions.find((d) => d.process_key === PROC_KEY);
      expect(def).toBeDefined();
      expect(def!.instance_count).toBe(2);
      expect(body.instances.map((i) => i.inst).sort()).toEqual(["inst-record-a", "inst-record-b"]);
    });
  });

  it("honest-degrade: resolveReadVisibility absent → instance_count stays tenant-scope-only (byte-identical to pre-T-0771)", async () => {
    const deps = makeDeps({
      startedRows: [
        startedRow("inst-record-a", RECORD_ID),
        startedRow("inst-record-b", RECORD_ID),
        startedRow("inst-recordless-c"),
      ],
      // no resolveReadVisibility — gate skipped entirely.
    });
    await withServer(deps, async (baseUrl) => {
      const { status, json } = await httpReq("GET", `${baseUrl}/api/process-catalog`, {
        "x-dev-user": NON_PARTICIPANT_ACTOR,
      });
      expect(status).toBe(200);
      const body = json as CatalogResponse;
      const def = body.definitions.find((d) => d.process_key === PROC_KEY);
      expect(def).toBeDefined();
      expect(def!.instance_count).toBe(3);
    });
  });
});
