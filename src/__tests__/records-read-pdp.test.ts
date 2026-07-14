/**
 * T-0570 [D3, READ-PDP] — records LIST/DETAIL grant-resolver visibility tests.
 *
 * Verifies GET /api/records and GET /api/records/:id resolve record-level
 * visibility through the SAME containment predicate resolveFor already uses
 * for actions (grant-resolver.ts), once the OPTIONAL resolveReadVisibility dep
 * is injected. Mirrors the fake-pool / injected-dep pattern of
 * records-field-visibility.test.ts and records-field-visibility-detail.test.ts.
 *
 * Tests (mapped to ADR fitness functions):
 *   RP-1  No resolveReadVisibility dep → NF-2 honest-degrade (all rows present)
 *   RP-2  Empty grant set (gate active, no covering grant) → list=[] (FF-RP-1/AC-1)
 *   RP-3  Root-sentinel default grant → all rows present (FF-RP-1/AC-1)
 *   RP-4  DETAIL: no covering grant → 404, same shape as not-found (FF-RP-2/AC-2)
 *   RP-5  DETAIL: covering grant → record present (FF-RP-2/AC-2)
 *   RP-6  Record-scoped narrow grant covers ONLY that record; a second record
 *         (same actor's grant set) is excluded from the list (FF-RP-5/AC-5)
 *   RP-7  Two actors: one default-open-covered, one narrowed to a subset — the
 *         narrowed actor sees fewer rows, the default actor still sees all
 *         (FF-RP-5/AC-5)
 *   RP-8  resolveReadVisibility called ONCE per LIST request, not per row
 *         (FF-RP-9/AC-7, N+1 guard)
 *   RP-9  Human path vs "agent" path (same actor slug convention, same grant
 *         set) → byte-identical visible set (FF-RP-10/AC-8 — one PDP, no fork)
 *   RP-10 Anti-case sanity: RESOURCE_ROOT_NODE_ID / READER_ROLE_SLUG are
 *         platform constants, not case-specific strings (NF-4 smoke check)
 *   RP-11 Composition: resolveReadVisibility (record-level gate) AND
 *         resolveFieldVisibility (field-level narrowing) injected TOGETHER —
 *         a record within the actor's READ grant is present, but a
 *         role-scoped field the actor's grant does not confer is physically
 *         absent from that SAME record (AC-6/FF-RP-11 — the two resolvers
 *         compose, neither shadows the other)
 */

import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerRecordRoutes } from "../http/records.js";
import type { RecordRoutesDeps, ReadVisibilityResolver, FieldVisibilityResolver } from "../http/records.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";
import type { FieldVisibilityPolicy } from "../core/field-visibility.js";
import { RESOURCE_ROOT_NODE_ID, READER_ROLE_SLUG } from "../core/read-visibility.js";
import { makeResourceAncestryOracle } from "../db/resource-ancestry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "77777777-0570-0000-0000-000000000001";
const APP_ID = "aaaaaaaa-0570-0000-0000-000000000001";
const REG_DEF_ID = "bbbbbbbb-0570-0000-0000-000000000002";
const RECORD_1 = "cccccccc-0570-0000-0000-000000000001";
const RECORD_2 = "cccccccc-0570-0000-0000-000000000002";

// A no-op org oracle (org hierarchy is not exercised in these tests).
const NOOP_ORG_ORACLE: AncestryOracle = {
  isDescendantOrSelf: (_h, a, b) => a === b,
};

function rootAncestry(): AncestryOracle {
  return makeResourceAncestryOracle(NOOP_ORG_ORACLE, new Map());
}

// ---------------------------------------------------------------------------
// Row factory
// ---------------------------------------------------------------------------

function makeRow(recordId: string) {
  return {
    id: recordId,
    registry_id: REG_DEF_ID,
    application_id: APP_ID,
    record_schema_version: 1,
    data: { name: `item-${recordId.slice(-1)}` },
    created_at: String(1700000000000),
    updated_at: String(1700000000000),
  };
}

// ---------------------------------------------------------------------------
// Grant factories
// ---------------------------------------------------------------------------

function defaultOpenGrant(): Grant {
  return {
    tenantId: TENANT_ID,
    id: "g-default-open",
    roleId: "role-reader-570",
    resourceType: "record",
    operation: "read",
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeLevel: "application",
      nodeId: RESOURCE_ROOT_NODE_ID,
    },
    resourceFacet: undefined,
    delegable: true,
    grantedBy: "registration",
    createdAt: Date.now() - 10_000,
  } as unknown as Grant;
}

