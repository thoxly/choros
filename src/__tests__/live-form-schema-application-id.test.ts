/**
 * src/__tests__/live-form-schema-application-id.test.ts — T-0711 (P2, review
 * T-0706 finding #37).
 *
 * `process_app_binding` carries `UNIQUE (tenant_id, process_key,
 * application_id)` (migration 075) — ONE process CAN be bound to SEVERAL
 * applications (the FormDesigner "Приложение" picker, T-0669, lets an author
 * pick any of them). Before this task, `resolveLiveRecordSchema`
 * (src/db/live-form-schema.ts) resolved step 1 by `process_key` ALONE, with
 * NO `application_id` filter and NO `ORDER BY` — so a process bound to 2+
 * apps let the resolver return WHICHEVER row Postgres's planner happened to
 * pick, independent of (and possibly disagreeing with) whatever application
 * the caller had actually selected.
 *
 * This is a PURE unit suite (fake pg.PoolClient, no live Postgres) that pins
 * down the exact SQL CONTRACT the fix adds:
 *   AC-1 no applicationId given → the query's 3rd bind param is `null` (never
 *        `undefined` — pg rejects undefined bind params) and the SQL text
 *        carries an `ORDER BY` (deterministic fallback, not planner-order).
 *   AC-2 applicationId given → it is passed through as the 3rd bind param
 *        verbatim, and the SQL text's WHERE clause references it
 *        (`application_id = $3`, guarded by an `IS NULL OR` for the no-op
 *        case — ONE statement covers both branches).
 *   AC-3 a malformed (non-UUID-shaped) applicationId fails CLOSED before any
 *        query runs (no query issued at all — never silently ignored).
 *   AC-4 resolveLiveSchemaFieldKeys / resolveLiveCollectionSubKeys forward
 *        applicationId to resolveLiveRecordSchema unchanged.
 *   AC-5 classifyLayoutSave (src/http/binding.ts) threads ONE applicationId
 *        to BOTH of its live-schema resolver calls — the field key-set and
 *        the collection sub-key-sets must resolve against the SAME binding
 *        row, never two different ones.
 *
 * The DB-level proof that the SQL is actually CORRECT against real Postgres
 * (a process genuinely bound to 2 different applications, each with a
 * different live schema) lives in
 * ci/checks/db/T-0711-multi-app-binding-resolve.db.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import type pg from "pg";
import {
  resolveLiveRecordSchema,
  resolveLiveSchemaFieldKeys,
  resolveLiveCollectionSubKeys,
} from "../db/live-form-schema.js";
import { classifyLayoutSave } from "../http/binding.js";
import type { FormDocument } from "../core/floor-boundary.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const PROC_KEY = "t0711-proc";
const APP_A = "b1111111-1111-1111-1111-111111111111";
const APP_B = "b2222222-2222-2222-2222-222222222222";

/** Records every (sql, params) pair passed to `.query`, replays a single
 * fixed binding row + registry_def so the resolver reaches a concrete
 * schema. Never inspects params beyond what a given test asserts. */
function makeSpyClient(opts: {
  bindingRows: Array<{ application_id: string; target_registry_slug: string | null }>;
  schemaProps: Record<string, unknown>;
}): { client: pg.PoolClient; calls: Array<{ sql: string; params: unknown[] | undefined }> } {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const client = {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, " ").trim();
      if (/FROM choros\.process_app_binding/.test(s)) {
        return { rows: opts.bindingRows };
      }
      if (/FROM choros\.registry_def/.test(s)) {
        return { rows: [{ record_schema: { properties: opts.schemaProps } }] };
      }
      return { rows: [] };
    }),
  } as unknown as pg.PoolClient;
  return { client, calls };
}

