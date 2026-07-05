/**
 * src/__tests__/binding-fields-from-layout.test.ts  (T-0665-e2e — P0 fix)
 *
 * LIVE_PROOF T-0665-e2e found a P0: EVERY form assembled through the
 * FormDesigner drag-n-drop constructor renders as "no form" for the
 * assignee. Two sцепленных causes:
 *
 *   (A) web/src/forms/FormDesigner.jsx's persistLayout() sends
 *       {process_key, form_key, layout} — NEVER `fields`. Before this fix,
 *       src/http/binding.ts's POST handler responded to that shape by
 *       hardcoding `fields = []` (the column is NOT NULL). screen-inbox.jsx's
 *       InboxTaskForm then hit `if (fields.length === 0) return null` BEFORE
 *       it ever looked at `binding.layout` — the fix for THAT half lives in
 *       web/src/screens/screen-inbox.test.jsx (guard-order + hasBoundLayout/
 *       resolveInboxFormHasContent).
 *
 *   (B) The FormDesigner step-picker's datalist suggested the BPMN
 *       userTask's technical `id` (e.g. "Activity_0dsh0ls") as the fillable
 *       stepKey value, but a REAL inbox task's `item.step` is the userTask's
 *       human-readable `name` (src/http/process-start.ts:
 *       `step: firstActiveTask.name`, T-0575 BUG-015) — so a binding saved
 *       via the picker's own suggestion could never be found for a real
 *       task. Fixed in FormDesigner.jsx (datalist option value=t.name).
 *
 * THIS FILE covers the SERVER-SIDE half of (A): fields must be DERIVED from
 * the layout (not hardcoded to []) when the FormDesigner path omits them —
 * so form_binding.fields stays a real projection of what the layout shows,
 * for every OTHER consumer that reads it (not only the layout-aware
 * InboxTaskForm branch) — and exercises the SAME (processKey, stepKey) —
 * i.e. (process_key, item.step) — round-trip using a human-readable step
 * name (mirroring how findWaitingInstanceTask ultimately keys a real task),
 * proving the lookup is not merely a happy-path-with-any-string.
 *
 * No real DB: reuses the stateful stub pg.Pool pattern from
 * binding-get-layout.test.ts (T-0665 F4) — one in-memory row map keyed by
 * `${processKey}:${formKey}`, replaying process_app_binding/registry_def so
 * the live-schema resolution (resolveLiveRecordSchema/deriveFieldsFromLayout)
 * has something real to derive against. Dev auth mode.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerBindingRoutes, collectLayoutFieldKeys, deriveFieldsFromLayout } from "../http/binding.js";

describe("collectLayoutFieldKeys — pure fieldKey walker (no DB)", () => {
  it("collects fieldKey from a nested section/children tree, document order, deduped", () => {
    const doc = {
      root: {
        type: "section",
        children: [
          { type: "field", fieldKey: "a" },
          { type: "section", children: [{ type: "field", fieldKey: "b" }, { type: "field", fieldKey: "a" }] },
          { type: "text", content: "no fieldKey here" },
        ],
      },
    };
    expect(collectLayoutFieldKeys(doc)).toEqual(["a", "b"]);
  });

  it("descends into tabs[].children", () => {
    const doc = {
      root: {
        type: "tabs",
        tabs: [{ children: [{ type: "field", fieldKey: "x" }] }],
      },
    };
    expect(collectLayoutFieldKeys(doc)).toEqual(["x"]);
  });

  it("returns [] for a document with no fieldKey references (pure static content)", () => {
    expect(collectLayoutFieldKeys({ root: { type: "section", children: [{ type: "divider" }] } })).toEqual([]);
  });

  it("returns [] for null/non-object/empty input — never throws", () => {
    expect(collectLayoutFieldKeys(null)).toEqual([]);
    expect(collectLayoutFieldKeys(undefined)).toEqual([]);
    expect(collectLayoutFieldKeys("not an object")).toEqual([]);
    expect(collectLayoutFieldKeys({})).toEqual([]);
  });
});

describe("deriveFieldsFromLayout — unresolvable schema fallback (pure-ish, no HTTP)", () => {
  function stubClientReturningNoAppBinding(): pg.PoolClient {
    return {
      query: async () => ({ rows: [] }), // no process_app_binding row → resolveLiveRecordSchema → null
    } as unknown as pg.PoolClient;
  }

  it("returns [] when the live schema is unresolvable (no process_app_binding) — fails closed, never throws", async () => {
    const client = stubClientReturningNoAppBinding();
    const result = await deriveFieldsFromLayout(client, "a0000000-0000-0000-0000-000000000001", "ghost-process", {
      root: { type: "section", children: [{ type: "field", fieldKey: "x" }] },
    });
    expect(result).toEqual([]);
  });

  it("returns [] immediately when the layout references no fieldKeys (never queries the DB)", async () => {
    let queried = false;
    const client = {
      query: async () => { queried = true; return { rows: [] }; },
    } as unknown as pg.PoolClient;
    const result = await deriveFieldsFromLayout(client, "a0000000-0000-0000-0000-000000000001", "any-process", {
      root: { type: "section", children: [{ type: "divider" }] },
    });
    expect(result).toEqual([]);
    expect(queried).toBe(false); // short-circuit: no fieldKeys → no DB round-trip needed
  });
});

const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const APP_ID = "b0000000-0000-0000-0000-0000000000aa";

// D-064 anti-case discipline: a synthetic, non-case-specific process key +
// human-readable step name — deliberately NOT any of this repo's real demo
// personas/slugs (e.g. not the ТЭЛ "Согласование"/"soglasovanie" literals).
// The point under test is generic: "a human-readable step LABEL (what
// process-start.ts's firstActiveTask.name puts into a real inbox task's
// item.step, per T-0575 BUG-015) must round-trip as the binding lookup key —
// NOT a BPMN technical node id (e.g. "Activity_0dsh0ls")." Any two distinct
// strings demonstrate that; using this repo's specific demo case is neither
// needed nor allowed under the anti-case-lock gate.
const PROCESS_KEY = "custom-review-flow";
const STEP_NAME = "Проверка заявки";

const LIVE_SCHEMA: Record<string, { type: string }> = {
  decision: { type: "string" },
  comment: { type: "string" },
};

const LAYOUT_NO_FIELDS_DOC = {
  schemaVersion: 1,
  source: { applicationId: APP_ID },
  root: {
    type: "section",
    id: "s1",
    children: [
      { type: "field", id: "f1", fieldKey: "decision", widget: "text", label: "Решение" },
      { type: "text", id: "t1", content: "Заполните решение" },
    ],
  },
};

interface StoredRow {
  id: string;
  fields: unknown;
  layout: unknown;
  version: number;
}

/** Stateful stub pool — mirrors binding-get-layout.test.ts's harness. */
function makeStatefulStubPool(): pg.Pool {
  const rows = new Map<string, StoredRow>();

  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [] };
      const t = text.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/i.test(t)) return { rows: [] };
      if (text.includes("role_assignment")) return { rows: [{ cnt: 1 }] };
      if (text.includes("process_app_binding")) return { rows: [{ application_id: APP_ID, target_registry_slug: null }] };
      if (text.includes("registry_def")) {
        return { rows: [{ record_schema: { properties: LIVE_SCHEMA } }] };
      }
      if (text.includes("INSERT INTO choros.form_binding")) {
        const p = params as [string, string, string, string, string, string | null, number];
        const [, id, processKey, formKey, fieldsJson, layoutJson] = p;
        rows.set(`${processKey}:${formKey}`, {
          id,
          fields: JSON.parse(fieldsJson),
          layout: layoutJson !== null ? JSON.parse(layoutJson) : null,
          version: 1,
        });
        return { rows: [] };
      }
      if (text.includes("UPDATE choros.form_binding")) {
        const p = params as [string, string | null, number, number, string, string, string];
        const [fieldsJson, layoutJson, newVersion, , , processKey, formKey] = p;
        const key = `${processKey}:${formKey}`;
        const existing = rows.get(key);
        if (existing) {
          rows.set(key, {
            id: existing.id,
            fields: JSON.parse(fieldsJson),
            layout: layoutJson !== null ? JSON.parse(layoutJson) : existing.layout,
            version: newVersion,
          });
        }
        return { rows: [] };
      }
      if (text.includes("FROM choros.form_binding") && text.includes("SELECT")) {
        const p = params as [string, string, string];
        const [, processKey, formKey] = p;
        const row = rows.get(`${processKey}:${formKey}`);
        if (!row) return { rows: [] };
        return {
          rows: [{
            id: row.id,
            process_key: processKey,
            form_key: formKey,
            fields: row.fields,
            layout: row.layout,
            version: row.version,
            created_at: "0",
            updated_at: "0",
          }],
        };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

async function startServer(pool: pg.Pool): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerBindingRoutes(router, pool, { pool, resolveActorTenant: async () => DEV_TENANT_ID });
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e?: Error) => (e ? reject(e) : resolve()))),
  };
}

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          "x-dev-user": "alice",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("POST /api/forms/binding — fields DERIVED from layout (T-0665-e2e P0, part A)", () => {
  it("a FormDesigner-shaped save (layout only, NO fields key) persists a NON-EMPTY fields[] derived from the layout's fieldKeys", async () => {
    const srv = await startServer(makeStatefulStubPool());
    try {
      const post = await request(srv.port, "POST", "/api/forms/binding", {
        process_key: PROCESS_KEY,
        form_key: STEP_NAME,
        layout: LAYOUT_NO_FIELDS_DOC,
        // deliberately NO `fields` key — this is the exact FormDesigner
        // persistLayout() body shape (T-0665-e2e P0 root cause).
      });
      expect([200, 201]).toContain(post.status);

      const get = await request(
        srv.port,
        "GET",
        `/api/forms/binding?processKey=${encodeURIComponent(PROCESS_KEY)}&stepKey=${encodeURIComponent(STEP_NAME)}`,
      );
      expect(get.status).toBe(200);
      const data = get.body as { fields?: unknown[]; layout?: unknown };
      // MUTATIONAL: before the fix this was [] (binding.ts hardcoded fields=[]
      // whenever layout!==null and body.fields was absent) — with the fix,
      // fields is derived from layout.root's referenced fieldKey ("decision").
      expect(Array.isArray(data.fields)).toBe(true);
      expect(data.fields).not.toEqual([]);
      expect(data.fields).toHaveLength(1);
      expect((data.fields as Array<{ key: string }>)[0].key).toBe("decision");
      // layout itself is untouched by the derivation.
      expect(data.layout).toEqual(LAYOUT_NO_FIELDS_DOC);
    } finally { await srv.close(); }
  });

  it("derived fields carry the TYPE from the live record_schema (not a generic placeholder)", async () => {
    const srv = await startServer(makeStatefulStubPool());
    try {
      await request(srv.port, "POST", "/api/forms/binding", {
        process_key: PROCESS_KEY,
        form_key: STEP_NAME,
        layout: LAYOUT_NO_FIELDS_DOC,
      });
      const get = await request(
        srv.port,
        "GET",
        `/api/forms/binding?processKey=${encodeURIComponent(PROCESS_KEY)}&stepKey=${encodeURIComponent(STEP_NAME)}`,
      );
      const data = get.body as { fields: Array<{ key: string; type: string }> };
      // deriveFieldType (field-type-dictionary.ts) maps JSON-schema
      // {type:"string"} (no format/enum) → the FieldDef type "text" — this
      // assertion pins that the TYPE genuinely flows through
      // deriveFieldDefsFromSchema, not a hardcoded placeholder like "string".
      expect(data.fields[0].type).toBe("text");
      expect(data.fields[0].type).not.toBe("string");
    } finally { await srv.close(); }
  });

  it("a layout referencing a fieldKey NOT in the live schema is rejected 409 BEFORE derivation runs (R-4 gate, unchanged)", async () => {
    // A dangling fieldKey is caught by classifyLayoutSave's existing R-4
    // check (floor-boundary.ts) — the SAME gate every layout save already
    // runs through, BEFORE deriveFieldsFromLayout is ever reached. This
    // pins that the fields-from-layout fix does not create a second,
    // weaker path around that gate.
    const srv = await startServer(makeStatefulStubPool());
    try {
      const docWithGhostKey = {
        schemaVersion: 1,
        source: {},
        root: {
          type: "section",
          children: [
            { type: "field", fieldKey: "decision", widget: "text" },
            { type: "field", fieldKey: "not_in_schema", widget: "text" },
          ],
        },
      };
      const post = await request(srv.port, "POST", "/api/forms/binding", {
        process_key: PROCESS_KEY,
        form_key: STEP_NAME,
        layout: docWithGhostKey,
      });
      expect(post.status).toBe(409);
      expect((post.body as { error?: { code?: string } }).error?.code).toBe("WRONG_FLOOR");
    } finally { await srv.close(); }
  });

  it("explicit body.fields (FormBuilder path) still wins verbatim — layout-derivation never overrides an explicit list", async () => {
    const srv = await startServer(makeStatefulStubPool());
    try {
      const explicitFields = [{ key: "comment", type: "string", required: true, label: "Комментарий" }];
      await request(srv.port, "POST", "/api/forms/binding", {
        processKey: PROCESS_KEY,
        stepKey: STEP_NAME,
        fields: explicitFields,
        layout: LAYOUT_NO_FIELDS_DOC, // layout ALSO present — fields must still win
      });
      const get = await request(
        srv.port,
        "GET",
        `/api/forms/binding?processKey=${encodeURIComponent(PROCESS_KEY)}&stepKey=${encodeURIComponent(STEP_NAME)}`,
      );
      const data = get.body as { fields: Array<{ key: string }> };
      expect(data.fields).toEqual(explicitFields);
    } finally { await srv.close(); }
  });

  it("(process_key, item.step) lookup: the SAME human-readable step name used as a real task's item.step round-trips end to end", async () => {
    // Mirrors LIVE_PROOF T-0665-e2e's real scenario (with a synthetic,
    // non-case-specific step name — see the D-064 anti-case note on
    // STEP_NAME above): a live BPMN instance's item.step is the userTask's
    // human-readable `name` attribute (process-start.ts's
    // firstActiveTask.name, T-0575 BUG-015), NOT the BPMN node's technical id
    // (e.g. "Activity_0dsh0ls"). A binding saved with stepKey=STEP_NAME (what
    // the FIXED FormDesigner picker now writes, post-datalist-value fix) must
    // be found by that exact name — proving the resolve chain
    // FormDesigner-save → form_binding.form_key → InboxTaskForm-lookup shares
    // one key end to end.
    const srv = await startServer(makeStatefulStubPool());
    try {
      const post = await request(srv.port, "POST", "/api/forms/binding", {
        process_key: PROCESS_KEY,
        form_key: STEP_NAME,
        layout: LAYOUT_NO_FIELDS_DOC,
      });
      expect([200, 201]).toContain(post.status);

      const get = await request(
        srv.port,
        "GET",
        `/api/forms/binding?processKey=${encodeURIComponent(PROCESS_KEY)}&stepKey=${encodeURIComponent(STEP_NAME)}`,
      );
      expect(get.status).toBe(200);

      // A lookup by the BPMN technical id (the OLD, wrong picker value) must
      // NOT find this binding — pinning that the fix is name-based, not an
      // accidental match.
      const wrongKeyLookup = await request(
        srv.port,
        "GET",
        `/api/forms/binding?processKey=${encodeURIComponent(PROCESS_KEY)}&stepKey=${encodeURIComponent("Activity_0dsh0ls")}`,
      );
      expect(wrongKeyLookup.status).toBe(404);
    } finally { await srv.close(); }
  });
});
