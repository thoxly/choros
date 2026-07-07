/**
 * src/__tests__/process-catalog-target-registry.test.ts — T-0681 [E-FORMS/P1].
 *
 * Live-proof T-0678/T-0680 finding: process_app_binding.target_registry_slug
 * (migration 119) is never written by any HTTP/UI path — only seeds/migrations set
 * it. A fresh process bound to a NON-default result registry therefore has
 * target_registry_slug=NULL → the authoring floor-gate (T-0520, via
 * resolveLiveRecordSchema) resolves the live schema by the DEFAULT slug → no
 * registry_def under that slug → null schema → Floor-2 → the first form save 409s
 * WRONG_FLOOR, even though the form is valid.
 *
 * This suite exercises the NEW write path on POST /api/process-app-bindings:
 *   AC-1  valid target_registry_slug (registry exists under the app) → 201, written;
 *         re-bind (upsert) updates target_registry_slug.
 *   AC-2  unresolvable target_registry_slug → 400 REGISTRY_NOT_FOUND, row not written.
 *   AC-3  omitted / null → 201, column NULL (backward-compatible default-slug path).
 *   AC-4  GET /api/process-app-bindings serializes target_registry_slug.
 *   AC-5  the written slug drives resolveLiveRecordSchema to a NON-null schema (the
 *         exact resolver the floor-gate uses) — proving the 409 trap is removed.
 *
 * Pure unit (no live Postgres). A fake pg.Pool models: application existence,
 * registry_def existence under an app, the upsert (recording params), the GET list
 * query, and (AC-5) the two SELECTs resolveLiveRecordSchema issues. The slug is a
 * NEUTRAL fixture (`results-registry`) local to this test — never a case literal.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerProcessCatalogRoutes } from "../http/process-catalog.js";
import { resolveLiveRecordSchema } from "../db/live-form-schema.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const APP_ID = "b1111111-1111-1111-1111-111111111111";
const PROC_KEY = "novyy-protsess-1";
const DEV_USER = "e-owner";
// NEUTRAL, test-local fixtures — NOT case literals (no soglasovanie/sdelka/tel/persona).
const REAL_SLUG = "results-registry";
const MISSING_SLUG = "no-such-registry";
const TEST_RESOLVER = async () => TENANT_ID;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface PoolOpts {
  /** slugs that DO exist as registry_def under APP_ID (for the existence guard). */
  existingRegistrySlugs?: string[];
  /** capture sink for the recorded INSERT params (index 8 = target_registry_slug). */
  captured?: { insertParams?: unknown[] };
  /** rows the GET list query returns (AC-4). */
  listRows?: Array<Record<string, unknown>>;
}

function makePool(opts: PoolOpts = {}) {
  const existing = new Set(opts.existingRegistrySlugs ?? []);
  const responder = async (sql: string, params?: unknown[]) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s) || /SET LOCAL/.test(s)) return { rows: [] };

    // applicationExists — the app is always present in this tenant.
    if (/FROM choros\.application/.test(s) && /WHERE tenant_id = \$1 AND id = \$2/.test(s)) {
      return { rows: [{ one: 1 }] };
    }
    // registryExistsUnderApp — SELECT 1 FROM registry_def WHERE tenant+app+slug.
    if (/FROM choros\.registry_def/.test(s) && /AND slug = \$3/.test(s)) {
      const slug = params?.[2] as string;
      return { rows: existing.has(slug) ? [{ one: 1 }] : [] };
    }
    // The upsert — record params, return a synthetic id.
    if (/INSERT INTO choros\.process_app_binding/.test(s)) {
      if (opts.captured) opts.captured.insertParams = params;
      return { rows: [{ id: "c2222222-2222-2222-2222-222222222222" }] };
    }
    // GET list query (AC-4).
    if (/FROM choros\.process_app_binding b/.test(s)) {
      return { rows: opts.listRows ?? [] };
    }
    return { rows: [] };
  };
  return {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation(responder),
      release: vi.fn(),
    }),
    query: vi.fn().mockImplementation(responder),
  };
}

function makeRouter() {
  const routes: Array<{ method: string; path: string; handler: any }> = [];
  return {
    register(method: string, path: string, handler: any) { routes.push({ method, path, handler }); },
    find(method: string, path: string) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const rp = r.path.split("/"), pp = path.split("/");
        if (rp.length !== pp.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < rp.length; i++) {
          if (rp[i]!.startsWith(":")) params[rp[i]!.slice(1)] = pp[i]!;
          else if (rp[i] !== pp[i]) { ok = false; break; }
        }
        if (ok) return { handler: r.handler, params };
      }
      return null;
    },
  };
}

