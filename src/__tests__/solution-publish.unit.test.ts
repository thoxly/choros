/**
 * src/__tests__/solution-publish.unit.test.ts — T-0562 (PD-26 / ADR T-0561).
 *
 * Fake-pool unit tests for «Опубликовать связанное решение по кнопке»:
 *   GET  /api/applications/:id/publish-preview
 *   POST /api/applications/:id/publish-solution
 *
 * NO ambient DB. A fake pg.Pool scripts row sets by SQL shape so the handler drives
 * the REAL derive query + promoteTier (artifacts.ts) + publishProcessByKey
 * (process-defs.ts) paths. The privilege check is injected (resolvePrivilege) so the
 * authz branches are exercised without standing up the grant tables.
 *
 * Coverage:
 *   - derive: app + x-relation справочник + bound process + step form
 *   - preview shape { app_id, items, counts }
 *   - publish per-item results, mixed draft/published, one failing item → 207
 *   - authz: non-privileged → 403
 *   - tenant isolation: unknown/foreign app id → 404 (RLS-filtered absent)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerSolutionPublishRoutes } from "../http/solution-publish.js";
import type { FlowableClient } from "../core/flowable-client.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const APP_ID = "a1111111-1111-1111-1111-111111111111";
const REF_APP_ID = "a2222222-2222-2222-2222-222222222222";
const TARGET_REG_ID = "c2222222-2222-2222-2222-222222222222";
const PROC_KEY = "soglasovanie-zakupki";
const FORM_KEY = "zayavka-form";

// ---------------------------------------------------------------------------
// Router stub
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

function makeRouter() {
  const routes: Array<{ method: string; path: string; handler: Handler }> = [];
  return {
    register(method: string, path: string, handler: Handler) {
      routes.push({ method, path, handler });
    },
    find(method: string, path: string) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const rp = route.path.split("/");
        const pp = path.split("/");
        if (rp.length !== pp.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < rp.length; i++) {
          if (rp[i]!.startsWith(":")) params[rp[i]!.slice(1)] = pp[i]!;
          else if (rp[i] !== pp[i]) { ok = false; break; }
        }
        if (ok) return { handler: route.handler, params };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake pg.Pool — scripts row sets by SQL shape.
// ---------------------------------------------------------------------------

interface PoolOpts {
  /** application rows keyed by id → { display_name, tier } */
  apps?: Record<string, { display_name: string; tier: string }>;
  /** registry_defs under the target app: their record_schema list */
  appRegistrySchemas?: unknown[];
  /** registry_def id → application_id (for x-relation target resolution) */
  targetRegistries?: Record<string, string>;
  /** bindings under the target app */
  bindings?: Array<{ process_key: string; form_key: string | null; start_form_key: string | null }>;
  /** process status keyed by process_key */
  processStatus?: Record<string, { name: string; status: string }>;
  /** form_binding rows: process_key → form_keys[] */
  formBindings?: Record<string, string[]>;
  /** getLatestVersion status for publishProcessByKey (draft → publishes) */
  procPublishStatus?: string;
}