describe("T-0711 · resolveLiveRecordSchema — application_id SQL contract", () => {
  it("AC-1: no applicationId → 3rd bind param is null (not undefined), SQL carries ORDER BY", async () => {
    const { client, calls } = makeSpyClient({
      bindingRows: [{ application_id: APP_A, target_registry_slug: null }],
      schemaProps: { amountA: { type: "number" } },
    });
    const schema = await resolveLiveRecordSchema(client, TENANT_ID, PROC_KEY);
    expect(schema).toEqual({ properties: { amountA: { type: "number" } } });
    const bindingCall = calls.find((c) => /process_app_binding/.test(c.sql));
    expect(bindingCall).toBeDefined();
    expect(bindingCall!.params).toEqual([TENANT_ID, PROC_KEY, null]);
    expect(bindingCall!.sql).toMatch(/ORDER BY/i);
    expect(bindingCall!.sql).toMatch(/application_id\s*=\s*\$3/);
  });

  it("AC-2: applicationId given → passed through verbatim as the 3rd bind param", async () => {
    const { client, calls } = makeSpyClient({
      bindingRows: [{ application_id: APP_A, target_registry_slug: null }],
      schemaProps: {},
    });
    await resolveLiveRecordSchema(client, TENANT_ID, PROC_KEY, APP_A);
    const bindingCall = calls.find((c) => /process_app_binding/.test(c.sql));
    expect(bindingCall!.params).toEqual([TENANT_ID, PROC_KEY, APP_A]);
  });

  it("AC-3: a malformed applicationId fails closed — no query issued at all", async () => {
    const { client, calls } = makeSpyClient({ bindingRows: [], schemaProps: {} });
    const schema = await resolveLiveRecordSchema(client, TENANT_ID, PROC_KEY, "not-a-uuid");
    expect(schema).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("AC-4a: resolveLiveSchemaFieldKeys forwards applicationId unchanged", async () => {
    const { client, calls } = makeSpyClient({
      bindingRows: [{ application_id: APP_A, target_registry_slug: null }],
      schemaProps: { amountA: { type: "number" } },
    });
    const keys = await resolveLiveSchemaFieldKeys(client, TENANT_ID, PROC_KEY, APP_A);
    expect(keys).toEqual(new Set(["amountA"]));
    const bindingCall = calls.find((c) => /process_app_binding/.test(c.sql));
    expect(bindingCall!.params).toEqual([TENANT_ID, PROC_KEY, APP_A]);
  });

  it("AC-4b: resolveLiveCollectionSubKeys forwards applicationId unchanged", async () => {
    const { client, calls } = makeSpyClient({
      bindingRows: [{ application_id: APP_B, target_registry_slug: null }],
      schemaProps: { items: { type: "array", items: { type: "object", properties: { sku: {} } } } },
    });
    const map = await resolveLiveCollectionSubKeys(client, TENANT_ID, PROC_KEY, APP_B);
    expect(map).toEqual({ items: ["sku"] });
    const bindingCall = calls.find((c) => /process_app_binding/.test(c.sql));
    expect(bindingCall!.params).toEqual([TENANT_ID, PROC_KEY, APP_B]);
  });
});

describe("T-0711 · classifyLayoutSave — threads ONE applicationId to both resolver calls", () => {
  const CLEAN_DOC: FormDocument = {
    type: "root",
    children: [{ type: "field", fieldKey: "amountA" }],
  };

  it("both the field-key resolution and the collection-subkey resolution receive the SAME applicationId", async () => {
    const { client, calls } = makeSpyClient({
      bindingRows: [{ application_id: APP_A, target_registry_slug: null }],
      schemaProps: { amountA: { type: "number" } },
    });
    await classifyLayoutSave(client, TENANT_ID, PROC_KEY, CLEAN_DOC as unknown as Record<string, unknown>, APP_A);

    const bindingCalls = calls.filter((c) => /process_app_binding/.test(c.sql));
    // resolveLiveSchemaFieldKeys + resolveLiveCollectionSubKeys each resolve
    // via resolveLiveRecordSchema → TWO process_app_binding SELECTs, both
    // pinned to the SAME applicationId (never one pinned + one unpinned).
    expect(bindingCalls.length).toBe(2);
    for (const c of bindingCalls) {
      expect(c.params).toEqual([TENANT_ID, PROC_KEY, APP_A]);
    }
  });

  it("omitting applicationId threads null (deterministic fallback) to both resolver calls identically", async () => {
    const { client, calls } = makeSpyClient({
      bindingRows: [{ application_id: APP_A, target_registry_slug: null }],
      schemaProps: { amountA: { type: "number" } },
    });
    await classifyLayoutSave(client, TENANT_ID, PROC_KEY, CLEAN_DOC as unknown as Record<string, unknown>);

    const bindingCalls = calls.filter((c) => /process_app_binding/.test(c.sql));
    expect(bindingCalls.length).toBe(2);
    for (const c of bindingCalls) {
      expect(c.params).toEqual([TENANT_ID, PROC_KEY, null]);
    }
  });
});