function makeReq(body?: unknown): IncomingMessage {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  return {
    headers: { "x-dev-user": DEV_USER },
    on: vi.fn().mockImplementation((event: string, cb: (data?: Buffer) => void) => {
      if (event === "data" && bodyStr) cb(Buffer.from(bodyStr, "utf8"));
      if (event === "end") (cb as () => void)();
    }),
    setEncoding: vi.fn(),
  } as unknown as IncomingMessage;
}

function makeRes() {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    headers,
    setHeader(name: string, value: string) { headers[name] = value; },
    end(body?: string) { if (body) chunks.push(body); },
    get body() { return chunks.join(""); },
    get json() { return JSON.parse(chunks.join("")); },
  } as unknown as ServerResponse & { body: string; json: any };
}

async function dispatch(
  router: ReturnType<typeof makeRouter>,
  method: string,
  path: string,
  req: IncomingMessage,
) {
  const match = router.find(method, path);
  if (!match) throw new Error(`no route for ${method} ${path}`);
  const res = makeRes();
  try {
    await match.handler(req, res, match.params);
  } catch (err: any) {
    // Mirror the router envelope so tests can assert status + code.
    res.statusCode = err?.statusCode ?? 500;
    (res as any).__err = { code: err?.code, message: err?.message };
  }
  return res;
}

// ---------------------------------------------------------------------------
// POST /api/process-app-bindings — target_registry_slug write path
// ---------------------------------------------------------------------------

describe("T-0681 · POST /api/process-app-bindings writes target_registry_slug", () => {
  it("AC-1: valid slug (registry exists under the app) → 201, column written", async () => {
    const captured: { insertParams?: unknown[] } = {};
    const pool = makePool({ existingRegistrySlugs: [REAL_SLUG], captured });
    const router = makeRouter();
    registerProcessCatalogRoutes(router as any, { pool: pool as any, resolveActorTenant: TEST_RESOLVER });

    const res = await dispatch(
      router,
      "POST",
      "/api/process-app-bindings",
      makeReq({ process_key: PROC_KEY, application_id: APP_ID, target_registry_slug: REAL_SLUG }),
    );

    expect(res.statusCode).toBe(201);
    expect(res.json.target_registry_slug).toBe(REAL_SLUG);
    // Column position 9 (1-based $9) in the INSERT param array = index 8.
    expect(captured.insertParams?.[8]).toBe(REAL_SLUG);
  });

  it("AC-2: unresolvable slug → 400 REGISTRY_NOT_FOUND, upsert never runs", async () => {
    const captured: { insertParams?: unknown[] } = {};
    // Registry list is empty → MISSING_SLUG resolves to no row.
    const pool = makePool({ existingRegistrySlugs: [], captured });
    const router = makeRouter();
    registerProcessCatalogRoutes(router as any, { pool: pool as any, resolveActorTenant: TEST_RESOLVER });

    const res = await dispatch(
      router,
      "POST",
      "/api/process-app-bindings",
      makeReq({ process_key: PROC_KEY, application_id: APP_ID, target_registry_slug: MISSING_SLUG }),
    );

    expect(res.statusCode).toBe(400);
    expect((res as any).__err.code).toBe("REGISTRY_NOT_FOUND");
    // Fail-closed: the row was never inserted.
    expect(captured.insertParams).toBeUndefined();
  });

  it("AC-3: omitted target_registry_slug → 201, column NULL (backward-compatible)", async () => {
    const captured: { insertParams?: unknown[] } = {};
    const pool = makePool({ existingRegistrySlugs: [REAL_SLUG], captured });
    const router = makeRouter();
    registerProcessCatalogRoutes(router as any, { pool: pool as any, resolveActorTenant: TEST_RESOLVER });

    const res = await dispatch(
      router,
      "POST",
      "/api/process-app-bindings",
      makeReq({ process_key: PROC_KEY, application_id: APP_ID }),
    );

    expect(res.statusCode).toBe(201);
    expect(res.json.target_registry_slug).toBeNull();
    expect(captured.insertParams?.[8]).toBeNull();
  });

  it("AC-3b: explicit null / empty string → 201, column NULL", async () => {
    const captured: { insertParams?: unknown[] } = {};
    const pool = makePool({ existingRegistrySlugs: [REAL_SLUG], captured });
    const router = makeRouter();
    registerProcessCatalogRoutes(router as any, { pool: pool as any, resolveActorTenant: TEST_RESOLVER });

    const res = await dispatch(
      router,
      "POST",
      "/api/process-app-bindings",
      makeReq({ process_key: PROC_KEY, application_id: APP_ID, target_registry_slug: "  " }),
    );

    expect(res.statusCode).toBe(201);
    expect(res.json.target_registry_slug).toBeNull();
    expect(captured.insertParams?.[8]).toBeNull();
  });

  it("AC-4: GET /api/process-app-bindings serializes target_registry_slug", async () => {
    const pool = makePool({
      listRows: [{
        id: "c2222222-2222-2222-2222-222222222222",
        process_key: PROC_KEY,
        application_id: APP_ID,
        form_key: null,
        trigger_type: "launcher",
        start_form_key: null,
        field_mapping: {},
        target_registry_slug: REAL_SLUG,
        created_at: "1",
        updated_at: "1",
        app_slug: "crm",
        app_display_name: "CRM",
      }],
    });
    const router = makeRouter();
    registerProcessCatalogRoutes(router as any, { pool: pool as any, resolveActorTenant: TEST_RESOLVER });

    const res = await dispatch(router, "GET", "/api/process-app-bindings", makeReq());

    expect(res.statusCode).toBe(200);
    expect(res.json.bindings).toHaveLength(1);
    expect(res.json.bindings[0].target_registry_slug).toBe(REAL_SLUG);
  });
});

