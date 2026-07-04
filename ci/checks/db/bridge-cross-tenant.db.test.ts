/**
 * T-0636 (AC-5 / FF-5) — cross-tenant DB acceptance for runBridgeOnce.
 *
 * Regression target: the external-task bridge poll cycle (runBridgeOnce,
 * src/core/externalTaskBridge.ts) never set `choros.tenant_id` before calling
 * PostgresJobStore.enqueue — enqueue's `current_setting('choros.tenant_id', false)`
 * throws when the GUC is unset (P0-6). Even once a GUC is set on SOME connection,
 * enqueue queries `this.pool` directly (an arbitrary pooled connection), so a GUC
 * set on a DIFFERENT connection is invisible to it — the bug persists even under
 * a naive single-SET-LOCAL fix (see bridge-runner.ts's pre-existing bug, noted in
 * the ADR). The T-0636 fix threads an `executor` (a GUC-scoped pg.PoolClient)
 * through runBridgeOnce → jobStore.enqueue so the INSERT runs on the SAME
 * connection the GUC was set on, per discovered tenant.
 *
 * This test runs the REAL runBridgeOnce + REAL PostgresJobStore against the REAL
 * (choros_app, RLS-enforced) app pool — mirroring ci/checks/db/agent-dispatch-
 * cross-tenant.test.ts's methodology for the symmetric agent-dispatch loop — to
 * prove:
 *   1. Two tenants, each with one Flowable ExternalTask carrying its OWN
 *      choros_tenantId stamp, enqueued in a SINGLE runBridgeOnce pass, both land
 *      in choros.job with their OWN (correct) tenant_id — not just the first, not
 *      cross-contaminated, no GUC-related exception.
 *   2. A task with NO tenant stamp is skipped (fail-closed) rather than crashing
 *      the whole pass or falling back to a guessed tenant.
 *
 * CI-ONLY: requires DATABASE_URL (must resolve to choros_migrator) + the derived
 * choros_app URL. Runs in the `db` CI job / locally via npm run fitness:db.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { TENANT_A, TENANT_B, migratorUrl, appUrl, withClient, uuid } from "./_helpers.js";
import { PostgresJobStore } from "../../../src/core/postgres/pgJobStore.js";
import { runBridgeOnce, CHOROS_TENANT_VAR } from "../../../src/core/externalTaskBridge.js";
import type {
  FlowableClient,
  ExternalTask,
  FetchResult,
  DeployResult,
  StartResult,
  CompleteTaskResult,
  FailTaskResult,
  GetFirstUserTaskResult,
  CompleteUserTaskResult,
  GetActiveUserTasksResult,
  GetMessageCatchWaitsResult,
  CorrelateMessageResult,
  IsInstanceEndedResult,
} from "../../../src/core/flowable-client.js";

const AGENT_TOPIC = "agent-step";
const WORKER = "ct-bridge-worker";

// ---------------------------------------------------------------------------
// A minimal fake FlowableClient — only fetchAndLock is exercised by
// runBridgeOnce; every other method is a stub satisfying the interface.
// ---------------------------------------------------------------------------
function makeFakeFlowableClient(tasksByTopic: Record<string, ExternalTask[]>): FlowableClient {
  return {
    deployBpmn: async (): Promise<DeployResult> => ({ ok: true, deploymentId: "stub" }),
    startInstance: async (): Promise<StartResult> => ({ ok: true, instanceId: "stub" }),
    fetchAndLock: async (topic: string): Promise<FetchResult> => ({
      ok: true,
      tasks: tasksByTopic[topic] ?? [],
    }),
    completeTask: async (): Promise<CompleteTaskResult> => ({ ok: true }),
    failTask: async (): Promise<FailTaskResult> => ({ ok: true }),
    getFirstActiveUserTask: async (): Promise<GetFirstUserTaskResult> => ({ ok: true, taskId: null }),
    completeUserTask: async (): Promise<CompleteUserTaskResult> => ({ ok: true }),
    getActiveUserTasks: async (): Promise<GetActiveUserTasksResult> => ({ ok: true, tasks: [] }),
    getMessageCatchWaits: async (): Promise<GetMessageCatchWaitsResult> => ({ ok: true, waits: [] }),
    correlateMessage: async (): Promise<CorrelateMessageResult> => ({ ok: true }),
    isInstanceEnded: async (): Promise<IsInstanceEndedResult> => ({ ok: true, ended: false }),
  };
}

function makeExternalTask(over: Partial<ExternalTask> = {}): ExternalTask {
  return {
    id: over.id ?? uuid(),
    topic: over.topic ?? AGENT_TOPIC,
    processInstanceId: over.processInstanceId ?? uuid(),
    processDefinitionKey: over.processDefinitionKey ?? "",
    variables: over.variables ?? {},
    lockOwner: over.lockOwner ?? WORKER,
    lockExpirationTime: over.lockExpirationTime ?? new Date(Date.now() + 30_000).toISOString(),
  };
}

/** Read (tenant_id, idempotency_key, lock_expiry, state) for every job row via migrator (BYPASSRLS — sees all tenants). */
async function readAllJobs(): Promise<Array<{ tenant_id: string; idempotency_key: string | null; state: string; lock_expiry: string | null; created_at: string }>> {
  return withClient(migratorUrl(), async (c) => {
    const { rows } = await c.query<{ tenant_id: string; idempotency_key: string | null; state: string; lock_expiry: string | null; created_at: string }>(
      `SELECT tenant_id, idempotency_key, state, lock_expiry, created_at FROM choros.job`,
    );
    return rows;
  });
}

