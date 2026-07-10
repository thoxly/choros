/**
 * src/__tests__/node-resolver.test.ts — T-0733 [R-1 из ревью T-0712, столп 4
 * анти-UUID] unit tests for src/db/node-resolver.ts (batchResolveOrgNodes /
 * resolveNodeDisplay).
 *
 * Mirrors actor-resolver.test.ts's structure and mock-pool technique (pure
 * unit — no live Postgres; a live-PG proof of the full HTTP wiring lives in
 * ci/checks/db/org-move-api.db.test.ts).
 *
 * Covers:
 *   (a) resolves a department by id → kind "department", name = display_name
 *   (b) resolves a position by id → kind "position", name = title
 *   (c) ONE query resolves BOTH a department id and a position id together
 *       (UNION ALL — no N+1, no second round-trip for the second table)
 *   (d) an id matching NO row (deleted / never existed) is NOT an error —
 *       resolveNodeDisplay falls back to an honest {id, name:id, kind,
 *       resolved:false} shape — mirrors resolveActorDisplay's contract
 *   (e) empty input (both lists) short-circuits to an empty Map with ZERO
 *       queries (no pool.connect() call at all)
 *   (f) one query for a department-only page (positionIds=[]) — the empty
 *       side never trips an error
 *   (g) tenant-scope: the query is bound to the caller-supplied tenantId
 *       (defence-in-depth — same discipline as batchResolveActors/listOrgTree)
 *   (h) resolveNodeDisplay(_, null/undefined/"", kind) → honest empty-id
 *       fallback, never throws
 *   (i) duplicate ids in the input are deduped before querying (Set semantics)
 */

import { describe, it, expect } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  batchResolveOrgNodes,
  resolveNodeDisplay,
  type ResolvedNode,
} from "../db/node-resolver.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

interface NodeFixture {
  id: string;
  name: string;
  kind: "department" | "position";
}

