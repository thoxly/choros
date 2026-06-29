/**
 * T-0520 · floor-boundary-wire.test.ts
 *
 * Tests for the classifyFloorBoundary integration into the Floor-1 authoring path,
 * with the BLOCKING #1 fix: R-4 (named-binding integrity) validates the document's
 * KEY_SET against the AUTHORITATIVE live registry_def.record_schema (from DB),
 * NOT against body.fields[] (the untrusted request that also carries `doc`).
 *
 * Covers (per task spec):
 *   (a) Valid Floor-1 edit WITHOUT doc → applied, 200 (no DB read needed).
 *   (a-doc) Valid Floor-1 edit + declarative doc whose keys ∈ LIVE schema → 200.
 *   (b) Лже-Floor-1: kind=relabel_field but doc carries custom-node → 409 (R-3).
 *   (b-reactSource) doc carries reactSource → 409 (R-3).
 *   (b-dangling) BLOCKING #1 PROOF: dangling key present in BOTH doc AND body.fields[]
 *                but ABSENT from the live (mocked) record_schema → 409 (was 200 before).
 *   (c) route=sandbox (componentId) → 409, message mentions sandbox.
 *   (d) FAIL-CLOSED: doc present but live schema unresolvable (no registry_def) → 409.
 *
 * No real DB: a stub pg.Pool replays the live-schema resolution queries
 * (process_app_binding → registry_def.record_schema) from an in-memory fixture.
 * Dev auth mode (x-dev-user) so authorizeEditor soft-passes without touching the pool.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerFloor1EditorRoutes } from "../http/floor1-editor.js";
import { registerBindingRoutes } from "../http/binding.js";
import type { BindingField } from "../core/binding-compat.js";
import type { FormDocument } from "../core/floor-boundary.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const APP_ID = "b0000000-0000-0000-0000-0000000000aa";

// body.fields[] — the UNTRUSTED request-supplied key-set.
const BASE_FIELDS: BindingField[] = [
  { key: "supplier", type: "string", required: true, label: "Supplier" },
  { key: "category", type: "string", required: false, label: "Category" },
];

// The AUTHORITATIVE live record_schema key-set (what the stub pool returns).
// "evil_new_field" is NOT here — that is the whole point of the BLOCKING fix.
const LIVE_SCHEMA_KEYS = ["supplier", "category"];

/** A purely declarative form-document — all fieldKeys in the LIVE schema. */
const CLEAN_DOC: FormDocument = {
  type: "root",
  children: [
    { type: "section", title: "Основные данные", children: [
      { type: "field", fieldKey: "supplier" },
      { type: "field", fieldKey: "category" },
    ]},
  ],
};

/** A doc + body.fields[] that BOTH carry a key absent from the LIVE schema → R-4 fail. */
const DANGLING_KEY_DOC: FormDocument = {
  type: "root",
  children: [
    { type: "field", fieldKey: "supplier" },
    { type: "field", fieldKey: "evil_new_field" }, // in body.fields[] too, NOT in live schema
  ],
};
const DANGLING_FIELDS: BindingField[] = [
  ...BASE_FIELDS,
  { key: "evil_new_field", type: "string", required: false, label: "Evil" }, // attacker whitelists it
];

/** A doc with a custom-node (code-signal, R-3). */
const CUSTOM_NODE_DOC: FormDocument = {
  type: "root",
  children: [
    { type: "field", fieldKey: "supplier" },
    { type: "custom", componentId: "my-widget", fieldKey: "category" },
  ],
};

/** A doc with reactSource on a node (code-signal, R-3). */
const REACT_SOURCE_DOC = {
  type: "root",
  children: [
    { type: "field", fieldKey: "supplier", reactSource: "() => <div/>" },
  ],
} as unknown as FormDocument;

// ---------------------------------------------------------------------------
// Stub pg.Pool — replays live-schema resolution queries from an in-memory fixture.
//
// resolveLiveSchemaFieldKeys issues two queries inside withTenantTx:
//   1. SELECT application_id FROM choros.process_app_binding WHERE ... process_key
//   2. SELECT record_schema FROM choros.registry_def WHERE ... slug='soglasovanie'
//
// `liveKeys`: when non-null, the registry resolves and record_schema.properties
//             carries those keys. When null, the registry_def lookup returns 0 rows.
// `hasAppBinding`: when false, the process_app_binding lookup returns 0 rows.
// ---------------------------------------------------------------------------

