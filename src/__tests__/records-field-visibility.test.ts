/**
 * T-0419 [D7-3-FU] — records LIST cross-role field-visibility redaction tests
 *
 * Verifies that the real field-visibility redaction is applied to the records
 * LIST handler BEFORE serialization. Actor A (with visibility to field X) sees
 * X in the list; actor B (without visibility) does NOT see X (key absent).
 *
 * Test suite mirrors the existing records-pagination.test.ts pattern:
 *   - Fake pool returning controlled rows (no live DB required)
 *   - resolveFieldVisibility dep stub returning controlled grants + policy
 *   - HTTP-level assertions over the response JSON
 *
 * Tests:
 *   FVR-1  No resolveFieldVisibility dep → empty policy → all fields present (NF-1)
 *   FVR-2  Empty policy (roleScopedFields=∅) → all fields present (no-op)
 *   FVR-3  Actor A with whole-resource grant sees role-scoped field X
 *   FVR-4  Actor B with facet-restricted grant (no X) → key X PHYSICALLY ABSENT
 *   FVR-5  Most-restrictive-wins: two grants, one withholds X → X absent
 *   FVR-6  Non-role-scoped fields are ALWAYS present regardless of facet
 *   FVR-7  resolveFieldVisibility called once per request (not per row)
 */

import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerRecordRoutes } from "../http/records.js";
import type { RecordRoutesDeps, FieldVisibilityResolver } from "../http/records.js";
import type { Grant } from "../core/grant-lattice.js";
import type { FieldVisibilityPolicy } from "../core/field-visibility.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "66666666-6666-6666-6666-666666666666";
const APP_ID    = "aaaaaaaa-0419-0001-0000-000000000001";
const REG_DEF_ID = "bbbbbbbb-0419-0001-0000-000000000002";

// ---------------------------------------------------------------------------
// Row factory — data has both a role-scoped field and a non-role-scoped field
// ---------------------------------------------------------------------------

function makeRow(i: number, extraData: Record<string, unknown> = {}) {
  return {
    id: `00000000-0419-0000-0000-${String(i).padStart(12, "0")}`,
    registry_id: REG_DEF_ID,
    application_id: APP_ID,
    record_schema_version: 1,
    data: { public_name: `item_${i}`, salary: 100_000 + i, ...extraData },
    created_at: String(1700000000000 - i * 1000),
    updated_at: String(1700000000000 - i * 1000),
  };
}

// ---------------------------------------------------------------------------
// Grant factories
// ---------------------------------------------------------------------------

function wholeResourceGrant(): Grant {
  return {
    tenantId: TENANT_ID,
    id: "g-whole",
    roleId: "role-whole",
    resourceType: "record",
    operation: "read",
    scope: {
      kind: "node",
      hierarchy: "resource",
      nodeId: REG_DEF_ID,
      nodeLevel: "registry",
    },
    resourceFacet: undefined, // whole-resource: confers all fields
    delegable: false,
    grantedBy: "admin",
    createdAt: Date.now() - 10_000,
  } as unknown as Grant;
}

function facetGrant(fields: string[]): Grant {
  return {
    ...wholeResourceGrant(),
    id: "g-facet",
    roleId: "role-facet",
    resourceFacet: { fields }, // facet-restricted: only these fields conferred
  } as unknown as Grant;
}

// ---------------------------------------------------------------------------
// Policy: "salary" is role-scoped; "public_name" is not
// ---------------------------------------------------------------------------

const POLICY_SALARY_SCOPED: FieldVisibilityPolicy = {
  roleScopedFields: new Set(["salary"]),
};
const EMPTY_POLICY: FieldVisibilityPolicy = { roleScopedFields: new Set() };

// ---------------------------------------------------------------------------
// Fake pool — stubs withTenantTx boilerplate + record SELECT
// ---------------------------------------------------------------------------

