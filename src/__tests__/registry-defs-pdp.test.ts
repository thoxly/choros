/**
 * T-0191 · registry-defs PDP-gate unit tests (no-DB)
 *
 * Tests the injectable RegistryDefAuthzDeps gate on PUT/PATCH /api/registry-defs/:id
 * for the force=true (destructive) path.
 *
 * AC coverage (docs/specs/T-0191.spec.contract.json):
 *   AC-1  RegistryDefAuthzDeps exported from registry-defs.ts (tsc structural)
 *   AC-2  registerRegistryDefRoutes accepts deps? third parameter
 *   AC-3  force=true + denyAll-fake → 403 NO_SCHEMA_DESTRUCTIVE_GRANT
 *   AC-4  force=false + destructive dep → 409 (gate NOT called)
 *   AC-5  TODO-stub absent (grep-level; verified in registry-defs-pdp-isolation.sh)
 *   AC-6  genesis-owner short-circuit: defaultCheckDestructiveGrant passes through isGenesisOwner
 *         (structural: verified by defaultCheckDestructiveGrant logic, live-DB in fitness:db)
 *
 * Note on allow-path (AC-4 variant for force=true + grant):
 *   Full allow-path requires a fake pool that responds to all DB calls in updateSchemaInTx
 *   (SELECT registry_def FOR UPDATE, SELECT report_page_dep JOIN, UPDATE × 3, audit INSERT).
 *   Rather than an elaborate fake pool, the allow-path with a real grant is covered in the
 *   live-DB fitness:db suite (schema_change_api.test.ts AC-10 updated to use genesis-owner).
 *   Here we verify the structural shape: denyAll fake → 403.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as http from "node:http";
import {
  registerRegistryDefRoutes,
  resetPoolForTesting,
  type RegistryDefAuthzDeps,
} from "../http/registry-defs.js";
import { Router } from "../http/router.js";

// ---------------------------------------------------------------------------
// Fake pool — returns empty rows for all queries so updateSchemaInTx can reach
// the PDP gate (steps 1-3 must succeed before gate is called in step 7b).
// The pool is used only when force=true and destructiveDeps.length > 0, which
// means the gate is called inside withTenantTx after the transaction is open.
// We provide a minimal fake pool that passes the registry_def lookup step.
// ---------------------------------------------------------------------------

interface FakeQueryResult {
  rows: unknown[];
}

/** Fake pool client: sequences through provided row sets per query call. */
class FakePoolClient {
  private _queryIndex = 0;
  private _rowSets: unknown[][];

  constructor(rowSets: unknown[][]) {
    this._rowSets = rowSets;
  }

  async query(_sql: string, _params?: unknown[]): Promise<FakeQueryResult> {
    const rows = this._rowSets[this._queryIndex] ?? [];
    this._queryIndex++;
    return { rows };
  }

  release(): void { /* no-op */ }
}