function makePool(opts: PoolOpts) {
  const queries: string[] = [];
  const responder = async (sql: string, params?: any[]): Promise<{ rows: any[]; rowCount: number }> => {
    queries.push(sql);
    const s = sql.replace(/\s+/g, " ").trim();

    // The target app SELECT (derive: app itself)
    if (/SELECT id, display_name, tier FROM choros\.application WHERE tenant_id = \$1 AND id = \$2 LIMIT 1/.test(s)) {
      const id = params?.[1] as string;
      const row = opts.apps?.[id];
      if (!row) return { rows: [], rowCount: 0 };
      return { rows: [{ id, display_name: row.display_name, tier: row.tier }], rowCount: 1 };
    }
    // registry_defs under the app → record_schema list
    if (/SELECT record_schema FROM choros\.registry_def WHERE tenant_id = \$1 AND application_id = \$2/.test(s)) {
      return {
        rows: (opts.appRegistrySchemas ?? []).map((rs) => ({ record_schema: rs })),
        rowCount: (opts.appRegistrySchemas ?? []).length,
      };
    }
    // x-relation target registry_defs → owning applications
    if (/JOIN choros\.application a ON a\.tenant_id = rd\.tenant_id AND a\.id = rd\.application_id/.test(s)) {
      const regIds = (params?.[1] ?? []) as string[];
      const rows: any[] = [];
      for (const rid of regIds) {
        const appId = opts.targetRegistries?.[rid];
        if (!appId) continue;
        const app = opts.apps?.[appId];
        if (!app) continue;
        rows.push({ id: appId, display_name: app.display_name, tier: app.tier });
      }
      return { rows, rowCount: rows.length };
    }
    // bindings
    if (/FROM choros\.process_app_binding WHERE tenant_id = \$1 AND application_id = \$2/.test(s)) {
      return { rows: opts.bindings ?? [], rowCount: (opts.bindings ?? []).length };
    }
    // process status (derive)
    if (/SELECT DISTINCT ON \(process_key\) process_key, name, status FROM choros\.process_definition/.test(s)) {
      const keys = (params?.[1] ?? []) as string[];
      const rows = keys
        .map((k) => {
          const st = opts.processStatus?.[k];
          return st ? { process_key: k, name: st.name, status: st.status } : null;
        })
        .filter(Boolean);
      return { rows: rows as any[], rowCount: rows.length };
    }
    // form_binding rows
    if (/SELECT process_key, form_key FROM choros\.form_binding/.test(s)) {
      const keys = (params?.[1] ?? []) as string[];
      const rows: any[] = [];
      for (const k of keys) {
        for (const fk of opts.formBindings?.[k] ?? []) rows.push({ process_key: k, form_key: fk });
      }
      return { rows, rowCount: rows.length };
    }

    // ---- promoteTier: SELECT tier FOR UPDATE ----
    if (/SELECT tier FROM .* WHERE tenant_id = \$1 AND id = \$2 FOR UPDATE/.test(s)) {
      return { rows: [{ tier: "draft" }], rowCount: 1 };
    }
    // audit writer plumbing
    if (/current_setting\('choros\.tenant_id', false\)::uuid AS tenant_id/.test(s)) {
      return { rows: [{ tenant_id: TENANT_ID }], rowCount: 1 };
    }
    if (/FROM choros\.audit_head/.test(s)) {
      return { rows: [{ seq: "0", row_hash: Buffer.alloc(32, 0), vocab_version: 1 }], rowCount: 1 };
    }
    // ---- publishProcessByKey: getLatestVersion (latest process row) ----
    if (/FROM choros\.process_definition/.test(s) && /process_key/.test(s) && /ORDER BY version/.test(s)) {
      return {
        rows: [{
          id: "d1111111-1111-1111-1111-111111111111",
          tenant_id: TENANT_ID,
          process_key: PROC_KEY,
          name: "Согласование закупки",
          bpmn_xml: "<xml/>",
          version: 1,
          status: opts.procPublishStatus ?? "draft",
          deployment_id: null,
          created_at: "1",
          updated_at: "1",
        }],
        rowCount: 1,
      };
    }

    return { rows: [], rowCount: 0 };
  };

  const pool = {
    _queries: queries,
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockImplementation(responder),
      release: vi.fn(),
    }),
    query: vi.fn().mockImplementation(responder),
  };
  return pool;
}