function makeStubPool(
  liveKeys: string[] | null,
  hasAppBinding = true,
): pg.Pool {
  const client = {
    query: async (text: string, _params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [] };
      const t = text.trim();
      // withTenantTx control statements
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/i.test(t)) {
        return { rows: [] };
      }
      // role_assignment lookup (checkRole) — not reached in dev mode, but be safe.
      if (text.includes("role_assignment")) {
        return { rows: [{ cnt: 1 }] };
      }
      // Step 1: process_app_binding → application_id
      if (text.includes("process_app_binding")) {
        return hasAppBinding ? { rows: [{ application_id: APP_ID }] } : { rows: [] };
      }
      // Step 2: registry_def → record_schema
      if (text.includes("registry_def")) {
        if (liveKeys === null) return { rows: [] }; // no registry → fail-closed
        const properties: Record<string, unknown> = {};
        for (const k of liveKeys) properties[k] = { type: "string" };
        return { rows: [{ record_schema: { properties } }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

async function startServer(
  pool: pg.Pool | null,
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerFloor1EditorRoutes(router, pool);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e?: Error) => (e ? reject(e) : resolve())),
      ),
  };
}

async function postEdit(
  port: number,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/tenants/${DEV_TENANT_ID}/processes/purchase-approval/forms/purchase-form/edits`,
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
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// (a) Valid Floor-1 edit — no doc → 200 (no DB read needed; pool may be null)
// ---------------------------------------------------------------------------

describe("T-0520 (a) — valid Floor-1 relabel_field without doc → 200", () => {
  it("applies the edit and returns 200 when no doc is provided (no live-schema read)", async () => {
    const { port, close } = await startServer(null);
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "Поставщик" },
      });
      expect(resp.status).toBe(200);
      const b = resp.body as { fields: BindingField[] };
      expect(b.fields.find((f) => f.key === "supplier")?.label).toBe("Поставщик");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (a-doc) Valid Floor-1 edit + declarative doc, keys ∈ LIVE schema → 200
// ---------------------------------------------------------------------------

describe("T-0520 (a-doc) — valid Floor-1 relabel_field with declarative doc whose keys ∈ live schema → 200", () => {
  it("returns 200 when doc has only declarative nodes + fieldKeys present in the LIVE schema", async () => {
    const { port, close } = await startServer(makeStubPool(LIVE_SCHEMA_KEYS));
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "Поставщик" },
        doc: CLEAN_DOC,
      });
      expect(resp.status).toBe(200);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (b) custom-node → 409 WRONG_FLOOR (R-3 code-signal)
// ---------------------------------------------------------------------------

describe("T-0520 (b) — relabel_field kind but doc contains custom-node → 409 WRONG_FLOOR", () => {
  it("rejects with 409 WRONG_FLOOR when doc carries a custom-node (R-3)", async () => {
    const { port, close } = await startServer(makeStubPool(LIVE_SCHEMA_KEYS));
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "X" },
        doc: CUSTOM_NODE_DOC,
      });
      expect(resp.status).toBe(409);
      const b = resp.body as { error: { code: string; message: string } };
      expect(b.error.code).toBe("WRONG_FLOOR");
      expect(b.error.message).toContain("Floor-2");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (b-reactSource) reactSource → 409 WRONG_FLOOR (R-3)
// ---------------------------------------------------------------------------

describe("T-0520 (b-reactSource) — doc has reactSource field → 409 WRONG_FLOOR", () => {
  it("rejects with 409 WRONG_FLOOR when doc carries reactSource (R-3)", async () => {
    const { port, close } = await startServer(makeStubPool(LIVE_SCHEMA_KEYS));
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "X" },
        doc: REACT_SOURCE_DOC,
      });
      expect(resp.status).toBe(409);
      const b = resp.body as { error: { code: string } };
      expect(b.error.code).toBe("WRONG_FLOOR");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (b-dangling) BLOCKING #1 PROOF — dangling key in BOTH doc AND body.fields[]
// but ABSENT from the live (mocked) schema → 409. Before the fix this was 200
// because R-4 sourced fieldKeys from body.fields[] (attacker-controlled).
// ---------------------------------------------------------------------------

describe("T-0520 (b-dangling) — BLOCKING #1: dangling key in doc+body.fields but NOT in live schema → 409", () => {
  it("rejects with 409 WRONG_FLOOR even though body.fields[] whitelists the dangling key (R-4 uses LIVE schema)", async () => {
    // Live schema only knows supplier/category. The attacker lists evil_new_field in
    // BOTH the doc and body.fields[] to satisfy R-4. With the fix, R-4 consults the
    // LIVE schema (supplier/category) → evil_new_field is a dangling binding → 409.
    const { port, close } = await startServer(makeStubPool(LIVE_SCHEMA_KEYS));
    try {
      const resp = await postEdit(port, {
        fields: DANGLING_FIELDS, // attacker-controlled, includes evil_new_field
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "X" },
        doc: DANGLING_KEY_DOC, // references evil_new_field
      });
      expect(resp.status).toBe(409);
      const b = resp.body as { error: { code: string; message: string } };
      expect(b.error.code).toBe("WRONG_FLOOR");
      expect(b.error.message).toMatch(/Floor-2|evil_new_field|R-4/);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) route=sandbox — componentId → 409, message mentions sandbox
// ---------------------------------------------------------------------------

describe("T-0520 (c) — doc with custom-node classified route:sandbox → 409 (Floor-1 endpoint refuses)", () => {
  it("responds 409 with route:sandbox in message when doc has componentId", async () => {
    const { port, close } = await startServer(makeStubPool(LIVE_SCHEMA_KEYS));
    try {
      const sandboxDoc: FormDocument = {
        type: "root",
        children: [{ type: "custom", componentId: "rich-editor", fieldKey: "supplier" }],
      };
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "X" },
        doc: sandboxDoc,
      });
      expect(resp.status).toBe(409);
      const b = resp.body as { error: { code: string; message: string } };
      expect(b.error.code).toBe("WRONG_FLOOR");
      expect(b.error.message).toContain("sandbox");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (d) FAIL-CLOSED — doc present but live schema unresolvable → 409
// ---------------------------------------------------------------------------

describe("T-0520 (d) — fail-closed: doc present but no live registry_def → 409", () => {
  it("returns 409 when the process has no app binding (live schema unresolvable)", async () => {
    const { port, close } = await startServer(makeStubPool(null, /* hasAppBinding */ false));
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "X" },
        doc: CLEAN_DOC,
      });
      expect(resp.status).toBe(409);
      const b = resp.body as { error: { code: string; message: string } };
      expect(b.error.code).toBe("WRONG_FLOOR");
    } finally {
      await close();
    }
  });

  it("returns 409 when the app exists but has no soglasovanie registry_def", async () => {
    const { port, close } = await startServer(makeStubPool(null, /* hasAppBinding */ true));
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "X" },
        doc: CLEAN_DOC,
      });
      expect(resp.status).toBe(409);
    } finally {
      await close();
    }
  });

  it("returns 409 when a doc is sent but no pool is wired (no DB → fail-closed)", async () => {
    const { port, close } = await startServer(null);
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "X" },
        doc: CLEAN_DOC,
      });
      expect(resp.status).toBe(409);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Regression — valid Floor-1 edits WITHOUT doc must NOT be broken by the gate.
// No-doc path → no live-schema read → pool may be null.
// ---------------------------------------------------------------------------

describe("T-0520 regression — valid Floor-1 edits (no doc) pass the gate unchanged", () => {
  it("toggle_required without doc → 200", async () => {
    const { port, close } = await startServer(null);
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "toggle_required", fieldKey: "category", required: true },
      });
      expect(resp.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("hide_field without doc → 200", async () => {
    const { port, close } = await startServer(null);
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "hide_field", fieldKey: "category" },
      });
      expect(resp.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("set_help_text without doc → 200", async () => {
    const { port, close } = await startServer(null);
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "set_help_text", fieldKey: "supplier", helpText: "Выберите поставщика" },
      });
      expect(resp.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("reorder_fields with clean doc whose keys ∈ live schema → 200", async () => {
    const { port, close } = await startServer(makeStubPool(LIVE_SCHEMA_KEYS));
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: {
          kind: "reorder_fields",
          orders: [
            { fieldKey: "supplier", displayOrder: 1 },
            { fieldKey: "category", displayOrder: 2 },
          ],
        },
        doc: CLEAN_DOC,
      });
      expect(resp.status).toBe(200);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// binding.ts POST /api/forms/binding — FormDesigner/agent layout-emit path.
// Proves the EXACT adversarial reproduction (dangling key in BOTH layout AND
// body.fields[], absent from live schema) now yields 409 (was 200 before the fix).
// ---------------------------------------------------------------------------

/**
 * binding.ts upsert stub: serves checkRole (count) + live-schema queries +
 * (after the gate) getBinding. The gate fires BEFORE getBinding, so for the
 * 409 cases only the live-schema queries matter.
 */
function makeBindingStubPool(liveKeys: string[] | null, hasAppBinding = true): pg.Pool {
  const client = {
    query: async (text: string, _params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [] };
      const t = text.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/i.test(t)) return { rows: [] };
      if (text.includes("role_assignment")) return { rows: [{ cnt: 1 }] };
      if (text.includes("process_app_binding")) {
        return hasAppBinding ? { rows: [{ application_id: APP_ID }] } : { rows: [] };
      }
      if (text.includes("registry_def")) {
        if (liveKeys === null) return { rows: [] };
        const properties: Record<string, unknown> = {};
        for (const k of liveKeys) properties[k] = { type: "string" };
        return { rows: [{ record_schema: { properties } }] };
      }
      // getBinding (only reached when gate passes) — pretend none exists → INSERT path.
      if (text.includes("form_binding")) return { rows: [] };
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

async function startBindingServer(pool: pg.Pool): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerBindingRoutes(router, pool, {
    pool,
    resolveActorTenant: async () => DEV_TENANT_ID,
  });
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e?: Error) => (e ? reject(e) : resolve())),
      ),
  };
}

async function postBinding(port: number, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/api/forms/binding`,
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
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("T-0520 binding.ts — POST /api/forms/binding layout gate", () => {
  it("BLOCKING #1 repro: dangling key in layout + body.fields[] but NOT in live schema → 409 (was 200)", async () => {
    const { port, close } = await startBindingServer(makeBindingStubPool(LIVE_SCHEMA_KEYS));
    try {
      // EXACTLY the coordinator's reproduction: attacker controls fields[] and layout.
      const resp = await postBinding(port, {
        processKey: "purchase-approval",
        stepKey: "purchase-form",
        fields: [{ key: "evil_new_field", type: "string", required: false }],
        layout: { type: "root", children: [{ type: "field", fieldKey: "evil_new_field" }] },
      });
      expect(resp.status).toBe(409);
      const b = resp.body as { error: { code: string } };
      expect(b.error.code).toBe("WRONG_FLOOR");
    } finally {
      await close();
    }
  });

  it("valid layout whose keys ∈ live schema → not 409 (gate passes; persists)", async () => {
    const { port, close } = await startBindingServer(makeBindingStubPool(LIVE_SCHEMA_KEYS));
    try {
      const resp = await postBinding(port, {
        processKey: "purchase-approval",
        stepKey: "purchase-form",
        fields: BASE_FIELDS,
        layout: CLEAN_DOC,
      });
      // Gate passes (all keys in live schema). INSERT path → 201.
      expect(resp.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("layout with custom-node (R-3 code-signal) → 409", async () => {
    const { port, close } = await startBindingServer(makeBindingStubPool(LIVE_SCHEMA_KEYS));
    try {
      const resp = await postBinding(port, {
        processKey: "purchase-approval",
        stepKey: "purchase-form",
        fields: BASE_FIELDS,
        layout: CUSTOM_NODE_DOC,
      });
      expect(resp.status).toBe(409);
    } finally {
      await close();
    }
  });

  it("fail-closed: layout present but no live registry_def → 409", async () => {
    const { port, close } = await startBindingServer(makeBindingStubPool(null, false));
    try {
      const resp = await postBinding(port, {
        processKey: "purchase-approval",
        stepKey: "purchase-form",
        fields: BASE_FIELDS,
        layout: CLEAN_DOC,
      });
      expect(resp.status).toBe(409);
    } finally {
      await close();
    }
  });
});
