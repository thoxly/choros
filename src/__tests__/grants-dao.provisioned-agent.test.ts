/**
 * src/__tests__/grants-dao.provisioned-agent.test.ts
 *
 * [SECURITY] Unit tests for filterProvisionedAgentEmployeeIds — the publish-time
 * executor-resolution DAO. Pure unit (no live Postgres): a minimal fake pg.Pool
 * models the choros.employee ⨝ choros.agent_card resolution and records the SQL it
 * is asked to run so we can assert the UUID pre-filter and the RLS-scoped query.
 *
 * Covers:
 *   - resolves only the (tenant, kind='agent', agent_card) rows the DB returns
 *   - drops a candidate whose row is absent (non-existent / non-agent / cross-tenant)
 *   - filters non-UUID ids up-front (never reaches the DB → inherently unresolved)
 *   - empty / all-non-UUID input short-circuits without opening a connection
 *   - dedupes repeated ids before querying
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { filterProvisionedAgentEmployeeIds } from "../db/grants-dao.js";

const TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const A_RECON   = "d0000000-0000-0000-0000-000000000002"; // provisioned kind='agent'
const A_INVOICE = "d0000000-0000-0000-0000-000000000003"; // provisioned kind='agent'
const E_HUMAN   = "d0000000-0000-0000-0000-000000000001"; // a human employee (no agent_card)
const ABSENT    = "d0000000-0000-0000-0000-0000000000ff"; // not present in this tenant

/**
 * Fake pool whose employee⨝agent_card query returns exactly the ids from
 * `provisioned` that the caller asked about (params[1] = candidate uuid[]). All
 * issued SQL is captured for assertions. Mirrors the stateless-responder pattern
 * used across the repo's unit suites (grants-dao.test.ts / process-defs.unit.test.ts).
 */
function makePool(provisioned: string[]) {
  const queries: string[] = [];
  const responder = async (sql: string, params?: unknown[]) => {
    queries.push(sql);
    const s = sql.replace(/\s+/g, " ");
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(s) || /SET LOCAL/.test(s)) return { rows: [] };
    if (/FROM choros\.employee e/.test(s) && /JOIN choros\.agent_card/.test(s)) {
      const candidates = (params?.[1] as string[]) ?? [];
      const set = new Set(provisioned);
      return { rows: candidates.filter((id) => set.has(id)).map((id) => ({ id })) };
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

describe("filterProvisionedAgentEmployeeIds (unit, no DB)", () => {
  it("returns only the ids the DB resolves to a provisioned agent", async () => {
    const pool = makePool([A_RECON, A_INVOICE]);
    const resolved = await filterProvisionedAgentEmployeeIds(
      pool as any,
      TENANT_ID,
      [A_RECON, A_INVOICE],
    );
    expect(resolved).toEqual(new Set([A_RECON, A_INVOICE]));
  });

  it("drops a non-existent / non-agent id (absent agent_card row → unresolved)", async () => {
    // Only A_RECON is provisioned; the human id and an absent id resolve to nothing.
    const pool = makePool([A_RECON]);
    const resolved = await filterProvisionedAgentEmployeeIds(
      pool as any,
      TENANT_ID,
      [A_RECON, E_HUMAN, ABSENT],
    );
    expect(resolved).toEqual(new Set([A_RECON]));
    expect(resolved.has(E_HUMAN)).toBe(false);
    expect(resolved.has(ABSENT)).toBe(false);
  });

  it("filters non-UUID ids before the DB (they can never match a uuid column)", async () => {
    const pool = makePool([A_RECON]);
    const resolved = await filterProvisionedAgentEmployeeIds(
      pool as any,
      TENANT_ID,
      ["not-a-uuid", "", "../etc/passwd", A_RECON],
    );
    expect(resolved).toEqual(new Set([A_RECON]));
    // The query only ever carried the well-formed UUID — no invalid uuid cast risk.
    const agentQuery = pool._client.query.mock.calls.find(
      (c: any[]) => /JOIN choros\.agent_card/.test(c[0]),
    );
    expect(agentQuery).toBeDefined();
    expect(agentQuery![1][1]).toEqual([A_RECON]);
  });

  it("short-circuits (no connection) when there are no well-formed candidates", async () => {
    const pool = makePool([A_RECON]);
    const empty = await filterProvisionedAgentEmployeeIds(pool as any, TENANT_ID, []);
    expect(empty).toEqual(new Set());
    const allBad = await filterProvisionedAgentEmployeeIds(
      pool as any,
      TENANT_ID,
      ["nope", "still-not-a-uuid"],
    );
    expect(allBad).toEqual(new Set());
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("dedupes repeated ids before querying", async () => {
    const pool = makePool([A_RECON]);
    const resolved = await filterProvisionedAgentEmployeeIds(
      pool as any,
      TENANT_ID,
      [A_RECON, A_RECON, A_RECON],
    );
    expect(resolved).toEqual(new Set([A_RECON]));
    const agentQuery = pool._client.query.mock.calls.find(
      (c: any[]) => /JOIN choros\.agent_card/.test(c[0]),
    );
    expect(agentQuery![1][1]).toEqual([A_RECON]); // single, deduped element
  });

  it("rejects a non-UUID tenantId (RLS guard, defence-in-depth)", async () => {
    const pool = makePool([A_RECON]);
    await expect(
      filterProvisionedAgentEmployeeIds(pool as any, "not-a-tenant", [A_RECON]),
    ).rejects.toThrow(/UUID/i);
  });
});