// ---------------------------------------------------------------------------
// AC-5 — the written slug removes the false 409 (integration with the gate resolver)
// ---------------------------------------------------------------------------

describe("T-0681 · AC-5: written slug drives resolveLiveRecordSchema (no false 409)", () => {
  /**
   * resolveLiveRecordSchema is the EXACT resolver the authoring floor-gate (T-0520)
   * calls. It issues two SELECTs:
   *   1. process_app_binding → application_id + target_registry_slug
   *   2. registry_def by (application_id, resolved-slug) → record_schema
   * When a NON-default slug is recorded (this task's write path), (2) matches the
   * NON-default registry and returns its schema — so the gate sees a live schema,
   * classifies Floor-1, and the save is NOT bounced to 409. Before this task, (1)
   * returned NULL, (2) looked up the DEFAULT slug, found nothing, and the resolver
   * returned null → Floor-2 → 409.
   */
  function makeSchemaClient(boundSlug: string | null, nonDefaultRegistrySchema: unknown) {
    return {
      query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
        const s = sql.replace(/\s+/g, " ").trim();
        // Step 1 — binding row.
        if (/FROM choros\.process_app_binding/.test(s) && /target_registry_slug/.test(s)) {
          return { rows: [{ application_id: APP_ID, target_registry_slug: boundSlug }] };
        }
        // Step 2 — registry_def by resolved slug. Only the NON-default slug has a schema.
        if (/FROM choros\.registry_def/.test(s) && /AND slug = \$3/.test(s)) {
          const slug = params?.[2] as string;
          return slug === REAL_SLUG ? { rows: [{ record_schema: nonDefaultRegistrySchema }] } : { rows: [] };
        }
        return { rows: [] };
      }),
    } as any;
  }

  const NON_DEFAULT_SCHEMA = { type: "object", properties: { amount: { type: "number" } } };

  it("recorded non-default slug → resolveLiveRecordSchema returns the real schema", async () => {
    const client = makeSchemaClient(REAL_SLUG, NON_DEFAULT_SCHEMA);
    const schema = await resolveLiveRecordSchema(client, TENANT_ID, PROC_KEY);
    expect(schema).toEqual(NON_DEFAULT_SCHEMA);
  });

  it("regression: NULL slug (pre-T-0681) → default slug misses → null schema (the old 409 trap)", async () => {
    // boundSlug NULL → resolver falls back to the default slug, which (in this fixture)
    // has no registry_def → null → Floor-2 → the 409 WRONG_FLOOR this task removes.
    const client = makeSchemaClient(null, NON_DEFAULT_SCHEMA);
    const schema = await resolveLiveRecordSchema(client, TENANT_ID, PROC_KEY);
    expect(schema).toBeNull();
  });
});
