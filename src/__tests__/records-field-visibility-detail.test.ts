/**
 * T-0421 [D7-3-FU] — records DETAIL field-visibility cross-role redaction tests
 *
 * Verifies that the field-visibility redaction introduced in T-0421 is applied
 * to GET /api/records/:id (the DETAIL endpoint) BEFORE serialization, mirroring
 * the T-0419 LIST behaviour.
 *
 * Tests use the same fake-pool / injected-dep pattern as
 * records-field-visibility.test.ts (T-0419 unit tests), but issue requests
 * against GET /api/records/:id instead of GET /api/records.
 *
 * Tests:
 *   DFV-1  No resolveFieldVisibility dep → empty policy → all fields present (NF-1)
 *   DFV-2  Actor WITH visibility to a classified field → field PRESENT in detail
 *   DFV-3  Actor WITHOUT visibility to a classified field → field key PHYSICALLY ABSENT
 *   DFV-4  Non-role-scoped fields always present regardless of facet restriction
 *   DFV-5  LIST behaviour unchanged: the LIST endpoint still redacts independently
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerRecordRoutes } from "../http/records.js";
import type { RecordRoutesDeps, FieldVisibilityResolver } from "../http/records.js";
import type { Grant } from "../core/grant-lattice.js";
import type { FieldVisibilityPolicy } from "../core/field-visibility.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID   = "55555555-5555-5555-5555-000000000421";
const APP_ID      = "aaaaaaaa-0421-0000-0000-000000000001";
const REG_DEF_ID  = "bbbbbbbb-0421-0000-0000-000000000002";
const RECORD_ID   = "cccccccc-0421-0000-0000-000000000003";
const RECORD_SCHEMA = { type: "object", properties: { public_name: { type: "string" }, salary: { type: "number" } } };

// ---------------------------------------------------------------------------
// A single detail row (what getRecordDetail returns)
// ---------------------------------------------------------------------------

const DETAIL_ROW = {
  id: RECORD_ID,
  registry_id: REG_DEF_ID,
  application_id: APP_ID,
  record_schema_version: 1,
  record_schema: RECORD_SCHEMA,
  data: { public_name: "Alice", salary: 150_000 },
  created_at: String(1700000000000),
  updated_at: String(1700000000000),
  created_by: "e-orlov",
};

// ---------------------------------------------------------------------------
// Grant factories (mirrors records-field-visibility.test.ts)
// ---------------------------------------------------------------------------

function wholeResourceGrant(): Grant {
  return {
    tenantId: TENANT_ID,
    id: "g-whole-421",
    roleId: "role-whole-421",
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
    id: "g-facet-421",
    roleId: "role-facet-421",
    resourceFacet: { fields }, // facet-restricted: only these fields conferred
  } as unknown as Grant;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

const POLICY_SALARY_SCOPED: FieldVisibilityPolicy = {
  roleScopedFields: new Set(["salary"]),
};

// ---------------------------------------------------------------------------
// Fake pool — stubs withTenantTx + the detail SELECT
// ---------------------------------------------------------------------------

function makeFakePool(): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    const client = {
      query(sql: string) {
        if (/^BEGIN/i.test(sql) || /^SET LOCAL/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        // getRecordDetail — detail SELECT (joins record + registry_def, selects record_schema)
        if (/FROM choros\.record r/i.test(sql) && /registry_def/i.test(sql)) {
          return Promise.resolve({ rows: [DETAIL_ROW], rowCount: 1 });
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
// Server factory
// ---------------------------------------------------------------------------

function makeServer(
  deps: Partial<RecordRoutesDeps> = {},
): { start(): Promise<string>; stop(): Promise<void> } {
  const router = new Router();
  const pool = makeFakePool();

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

// ---------------------------------------------------------------------------
// HTTP helper — GET /api/records/:id
// ---------------------------------------------------------------------------

function getRecordDetail(
  baseUrl: string,
  recordId: string,
  actor = "e-orlov",
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records/${recordId}`);
    const req = http.request(url, {
      method: "GET",
      headers: { "x-dev-user": actor },
    }, (res) => {
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
// HTTP helper — GET /api/records (LIST) for DFV-5
// ---------------------------------------------------------------------------

function getRecordsList(
  baseUrl: string,
  actor = "e-larina",
): Promise<{ statusCode: number; records: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/records`);
    const req = http.request(url, {
      method: "GET",
      headers: { "x-dev-user": actor },
    }, (res) => {
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
// DFV-1: No resolveFieldVisibility dep → NF-1 no-op (all fields present)
// ---------------------------------------------------------------------------

describe("T-0421 DFV-1: no resolveFieldVisibility dep → NF-1 (all fields present in detail)", () => {
  it("all data fields are present in detail when dep is absent (honest-degrade)", async () => {
    const { start, stop } = makeServer(); // no resolveFieldVisibility
    const base = await start();
    try {
      const { statusCode, body } = await getRecordDetail(base, RECORD_ID);
      expect(statusCode).toBe(200);
      const data = body["data"] as Record<string, unknown>;
      expect("public_name" in data).toBe(true);
      expect("salary" in data).toBe(true); // no redaction → present (NF-1)
      expect(data["salary"]).toBe(150_000);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// DFV-2: Actor WITH visibility → classified field PRESENT in detail
// ---------------------------------------------------------------------------

describe("T-0421 DFV-2: actor with whole-resource grant → classified field PRESENT in detail", () => {
  it("salary is PRESENT for actor with whole-resource grant on detail endpoint", async () => {
    const resolveFieldVisibility: FieldVisibilityResolver = async () => ({
      coveringGrants: [wholeResourceGrant()],
      policy: POLICY_SALARY_SCOPED,
    });
    const { start, stop } = makeServer({ resolveFieldVisibility });
    const base = await start();
    try {
      const { statusCode, body } = await getRecordDetail(base, RECORD_ID, "e-orlov");
      expect(statusCode).toBe(200);
      const data = body["data"] as Record<string, unknown>;
      // Whole-resource grant confers ALL fields → salary present
      expect("salary" in data).toBe(true);
      expect(data["salary"]).toBe(150_000);
      expect("public_name" in data).toBe(true);
      // Detail-specific fields must still be present
      expect(body["record_schema"]).toBeDefined();
      expect(body["created_by"]).toBe("e-orlov");
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// DFV-3: Actor WITHOUT visibility → classified field key PHYSICALLY ABSENT
// ---------------------------------------------------------------------------

describe("T-0421 DFV-3: actor with facet-restricted grant → classified field ABSENT in detail", () => {
  it("salary key is PHYSICALLY ABSENT for actor whose grant does not confer it", async () => {
    // Facet-restricted grant: only "public_name" — does NOT confer "salary"
    const resolveFieldVisibility: FieldVisibilityResolver = async () => ({
      coveringGrants: [facetGrant(["public_name"])],
      policy: POLICY_SALARY_SCOPED,
    });
    const { start, stop } = makeServer({ resolveFieldVisibility });
    const base = await start();
    try {
      const { statusCode, body } = await getRecordDetail(base, RECORD_ID, "e-larina");
      expect(statusCode).toBe(200);
      const data = body["data"] as Record<string, unknown>;
      // public_name is NOT role-scoped → union-floor holds → present
      expect("public_name" in data).toBe(true);
      // salary IS role-scoped and grant does NOT confer it → PHYSICALLY ABSENT (not null)
      expect("salary" in data).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(data, "salary")).toBe(false);
      // Detail-specific fields must still be intact (redaction is data-only)
      expect(body["record_schema"]).toBeDefined();
      expect(body["created_by"]).toBe("e-orlov");
      expect(body["id"]).toBe(RECORD_ID);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// DFV-4: Non-role-scoped fields always present regardless of facet restriction
// ---------------------------------------------------------------------------

describe("T-0421 DFV-4: non-role-scoped fields always present in detail", () => {
  it("public_name (not role-scoped) is present even when facet does not list it", async () => {
    // "public_name" is NOT in roleScopedFields → union-floor holds
    // Grant only explicitly confers "salary", but "public_name" is not scoped
    // so it is always included regardless
    const resolveFieldVisibility: FieldVisibilityResolver = async () => ({
      coveringGrants: [facetGrant(["salary"])],
      policy: POLICY_SALARY_SCOPED,
    });
    const { start, stop } = makeServer({ resolveFieldVisibility });
    const base = await start();
    try {
      const { statusCode, body } = await getRecordDetail(base, RECORD_ID, "e-larina");
      expect(statusCode).toBe(200);
      const data = body["data"] as Record<string, unknown>;
      // salary IS role-scoped and the facet explicitly confers it → present
      expect("salary" in data).toBe(true);
      // public_name is NOT role-scoped → T-0081 post-filter does not hide it
      expect("public_name" in data).toBe(true);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// DFV-5: LIST behaviour unchanged — the LIST endpoint still redacts independently
// ---------------------------------------------------------------------------

describe("T-0421 DFV-5: LIST behaviour unchanged by detail redaction change", () => {
  it("GET /api/records (list) still redacts classified fields for facet-restricted actor", async () => {
    const resolveFieldVisibility: FieldVisibilityResolver = async () => ({
      coveringGrants: [facetGrant(["public_name"])],
      policy: POLICY_SALARY_SCOPED,
    });
    const { start, stop } = makeServer({ resolveFieldVisibility });
    const base = await start();
    try {
      // LIST: facet-restricted actor must NOT see salary
      const { statusCode: listStatus, records } = await getRecordsList(base, "e-larina");
      expect(listStatus).toBe(200);
      // Pool returns DETAIL_ROW for any record SELECT — list shows same data
      if (records.length > 0) {
        const data = records[0]!["data"] as Record<string, unknown>;
        expect("public_name" in data).toBe(true);
        expect("salary" in data).toBe(false);
      }
      // DETAIL: same actor must NOT see salary
      const { statusCode: detailStatus, body } = await getRecordDetail(base, RECORD_ID, "e-larina");
      expect(detailStatus).toBe(200);
      const detailData = body["data"] as Record<string, unknown>;
      expect("public_name" in detailData).toBe(true);
      expect("salary" in detailData).toBe(false);
    } finally {
      await stop();
    }
  });
});