function makeFakePool(
  nodes: NodeFixture[],
): { pool: Pool; queryCount: () => number; lastTenantParam: () => string | null } {
  let queryCount = 0;
  let lastTenantParam: string | null = null;

  const fakeClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (sql: string, params?: unknown[]): Promise<any> => {
      // BEGIN / SET LOCAL / COMMIT / ROLLBACK — no-op, not counted as the real query.
      if (!sql.includes("FROM choros.department")) {
        return { rows: [] };
      }
      queryCount += 1;
      const p = (params ?? []) as [string, string[], string[]];
      lastTenantParam = p[0] ?? null;
      const deptIds = new Set(p[1] ?? []);
      const posIds = new Set(p[2] ?? []);
      const rows = nodes
        .filter(
          (n) =>
            (n.kind === "department" && deptIds.has(n.id)) ||
            (n.kind === "position" && posIds.has(n.id)),
        )
        .map((n) => ({ id: n.id, name: n.name, kind: n.kind }));
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
// (a) department resolves
// ---------------------------------------------------------------------------

describe("T-0733 batchResolveOrgNodes — (a) department resolves by id", () => {
  it("returns kind department + name = display_name", async () => {
    const deptId = "aaaaaaaa-0000-0000-0000-00000000000a";
    const { pool } = makeFakePool([{ id: deptId, name: "Финансы", kind: "department" }]);

    const resolved = await batchResolveOrgNodes(pool, TENANT_ID, [deptId], []);
    const hit = resolved.get(deptId);

    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("department");
    expect(hit?.name).toBe("Финансы");
    expect(hit?.resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) position resolves
// ---------------------------------------------------------------------------

describe("T-0733 batchResolveOrgNodes — (b) position resolves by id", () => {
  it("returns kind position + name = title", async () => {
    const posId = "bbbbbbbb-0000-0000-0000-00000000000b";
    const { pool } = makeFakePool([{ id: posId, name: "Контролёр расчётов", kind: "position" }]);

    const resolved = await batchResolveOrgNodes(pool, TENANT_ID, [], [posId]);
    const hit = resolved.get(posId);

    expect(hit?.kind).toBe("position");
    expect(hit?.name).toBe("Контролёр расчётов");
  });
});

// ---------------------------------------------------------------------------
// (c) one query resolves BOTH tables together — no N+1, no second round-trip
// ---------------------------------------------------------------------------

describe("T-0733 batchResolveOrgNodes — (c) one query resolves a department AND a position id together", () => {
  it("a page mixing department.moved and position.moved targets costs exactly ONE query", async () => {
    const deptId = "cccccccc-0000-0000-0000-00000000000c";
    const posId = "dddddddd-0000-0000-0000-00000000000d";
    const { pool, queryCount } = makeFakePool([
      { id: deptId, name: "Клиентский сервис", kind: "department" },
      { id: posId, name: "Линия поддержки L1", kind: "position" },
    ]);

    const resolved = await batchResolveOrgNodes(pool, TENANT_ID, [deptId], [posId]);

    expect(resolved.get(deptId)?.name).toBe("Клиентский сервис");
    expect(resolved.get(posId)?.name).toBe("Линия поддержки L1");
    expect(resolved.size).toBe(2);
    expect(queryCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (d) unresolved id — honest fallback, never an error
// ---------------------------------------------------------------------------

describe("T-0733 batchResolveOrgNodes / resolveNodeDisplay — (d) unresolved id is not an error", () => {
  it("an id matching no department/position row (deleted, or never existed) is simply ABSENT from the Map", async () => {
    const { pool } = makeFakePool([]);
    const resolved = await batchResolveOrgNodes(pool, TENANT_ID, ["ghost-dept"], ["ghost-pos"]);
    expect(resolved.has("ghost-dept")).toBe(false);
    expect(resolved.has("ghost-pos")).toBe(false);
  });

  it("resolveNodeDisplay falls back to {id, name:id, kind, resolved:false} — never invents a name", () => {
    const resolved = new Map<string, ResolvedNode>();
    const fallback = resolveNodeDisplay(resolved, "dept-9", "department");
    expect(fallback).toEqual({
      id: "dept-9",
      name: "dept-9",
      kind: "department",
      resolved: false,
    });
  });
});

// ---------------------------------------------------------------------------
// (e) empty input on BOTH sides — zero queries
// ---------------------------------------------------------------------------

describe("T-0733 batchResolveOrgNodes — (e) empty input on both sides short-circuits with ZERO queries", () => {
  it("passing two empty arrays never calls pool.connect() at all", async () => {
    let connected = false;
    const pool = {
      connect: async () => {
        connected = true;
        throw new Error("should never be called for empty input");
      },
    } as unknown as Pool;

    const resolved = await batchResolveOrgNodes(pool, TENANT_ID, [], []);
    expect(resolved.size).toBe(0);
    expect(connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (f) one side empty — the empty side never trips an error (ANY('{}') is safe)
// ---------------------------------------------------------------------------

describe("T-0733 batchResolveOrgNodes — (f) a department-only page (positionIds=[]) still resolves cleanly", () => {
  it("resolves the department id with positionIds=[] and does not throw", async () => {
    const deptId = "eeeeeeee-0000-0000-0000-00000000000e";
    const { pool, queryCount } = makeFakePool([{ id: deptId, name: "Платформа", kind: "department" }]);

    const resolved = await batchResolveOrgNodes(pool, TENANT_ID, [deptId], []);
    expect(resolved.get(deptId)?.name).toBe("Платформа");
    expect(queryCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (g) tenant-scope — the query is bound to the caller-supplied tenantId.
// ---------------------------------------------------------------------------

describe("T-0733 batchResolveOrgNodes — (g) tenant-scope (defence-in-depth)", () => {
  it("the tenantId param passed to the query is the caller-supplied one, never a request-derived value", async () => {
    const deptId = "ffffffff-0000-0000-0000-00000000000f";
    const { pool, lastTenantParam } = makeFakePool([{ id: deptId, name: "Отдел", kind: "department" }]);

    await batchResolveOrgNodes(pool, TENANT_ID, [deptId], []);
    expect(lastTenantParam()).toBe(TENANT_ID);
  });
});

// ---------------------------------------------------------------------------
// (h) resolveNodeDisplay honest empty-id fallback
// ---------------------------------------------------------------------------

describe("T-0733 resolveNodeDisplay — (h) null/undefined/empty id → honest empty fallback, never throws", () => {
  it("null/undefined/'' all yield the same honest empty shape", () => {
    const resolved = new Map<string, ResolvedNode>();
    expect(resolveNodeDisplay(resolved, null, "department")).toEqual({
      id: "", name: "—", kind: "department", resolved: false,
    });
    expect(resolveNodeDisplay(resolved, undefined, "position")).toEqual({
      id: "", name: "—", kind: "position", resolved: false,
    });
    expect(resolveNodeDisplay(resolved, "", "department")).toEqual({
      id: "", name: "—", kind: "department", resolved: false,
    });
  });
});

// ---------------------------------------------------------------------------
// (i) duplicate ids deduped before querying
// ---------------------------------------------------------------------------

describe("T-0733 batchResolveOrgNodes — (i) duplicate ids in the input are deduped before querying", () => {
  it("the same department id repeated in the input still costs ONE query", async () => {
    const deptId = "12121212-0000-0000-0000-000000000012";
    const { pool, queryCount } = makeFakePool([{ id: deptId, name: "Дубль", kind: "department" }]);

    const resolved = await batchResolveOrgNodes(pool, TENANT_ID, [deptId, deptId, deptId], []);
    expect(resolved.size).toBe(1);
    expect(queryCount()).toBe(1);
  });
});
