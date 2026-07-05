/**
 * src/__tests__/forms-document-ops-wire.test.ts  (T-0656)
 *
 * HTTP-level tests for the agent machine seam POST /api/forms/document-ops.
 * Proves the route:
 *   - 404 when there is no existing form_binding.layout to patch;
 *   - 400 on a malformed / unknown op (fail-closed vocabulary);
 *   - 409 WRONG_FLOOR when the op's result classifies as Floor-2 (dangling
 *     fieldKey vs the LIVE schema) — the SAME judge (classifyLayoutSave) the
 *     human POST /api/forms/binding uses;
 *   - 200 + persisted layout on a valid Floor-1 op, and that the resulting doc
 *     equals what the pure ops produce for the same op (the seam shares the
 *     contract — AC-e).
 *
 * No real DB: a stub pg.Pool replays the layout SELECT/UPDATE + the live-schema
 * resolution the Floor gate needs. Dev auth mode (x-dev-user) so checkRole
 * soft-passes. Mirrors the harness of floor-boundary-wire.test.ts (T-0520).
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerFormDocumentOpsRoute } from "../http/forms-document-ops.js";
import { insertNode, type FormDoc } from "../core/form-document-ops.js";

const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const APP_ID = "b0000000-0000-0000-0000-0000000000aa";
const PROCESS_KEY = "record";
const STEP_KEY = "record-form";

const LIVE_SCHEMA_KEYS = ["supplier", "category"];

/** The stored layout the stub returns for the (processKey, stepKey) binding. */
const STORED_LAYOUT: FormDoc = {
  schemaVersion: 1,
  source: {},
  root: {
    type: "section",
    children: [
      { type: "field", fieldKey: "supplier", widget: "text" },
      { type: "field", fieldKey: "category", widget: "text" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Stub pg.Pool — captures the persisted layout for assertions.
// ---------------------------------------------------------------------------

function makeStubPool(opts: {
  layout: unknown;         // current form_binding.layout (null = no binding to patch)
  liveKeys: string[] | null;
  captured?: { layout?: unknown; version?: number };
}): pg.Pool {
  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [] };
      const t = text.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/i.test(t)) return { rows: [] };
      if (text.includes("role_assignment")) return { rows: [{ cnt: 1 }] };
      // getBindingLayout: SELECT id, ..., layout, version FROM form_binding
      if (text.includes("FROM choros.form_binding") && text.includes("SELECT")) {
        if (opts.layout === null) return { rows: [] };
        return { rows: [{ id: "row1", process_key: PROCESS_KEY, form_key: STEP_KEY, layout: opts.layout, version: 3 }] };
      }
      // classifyLayoutSave: process_app_binding → application_id
      if (text.includes("process_app_binding")) return { rows: [{ application_id: APP_ID }] };
      // classifyLayoutSave: registry_def → record_schema
      if (text.includes("registry_def")) {
        if (opts.liveKeys === null) return { rows: [] };
        const properties: Record<string, unknown> = {};
        for (const k of opts.liveKeys) properties[k] = { type: "string" };
        return { rows: [{ record_schema: { properties } }] };
      }
      // UPDATE form_binding SET layout=..., version=...
      if (text.includes("UPDATE choros.form_binding")) {
        if (opts.captured) {
          opts.captured.layout = params?.[0] ? JSON.parse(params[0] as string) : undefined;
          opts.captured.version = params?.[1] as number;
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

async function startServer(pool: pg.Pool): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerFormDocumentOpsRoute(router, pool, {
    pool,
    resolveActorTenant: async () => DEV_TENANT_ID,
  });
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e?: Error) => (e ? reject(e) : resolve()))),
  };
}

async function postOp(port: number, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/forms/document-ops",
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

describe("POST /api/forms/document-ops — agent machine seam", () => {
  it("404 when there is no existing layout to patch", async () => {
    const srv = await startServer(makeStubPool({ layout: null, liveKeys: LIVE_SCHEMA_KEYS }));
    try {
      const res = await postOp(srv.port, {
        processKey: PROCESS_KEY, stepKey: STEP_KEY,
        op: { kind: "insert", containerPath: [], node: { type: "divider" } },
      });
      expect(res.status).toBe(404);
    } finally { await srv.close(); }
  });

  it("400 on an unknown op kind (fail-closed vocabulary)", async () => {
    const srv = await startServer(makeStubPool({ layout: STORED_LAYOUT, liveKeys: LIVE_SCHEMA_KEYS }));
    try {
      const res = await postOp(srv.port, {
        processKey: PROCESS_KEY, stepKey: STEP_KEY,
        op: { kind: "explode", containerPath: [] },
      });
      expect(res.status).toBe(400);
    } finally { await srv.close(); }
  });

  it("400 when op is missing", async () => {
    const srv = await startServer(makeStubPool({ layout: STORED_LAYOUT, liveKeys: LIVE_SCHEMA_KEYS }));
    try {
      const res = await postOp(srv.port, { processKey: PROCESS_KEY, stepKey: STEP_KEY });
      expect(res.status).toBe(400);
    } finally { await srv.close(); }
  });

  it("200 + persists the layout for a valid Floor-1 insert, and the result equals the pure-op output (AC-e)", async () => {
    const captured: { layout?: unknown; version?: number } = {};
    const srv = await startServer(makeStubPool({ layout: STORED_LAYOUT, liveKeys: LIVE_SCHEMA_KEYS, captured }));
    try {
      const op = { kind: "insert", containerPath: [] as number[], node: { type: "divider" } };
      const res = await postOp(srv.port, { processKey: PROCESS_KEY, stepKey: STEP_KEY, op });
      expect(res.status).toBe(200);
      const respBody = res.body as { layout: FormDoc; version: number };
      expect(respBody.version).toBe(4); // 3 + 1

      // The seam's output must equal what the pure front-ops produce for the same op.
      const expected = insertNode(STORED_LAYOUT, [], { type: "divider" });
      expect(respBody.layout).toEqual(expected);
      expect(captured.layout).toEqual(expected);
    } finally { await srv.close(); }
  });

  it("409 WRONG_FLOOR when the op inserts a dangling fieldKey (same judge as /binding, AC-f)", async () => {
    const srv = await startServer(makeStubPool({ layout: STORED_LAYOUT, liveKeys: LIVE_SCHEMA_KEYS }));
    try {
      const res = await postOp(srv.port, {
        processKey: PROCESS_KEY, stepKey: STEP_KEY,
        // "ghost" is NOT in the live schema → R-4 (named-binding integrity) → Floor-2.
        op: { kind: "insert", containerPath: [], node: { type: "field", fieldKey: "ghost", widget: "text" } },
      });
      expect(res.status).toBe(409);
      const env = res.body as { error?: { code?: string; message?: string } };
      expect(env.error?.code).toBe("WRONG_FLOOR");
    } finally { await srv.close(); }
  });

  it("409 WRONG_FLOOR when the op inserts a custom (code) node — R-3 code-signal", async () => {
    const srv = await startServer(makeStubPool({ layout: STORED_LAYOUT, liveKeys: LIVE_SCHEMA_KEYS }));
    try {
      const res = await postOp(srv.port, {
        processKey: PROCESS_KEY, stepKey: STEP_KEY,
        op: { kind: "insert", containerPath: [], node: { type: "custom", componentId: "x" } },
      });
      expect(res.status).toBe(409);
    } finally { await srv.close(); }
  });
});
