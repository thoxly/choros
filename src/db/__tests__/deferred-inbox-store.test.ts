/**
 * src/db/__tests__/deferred-inbox-store.test.ts — T-0676 [anti-case hardcode fix,
 * D-064 relevant] fast, mocked-pool unit test for listDeferredInboxTasks's
 * row → DeferredInboxRow mapping (the part of the file that does NOT need a
 * live Postgres — the SQL text itself is unchanged by this task).
 *
 * Regression this guards: deferred-inbox-store.ts used to default an unset/blank
 * payload.defer_role to the LITERAL "fin-ctrl" (a case-specific, day-1-demo role
 * slug). That silently defeated the honest-addressing fallback T-0638 (F6) built
 * at the read layer (src/http/inbox.ts's resolveExecutorFallbackBatch +
 * findTenantOwnerSlug): "fin-ctrl" is a REAL role that often has confirmed
 * holders, so a defer task that never actually had a role assigned would land on
 * fin-ctrl's holder instead of the tenant owner. The fix: an unset/blank
 * defer_role now projects to "" — a role slug no tenant can ever define — so the
 * existing fallback resolver correctly treats it as unfilled and routes to the
 * owner (see ADR-T0638-defer-task-complete.md §2.5; live-DB confirmation in
 * ci/checks/db/inbox-defer-escalation.db.test.ts, T-0676 case).
 *
 * These tests mock pg.Pool.connect() to avoid a live DB — they exercise ONLY the
 * in-memory row-mapping (BEGIN/SET LOCAL/COMMIT calls are stubbed no-ops; the
 * SELECT call returns canned rows shaped exactly like the real query's output).
 */
import { describe, it, expect } from "vitest";
import type pg from "pg";
import { listDeferredInboxTasks } from "../deferred-inbox-store.js";

type FakeAuditRow = {
  id: string;
  actor: string;
  subject: string | null;
  scope: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  occurred_at: number;
};

/**
 * Minimal fake pg.Pool: connect() resolves a fake client whose query() answers
 * BEGIN/SET LOCAL/COMMIT with an empty result and the actual SELECT with the
 * given canned rows (matched by a leading "SELECT" — the only SELECT the DAO
 * issues inside withTenant).
 */
function makeFakePool(rows: FakeAuditRow[]): pg.Pool {
  const client = {
    query: async (sql: string) => {
      if (/^\s*SELECT/i.test(sql)) {
        return { rows };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return {
    connect: async () => client,
  } as unknown as pg.Pool;
}

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

function baseRow(payload: Record<string, unknown>): FakeAuditRow {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    actor: "agent-t0676",
    subject: null,
    scope: { skill: "legal_precheck" },
    payload,
    occurred_at: Date.now(),
  };
}

describe("T-0676 — listDeferredInboxTasks: honest role fallback (no case-literal default)", () => {
  it("payload.defer_role ABSENT → role is '' (honest unfilled), never the 'fin-ctrl' literal", async () => {
    const pool = makeFakePool([baseRow({ doubt_reason: "some reason" })]);
    const result = await listDeferredInboxTasks(pool, TENANT_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.role).not.toBe("fin-ctrl");
    expect(result[0]!.role).toBe("");
  });

  it("payload.defer_role blank/whitespace → role is '' (also not defaulted to 'fin-ctrl')", async () => {
    const pool = makeFakePool([baseRow({ doubt_reason: "some reason", defer_role: "   " })]);
    const result = await listDeferredInboxTasks(pool, TENANT_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.role).not.toBe("fin-ctrl");
    expect(result[0]!.role).toBe("");
  });

  it("payload.defer_role set to a real role → passes through verbatim (no regression)", async () => {
    const pool = makeFakePool([
      baseRow({ doubt_reason: "some reason", defer_role: "cs-l2" }),
    ]);
    const result = await listDeferredInboxTasks(pool, TENANT_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("cs-l2");
  });

  it("payload.defer_role explicitly 'fin-ctrl' still passes through verbatim (a real value is never rewritten)", async () => {
    const pool = makeFakePool([
      baseRow({ doubt_reason: "some reason", defer_role: "fin-ctrl" }),
    ]);
    const result = await listDeferredInboxTasks(pool, TENANT_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("fin-ctrl");
  });
});
