/**
 * T-0558 — records LIST/GET sandbox-gate tests
 *
 * Verifies that the sandbox read gate (src/core/sandbox-gate.ts) is applied to the
 * record runtime read paths so DRAFT (sandbox) records — those of an application
 * still in the draft tier — are HIDDEN from a non-privileged caller, while published
 * records are unaffected and a privileged caller sees both.
 *
 * The gate is on the OWNING APPLICATION's tier (records inherit the app's sandbox
 * state) and is appended as an EXTRA `AND (a.tier = 'published')` for a non-privileged
 * caller (sandboxReadPredicate emits `TRUE` for a privileged one).
 *
 * Pure unit — no live DB. The fake pool returns rows tagged with an application tier
 * and HONOURS the appended sandbox predicate (it filters draft rows out when the SELECT
 * carries `a.tier = 'published'`), exactly as a real Postgres would. The privilege
 * resolver is injected (resolveSandboxPrivilege) so the privileged / unprivileged
 * branches are exercised without a live DB.
 *
 * Tests:
 *   SG-1  Unprivileged caller: published records visible, draft records HIDDEN (list)
 *   SG-2  Privileged caller (owner/admin): sees BOTH published AND draft records (list)
 *   SG-3  Privileged via authoring_draft grant: sees draft records (list)
 *   SG-4  Unprivileged GET of a draft record → 404 (honest-hide)
 *   SG-5  Privileged GET of a draft record → 200
 *   SG-6  Cross-tenant: actor in tenant A sees neither published NOR draft rows of
 *         tenant B (tenant isolation preserved — the predicate is ADDITIVE, never a
 *         replacement for the tenant scope)
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerRecordRoutes } from "../http/records.js";
import type { RecordRoutesDeps, ActorPrivilegeResolver } from "../http/records.js";
import type { ActorPrivilege } from "../db/sandbox-gate-dao.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ACTOR_A = "e-orlov";
const APP_ID = "aaaaaaaa-0558-0001-0000-000000000001";
const REG_DEF_ID = "bbbbbbbb-0558-0001-0000-000000000002";

// ---------------------------------------------------------------------------
// Row factory — `__tier` is the OWNING APPLICATION's tier (the fake pool uses it to
// emulate the appended `a.tier = 'published'` predicate). It is not part of the
// record's own columns; it is stripped before the row is returned to the handler.
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  registry_id: string;
  application_id: string;
  record_schema_version: number;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  record_schema?: unknown;
  created_by?: string | null;
  __tier: "draft" | "published";
  __tenant: string;
}

function makeRow(i: number, tier: "draft" | "published", tenant: string): RawRow {
  return {
    id: `00000000-0558-0000-0000-${String(i).padStart(12, "0")}`,
    registry_id: REG_DEF_ID,
    application_id: APP_ID,
    record_schema_version: 1,
    data: { name: `item_${i}`, _tier: tier },
    created_at: String(1700000000000 - i * 1000),
    updated_at: String(1700000000000 - i * 1000),
    record_schema: { type: "object" },
    created_by: ACTOR_A,
    __tier: tier,
    __tenant: tenant,
  };
}

function stripInternal(row: RawRow): Record<string, unknown> {
  const { __tier, __tenant, ...rest } = row;
  void __tier;
  void __tenant;
  return rest;
}

// ---------------------------------------------------------------------------
// Fake pool — honours the sandbox predicate + tenant scope the same way real PG does.
//
//  - A SELECT carrying `a.tier = 'published'` (the unprivileged predicate) returns
//    ONLY published rows; a SELECT carrying `TRUE` (privileged) returns all tiers.
//  - Rows are also tenant-filtered by the tenant_id param (params[0]) so the
//    cross-tenant isolation case is exercised (a foreign tenant's rows never match).
// ---------------------------------------------------------------------------

function makeFakePool(allRows: RawRow[]): import("pg").Pool {
  function makeClient(): import("pg").PoolClient {
    const client = {
      query(sql: string, params?: unknown[]) {
        if (/^BEGIN/i.test(sql) || /^SET LOCAL/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (/FROM choros\.record r/i.test(sql) && /SELECT/i.test(sql)) {
          const tenantParam = params?.[0];
          // Emulate RLS + the explicit r.tenant_id = $1 guard: only this tenant's rows.
          let rows = allRows.filter((r) => r.__tenant === tenantParam);
          // Emulate the appended sandbox predicate: `a.tier = 'published'` → published only.
          if (/a\.tier\s*=\s*'published'/i.test(sql)) {
            rows = rows.filter((r) => r.__tier === "published");
          }
          // Detail GET carries `AND r.id = $2` — narrow by id.
          if (/r\.id\s*=\s*\$2/i.test(sql)) {
            const idParam = params?.[1];
            rows = rows.filter((r) => r.id === idParam);
          }
          // List query fetches limit+1 rows; the last numeric param is the LIMIT.
          const limitParam = params?.[params.length - 1];
          const limit = typeof limitParam === "number" ? limitParam : 10_000;
          const sliced = rows.slice(0, limit).map(stripInternal);
          return Promise.resolve({ rows: sliced, rowCount: sliced.length });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      release() {},
    };
    return client as unknown as import("pg").PoolClient;
  }
  return {
    connect: async () => makeClient(),
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// Privilege resolver stubs
// ---------------------------------------------------------------------------

const UNPRIVILEGED: ActorPrivilege = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false };
const OWNER_ADMIN: ActorPrivilege = { isOwnerOrAdmin: true, hasAuthoringDraftGrant: false };
const AUTHORING_DRAFT: ActorPrivilege = { isOwnerOrAdmin: false, hasAuthoringDraftGrant: true };

function privResolver(priv: ActorPrivilege): ActorPrivilegeResolver {
  return async () => priv;
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

function buildServer(deps: RecordRoutesDeps): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  registerRecordRoutes(router, deps);
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
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method,
      headers,
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
    req.end();
  });
}

function makeDeps(rows: RawRow[], priv: ActorPrivilege, tenant: string = TENANT_A): RecordRoutesDeps {
  return {
    pool: makeFakePool(rows),
    resolveActorTenant: async () => tenant,
    resolveSandboxPrivilege: privResolver(priv),
  };
}

async function withServer(
  deps: RecordRoutesDeps,
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

// ---------------------------------------------------------------------------
// Fixtures: two published + two draft records in tenant A.
// ---------------------------------------------------------------------------

const PUBLISHED_ROWS = [makeRow(1, "published", TENANT_A), makeRow(2, "published", TENANT_A)];
const DRAFT_ROWS = [makeRow(3, "draft", TENANT_A), makeRow(4, "draft", TENANT_A)];
const ALL_ROWS_A = [...PUBLISHED_ROWS, ...DRAFT_ROWS];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("records sandbox-gate: LIST visibility", () => {
  it("SG-1 unprivileged caller sees published records, NOT draft", async () => {
    await withServer(makeDeps(ALL_ROWS_A, UNPRIVILEGED), async (base) => {
      const r = await httpReq("GET", `${base}/api/records`, { "x-dev-user": ACTOR_A });
      expect(r.status).toBe(200);
      const body = r.json as { records: Array<{ id: string }> };
      const ids = body.records.map((x) => x.id);
      expect(ids).toContain(PUBLISHED_ROWS[0]!.id);
      expect(ids).toContain(PUBLISHED_ROWS[1]!.id);
      expect(ids).not.toContain(DRAFT_ROWS[0]!.id);
      expect(ids).not.toContain(DRAFT_ROWS[1]!.id);
    });
  });

  it("SG-2 privileged owner/admin sees BOTH published and draft", async () => {
    await withServer(makeDeps(ALL_ROWS_A, OWNER_ADMIN), async (base) => {
      const r = await httpReq("GET", `${base}/api/records`, { "x-dev-user": ACTOR_A });
      expect(r.status).toBe(200);
      const body = r.json as { records: Array<{ id: string }> };
      const ids = body.records.map((x) => x.id);
      expect(ids).toContain(PUBLISHED_ROWS[0]!.id);
      expect(ids).toContain(DRAFT_ROWS[0]!.id);
      expect(ids).toContain(DRAFT_ROWS[1]!.id);
    });
  });

  it("SG-3 privileged via authoring_draft grant sees draft", async () => {
    await withServer(makeDeps(ALL_ROWS_A, AUTHORING_DRAFT), async (base) => {
      const r = await httpReq("GET", `${base}/api/records`, { "x-dev-user": ACTOR_A });
      expect(r.status).toBe(200);
      const body = r.json as { records: Array<{ id: string }> };
      const ids = body.records.map((x) => x.id);
      expect(ids).toContain(DRAFT_ROWS[0]!.id);
    });
  });
});

describe("records sandbox-gate: GET detail visibility", () => {
  it("SG-4 unprivileged GET of a draft record → 404", async () => {
    await withServer(makeDeps(ALL_ROWS_A, UNPRIVILEGED), async (base) => {
      const r = await httpReq("GET", `${base}/api/records/${DRAFT_ROWS[0]!.id}`, { "x-dev-user": ACTOR_A });
      expect(r.status).toBe(404);
    });
  });

  it("SG-4b unprivileged GET of a published record → 200", async () => {
    await withServer(makeDeps(ALL_ROWS_A, UNPRIVILEGED), async (base) => {
      const r = await httpReq("GET", `${base}/api/records/${PUBLISHED_ROWS[0]!.id}`, { "x-dev-user": ACTOR_A });
      expect(r.status).toBe(200);
    });
  });

  it("SG-5 privileged GET of a draft record → 200", async () => {
    await withServer(makeDeps(ALL_ROWS_A, OWNER_ADMIN), async (base) => {
      const r = await httpReq("GET", `${base}/api/records/${DRAFT_ROWS[0]!.id}`, { "x-dev-user": ACTOR_A });
      expect(r.status).toBe(200);
    });
  });
});

describe("records sandbox-gate: tenant isolation preserved (T-0013)", () => {
  it("SG-6 actor in tenant A sees neither published NOR draft rows of tenant B", async () => {
    const tenantBRows = [makeRow(10, "published", TENANT_B), makeRow(11, "draft", TENANT_B)];
    const rows = [...ALL_ROWS_A, ...tenantBRows];
    // Actor A resolves to TENANT_A; even as a privileged owner, the additive sandbox
    // predicate never relaxes the tenant scope — tenant B rows must NOT appear.
    await withServer(makeDeps(rows, OWNER_ADMIN, TENANT_A), async (base) => {
      const r = await httpReq("GET", `${base}/api/records`, { "x-dev-user": ACTOR_A });
      expect(r.status).toBe(200);
      const body = r.json as { records: Array<{ id: string }> };
      const ids = body.records.map((x) => x.id);
      expect(ids).not.toContain(tenantBRows[0]!.id); // tenant B published — hidden by tenant scope
      expect(ids).not.toContain(tenantBRows[1]!.id); // tenant B draft — hidden by tenant scope
      // Sanity: tenant A rows still present.
      expect(ids).toContain(PUBLISHED_ROWS[0]!.id);
    });
  });
});