function makeFakePool(allRows: ReturnType<typeof makeRow>[]): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    const client = {
      query(sql: string, params?: unknown[]) {
        if (/^BEGIN/i.test(sql) || /^SET LOCAL/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
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
// HTTP test helpers
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
  actor = "e-orlov",
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

// ---------------------------------------------------------------------------
// FVR-1: No resolveFieldVisibility dep → NF-1 no-op (all fields present)
// ---------------------------------------------------------------------------

describe("T-0419 FVR-1: no resolveFieldVisibility dep → NF-1 (all fields present)", () => {
  it("all data fields are present when dep is absent (honest-degrade)", async () => {
    const rows = [makeRow(1)];
    const { start, stop } = makeServer(rows); // no resolveFieldVisibility
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base);
      expect(statusCode).toBe(200);
      expect(records).toHaveLength(1);
      const data = records[0]!["data"] as Record<string, unknown>;
      expect("public_name" in data).toBe(true);
      expect("salary" in data).toBe(true); // no redaction → present
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// FVR-2: Empty policy (roleScopedFields=∅) → no-op (all fields present)
// ---------------------------------------------------------------------------

describe("T-0419 FVR-2: empty policy → no-op (all fields present)", () => {
  it("all data fields are present when policy has no role-scoped fields", async () => {
    const rows = [makeRow(1)];
    const resolveFieldVisibility: FieldVisibilityResolver = async () => ({
      coveringGrants: [wholeResourceGrant()],
      policy: EMPTY_POLICY,
    });
    const { start, stop } = makeServer(rows, { resolveFieldVisibility });
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base);
      expect(statusCode).toBe(200);
      const data = records[0]!["data"] as Record<string, unknown>;
      expect("salary" in data).toBe(true);
      expect("public_name" in data).toBe(true);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// FVR-3: Actor A with whole-resource grant sees role-scoped field "salary"
// ---------------------------------------------------------------------------

describe("T-0419 FVR-3: actor with whole-resource grant sees role-scoped field", () => {
  it("salary is PRESENT for actor with whole-resource grant", async () => {
    const rows = [makeRow(1)];
    // Whole-resource grant confers every field (including role-scoped ones)
    const resolveFieldVisibility: FieldVisibilityResolver = async () => ({
      coveringGrants: [wholeResourceGrant()],
      policy: POLICY_SALARY_SCOPED,
    });
    const { start, stop } = makeServer(rows, { resolveFieldVisibility });
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base, "e-orlov");
      expect(statusCode).toBe(200);
      const data = records[0]!["data"] as Record<string, unknown>;
      expect("salary" in data).toBe(true);
      expect(data["salary"]).toBe(100_001);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// FVR-4: Actor B with facet-restricted grant (no "salary") → key ABSENT
// ---------------------------------------------------------------------------

describe("T-0419 FVR-4: actor with facet-restricted grant → role-scoped field ABSENT", () => {
  it("salary key is PHYSICALLY ABSENT for actor whose grant does not confer it", async () => {
    const rows = [makeRow(1)];
    // Facet-restricted grant: only "public_name" — does NOT confer "salary"
    const resolveFieldVisibility: FieldVisibilityResolver = async () => ({
      coveringGrants: [facetGrant(["public_name"])],
      policy: POLICY_SALARY_SCOPED,
    });
    const { start, stop } = makeServer(rows, { resolveFieldVisibility });
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base, "e-larina");
      expect(statusCode).toBe(200);
      const data = records[0]!["data"] as Record<string, unknown>;
      // public_name is NOT role-scoped → still present
      expect("public_name" in data).toBe(true);
      // salary IS role-scoped and grant does NOT confer it → PHYSICALLY ABSENT
      expect("salary" in data).toBe(false);
      // confirm it's not null — it's genuinely absent
      expect(Object.prototype.hasOwnProperty.call(data, "salary")).toBe(false);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// FVR-5: Most-restrictive-wins: two grants, one withholds "salary" → absent
// ---------------------------------------------------------------------------

describe("T-0419 FVR-5: most-restrictive-wins cross-role (two grants, one withholds field)", () => {
  it("salary absent when ANY covering grant does not confer it", async () => {
    const rows = [makeRow(1)];
    // Two grants: one whole-resource (confers salary), one facet that does NOT
    // Most-restrictive-wins → salary must be ABSENT
    const resolveFieldVisibility: FieldVisibilityResolver = async () => ({
      coveringGrants: [wholeResourceGrant(), facetGrant(["public_name"])],
      policy: POLICY_SALARY_SCOPED,
    });
    const { start, stop } = makeServer(rows, { resolveFieldVisibility });
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base, "e-actor-ab");
      expect(statusCode).toBe(200);
      const data = records[0]!["data"] as Record<string, unknown>;
      // Non-role-scoped field unaffected
      expect("public_name" in data).toBe(true);
      // Role-scoped field: one dissenting grant → hidden (most-restrictive-wins)
      expect("salary" in data).toBe(false);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// FVR-6: Non-role-scoped fields ALWAYS present regardless of facet restriction
// ---------------------------------------------------------------------------

describe("T-0419 FVR-6: non-role-scoped fields always present", () => {
  it("public_name (not role-scoped) is present even when facet does not list it", async () => {
    // "public_name" is NOT in roleScopedFields → union-floor holds (always visible
    // if the record has it, regardless of facet narrowing on role-scoped fields)
    const rows = [makeRow(1)];
    // Facet only confers "salary" (not "public_name") — but "public_name" is not role-scoped
    // so T-0081 most-restrictive post-filter does NOT hide it
    const resolveFieldVisibility: FieldVisibilityResolver = async () => ({
      coveringGrants: [facetGrant(["salary"])],
      policy: POLICY_SALARY_SCOPED,
    });
    const { start, stop } = makeServer(rows, { resolveFieldVisibility });
    const base = await start();
    try {
      const { records } = await getRecords(base);
      const data = records[0]!["data"] as Record<string, unknown>;
      // salary IS role-scoped and the facet explicitly confers it → present
      expect("salary" in data).toBe(true);
      // public_name is NOT role-scoped → T-0081 post-filter leaves it untouched
      // (it was in unionVisible via the grant's facet granting 'salary'; note that
      // for the union-floor in applyFieldVisibilityRedaction, unionVisible = all
      // keys in data, and non-role-scoped keys are always kept)
      expect("public_name" in data).toBe(true);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// FVR-7: resolveFieldVisibility called ONCE per request (not per row)
// ---------------------------------------------------------------------------

describe("T-0419 FVR-7: resolveFieldVisibility called once per request not per row", () => {
  it("spy is called exactly once for a 3-record response", async () => {
    const rows = [makeRow(1), makeRow(2), makeRow(3)];
    const spy = vi.fn(async () => ({
      coveringGrants: [wholeResourceGrant()],
      policy: POLICY_SALARY_SCOPED,
    }));
    const resolveFieldVisibility = spy as FieldVisibilityResolver;
    const { start, stop } = makeServer(rows, { resolveFieldVisibility });
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base);
      expect(statusCode).toBe(200);
      expect(records).toHaveLength(3);
      // resolveFieldVisibility must have been called exactly ONCE per request,
      // regardless of how many rows are in the page.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await stop();
    }
  });
});
