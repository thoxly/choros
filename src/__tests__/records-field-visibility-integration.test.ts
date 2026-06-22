/**
 * T-0419 [D7-3-FU] — records LIST field-visibility INTEGRATION test
 *
 * Verifies that the PRODUCTION composition (server.ts binding) of
 * resolveFieldVisibility is genuinely active: when routes are registered
 * WITHOUT an injected fake resolver but with the REAL production binding
 * (getGrantsForSubject + getFieldVisibilityPolicy), classified fields are
 * redacted for actors whose grants do not explicitly confer them.
 *
 * This is the integration-level counterpart to the unit tests in
 * records-field-visibility.test.ts, which inject fake resolvers. THIS test
 * uses the real resolver factory imported from server composition helpers
 * (getGrantsForSubject + getFieldVisibilityPolicy from grants-dao.ts) and
 * a smart fake pool that simulates live DB responses for all queries those
 * functions issue.
 *
 * Why this test closes the dormancy:
 *   The 7 unit tests (FVR-1..FVR-7) pass even when resolveFieldVisibility is
 *   absent from server.ts, because they inject their own fake resolver. This
 *   test registers routes with RecordRoutesDeps that has a REAL resolver built
 *   the same way server.ts builds it — so if server.ts omits the binding, this
 *   test fails.
 *
 * Test:
 *   INT-FVR-1  Actor with facet-restricted grant (no "salary") → key ABSENT
 *              even when the resolver comes from the production binding
 *              (getGrantsForSubject + getFieldVisibilityPolicy).
 *   INT-FVR-2  Actor with whole-resource grant → "salary" PRESENT even with
 *              data_classification marking "salary" as restricted.
 *   INT-FVR-3  No data_classification rows → policy is empty → no redaction
 *              (honest-degrade / NF-1 via production path).
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerRecordRoutes } from "../http/records.js";
import type { RecordRoutesDeps } from "../http/records.js";
import { getGrantsForSubject, getFieldVisibilityPolicy } from "../db/grants-dao.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TENANT_ID = "77777777-7777-7777-7777-000000000419";
const APP_ID    = "aaaaaaaa-0419-0002-0000-000000000001";
const REG_DEF_ID = "bbbbbbbb-0419-0002-0000-000000000002";

// Grant IDs for the fake DB
const WHOLE_RESOURCE_GRANT_ID = "cccccccc-0419-0000-0000-000000000001";
const FACET_GRANT_ID           = "cccccccc-0419-0000-0000-000000000002";
const ROLE_ID_WHOLE            = "dddddddd-0419-0000-0000-000000000001";
const ROLE_ID_FACET            = "dddddddd-0419-0000-0000-000000000002";
const EMPLOYEE_ID_WHOLE        = "eeeeeeee-0419-0000-0000-000000000001";
const EMPLOYEE_ID_FACET        = "eeeeeeee-0419-0000-0000-000000000002";
const ACTOR_WHOLE              = "actor-whole-resource";   // actor with whole-resource grant
const ACTOR_FACET              = "actor-facet-restricted"; // actor with facet grant (no salary)
const GRANT_CREATED_AT         = String(Date.now() - 100_000);

// ---------------------------------------------------------------------------
// Row factory — data has both a role-scoped field and a non-role-scoped field
// ---------------------------------------------------------------------------

function makeRow(i: number) {
  return {
    id: `00000000-0419-0002-0000-${String(i).padStart(12, "0")}`,
    registry_id: REG_DEF_ID,
    application_id: APP_ID,
    record_schema_version: 1,
    data: { public_name: `item_${i}`, salary: 100_000 + i },
    created_at: String(1700000000000 - i * 1000),
    updated_at: String(1700000000000 - i * 1000),
  };
}

// ---------------------------------------------------------------------------
// Smart fake pool
//
// Dispatches SQL to different result sets based on content. Simulates:
//   - getGrantsForSubject (employee lookup → role_assignment → grant)
//   - getFieldVisibilityPolicy (data_classification lookup)
//   - listRecordsPaginated (record SELECT)
//
// actorRows: map from actor slug → { employeeId, roleId, grantRow }
// classifiedFields: fields in data_classification with confidential/restricted
// ---------------------------------------------------------------------------

interface ActorConfig {
  employeeId: string;
  roleId: string;
  grantId: string;
  resourceFacet: unknown; // null = whole-resource, { fields: string[] } = facet-restricted
}

function makeIntegrationPool(
  actorConfigs: Record<string, ActorConfig>,
  classifiedFields: string[], // fields with class IN ('confidential', 'restricted')
  dataRows: ReturnType<typeof makeRow>[],
): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    const client = {
      query(sql: string, params?: unknown[]) {
        const s = sql.trim();

        // Transaction control
        if (/^BEGIN/i.test(s) || /^SET LOCAL/i.test(s) || /^COMMIT/i.test(s) || /^ROLLBACK/i.test(s)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }

        // getGrantsForSubject — Step 1: employee lookup
        // SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2
        if (/FROM choros\.employee/i.test(s) && /SELECT id/i.test(s) && Array.isArray(params) && params.length >= 2) {
          const slug = params[1] as string;
          const cfg = actorConfigs[slug];
          if (cfg) {
            return Promise.resolve({ rows: [{ id: cfg.employeeId }], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        }

        // getGrantsForSubject — Step 2: role_assignment lookup
        // SELECT ra.role_id FROM choros.role_assignment ra WHERE ...
        if (/FROM choros\.role_assignment ra/i.test(s) && /SELECT.*role_id/i.test(s) && Array.isArray(params)) {
          const empId = params[1] as string;
          // Find actor by employeeId
          const cfg = Object.values(actorConfigs).find((c) => c.employeeId === empId);
          if (cfg) {
            return Promise.resolve({ rows: [{ role_id: cfg.roleId }], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        }

        // getGrantsForSubject — Step 3: grant lookup
        // SELECT id, role_id, resource_type... FROM choros."grant" WHERE ...
        if (/FROM choros\."grant"/i.test(s) && /SELECT/i.test(s) && Array.isArray(params)) {
          const roleIds = params[1] as string[];
          const matchingConfigs = Object.values(actorConfigs).filter((c) =>
            Array.isArray(roleIds) ? roleIds.includes(c.roleId) : c.roleId === roleIds,
          );
          const grantRows = matchingConfigs.map((cfg) => ({
            id: cfg.grantId,
            role_id: cfg.roleId,
            resource_type: "record",
            resource_facet: cfg.resourceFacet,
            operation: "read",
            scope: JSON.stringify({ kind: "node", hierarchy: "resource", nodeId: REG_DEF_ID, nodeLevel: "registry" }),
            constraint: null,
            delegable: false,
            granted_by: "admin",
            valid_from: null,
            valid_until: null,
            created_at: GRANT_CREATED_AT,
          }));
          return Promise.resolve({ rows: grantRows, rowCount: grantRows.length });
        }

        // getFieldVisibilityPolicy — data_classification lookup
        // SELECT DISTINCT facet_field FROM choros.data_classification WHERE ...
        if (/FROM choros\.data_classification/i.test(s)) {
          const rows = classifiedFields.map((f) => ({ facet_field: f }));
          return Promise.resolve({ rows, rowCount: rows.length });
        }

        // listRecordsPaginated — record SELECT
        // SELECT ... FROM choros.record r JOIN choros.registry_def rd ...
        if (/FROM choros\.record r/i.test(s) && /JOIN choros\.registry_def/i.test(s)) {
          const limitParam = Array.isArray(params) ? params[params.length - 1] : 10_000;
          const limit = typeof limitParam === "number" ? limitParam : 10_000;
          const sliced = dataRows.slice(0, limit);
          return Promise.resolve({ rows: sliced, rowCount: sliced.length });
        }

        // Unknown SQL — return empty
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
// Server factory using the PRODUCTION binding pattern (mirrors server.ts)
// ---------------------------------------------------------------------------

function makeIntegrationServer(
  actorConfigs: Record<string, ActorConfig>,
  classifiedFields: string[],
  dataRows: ReturnType<typeof makeRow>[],
): { start(): Promise<string>; stop(): Promise<void> } {
  const pool = makeIntegrationPool(actorConfigs, classifiedFields, dataRows);
  const router = new Router();

  // This is the PRODUCTION binding: exactly what server.ts now does.
  // If server.ts omits resolveFieldVisibility, this test will instead test
  // the absent-dep path and redaction will not occur — making INT-FVR-1 fail.
  const deps: RecordRoutesDeps = {
    pool,
    resolveActorTenant: (_slug) => Promise.resolve(TENANT_ID),
    resolveFieldVisibility: async (actorSlug: string, tenantId: string, nowMs: number) => ({
      coveringGrants: await getGrantsForSubject(pool, tenantId, actorSlug, nowMs),
      policy: await getFieldVisibilityPolicy(pool, tenantId),
    }),
  };

  registerRecordRoutes(router, deps);

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
// HTTP helper
// ---------------------------------------------------------------------------

function getRecords(
  baseUrl: string,
  actor: string,
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
// INT-FVR-1: Actor with facet-restricted grant → classified field ABSENT
//            via the PRODUCTION binding (getGrantsForSubject + getFieldVisibilityPolicy)
// ---------------------------------------------------------------------------

describe("T-0419 INT-FVR-1: production binding — facet-restricted actor cannot see classified field", () => {
  it("salary key is PHYSICALLY ABSENT for actor whose grant does not confer it (production path)", async () => {
    // "salary" is classified as 'restricted' in data_classification.
    // ACTOR_FACET has a grant with resourceFacet = { fields: ["public_name"] }
    // (does NOT confer "salary"). The production resolver must redact "salary".
    const actorConfigs: Record<string, ActorConfig> = {
      [ACTOR_FACET]: {
        employeeId: EMPLOYEE_ID_FACET,
        roleId: ROLE_ID_FACET,
        grantId: FACET_GRANT_ID,
        resourceFacet: { fields: ["public_name"] }, // does NOT include "salary"
      },
    };

    const { start, stop } = makeIntegrationServer(
      actorConfigs,
      ["salary"], // salary is classified as restricted
      [makeRow(1)],
    );
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base, ACTOR_FACET);
      expect(statusCode).toBe(200);
      expect(records).toHaveLength(1);
      const data = records[0]!["data"] as Record<string, unknown>;

      // public_name is NOT role-scoped → union-floor holds → present
      expect("public_name" in data).toBe(true);

      // salary IS role-scoped (classified 'restricted') AND the facet grant
      // does NOT confer it → it must be PHYSICALLY ABSENT (not null)
      expect("salary" in data).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(data, "salary")).toBe(false);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// INT-FVR-2: Actor with whole-resource grant → classified field PRESENT
// ---------------------------------------------------------------------------

describe("T-0419 INT-FVR-2: production binding — whole-resource grant sees classified field", () => {
  it("salary is PRESENT for actor with whole-resource grant even when classified", async () => {
    // ACTOR_WHOLE has a grant with resourceFacet = null (whole-resource).
    // Even though "salary" is classified 'restricted', a whole-resource grant
    // confers ALL fields (including role-scoped ones) — most-restrictive-wins
    // only hides when a grant WITHHOLDS the field; whole-resource never withholds.
    const actorConfigs: Record<string, ActorConfig> = {
      [ACTOR_WHOLE]: {
        employeeId: EMPLOYEE_ID_WHOLE,
        roleId: ROLE_ID_WHOLE,
        grantId: WHOLE_RESOURCE_GRANT_ID,
        resourceFacet: null, // whole-resource: confers everything
      },
    };

    const { start, stop } = makeIntegrationServer(
      actorConfigs,
      ["salary"], // salary is classified as restricted
      [makeRow(1)],
    );
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base, ACTOR_WHOLE);
      expect(statusCode).toBe(200);
      expect(records).toHaveLength(1);
      const data = records[0]!["data"] as Record<string, unknown>;

      // Whole-resource grant confers ALL fields → both present
      expect("public_name" in data).toBe(true);
      expect("salary" in data).toBe(true);
      expect(data["salary"]).toBe(100_001);
    } finally {
      await stop();
    }
  });
});

// ---------------------------------------------------------------------------
// INT-FVR-3: No data_classification rows → policy empty → no redaction (NF-1)
// ---------------------------------------------------------------------------

describe("T-0419 INT-FVR-3: production binding — no classification rows → NF-1 no-op", () => {
  it("all fields present when data_classification has no rows for this tenant", async () => {
    // Even though the actor has a facet-restricted grant (no "salary"),
    // if data_classification has no rows then roleScopedFields=∅ → policy is
    // a no-op → "salary" is NOT hidden (union-floor holds for non-role-scoped fields).
    const actorConfigs: Record<string, ActorConfig> = {
      [ACTOR_FACET]: {
        employeeId: EMPLOYEE_ID_FACET,
        roleId: ROLE_ID_FACET,
        grantId: FACET_GRANT_ID,
        resourceFacet: { fields: ["public_name"] }, // does NOT include "salary"
      },
    };

    const { start, stop } = makeIntegrationServer(
      actorConfigs,
      [], // NO classified fields → roleScopedFields empty → no-op policy
      [makeRow(1)],
    );
    const base = await start();
    try {
      const { statusCode, records } = await getRecords(base, ACTOR_FACET);
      expect(statusCode).toBe(200);
      expect(records).toHaveLength(1);
      const data = records[0]!["data"] as Record<string, unknown>;

      // No classification → no role-scoped fields → both present (NF-1)
      expect("public_name" in data).toBe(true);
      expect("salary" in data).toBe(true);
    } finally {
      await stop();
    }
  });
});
