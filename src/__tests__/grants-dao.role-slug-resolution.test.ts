/**
 * src/__tests__/grants-dao.role-slug-resolution.test.ts
 *
 * T-0642 [столп1/P0]: unit tests for resolveRoleSlugsByIds — the publish-time
 * role.id → role.slug DAO that fixes userTask assignedRoleId routing.
 *
 * Pure unit (no live Postgres): a minimal fake pg.Pool models the choros.role
 * lookup and records the SQL/params it is asked to run. Mirrors the sibling
 * filterProvisionedAgentEmployeeIds test file's stateless-responder pattern
 * (grants-dao.provisioned-agent.test.ts).
 *
 * Covers:
 *   - resolves only the (tenant-scoped) ids the DB returns, to their slug
 *   - drops a candidate whose row is absent (deleted role / cross-tenant / never existed)
 *   - filters non-UUID ids up-front (never reaches the DB → inherently unresolved)
 *   - empty / all-non-UUID input short-circuits without opening a connection
 *   - dedupes repeated ids before querying
 *   - rejects a non-UUID tenantId (RLS guard, defence-in-depth — inherited from
 *     withTenantReadTx's assertUuid, same as filterProvisionedAgentEmployeeIds)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { resolveRoleSlugsByIds } from "../db/grants-dao.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const ROLE_OWNER  = "e0000000-0000-0000-0000-000000000001"; // tenant-owner (seed, 019_role.sql)
const ROLE_BUH    = "e0000000-0000-0000-0000-000000000002"; // budget-approver (seed)
const ROLE_ABSENT = "e0000000-0000-0000-0000-0000000000ff"; // never a row in this tenant

/**
 * Fake pool whose `choros.role` query returns exactly the {id,slug} rows for the
 * candidate ids present in `roleMap`. All issued SQL is captured for assertions.
 */
function makePool(roleMap: Record<string, string>) {
  const queries: string[] = [];
  const responder = async (sql: string, params?: unknown[]) => {
    queries.push(sql);
    const s = sql.replace(/\s+/g, " ");
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(s) || /SET LOCAL/.test(s)) return { rows: [] };
    if (/FROM choros\.role\b/.test(s)) {
      const candidates = (params?.[1] as string[]) ?? [];
      return {
        rows: candidates
          .filter((id) => id in roleMap)
          .map((id) => ({ id, slug: roleMap[id]! })),
      };
    }
    return { rows: [] };
  };
  const client = { query: vi.fn().mockImplementation(responder), release: vi.fn() };
  return {
    _queries: queries,
    _client: client,
    connect: vi.fn().mockResolvedValue(client),
  };
}

describe("resolveRoleSlugsByIds (unit, no DB)", () => {
  it("resolves ids to their slugs for a tenant-scoped choros.role lookup", async () => {
    const pool = makePool({ [ROLE_OWNER]: "tenant-owner", [ROLE_BUH]: "budget-approver" });
    const resolved = await resolveRoleSlugsByIds(pool as any, TENANT_ID, [ROLE_OWNER, ROLE_BUH]);
    expect(resolved).toEqual(
      new Map([
        [ROLE_OWNER, "tenant-owner"],
        [ROLE_BUH, "budget-approver"],
      ]),
    );
  });

  it("omits an id whose role row is absent (deleted / cross-tenant / never existed)", async () => {
    const pool = makePool({ [ROLE_BUH]: "budget-approver" });
    const resolved = await resolveRoleSlugsByIds(pool as any, TENANT_ID, [ROLE_BUH, ROLE_ABSENT]);
    expect(resolved).toEqual(new Map([[ROLE_BUH, "budget-approver"]]));
    expect(resolved.has(ROLE_ABSENT)).toBe(false);
  });

  it("filters non-UUID ids before the DB (they can never match a uuid column)", async () => {
    const pool = makePool({ [ROLE_BUH]: "budget-approver" });
    const resolved = await resolveRoleSlugsByIds(pool as any, TENANT_ID, [
      "not-a-uuid",
      "",
      "../etc/passwd",
      ROLE_BUH,
    ]);
    expect(resolved).toEqual(new Map([[ROLE_BUH, "budget-approver"]]));
    const roleQuery = pool._client.query.mock.calls.find((c: any[]) => /FROM choros\.role\b/.test(c[0]));
    expect(roleQuery).toBeDefined();
    expect(roleQuery![1][1]).toEqual([ROLE_BUH]);
  });

  it("short-circuits (no connection) when there are no well-formed candidates", async () => {
    const pool = makePool({ [ROLE_BUH]: "budget-approver" });
    const empty = await resolveRoleSlugsByIds(pool as any, TENANT_ID, []);
    expect(empty).toEqual(new Map());
    const allBad = await resolveRoleSlugsByIds(pool as any, TENANT_ID, ["nope", "still-not-a-uuid"]);
    expect(allBad).toEqual(new Map());
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("dedupes repeated ids before querying", async () => {
    const pool = makePool({ [ROLE_BUH]: "budget-approver" });
    const resolved = await resolveRoleSlugsByIds(pool as any, TENANT_ID, [
      ROLE_BUH,
      ROLE_BUH,
      ROLE_BUH,
    ]);
    expect(resolved).toEqual(new Map([[ROLE_BUH, "budget-approver"]]));
    const roleQuery = pool._client.query.mock.calls.find((c: any[]) => /FROM choros\.role\b/.test(c[0]));
    expect(roleQuery![1][1]).toEqual([ROLE_BUH]); // single, deduped element
  });

  it("rejects a non-UUID tenantId (RLS guard, defence-in-depth)", async () => {
    const pool = makePool({ [ROLE_BUH]: "budget-approver" });
    await expect(
      resolveRoleSlugsByIds(pool as any, "not-a-tenant", [ROLE_BUH]),
    ).rejects.toThrow(/UUID/i);
  });
});
