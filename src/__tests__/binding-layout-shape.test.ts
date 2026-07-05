/**
 * src/__tests__/binding-layout-shape.test.ts  (T-0656 — F1 regression)
 *
 * Regression for the latent shape mismatch the T-0656 refactor fixed: the real
 * FormDesigner document is { schemaVersion, source, root: {type:'section', …} }
 * — the tree hangs off `.root`. classifyFloorBoundary treats the passed object
 * AS the root node and only descends `.children`/`.tabs` (never `.root`), so a
 * genuine FormDesigner document used to classify as FALSE Floor-2 (409) on the
 * HUMAN save path (POST /api/forms/binding). classifyLayoutSave now normalizes
 * the shape to the classifier's {type:'root', children:[root]} contract.
 *
 * This test posts a real {root:…} document with only live-schema fieldKeys and
 * asserts it is accepted (Floor-1 → 201/200), NOT rejected 409. It also asserts a
 * {root:…} doc carrying a custom (code) node IS still rejected — the normalization
 * did not weaken the gate.
 *
 * No real DB: stub pg.Pool replays the layout + live-schema queries. Dev auth.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerBindingRoutes } from "../http/binding.js";

const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const APP_ID = "b0000000-0000-0000-0000-0000000000aa";
const PROCESS_KEY = "record";
const FORM_KEY = "record-form";
const LIVE_SCHEMA_KEYS = ["title", "amount"];

/** A real FormDesigner-shaped document: tree under `.root`, keys ∈ live schema. */
const FORMDESIGNER_DOC = {
  schemaVersion: 1,
  source: { applicationId: APP_ID },
  root: {
    type: "section",
    id: "s1",
    children: [
      { type: "field", id: "f1", fieldKey: "title", widget: "text", label: "Заголовок" },
      { type: "field", id: "f2", fieldKey: "amount", widget: "money", label: "Сумма" },
    ],
  },
};

/** Same shape, but with a custom (code) node → must still be Floor-2. */
const FORMDESIGNER_DOC_WITH_CUSTOM = {
  schemaVersion: 1,
  source: {},
  root: {
    type: "section",
    children: [
      { type: "field", fieldKey: "title", widget: "text" },
      { type: "custom", componentId: "evil-widget" },
    ],
  },
};

function makeStubPool(liveKeys: string[] | null): pg.Pool {
  const client = {
    query: async (text: string) => {
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
      // getBinding SELECT (no existing row → INSERT path)
      if (text.includes("FROM choros.form_binding") && text.includes("SELECT")) return { rows: [] };
      if (text.includes("INSERT INTO choros.form_binding")) return { rows: [] };
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

async function postBinding(port: number, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/forms/binding",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
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
    req.write(payload);
    req.end();
  });
}

describe("POST /api/forms/binding — real FormDesigner {root:…} document (F1 regression)", () => {
  it("accepts a {root:…} document with only live-schema keys as Floor-1 (was false-409)", async () => {
    const srv = await startServer(makeStubPool(LIVE_SCHEMA_KEYS));
    try {
      const res = await postBinding(srv.port, {
        process_key: PROCESS_KEY,
        form_key: FORM_KEY,
        layout: FORMDESIGNER_DOC,
      });
      // 201 created (or 200 updated) — the point is NOT 409 WRONG_FLOOR.
      expect([200, 201]).toContain(res.status);
    } finally { await srv.close(); }
  });

  it("still rejects a {root:…} document carrying a custom (code) node → 409", async () => {
    const srv = await startServer(makeStubPool(LIVE_SCHEMA_KEYS));
    try {
      const res = await postBinding(srv.port, {
        process_key: PROCESS_KEY,
        form_key: FORM_KEY,
        layout: FORMDESIGNER_DOC_WITH_CUSTOM,
      });
      expect(res.status).toBe(409);
      expect((res.body as { error?: { code?: string } }).error?.code).toBe("WRONG_FLOOR");
    } finally { await srv.close(); }
  });

  it("still rejects a {root:…} document with a dangling fieldKey (not in live schema) → 409", async () => {
    const srv = await startServer(makeStubPool(["title"])); // "amount" now NOT in live schema
    try {
      const res = await postBinding(srv.port, {
        process_key: PROCESS_KEY,
        form_key: FORM_KEY,
        layout: FORMDESIGNER_DOC, // binds "amount"
      });
      expect(res.status).toBe(409);
    } finally { await srv.close(); }
  });
});
