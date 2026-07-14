/**
 * src/__tests__/record-resolver.test.ts — T-0769 [столп 4 анти-UUID] unit
 * tests for src/db/record-resolver.ts (batchResolveRecords / resolveRecordDisplay).
 *
 * Mirrors node-resolver.test.ts's structure and mock-pool technique (pure
 * unit — no live Postgres; a live-PG HTTP-wiring proof lives in
 * src/__tests__/audit-log.test.ts's T-0769 (9) describe block).
 *
 * Covers:
 *   (a) resolves a record by id → title = the schema-designated title field's
 *       value (deriveSafeRecordTitle/pickTitleFieldKey, registry-title-field.ts)
 *   (b) a blank/missing registry_def.display_name falls back to the generic
 *       "Запись" type label (GENERIC_RECORD_TYPE_LABEL)
 *   (c) a schema with no derivable title field falls back to `«typeLabel»
 *       · <id8>»`
 *   (d) ONE query resolves MULTIPLE record ids together (no N+1)
 *   (e) an id matching NO row (deleted / never existed) is NOT an error —
 *       resolveRecordDisplay returns `null` (NOT a name=id fallback shape —
 *       unlike resolveActorDisplay/resolveNodeDisplay, a deleted record has
 *       genuinely nothing left to name, mirroring resolveSourceRecordProjection)
 *   (f) empty input short-circuits to an empty Map with ZERO queries (no
 *       pool.connect() call at all)
 *   (g) tenant-scope: the query is bound to the caller-supplied tenantId
 *       (defence-in-depth — same discipline as batchResolveActors/batchResolveOrgNodes)
 *   (h) resolveRecordDisplay(_, null/undefined/"") → null, never throws
 *   (i) duplicate ids in the input are deduped before querying (Set semantics)
 *   (j) canOpen is always `true` and appId is always the joined application id
 */

import { describe, it, expect } from "vitest";
import type { Pool, PoolClient } from "pg";
import { batchResolveRecords, resolveRecordDisplay, type ResolvedRecord } from "../db/record-resolver.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

interface RecordFixture {
  id: string;
  data: Record<string, unknown>;
  recordSchema?: unknown;
  typeLabel: string | null;
  appId: string;
}

function makeFakePool(
  records: RecordFixture[],
): { pool: Pool; queryCount: () => number; lastTenantParam: () => string | null } {
  let queryCount = 0;
  let lastTenantParam: string | null = null;

  const fakeClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (sql: string, params?: unknown[]): Promise<any> => {
      // BEGIN / SET LOCAL / COMMIT / ROLLBACK — no-op, not counted as the real query.
      if (!sql.includes("FROM choros.record r")) {
        return { rows: [] };
      }
      queryCount += 1;
      const p = (params ?? []) as [string, string[]];
      lastTenantParam = p[0] ?? null;
      const ids = new Set(p[1] ?? []);
      const rows = records
        .filter((r) => ids.has(r.id))
        .map((r) => ({
          id: r.id,
          data: r.data,
          record_schema: r.recordSchema ?? null,
          type_label: r.typeLabel,
          application_id: r.appId,
        }));
      return { rows };
    },
    release: () => {},
  } as unknown as PoolClient;

  const pool = {
    connect: async () => fakeClient,
  } as unknown as Pool;

  return {
    pool,
    queryCount: () => queryCount,
    lastTenantParam: () => lastTenantParam,
  };
}

// ---------------------------------------------------------------------------
// (a) resolves a record → title = schema-designated title field's value
// ---------------------------------------------------------------------------

describe("T-0769 batchResolveRecords — (a) resolves a record by id (schema title field)", () => {
  it("returns title = the value under the title-like schema key, typeLabel = registry display_name", async () => {
    const recId = "aaaaaaaa-0000-0000-0000-00000000000a";
    const { pool } = makeFakePool([
      {
        id: recId,
        data: { name: "ООО Вектор", inn: "7701234567" },
        recordSchema: { properties: { inn: { type: "string" }, name: { type: "string" } } },
        typeLabel: "Контрагент",
        appId: "app-1",
      },
    ]);

    const resolved = await batchResolveRecords(pool, TENANT_ID, [recId]);
    const hit = resolved.get(recId);

    expect(hit).toBeDefined();
    expect(hit?.title).toBe("ООО Вектор");
    expect(hit?.typeLabel).toBe("Контрагент");
    expect(hit?.canOpen).toBe(true);
    expect(hit?.appId).toBe("app-1");
  });
});

// ---------------------------------------------------------------------------
// (b) blank display_name → generic "Запись" type label
// ---------------------------------------------------------------------------

describe("T-0769 batchResolveRecords — (b) blank registry display_name falls back to generic type label", () => {
  it("falls back to GENERIC_RECORD_TYPE_LABEL ('Запись') when display_name is blank/null", async () => {
    const recId = "bbbbbbbb-0000-0000-0000-00000000000b";
    const { pool } = makeFakePool([
      { id: recId, data: {}, recordSchema: null, typeLabel: "   ", appId: "app-1" },
    ]);

    const resolved = await batchResolveRecords(pool, TENANT_ID, [recId]);
    expect(resolved.get(recId)?.typeLabel).toBe("Запись");
  });
});

// ---------------------------------------------------------------------------
// (c) no derivable title field → «typeLabel · id8» fallback
// ---------------------------------------------------------------------------

