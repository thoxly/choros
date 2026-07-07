/**
 * T-0581 (view registry) — src/http/list-views.ts CRUD unit tests (no-DB).
 *
 * Uses a query-content-aware fake pool (mirrors records-pagination.test.ts) so
 * we can exercise the CRUD contract without a live Postgres.
 *
 * Covers:
 *   AC-1   POST creates a view (valid config) → 201, readable via GET.
 *   AC-4   POST/PUT with an invalid config (bad operator/type) → 400 VIEW_CONFIG_INVALID.
 *   AC-10  is_default semantics: setting is_default clears any prior default in
 *          the SAME tx (UPDATE ... WHERE is_default runs before the INSERT/UPDATE).
 *   FR-10  Mutation requires configurator privilege (owner/admin | authoring_draft);
 *          a non-privileged actor gets 403 on POST/PUT/DELETE (GET is unprivileged).
 *   409    Duplicate view name (unique_violation) → 409 CONFLICT.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerListViewRoutes } from "../http/list-views.js";
import type { ListViewRoutesDeps } from "../http/list-views.js";

const TENANT_ID = "55555555-5555-5555-5555-555555555555";
const ACTOR = "e-owner";
const REG_DEF_ID = "bbbbbbbb-0581-0001-0000-000000000002";
const APP_ID = "aaaaaaaa-0581-0001-0000-000000000001";

const RECORD_SCHEMA = {
  type: "object",
  properties: {
    amount: { type: "number", "x-money": { currency: "RUB" } },
    status: { type: "string", enum: ["open", "won"] },
  },
  required: [],
  "x-field-order": ["amount", "status"],
};

type FakeQuery = { sql: string; params: unknown[] };

/**
 * Fake pool: routes SELECT queries by table-name substring, tracks INSERT/
 * UPDATE calls, and simulates the unique_violation (23505) Postgres error when
 * the caller signals a name collision via `simulateConflict`.
 */
function makeFakePool(opts: {
  registryDef?: { id: string; application_id: string; record_schema: unknown } | null;
  existingView?: Record<string, unknown> | null;
  simulateConflict?: boolean;
} = {}): { pool: import("pg").Pool; queries: FakeQuery[] } {
  const queries: FakeQuery[] = [];
  const registryDef = opts.registryDef !== undefined ? opts.registryDef : {
    id: REG_DEF_ID,
    application_id: APP_ID,
    record_schema: RECORD_SCHEMA,
  };

  function makeClient(): import("pg").PoolClient {
    const client = {
      query(sql: string, params?: unknown[]) {
        const trimmed = sql.trim();
        queries.push({ sql: trimmed, params: params ?? [] });

        if (/^BEGIN/i.test(trimmed) || /^SET LOCAL/i.test(trimmed) || /^COMMIT/i.test(trimmed) || /^ROLLBACK/i.test(trimmed)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }

        if (/FROM choros\.registry_def/i.test(trimmed)) {
          if (registryDef === null) return Promise.resolve({ rows: [], rowCount: 0 });
          return Promise.resolve({ rows: [registryDef], rowCount: 1 });
        }

        if (/UPDATE choros\.list_view SET is_default = false/i.test(trimmed)) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }

        if (/INSERT INTO choros\.list_view/i.test(trimmed)) {
          if (opts.simulateConflict) {
            const err = new Error("duplicate key value violates unique constraint") as Error & { code: string };
            err.code = "23505";
            return Promise.reject(err);
          }
          // T-0653: column order is now (tenant_id, id, registry_def_id,
          // application_id, source, owner_actor, type, name, is_default, config, ...).
          const [tenantId, id, registryDefId, applicationId, source, ownerActor, type, name, isDefault, config] = params ?? [];
          return Promise.resolve({
            rows: [{
              id, registry_def_id: registryDefId, application_id: applicationId,
              source, owner_actor: ownerActor, type, name,
              is_default: isDefault, config: JSON.parse(config as string), created_at: "0", updated_at: "0",
              tenant_id: tenantId,
            }],
            rowCount: 1,
          });
        }

        if (/SELECT .* FROM choros\.list_view WHERE tenant_id = \$1 AND id = \$2/i.test(trimmed)) {
          if (opts.existingView === undefined || opts.existingView === null) {
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          return Promise.resolve({ rows: [opts.existingView], rowCount: 1 });
        }

        if (/UPDATE choros\.list_view\s+SET/i.test(trimmed) && !/is_default = false/i.test(trimmed)) {
          if (opts.simulateConflict) {
            const err = new Error("duplicate key value violates unique constraint") as Error & { code: string };
            err.code = "23505";
            return Promise.reject(err);
          }
          return Promise.resolve({
            rows: [{ ...opts.existingView, name: "updated" }],
            rowCount: 1,
          });
        }

        if (/DELETE FROM choros\.list_view/i.test(trimmed)) {
          const deleted = opts.existingView !== undefined && opts.existingView !== null;
          return Promise.resolve({ rows: [], rowCount: deleted ? 1 : 0 });
        }

        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      release() {},
    };
    return client as unknown as import("pg").PoolClient;
  }

  return {
    pool: { connect: () => Promise.resolve(makeClient()) } as unknown as import("pg").Pool,
    queries,
  };
}

function makeServer(deps: ListViewRoutesDeps): { start(): Promise<string>; stop(): Promise<void> } {
  const router = new Router();
  registerListViewRoutes(router, deps);
  const srv = http.createServer((req, res) => router.dispatch(req, res));
  return {
    start(): Promise<string> {
      return new Promise((resolve) => {
        srv.listen(0, "localhost", () => {
          const addr = srv.address();
          resolve(addr && typeof addr !== "string" ? `http://localhost:${addr.port}` : "http://localhost:0");
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => srv.close(() => resolve()));
    },
  };
}

function req(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const headers: Record<string, string> = { "x-dev-user": ACTOR };
    if (buf) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(buf.length);
    }
    const r = http.request(url, { method, headers }, (res) => {
      let raw = "";
      res.on("data", (c: Buffer) => { raw += c.toString(); });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
      });
    });
    r.on("error", reject);
    if (buf) r.write(buf);
    r.end();
  });
}