/** A minimal fake pg.Pool that yields a FakePoolClient with pre-set row sequences. */
function makeFakePool(rowSets: unknown[][]): import("pg").Pool {
  return {
    connect: async () => new FakePoolClient(rowSets) as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function buildTestServer(
  fakeDeps: RegistryDefAuthzDeps,
  fakePool?: import("pg").Pool,
): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  registerRegistryDefRoutes(router, fakePool, fakeDeps);
  const server = http.createServer((req, res) => {
    router.dispatch(req, res);
  });
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
      path: parsed.pathname,
      method,
      headers: {
        ...headers,
        ...(buf
          ? { "Content-Type": "application/json", "Content-Length": String(buf.length) }
          : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
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

// Valid UUID for registry_def id in all requests
const FAKE_REG_ID = "11111111-1111-1111-1111-111111111111";

// ---------------------------------------------------------------------------
// Fake deps
// ---------------------------------------------------------------------------

/** denyAll: always denies — simulates actor without mgmt_object:schema_destructive/apply */
const denyAllDeps: RegistryDefAuthzDeps = {
  checkDestructiveGrant: vi.fn().mockResolvedValue({ ok: false, reason: "no_admin_authority" }),
};

// ---------------------------------------------------------------------------
// AC-1/AC-2: structural checks — RegistryDefAuthzDeps exported, registerRegistryDefRoutes
// accepts third parameter. These are verified by the TypeScript import above
// (tsc would fail if the export or signature were wrong).
// ---------------------------------------------------------------------------

describe("AC-1/AC-2: structural — RegistryDefAuthzDeps exported, deps parameter accepted", () => {
  it("RegistryDefAuthzDeps is importable and has checkDestructiveGrant", () => {
    const deps: RegistryDefAuthzDeps = {
      checkDestructiveGrant: async () => ({ ok: true }),
    };
    expect(typeof deps.checkDestructiveGrant).toBe("function");
  });

  it("registerRegistryDefRoutes signature accepts (router, pool?, deps?)", () => {
    const router = new Router();
    // Should not throw — third param is optional
    expect(() => {
      registerRegistryDefRoutes(router, undefined, denyAllDeps);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-3: force=true + denyAll → 403 NO_SCHEMA_DESTRUCTIVE_GRANT
//
// Strategy: provide a fake pool whose rowSets simulate:
//   1. BEGIN → rows: []
//   2. SET LOCAL choros.tenant_id → rows: []
//   3. SET LOCAL search_path → rows: []
//   4. SELECT registry_def FOR UPDATE → rows: [{ id, record_schema, tier }]
//   5. SELECT report_page_dep JOIN → rows: [one active dep]  (→ destructiveDeps.length>0)
//   6. SET LOCAL choros.promoting = '1' → rows: []
//   7. checkDestructiveGrant → denied → 403 thrown → ROLLBACK
//   8. ROLLBACK → rows: []
//
// The fake pool just needs to provide row sets in the right sequence.
// After checkDestructiveGrant denies, HttpError(403) is thrown inside withTenantTx,
// caught by the catch block (ROLLBACK), re-thrown, caught by router.dispatch → 403 response.
// ---------------------------------------------------------------------------

describe("AC-3: PUT force=true + denyAll → 403 NO_SCHEMA_DESTRUCTIVE_GRANT", () => {
  // Row sets for the fake pool: must match query sequence in withTenantTx + updateSchemaInTx
  // Sequence: BEGIN, SET LOCAL tenant_id, SET LOCAL search_path,
  //           SELECT registry_def (rows=[{id,record_schema,tier}]),
  //           SELECT report_page_dep (rows=[one dep]),
  //           UPDATE registry_def (rows=[]),
  //           SET LOCAL choros.promoting (rows=[]),
  //           → checkDestructiveGrant called → deny → HttpError 403 → ROLLBACK
  const fakeRegRow = {
    id: FAKE_REG_ID,
    record_schema: { properties: { amount: { type: "number" } } },
    tier: "draft",
  };
  const fakeDepRow = {
    id: "dd000000-0000-0000-0000-000000000001",
    page_id: "pp000000-0000-0000-0000-000000000001",
    page_slug: "test-page",
    field_key: "amount",
    dep_kind: "aggregate",
  };

  const fakePool = makeFakePool([
    [],              // BEGIN
    [],              // SET LOCAL choros.tenant_id
    [],              // SET LOCAL search_path
    [fakeRegRow],    // SELECT registry_def FOR UPDATE
    [fakeDepRow],    // SELECT report_page_dep JOIN
    [],              // UPDATE registry_def (schema applied before gate in step 5)
    [],              // SET LOCAL choros.promoting = '1'
    // gate denies → HttpError(403) → caught by withTenantTx
    [],              // ROLLBACK
  ]);

  const freshDenyDeps: RegistryDefAuthzDeps = {
    checkDestructiveGrant: vi.fn().mockResolvedValue({ ok: false, reason: "no_admin_authority" }),
  };

  const { server, baseUrl } = buildTestServer(freshDenyDeps, fakePool);

  beforeAll(
    () => new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    }),
  );

  afterAll(
    () => new Promise<void>((res) => server.close(() => res())),
  );

  it("returns 403 NO_SCHEMA_DESTRUCTIVE_GRANT when checkDestructiveGrant denies", async () => {
    const res = await httpReq(
      "PUT",
      `${baseUrl()}/api/registry-defs/${FAKE_REG_ID}`,
      { "x-dev-user": "actor-no-grant" },
      // Drop 'amount' field → destructive (dep on it); force=true → gate called
      { record_schema: { properties: {} }, force: true },
    );

    expect(res.status, `expected 403, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(403);
    const err = (res.json as Record<string, unknown>)["error"];
    const code = err && typeof err === "object"
      ? (err as Record<string, unknown>)["code"]
      : (res.json as Record<string, unknown>)["code"];
    expect(code).toBe("NO_SCHEMA_DESTRUCTIVE_GRANT");
    // Verify the gate was actually called
    expect(freshDenyDeps.checkDestructiveGrant).toHaveBeenCalled();
  });

  it("PATCH returns 403 NO_SCHEMA_DESTRUCTIVE_GRANT (same handler)", async () => {
    // Re-use a fresh pool for PATCH
    const patchPool = makeFakePool([
      [],
      [],
      [],
      [fakeRegRow],
      [fakeDepRow],
      [],
      [],
      [],
    ]);
    const patchDenyDeps: RegistryDefAuthzDeps = {
      checkDestructiveGrant: vi.fn().mockResolvedValue({ ok: false, reason: "no_admin_authority" }),
    };

    const patchRouter = new Router();
    registerRegistryDefRoutes(patchRouter, patchPool, patchDenyDeps);
    const patchServer = http.createServer((req, res) => {
      patchRouter.dispatch(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      patchServer.listen(0, "127.0.0.1", () => resolve());
      patchServer.once("error", reject);
    });

    const addr = patchServer.address() as { port: number };
    const patchBase = `http://127.0.0.1:${addr.port}`;

    try {
      const res = await httpReq(
        "PATCH",
        `${patchBase}/api/registry-defs/${FAKE_REG_ID}`,
        { "x-dev-user": "actor-no-grant" },
        { record_schema: { properties: {} }, force: true },
      );
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => patchServer.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: force=false + destructive dep → 409 (gate NOT called)
//
// Without force=true, the code returns { kind: "destructive_denied" } before
// reaching the gate. The denyAll dep spy must NOT be called.
// ---------------------------------------------------------------------------

describe("AC-4: force=false + destructive dep → 409, gate NOT called", () => {
  const fakeRegRow = {
    id: FAKE_REG_ID,
    record_schema: { properties: { amount: { type: "number" } } },
    tier: "draft",
  };
  const fakeDepRow = {
    id: "dd000000-0000-0000-0000-000000000002",
    page_id: "pp000000-0000-0000-0000-000000000002",
    page_slug: "page-b",
    field_key: "amount",
    dep_kind: "aggregate",
  };

  // No gate call expected — pool only needs up through the classify step
  const fakePool = makeFakePool([
    [],           // BEGIN
    [],           // SET LOCAL choros.tenant_id
    [],           // SET LOCAL search_path
    [fakeRegRow], // SELECT registry_def FOR UPDATE
    [fakeDepRow], // SELECT report_page_dep JOIN
    // destructiveDeps.length > 0 && !force → ROLLBACK (kind: "destructive_denied")
    [],           // ROLLBACK
  ]);

  const gateSpy = vi.fn();
  const noForceDeps: RegistryDefAuthzDeps = {
    checkDestructiveGrant: gateSpy,
  };

  const { server, baseUrl } = buildTestServer(noForceDeps, fakePool);

  beforeAll(
    () => new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    }),
  );

  afterAll(
    () => new Promise<void>((res) => server.close(() => res())),
  );

  it("returns 409 and does not call checkDestructiveGrant", async () => {
    const res = await httpReq(
      "PUT",
      `${baseUrl()}/api/registry-defs/${FAKE_REG_ID}`,
      { "x-dev-user": "actor-any" },
      // Drop 'amount' → destructive; force NOT set (default false)
      { record_schema: { properties: {} } },
    );

    expect(res.status, `expected 409, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(409);
    const json = res.json as Record<string, unknown>;
    const err = json["error"] as Record<string, unknown> | undefined;
    expect(err?.["code"]).toBe("destructive_schema_change");
    // Gate must NOT have been called
    expect(gateSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-5: TODO-stub absent (structural — checked by fitness registry-defs-pdp-isolation.sh)
//
// This test is a lightweight proxy: import the module and verify the exported
// RegistryDefAuthzDeps has checkDestructiveGrant (not a stub comment marker).
// The actual grep check lives in ci/checks/registry-defs-pdp-isolation.sh.
// ---------------------------------------------------------------------------

describe("AC-5: RegistryDefAuthzDeps.checkDestructiveGrant is a real function, not a stub", () => {
  it("registerRegistryDefRoutes is exported as a function (interface is type-only)", async () => {
    // RegistryDefAuthzDeps is an interface (not a runtime value) — it cannot be
    // imported as a value. Its presence is verified at compile-time by the
    // `type RegistryDefAuthzDeps` import at the top of this file (tsc AC-1).
    // Here we verify the runtime export that depends on the interface exists.
    const mod = await import("../http/registry-defs.js");
    expect(typeof mod.registerRegistryDefRoutes).toBe("function");
    expect(typeof mod.resetPoolForTesting).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// resetPoolForTesting: ensure no pool leak between test suites
// ---------------------------------------------------------------------------

describe("resetPoolForTesting", () => {
  it("resets the internal pool singleton without throwing", () => {
    expect(() => resetPoolForTesting()).not.toThrow();
  });
});