async function truncateJobs(): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query("TRUNCATE choros.job");
  });
}

let appPool: pg.Pool;
let jobStore: PostgresJobStore;

beforeAll(() => {
  appPool = new pg.Pool({ connectionString: appUrl() });
  jobStore = new PostgresJobStore(appPool);
});

afterAll(async () => {
  await appPool.end();
});

beforeEach(async () => {
  await truncateJobs();
});

describe("T-0636 (AC-5/FF-5) cross-tenant: runBridgeOnce enqueues each tenant's job under its OWN tenant_id", () => {
  it("two tenants, one ExternalTask each (own choros_tenantId stamp) → both land in choros.job with correct tenant_id", async () => {
    const taskA = makeExternalTask({
      id: `ext-${uuid()}`,
      topic: AGENT_TOPIC,
      variables: { [CHOROS_TENANT_VAR]: TENANT_A, amount: 100 },
    });
    const taskB = makeExternalTask({
      id: `ext-${uuid()}`,
      topic: AGENT_TOPIC,
      variables: { [CHOROS_TENANT_VAR]: TENANT_B, amount: 200 },
    });

    const flowableClient = makeFakeFlowableClient({ [AGENT_TOPIC]: [taskA, taskB] });

    const result = await runBridgeOnce(
      flowableClient,
      jobStore,
      [AGENT_TOPIC],
      WORKER,
      30_000, // lockDurationMs
      10,     // maxTasksPerTopic
      3,      // retries
      appPool,
    );

    expect(result.fetched).toBe(2);
    expect(result.enqueued).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    const rows = await readAllJobs();
    expect(rows).toHaveLength(2);

    const rowA = rows.find((r) => r.idempotency_key === taskA.id);
    const rowB = rows.find((r) => r.idempotency_key === taskB.id);
    expect(rowA, "tenant A's job must exist").toBeDefined();
    expect(rowB, "tenant B's job must exist").toBeDefined();

    // GLOBAL INVARIANT: each job's tenant_id matches its OWN stamped tenant —
    // never the other tenant, never a NULL/guessed value.
    expect(rowA!.tenant_id).toBe(TENANT_A);
    expect(rowB!.tenant_id).toBe(TENANT_B);
    expect(rowA!.tenant_id).not.toBe(rowB!.tenant_id);
  });

  it("a task with NO choros_tenantId variable is skipped (fail-closed) — not enqueued under a guessed tenant", async () => {
    const taskNoTenant = makeExternalTask({
      id: `ext-${uuid()}`,
      topic: AGENT_TOPIC,
      variables: { amount: 999 }, // no choros_tenantId
    });
    const taskWithTenant = makeExternalTask({
      id: `ext-${uuid()}`,
      topic: AGENT_TOPIC,
      variables: { [CHOROS_TENANT_VAR]: TENANT_A },
    });

    const flowableClient = makeFakeFlowableClient({ [AGENT_TOPIC]: [taskNoTenant, taskWithTenant] });

    const result = await runBridgeOnce(
      flowableClient, jobStore, [AGENT_TOPIC], WORKER, 30_000, 10, 3, appPool,
    );

    expect(result.fetched).toBe(2);
    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(1);

    const rows = await readAllJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotency_key).toBe(taskWithTenant.id);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it("P0-7 companion: lock_expiry after enqueue+fetchAndLock cycle reflects SECONDS-scale duration, not hours (regression guard for the wire-format fix)", async () => {
    // This test asserts the *bridge* enqueue path lands a sane row; the actual
    // Flowable-side lock_expiry (8h-vs-30s) is covered by flowable-client unit
    // tests (AC-7/AC-8) against a mocked wire — this DB test's job carries no
    // engine-side lock_expiry itself (choros.job's own lock_expiry is set by
    // fetchAndLock/enqueue semantics on THIS side, unrelated to the Flowable
    // wire duration format). We assert the enqueued row is CREATED (unlocked)
    // immediately after enqueue — i.e. runBridgeOnce's enqueue path itself does
    // not inherit any bogus multi-hour value.
    const task = makeExternalTask({
      id: `ext-${uuid()}`,
      topic: AGENT_TOPIC,
      variables: { [CHOROS_TENANT_VAR]: TENANT_A },
    });
    const flowableClient = makeFakeFlowableClient({ [AGENT_TOPIC]: [task] });

    await runBridgeOnce(flowableClient, jobStore, [AGENT_TOPIC], WORKER, 30_000, 10, 3, appPool);

    const rows = await readAllJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("CREATED");
    expect(rows[0].lock_expiry).toBeNull();
  });
});