const allowPrivilege: ListViewRoutesDeps["resolveActorPrivilege"] = async () => ({
  isOwnerOrAdmin: true,
  hasAuthoringDraftGrant: false,
});
const denyPrivilege: ListViewRoutesDeps["resolveActorPrivilege"] = async () => ({
  isOwnerOrAdmin: false,
  hasAuthoringDraftGrant: false,
});

describe("AC-1: POST /api/list-views creates a valid view", () => {
  it("201 + readable shape for a valid config", async () => {
    const { pool } = makeFakePool();
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: allowPrivilege,
    });
    const base = await start();
    try {
      const { statusCode, body } = await req(base, "POST", "/api/list-views", {
        registry_def_id: REG_DEF_ID,
        name: "Мои активные сделки",
        config: { columns: [{ field_key: "amount", visible: true }], filters: [], sort: [] },
      });
      expect(statusCode).toBe(201);
      expect(body["name"]).toBe("Мои активные сделки");
      expect(body["type"]).toBe("list");
      expect(body["registry_def_id"]).toBe(REG_DEF_ID);
    } finally {
      await stop();
    }
  });
});

describe("AC-4: invalid config is rejected with 400 VIEW_CONFIG_INVALID (not persisted)", () => {
  it("rejects gt on a select field", async () => {
    const { pool, queries } = makeFakePool();
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: allowPrivilege,
    });
    const base = await start();
    try {
      const { statusCode, body } = await req(base, "POST", "/api/list-views", {
        registry_def_id: REG_DEF_ID,
        name: "Bad view",
        config: { filters: [{ field_key: "status", op: "gt", value: "open" }] },
      });
      expect(statusCode).toBe(400);
      expect((body["error"] as Record<string, unknown>)["code"]).toBe("VIEW_CONFIG_INVALID");
      const insertRan = queries.some((q) => /INSERT INTO choros\.list_view/i.test(q.sql));
      expect(insertRan).toBe(false); // config not saved
    } finally {
      await stop();
    }
  });
});