describe("T-0769 batchResolveRecords — (c) no derivable title field falls back to '«typeLabel» · <id8>'", () => {
  it("a schema with only number/boolean fields (no title-like key, no textual property) falls back", async () => {
    const recId = "cccccccc-0000-0000-0000-00000000000c";
    const { pool } = makeFakePool([
      {
        id: recId,
        data: { amount: 184000 },
        recordSchema: { properties: { amount: { type: "number" } } },
        typeLabel: "Счёт",
        appId: "app-1",
      },
    ]);

    const resolved = await batchResolveRecords(pool, TENANT_ID, [recId]);
    expect(resolved.get(recId)?.title).toBe(`Счёт · ${recId.slice(0, 8)}`);
  });
});

// ---------------------------------------------------------------------------
// (d) one query resolves MULTIPLE record ids together — no N+1
// ---------------------------------------------------------------------------

describe("T-0769 batchResolveRecords — (d) one query resolves multiple record ids together", () => {
  it("a page with two distinct record ids costs exactly ONE query", async () => {
    const id1 = "dddddddd-0000-0000-0000-00000000000d";
    const id2 = "eeeeeeee-0000-0000-0000-00000000000e";
    const { pool, queryCount } = makeFakePool([
      { id: id1, data: { name: "Первая" }, recordSchema: { properties: { name: { type: "string" } } }, typeLabel: "Запись", appId: "app-1" },
      { id: id2, data: { name: "Вторая" }, recordSchema: { properties: { name: { type: "string" } } }, typeLabel: "Запись", appId: "app-1" },
    ]);

    const resolved = await batchResolveRecords(pool, TENANT_ID, [id1, id2]);

    expect(resolved.get(id1)?.title).toBe("Первая");
    expect(resolved.get(id2)?.title).toBe("Вторая");
    expect(resolved.size).toBe(2);
    expect(queryCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (e) unresolved id — honest miss, resolveRecordDisplay → null (not an error)
// ---------------------------------------------------------------------------

describe("T-0769 batchResolveRecords / resolveRecordDisplay — (e) unresolved id is not an error", () => {
  it("an id matching no record row (deleted, or never existed) is simply ABSENT from the Map", async () => {
    const { pool } = makeFakePool([]);
    const resolved = await batchResolveRecords(pool, TENANT_ID, ["ghost-record"]);
    expect(resolved.has("ghost-record")).toBe(false);
  });

  it("resolveRecordDisplay returns null on a miss — NEVER a name=id fallback shape (a deleted record has nothing left to name)", () => {
    const resolved = new Map<string, ResolvedRecord>();
    expect(resolveRecordDisplay(resolved, "rec-9")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (f) empty input — zero queries
// ---------------------------------------------------------------------------

describe("T-0769 batchResolveRecords — (f) empty input short-circuits with ZERO queries", () => {
  it("passing an empty array never calls pool.connect() at all", async () => {
    let connected = false;
    const pool = {
      connect: async () => {
        connected = true;
        throw new Error("should never be called for empty input");
      },
    } as unknown as Pool;

    const resolved = await batchResolveRecords(pool, TENANT_ID, []);
    expect(resolved.size).toBe(0);
    expect(connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (g) tenant-scope — the query is bound to the caller-supplied tenantId.
// ---------------------------------------------------------------------------

describe("T-0769 batchResolveRecords — (g) tenant-scope (defence-in-depth)", () => {
  it("the tenantId param passed to the query is the caller-supplied one, never a request-derived value", async () => {
    const recId = "ffffffff-0000-0000-0000-00000000000f";
    const { pool, lastTenantParam } = makeFakePool([
      { id: recId, data: {}, recordSchema: null, typeLabel: "Запись", appId: "app-1" },
    ]);

    await batchResolveRecords(pool, TENANT_ID, [recId]);
    expect(lastTenantParam()).toBe(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// (h) resolveRecordDisplay honest empty-id handling
// ---------------------------------------------------------------------------

describe("T-0769 resolveRecordDisplay — (h) null/undefined/empty id → null, never throws", () => {
  it("null/undefined/'' all yield null", () => {
    const resolved = new Map<string, ResolvedRecord>();
    expect(resolveRecordDisplay(resolved, null)).toBeNull();
    expect(resolveRecordDisplay(resolved, undefined)).toBeNull();
    expect(resolveRecordDisplay(resolved, "")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (i) duplicate ids deduped before querying
// ---------------------------------------------------------------------------

describe("T-0769 batchResolveRecords — (i) duplicate ids in the input are deduped before querying", () => {
  it("the same record id repeated in the input still costs ONE query", async () => {
    const recId = "12121212-0000-0000-0000-000000000012";
    const { pool, queryCount } = makeFakePool([
      { id: recId, data: { name: "Дубль" }, recordSchema: { properties: { name: { type: "string" } } }, typeLabel: "Запись", appId: "app-1" },
    ]);

    const resolved = await batchResolveRecords(pool, TENANT_ID, [recId, recId, recId]);
    expect(resolved.size).toBe(1);
    expect(queryCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (j) canOpen always true, appId always the joined application id
// ---------------------------------------------------------------------------

describe("T-0769 batchResolveRecords — (j) canOpen is always true; appId is the joined application id", () => {
  it("canOpen=true and appId is threaded through from registry_def.application_id", async () => {
    const recId = "34343434-0000-0000-0000-000000000034";
    const { pool } = makeFakePool([
      { id: recId, data: { name: "Запись" }, recordSchema: { properties: { name: { type: "string" } } }, typeLabel: "Тип", appId: "app-77" },
    ]);
    const resolved = await batchResolveRecords(pool, TENANT_ID, [recId]);
    const hit = resolved.get(recId);
    expect(hit?.canOpen).toBe(true);
    expect(hit?.appId).toBe("app-77");
  });
});
