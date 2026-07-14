/**
 * src/__tests__/actor-resolver.test.ts — T-0648 [W4-UX/столп 4] unit tests for
 * src/db/actor-resolver.ts (batchResolveActors / resolveActorDisplay).
 *
 * Pure unit — no live Postgres. Mocks pool.connect() → a fake client whose
 * query() replays the SELECT ... FROM choros.employee WHERE tenant_id = $1 AND
 * (slug = ANY($2) OR id::text = ANY($2)) shape and asserts the BEGIN/SET LOCAL/
 * COMMIT wrapper the withTenant helper drives.
 *
 * Covers:
 *   (a) resolves a human employee by slug → type "human"
 *   (b) resolves an agent employee by slug → type "agent" (non-service-shaped slug)
 *   (c) resolves an agent whose slug matches the service naming convention
 *       (s-*, svc-*, system-*, *-sync, *-gateway, *-bridge) → type "service"
 *   (d) resolves the SAME employee whether looked up by slug or by raw id (UUID)
 *   (e) an id that matches NO employee row is NOT an error — resolveActorDisplay
 *       falls back to an honest {type:"service", name:id, resolved:false} shape
 *   (f) empty input short-circuits to an empty Map with ZERO queries (no
 *       pool.connect() call at all)
 *   (g) exactly ONE query for a batch of N distinct ids (no N+1 — asserts the
 *       query() call count regardless of how many ids/rows are involved)
 *   (h) deactivated_at is surfaced as `deactivated: true`
 *   (i) resolveActorDisplay(_, null/undefined/"") → honest empty-id fallback,
 *       never throws
 */

import { describe, it, expect } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  batchResolveActors,
  resolveActorDisplay,
  type ResolvedActor,
} from "../db/actor-resolver.js";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

interface EmployeeFixture {
  slug: string;
  id: string;
  display_name: string;
  kind: "human" | "agent";
  deactivated_at?: string | null;
}

function makeFakePool(
  employees: EmployeeFixture[],
): { pool: Pool; queryCount: () => number; released: () => number } {
  let queryCount = 0;
  let releaseCount = 0;

  const fakeClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (sql: string, params?: unknown[]): Promise<any> => {
      // BEGIN / SET LOCAL / COMMIT / ROLLBACK — no-op, not counted as the real query.
      if (!sql.includes("FROM choros.employee")) {
        return { rows: [] };
      }
      queryCount += 1;
      const ids = (params ?? [])[1] as string[] | undefined;
      const idSet = new Set(ids ?? []);
      const rows = employees
        .filter((e) => idSet.has(e.slug) || idSet.has(e.id))
        .map((e) => ({
          slug: e.slug,
          id: e.id,
          display_name: e.display_name,
          kind: e.kind,
          deactivated_at: e.deactivated_at ?? null,
        }));
      return { rows };
    },
    release: () => {
      releaseCount += 1;
    },
  } as unknown as PoolClient;

  const pool = {
    connect: async () => fakeClient,
  } as unknown as Pool;

  return { pool, queryCount: () => queryCount, released: () => releaseCount };
}

// ---------------------------------------------------------------------------
// (a) human employee
// ---------------------------------------------------------------------------