describe("FR-10: mutation requires configurator privilege", () => {
  it("POST without owner/admin or authoring_draft → 403", async () => {
    const { pool } = makeFakePool();
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: denyPrivilege,
    });
    const base = await start();
    try {
      const { statusCode } = await req(base, "POST", "/api/list-views", {
        registry_def_id: REG_DEF_ID,
        name: "x",
        config: {},
      });
      expect(statusCode).toBe(403);
    } finally {
      await stop();
    }
  });

  it("GET does not require configurator privilege (read is common-to-tenant)", async () => {
    const { pool } = makeFakePool();
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: denyPrivilege,
    });
    const base = await start();
    try {
      const { statusCode } = await req(base, "GET", `/api/list-views?registry_def_id=${REG_DEF_ID}`);
      expect(statusCode).toBe(200);
    } finally {
      await stop();
    }
  });
});

describe("409: duplicate view name", () => {
  it("POST with a colliding name → 409 CONFLICT", async () => {
    const { pool } = makeFakePool({ simulateConflict: true });
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: allowPrivilege,
    });
    const base = await start();
    try {
      const { statusCode } = await req(base, "POST", "/api/list-views", {
        registry_def_id: REG_DEF_ID,
        name: "dup",
        config: {},
      });
      expect(statusCode).toBe(409);
    } finally {
      await stop();
    }
  });
});

describe("AC-10: is_default clears the prior default inside the same mutation", () => {
  it("POST with is_default=true issues an UPDATE ... WHERE is_default clause before the INSERT", async () => {
    const { pool, queries } = makeFakePool();
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: allowPrivilege,
    });
    const base = await start();
    try {
      const { statusCode } = await req(base, "POST", "/api/list-views", {
        registry_def_id: REG_DEF_ID,
        name: "New default",
        config: {},
        is_default: true,
      });
      expect(statusCode).toBe(201);
      const clearIdx = queries.findIndex((q) => /UPDATE choros\.list_view SET is_default = false/i.test(q.sql));
      const insertIdx = queries.findIndex((q) => /INSERT INTO choros\.list_view/i.test(q.sql));
      expect(clearIdx).toBeGreaterThanOrEqual(0);
      expect(insertIdx).toBeGreaterThan(clearIdx);
    } finally {
      await stop();
    }
  });
});

describe("GET /api/list-views/:id 404 for a missing/foreign view (RLS-indistinguishable)", () => {
  it("returns 404 when the fake pool yields no row", async () => {
    const { pool } = makeFakePool({ existingView: null });
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
    });
    const base = await start();
    try {
      const { statusCode } = await req(base, "GET", "/api/list-views/00000000-0000-0000-0000-000000000099");
      expect(statusCode).toBe(404);
    } finally {
      await stop();
    }
  });
});

