/**
 * src/__tests__/binding-get-layout.test.ts  (T-0665 — F4 regression)
 *
 * LIVE_PROOF T-0656 found that GET /api/forms/binding (both the T-0072 named
 * route and the T-0376 actor-scoped route) answered {fields, version, ...}
 * WITHOUT `layout` — even though form_binding.layout (T-0506) is the exact
 * column the human FormDesigner and the T-0656 agent document-ops seam both
 * write to. Production's InboxTaskForm (screen-inbox.jsx) therefore could
 * never render a DnD-assembled or agent-edited layout: the data existed in
 * Postgres but was invisible to every reachable client.
 *
 * This test proves, with a STATEFUL stub pool (POST persists into an
 * in-memory row, GET reads it back — same process, no real DB):
 *   (AC-a) POST with a real (non-'record') processKey/stepKey + layout
 *          succeeds (200/201, not 409) — the write path was never broken;
 *          the P0 was purely "no UI sets doc.step" (fixed client-side).
 *   (AC-b) GET on that binding returns `layout` byte-identical to what was
 *          POSTed (both the actor-scoped route AND the T-0072 named route).
 *   (legacy / NF3) A binding saved WITHOUT a layout (fields-only, the
 *          pre-T-0506 FormBuilder shape) is read back WITHOUT a `layout` key
 *          at all — not `null`, not `{}` — so a client can branch on
 *          `'layout' in data` to tell "no layout ever saved" apart from "an
 *          empty layout was saved" (the two are NOT equivalent).
 *
 * No real DB: a stateful stub pg.Pool holds one row map keyed by
 * `${processKey}:${formKey}`, mirroring the upsert/read shape of
 * choros.form_binding. Dev auth mode (x-dev-user softens checkRole to
 * "authenticated" per ADR §4 footnote — process_designer seeding is T-0666,
 * out of scope here).
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerBindingRoutes } from "../http/binding.js";

const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const APP_ID = "b0000000-0000-0000-0000-0000000000aa";

// A REAL-looking process key (not the 'record' fallback) — the point of
// AC-a is that a genuine processKey/stepKey pair saves fine; the P0 LIVE_PROOF
// found was entirely that the client never SENT one, not a server defect.
const PROCESS_KEY = "purchaseApproval";
const STEP_KEY = "approveRequest";
const LIVE_SCHEMA_KEYS = ["amount", "requester"];

const LAYOUT_DOC = {
  schemaVersion: 1,
  source: { applicationId: APP_ID },
  step: { processKey: PROCESS_KEY, step: STEP_KEY },
  root: {
    type: "section",
    id: "s1",
    children: [
      { type: "field", id: "f1", fieldKey: "amount", widget: "money", label: "Сумма" },
      { type: "field", id: "f2", fieldKey: "requester", widget: "text", label: "Заявитель" },
    ],
  },
};

interface StoredRow {
  id: string;
  fields: unknown;
  layout: unknown;
  version: number;
}

/** A stateful stub pool: one persisted row map, upsert + read semantics. */
function makeStatefulStubPool(liveKeys: string[] | null) {
  const rows = new Map<string, StoredRow>();

  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [] };
      const t = text.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/i.test(t)) return { rows: [] };
      if (text.includes("role_assignment")) return { rows: [{ cnt: 1 }] };
      if (text.includes("process_app_binding")) return { rows: [{ application_id: APP_ID }] };
      if (text.includes("registry_def")) {
        if (liveKeys === null) return { rows: [] };
        const properties: Record<string, unknown> = {};
        for (const k of liveKeys) properties[k] = { type: "string" };
        return { rows: [{ record_schema: { properties } }] };
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
        const [fieldsJson, layoutJson, newVersion, , tenantId, processKey, formKey] = p;
        void tenantId;
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
        // Both getBinding (fields+layout+version+...) and getBindingLayout
        // (id/process_key/form_key/layout/version) select by (tenant, process, form).
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

describe("POST + GET /api/forms/binding — layout round-trip (T-0665 F4, AC-a/AC-b)", () => {
  it("POST with a real (non-'record') processKey/stepKey + layout succeeds — not 409", async () => {
    const srv = await startServer(makeStatefulStubPool(LIVE_SCHEMA_KEYS));
    try {
      const res = await request(srv.port, "POST", "/api/forms/binding", {
        processKey: PROCESS_KEY,
        stepKey: STEP_KEY,
        layout: LAYOUT_DOC,
      });
      expect([200, 201]).toContain(res.status);
    } finally { await srv.close(); }
  });

  it("GET returns `layout` byte-identical to what was POSTed (actor-scoped route)", async () => {
    const srv = await startServer(makeStatefulStubPool(LIVE_SCHEMA_KEYS));
    try {
      const post = await request(srv.port, "POST", "/api/forms/binding", {
        processKey: PROCESS_KEY,
        stepKey: STEP_KEY,
        layout: LAYOUT_DOC,
      });
      expect([200, 201]).toContain(post.status);

      const get = await request(
        srv.port,
        "GET",
        `/api/forms/binding?processKey=${encodeURIComponent(PROCESS_KEY)}&stepKey=${encodeURIComponent(STEP_KEY)}`,
      );
      expect(get.status).toBe(200);
      const data = get.body as { layout?: unknown; fields?: unknown; processKey?: string; stepKey?: string };
      expect(data.layout).toEqual(LAYOUT_DOC);
      expect(data.processKey).toBe(PROCESS_KEY);
      expect(data.stepKey).toBe(STEP_KEY);
    } finally { await srv.close(); }
  });

  it("GET returns `layout` on the T-0072 named route (/tenants/:id/processes/:pk/forms/:fk/binding) too", async () => {
    const srv = await startServer(makeStatefulStubPool(LIVE_SCHEMA_KEYS));
    try {
      const post = await request(srv.port, "POST", "/api/forms/binding", {
        processKey: PROCESS_KEY,
        stepKey: STEP_KEY,
        layout: LAYOUT_DOC,
      });
      expect([200, 201]).toContain(post.status);

      const get = await request(
        srv.port,
        "GET",
        `/tenants/${DEV_TENANT_ID}/processes/${encodeURIComponent(PROCESS_KEY)}/forms/${encodeURIComponent(STEP_KEY)}/binding`,
      );
      expect(get.status).toBe(200);
      const data = get.body as { layout?: unknown };
      expect(data.layout).toEqual(LAYOUT_DOC);
    } finally { await srv.close(); }
  });

  it("a binding saved WITHOUT a layout (legacy FormBuilder shape) reads back with NO `layout` key at all", async () => {
    const srv = await startServer(makeStatefulStubPool(LIVE_SCHEMA_KEYS));
    try {
      const post = await request(srv.port, "POST", "/api/forms/binding", {
        processKey: PROCESS_KEY,
        stepKey: STEP_KEY,
        fields: [{ key: "amount", type: "string", required: false, label: "Сумма" }],
        // no `layout` at all — the legacy FormBuilder body shape.
      });
      expect([200, 201]).toContain(post.status);

      const get = await request(
        srv.port,
        "GET",
        `/api/forms/binding?processKey=${encodeURIComponent(PROCESS_KEY)}&stepKey=${encodeURIComponent(STEP_KEY)}`,
      );
      expect(get.status).toBe(200);
      const data = get.body as Record<string, unknown>;
      expect("layout" in data).toBe(false);
      expect(Array.isArray(data.fields)).toBe(true);
    } finally { await srv.close(); }
  });
});
