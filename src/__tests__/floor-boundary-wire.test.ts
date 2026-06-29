/**
 * T-0520 · floor-boundary-wire.test.ts
 *
 * Tests for the classifyFloorBoundary integration into the Floor-1 authoring path.
 *
 * Covers (per task spec):
 *   (a) Valid Floor-1 edit (relabel_field with clean doc) → applied, 200.
 *   (b) Lже-Floor-1: kind=relabel_field but doc carries custom-node / new fieldKey
 *       → 409 WRONG_FLOOR, edit NOT applied.
 *   (c) route=sandbox (Floor-2 signal) → 409 WRONG_FLOOR (Floor-1 endpoint refuses).
 *
 * Additional:
 *   (d) Valid Floor-1 edit WITHOUT doc → 200 (R-4 passes; no doc = empty KEY_SET).
 *   (e) Doc with reactSource (code-signal, R-3) → 409 WRONG_FLOOR.
 *   (f) Doc with fieldKey absent from schema (dangling binding, R-4) → 409 WRONG_FLOOR.
 *   (g) Doc with only declarative nodes, all fieldKeys in schema → 200 (Floor-1).
 *
 * No real DB: uses dev-mode auth (x-dev-user) and stateless Mode A body
 * (fields[] supplied in body). Route requires no pool in dev mode.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Router } from "../http/router.js";
import { registerFloor1EditorRoutes } from "../http/floor1-editor.js";
import type { BindingField } from "../core/binding-compat.js";
import type { FormDocument } from "../core/floor-boundary.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const BASE_FIELDS: BindingField[] = [
  { key: "supplier", type: "string", required: true, label: "Supplier" },
  { key: "category", type: "string", required: false, label: "Category" },
];

/** A purely declarative form-document — all fieldKeys in BASE_FIELDS. */
const CLEAN_DOC: FormDocument = {
  type: "root",
  children: [
    { type: "section", title: "Основные данные", children: [
      { type: "field", fieldKey: "supplier" },
      { type: "field", fieldKey: "category" },
    ]},
  ],
};

/** A doc that introduces a new fieldKey not in BASE_FIELDS → R-4 fail (dangling binding). */
const DANGLING_KEY_DOC: FormDocument = {
  type: "root",
  children: [
    { type: "field", fieldKey: "supplier" },
    { type: "field", fieldKey: "new_unknown_field" }, // NOT in BASE_FIELDS
  ],
};

/** A doc with a custom-node (code-signal, R-3). */
const CUSTOM_NODE_DOC: FormDocument = {
  type: "root",
  children: [
    { type: "field", fieldKey: "supplier" },
    { type: "custom", componentId: "my-widget", fieldKey: "category" },
  ],
};

/** A doc with reactSource on a node (code-signal, R-3). */
const REACT_SOURCE_DOC: FormDocument = {
  type: "root",
  children: [
    { type: "field", fieldKey: "supplier", reactSource: "() => <div/>" } as unknown as import("../core/floor-boundary.js").FormDocNode,
  ],
};

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerFloor1EditorRoutes(router, null /* dev mode — no pool needed */);
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
// (a) Valid Floor-1 edit — no doc → 200
// ---------------------------------------------------------------------------

describe("T-0520 (a) — valid Floor-1 relabel_field without doc → 200", () => {
  it("applies the edit and returns 200 when no doc is provided", async () => {
    const { port, close } = await startServer();
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "Поставщик" },
        // no doc — R-4 trivially passes (KEY_SET is empty)
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
// (a-doc) Valid Floor-1 edit with a clean doc → 200
// ---------------------------------------------------------------------------

describe("T-0520 (a-doc) — valid Floor-1 relabel_field with declarative doc → 200", () => {
  it("applies the edit and returns 200 when doc has only declarative nodes + known fieldKeys", async () => {
    const { port, close } = await startServer();
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
// (b) Лже-Floor-1: kind=relabel_field but doc has custom-node → 409 WRONG_FLOOR
// ---------------------------------------------------------------------------

describe("T-0520 (b) — relabel_field kind but doc contains custom-node → 409 WRONG_FLOOR", () => {
  it("rejects with 409 WRONG_FLOOR when doc carries a custom-node (R-3 code-signal)", async () => {
    const { port, close } = await startServer();
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
// (b-reactSource) relabel_field but doc has reactSource → 409 WRONG_FLOOR
// ---------------------------------------------------------------------------

describe("T-0520 (b-reactSource) — relabel_field kind but doc has reactSource field → 409 WRONG_FLOOR", () => {
  it("rejects with 409 WRONG_FLOOR when doc carries reactSource (R-3 code-signal)", async () => {
    const { port, close } = await startServer();
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
// (b-dangling) relabel_field but doc references unknown fieldKey → 409 WRONG_FLOOR
// ---------------------------------------------------------------------------

describe("T-0520 (b-dangling) — relabel_field kind but doc has fieldKey absent from schema → 409 WRONG_FLOOR", () => {
  it("rejects with 409 WRONG_FLOOR when doc carries a dangling fieldKey (R-4 violation)", async () => {
    const { port, close } = await startServer();
    try {
      const resp = await postEdit(port, {
        fields: BASE_FIELDS,
        uiSchema: {},
        edit: { kind: "relabel_field", fieldKey: "supplier", label: "X" },
        doc: DANGLING_KEY_DOC,
      });
      expect(resp.status).toBe(409);
      const b = resp.body as { error: { code: string; message: string } };
      expect(b.error.code).toBe("WRONG_FLOOR");
      // The message should mention the dangling key or Floor-2
      expect(b.error.message).toMatch(/Floor-2|new_unknown_field|R-4/);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// (c) route=sandbox path — Floor-2 content in doc → 409 WRONG_FLOOR
// The floor1-editor endpoint is Floor-1 only; any Floor-2 classification
// (regardless of route:sandbox vs other) results in 409 and a message pointing
// to the Floor-2 authoring path.
// ---------------------------------------------------------------------------

describe("T-0520 (c) — doc with custom-node classified as route:sandbox → 409 WRONG_FLOOR (Floor-1 endpoint refuses)", () => {
  it("responds 409 with route:sandbox in message when doc has componentId", async () => {
    const { port, close } = await startServer();
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
      // Message should mention the sandbox route
      expect(b.error.message).toContain("sandbox");
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Regression guard: valid Floor-1 edits that must NOT be broken by the gate
// ---------------------------------------------------------------------------

describe("T-0520 regression — valid Floor-1 edits pass the gate unchanged", () => {
  it("toggle_required without doc → 200", async () => {
    const { port, close } = await startServer();
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
    const { port, close } = await startServer();
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

  it("reorder_fields with clean doc → 200", async () => {
    const { port, close } = await startServer();
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

  it("set_help_text without doc → 200", async () => {
    const { port, close } = await startServer();
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
});