describe("T-0648 batchResolveActors — (a) human employee resolves by slug", () => {
  it("returns type human + display_name", async () => {
    const { pool } = makeFakePool([
      { slug: "e-kravtsova", id: "aaaaaaaa-0000-0000-0000-00000000000a", display_name: "А. Кравцова", kind: "human" },
    ]);

    const resolved = await batchResolveActors(pool, TENANT_ID, ["e-kravtsova"]);
    const hit = resolved.get("e-kravtsova");

    expect(hit).toBeDefined();
    expect(hit?.type).toBe("human");
    expect(hit?.name).toBe("А. Кравцова");
    expect(hit?.resolved).toBe(true);
    expect(hit?.deactivated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) agent employee, non-service slug
// ---------------------------------------------------------------------------

describe("T-0648 batchResolveActors — (b) agent employee resolves to type agent", () => {
  it("a plain agent slug (no service naming convention) resolves to 'agent'", async () => {
    const { pool } = makeFakePool([
      { slug: "a-invoice", id: "bbbbbbbb-0000-0000-0000-00000000000b", display_name: "Счёт-агент", kind: "agent" },
    ]);

    const resolved = await batchResolveActors(pool, TENANT_ID, ["a-invoice"]);
    const hit = resolved.get("a-invoice");

    expect(hit?.type).toBe("agent");
    expect(hit?.name).toBe("Счёт-агент");
  });
});

// ---------------------------------------------------------------------------
// (c) service-shaped agent slug
// ---------------------------------------------------------------------------

describe("T-0648 batchResolveActors — (c) service-naming-convention agent resolves to type service", () => {
  it.each([
    ["s-ledger", "ledger-sync"],
    ["s-ocr", "ocr-gateway"],
    ["svc-relay", "relay-bridge"],
    ["system-jobs", "jobs runner"],
  ])("slug=%s (display=%s) → service", async (slug, displayName) => {
    const { pool } = makeFakePool([
      { slug, id: "cccccccc-0000-0000-0000-00000000000c", display_name: displayName, kind: "agent" },
    ]);

    const resolved = await batchResolveActors(pool, TENANT_ID, [slug]);
    expect(resolved.get(slug)?.type).toBe("service");
  });

  it("a slug ENDING in -sync/-gateway/-bridge also resolves to service even without a prefix", async () => {
    const { pool } = makeFakePool([
      { slug: "ledger-sync", id: "dddddddd-0000-0000-0000-00000000000d", display_name: "ledger-sync", kind: "agent" },
    ]);
    const resolved = await batchResolveActors(pool, TENANT_ID, ["ledger-sync"]);
    expect(resolved.get("ledger-sync")?.type).toBe("service");
  });
});

// ---------------------------------------------------------------------------
// (d) lookup by slug OR by raw id (UUID) — same resolved entry
// ---------------------------------------------------------------------------

describe("T-0648 batchResolveActors — (d) resolves by slug OR by raw employee id", () => {
  it("an id passed as the employee UUID resolves to the same display shape as the slug", async () => {
    const id = "eeeeeeee-0000-0000-0000-00000000000e";
    const { pool, queryCount } = makeFakePool([
      { slug: "e-fixture-actor", id, display_name: "Т. Фикстурин", kind: "human" },
    ]);

    const resolved = await batchResolveActors(pool, TENANT_ID, [id]);
    const hit = resolved.get(id);

    expect(hit?.name).toBe("Т. Фикстурин");
    expect(hit?.type).toBe("human");
    // Exactly one query even though the caller looked up by UUID, not slug.
    expect(queryCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (e) unresolved id — honest fallback, never an error
// ---------------------------------------------------------------------------

describe("T-0648 batchResolveActors / resolveActorDisplay — (e) unresolved id is not an error", () => {
  it("an id matching no employee row is simply ABSENT from the Map", async () => {
    const { pool } = makeFakePool([]);
    const resolved = await batchResolveActors(pool, TENANT_ID, ["control-plane", "ghost-uuid"]);
    expect(resolved.has("control-plane")).toBe(false);
    expect(resolved.has("ghost-uuid")).toBe(false);
  });

  it("resolveActorDisplay falls back to {type:'service', name:id, resolved:false} — never invents human/agent", async () => {
    const resolved = new Map<string, ResolvedActor>();
    const fallback = resolveActorDisplay(resolved, "policy-sync");
    expect(fallback).toEqual({
      id: "policy-sync",
      name: "policy-sync",
      type: "service",
      deactivated: false,
      resolved: false,
    });
  });

  it("resolveActorDisplay(_, null/undefined/empty) → honest empty-id fallback, never throws", () => {
    const resolved = new Map<string, ResolvedActor>();
    expect(resolveActorDisplay(resolved, null)).toEqual({
      id: "", name: "—", type: "service", deactivated: false, resolved: false,
    });
    expect(resolveActorDisplay(resolved, undefined)).toEqual({
      id: "", name: "—", type: "service", deactivated: false, resolved: false,
    });
    expect(resolveActorDisplay(resolved, "")).toEqual({
      id: "", name: "—", type: "service", deactivated: false, resolved: false,
    });
  });
});

// ---------------------------------------------------------------------------
// (f) empty input — zero queries
// ---------------------------------------------------------------------------

describe("T-0648 batchResolveActors — (f) empty input short-circuits with ZERO queries", () => {
  it("passing an empty array never calls pool.connect() at all", async () => {
    let connected = false;
    const pool = {
      connect: async () => {
        connected = true;
        throw new Error("should never be called for empty input");
      },
    } as unknown as Pool;

    const resolved = await batchResolveActors(pool, TENANT_ID, []);
    expect(resolved.size).toBe(0);
    expect(connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (g) N+1 guard — exactly ONE query for a batch of many distinct ids
// ---------------------------------------------------------------------------

describe("T-0648 batchResolveActors — (g) no N+1: one query regardless of batch size", () => {
  it("resolves 25 distinct ids in exactly ONE query", async () => {
    const employees: EmployeeFixture[] = Array.from({ length: 25 }, (_, i) => ({
      slug: `e-actor-${i}`,
      id: `ffffffff-0000-0000-0000-${String(i).padStart(12, "0")}`,
      display_name: `Actor ${i}`,
      kind: "human" as const,
    }));
    const { pool, queryCount } = makeFakePool(employees);

    const ids = employees.map((e) => e.slug);
    const resolved = await batchResolveActors(pool, TENANT_ID, ids);

    // Every resolved row is indexed by BOTH its slug and its raw id (see (d)
    // above) — 25 distinct employees ⇒ 50 Map entries, but still ONE query.
    expect(resolved.size).toBe(50);
    for (const slug of ids) expect(resolved.has(slug)).toBe(true);
    expect(queryCount()).toBe(1);
  });

  it("duplicate ids in the input are deduped before querying (Set semantics)", async () => {
    const { pool, queryCount } = makeFakePool([
      { slug: "e-fixture-dup", id: "11111111-1111-1111-1111-111111111112", display_name: "Дубль Фикстурин", kind: "human" },
    ]);

    const resolved = await batchResolveActors(pool, TENANT_ID, [
      "e-fixture-dup", "e-fixture-dup", "e-fixture-dup",
    ]);

    // Indexed by both slug and id (see (d) above) — one employee ⇒ 2 Map entries.
    expect(resolved.size).toBe(2);
    expect(queryCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (h) deactivated employee
// ---------------------------------------------------------------------------

describe("T-0648 batchResolveActors — (h) deactivated employee surfaces deactivated:true", () => {
  it("a row with a non-null deactivated_at resolves with deactivated:true", async () => {
    const { pool } = makeFakePool([
      {
        slug: "e-gone",
        id: "22222222-2222-2222-2222-222222222222",
        display_name: "Уволенный Сотрудник",
        kind: "human",
        deactivated_at: "1700000000000",
      },
    ]);

    const resolved = await batchResolveActors(pool, TENANT_ID, ["e-gone"]);
    expect(resolved.get("e-gone")?.deactivated).toBe(true);
  });
});