function makeFlowable(deployOk = true): FlowableClient {
  return {
    startInstance: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    fetchAndLock: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    completeTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    failTask: vi.fn().mockResolvedValue({ ok: false, code: "UNKNOWN" as const }),
    deployBpmn: vi.fn().mockResolvedValue(
      deployOk ? { ok: true, deploymentId: "dep-1" } : { ok: false, code: "ENGINE_UNAVAILABLE" as const },
    ),
    getFirstActiveUserTask: vi.fn().mockResolvedValue({ ok: true, taskId: null }),
    completeUserTask: vi.fn().mockResolvedValue({ ok: true }),
    getActiveUserTasks: vi.fn().mockResolvedValue({ ok: true, tasks: [] }),
    isInstanceEnded: vi.fn().mockResolvedValue({ ok: true, ended: false }),
    getMessageCatchWaits: vi.fn().mockResolvedValue({ ok: true, waits: [] }),
    correlateMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function makeReq(headers: Record<string, string> = { "x-dev-user": "e-orlov" }): IncomingMessage {
  return {
    headers,
    on: vi.fn().mockImplementation((event: string, cb: () => void) => { if (event === "end") cb(); }),
    setEncoding: vi.fn(),
  } as unknown as IncomingMessage;
}

function makeRes() {
  const chunks: string[] = [];
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(n: string, v: string) { this.headers[n] = v; },
    end(b?: string) { if (b) chunks.push(b); },
    get body() { return chunks.join(""); },
    get json() { return JSON.parse(this.body); },
  };
}

const TENANT_RESOLVER = async () => TENANT_ID;
const PRIVILEGED = async () => ({ isOwnerOrAdmin: true, hasAuthoringDraftGrant: false });
const AUTHORING = async () => ({ isOwnerOrAdmin: false, hasAuthoringDraftGrant: true });
const UNPRIVILEGED = async () => ({ isOwnerOrAdmin: false, hasAuthoringDraftGrant: false });

// x-relation record_schema fixture pointing at TARGET_REG_ID (owned by REF_APP_ID).
const SCHEMA_WITH_RELATION = {
  type: "object",
  properties: {
    kontragent: { type: "string", title: "Контрагент", "x-relation": { target_registry_id: TARGET_REG_ID } },
  },
};

function register(router: any, pool: any, flowable: FlowableClient, priv = PRIVILEGED) {
  registerSolutionPublishRoutes(router, {
    pool: pool as any,
    flowable,
    resolveActorTenant: TENANT_RESOLVER,
    resolvePrivilege: priv as any,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("solution-publish (unit, no DB)", () => {
  let router: ReturnType<typeof makeRouter>;
  beforeEach(() => { router = makeRouter(); });

  it("registers both routes", () => {
    register(router, makePool({}), makeFlowable());
    expect(router.find("GET", `/api/applications/${APP_ID}/publish-preview`)).not.toBeNull();
    expect(router.find("POST", `/api/applications/${APP_ID}/publish-solution`)).not.toBeNull();
  });

  it("401 when no actor identity (x-dev-user missing)", async () => {
    register(router, makePool({}), makeFlowable());
    const route = router.find("GET", `/api/applications/${APP_ID}/publish-preview`)!;
    await expect(
      route.handler(makeReq({}) as any, makeRes() as any, { id: APP_ID }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("400 when app id is not a UUID", async () => {
    register(router, makePool({}), makeFlowable());
    const route = router.find("GET", `/api/applications/not-a-uuid/publish-preview`);
    expect(route).not.toBeNull();
    await expect(
      route!.handler(makeReq() as any, makeRes() as any, { id: "not-a-uuid" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("403 when the actor is not privileged (preview)", async () => {
    register(router, makePool({ apps: { [APP_ID]: { display_name: "X", tier: "draft" } } }), makeFlowable(), UNPRIVILEGED);
    const route = router.find("GET", `/api/applications/${APP_ID}/publish-preview`)!;
    await expect(
      route.handler(makeReq() as any, makeRes() as any, { id: APP_ID }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("403 when the actor is not privileged (publish)", async () => {
    register(router, makePool({ apps: { [APP_ID]: { display_name: "X", tier: "draft" } } }), makeFlowable(), UNPRIVILEGED);
    const route = router.find("POST", `/api/applications/${APP_ID}/publish-solution`)!;
    await expect(
      route.handler(makeReq() as any, makeRes() as any, { id: APP_ID }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("authoring_draft grant holder is allowed (200 preview)", async () => {
    register(router, makePool({ apps: { [APP_ID]: { display_name: "X", tier: "published" } } }), makeFlowable(), AUTHORING);
    const route = router.find("GET", `/api/applications/${APP_ID}/publish-preview`)!;
    const res = makeRes();
    await route.handler(makeReq() as any, res as any, { id: APP_ID });
    expect(res.statusCode).toBe(200);
  });

  it("404 when the app is not in the caller's tenant (RLS-filtered absent)", async () => {
    register(router, makePool({ apps: {} }), makeFlowable());
    const route = router.find("GET", `/api/applications/${APP_ID}/publish-preview`)!;
    await expect(
      route.handler(makeReq() as any, makeRes() as any, { id: APP_ID }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("PREVIEW: derives app + x-relation справочник + bound process + step form", async () => {
    const pool = makePool({
      apps: {
        [APP_ID]: { display_name: "Заявки", tier: "draft" },
        [REF_APP_ID]: { display_name: "Контрагенты", tier: "draft" },
      },
      appRegistrySchemas: [SCHEMA_WITH_RELATION],
      targetRegistries: { [TARGET_REG_ID]: REF_APP_ID },
      bindings: [{ process_key: PROC_KEY, form_key: null, start_form_key: null }],
      processStatus: { [PROC_KEY]: { name: "Согласование", status: "draft" } },
      formBindings: { [PROC_KEY]: [FORM_KEY] },
    });
    register(router, pool, makeFlowable());
    const route = router.find("GET", `/api/applications/${APP_ID}/publish-preview`)!;
    const res = makeRes();
    await route.handler(makeReq() as any, res as any, { id: APP_ID });

    expect(res.statusCode).toBe(200);
    const out = res.json;
    expect(out.app_id).toBe(APP_ID);
    const kinds = out.items.map((i: any) => `${i.kind}:${i.id}`).sort();
    expect(kinds).toEqual([
      `application:${APP_ID}`,
      `application:${REF_APP_ID}`,
      `form:${FORM_KEY}`,
      `process:${PROC_KEY}`,
    ]);
    // All draft → all will_publish; counts reflect that.
    expect(out.items.every((i: any) => i.will_publish)).toBe(true);
    expect(out.counts).toEqual({ total: 4, to_publish: 4 });
  });

  it("PREVIEW: a published item shows will_publish=false and drops out of to_publish", async () => {
    const pool = makePool({
      apps: {
        [APP_ID]: { display_name: "Заявки", tier: "published" },
        [REF_APP_ID]: { display_name: "Контрагенты", tier: "draft" },
      },
      appRegistrySchemas: [SCHEMA_WITH_RELATION],
      targetRegistries: { [TARGET_REG_ID]: REF_APP_ID },
    });
    register(router, pool, makeFlowable());
    const route = router.find("GET", `/api/applications/${APP_ID}/publish-preview`)!;
    const res = makeRes();
    await route.handler(makeReq() as any, res as any, { id: APP_ID });
    const out = res.json;
    const appItem = out.items.find((i: any) => i.id === APP_ID);
    expect(appItem.tier).toBe("published");
    expect(appItem.will_publish).toBe(false);
    expect(out.counts).toEqual({ total: 2, to_publish: 1 });
  });

  it("PREVIEW: справочник without relations → single-item list (degenerate case)", async () => {
    const pool = makePool({ apps: { [APP_ID]: { display_name: "Справочник", tier: "draft" } } });
    register(router, pool, makeFlowable());
    const route = router.find("GET", `/api/applications/${APP_ID}/publish-preview`)!;
    const res = makeRes();
    await route.handler(makeReq() as any, res as any, { id: APP_ID });
    const out = res.json;
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ kind: "application", id: APP_ID, will_publish: true });
    expect(out.counts).toEqual({ total: 1, to_publish: 1 });
  });

  it("PUBLISH: promotes every draft item; all ok → 200, all_ok true", async () => {
    const pool = makePool({
      apps: {
        [APP_ID]: { display_name: "Заявки", tier: "draft" },
        [REF_APP_ID]: { display_name: "Контрагенты", tier: "draft" },
      },
      appRegistrySchemas: [SCHEMA_WITH_RELATION],
      targetRegistries: { [TARGET_REG_ID]: REF_APP_ID },
      bindings: [{ process_key: PROC_KEY, form_key: null, start_form_key: null }],
      processStatus: { [PROC_KEY]: { name: "Согласование", status: "draft" } },
      formBindings: { [PROC_KEY]: [FORM_KEY] },
      procPublishStatus: "draft",
    });
    const flowable = makeFlowable(true);
    register(router, pool, flowable);
    const route = router.find("POST", `/api/applications/${APP_ID}/publish-solution`)!;
    const res = makeRes();
    await route.handler(makeReq() as any, res as any, { id: APP_ID });

    expect(res.statusCode).toBe(200);
    const out = res.json;
    expect(out.app_id).toBe(APP_ID);
    expect(out.all_ok).toBe(true);
    expect(out.results).toHaveLength(4);
    expect(out.results.every((r: any) => r.ok && r.error === null)).toBe(true);
    // 2 applications flipped tier via promoteTier.
    const promoteUpdates = pool._queries.filter((q) => /tier = 'published'/.test(q.replace(/\s+/g, " ")));
    expect(promoteUpdates.length).toBe(2);
    // The process deployed exactly ONCE (form rides the same process publish — cached).
    expect(flowable.deployBpmn).toHaveBeenCalledTimes(1);
  });

  it("PUBLISH: one failing item (engine down on process) → 207, config items still flipped", async () => {
    const pool = makePool({
      apps: { [APP_ID]: { display_name: "Заявки", tier: "draft" } },
      bindings: [{ process_key: PROC_KEY, form_key: null, start_form_key: null }],
      processStatus: { [PROC_KEY]: { name: "Согласование", status: "draft" } },
      formBindings: { [PROC_KEY]: [FORM_KEY] },
      procPublishStatus: "draft",
    });
    const flowable = makeFlowable(false); // deploy fails → engine_unavailable
    register(router, pool, flowable);
    const route = router.find("POST", `/api/applications/${APP_ID}/publish-solution`)!;
    const res = makeRes();
    await route.handler(makeReq() as any, res as any, { id: APP_ID });

    expect(res.statusCode).toBe(207);
    const out = res.json;
    expect(out.all_ok).toBe(false);
    const app = out.results.find((r: any) => r.kind === "application");
    expect(app.ok).toBe(true);
    const proc = out.results.find((r: any) => r.kind === "process");
    expect(proc.ok).toBe(false);
    expect(proc.error).toBeTruthy();
    // The form rides the failed process → also ok:false, mirroring the process error.
    const form = out.results.find((r: any) => r.kind === "form");
    expect(form.ok).toBe(false);
  });

  it("PUBLISH: already-published items are skipped as ok:true (no promote)", async () => {
    const pool = makePool({ apps: { [APP_ID]: { display_name: "Заявки", tier: "published" } } });
    register(router, pool, makeFlowable());
    const route = router.find("POST", `/api/applications/${APP_ID}/publish-solution`)!;
    const res = makeRes();
    await route.handler(makeReq() as any, res as any, { id: APP_ID });

    expect(res.statusCode).toBe(200);
    const out = res.json;
    expect(out.all_ok).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ kind: "application", ok: true, error: null });
    // No tier flip happened (already published).
    const promoteUpdates = pool._queries.filter((q) => /tier = 'published'/.test(q.replace(/\s+/g, " ")));
    expect(promoteUpdates.length).toBe(0);
  });
});
