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
 * T-0722 (D-064, P2 из T-0714 — security/PDP) EXTENDS this file: GET
 * /api/processes LIST is now narrowed by the SAME predicate, BATCHED
 * (filterProjectionsByReadVisibility) instead of DETAIL's per-instance
 * isInstanceDetailVisible — see the "T-0722 · GET /api/processes LIST
 * narrowed" describe block below. The fake pool's `FROM choros.record r`
 * route already matches BOTH the single-row (DETAIL) and batched (LIST)
 * ancestry SELECTs — no harness change needed.
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
  filterProjectionsByReadVisibility,
  type InstanceProjection,
} from "../http/process-projection.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";
import { RESOURCE_ROOT_NODE_ID } from "../core/read-visibility.js";
import { ACTOR_ACTIVE_SQL } from "../db/actor-authority-gate.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR = "e-test-actor";
const LIVE_INST = "eng-inst-rv-1";
const LIVE_PROC = "telLinear";
const RECORD_ID = "aaaaaaaa-1111-0000-0000-000000000001";
const REGISTRY_ID = "reg-0001";
const APPLICATION_ID = "app-0001";

function startedRow(inst: string, recordId?: string, id = "audit-evt-1"): Record<string, unknown> {
  return {
    id,
    actor: ACTOR,
    payload: {
      inst,
      proc_key: LIVE_PROC,
      task_role: APPROVER_ROLE,
      task_step: "detail-gate-test-step",
      inbox_task_id: id,
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
 * name since it carries no `type` arg. T-0723 ADDS: the isInstanceParticipant /
 * isInstanceParticipantBatch audit-track query (distinguished by the
 * `confirmed_by` column it alone selects — neither the readEvents queries nor
 * the ancestry SELECT touch that column) — synthesized directly from
 * `opts.startedRows` (each row's `actor` + `payload.task_role` become that
 * instance's participant signal), for EITHER the single-instance shape
 * (`payload->>'inst' = $2`) or the batched shape (`= ANY($2::text[])`).
 *
 * T-0759 ADDS: a bare `FROM choros.employee ... slug = $2 ... LIMIT 1` lookup
 * WITHOUT a `role_assignment` reference is the "is this slug a CURRENTLY
 * active employee" shape — shared, byte-identical, by getRoleSlugsForActor's
 * OWN employeeId-resolve (clause (2)'s role check) AND isInstanceParticipant/
 * Batch's NEW clause-(1) active-check (this task). Answered TRUE (active) for
 * any slug the test names, UNLESS it appears in `opts.deactivatedSlugs` — so
 * every PRE-EXISTING test in this file (none of whose actors are meant to be
 * deactivated) keeps passing unchanged, and a NEW test can flip one slug to
 * "deactivated" without touching this shared fake pool's other routing. This
 * is a DIFFERENT shape from isGenesisOwnerForTenant's owner-check (which nests
 * the SAME bare lookup INSIDE a `role_assignment` JOIN) — that shape is left
 * on the old unconditional-`{rows:[]}` ("not owner") branch below, unaffected.
 *
 * T-0765 [fake-green fix, R-2 из ревью T-0759]: the T-0759 routing above
 * decided "deactivated?" from `opts.deactivatedSlugs` alone, keyed ONLY by
 * the query's SHAPE (bare `choros.employee`, no `role_assignment`) and the
 * `$2` slug arg — it never looked at whether the SQL TEXT actually carried
 * the `ACTOR_ACTIVE_SQL` (`deactivated_at IS NULL`) predicate. A mutant that
 * deletes `AND ${ACTOR_ACTIVE_SQL}` from the prod point-lookup (T-0759's
 * clause (1), process-projection.ts) still matches the SAME shape with the
 * SAME `$2` slug, so the old fake pool kept denying a "deactivated" slug
 * regardless — the mutant stayed invisible, all 28 tests green (see
 * docs/tasks/T-0765.spec.md for the RED→GREEN mutation proof). Fixed by
 * checking `text.includes(ACTOR_ACTIVE_SQL)`: a `deactivatedSlugs` entry is
 * only filtered out when the query text ACTUALLY carries the predicate —
 * mirroring real Postgres, where a deactivated employee's ROW still EXISTS
 * (`deactivated_at` is SET, the row is never deleted) and only a WHERE
 * clause that names the predicate excludes it. Drop the predicate from prod
 * SQL → this fake pool now finds the row regardless of `deactivatedSlugs` →
 * clause (1) grants → the T-0759 "deactivated actor denied" tests flip to a
 * 200/visible result they assert against → RED.
 */
function makeFakePool(opts: {
  startedRows: Array<Record<string, unknown>>;
  recordExists?: boolean;
  deactivatedSlugs?: string[];
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
      // T-0723: isInstanceParticipant(Batch)'s audit-track query — the ONLY query
      // in this module selecting `confirmed_by` — checked BEFORE the generic
      // `FROM choros.employee` branch below (isGenesisOwnerForTenant's query also
      // touches choros.employee as a subquery and must keep falling into that
      // branch, resolving non-owner; it never selects confirmed_by).
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
      // T-0759: bare employee-active lookup (no role_assignment JOIN) — the
      // "is this slug a currently-active employee" shape shared by
      // getRoleSlugsForActor's employeeId-resolve and isInstanceParticipant/
      // Batch's clause-(1) active-check. MUST be checked BEFORE the generic
      // fallback below (isGenesisOwnerForTenant's owner-check ALSO touches
      // choros.employee, but nested inside a role_assignment JOIN — that shape
      // keeps falling into the unconditional `{rows:[]}` branch, "not owner").
      if (/FROM\s+choros\.employee/i.test(text) && !/role_assignment/i.test(text)) {
        const slugArg = Array.isArray(values) ? values[1] : undefined;
        if (typeof slugArg !== "string") return { rows: [] };
        // T-0765: only filter out a `deactivatedSlugs` entry when the query
        // TEXT actually carries the ACTOR_ACTIVE_SQL predicate — see the
        // module doc-comment above for why (fake-green fix, R-2).
        const isDeactivated = (opts.deactivatedSlugs ?? []).includes(slugArg);
        const carriesActiveGate = text.includes(ACTOR_ACTIVE_SQL);
        if (isDeactivated && carriesActiveGate) return { rows: [] };
        return { rows: [{ id: `emp-${slugArg}` }] };
      }
      if (/FROM\s+choros\.employee/i.test(text)) return { rows: [] };
      const type = Array.isArray(values) ? values[0] : undefined;
      if (type === PROCESS_STARTED_TYPE) return { rows: opts.startedRows };
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => fakeClient as unknown as import("pg").PoolClient } as unknown as import("pg").Pool;
}

/** T-0723: a tenant-member actor with NO audit-track entry on any synthetic
 * instance in this file (never `startedRow`'s `actor`, never a role holder,
 * never owner) — the honest non-participant control for record-less tests. */
const NON_PARTICIPANT_ACTOR = "e-non-participant";

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
  deactivatedSlugs?: string[];
}): StartInstanceDeps {
  return {
    pool: makeFakePool({
      startedRows: opts.startedRows,
      recordExists: opts.recordExists,
      deactivatedSlugs: opts.deactivatedSlugs,
    }),
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
        // T-0723: query as a TRUE stranger — ACTOR is startedRow's audit actor
        // (the "started it" participant, T-0756), so querying as ACTOR here would
        // exercise the (separate, pre-existing) participant-tier fallback instead
        // of this test's actual target (the READ-grant-only denial with ZERO
        // participant relationship).
        const { status } = await httpReq("GET", `${baseUrl}/api/processes/${LIVE_INST}`, {
          "x-dev-user": NON_PARTICIPANT_ACTOR,
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
        // T-0723: same non-participant rationale as the test above.
        const { status } = await httpReq("GET", `${baseUrl}/api/processes/${LIVE_INST}`, {
          "x-dev-user": NON_PARTICIPANT_ACTOR,
        });
        expect(status).toBe(404);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  // T-0723 (D-064 anti-case): a record-less instance used to stay visible to
  // ANY zero-grant tenant member ("phase-1 scope"/default-open). That default
  // is now REPLACED by participant-tier: honest-404 for a stranger, skeleton
  // (no variables/history) for a genuine participant. See
  // docs/tasks/T-0723.spec.md §2 for the mini-ADR.
  it("T-0723: a record-less instance is DENIED to a non-participant zero-grant actor (honest-404, not default-open)", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0723-recordless-deny";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST)], // no record_id in payload; actor=ACTOR started it
        resolveReadVisibility: makeResolver([]), // zero covering grants
      });
      await withServer(deps, async (baseUrl) => {
        const { status } = await httpReq("GET", `${baseUrl}/api/processes/${LIVE_INST}`, {
          "x-dev-user": NON_PARTICIPANT_ACTOR,
        });
        expect(status).toBe(404);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("T-0723: a record-less instance is visible (participant-tier skeleton, NO variables/history) to the actor who started it", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0723-recordless-participant";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST)], // no record_id; actor=ACTOR — the audit-track "acted" case
        resolveReadVisibility: makeResolver([]), // zero covering grants — participant-tier is the ONLY door
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes/${LIVE_INST}`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
        const body = json as Record<string, unknown>;
        expect(body["id"]).toBe(LIVE_INST);
        // Participant-tier NEVER carries the reader-tier variables/history —
        // record-less instances have no source record, so there is no
        // covering-grant basis for the full reader tier at all (T-0723).
        expect(body["variables"]).toBeUndefined();
        expect(body["history"]).toBeUndefined();
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  // T-0759 [security/PDP P3, N1 из ревью T-0756 §1.2]: clause (1) (audit-actor
  // match) is now ACTOR_ACTIVE-gated — a DEACTIVATED former participant's PAST
  // audit-track action alone no longer grants the skeleton. Pure-unit mirror
  // of the live-PG RED→GREEN in ci/checks/db/processes-read-visibility.db.test.ts.
  it("T-0759: a DEACTIVATED former participant is denied (404), not the participant skeleton", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0759-deactivated-audit-actor";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST)], // no record_id; actor=ACTOR acted on it
        resolveReadVisibility: makeResolver([]), // zero covering grants — participant-tier is the ONLY door
        deactivatedSlugs: [ACTOR], // ACTOR genuinely acted, but is now deactivated
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

  // T-0722 [superseded]: this test used to assert LIST was UNAFFECTED by the
  // DETAIL gate ("phase-1 scope is DETAIL only"). T-0722 (phase 2 of T-0714
  // §5) closes that gap — see the "T-0722 · GET /api/processes LIST narrowed"
  // describe block below for the current (narrowed) behaviour.
});

// ---------------------------------------------------------------------------
// T-0722 (D-064, P2 из T-0714 — security/PDP) · GET /api/processes LIST
// narrowed by the SAME READ-visibility predicate as DETAIL (T-0721). Reuses
// the SAME fake-pool harness (the batched ancestry SELECT also matches the
// `FROM choros.record r` route in makeFakePool).
// ---------------------------------------------------------------------------

describe("T-0722 · GET /api/processes LIST narrowed by READ-visibility of each instance's source record", () => {
  const prevDbUrl = process.env["DATABASE_URL"];

  it("actor WITHOUT any covering READ grant: the record-bound instance is DROPPED from LIST", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0722-list-deny";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST, RECORD_ID)],
        resolveReadVisibility: makeResolver([]), // zero covering grants
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
        const data = json as { instances: Array<Record<string, unknown>> };
        expect(data.instances.some((i) => i.id === LIVE_INST)).toBe(false);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("actor WITH a covering READ grant: the record-bound instance APPEARS on LIST", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0722-list-allow";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST, RECORD_ID)],
        resolveReadVisibility: makeResolver([wideReadGrant()]),
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
        const data = json as { instances: Array<Record<string, unknown>> };
        expect(data.instances.some((i) => i.id === LIVE_INST)).toBe(true);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("mixed visibility: record-less instance stays (ACTOR is its participant — T-0723), record-bound (denied) instance is dropped — count reflects ONLY the visible instance", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0722-list-mixed";
    const RECORDLESS_INST = "eng-inst-rv-recordless";
    try {
      const deps = makeDeps({
        startedRows: [
          startedRow(LIVE_INST, RECORD_ID, "audit-evt-bound"),
          // T-0723: startedRow's `actor` is ACTOR — the querying actor below IS
          // this record-less instance's participant (the "acted on it" case),
          // which is now the ONLY reason it stays in LIST (not a blanket default).
          startedRow(RECORDLESS_INST, undefined, "audit-evt-recordless"),
        ],
        resolveReadVisibility: makeResolver([]), // zero covering grants — denies the record-bound one
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
        const data = json as { instances: Array<Record<string, unknown>> };
        // The response carries no separate total/count field — `instances` IS the
        // authoritative visible set, computed AFTER the filter (T-0722 spec §4.1).
        expect(data.instances.map((i) => i.id)).toEqual([RECORDLESS_INST]);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("the source record no longer resolves in-tenant (deleted) → dropped from LIST even with a wide grant", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0722-list-deleted";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST, RECORD_ID)],
        recordExists: false,
        resolveReadVisibility: makeResolver([wideReadGrant()]),
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
        const data = json as { instances: Array<Record<string, unknown>> };
        expect(data.instances.some((i) => i.id === LIVE_INST)).toBe(false);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("T-0723: a record-less instance stays on LIST for the actor who started it (participant-tier), not for a stranger", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0722-list-recordless";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST)], // no record_id in payload; actor=ACTOR
        resolveReadVisibility: makeResolver([]), // zero covering grants — participant-tier is the ONLY door
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
        const data = json as { instances: Array<Record<string, unknown>> };
        expect(data.instances.some((i) => i.id === LIVE_INST)).toBe(true);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("T-0723 (D-064 anti-case): a record-less instance is ABSENT from LIST for a non-participant zero-grant actor (not default-open)", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0723-list-recordless-deny";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST)], // no record_id in payload; actor=ACTOR started it
        resolveReadVisibility: makeResolver([]), // zero covering grants
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes`, {
          "x-dev-user": NON_PARTICIPANT_ACTOR,
        });
        expect(status).toBe(200);
        const data = json as { instances: Array<Record<string, unknown>> };
        expect(data.instances.some((i) => i.id === LIVE_INST)).toBe(false);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  // T-0759, LIST path (isInstanceParticipantBatch clause (1), equivalence with
  // the DETAIL test above): a DEACTIVATED former participant's past audit-track
  // action no longer keeps the record-less instance on LIST.
  it("T-0759: a DEACTIVATED former participant's record-less instance is ABSENT from LIST", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0759-list-deactivated-audit-actor";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST)], // no record_id; actor=ACTOR acted on it
        resolveReadVisibility: makeResolver([]), // zero covering grants — participant-tier is the ONLY door
        deactivatedSlugs: [ACTOR],
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
        const data = json as { instances: Array<Record<string, unknown>> };
        expect(data.instances.some((i) => i.id === LIVE_INST)).toBe(false);
      });
    } finally {
      if (prevDbUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = prevDbUrl;
    }
  });

  it("honest-degrade: resolveReadVisibility absent → LIST unchanged (byte-identical pre-T-0722)", async () => {
    process.env["DATABASE_URL"] = "postgres://fake/T-0722-list-degrade";
    try {
      const deps = makeDeps({
        startedRows: [startedRow(LIVE_INST, RECORD_ID)],
        // no resolveReadVisibility — gate skipped entirely.
      });
      await withServer(deps, async (baseUrl) => {
        const { status, json } = await httpReq("GET", `${baseUrl}/api/processes`, {
          "x-dev-user": ACTOR,
        });
        expect(status).toBe(200);
        const data = json as { instances: Array<Record<string, unknown>> };
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
  it("T-0723: record-less (recordId undefined) is NEVER visible via this predicate, regardless of grants — no covering-grant basis exists; participant-tier is decided separately by the caller (isInstanceParticipant)", async () => {
    const visible = await isInstanceDetailVisible(
      makeFakePool({ startedRows: [] }),
      TENANT_ID,
      undefined,
      [wideReadGrant()],
      rootAncestry,
      Date.now(),
    );
    expect(visible).toBe(false);
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

// ---------------------------------------------------------------------------
// filterProjectionsByReadVisibility — direct unit coverage of the T-0722
// batched LIST filter itself (process-projection.ts), independent of the
// HTTP layer. Mirrors the isInstanceDetailVisible direct-unit block above.
// ---------------------------------------------------------------------------

function fakeProjection(overrides: Partial<InstanceProjection> & { inst: string }): InstanceProjection {
  return {
    procKey: LIVE_PROC,
    role: APPROVER_ROLE,
    step: "step",
    status: "waiting",
    startedAt: Date.now(),
    inboxTaskId: `task-${overrides.inst}`,
    concurrentSteps: [],
    definitionName: "Test process",
    stepsDone: 0,
    stepsKnownTotal: 1,
    starterActorKind: "human",
    // T-0654 [rebase]: starterActorId is a required field of InstanceProjection (the raw
    // starter actor id, = process.started audit_event.actor). Default fixture value.
    starterActorId: "e-fixture-starter",
    ...overrides,
  };
}

describe("T-0722/T-0723 · filterProjectionsByReadVisibility (process-projection.ts)", () => {
  it("T-0723 (D-064 anti-case): a record-less projection is DROPPED for a non-participant actor, even with zero DB audit trail (no default-open)", async () => {
    const projections = [fakeProjection({ inst: "inst-recordless" })];
    const visible = await filterProjectionsByReadVisibility(
      makeFakePool({ startedRows: [] }), // no audit trail at all for inst-recordless
      TENANT_ID,
      projections,
      [wideReadGrant()], // even a WIDE grant is irrelevant — no source record to apply it to
      rootAncestry,
      Date.now(),
      NON_PARTICIPANT_ACTOR,
    );
    expect(visible).toEqual([]);
  });

  it("T-0723: a record-less projection is KEPT for the actor who is its participant (acted on it), regardless of grants", async () => {
    const projections = [fakeProjection({ inst: "inst-recordless" })];
    const visible = await filterProjectionsByReadVisibility(
      makeFakePool({ startedRows: [startedRow("inst-recordless")] }), // ACTOR acted on it (audit `actor` field)
      TENANT_ID,
      projections,
      [], // zero grants — participant-tier is the ONLY door
      rootAncestry,
      Date.now(),
      ACTOR,
    );
    expect(visible.map((p) => p.inst)).toEqual(["inst-recordless"]);
  });

  it("T-0759: a record-less projection is DROPPED for a DEACTIVATED former participant (direct isInstanceParticipantBatch unit coverage)", async () => {
    const projections = [fakeProjection({ inst: "inst-recordless" })];
    const visible = await filterProjectionsByReadVisibility(
      makeFakePool({
        startedRows: [startedRow("inst-recordless")], // ACTOR acted on it (audit `actor` field)
        deactivatedSlugs: [ACTOR], // but is now deactivated
      }),
      TENANT_ID,
      projections,
      [], // zero grants — participant-tier is the ONLY door, and it is now closed
      rootAncestry,
      Date.now(),
      ACTOR,
    );
    expect(visible).toEqual([]);
  });

  it("a covering grant keeps a record-bound projection", async () => {
    const projections = [fakeProjection({ inst: "inst-a", recordId: RECORD_ID })];
    const visible = await filterProjectionsByReadVisibility(
      makeFakePool({ startedRows: [], recordExists: true }),
      TENANT_ID,
      projections,
      [wideReadGrant()],
      rootAncestry,
      Date.now(),
      NON_PARTICIPANT_ACTOR, // irrelevant for a record-bound row — READ-PDP is the only gate
    );
    expect(visible.map((p) => p.inst)).toEqual(["inst-a"]);
  });

  it("zero covering grants drops a record-bound projection", async () => {
    const projections = [fakeProjection({ inst: "inst-a", recordId: RECORD_ID })];
    const visible = await filterProjectionsByReadVisibility(
      makeFakePool({ startedRows: [], recordExists: true }),
      TENANT_ID,
      projections,
      [],
      rootAncestry,
      Date.now(),
      NON_PARTICIPANT_ACTOR,
    );
    expect(visible).toEqual([]);
  });

  it("a record that does not resolve in-tenant is dropped even with a wide grant", async () => {
    const projections = [fakeProjection({ inst: "inst-a", recordId: RECORD_ID })];
    const visible = await filterProjectionsByReadVisibility(
      makeFakePool({ startedRows: [], recordExists: false }),
      TENANT_ID,
      projections,
      [wideReadGrant()],
      rootAncestry,
      Date.now(),
      NON_PARTICIPANT_ACTOR,
    );
    expect(visible).toEqual([]);
  });

  it("a malformed (non-UUID) recordId is dropped WITHOUT touching the pool", async () => {
    let queried = false;
    const trackingPool = {
      connect: async () => ({
        query: async (text: string) => {
          if (/^\s*SELECT/i.test(text) && /FROM\s+choros\.record\s+r/i.test(text)) queried = true;
          return { rows: [] };
        },
        release: () => {},
      }),
    } as unknown as import("pg").Pool;
    const projections = [fakeProjection({ inst: "inst-a", recordId: "not-a-uuid" })];
    const visible = await filterProjectionsByReadVisibility(
      trackingPool,
      TENANT_ID,
      projections,
      [wideReadGrant()],
      rootAncestry,
      Date.now(),
      NON_PARTICIPANT_ACTOR,
    );
    expect(visible).toEqual([]);
    // A malformed recordId is NOT record-less (`p.recordId !== undefined`), so it
    // never reaches the T-0723 participant-batch path either — confirmed by the
    // absence of any query in this tracker beyond the pre-validation short-circuit.
    expect(queried).toBe(false);
  });

  it("no record-bound projections at all → the batched ANCESTRY query is skipped (the participant query still runs for the record-less rows)", async () => {
    let ancestryQueried = false;
    let participantQueried = false;
    const trackingPool = {
      connect: async () => ({
        query: async (text: string, values?: unknown[]) => {
          if (!/^\s*SELECT/i.test(text)) return { rows: [] };
          if (/FROM\s+choros\.record\s+r/i.test(text)) {
            ancestryQueried = true;
            return { rows: [] };
          }
          if (/confirmed_by/i.test(text)) {
            participantQueried = true;
            // Both record-less instances have ACTOR as their audit-track actor —
            // preserves this test's original "both kept" intent under T-0723.
            const wanted = new Set(Array.isArray(values?.[1]) ? (values![1] as string[]) : []);
            const rows = ["inst-recordless-1", "inst-recordless-2"]
              .filter((inst) => wanted.has(inst))
              .map((inst) => ({ inst, actor: ACTOR, confirmed_by: null, task_role: null }));
            return { rows };
          }
          // T-0759: clause (1)'s active-check — ACTOR is active in this fixture.
          if (/FROM\s+choros\.employee/i.test(text) && !/role_assignment/i.test(text)) {
            const slugArg = Array.isArray(values) ? values[1] : undefined;
            return slugArg === ACTOR ? { rows: [{ id: "emp-actor" }] } : { rows: [] };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    } as unknown as import("pg").Pool;
    const projections = [fakeProjection({ inst: "inst-recordless-1" }), fakeProjection({ inst: "inst-recordless-2" })];
    const visible = await filterProjectionsByReadVisibility(
      trackingPool,
      TENANT_ID,
      projections,
      [],
      rootAncestry,
      Date.now(),
      ACTOR,
    );
    expect(visible.map((p) => p.inst)).toEqual(["inst-recordless-1", "inst-recordless-2"]);
    expect(ancestryQueried).toBe(false);
    expect(participantQueried).toBe(true);
  });

  it("preserves input order across mixed record-bound and record-less projections", async () => {
    const projections = [
      fakeProjection({ inst: "inst-1", recordId: RECORD_ID }),
      fakeProjection({ inst: "inst-2" }), // record-less — needs an audit trail to stay kept (T-0723)
      fakeProjection({ inst: "inst-3", recordId: RECORD_ID }),
    ];
    const visible = await filterProjectionsByReadVisibility(
      makeFakePool({ startedRows: [startedRow("inst-2")], recordExists: true }),
      TENANT_ID,
      projections,
      [wideReadGrant()],
      rootAncestry,
      Date.now(),
      ACTOR, // ACTOR is inst-2's participant (audit actor) AND covered by wideReadGrant for inst-1/inst-3
    );
    expect(visible.map((p) => p.inst)).toEqual(["inst-1", "inst-2", "inst-3"]);
  });
});