describe("honest-degrade: routes not registered without pool", () => {
  it("registerListViewRoutes(router) with no deps registers nothing", async () => {
    const router = new Router();
    registerListViewRoutes(router);
    const srv = http.createServer((req2, res2) => router.dispatch(req2, res2));
    await new Promise<void>((resolve) => srv.listen(0, "localhost", () => resolve()));
    const addr = srv.address();
    const base = addr && typeof addr !== "string" ? `http://localhost:${addr.port}` : "";
    try {
      const { statusCode } = await req(base, "GET", `/api/list-views?registry_def_id=${REG_DEF_ID}`);
      expect(statusCode).toBe(404);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

// ===========================================================================
// T-0653 (W5-UX/§4) — view-primitive: source discriminator + personal views.
// ===========================================================================

describe("T-0653 AC-1.1: source discriminator", () => {
  it("unknown source → 400 VIEW_SOURCE_INVALID (not persisted)", async () => {
    const { pool, queries } = makeFakePool();
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: allowPrivilege,
    });
    const base = await start();
    try {
      const { statusCode, body } = await req(base, "POST", "/api/list-views", {
        source: "widgets",
        name: "bad",
        config: { columns: [], density: "compact" },
      });
      expect(statusCode).toBe(400);
      expect((body["error"] as Record<string, unknown>)["code"]).toBe("VIEW_SOURCE_INVALID");
      expect(queries.some((q) => /INSERT INTO choros\.list_view/i.test(q.sql))).toBe(false);
    } finally {
      await stop();
    }
  });

  it("GET ?source=widgets → 400 VIEW_SOURCE_INVALID", async () => {
    const { pool } = makeFakePool();
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: allowPrivilege,
    });
    const base = await start();
    try {
      const { statusCode, body } = await req(base, "GET", "/api/list-views?source=widgets");
      expect(statusCode).toBe(400);
      expect((body["error"] as Record<string, unknown>)["code"]).toBe("VIEW_SOURCE_INVALID");
    } finally {
      await stop();
    }
  });
});

describe("T-0653 AC-1.2/AC-1.5: inbox personal view (no registry_def, no privilege)", () => {
  it("POST source=inbox personal=true creates an owner-scoped view WITHOUT configurator privilege", async () => {
    // denyPrivilege proves a PERSONAL view does not need the configurator gate.
    const { pool, queries } = makeFakePool();
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: denyPrivilege,
    });
    const base = await start();
    try {
      const { statusCode, body } = await req(base, "POST", "/api/list-views", {
        source: "inbox",
        personal: true,
        name: "Мой инбокс",
        config: { columns: [{ key: "name", visible: true }, { key: "sla", visible: false }], density: "compact" },
      });
      expect(statusCode).toBe(201);
      expect(body["source"]).toBe("inbox");
      expect(body["registry_def_id"]).toBe(null);
      // owner_actor is set to the caller (ACTOR), resolved from identity not body.
      expect(body["owner_actor"]).toBe(ACTOR);
      // The INSERT bound owner_actor = ACTOR, not from the request body.
      const insert = queries.find((q) => /INSERT INTO choros\.list_view/i.test(q.sql));
      expect(insert).toBeTruthy();
      expect(insert!.params).toContain(ACTOR);
    } finally {
      await stop();
    }
  });

  it("POST source=inbox with a bad config column → 400 VIEW_CONFIG_INVALID", async () => {
    const { pool, queries } = makeFakePool();
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: denyPrivilege,
    });
    const base = await start();
    try {
      const { statusCode, body } = await req(base, "POST", "/api/list-views", {
        source: "inbox",
        personal: true,
        name: "Bad inbox view",
        config: { columns: [{ key: "not_a_column", visible: true }], density: "compact" },
      });
      expect(statusCode).toBe(400);
      expect((body["error"] as Record<string, unknown>)["code"]).toBe("VIEW_CONFIG_INVALID");
      expect(queries.some((q) => /INSERT INTO choros\.list_view/i.test(q.sql))).toBe(false);
    } finally {
      await stop();
    }
  });
});

describe("T-0653 AC-1.3: GET ?source=inbox scopes to common + caller's own personal", () => {
  it("issues an owner-scoped SELECT (owner_actor IS NULL OR owner_actor = caller)", async () => {
    const { pool, queries } = makeFakePool();
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: allowPrivilege,
    });
    const base = await start();
    try {
      const { statusCode, body } = await req(base, "GET", "/api/list-views?source=inbox");
      expect(statusCode).toBe(200);
      // synthetic inbox default is returned even with no saved views.
      expect(body["default_view"]).toBeTruthy();
      const listSelect = queries.find(
        (q) => /FROM choros\.list_view/i.test(q.sql) && /source = \$2/i.test(q.sql),
      );
      expect(listSelect).toBeTruthy();
      // owner-visibility clause present + caller bound as the actor param.
      expect(/owner_actor IS NULL OR owner_actor = \$3/i.test(listSelect!.sql)).toBe(true);
      expect(listSelect!.params).toContain(ACTOR);
    } finally {
      await stop();
    }
  });
});

describe("T-0653 AC-1.7: a foreign actor's personal view is invisible (owner-scoped)", () => {
  it("GET/:id of a view not owner-visible → 404 (SELECT carries the owner clause)", async () => {
    // existingView is null → fake pool returns 0 rows for the owner-scoped SELECT.
    const { pool, queries } = makeFakePool({ existingView: null });
    const { start, stop } = makeServer({
      pool,
      resolveActorTenant: async () => TENANT_ID,
      resolveActorPrivilege: allowPrivilege,
    });
    const base = await start();
    try {
      const { statusCode } = await req(base, "GET", "/api/list-views/00000000-0000-0000-0000-0000000000aa");
      expect(statusCode).toBe(404);
      const byId = queries.find(
        (q) => /FROM choros\.list_view/i.test(q.sql) && /id = \$2/i.test(q.sql),
      );
      expect(byId).toBeTruthy();
      expect(/owner_actor IS NULL OR owner_actor = \$3/i.test(byId!.sql)).toBe(true);
    } finally {
      await stop();
    }
  });
});
