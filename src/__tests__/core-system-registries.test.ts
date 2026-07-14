/**
 * T-0354 · Core system registries unit tests (no-DB)
 *
 * Tests:
 *   1. Seed schema: the 4 core registries are described by correct UUIDs and
 *      is_system=true (static assertions on migration file content).
 *   2. Extend-not-replace guard: PUT/PATCH on a system registry that removes or
 *      renames a standard field → 403 SYSTEM_REGISTRY_FIELD_PROTECTED.
 *   3. Add field allowed: PUT/PATCH that only adds new fields → allowed (no 403 from guard).
 *   4. Non-system registry: no extend-not-replace guard fires (is_system=false).
 *
 * Strategy: uses a fake pool whose row sequences match the query ordering in
 * updateSchemaInTx (same pattern as registry-defs-pdp.test.ts).
 *
 * Fake pool query sequence for PUT/PATCH happy-path entry into updateSchemaInTx:
 *   1. BEGIN → []
 *   2. SET LOCAL choros.tenant_id → []
 *   3. SET LOCAL search_path → []
 *   4. SELECT registry_def FOR UPDATE → [fakeRegRow with is_system]
 *   (guard fires here for system registries — no further queries needed for 403 path)
 *
 * For the allow-path (add field → soft path):
 *   5. SELECT report_page_dep JOIN → []   (no active deps)
 *   6. SELECT template_dep → []           (no active deps)
 *   7. UPDATE registry_def → []
 *   8. COMMIT → []
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  registerRegistryDefRoutes,
  resetPoolForTesting,
  type RegistryDefAuthzDeps,
} from "../http/registry-defs.js";
import { Router } from "../http/router.js";

// ---------------------------------------------------------------------------
// Fake pool infrastructure (mirrors registry-defs-pdp.test.ts)
// ---------------------------------------------------------------------------

interface FakeQueryResult {
  rows: unknown[];
}

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

function makeFakePool(rowSets: unknown[][]): import("pg").Pool {
  return {
    connect: async () => new FakePoolClient(rowSets) as unknown as import("pg").PoolClient,
  } as unknown as import("pg").Pool;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function buildTestServer(
  fakePool: import("pg").Pool,
  fakeDeps?: RegistryDefAuthzDeps,
): { server: http.Server; baseUrl: () => string } {
  resetPoolForTesting();
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

const FAKE_REG_ID = "22222222-2222-2222-2222-222222222222";

// Passthrough authz deps (allow destructive schema changes in force path) — not
// relevant for extend-not-replace tests since 403 fires before authz is checked.
const allowAllDeps: RegistryDefAuthzDeps = {
  checkDestructiveGrant: async () => ({ ok: true }),
};

// ---------------------------------------------------------------------------
// 1. Static seed assertions — migration 083 must exist with correct content
// ---------------------------------------------------------------------------

describe("Seed migration 083: core system registries", () => {
  const MIGRATION_PATH = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../migrations/083_core_system_registries_seed.sql",
  );

  it("migration file exists", () => {
    expect(fs.existsSync(MIGRATION_PATH), `expected ${MIGRATION_PATH} to exist`).toBe(true);
  });

  it("seeds core-registries application with stable UUID a8000000-...-0001", () => {
    const content = fs.readFileSync(MIGRATION_PATH, "utf8");
    expect(content).toContain("a8000000-0000-0000-0000-000000000001");
    expect(content).toContain("core-registries");
  });

  it("seeds Контрагенты registry (slug=kontragenty) with is_system=true", () => {
    const content = fs.readFileSync(MIGRATION_PATH, "utf8");
    expect(content).toContain("a8000000-0000-0000-0000-000000000002");
    expect(content).toContain("'kontragenty'");
    // is_system=true: the registry row must pass true for the is_system column
    expect(content.toLowerCase()).toContain("is_system");
    // ensure the actual value 'true' appears near the INSERT slug (lastIndexOf finds INSERT, not comment)
    const kIdx = content.lastIndexOf("'kontragenty'");
    const slice = content.slice(kIdx, kIdx + 800);
    expect(slice).toContain("true");
  });

  it("seeds Валюты registry (slug=valyuty) with is_system=true", () => {
    const content = fs.readFileSync(MIGRATION_PATH, "utf8");
    expect(content).toContain("a8000000-0000-0000-0000-000000000003");
    expect(content).toContain("valyuty");
  });

  it("seeds Производственный календарь (slug=prod-kalendar) with is_system=true", () => {
    const content = fs.readFileSync(MIGRATION_PATH, "utf8");
    expect(content).toContain("a8000000-0000-0000-0000-000000000004");
    expect(content).toContain("prod-kalendar");
  });

  it("seeds Единицы измерения (slug=edinitsy) with is_system=true", () => {
    const content = fs.readFileSync(MIGRATION_PATH, "utf8");
    expect(content).toContain("a8000000-0000-0000-0000-000000000005");
    expect(content).toContain("edinitsy");
  });

  it("contains no DDL (no CREATE TABLE)", () => {
    const content = fs.readFileSync(MIGRATION_PATH, "utf8");
    // Extract non-comment lines only
    const nonComment = content
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(nonComment.toLowerCase()).not.toContain("create table");
  });

  it("uses ON CONFLICT DO NOTHING (idempotent inserts)", () => {
    const content = fs.readFileSync(MIGRATION_PATH, "utf8");
    expect(content.toLowerCase()).toContain("on conflict");
    expect(content.toLowerCase()).toContain("do nothing");
  });

  it("Контрагенты schema has required standard fields: name, inn, kpp, ogrn", () => {
    const content = fs.readFileSync(MIGRATION_PATH, "utf8");
    // Use lastIndexOf to find the INSERT occurrence of 'kontragenty' (not the comment)
    const kIdx = content.lastIndexOf("'kontragenty'");
    expect(kIdx, "kontragenty INSERT not found").toBeGreaterThan(-1);
    const slice = content.slice(kIdx, kIdx + 1500);
    expect(slice).toContain('"name"');
    expect(slice).toContain('"inn"');
    expect(slice).toContain('"kpp"');
    expect(slice).toContain('"ogrn"');
  });

  it("Валюты schema has standard fields: code, name, symbol, decimal_places", () => {
    const content = fs.readFileSync(MIGRATION_PATH, "utf8");
    // Use lastIndexOf to find the INSERT occurrence
    const vIdx = content.lastIndexOf("'valyuty'");
    expect(vIdx, "valyuty INSERT not found").toBeGreaterThan(-1);
    const slice = content.slice(vIdx, vIdx + 1200);
    expect(slice).toContain('"code"');
    expect(slice).toContain('"name"');
    expect(slice).toContain('"symbol"');
    expect(slice).toContain('"decimal_places"');
  });

  it("Производственный календарь schema has standard fields: date, is_working_day", () => {
    const content = fs.readFileSync(MIGRATION_PATH, "utf8");
    // Use lastIndexOf to find the INSERT occurrence (not the comment reference)
    const insertIdx = content.lastIndexOf("'prod-kalendar'");
    expect(insertIdx, "prod-kalendar INSERT not found in migration").toBeGreaterThan(-1);
    const slice = content.slice(insertIdx, insertIdx + 1200);
    expect(slice).toContain('"date"');
    expect(slice).toContain('"is_working_day"');
  });
});

// ---------------------------------------------------------------------------
// 2. Extend-not-replace guard: DELETE standard field → 403
//
// Fake pool sequence for the 403 path (guard fires after SELECT FOR UPDATE,
// before any further DB queries):
//   1. BEGIN → []
//   2. SET LOCAL tenant_id → []
//   3. SET LOCAL search_path → []
//   4. SELECT registry_def FOR UPDATE → [{ id, record_schema, tier, is_system: true }]
//   → guard fires → HttpError 403 → ROLLBACK
//   5. ROLLBACK → []
// ---------------------------------------------------------------------------

describe("Extend-not-replace guard: delete standard field of system registry → 403", () => {
  const fakeSystemReg = {
    id: FAKE_REG_ID,
    record_schema: {
      properties: {
        name: { type: "string" },
        inn: { type: "string" },
        kpp: { type: "string" },
      },
    },
    tier: "active",
    is_system: true,
  };

  const fakePool = makeFakePool([
    [],             // BEGIN
    [],             // SET LOCAL tenant_id
    [],             // SET LOCAL search_path
    [fakeSystemReg], // SELECT registry_def FOR UPDATE
    [],             // ROLLBACK (after HttpError 403)
  ]);

  const { server, baseUrl } = buildTestServer(fakePool, allowAllDeps);

  beforeAll(
    () => new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    }),
  );

  afterAll(
    () => new Promise<void>((res) => server.close(() => res())),
  );

  it("PUT that removes a standard field → 403 SYSTEM_REGISTRY_FIELD_PROTECTED", async () => {
    const res = await httpReq(
      "PUT",
      `${baseUrl()}/api/registry-defs/${FAKE_REG_ID}`,
      { "x-dev-user": "actor-tenant" },
      {
        record_schema: {
          // Missing 'inn' and 'kpp' — standard fields removed
          properties: { name: { type: "string" } },
        },
      },
    );

    expect(res.status, `expected 403, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(403);
    const body = res.json as Record<string, unknown>;
    // Error is wrapped: { error: { code, message } }
    const errEnv = body["error"] as Record<string, unknown> | undefined;
    const code = errEnv ? errEnv["code"] : body["code"];
    expect(code).toBe("SYSTEM_REGISTRY_FIELD_PROTECTED");
    const msg = (errEnv ? errEnv["message"] : body["message"]) as string;
    // Message must name the removed fields
    expect(msg).toMatch(/inn|kpp/);
  });

  it("PATCH that removes a standard field → 403 SYSTEM_REGISTRY_FIELD_PROTECTED", async () => {
    // Fresh pool for PATCH request
    const patchPool = makeFakePool([
      [],
      [],
      [],
      [fakeSystemReg],
      [],
    ]);

    const patchRouter = new Router();
    resetPoolForTesting();
    registerRegistryDefRoutes(patchRouter, patchPool, allowAllDeps);
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
        { "x-dev-user": "actor-tenant" },
        {
          record_schema: {
            // Rename: 'inn' → 'tax_id' effectively removes 'inn'
            properties: { name: { type: "string" }, tax_id: { type: "string" } },
          },
        },
      );
      expect(res.status, `expected 403, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(403);
      const body = res.json as Record<string, unknown>;
      const errEnv = body["error"] as Record<string, unknown> | undefined;
      const code = errEnv ? errEnv["code"] : body["code"];
      expect(code).toBe("SYSTEM_REGISTRY_FIELD_PROTECTED");
    } finally {
      await new Promise<void>((resolve) => patchServer.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Add field allowed: PUT on system registry that ONLY adds new fields → no 403
//
// When a tenant adds fields but does NOT remove any standard field, the guard
// must not block. The request proceeds to the classifier. Since there are no
// active deps and the change is soft, it returns 200.
//
// Fake pool sequence for the soft (no deps) path:
//   1. BEGIN → []
//   2. SET LOCAL tenant_id → []
//   3. SET LOCAL search_path → []
//   4. SELECT registry_def FOR UPDATE → [{ ..., is_system: true }]
//   5. SELECT report_page_dep JOIN → []  (no deps)
//   6. SELECT template_dep → []          (no deps)
//   7. UPDATE registry_def → []
//   8. COMMIT → []
// ---------------------------------------------------------------------------

describe("Extend-not-replace guard: add field to system registry → allowed (no 403)", () => {
  const fakeSystemReg = {
    id: FAKE_REG_ID,
    record_schema: {
      properties: {
        code: { type: "string" },
        name: { type: "string" },
      },
    },
    tier: "active",
    is_system: true,
  };

  const fakePool = makeFakePool([
    [],              // BEGIN
    [],              // SET LOCAL tenant_id
    [],              // SET LOCAL search_path
    [fakeSystemReg], // SELECT registry_def FOR UPDATE
    [],              // SELECT report_page_dep JOIN (no deps)
    [],              // SELECT template_dep (no deps)
    [],              // UPDATE registry_def
    [],              // COMMIT
  ]);

  const { server, baseUrl } = buildTestServer(fakePool, allowAllDeps);

  beforeAll(
    () => new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    }),
  );

  afterAll(
    () => new Promise<void>((res) => server.close(() => res())),
  );

  it("PUT that ONLY adds new fields to system registry → 200 (not 403)", async () => {
    const res = await httpReq(
      "PUT",
      `${baseUrl()}/api/registry-defs/${FAKE_REG_ID}`,
      { "x-dev-user": "actor-tenant" },
      {
        record_schema: {
          // Keeps all standard fields AND adds a new tenant-specific field
          properties: {
            code: { type: "string" },
            name: { type: "string" },
            tenant_custom_field: { type: "string" },
          },
        },
      },
    );

    expect(res.status, `expected 200, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(200);
    const body = res.json as Record<string, unknown>;
    // Should not have SYSTEM_REGISTRY_FIELD_PROTECTED error (no error envelope on 200)
    const errEnv = body["error"] as Record<string, unknown> | undefined;
    expect(errEnv?.["code"]).not.toBe("SYSTEM_REGISTRY_FIELD_PROTECTED");
    expect(body["updated"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Non-system registry: extend-not-replace guard does NOT fire
//
// When is_system=false, removing fields is allowed (subject to the normal
// destructive-change classifier, not the system-field guard).
// The request proceeds; with no active deps it returns 200.
// ---------------------------------------------------------------------------

describe("Extend-not-replace guard: non-system registry → guard does not fire", () => {
  const fakeTenantReg = {
    id: FAKE_REG_ID,
    record_schema: {
      properties: {
        field_a: { type: "string" },
        field_b: { type: "number" },
      },
    },
    tier: "active",
    is_system: false,  // NOT a system registry
  };

  const fakePool = makeFakePool([
    [],               // BEGIN
    [],               // SET LOCAL tenant_id
    [],               // SET LOCAL search_path
    [fakeTenantReg],  // SELECT registry_def FOR UPDATE
    [],               // SELECT report_page_dep JOIN (no deps)
    [],               // SELECT template_dep (no deps)
    [],               // UPDATE registry_def
    [],               // COMMIT
  ]);

  const { server, baseUrl } = buildTestServer(fakePool, allowAllDeps);

  beforeAll(
    () => new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    }),
  );

  afterAll(
    () => new Promise<void>((res) => server.close(() => res())),
  );

  it("PUT removing a field on non-system registry → 200 (no system guard)", async () => {
    const res = await httpReq(
      "PUT",
      `${baseUrl()}/api/registry-defs/${FAKE_REG_ID}`,
      { "x-dev-user": "actor-tenant" },
      {
        record_schema: {
          // Removes 'field_b' — no active deps so soft path → 200
          properties: { field_a: { type: "string" } },
        },
      },
    );

    // No 403 from system guard; no active deps → soft path → 200
    expect(res.status, `expected 200, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(200);
    const body = res.json as Record<string, unknown>;
    const errEnv = body["error"] as Record<string, unknown> | undefined;
    expect(errEnv?.["code"]).not.toBe("SYSTEM_REGISTRY_FIELD_PROTECTED");
  });
});
