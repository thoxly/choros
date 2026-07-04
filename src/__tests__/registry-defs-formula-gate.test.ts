/**
 * T-0580 [D-064 §A8 / К4] — HTTP-level unit tests for the formula schema gate
 * (FR-7) wired into POST /api/registry-defs and PUT /api/registry-defs/:id.
 *
 * No live DB: both routes reject an invalid formula BEFORE any DB access is
 * attempted (POST: before resolveActorTenant/createRegistryDef; PUT: before
 * the withTenantTx lock-read). This is proven directly — resolveActorTenant
 * and the pool are wired to THROW if called, so a passing test is proof the
 * rejection happened at the gate, not merely "eventually returned 400 for
 * some other reason downstream".
 *
 * AC coverage: AC-7 (validation authoring: unknown field / invalid type /
 * cycle / self-reference / empty formula → reject) at the HTTP boundary.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { registerRegistryDefRoutes, type RegistryDefCrudDeps } from "../http/registry-defs.js";
import { Router } from "../http/router.js";

function buildServer(
  crudDeps?: RegistryDefCrudDeps,
  poolHint?: import("pg").Pool,
): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  registerRegistryDefRoutes(router, poolHint, undefined, crudDeps);
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
        ...(buf ? { "Content-Type": "application/json", "Content-Length": String(buf.length) } : {}),
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

async function withServer<T>(
  crudDeps: RegistryDefCrudDeps | undefined,
  fn: (baseUrl: string) => Promise<T>,
  poolHint?: import("pg").Pool,
): Promise<T> {
  const { server, baseUrl } = buildServer(crudDeps, poolHint);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(baseUrl());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// A stub resolveActorTenant that THROWS if ever called — proves the formula
// gate short-circuits the POST handler before this point is reached.
const NEVER_CALLED_RESOLVE_TENANT = async (): Promise<string> => {
  throw new Error("resolveActorTenant must not be called when the formula gate rejects the schema");
};

// A stub pool that THROWS if `.connect()`/`.query()` is ever invoked — proves
// no DB access happens before the formula gate runs.
const NEVER_TOUCHED_POOL = {
  connect: async () => {
    throw new Error("pool.connect must not be called when the formula gate rejects the schema");
  },
  query: async () => {
    throw new Error("pool.query must not be called when the formula gate rejects the schema");
  },
} as unknown as import("pg").Pool;

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

describe("POST /api/registry-defs — formula gate (T-0580 FR-7/AC-7)", () => {
  const crudDeps: RegistryDefCrudDeps = {
    pool: NEVER_TOUCHED_POOL,
    resolveActorTenant: NEVER_CALLED_RESOLVE_TENANT,
  };

  it("rejects a formula referencing a non-existent field with 400 VALIDATION (never reaches resolveActorTenant)", async () => {
    await withServer(crudDeps, async (baseUrl) => {
      const r = await httpReq("POST", `${baseUrl}/api/registry-defs`, { "x-dev-user": "tester" }, {
        application_id: VALID_UUID,
        slug: "contracts",
        display_name: "Договоры",
        record_schema: {
          type: "object",
          properties: {
            itogo: { type: "number", "x-formula": { expr: "no_such_field + 1", result_type: "number" } },
          },
        },
      });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toMatch(/no_such_field|unknown field/i);
    });
  });

  it("rejects a self-referencing formula cycle with 400 VALIDATION", async () => {
    await withServer(crudDeps, async (baseUrl) => {
      const r = await httpReq("POST", `${baseUrl}/api/registry-defs`, { "x-dev-user": "tester" }, {
        application_id: VALID_UUID,
        slug: "contracts",
        display_name: "Договоры",
        record_schema: {
          type: "object",
          properties: {
            a: { type: "number", "x-formula": { expr: "a + 1", result_type: "number" } },
          },
        },
      });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toMatch(/cycle/i);
    });
  });

  it("rejects a 2-field formula cycle with 400 VALIDATION", async () => {
    await withServer(crudDeps, async (baseUrl) => {
      const r = await httpReq("POST", `${baseUrl}/api/registry-defs`, { "x-dev-user": "tester" }, {
        application_id: VALID_UUID,
        slug: "contracts",
        display_name: "Договоры",
        record_schema: {
          type: "object",
          properties: {
            a: { type: "number", "x-formula": { expr: "b + 1", result_type: "number" } },
            b: { type: "number", "x-formula": { expr: "a + 1", result_type: "number" } },
          },
        },
      });
      expect(r.status).toBe(400);
    });
  });

  it("rejects a formula referencing a string (invalid-type) sibling field", async () => {
    await withServer(crudDeps, async (baseUrl) => {
      const r = await httpReq("POST", `${baseUrl}/api/registry-defs`, { "x-dev-user": "tester" }, {
        application_id: VALID_UUID,
        slug: "contracts",
        display_name: "Договоры",
        record_schema: {
          type: "object",
          properties: {
            vendor_name: { type: "string" },
            itogo: { type: "number", "x-formula": { expr: "vendor_name + 1", result_type: "number" } },
          },
        },
      });
      expect(r.status).toBe(400);
    });
  });

  it("rejects an empty formula expression", async () => {
    await withServer(crudDeps, async (baseUrl) => {
      const r = await httpReq("POST", `${baseUrl}/api/registry-defs`, { "x-dev-user": "tester" }, {
        application_id: VALID_UUID,
        slug: "contracts",
        display_name: "Договоры",
        record_schema: {
          type: "object",
          properties: {
            itogo: { type: "number", "x-formula": { expr: "", result_type: "number" } },
          },
        },
      });
      expect(r.status).toBe(400);
    });
  });

  it("rejects a field carrying BOTH x-formula and x-rollup", async () => {
    await withServer(crudDeps, async (baseUrl) => {
      const r = await httpReq("POST", `${baseUrl}/api/registry-defs`, { "x-dev-user": "tester" }, {
        application_id: VALID_UUID,
        slug: "contracts",
        display_name: "Договоры",
        record_schema: {
          type: "object",
          properties: {
            lines: { type: "array" },
            both: {
              type: "number",
              "x-formula": { expr: "1 + 1", result_type: "number" },
              "x-rollup": { source: "lines", op: "sum", value_field: "price" },
            },
          },
        },
      });
      expect(r.status).toBe(400);
    });
  });
});

describe("PUT /api/registry-defs/:id — formula gate (T-0580 FR-7/AC-7)", () => {
  // PUT's handler resolves a schema pool (crudDeps.pool ?? poolHint ?? lazy
  // singleton) BEFORE the formula gate runs (pre-existing code order, T-0177)
  // — a poolHint is required so the lazy singleton doesn't 503 on a missing
  // DATABASE_URL in this no-DB test. NEVER_TOUCHED_POOL still proves the
  // formula gate rejects BEFORE any actual query: extractActor's x-dev-user
  // path never touches the pool, and the gate throws before updateSchemaInTx's
  // withTenantTx (the first real query) is ever reached.
  it("rejects a cyclic formula with 400 VALIDATION before touching the DB", async () => {
    await withServer(
      undefined,
      async (baseUrl) => {
        const r = await httpReq(
          "PUT",
          `${baseUrl}/api/registry-defs/${VALID_UUID}`,
          { "x-dev-user": "tester" },
          {
            record_schema: {
              type: "object",
              properties: {
                a: { type: "number", "x-formula": { expr: "a + 1", result_type: "number" } },
              },
            },
          },
        );
        expect(r.status).toBe(400);
        expect(JSON.stringify(r.json)).toMatch(/cycle/i);
      },
      NEVER_TOUCHED_POOL,
    );
  });

  it("rejects an unknown-field-reference formula with 400 VALIDATION before touching the DB", async () => {
    await withServer(
      undefined,
      async (baseUrl) => {
        const r = await httpReq(
          "PUT",
          `${baseUrl}/api/registry-defs/${VALID_UUID}`,
          { "x-dev-user": "tester" },
          {
            record_schema: {
              type: "object",
              properties: {
                itogo: { type: "number", "x-formula": { expr: "ghost_field + 1", result_type: "number" } },
              },
            },
          },
        );
        expect(r.status).toBe(400);
      },
      NEVER_TOUCHED_POOL,
    );
  });
});