function recordScopedGrant(recordId: string): Grant {
  return {
    tenantId: TENANT_ID,
    id: `g-record-${recordId}`,
    roleId: "role-narrow-570",
    resourceType: "record",
    operation: "read",
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeLevel: "record",
      nodeId: recordId,
    },
    resourceFacet: undefined,
    delegable: false,
    grantedBy: "owner",
    createdAt: Date.now() - 5_000,
  } as unknown as Grant;
}

// ---------------------------------------------------------------------------
// Fake pool — stubs withTenantTx boilerplate + record SELECT (LIST + DETAIL)
// ---------------------------------------------------------------------------

function makeFakePool(allRows: ReturnType<typeof makeRow>[]): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    const client = {
      query(sql: string, params?: unknown[]) {
        if (/^BEGIN/i.test(sql) || /^SET LOCAL/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        // DETAIL: SELECT ... FROM choros.record r ... WHERE r.tenant_id = $1 AND r.id = $2 ...
        if (/FROM choros\.record r/i.test(sql) && /WHERE r\.tenant_id = \$1 AND r\.id = \$2/i.test(sql)) {
          const id = params?.[1] as string;
          const row = allRows.find((r) => r.id === id);
          return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
        }
        // LIST: SELECT ... FROM choros.record r ...
        if (/FROM choros\.record r/i.test(sql) && /SELECT/i.test(sql)) {
          const limitParam = params?.[params.length - 1];
          const limit = typeof limitParam === "number" ? limitParam : 10_000;
          const sliced = allRows.slice(0, limit);
          return Promise.resolve({ rows: sliced, rowCount: sliced.length });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      release() {},
    };
    return client as unknown as import("pg").PoolClient;
  }
  return {
    connect() { return Promise.resolve(makeClient()); },
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// Server + HTTP helpers
// ---------------------------------------------------------------------------

function makeServer(
  rows: ReturnType<typeof makeRow>[],
  deps: Partial<RecordRoutesDeps> = {},
): { start(): Promise<string>; stop(): Promise<void> } {
  const router = new Router();
  const pool = makeFakePool(rows);

  const fullDeps: RecordRoutesDeps = {
    pool,
    resolveActorTenant: (_slug) => Promise.resolve(TENANT_ID),
    ...deps,
  };

  registerRecordRoutes(router, fullDeps);

  const srv = http.createServer((req, res) => { router.dispatch(req, res); });

  return {
    start(): Promise<string> {
      return new Promise((resolve) => {
        srv.listen(0, "localhost", () => {
          const addr = srv.address();
          resolve(
            addr && typeof addr !== "string"
              ? `http://localhost:${addr.port}`
              : "http://localhost:0",
          );
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => srv.close(() => resolve()));
    },
  };
}

function getRecords(
  baseUrl: string,
  actor = "e-actor",
): Promise<{ statusCode: number; records: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records`);
    const req = http.request(url, { method: "GET", headers: { "x-dev-user": actor } }, (res) => {
      let raw = "";
      res.on("data", (c: Buffer) => { raw += c.toString(); });
      res.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        resolve({
          statusCode: res.statusCode ?? 200,
          records: (body["records"] as Array<Record<string, unknown>>) ?? [],
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function getRecordDetail(
  baseUrl: string,
  recordId: string,
  actor = "e-actor",
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records/${recordId}`);
    const req = http.request(url, { method: "GET", headers: { "x-dev-user": actor } }, (res) => {
      let raw = "";
      res.on("data", (c: Buffer) => { raw += c.toString(); });
      res.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        resolve({ statusCode: res.statusCode ?? 200, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// RP-1: No resolveReadVisibility dep → NF-2 honest-degrade
// ---------------------------------------------------------------------------

describe("T-0570 RP-1: no resolveReadVisibility dep → NF-2 honest-degrade", () => {
  it("all rows present when the dep is absent (byte-identical to pre-T-0570)", async () => {
    const rows = [makeRow(RECORD_1), makeRow(RECORD_2)];
    const { start, stop } = makeServer(rows); // no resolveReadVisibility
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base);
      expect(statusCode).toBe(200);
      expect(records).toHaveLength(2);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// RP-2: Empty grant set (gate active, no covering grant) → list=[] (AC-1)
// ---------------------------------------------------------------------------

describe("T-0570 RP-2: empty grant set → list is empty, not full (FF-RP-1/AC-1)", () => {
  it("returns zero rows when the actor holds no covering READ grant", async () => {
    const rows = [makeRow(RECORD_1), makeRow(RECORD_2)];
    const resolveReadVisibility: ReadVisibilityResolver = async () => ({
      grants: [],
      ancestry: rootAncestry(),
    });
    const { start, stop } = makeServer(rows, { resolveReadVisibility });
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base);
      expect(statusCode).toBe(200);
      expect(records).toHaveLength(0);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// RP-3: Root-sentinel default grant → all rows present (AC-1)
// ---------------------------------------------------------------------------

describe("T-0570 RP-3: default-open (root-sentinel) grant → all rows visible (AC-1)", () => {
  it("returns every row when the actor holds the root-sentinel default grant", async () => {
    const rows = [makeRow(RECORD_1), makeRow(RECORD_2)];
    const resolveReadVisibility: ReadVisibilityResolver = async () => ({
      grants: [defaultOpenGrant()],
      ancestry: rootAncestry(),
    });
    const { start, stop } = makeServer(rows, { resolveReadVisibility });
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base);
      expect(statusCode).toBe(200);
      expect(records).toHaveLength(2);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// RP-4: DETAIL without covering grant → 404 (AC-2)
// ---------------------------------------------------------------------------

describe("T-0570 RP-4: DETAIL without covering grant → 404, not 200/403 (FF-RP-2/AC-2)", () => {
  it("returns the SAME honest 404 shape as not-found for a record the actor cannot READ", async () => {
    const rows = [makeRow(RECORD_1)];
    const resolveReadVisibility: ReadVisibilityResolver = async () => ({
      grants: [],
      ancestry: rootAncestry(),
    });
    const { start, stop } = makeServer(rows, { resolveReadVisibility });
    const base = await start();
    try {
      const { statusCode, body } = await getRecordDetail(base, RECORD_1);
      expect(statusCode).toBe(404);
      expect(body["error"]).toBeDefined();
      // Same shape as a genuinely-nonexistent record — no data leak.
      const { statusCode: notFoundStatus, body: notFoundBody } = await getRecordDetail(
        base,
        "00000000-0000-0000-0000-000000009999",
      );
      expect(notFoundStatus).toBe(404);
      expect(Object.keys(body).sort()).toEqual(Object.keys(notFoundBody).sort());
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// RP-5: DETAIL with a covering grant → record present (AC-2)
// ---------------------------------------------------------------------------

describe("T-0570 RP-5: DETAIL with covering grant → record present (AC-2)", () => {
  it("returns 200 with the record when a covering READ grant exists", async () => {
    const rows = [makeRow(RECORD_1)];
    const resolveReadVisibility: ReadVisibilityResolver = async () => ({
      grants: [defaultOpenGrant()],
      ancestry: rootAncestry(),
    });
    const { start, stop } = makeServer(rows, { resolveReadVisibility });
    const base = await start();
    try {
      const { statusCode, body } = await getRecordDetail(base, RECORD_1);
      expect(statusCode).toBe(200);
      expect(body["id"]).toBe(RECORD_1);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// RP-6: Record-scoped narrow grant covers ONLY that record (AC-5)
// ---------------------------------------------------------------------------

describe("T-0570 RP-6: record-scoped narrow grant covers only its own record (FF-RP-5/AC-5)", () => {
  it("a grant scoped to RECORD_1 does not confer visibility to RECORD_2", async () => {
    const rows = [makeRow(RECORD_1), makeRow(RECORD_2)];
    const resolveReadVisibility: ReadVisibilityResolver = async () => ({
      grants: [recordScopedGrant(RECORD_1)],
      ancestry: rootAncestry(),
    });
    const { start, stop } = makeServer(rows, { resolveReadVisibility });
    const base = await start();
    try {
      const { records } = await getRecords(base);
      expect(records).toHaveLength(1);
      expect(records[0]!["id"]).toBe(RECORD_1);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// RP-7: Sujenie is per-actor: narrowed actor sees fewer, default actor sees all
// ---------------------------------------------------------------------------

describe("T-0570 RP-7: narrowing one actor's grant does not affect another actor (FF-RP-5/AC-5)", () => {
  it("actor B (narrow grant) sees 1 record; actor A (default-open) still sees 2", async () => {
    const rows = [makeRow(RECORD_1), makeRow(RECORD_2)];
    const resolveReadVisibility: ReadVisibilityResolver = async (actorSlug: string) => {
      if (actorSlug === "actor-b-narrow") {
        return { grants: [recordScopedGrant(RECORD_1)], ancestry: rootAncestry() };
      }
      return { grants: [defaultOpenGrant()], ancestry: rootAncestry() };
    };
    const { start, stop } = makeServer(rows, { resolveReadVisibility });
    const base = await start();
    try {
      const { records: recordsA } = await getRecords(base, "actor-a-default");
      expect(recordsA).toHaveLength(2);

      const { records: recordsB } = await getRecords(base, "actor-b-narrow");
      expect(recordsB).toHaveLength(1);
      expect(recordsB[0]!["id"]).toBe(RECORD_1);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// RP-8: resolveReadVisibility called ONCE per LIST request (N+1 guard, AC-7)
// ---------------------------------------------------------------------------

describe("T-0570 RP-8: resolveReadVisibility called once per request, not per row (FF-RP-9/AC-7)", () => {
  it("spy is called exactly once for a multi-record page", async () => {
    const rows = [makeRow(RECORD_1), makeRow(RECORD_2), makeRow("cccccccc-0570-0000-0000-000000000003")];
    const spy = vi.fn(async () => ({
      grants: [defaultOpenGrant()],
      ancestry: rootAncestry(),
    }));
    const resolveReadVisibility = spy as ReadVisibilityResolver;
    const { start, stop } = makeServer(rows, { resolveReadVisibility });
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base);
      expect(statusCode).toBe(200);
      expect(records).toHaveLength(3);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// RP-9: Human path vs "agent" path (same grant set) → byte-identical visible
// set (FF-RP-10/AC-8) — the HTTP route resolves the SAME isRecordReadable
// predicate regardless of whether the caller identity is a human or an agent
// employee slug; there is no separate, more permissive agent branch.
// ---------------------------------------------------------------------------

describe("T-0570 RP-9: human actor and agent actor over the SAME grant set → identical visible set (FF-RP-10/AC-8)", () => {
  it("a human slug and an agent slug sharing the same covering grant see the same rows", async () => {
    const rows = [makeRow(RECORD_1), makeRow(RECORD_2)];
    // Same resolver regardless of caller identity — the PDP does not branch on
    // whether the actor slug looks human or agent (FR-6: one path).
    const resolveReadVisibility: ReadVisibilityResolver = async () => ({
      grants: [defaultOpenGrant()],
      ancestry: rootAncestry(),
    });
    const { start, stop } = makeServer(rows, { resolveReadVisibility });
    const base = await start();
    try {
      const { records: humanRecords } = await getRecords(base, "e-human-actor");
      const { records: agentRecords } = await getRecords(base, "assistant-agent");
      expect(humanRecords.map((r) => r["id"]).sort()).toEqual(
        agentRecords.map((r) => r["id"]).sort(),
      );
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// RP-10: Anti-case sanity — platform constants, not case-specific strings
// ---------------------------------------------------------------------------

describe("T-0570 RP-10: platform constants are not case-specific (NF-4 smoke check)", () => {
  it("RESOURCE_ROOT_NODE_ID and READER_ROLE_SLUG carry no case-specific persona/slug", () => {
    // FORBIDDEN_SANITY_LIST: this line ASSERTS the constants below do NOT
    // contain any of these D-064 anti-case literals — it is the test proving
    // the ban, not a violation of it (ci/checks/read-pdp-anti-case.sh
    // excludes lines containing "FORBIDDEN" from its scan for exactly this
    // reason).
    const FORBIDDEN_SANITY_LIST = ["role-approver", "soglasovanie", "tel-", "Согласование", "e-larina", "e-orlov", "e-configurator"];
    for (const bad of FORBIDDEN_SANITY_LIST) {
      expect(RESOURCE_ROOT_NODE_ID.includes(bad)).toBe(false);
      expect(READER_ROLE_SLUG.includes(bad)).toBe(false);
    }
    expect(READER_ROLE_SLUG).toBe("role-reader");
  });
});

// ---------------------------------------------------------------------------
// RP-11: Composition — resolveReadVisibility (record-level) AND
// resolveFieldVisibility (field-level) injected SIMULTANEOUSLY (AC-6/FF-RP-11,
// review R-2). records-read-pdp.test.ts (this file) otherwise only injects
// resolveReadVisibility alone; records-field-visibility(-detail).test.ts only
// inject resolveFieldVisibility alone (honest-degrade record-gate). Neither
// file proves the two resolvers compose when BOTH are wired at once — this is
// the missing case: a record-level covering grant admits the record into the
// result set, and a field-level facet independently narrows which keys of
// THAT SAME record are visible.
// ---------------------------------------------------------------------------

function makeRowWithSalary(recordId: string, salary: number) {
  return {
    id: recordId,
    registry_id: REG_DEF_ID,
    application_id: APP_ID,
    record_schema_version: 1,
    data: { name: `item-${recordId.slice(-1)}`, salary },
    created_at: String(1700000000000),
    updated_at: String(1700000000000),
  };
}

const FV_POLICY_SALARY_SCOPED: FieldVisibilityPolicy = {
  roleScopedFields: new Set(["salary"]),
};

function narrowFieldFacetGrant(): Grant {
  // A field-facet grant that confers "name" but NOT "salary" — distinct from
  // the record-level recordScopedGrant() above (which governs whether the
  // RECORD is in the result set at all, not which of its FIELDS are visible).
  return {
    tenantId: TENANT_ID,
    id: "g-field-facet",
    roleId: "role-field-narrow-570",
    resourceType: "record",
    operation: "read",
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeLevel: "registry",
      nodeId: REG_DEF_ID,
    },
    resourceFacet: { fields: ["name"] },
    delegable: false,
    grantedBy: "owner",
    createdAt: Date.now() - 5_000,
  } as unknown as Grant;
}

describe("T-0570 RP-11: resolveReadVisibility + resolveFieldVisibility injected together (AC-6/FF-RP-11)", () => {
  it("record-level grant admits the record; field-level facet independently hides a role-scoped field on it", async () => {
    const rows = [makeRowWithSalary(RECORD_1, 100_001), makeRowWithSalary(RECORD_2, 100_002)];

    // Record-level gate: actor holds a covering grant for RECORD_1 only —
    // RECORD_2 must be excluded from the list entirely (same as RP-6).
    const resolveReadVisibility: ReadVisibilityResolver = async () => ({
      grants: [recordScopedGrant(RECORD_1)],
      ancestry: rootAncestry(),
    });
    // Field-level narrowing: the actor's grant confers "name" but NOT
    // "salary" — on whatever record(s) survive the record-level gate,
    // "salary" must be physically absent.
    const resolveFieldVisibility: FieldVisibilityResolver = async () => ({
      coveringGrants: [narrowFieldFacetGrant()],
      policy: FV_POLICY_SALARY_SCOPED,
    });

    const { start, stop } = makeServer(rows, { resolveReadVisibility, resolveFieldVisibility });
    const base = await start();
    try {
      // LIST: only RECORD_1 present (record-level gate), and on it "salary"
      // is absent while "name" remains (field-level gate) — both layers fired
      // on the SAME response, neither shadowing the other.
      const { statusCode, records } = await getRecords(base);
      expect(statusCode).toBe(200);
      expect(records).toHaveLength(1);
      const listData = records[0]!["data"] as Record<string, unknown>;
      expect(records[0]!["id"]).toBe(RECORD_1);
      expect("name" in listData).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(listData, "salary")).toBe(false);

      // DETAIL: RECORD_1 (covered) returns 200 with "salary" absent too.
      const { statusCode: detailStatus, body: detailBody } = await getRecordDetail(base, RECORD_1);
      expect(detailStatus).toBe(200);
      const detailData = detailBody["data"] as Record<string, unknown>;
      expect("name" in detailData).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(detailData, "salary")).toBe(false);

      // DETAIL: RECORD_2 is NOT covered by the record-level grant → 404,
      // regardless of the field-visibility facet (record-level gate wins the
      // existence question; field-visibility only narrows an admitted record).
      const { statusCode: deniedStatus } = await getRecordDetail(base, RECORD_2);
      expect(deniedStatus).toBe(404);
    } finally {
      await stop();
    }
  });
});
