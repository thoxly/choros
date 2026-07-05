/**
 * T-0392 [SECURITY] — multi-tenant DB acceptance for PostgresAgentJobFetcher.
 *
 * Regression for the cross-tenant confusion in the agent dispatch loop:
 * the production runtime pool connects as `choros_migrator` (BYPASSRLS), so the
 * `SET LOCAL choros.tenant_id` GUC is INERT for row filtering. Before the fix the
 * Phase-2 candidates CTE had NO `tenant_id` predicate, so iterating tenant A would
 * LOCK tenant B's agent-step jobs in tenant A's batch and stamp them `__tenantId: A`
 * (from the loop iterator, not the row), causing assembleAgentStepContext + the
 * apply-write to run under the WRONG tenant.
 *
 * These tests run the REAL fetcher against the REAL (BYPASSRLS) migrator pool — the
 * exact production connection — to prove:
 *   1. Each tenant's job is fetched/processed under its OWN tenant's __tenantId.
 *   2. Tenant A's iteration does NOT lock tenant B's job (no cross-tenant lock).
 *   3. __tenantId is stamped from the row's real tenant_id (never the iterator).
 *
 * CI-ONLY: requires DATABASE_URL (must resolve to choros_migrator). Runs in the `db`
 * CI job / locally against the compose Postgres via npm run fitness:db.
 *
 * NB: we deliberately use the MIGRATOR pool here (not appUrl): production wires
 * PostgresAgentJobFetcher with the migrator pool (DATABASE_URL), so the test must
 * reproduce the BYPASSRLS condition under which the leak existed — testing under the
 * NOBYPASSRLS app role would mask the bug (RLS would scope the rows for free).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { TENANT_A, TENANT_B, migratorUrl, withClient, uuid } from "./_helpers.js";
import { PostgresAgentJobFetcher } from "../../../src/server/agent-dispatch-loop.js";
import type { PostgresJobStore } from "../../../src/core/jobStore.js";

const AGENT_TOPIC = "agent-step";
const WORKER = "ct-agent-dispatcher";

// ---------------------------------------------------------------------------
// Seed helpers (migrator — BYPASSRLS; mirrors pgJobStore.integration.test.ts)
// ---------------------------------------------------------------------------

/** Seed one agent-step job for the given tenant via migrator. Returns the job id. */
async function seedAgentJob(params: {
  tenantId: string;
  topic?: string;
  state?: string;
  available_at?: number;
  created_at?: number;
  lockExpiry?: number | null;
  /** T-0677: migration 111 (T-0534) columns — omit to leave them NULL (legacy row). */
  processDefId?: string | null;
  instanceId?: string | null;
}): Promise<string> {
  const id = uuid();
  const now = Date.now();
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `INSERT INTO choros.job
         (tenant_id, id, topic, variables, state, retries,
          lock_owner, lock_expiry, created_at, available_at,
          process_def_id, instance_id)
       VALUES ($1,$2,$3,$4,$5,0,NULL,$6,$7,$8,$9,$10)`,
      [
        params.tenantId,
        id,
        params.topic ?? AGENT_TOPIC,
        JSON.stringify({ marker: id.slice(0, 8) }),
        params.state ?? "CREATED",
        params.lockExpiry ?? null,
        params.created_at ?? now,
        params.available_at ?? now,
        params.processDefId ?? null,
        params.instanceId ?? null,
      ],
    );
  });
  return id;
}

/** Truncate choros.job for test isolation (migrator). */
async function truncateJobs(): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query("TRUNCATE choros.job");
  });
}

/** Read the current (tenant_id, state, lock_owner) for a job via migrator. */
async function readJob(id: string): Promise<{ tenant_id: string; state: string; lock_owner: string | null } | undefined> {
  return withClient(migratorUrl(), async (c) => {
    const { rows } = await c.query<{ tenant_id: string; state: string; lock_owner: string | null }>(
      `SELECT tenant_id, state, lock_owner FROM choros.job WHERE id = $1`,
      [id],
    );
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Pool / fetcher under test — the PRODUCTION (migrator/BYPASSRLS) pool.
// jobStore is unused by fetchAndLockAgentJobs (the CTE is inlined), so a stub
// cast is sufficient and keeps the test free of extra wiring.
// ---------------------------------------------------------------------------
let migratorPool: pg.Pool;
let fetcher: PostgresAgentJobFetcher;

beforeAll(() => {
  migratorPool = new pg.Pool({ connectionString: migratorUrl() });
  fetcher = new PostgresAgentJobFetcher(
    migratorPool,
    {} as unknown as PostgresJobStore,
  );
});

afterAll(async () => {
  await migratorPool.end();
});

beforeEach(async () => {
  await truncateJobs();
});

describe("T-0392 cross-tenant: PostgresAgentJobFetcher under BYPASSRLS migrator pool", () => {
  it("each tenant's job is fetched under its OWN __tenantId (no cross-tenant leak)", async () => {
    const now = Date.now();
    const jobA = await seedAgentJob({ tenantId: TENANT_A, created_at: now - 100, available_at: now - 100 });
    const jobB = await seedAgentJob({ tenantId: TENANT_B, created_at: now - 100, available_at: now - 100 });

    const batches = await fetcher.fetchAndLockAgentJobs({
      workerId: WORKER,
      topics: [AGENT_TOPIC],
      maxJobs: 10,
      lockMs: 30_000,
      nowMs: now,
    });

    // One batch per tenant.
    expect(batches).toHaveLength(2);
    const batchA = batches.find((b) => b.tenantId === TENANT_A);
    const batchB = batches.find((b) => b.tenantId === TENANT_B);
    expect(batchA, "tenant A must have a batch").toBeDefined();
    expect(batchB, "tenant B must have a batch").toBeDefined();

    // Batch A contains ONLY A's job, stamped __tenantId = A.
    expect(batchA!.jobs).toHaveLength(1);
    expect(batchA!.jobs[0].id).toBe(jobA);
    expect(batchA!.jobs[0].variables["__tenantId"]).toBe(TENANT_A);

    // Batch B contains ONLY B's job, stamped __tenantId = B.
    expect(batchB!.jobs).toHaveLength(1);
    expect(batchB!.jobs[0].id).toBe(jobB);
    expect(batchB!.jobs[0].variables["__tenantId"]).toBe(TENANT_B);

    // GLOBAL INVARIANT: no batch contains a job belonging to a foreign tenant, and
    // every stamped __tenantId equals the batch tenant. This is the precise leak.
    for (const batch of batches) {
      for (const job of batch.jobs) {
        expect(job.variables["__tenantId"]).toBe(batch.tenantId);
        const row = await readJob(job.id);
        expect(row, `job ${job.id} must exist`).toBeDefined();
        expect(
          row!.tenant_id,
          `job ${job.id} stamped __tenantId ${String(job.variables["__tenantId"])} but DB tenant_id is ${row!.tenant_id}`,
        ).toBe(job.variables["__tenantId"]);
      }
    }
  });

  it("tenant A's iteration does NOT lock tenant B's job", async () => {
    // Single tenant in the topic-eligible set is enough to expose the missing
    // predicate: BEFORE the fix, the Phase-2 CTE under tenant A (no tenant_id
    // predicate, GUC inert under BYPASSRLS) would lock EVERY eligible agent-step
    // row — including tenant B's — within tenant A's batch. We assert B stays
    // CREATED and unlocked after A's pass, and that B never appears in batch A.
    const now = Date.now();
    const jobA = await seedAgentJob({ tenantId: TENANT_A, created_at: now - 200, available_at: now - 200 });
    const jobB = await seedAgentJob({ tenantId: TENANT_B, created_at: now - 100, available_at: now - 100 });

    const batches = await fetcher.fetchAndLockAgentJobs({
      workerId: WORKER,
      topics: [AGENT_TOPIC],
      maxJobs: 10,
      lockMs: 30_000,
      nowMs: now,
    });

    // B's job must NEVER appear inside tenant A's batch.
    const batchA = batches.find((b) => b.tenantId === TENANT_A);
    expect(batchA).toBeDefined();
    expect(batchA!.jobs.some((j) => j.id === jobB)).toBe(false);

    // Physical truth: A's job is LOCKED by WORKER; B's job is LOCKED only under its
    // OWN batch/tenant — never reclaimed into A. Verify A locked, then verify B's row
    // was locked under tenant B (its own batch), with state/owner consistent.
    const rowA = await readJob(jobA);
    expect(rowA!.state).toBe("LOCKED");
    expect(rowA!.lock_owner).toBe(WORKER);
    expect(rowA!.tenant_id).toBe(TENANT_A);

    // B's job is processed under tenant B's own batch (correct), not under A.
    const batchB = batches.find((b) => b.tenantId === TENANT_B);
    expect(batchB).toBeDefined();
    expect(batchB!.jobs.map((j) => j.id)).toContain(jobB);
    const rowB = await readJob(jobB);
    expect(rowB!.tenant_id).toBe(TENANT_B);
  });

  it("__tenantId is the row's real tenant_id, never the loop iterator", async () => {
    // Seed several jobs across both tenants; assert EVERY returned job's __tenantId
    // matches its DB tenant_id (the authoritative row value), proving the stamp comes
    // from RETURNING j.tenant_id and not from the per-tenant loop variable.
    const now = Date.now();
    const ids: Array<{ id: string; tenant: string }> = [];
    for (let i = 0; i < 3; i++) {
      ids.push({ id: await seedAgentJob({ tenantId: TENANT_A, created_at: now - 300 + i, available_at: now - 300 }), tenant: TENANT_A });
      ids.push({ id: await seedAgentJob({ tenantId: TENANT_B, created_at: now - 300 + i, available_at: now - 300 }), tenant: TENANT_B });
    }

    const batches = await fetcher.fetchAndLockAgentJobs({
      workerId: WORKER,
      topics: [AGENT_TOPIC],
      maxJobs: 50,
      lockMs: 30_000,
      nowMs: now,
    });

    const stamped = new Map<string, string>();
    for (const batch of batches) {
      for (const job of batch.jobs) {
        stamped.set(job.id, String(job.variables["__tenantId"]));
      }
    }

    // Every seeded job was fetched, and stamped with ITS OWN tenant_id.
    expect(stamped.size).toBe(ids.length);
    for (const { id, tenant } of ids) {
      expect(stamped.get(id), `job ${id} stamped __tenantId`).toBe(tenant);
    }
  });

  it("expired-lock rows are re-fetched under the correct tenant (no cross-tenant reclaim)", async () => {
    // An expired LOCKED row of tenant B must NOT be reclaimed into tenant A's batch.
    const now = Date.now();
    const jobA = await seedAgentJob({ tenantId: TENANT_A, created_at: now - 100, available_at: now - 100 });
    const jobBExpired = await seedAgentJob({
      tenantId: TENANT_B,
      state: "LOCKED",
      lockExpiry: now - 1, // expired → re-eligible
      created_at: now - 100,
      available_at: now - 100,
    });

    const batches = await fetcher.fetchAndLockAgentJobs({
      workerId: WORKER,
      topics: [AGENT_TOPIC],
      maxJobs: 10,
      lockMs: 30_000,
      nowMs: now,
    });

    const batchA = batches.find((b) => b.tenantId === TENANT_A);
    const batchB = batches.find((b) => b.tenantId === TENANT_B);
    // A's batch has only A's job; B's expired job is NOT reclaimed into A.
    expect(batchA!.jobs.map((j) => j.id)).toEqual([jobA]);
    // B's expired job is reclaimed under B's own batch, stamped B.
    expect(batchB!.jobs.some((j) => j.id === jobBExpired && j.variables["__tenantId"] === TENANT_B)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-0677 [P0 движок]: PostgresAgentJobFetcher must thread process_def_id /
// instance_id (migration 111, T-0534) onto the returned Job — this IS the
// production path behind the live agent dispatch loop (main.ts wires
// PostgresAgentJobFetcher, NOT PostgresJobStore.fetchAndLock, for real jobs).
//
// This is the exact defect T-0638 live-proof diagnosed: a real agentTask job's
// RETURNING list here omitted process_def_id/instance_id, so every job handed
// to assembleAgentStepContext → readJobVars() carried job.instanceId===undefined
// (pre-fix: the field did not exist on Job at all), degrading to instanceId=""
// downstream and making the defer-completion action 404 DEFER_NOT_ROUTABLE
// (repro on stand: instance 99573238).
// ---------------------------------------------------------------------------
describe("T-0677: PostgresAgentJobFetcher threads process_def_id/instance_id onto Job", () => {
  it("a job seeded with process_def_id/instance_id is returned with both fields populated (mutation-red pre-fix: was undefined/empty)", async () => {
    const now = Date.now();
    const jobId = await seedAgentJob({
      tenantId: TENANT_A,
      created_at: now - 100,
      available_at: now - 100,
      processDefId: "telLinear",
      instanceId: "99573238",
    });

    const batches = await fetcher.fetchAndLockAgentJobs({
      workerId: WORKER,
      topics: [AGENT_TOPIC],
      maxJobs: 10,
      lockMs: 30_000,
      nowMs: now,
    });

    const batchA = batches.find((b) => b.tenantId === TENANT_A);
    expect(batchA).toBeDefined();
    const job = batchA!.jobs.find((j) => j.id === jobId);
    expect(job, "seeded job must appear in tenant A's batch").toBeDefined();

    // The precise assertion this PR fixes: these fields must carry the REAL
    // Flowable process-instance id / process-definition key captured at
    // enqueue time, not be absent/undefined/empty.
    expect(job!.instanceId).toBe("99573238");
    expect(job!.processDefId).toBe("telLinear");

    // FUNCTIONAL WIRING (post FF-15 relocation): the call site also injects these
    // into job.variables under the SAME keys the frozen agent-step-context.ts::
    // readJobVars() already probes (`instanceId` / `procKey`) — this is what makes
    // readJobVars return the real instanceId WITHOUT any edit to the frozen file.
    // This is the mutation-red assertion of record: pre-fix, variables carried no
    // instanceId/procKey and readJobVars → ctx.instanceId="" (repro 99573238).
    expect(job!.variables["instanceId"]).toBe("99573238");
    expect(job!.variables["procKey"]).toBe("telLinear");
  });

  it("backward compatibility: a legacy row with NULL process_def_id/instance_id → fields are null, fetch does not crash", async () => {
    const now = Date.now();
    const jobId = await seedAgentJob({
      tenantId: TENANT_A,
      created_at: now - 100,
      available_at: now - 100,
      // processDefId/instanceId omitted → NULL at the DB level (pre-migration-111
      // row, or an enqueue call that never captured process scope).
    });

    const batches = await fetcher.fetchAndLockAgentJobs({
      workerId: WORKER,
      topics: [AGENT_TOPIC],
      maxJobs: 10,
      lockMs: 30_000,
      nowMs: now,
    });

    const batchA = batches.find((b) => b.tenantId === TENANT_A);
    const job = batchA!.jobs.find((j) => j.id === jobId);
    expect(job).toBeDefined();
    expect(job!.instanceId).toBeNull();
    expect(job!.processDefId).toBeNull();
    // NULL columns → no injection into variables → readJobVars falls back to
    // whatever variables already carried (nothing here) → "" downstream. No crash,
    // no spurious empty-string key stamped.
    expect(job!.variables["instanceId"]).toBeUndefined();
    expect(job!.variables["procKey"]).toBeUndefined();
  });

  it("legacy fallback: a job whose variables already carry instanceId/procKey but has NULL columns keeps the variables value (readJobVars fallback preserved)", async () => {
    const now = Date.now();
    const jobId = uuid();
    // Seed a job with process_def_id/instance_id NULL at the DB level but with
    // instanceId/procKey already present INSIDE variables (a legacy shape). The
    // call-site injection is skipped (columns NULL) so the variables value survives.
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.job
           (tenant_id, id, topic, variables, state, retries,
            lock_owner, lock_expiry, created_at, available_at,
            process_def_id, instance_id)
         VALUES ($1,$2,$3,$4,'CREATED',0,NULL,NULL,$5,$5,NULL,NULL)`,
        [
          TENANT_A,
          jobId,
          AGENT_TOPIC,
          JSON.stringify({ instanceId: "legacy-inst", procKey: "legacyProc" }),
          now - 100,
        ],
      );
    });

    const batches = await fetcher.fetchAndLockAgentJobs({
      workerId: WORKER,
      topics: [AGENT_TOPIC],
      maxJobs: 10,
      lockMs: 30_000,
      nowMs: now,
    });
    const job = batches.find((b) => b.tenantId === TENANT_A)!.jobs.find((j) => j.id === jobId);
    expect(job).toBeDefined();
    // Columns NULL → injection skipped → the legacy variables value is preserved.
    expect(job!.variables["instanceId"]).toBe("legacy-inst");
    expect(job!.variables["procKey"]).toBe("legacyProc");
    expect(job!.instanceId).toBeNull();
    expect(job!.processDefId).toBeNull();
  });

  it("override: when BOTH a DB column and a stale variables value exist, the migration-111 column wins (authoritative engine-captured id)", async () => {
    const now = Date.now();
    const jobId = uuid();
    // Column carries the real engine id; variables carries a stale/wrong value.
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `INSERT INTO choros.job
           (tenant_id, id, topic, variables, state, retries,
            lock_owner, lock_expiry, created_at, available_at,
            process_def_id, instance_id)
         VALUES ($1,$2,$3,$4,'CREATED',0,NULL,NULL,$5,$5,$6,$7)`,
        [
          TENANT_A,
          jobId,
          AGENT_TOPIC,
          JSON.stringify({ instanceId: "stale-legacy-value" }),
          now - 100,
          "telLinear",
          "authoritative-999",
        ],
      );
    });

    const batches = await fetcher.fetchAndLockAgentJobs({
      workerId: WORKER,
      topics: [AGENT_TOPIC],
      maxJobs: 10,
      lockMs: 30_000,
      nowMs: now,
    });
    const job = batches.find((b) => b.tenantId === TENANT_A)!.jobs.find((j) => j.id === jobId);
    expect(job).toBeDefined();
    // The DB column (engine-captured at enqueue) overrides the stale business var.
    expect(job!.variables["instanceId"]).toBe("authoritative-999");
    expect(job!.variables["procKey"]).toBe("telLinear");
    expect(job!.instanceId).toBe("authoritative-999");
  });

  it("each tenant's process_def_id/instance_id are scoped to their own job (no cross-tenant field bleed)", async () => {
    const now = Date.now();
    const jobA = await seedAgentJob({
      tenantId: TENANT_A,
      created_at: now - 100,
      available_at: now - 100,
      processDefId: "procA",
      instanceId: "inst-A-1",
    });
    const jobB = await seedAgentJob({
      tenantId: TENANT_B,
      created_at: now - 100,
      available_at: now - 100,
      processDefId: "procB",
      instanceId: "inst-B-1",
    });

    const batches = await fetcher.fetchAndLockAgentJobs({
      workerId: WORKER,
      topics: [AGENT_TOPIC],
      maxJobs: 10,
      lockMs: 30_000,
      nowMs: now,
    });

    const batchA = batches.find((b) => b.tenantId === TENANT_A);
    const batchB = batches.find((b) => b.tenantId === TENANT_B);
    const foundA = batchA!.jobs.find((j) => j.id === jobA);
    const foundB = batchB!.jobs.find((j) => j.id === jobB);
    expect(foundA!.instanceId).toBe("inst-A-1");
    expect(foundA!.processDefId).toBe("procA");
    expect(foundB!.instanceId).toBe("inst-B-1");
    expect(foundB!.processDefId).toBe("procB");
  });
});
